import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, authorizeRoles } from '../middlewares/auth.middleware';
import { uploadBuffer, validateAndPersistUpload } from '../middlewares/upload.middleware';
import argon2 from 'argon2';
import { dbPool, strongPasswordRegex } from '../controllers/auth.controller';

const clubRouter = Router();

// Todas as rotas abaixo exigem usuário autenticado via JWT
clubRouter.use(authenticateToken);

// ============================================================================
// 0. INTEGRANTES — LISTA ÚNICA (DIRETORIA, FULL PATCH E PROSPECTS) + GESTÃO
// ============================================================================
const MEMBER_STATUS_SQL = `CASE WHEN u.suspended_at IS NOT NULL THEN 'SUSPENSO'
                               WHEN u.is_active THEN 'ATIVO'
                               ELSE 'PENDENTE' END`;
const uuidParam = z.string().uuid();

/**
 * GET /api/club/members
 * - DIRETORIA: vê todos (ativos, pendentes e suspensos) + contato de emergência.
 * - MEMBRO (Full Patch): vê apenas ativos, com telefone/e-mail (sem emergência).
 * - PROSPECT: vê apenas ativos, sem contatos nem nome civil.
 */
clubRouter.get(
  '/members',
  authorizeRoles('DIRETORIA', 'MEMBRO', 'PROSPECT'),
  async (req: Request, res: Response) => {
    const viewer = req.user!;
    const isBoard = viewer.role === 'DIRETORIA';
    const result = await dbPool.query(
      `SELECT u.id, u.full_name, u.road_name, u.email, u.phone_whatsapp,
              u.emergency_contact_name, u.emergency_contact_phone,
              u.club_rank, u.motorcycle, u.referral, u.signup_origin,
              u.approved_at, u.created_at, r.name AS role,
              ${MEMBER_STATUS_SQL} AS member_status
       FROM users u
       INNER JOIN roles r ON r.id = u.role_id
       WHERE ($1::boolean OR (u.is_active = TRUE AND u.suspended_at IS NULL))
       ORDER BY
         CASE r.name WHEN 'DIRETORIA' THEN 1 WHEN 'MEMBRO' THEN 2 ELSE 3 END,
         u.road_name ASC`,
      [isBoard]
    );

    const members = result.rows.map((m) => {
      const self = m.id === viewer.sub;
      const base = {
        id: m.id,
        roadName: m.road_name,
        role: m.role,
        clubRank: m.club_rank,
        motorcycle: m.motorcycle,
        memberStatus: m.member_status,
        memberSince: m.approved_at,
      };
      if (viewer.role === 'PROSPECT' && !self) return base;
      const withContacts = { ...base, fullName: m.full_name, email: m.email, phoneWhatsapp: m.phone_whatsapp };
      if (!isBoard && !self) return withContacts;
      return {
        ...withContacts,
        emergencyContactName: m.emergency_contact_name,
        emergencyContactPhone: m.emergency_contact_phone,
        ...(isBoard ? { referral: m.referral, signupOrigin: m.signup_origin, requestedAt: m.created_at } : {}),
      };
    });
    res.json({ members });
  }
);

// GET /api/club/members/pending — solicitações do "Solicitar Cadastro" (DIRETORIA)
clubRouter.get(
  '/members/pending',
  authorizeRoles('DIRETORIA'),
  async (_req: Request, res: Response) => {
    const result = await dbPool.query(
      `SELECT id, full_name, road_name, email, phone_whatsapp, motorcycle, referral, created_at
       FROM users
       WHERE is_active = FALSE AND approved_at IS NULL AND suspended_at IS NULL
       ORDER BY created_at ASC`
    );
    res.json({ pending: result.rows });
  }
);

// PATCH /api/club/members/:id/approve — aprova solicitação como PROSPECT (DIRETORIA)
clubRouter.patch(
  '/members/:id/approve',
  authorizeRoles('DIRETORIA'),
  async (req: Request, res: Response) => {
    const id = uuidParam.safeParse(req.params.id);
    if (!id.success) return void res.status(400).json({ error: 'INVALID_ID' });
    const result = await dbPool.query(
      `UPDATE users
       SET is_active = TRUE, approved_at = NOW(), approved_by = $2, club_rank = 'Prospect',
           role_id = (SELECT id FROM roles WHERE name = 'PROSPECT'), updated_at = NOW()
       WHERE id = $1 AND is_active = FALSE AND approved_at IS NULL AND suspended_at IS NULL
       RETURNING id, road_name`,
      [id.data, req.user!.sub]
    );
    if (!result.rowCount) return void res.status(404).json({ error: 'NOT_FOUND', message: 'Solicitação pendente não encontrada.' });
    res.json({ message: `Cadastro de ${result.rows[0].road_name} aprovado como Prospect.` });
  }
);

