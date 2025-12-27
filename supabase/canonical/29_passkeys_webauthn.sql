-- Passkeys/WebAuthn: tablas, RLS y RPC function
-- Ejecutar en Supabase SQL Editor

-- 1) Tabla passkeys ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE, -- base64url
  public_key text NOT NULL, -- base64url o COSE/PK en base64
  counter bigint NOT NULL DEFAULT 0,
  device_name text,
  transports jsonb, -- array de strings: ["usb", "nfc", "ble", "internal"]
  aaguid text, -- Authenticator Attestation Globally Unique Identifier
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- 2) Tabla webauthn_challenges ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid, -- null si es pre-autenticación
  email text, -- para lookup en authenticate/options
  challenge text NOT NULL, -- base64url
  type text NOT NULL CHECK (type IN ('registration', 'authentication')),
  expires_at timestamptz NOT NULL DEFAULT (now() + INTERVAL '5 minutes'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3) Índices ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_passkeys_user_id ON public.passkeys(user_id);
CREATE INDEX IF NOT EXISTS idx_passkeys_credential_id ON public.passkeys(credential_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_challenge ON public.webauthn_challenges(challenge);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires_at ON public.webauthn_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_email ON public.webauthn_challenges(email) WHERE email IS NOT NULL;

-- 4) RLS para passkeys -------------------------------------------------------
ALTER TABLE public.passkeys ENABLE ROW LEVEL SECURITY;

-- Policy: usuarios solo pueden ver sus propias passkeys
DROP POLICY IF EXISTS "Users can view own passkeys" ON public.passkeys;
CREATE POLICY "Users can view own passkeys"
  ON public.passkeys FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: usuarios solo pueden insertar sus propias passkeys
DROP POLICY IF EXISTS "Users can insert own passkeys" ON public.passkeys;
CREATE POLICY "Users can insert own passkeys"
  ON public.passkeys FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Policy: usuarios solo pueden eliminar sus propias passkeys
DROP POLICY IF EXISTS "Users can delete own passkeys" ON public.passkeys;
CREATE POLICY "Users can delete own passkeys"
  ON public.passkeys FOR DELETE
  USING (auth.uid() = user_id);

-- 5) RLS para webauthn_challenges --------------------------------------------
ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;

-- Sin policies: solo service role puede acceder (via Edge Function)
-- Esto permite que Edge Function use service role para leer/escribir challenges

-- 6) RPC Function: obtener user_id por email --------------------------------
CREATE OR REPLACE FUNCTION public.rpc_get_user_id_by_email(p_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id
  FROM auth.users
  WHERE lower(trim(email)) = lower(trim(p_email))
  LIMIT 1;
  
  RETURN v_user_id;
END;
$$;

-- 7) Comentarios -------------------------------------------------------------
COMMENT ON TABLE public.passkeys IS 'Passkeys registradas por usuario para autenticación WebAuthn';
COMMENT ON TABLE public.webauthn_challenges IS 'Challenges temporales para registro y autenticación WebAuthn';
COMMENT ON FUNCTION public.rpc_get_user_id_by_email IS 'Busca user_id por email normalizado (security definer para uso desde Edge Function)';

-- 8) Recargar API -----------------------------------------------------------
SELECT pg_notify('pgrst','reload schema');

