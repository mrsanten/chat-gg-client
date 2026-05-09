-- Phase 3 (MLS — RFC 9420). Trzy tabele dodane obok istniejacych:
--  - key_packages    publiczne paczki, klient publikuje, drugi klient consumuje
--                    przy starcie nowej grupy
--  - welcomes        kolejka MLS Welcome message-y dla offline klientow
--  - message_blobs   zaszyfrowane Application message-y (zastapi plain `messages`
--                    dla nowych konwersacji; stara tabela zostaje na legacy chats)
--
-- Phase 4 dorzuci device_id w obu (multi-device): KeyPackage jest per-device,
-- adresowanie Welcome i blob-ow tez per-device. Na razie 1 device per account.

CREATE TABLE key_packages (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    data        BYTEA        NOT NULL,                  -- serializowany openmls KeyPackage
    consumed    BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    consumed_at TIMESTAMPTZ
);

-- Szybkie pobieranie pierwszego niekonsumowanego KP danego usera
-- (LIMIT 1 ORDER BY created_at).
CREATE INDEX key_packages_account_unconsumed_idx
    ON key_packages(account_id, created_at)
    WHERE NOT consumed;

CREATE TABLE welcomes (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id  UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    sender_id     UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    ciphertext    BYTEA        NOT NULL,                -- serializowany MlsMessage Welcome
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    delivered_at  TIMESTAMPTZ
);

CREATE INDEX welcomes_recipient_undelivered_idx
    ON welcomes(recipient_id, created_at)
    WHERE delivered_at IS NULL;

CREATE TABLE message_blobs (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id     UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    recipient_id  UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    group_id      BYTEA        NOT NULL,                -- MLS GroupId (do routingu po kliencie)
    epoch         BIGINT       NOT NULL,                -- numer epoki MLS (do detekcji desync)
    ciphertext    BYTEA        NOT NULL,                -- serializowany PrivateMessage
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    delivered_at  TIMESTAMPTZ,
    CHECK (sender_id != recipient_id)
);

CREATE INDEX message_blobs_recipient_undelivered_idx
    ON message_blobs(recipient_id, created_at)
    WHERE delivered_at IS NULL;

-- Konwersacje per-grupa do paginowanej historii.
CREATE INDEX message_blobs_group_idx
    ON message_blobs(group_id, created_at DESC);
