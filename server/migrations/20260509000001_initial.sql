-- Initial schema dla phase 1 (auth tylko).
-- Pola crypto (master_pubkey, devices, key_packages, message_blobs) dochodza
-- w pozniejszych migracjach (phase 3+).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        TEXT NOT NULL,
    -- Lowercase + collation-aware unique check. Username 'Alice' i 'alice'
    -- to to samo konto.
    username_lower  TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger: utrzymuj updated_at na zapis.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER accounts_set_updated_at
BEFORE UPDATE ON accounts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
