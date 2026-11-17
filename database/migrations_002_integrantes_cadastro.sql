-- ============================================================================
-- MIGRAÇÃO 002 — Integrantes reformulados + Solicitar Cadastro (auto-cadastro)
-- Idempotente: pode ser executada mais de uma vez.
-- ============================================================================
ALTER TABLE users DROP COLUMN IF EXISTS blood_group;
DROP TYPE IF EXISTS blood_group_type;

ALTER TABLE users ADD COLUMN IF NOT EXISTS motorcycle VARCHAR(80);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral VARCHAR(80);
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_origin VARCHAR(20) NOT NULL DEFAULT 'AUTO_CADASTRO';
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

-- Integrantes já ativos são considerados aprovados pela Diretoria
UPDATE users SET approved_at = COALESCE(approved_at, created_at), signup_origin = 'DIRETORIA'
WHERE is_active = TRUE AND approved_at IS NULL;

-- Visão de status derivado (PENDENTE / ATIVO / SUSPENSO)
CREATE OR REPLACE VIEW v_member_status AS
SELECT u.id,
       CASE
         WHEN u.suspended_at IS NOT NULL THEN 'SUSPENSO'
         WHEN u.is_active THEN 'ATIVO'
         ELSE 'PENDENTE'
       END AS member_status
FROM users u;
