import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export type ClubRole = 'DIRETORIA' | 'MEMBRO' | 'PROSPECT';

export interface AuthenticatedUser {
  sub: string;       // UUID do usuário
  roadName: string;  // Alcunha no Moto Clube
  role: ClubRole;    // Perfil RBAC
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-only-replace-in-prod-32bytes-min';

/**
 * Middleware que verifica a assinatura e validade do Access Token JWT.
 * Aceita tanto o Cookie HttpOnly `cmc_access_token` (Web) quanto o Header `Authorization: Bearer` (Mobile App).
 */
export function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  const cookieToken = req.cookies?.cmc_access_token;
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  const token = cookieToken || bearerToken;

  if (!token) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Autenticação obrigatória. Faça login para acessar este recurso.',
    });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: 'carniceiros-mc-api',
      audience: 'carniceiros-mc-client',
    }) as AuthenticatedUser;

    req.user = {
      sub: payload.sub,
      roadName: payload.roadName,
      role: payload.role,
    };

    next();
  } catch (err) {
    res.status(401).json({
      error: 'TOKEN_INVALID_OR_EXPIRED',
      message: 'Sessão expirada ou token inválido.',
    });
  }
}

/**
 * Middleware de Controle de Acesso Baseado em Papéis (RBAC).
 * Garante que apenas usuários com uma das roles permitidas executem a rota.
 */
export function authorizeRoles(...allowedRoles: ClubRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Usuário não autenticado.',
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: 'FORBIDDEN_INSUFFICIENT_ROLE',
        message: `Acesso negado. Seu perfil (${req.user.role}) não possui permissão para esta operação.`,
      });
      return;
    }

    next();
  };
}