// DELETE /api/club/members/:id — recusa (apaga) uma solicitação PENDENTE (DIRETORIA)
clubRouter.delete(
  '/members/:id',
  authorizeRoles('DIRETORIA'),
  async (req: Request, res: Response) => {
    const id = uuidParam.safeParse(req.params.id);
    if (!id.success) return void res.status(400).json({ error: 'INVALID_ID' });
    const result = await dbPool.query(
      `DELETE FROM users WHERE id = $1 AND is_active = FALSE AND approved_at IS NULL RETURNING id`,
      [id.data]
    );
    if (!result.rowCount) return void res.status(404).json({ error: 'NOT_FOUND', message: 'Apenas solicitações pendentes podem ser recusadas.' });
    res.status(204).end();
  }
);

// PATCH /api/club/members/:id/role — promove/rebaixa patente e define cargo (DIRETORIA)
const roleChangeSchema = z.object({
  role: z.enum(['DIRETORIA', 'MEMBRO', 'PROSPECT']),
  clubRank: z.string().trim().min(2).max(40).optional(),
});
clubRouter.patch(
  '/members/:id/role',
  authorizeRoles('DIRETORIA'),
  async (req: Request, res: Response) => {
    const id = uuidParam.safeParse(req.params.id);
    const body = roleChangeSchema.safeParse(req.body);
    if (!id.success || !body.success) return void res.status(400).json({ error: 'VALIDATION_ERROR' });
    if (id.data === req.user!.sub) return void res.status(409).json({ error: 'SELF_CHANGE_FORBIDDEN', message: 'A Diretoria não altera a própria patente.' });
    const defaults = { DIRETORIA: 'Diretor', MEMBRO: 'Full Patch', PROSPECT: 'Prospect' } as const;
    const result = await dbPool.query(
      `UPDATE users
       SET role_id = (SELECT id FROM roles WHERE name = $2), club_rank = $3, updated_at = NOW()
       WHERE id = $1 AND is_active = TRUE AND suspended_at IS NULL
       RETURNING id`,
      [id.data, body.data.role, body.data.clubRank ?? defaults[body.data.role]]
    );
    if (!result.rowCount) return void res.status(404).json({ error: 'NOT_FOUND' });
    // Revoga sessões para que o novo papel valha imediatamente no próximo token
    await dbPool.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [id.data]);
    res.json({ message: 'Patente atualizada.' });
  }
);

// PATCH /api/club/members/:id/status — suspende ou reativa integrante (DIRETORIA)
const statusSchema = z.object({ status: z.enum(['ATIVO', 'SUSPENSO']) });
clubRouter.patch(
  '/members/:id/status',
  authorizeRoles('DIRETORIA'),
  async (req: Request, res: Response) => {
    const id = uuidParam.safeParse(req.params.id);
    const body = statusSchema.safeParse(req.body);
    if (!id.success || !body.success) return void res.status(400).json({ error: 'VALIDATION_ERROR' });
    if (id.data === req.user!.sub) return void res.status(409).json({ error: 'SELF_CHANGE_FORBIDDEN' });
    const suspend = body.data.status === 'SUSPENSO';
    const result = await dbPool.query(
      `UPDATE users
       SET suspended_at = CASE WHEN $2 THEN NOW() ELSE NULL END, updated_at = NOW()
       WHERE id = $1 AND approved_at IS NOT NULL
       RETURNING id`,
      [id.data, suspend]
    );
    if (!result.rowCount) return void res.status(404).json({ error: 'NOT_FOUND' });
    if (suspend) {
      await dbPool.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [id.data]);
    }
    res.json({ message: suspend ? 'Integrante suspenso.' : 'Integrante reativado.' });
  }
);

// PUT /api/club/members/:id — Edição completa da Ficha do Integrante (Exclusivo BOB / DIRETORIA)
const editMemberSheetSchema = z.object({
  roadName: z.string().trim().min(2).max(40).transform((v) => v.toUpperCase()),
  fullName: z.string().trim().min(2).max(150),
  email: z.string().trim().email().max(180).transform((v) => v.toLowerCase()),
  phoneWhatsapp: z.string().trim().min(8).max(30),
  clubRank: z.string().trim().min(2).max(60),
  role: z.enum(['DIRETORIA', 'MEMBRO', 'PROSPECT']).optional(),
  status: z.enum(['ATIVO', 'SUSPENSO', 'PENDENTE']).optional(),
  motorcycle: z.string().trim().max(80).optional(),
  emergencyContactName: z.string().trim().max(150).optional(),
  emergencyContactPhone: z.string().trim().max(30).optional(),
  referral: z.string().trim().max(60).optional(),
});

