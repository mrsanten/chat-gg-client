-- AI sessions (czaty z modelami) per-konto, synchronizowane między urządzeniami.
-- Wiadomości trzymane jako JSONB array żeby przy fetch dostać całą sesję
-- bez join-ów. Limit rozmiaru po app-side (typowy chat to <1 MB).
CREATE TABLE ai_sessions (
    id          UUID PRIMARY KEY,
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    model_id    TEXT NOT NULL,
    title       TEXT NOT NULL,
    messages    JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX ai_sessions_account_idx ON ai_sessions(account_id, updated_at DESC);
