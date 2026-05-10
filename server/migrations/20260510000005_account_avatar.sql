-- Avatar usera: data URL (np. "data:image/jpeg;base64,...") max ~200 KB.
-- Trzymamy plain w TEXT zamiast bytea+mime-type, bo i tak po stronie klienta
-- używamy data URL, a TEXT lepiej się komponuje z JSON-em w API.
ALTER TABLE accounts
    ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