clubRouter.put(
  '/members/:id',
  authorizeRoles('DIRETORIA'),
  async (req: Request, res: Response) => {
    const id = uuidParam.safeParse(req.params.id);
    const body = editMemberSheetSchema.safeParse(req.body);
    if (!id.success || !body.success) {
      return void res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Dados inválidos na edição da ficha.' });
    }
    // Verifica que apenas BOB possui permissão de editar a ficha de qualquer integrante
    const editorCheck = await dbPool.query(`SELECT road_name FROM users WHERE id = $1`, [req.user!.sub]);
    if (!editorCheck.rowCount || editorCheck.rows[0].road_name !== 'BOB') {
      return void res.status(403).json({
        error: 'FORBIDDEN_BOB_ONLY',
        message: 'Apenas BOB (CONSELHO/SECRETARIA) possui permissão para editar a Ficha do Integrante.',
      });
    }
    const d = body.data;
    try {
      const result = await dbPool.query(
        `UPDATE users
         SET road_name = $2,
             full_name = $3,
             email = $4,
             phone_whatsapp = $5,
             club_rank = $6,
             role_id = COALESCE((SELECT id FROM roles WHERE name = $7), role_id),
             motorcycle = COALESCE($8, motorcycle),
             emergency_contact_name = COALESCE($9, emergency_contact_name),
             emergency_contact_phone = COALESCE($10, emergency_contact_phone),
             referral = COALESCE($11, referral),
             is_active = CASE WHEN $12 = 'PENDENTE' THEN FALSE ELSE TRUE END,
             suspended_at = CASE WHEN $12 = 'SUSPENSO' THEN COALESCE(suspended_at, NOW()) ELSE NULL END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, road_name, club_rank`,
        [
          id.data,
          d.roadName,
          d.fullName,
          d.email,
          d.phoneWhatsapp,
          d.clubRank,
          d.role ?? null,
          d.motorcycle ?? null,
          d.emergencyContactName ?? null,
          d.emergencyContactPhone ?? null,
          d.referral ?? null,
          d.status ?? 'ATIVO',
        ]
      );
      if (!result.rowCount) return void res.status(404).json({ error: 'NOT_FOUND', message: 'Integrante não encontrado.' });
      res.json({ message: `Ficha de ${result.rows[0].road_name} atualizada com sucesso por BOB.`, member: result.rows[0] });
    } catch (err: any) {
      if (err.code === '23505') return void res.status(409).json({ error: 'CONFLICT', message: 'E-mail ou alcunha já utilizado por outro integrante.' });
      throw err;
    }
  }
);

// ============================================================================
// 0.1 MINHA CONTA (dados próprios + troca de senha + sessões)
// ============================================================================
const profileSchema = z.object({
  fullName: z.string().trim().min(5).max(150),
  roadName: z.string().trim().regex(/^[\p{L}\s'-]{2,30}$/u).optional(),
  email: z.string().trim().email().max(180).transform((v) => v.toLowerCase()),
  phoneWhatsapp: z.string().trim().max(30).refine((v) => { const d = v.replace(/\D/g, ''); return d.length >= 10 && d.length <= 13; }),
  motorcycle: z.string().trim().max(80).optional(),
  emergencyContactName: z.string().trim().min(2).max(150),
  emergencyContactPhone: z.string().trim().max(30),
});
clubRouter.patch('/me', async (req: Request, res: Response) => {
  const body = profileSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'VALIDATION_ERROR', details: body.error.flatten().fieldErrors });
  const d = body.data;
  // A alcunha é concedida pela Diretoria: só DIRETORIA pode alterar a própria
  const roadName = req.user!.role === 'DIRETORIA' ? d.roadName ?? null : null;
  try {
    await dbPool.query(
      `UPDATE users
       SET full_name = $2, road_name = COALESCE($3, road_name), email = $4, phone_whatsapp = $5,
           motorcycle = $6, emergency_contact_name = $7, emergency_contact_phone = $8, updated_at = NOW()
       WHERE id = $1`,
      [req.user!.sub, d.fullName, roadName, d.email, d.phoneWhatsapp, d.motorcycle || null, d.emergencyContactName, d.emergencyContactPhone]
    );
    res.json({ message: 'Dados atualizados.' });
  } catch (err: any) {
    if (err.code === '23505') return void res.status(409).json({ error: 'CONFLICT', message: 'E-mail ou alcunha já em uso.' });
    throw err;
  }
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().max(128).regex(strongPasswordRegex),
});
clubRouter.patch('/me/password', async (req: Request, res: Response) => {
  const body = passwordChangeSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Nova senha fora da política de segurança.' });
  const row = await dbPool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.user!.sub]);
  if (!row.rowCount || !(await argon2.verify(row.rows[0].password_hash, body.data.currentPassword))) {
    return void res.status(401).json({ error: 'INVALID_CURRENT_PASSWORD', message: 'Senha atual incorreta.' });
  }
  const hash = await argon2.hash(body.data.newPassword, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
  await dbPool.query(`UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`, [req.user!.sub, hash]);
  // Encerra todas as sessões (refresh tokens) — o dispositivo atual precisará logar novamente
  await dbPool.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [req.user!.sub]);
  res.json({ message: 'Senha atualizada. Sessões encerradas.' });
});

