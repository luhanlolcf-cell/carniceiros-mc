import { Request, Response } from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { ClubRole } from '../middlewares/auth.middleware';

export const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
});

// Política de senha forte: mín 8 caracteres, 1 maiúscula, 1 minúscula, 1 número e 1 especial
export const strongPasswordRegex =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,128}$/;

export const registerSchema = z.object({
  fullName: z.string().trim().min(5).max(150).refine((v) => v.split(/\s+/).length >= 2, 'Informe nome e sobrenome.'),
  roadName: z.string().trim().regex(/^[\p{L}\s'-]{2,30}$/u, 'Alcunha deve ter de 2 a 30 letras.'),
  email: z.string().trim().email().max(180).transform((v) => v.toLowerCase()),
  password: z
    .string()
    .max(128)
    .regex(
      strongPasswordRegex,
      'A senha deve ter no mínimo 8 caracteres, incluindo letra maiúscula, minúscula, número e caractere especial.'
    ),
  phoneWhatsapp: z.string().trim().max(30).refine((v) => {
    const digits = v.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 13;
  }, 'WhatsApp inválido (DDD + número).'),
  emergencyContactName: z.string().trim().min(2).max(150),
  emergencyContactPhone: z.string().trim().max(30).refine((v) => v.replace(/\D/g, '').length >= 10, 'Telefone de emergência inválido.'),
  motorcycle: z.string().trim().max(80).optional(),
  referral: z.string().trim().max(80).optional(),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'É necessário aceitar o estatuto e o termo LGPD.' }) }),
  website: z.string().max(0).optional(), // honeypot anti-bot: precisa vir vazio
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(180).transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(128),
});

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-only-replace-in-prod-32bytes-min';
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutos
const REFRESH_TOKEN_TTL_DAYS = 7;         // 7 dias
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

/**
 * Configura opções de Hashing Argon2id segundo recomendações OWASP:
 * memoryCost: 64 MB (65536 KiB), timeCost: 3 iterações, parallelism: 4 threads.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

/**
 * POST /api/auth/register
 * Cria solicitação de novo membro/prospect com senha hasheada em Argon2id.
 * Conta nasce com `is_active = false` até aprovação da Diretoria.
 */
export async function registerUser(req: Request, res: Response): Promise<void> {
  // Honeypot preenchido = bot: responde 202 genérico sem gravar nada
  if (typeof req.body?.website === 'string' && req.body.website.length > 0) {
    res.status(202).json({ message: 'Solicitação recebida. Ela ficará PENDENTE até a aprovação da Diretoria do Carniceiros MC.', status: 'PENDENTE' });
    return;
  }
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const data = parsed.data;
  const passwordHash = await argon2.hash(data.password, ARGON2_OPTIONS);

  // Resposta SEMPRE idêntica (mesmo se e-mail/alcunha já existirem) para evitar enumeração de contas
  const genericAccepted = {
    message: 'Solicitação recebida. Ela ficará PENDENTE até a aprovação da Diretoria do Carniceiros MC.',
    status: 'PENDENTE',
  };

  try {
    // Novos cadastros entram como PROSPECT, is_active = FALSE e approved_at = NULL (PENDENTE)
    await dbPool.query(
      `INSERT INTO users (
        role_id, full_name, road_name, email, password_hash,
        phone_whatsapp, emergency_contact_name, emergency_contact_phone,
        motorcycle, referral, signup_origin, club_rank, is_active
      )
      VALUES (
        (SELECT id FROM roles WHERE name = 'PROSPECT'),
        $1, $2, $3, $4, $5, $6, $7, $8, $9, 'AUTO_CADASTRO', 'Prospect', FALSE
      )`,
      [
        data.fullName,
        data.roadName,
        data.email,
        passwordHash,
        data.phoneWhatsapp,
        data.emergencyContactName,
        data.emergencyContactPhone,
        data.motorcycle || null,
        data.referral || null,
      ]
    );
    res.status(202).json(genericAccepted);
  } catch (err: any) {
    if (err.code === '23505') {
      // Duplicado: não revela ao cliente; apenas registra no log do servidor
      console.warn('[register] tentativa de cadastro duplicado (e-mail/alcunha)');
      res.status(202).json(genericAccepted);
      return;
    }
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Erro interno ao registrar solicitação.' });
  }
}

/**
 * POST /api/auth/login
 * Autentica o membro com proteção contra timing attacks, bloqueio temporário por força bruta,
 * verificação Argon2id e emissão de JWT Access Token curto + Refresh Token rotativo em Cookie HttpOnly.
 */
