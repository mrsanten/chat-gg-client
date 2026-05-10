-- Phase polish: profile description (krótki opis usera, widoczny w
-- liście znajomych innych userów). Pusty string = brak opisu.

ALTER TABLE accounts
    ADD COLUMN description TEXT NOT NULL DEFAULT '';
