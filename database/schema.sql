-- ============================================================================
-- CARNICEIROS MC - SISTEMA DE GESTÃO INTERNA (POSTGRESQL SCHEMA)
-- ============================================================================

-- Extensões necessárias para UUID e criptografia adicional
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. ENUMs para integridade de domínio
CREATE TYPE role_type AS ENUM ('DIRETORIA', 'MEMBRO', 'PROSPECT');
CREATE TYPE meeting_status AS ENUM ('AGENDADA', 'EM_ANDAMENTO', 'ENCERRADA', 'CANCELADA');
CREATE TYPE attendance_status AS ENUM ('PRESENTE', 'FALTA', 'FALTA_JUSTIFICADA');
CREATE TYPE checkin_method AS ENUM ('APP_QRCODE', 'APP_GEO', 'MANUAL_SECRETARIO');
CREATE TYPE task_status AS ENUM ('PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDO', 'ATRASADO');
CREATE TYPE suggestion_status AS ENUM ('RECEBIDA', 'EM_ANALISE', 'APROVADA', 'ARQUIVADA');
CREATE TYPE attachment_entity AS ENUM ('MEETING', 'TASK', 'EVENT', 'SUGGESTION');

-- 2. Tabela de Perfis de Acesso (Roles)
CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    name role_type UNIQUE NOT NULL,
    description VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO roles (name, description) VALUES
    ('DIRETORIA', 'Acesso total: cria reuniões, pautas, atas, eventos obrigatórios, tarefas e aprova membros.'),
    ('MEMBRO', 'Acesso pleno de integrante: visualiza pautas/atas, faz check-in, gerencia suas tarefas e envia sugestões.'),
    ('PROSPECT', 'Acesso restrito de aspirante: visualiza apenas eventos públicos/gerais e envia sugestões.');

-- 3. Tabela de Usuários / Integrantes (Lista Unificada: Diretoria, Full Patch e Prospects)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    full_name VARCHAR(150) NOT NULL,
    road_name VARCHAR(80) UNIQUE NOT NULL, -- Alcunha / Apunha no Moto Clube
    email VARCHAR(180) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,           -- Argon2id hash
    phone_whatsapp VARCHAR(30) NOT NULL,
    emergency_contact_name VARCHAR(150),
    emergency_contact_phone VARCHAR(30),
    club_rank VARCHAR(80) DEFAULT 'Prospect', -- Ex: Presidente, Vice, Sgt. de Armas, Secretário, Tesoureiro, Full Patch, Prospect
    is_active BOOLEAN NOT NULL DEFAULT FALSE, -- Requer aprovação da Diretoria no cadastro
    motorcycle VARCHAR(80),                   -- Máquina do integrante (marca / modelo)
    referral VARCHAR(80),                     -- Indicação / padrinho informado no auto-cadastro
    signup_origin VARCHAR(20) NOT NULL DEFAULT 'AUTO_CADASTRO' CHECK (signup_origin IN ('AUTO_CADASTRO', 'DIRETORIA')),
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,                  -- NULL + is_active=FALSE => solicitação PENDENTE
    suspended_at TIMESTAMPTZ,                 -- preenchido => integrante SUSPENSO
    failed_login_attempts SMALLINT NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role_id ON users(role_id);

-- 4. Tabela de Refresh Tokens (Controle de Sessão e Revogação)
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, -- SHA-256 do refresh token
    user_agent TEXT,
    ip_address INET,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- 5. Tabela de Reuniões (Início/Fim, Ata Anterior, Pauta Atual e Ata Oficial)
CREATE TABLE meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,                -- Horário real de início registrado ao clicar em "Iniciar Reunião"
    ended_at TIMESTAMPTZ,                  -- Horário real de término registrado ao clicar em "Finalizar Reunião"
    location VARCHAR(255) NOT NULL,
    previous_minutes_text TEXT,            -- Ata da Reunião Anterior
    agenda_text TEXT NOT NULL,             -- Pauta dessa Reunião Atual
    minutes_text TEXT,                     -- Ata oficial registrada pelo Secretário (BOB)
    status meeting_status NOT NULL DEFAULT 'AGENDADA',
    checkin_code VARCHAR(16),              -- Código/token temporário para check-in na reunião
    allow_prospects BOOLEAN NOT NULL DEFAULT FALSE,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_meetings_scheduled_at ON meetings(scheduled_at DESC);

-- 6. Tabela de Chamada de Presença (Attendance)
CREATE TABLE attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status attendance_status NOT NULL DEFAULT 'PRESENTE',
    method checkin_method NOT NULL DEFAULT 'APP_QRCODE',
    justification TEXT,
    checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recorded_by UUID REFERENCES users(id) ON DELETE SET NULL, -- Preenchido quando manual pelo secretário
    UNIQUE (meeting_id, user_id)
);

CREATE INDEX idx_attendance_meeting_id ON attendance(meeting_id);
CREATE INDEX idx_attendance_user_id ON attendance(user_id);

-- 7. Tabela de Eventos e Calendário
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ,
    location VARCHAR(255) NOT NULL,
    is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,   -- Destaque visual de presença obrigatória
    is_public_to_prospects BOOLEAN NOT NULL DEFAULT TRUE, -- Define se Prospects podem visualizar
    flyer_storage_key VARCHAR(512),                -- Caminho/chave segura (UUID.ext) no S3/Storage
    flyer_mime_type VARCHAR(64),
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_start_at ON events(start_at ASC);
CREATE INDEX idx_events_visibility ON events(is_public_to_prospects, is_mandatory);

-- 8. Tabela de Tarefas (To-Do / Ações)
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    due_date TIMESTAMPTZ NOT NULL,
    status task_status NOT NULL DEFAULT 'PENDENTE',
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tabela N:N para múltiplos responsáveis por tarefa
CREATE TABLE task_assignees (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (task_id, user_id)
);

CREATE INDEX idx_tasks_status_due ON tasks(status, due_date);
CREATE INDEX idx_task_assignees_user ON task_assignees(user_id);

-- 9. Tabela de Sugestões e Observações
CREATE TABLE suggestions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject VARCHAR(180) NOT NULL,
    content TEXT NOT NULL,
    status suggestion_status NOT NULL DEFAULT 'RECEBIDA',
    board_Notes TEXT, -- Resposta/parecer interno da Diretoria
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_suggestions_status ON suggestions(status);

-- 10. Tabela de Anexos Seguros (Reuniões, Atas, Tarefas, Sugestões)
CREATE TABLE attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type attachment_entity NOT NULL,
    entity_id UUID NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    storage_key VARCHAR(512) UNIQUE NOT NULL, -- Nome criptografado/UUID sem execução no servidor
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 15728640), -- Máx 15MB
    sha256_checksum CHAR(64) NOT NULL,
    uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_attachments_entity ON attachments(entity_type, entity_id);
