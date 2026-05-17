-- Załączniki obrazkowe do wiadomości peer (1:1) i grupowych. Lista data
-- URL-i (`data:image/...;base64,...`) przechowywana jako JSONB; domyślnie
-- pusta tablica, więc istniejące wiersze pozostają poprawne.
ALTER TABLE messages ADD COLUMN images JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE group_messages ADD COLUMN images JSONB NOT NULL DEFAULT '[]'::jsonb;