clubRouter.get('/me/sessions', async (req: Request, res: Response) => {
  const result = await dbPool.query(
    `SELECT id, user_agent, created_at, expires_at FROM refresh_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC`,
    [req.user!.sub]
  );
  res.json({ sessions: result.rows });
});

clubRouter.delete('/me/sessions', async (req: Request, res: Response) => {
  await dbPool.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [req.user!.sub]);
  res.json({ message: 'Todas as sessões foram encerradas.' });
});

// ============================================================================
// A. REUNIÃO (INÍCIO/FIM, CHECKLIST DE PRESENÇA, ATA ANTERIOR & PAUTA ATUAL)
// ============================================================================

// Listar reuniões (com horário de início/fim, ata da reunião anterior, pauta atual e checklist de presentes)
clubRouter.get(
  '/meetings',
  authorizeRoles('DIRETORIA', 'MEMBRO', 'PROSPECT'),
  async (_req: Request, res: Response) => {
    const result = await dbPool.query(
      `SELECT m.id, m.title, m.scheduled_at, m.started_at, m.ended_at, m.location,
              m.previous_minutes_text, m.agenda_text, m.minutes_text, m.status,
              COALESCE(
                (SELECT json_agg(a.user_id) FROM attendance a WHERE a.meeting_id = m.id AND a.status = 'PRESENTE'),
                '[]'::json
              ) AS present_member_ids
       FROM meetings m
       ORDER BY m.scheduled_at DESC`
    );
    res.json({ meetings: result.rows });
  }
);

// Criar reunião com Ata da Reunião Anterior e Pauta Atual: exclusivo BOB (DIRETORIA)
const createMeetingSchema = z.object({
  title: z.string().trim().min(5).max(200),
  scheduledAt: z.string().datetime(),
  location: z.string().trim().min(3).max(255),
  previousMinutesText: z.string().trim().optional(),
  agendaText: z.string().trim().min(5),
  minutesText: z.string().trim().optional(),
  allowProspects: z.boolean().default(true),
});

