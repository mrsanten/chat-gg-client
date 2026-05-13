-- Czaty grupowe. Każda grupa ma nazwę, autora i N członków.
-- Wiadomości w `group_messages` analogicznie do `messages` ale z group_id.
-- Brak per-device delivered tracking dla MVP — klient sam fetchuje historię.

CREATE TABLE groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    created_by  UUID NOT NULL REFERENCES accounts(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
    group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 'admin' (twórca + można promować) lub 'member'. Na razie tylko twórca
    -- jest admin-em automatycznie. Add/remove member feature będzie używać.
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    PRIMARY KEY (group_id, account_id)
);

CREATE INDEX group_members_account_idx ON group_members(account_id);

CREATE TABLE group_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    sender_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX group_messages_conv_idx ON group_messages(group_id, created_at DESC);
