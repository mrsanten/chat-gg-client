-- API klucze providerów AI per konto, synchronizowane między urządzeniami.
-- Klucze zapisane plaintext — security tradeoff świadomy (self-hosted server,
-- user trzyma swój własny DB). Jak ktoś chce E2E enkrypcję kluczy, trzeba
-- by derywować klucz z password-a i szyfrować client-side.
CREATE TABLE account_api_keys (
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic', 'moonshot')),
    api_key     TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, provider)
);