clubRouter.post(
  '/meetings',
  authorizeRoles('DIRETORIA'),
  async (req: Request, res: Response) => {
    const parsed = createMeetingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }
    const { title, scheduledAt, location, previousMinutesText, agendaText, minutesText, allowProspects } = parsed.data;
    const result = await dbPool.query(
      `INSERT INTO meetings (title, scheduled_at, location, previous_minutes_text, agenda_text, minutes_text, allow_prospects, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [title, scheduledAt, location, previousMinutesText ?? null, agendaText, minutesText ?? null, allowProspects, req.user!.sub]
    );
    res.status(201).json({ meeting: result.rows[0] });
  }
);

// PATCH /api/club/meetings/:meetingId/start — Registra o horário de início da reunião
clubRouter.patch(
  '/meetings/:meetingId/start',
  authorizeRoles('DIRETORIA'),
  async (req: Request, res: Response) => {
    const id = uuidParam.safeParse(req.params.meetingId);
    if (!id.success) return void res.status(400).json({ error: 'INVALID_ID' });
    const result = await dbPool.query(
      `UPDATE meetings
       SET started_at = COALESCE(started_at, NOW()),
           ended_at = NULL,
           status = 'EM_ANDAMENTO',
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, title, started_at, ended_at, status`,
      [id.data]
    );
    if (!result.rowCount) return void res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ message: 'Reunião iniciada. Horário de início registrado.', meeting: result.rows[0] });
  }
);

// PATCH /api/club/meetings/:meetingId/finish — Registra o horário de fim da reunião
clubRouter.patch(
  '/meetings/:meetingId/finish',
  authorizeRoles('DIRETORIA'),
  async (req: Request, res: Response) => {
    const id = uuidParam.safeParse(req.params.meetingId);
    if (!id.success) return void res.status(400).json({ error: 'INVALID_ID' });
    const result = await dbPool.query(
      `UPDATE meetings
       SET started_at = COALESCE(started_at, NOW()),
           ended_at = NOW(),
           status = 'ENCERRADA',
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, title, started_at, ended_at, status`,
      [id.data]
    );
    if (!result.rowCount) return void res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ message: 'Reunião finalizada. Horário de término registrado.', meeting: result.rows[0] });
  }
);

// PATCH /api/club/meetings/:meetingId/documents — Atualiza Ata da Reunião Anterior, Pauta Atual e Ata Atual
const updateMeetingDocsSchema = z.object({
  previousMinutesText: z.string().trim().optional(),
  agendaText: z.string().trim().min(2),
  minutesText: z.string().trim().optional(),
});

clubRouter.patch(
  '/meetings/:meetingId/documents',
  authorizeRoles('DIRETORIA'),
  async (req: Request, res: Response) => {
    const id = uuidParam.safeParse(req.params.meetingId);
    const body = updateMeetingDocsSchema.safeParse(req.body);
    if (!id.success || !body.success) return void res.status(400).json({ error: 'VALIDATION_ERROR' });
    const result = await dbPool.query(
      `UPDATE meetings
       SET previous_minutes_text = COALESCE($2, previous_minutes_text),
           agenda_text = $3,
           minutes_text = COALESCE($4, minutes_text),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id.data, body.data.previousMinutesText ?? null, body.data.agendaText, body.data.minutesText ?? null]
    );
    if (!result.rowCount) return void res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ message: 'Ata anterior e pauta atual salvas.', meeting: result.rows[0] });
  }
);

// PUT /api/club/meetings/:meetingId/checklist — Salva o checklist completo de membros presentes na reunião
const checklistSchema = z.object({
  presentMemberIds: z.array(z.string().uuid()),
});

clubRouter.put(
  '/meetings/:meetingId/checklist',
  authorizeRoles('DIRETORIA'),
  async (req: Request, res: Response) => {
    const id = uuidParam.safeParse(req.params.meetingId);
    const body = checklistSchema.safeParse(req.body);
    if (!id.success || !body.success) return void res.status(400).json({ error: 'VALIDATION_ERROR' });

    await dbPool.query(`DELETE FROM attendance WHERE meeting_id = $1`, [id.data]);
    for (const memberId of body.data.presentMemberIds) {
      await dbPool.query(
        `INSERT INTO attendance (meeting_id, user_id, status, method, recorded_by)
         VALUES ($1, $2, 'PRESENTE', 'MANUAL_SECRETARIO', $3)
         ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = 'PRESENTE', checked_in_at = NOW()`,
        [id.data, memberId, req.user!.sub]
      );
    }
    res.json({ message: 'Checklist de presença atualizado.', presentCount: body.data.presentMemberIds.length });
  }
);

// Check-in individual de presença na reunião
clubRouter.post(
  '/meetings/:meetingId/attendance',
  authorizeRoles('DIRETORIA', 'MEMBRO'),
  async (req: Request, res: Response) => {
    const { meetingId } = req.params;
    const targetUserId =
      req.user!.role === 'DIRETORIA' && req.body.memberId ? req.body.memberId : req.user!.sub;
    const method =
      req.user!.role === 'DIRETORIA' && req.body.memberId ? 'MANUAL_SECRETARIO' : 'APP_QRCODE';

    const result = await dbPool.query(
      `INSERT INTO attendance (meeting_id, user_id, status, method, recorded_by)
       VALUES ($1, $2, 'PRESENTE', $3, $4)
       ON CONFLICT (meeting_id, user_id)
       DO UPDATE SET status = 'PRESENTE', checked_in_at = NOW()
       RETURNING *`,
      [meetingId, targetUserId, method, req.user!.sub]
    );
    res.status(200).json({ attendance: result.rows[0] });
  }
);

// ============================================================================
// B. GESTÃO DE EVENTOS, EVENTOS OBRIGATÓRIOS E UPLOAD DE FLYER
// ============================================================================