export async function loginUser(req: Request, res: Response): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Credenciais em formato inválido.',
    });
    return;
  }

  const { email, password } = parsed.data;

  try {
    // Prepared statement parametrizado ($1) -> 100% imune a SQL Injection
    const userQuery = await dbPool.query(
      `SELECT u.id, u.full_name, u.road_name, u.email, u.password_hash,
              u.is_active, u.suspended_at, u.failed_login_attempts, u.locked_until, u.club_rank,
              r.name AS role_name
       FROM users u
       INNER JOIN roles r ON r.id = u.role_id
       WHERE u.email = $1
       LIMIT 1`,
      [email]
    );

    const user = userQuery.rows[0];

    // Se usuário não existir, executamos um hash dummy para mitigar enumeração por timing attack
    if (!user) {
      await argon2.hash(password, ARGON2_OPTIONS);
      res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'E-mail ou senha inválidos.',
      });
      return;
    }

    // Verifica bloqueio temporário por excesso de tentativas falhas
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      res.status(423).json({
        error: 'ACCOUNT_LOCKED',
        message: 'Conta temporariamente bloqueada por múltiplas tentativas falhas. Tente novamente mais tarde.',
      });
      return;
    }

    const isPasswordValid = await argon2.verify(user.password_hash, password);

    if (!isPasswordValid) {
      const nextAttempts = Number(user.failed_login_attempts) + 1;
      const shouldLock = nextAttempts >= MAX_FAILED_ATTEMPTS;

      await dbPool.query(
        `UPDATE users
         SET failed_login_attempts = $1,
             locked_until = CASE WHEN $2 THEN NOW() + ($3 || ' minutes')::INTERVAL ELSE NULL END,
             updated_at = NOW()
         WHERE id = $4`,
        [nextAttempts, shouldLock, LOCKOUT_MINUTES, user.id]
      );

      res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'E-mail ou senha inválidos.',
      });
      return;
    }

    if (user.suspended_at) {
      res.status(403).json({
        error: 'ACCOUNT_SUSPENDED',
        message: 'Acesso suspenso pela Diretoria. Procure o Secretário do clube.',
      });
      return;
    }

    if (!user.is_active) {
      res.status(403).json({
        error: 'ACCOUNT_PENDING_APPROVAL',
        message: 'Seu cadastro ainda aguarda aprovação da Diretoria do Carniceiros MC.',
      });
      return;
    }

    // Login bem-sucedido: zera contador de falhas e registra último acesso
    await dbPool.query(
      `UPDATE users
       SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    // 1. Emissão de Access Token JWT de curta duração (15 min)
    const accessToken = jwt.sign(
      {
        sub: user.id,
        roadName: user.road_name,
        role: user.role_name as ClubRole,
      },
      JWT_ACCESS_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        issuer: 'carniceiros-mc-api',
        audience: 'carniceiros-mc-client',
      }
    );

    // 2. Emissão de Refresh Token opaco criptograficamente seguro e armazenamento apenas do hash SHA-256
    const rawRefreshToken = crypto.randomBytes(48).toString('base64url');
    const refreshTokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

    await dbPool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::INTERVAL)`,
      [
        user.id,
        refreshTokenHash,
        req.headers['user-agent']?.slice(0, 255) || null,
        req.ip || null,
        REFRESH_TOKEN_TTL_DAYS,
      ]
    );

    const isProd = process.env.NODE_ENV === 'production';
    const platform = req.clientPlatform ?? {
      type: req.headers['x-client-platform'] === 'mobile' ? 'MOBILE' : 'WEB',
      os: 'DESKTOP',
      authTransport: 'HTTPONLY_COOKIE',
      isNativeApp: false,
      detectedBy: 'USER_AGENT',
    };

    // Cookies HttpOnly, Secure e SameSite=Strict para blindagem contra XSS e CSRF na Web
    res.cookie('cmc_access_token', accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
      path: '/',
    });

    res.cookie('cmc_refresh_token', rawRefreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      path: '/api/auth/refresh',
    });

    res.status(200).json({
      message: 'Autenticação realizada com sucesso.',
      clientPlatform: platform,
      user: {
        id: user.id,
        fullName: user.full_name,
        roadName: user.road_name,
        email: user.email,
        role: user.role_name,
        clubRank: user.club_rank,
      },
      // Em dispositivos MOBILE detectados automaticamente, entrega também os tokens para Keychain (iOS) / Keystore (Android)
      ...(platform.type === 'MOBILE' ? { accessToken, refreshToken: rawRefreshToken } : {}),
    });
  } catch (error) {
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Não foi possível processar o login no momento.',
    });
  }
}
