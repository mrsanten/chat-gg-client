-- Phase 2: contacts + plaintext messages.
-- W phase 3+ messages dostanie kolumnę ciphertext i ten plaintext wypadnie.

-- ─────────────────────────────────────────────────────────────────────
-- Contacts
--
-- Model: relacja jest "automatycznie wzajemna". Gdy Alice doda Boba,
-- tworzymy DWA wpisy (Alice→Bob i Bob→Alice). Nie ma flow zapraszania
-- ani blokowania (phase 5+).

CREATE TABLE contacts (
    owner_id   UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    peer_id    UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    nickname   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, peer_id),
    CHECK (owner_id != peer_id)
);

-- żeby szybko znaleźć "kto ma mnie w kontaktach" (do fan-outu presence)
CREATE INDEX contacts_peer_idx ON contacts(peer_id);

-- ─────────────────────────────────────────────────────────────────────
-- Messages
--
-- Phase 2: plaintext. Phase 3 dodamy:
--   ciphertext  BYTEA NOT NULL,
--   group_id    BYTEA NOT NULL,    -- MLS GroupId
--   epoch       BIGINT NOT NULL,
-- a `body` zostanie usunięty (po migracji historii lub po prostu cut).

CREATE TABLE messages (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id    UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    recipient_id UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    body         TEXT         NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ,
    CHECK (sender_id != recipient_id)
);

-- Offline queue: szybkie pobieranie wszystkich niedostarczonych do usera.
CREATE INDEX messages_recipient_undelivered_idx
    ON messages(recipient_id, created_at)
    WHERE delivered_at IS NULL;

-- Historia konwersacji w obu kierunkach. Zapytanie wygląda tak:
--   WHERE (sender_id = $a AND recipient_id = $b)
--      OR (sender_id = $b AND recipient_id = $a)
-- Postgres potrafi użyć obu indeksów + bitmap or, ale łatwiej jest
-- mieć osobny indeks na każdą stronę.
CREATE INDEX messages_conv_a_idx ON messages(sender_id, recipient_id, created_at DESC);
CREATE INDEX messages_conv_b_idx ON messages(recipient_id, sender_id, created_at DESC);
