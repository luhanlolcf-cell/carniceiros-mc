BEGIN;

-- O usuário administrador deve existir em auth.users antes deste corte.
-- Vincule pelo e-mail para evitar editar um perfil de outro integrante.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE LOWER(email) = LOWER('luhanlolcf@gmail.com')
  ) THEN
    RAISE EXCEPTION 'Usuário administrador ainda não existe em auth.users. Convide o usuário antes do corte.';
  END IF;
END;
$$;

UPDATE public.profiles p
SET legacy_member_id = 'm-05',
    display_name = 'BOB',
    role = 'ADMIN',
    active = TRUE,
    can_full_edit = TRUE
FROM auth.users u
WHERE p.id = u.id AND LOWER(u.email) = LOWER('luhanlolcf@gmail.com');

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_active_member() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cmc_update_my_member_record(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cmc_add_suggestion(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.is_active_member() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.cmc_update_my_member_record(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cmc_add_suggestion(TEXT, TEXT, TEXT, TEXT) TO authenticated;

DROP POLICY IF EXISTS cmc_shared_state_all ON public.cmc_shared_state;
DROP POLICY IF EXISTS cmc_shared_state_select ON public.cmc_shared_state;
DROP POLICY IF EXISTS cmc_shared_state_insert ON public.cmc_shared_state;
DROP POLICY IF EXISTS cmc_shared_state_update ON public.cmc_shared_state;
DROP POLICY IF EXISTS cmc_shared_state_select_authenticated ON public.cmc_shared_state;
DROP POLICY IF EXISTS cmc_shared_state_insert_authenticated ON public.cmc_shared_state;
DROP POLICY IF EXISTS cmc_shared_state_update_authenticated ON public.cmc_shared_state;

REVOKE ALL ON public.cmc_shared_state FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cmc_shared_state TO authenticated;

CREATE POLICY cmc_shared_state_select_authenticated
ON public.cmc_shared_state
FOR SELECT
TO authenticated
USING (public.is_active_member() AND key <> 'pwhashes');

CREATE POLICY cmc_shared_state_insert_authenticated
ON public.cmc_shared_state
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_active_member()
  AND key <> 'pwhashes'
  AND (public.is_admin() OR key = 'suggestions')
);

CREATE POLICY cmc_shared_state_update_authenticated
ON public.cmc_shared_state
FOR UPDATE
TO authenticated
USING (
  public.is_active_member()
  AND key <> 'pwhashes'
  AND public.is_admin()
)
WITH CHECK (
  public.is_active_member()
  AND key <> 'pwhashes'
  AND public.is_admin()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE legacy_member_id = 'm-05' AND active = TRUE AND can_full_edit = TRUE
  ) THEN
    RAISE EXCEPTION 'Perfil administrativo m-05 não está ativo. Convide o usuário antes do corte.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'cmc_shared_state'
      AND 'anon' = ANY(roles)
  ) THEN
    RAISE EXCEPTION 'Ainda existe política anônima em cmc_shared_state.';
  END IF;
END;
$$;

COMMIT;
