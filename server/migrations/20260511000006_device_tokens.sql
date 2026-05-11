-- Tokeny push notifications per device. Klient rejestruje swój token APNs
-- (iOS) / FCM (Android, kiedyś) przez POST /me/devices. Trzymamy multi-device:
-- jeden account może mieć N tokenów (telefon + tablet + iPad).
CREATE TABLE device_tokens (
    account_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    platform       TEXT        NOT NULL CHECK (platform IN ('ios', 'android')),
    token          TEXT        NOT NULL,
    -- App bundle ID — APNs wymaga go w `apns-topic` header.
    -- Dla naszej apki: com.mrellwart.gaidugaidu (lub .voip etc., w przyszłości).
    app_bundle_id  TEXT        NOT NULL,
    -- 'development' albo 'production' — Apple ma dwie osobne instancje APNs,
    -- token z dev nie zadziała na prod i vice versa. Zapamiętujemy jak klient
    -- się zarejestrował.
    apns_env       TEXT        NOT NULL DEFAULT 'production'
        CHECK (apns_env IN ('development', 'production')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, token)
);

CREATE INDEX device_tokens_account_idx ON device_tokens(account_id);
