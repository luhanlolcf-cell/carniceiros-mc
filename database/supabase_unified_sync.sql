-- ============================================================================
-- CARNICEIROS MC — SUPABASE BACKEND UNIFICADO (WEB + ANDROID APK)
-- Execute este script no SQL Editor do seu projeto Supabase (https://supabase.com)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.cmc_shared_state (
  key TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

-- Habilita Row Level Security (RLS) com política de leitura/escrita para o app do clube
ALTER TABLE public.cmc_shared_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cmc_shared_state_select" ON public.cmc_shared_state;
CREATE POLICY "cmc_shared_state_select"
  ON public.cmc_shared_state
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "cmc_shared_state_insert" ON public.cmc_shared_state;
CREATE POLICY "cmc_shared_state_insert"
  ON public.cmc_shared_state
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "cmc_shared_state_update" ON public.cmc_shared_state;
CREATE POLICY "cmc_shared_state_update"
  ON public.cmc_shared_state
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- Índices e registros iniciais vazios (serão populados automaticamente pelo primeiro sync do app)
INSERT INTO public.cmc_shared_state (key, payload, updated_by)
VALUES
  ('pwhashes', '{}'::jsonb, 'SEED'),
  ('member_records', '{}'::jsonb, 'SEED'),
  ('custom_members', '[]'::jsonb, 'SEED'),
  ('meetings', '[]'::jsonb, 'SEED'),
  ('agenda_events', '[]'::jsonb, 'SEED'),
  ('tasks', '[]'::jsonb, 'SEED'),
  ('suggestions', '[]'::jsonb, 'SEED')
ON CONFLICT (key) DO NOTHING;
