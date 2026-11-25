BEGIN;

CREATE TABLE IF NOT EXISTS public.cmc_shared_state (
  key TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

ALTER TABLE public.cmc_shared_state ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.cmc_shared_state_backup_20261125 (
  key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.cmc_shared_state_backup_20261125 (key, payload, updated_at, updated_by)
SELECT key, payload, updated_at, updated_by
FROM public.cmc_shared_state
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON public.cmc_shared_state_backup_20261125 FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  legacy_member_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'MEMBER',
  active BOOLEAN NOT NULL DEFAULT FALSE,
  can_full_edit BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS profiles_legacy_member_id_idx ON public.profiles(legacy_member_id);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profiles FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.is_active_member()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid() AND p.active = TRUE
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid() AND p.active = TRUE AND p.can_full_edit = TRUE
  );
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_active_member() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_member() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

DROP POLICY IF EXISTS profiles_select_self ON public.profiles;
CREATE POLICY profiles_select_self
ON public.profiles
FOR SELECT
TO authenticated
USING (id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS profiles_admin_update ON public.profiles;
CREATE POLICY profiles_admin_update
ON public.profiles
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, legacy_member_id, display_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'legacy_member_id', 'auth-' || NEW.id::TEXT),
    COALESCE(NEW.raw_user_meta_data ->> 'display_name', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'role', 'MEMBER')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.cmc_update_my_member_record(p_patch JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_member_id TEXT;
  v_actor TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Sessão autenticada obrigatória.';
  END IF;

  IF jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Os dados enviados devem ser um objeto JSON.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_patch) AS field
    WHERE field NOT IN ('name', 'phone', 'email', 'emergency', 'bike')
  ) THEN
    RAISE EXCEPTION 'Somente os campos pessoais autorizados podem ser alterados.';
  END IF;

  SELECT legacy_member_id, display_name
  INTO v_member_id, v_actor
  FROM public.profiles
  WHERE id = v_user_id AND active = TRUE;

  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'Perfil inativo ou não vinculado a um integrante.';
  END IF;

  UPDATE public.cmc_shared_state
  SET payload = jsonb_set(
        payload,
        ARRAY[v_member_id],
        COALESCE(payload -> v_member_id, '{}'::JSONB) || p_patch,
        TRUE
      ),
      updated_at = NOW(),
      updated_by = v_actor
  WHERE key = 'member_records';

  IF NOT FOUND THEN
    INSERT INTO public.cmc_shared_state (key, payload, updated_by)
    VALUES ('member_records', jsonb_build_object(v_member_id, p_patch), v_actor);
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.cmc_update_my_member_record(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cmc_update_my_member_record(JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.cmc_add_suggestion(
  p_subject TEXT,
  p_content TEXT,
  p_attachment TEXT DEFAULT NULL,
  p_attachment_data_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_member_id TEXT;
  v_actor TEXT;
  v_record JSONB;
  v_author TEXT;
  v_payload JSONB;
  v_suggestion JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Sessão autenticada obrigatória.';
  END IF;

  IF p_subject IS NULL OR btrim(p_subject) = '' OR length(p_subject) > 160 THEN
    RAISE EXCEPTION 'Informe um assunto de 1 a 160 caracteres.';
  END IF;

  IF p_content IS NULL OR btrim(p_content) = '' OR length(p_content) > 5000 THEN
    RAISE EXCEPTION 'Informe uma descrição de 1 a 5000 caracteres.';
  END IF;

  IF p_attachment IS NOT NULL AND length(p_attachment) > 500 THEN
    RAISE EXCEPTION 'O nome do anexo é muito longo.';
  END IF;

  IF p_attachment_data_url IS NOT NULL AND length(p_attachment_data_url) > 4000000 THEN
    RAISE EXCEPTION 'O anexo excede o limite de 4 MB.';
  END IF;

  SELECT legacy_member_id, display_name
  INTO v_member_id, v_actor
  FROM public.profiles
  WHERE id = v_user_id AND active = TRUE;

  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'Perfil inativo ou não vinculado a um integrante.';
  END IF;

  SELECT payload -> v_member_id
  INTO v_record
  FROM public.cmc_shared_state
  WHERE key = 'member_records';

  v_author := COALESCE(NULLIF(v_record ->> 'roadName', ''), NULLIF(v_actor, ''), 'INTEGRANTE');
  IF NULLIF(v_record ->> 'rankLabel', '') IS NOT NULL THEN
    v_author := v_author || ' (' || (v_record ->> 'rankLabel') || ')';
  END IF;

  v_suggestion := jsonb_build_object(
    'id', 'sug-' || replace(gen_random_uuid()::TEXT, '-', ''),
    'author', v_author,
    'subject', btrim(p_subject),
    'content', btrim(p_content),
    'attachment', NULLIF(btrim(p_attachment), ''),
    'attachmentDataUrl', p_attachment_data_url,
    'status', 'RECEBIDA'
  );

  SELECT payload
  INTO v_payload
  FROM public.cmc_shared_state
  WHERE key = 'suggestions'
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.cmc_shared_state (key, payload, updated_by)
    VALUES ('suggestions', jsonb_build_array(v_suggestion), v_actor);
  ELSE
    IF jsonb_typeof(v_payload) <> 'array' THEN
      RAISE EXCEPTION 'A lista de sugestões está em um formato inválido.';
    END IF;
    UPDATE public.cmc_shared_state
    SET payload = v_payload || jsonb_build_array(v_suggestion),
        updated_at = NOW(),
        updated_by = v_actor
    WHERE key = 'suggestions';
  END IF;

  RETURN v_suggestion;
END;
$$;

REVOKE ALL ON FUNCTION public.cmc_add_suggestion(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cmc_add_suggestion(TEXT, TEXT, TEXT, TEXT) TO authenticated;

INSERT INTO public.cmc_shared_state (key, payload, updated_by)
VALUES
  ('member_records', '{}'::JSONB, 'SEED'),
  ('custom_members', '[]'::JSONB, 'SEED'),
  ('meetings', '[]'::JSONB, 'SEED'),
  ('agenda_events', '[]'::JSONB, 'SEED'),
  ('tasks', '[]'::JSONB, 'SEED'),
  ('suggestions', '[]'::JSONB, 'SEED')
ON CONFLICT (key) DO NOTHING;

COMMIT;