// Listar eventos: Prospects visualizam apenas eventos com is_public_to_prospects = TRUE
clubRouter.get(
  '/events',
  authorizeRoles('DIRETORIA', 'MEMBRO', 'PROSPECT'),
  async (req: Request, res: Response) => {
    const isProspect = req.user!.role === 'PROSPECT';
    const result = await dbPool.query(
      `SELECT id, title, description, start_at, end_at, location, is_mandatory,
              is_public_to_prospects, flyer_storage_key
       FROM events
       WHERE ($1 = FALSE OR is_public_to_prospects = TRUE)
       ORDER BY start_at ASC`,
      [isProspect]
    );
    res.json({ events: result.rows });
  }
);

// Criar evento com upload seguro de Flyer: exclusivo para DIRETORIA
clubRouter.post(
  '/events',
  authorizeRoles('DIRETORIA'),
  uploadBuffer.single('flyer'),
  validateAndPersistUpload,
  async (req: Request, res: Response) => {
    const attachment = (req as any).validatedAttachment;
    const { title, description, startAt, endAt, location, isMandatory, isPublicToProspects } = req.body;

    const result = await dbPool.query(
      `INSERT INTO events (
         title, description, start_at, end_at, location,
         is_mandatory, is_public_to_prospects, flyer_storage_key, flyer_mime_type, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        title,
        description,
        startAt,
        endAt || null,
        location,
        isMandatory === 'true' || isMandatory === true,
        isPublicToProspects !== 'false',
        attachment?.storageKey || null,
        attachment?.mimeType || null,
        req.user!.sub,
      ]
    );
    res.status(201).json({ event: result.rows[0] });
  }
);

// ============================================================================
// C. GESTÃO DE TAREFAS (TO-DO / AÇÕES)
// ============================================================================

// Membros visualizam e atualizam o status de suas tarefas; Diretoria cria e atribui
clubRouter.patch(
  '/tasks/:taskId/status',
  authorizeRoles('DIRETORIA', 'MEMBRO'),
  async (req: Request, res: Response) => {
    const { taskId } = req.params;
    const statusSchema = z.enum(['PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDO', 'ATRASADO']);
    const parsed = statusSchema.safeParse(req.body.status);

    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_STATUS' });
      return;
    }

    // Se for MEMBRO, garante que ele é um dos responsáveis atribuídos à tarefa
    if (req.user!.role === 'MEMBRO') {
      const checkAssignee = await dbPool.query(
        `SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
        [taskId, req.user!.sub]
      );
      if (checkAssignee.rowCount === 0) {
        res.status(403).json({ error: 'FORBIDDEN', message: 'Você só pode atualizar tarefas atribuídas a você.' });
        return;
      }
    }

    const updated = await dbPool.query(
      `UPDATE tasks SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [parsed.data, taskId]
    );
    res.json({ task: updated.rows[0] });
  }
);

// DELETE /api/club/tasks/:taskId — exclui uma tarefa
clubRouter.delete(
  '/tasks/:taskId',
  authorizeRoles('DIRETORIA', 'MEMBRO'),
  async (req: Request, res: Response) => {
    const id = uuidParam.safeParse(req.params.taskId);
    if (!id.success) return void res.status(400).json({ error: 'INVALID_ID' });
    const deleted = await dbPool.query(`DELETE FROM tasks WHERE id = $1 RETURNING id`, [id.data]);
    if (!deleted.rowCount) return void res.status(404).json({ error: 'NOT_FOUND', message: 'Tarefa não encontrada.' });
    res.status(204).end();
  }
);

// ============================================================================
// E. SUGESTÕES E OBSERVAÇÕES (ABERTO A TODOS OS PERFIS, INCLUINDO PROSPECTS)
// ============================================================================

const suggestionSchema = z.object({
  subject: z.string().trim().min(4).max(180),
  content: z.string().trim().min(10).max(4000),
});

clubRouter.post(
  '/suggestions',
  authorizeRoles('DIRETORIA', 'MEMBRO', 'PROSPECT'),
  async (req: Request, res: Response) => {
    const parsed = suggestionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }

    const result = await dbPool.query(
      `INSERT INTO suggestions (user_id, subject, content)
       VALUES ($1, $2, $3)
       RETURNING id, subject, status, created_at`,
      [req.user!.sub, parsed.data.subject, parsed.data.content]
    );
    res.status(201).json({ suggestion: result.rows[0] });
  }
);

export default clubRouter;
