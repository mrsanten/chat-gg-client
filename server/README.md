# gaidu-server

Backend dla GAIdu GAIdu — auth, presence, message relay (faza 1 ma tylko auth).

Specyfikacja architektoniczna: [ADR-0001](../docs/adr/0001-network-chat-architecture.md).
Hosting: [ADR-0002](../docs/adr/0002-server-hosting.md).

## Stack

- Rust 1.84+ / Axum 0.8 / Tokio
- Postgres 17 (lokalnie via Docker)
- argon2id + JWT (HS256)
- sqlx (runtime queries, bez `query!` macra — żeby kompilacja nie wymagała
  działającej bazy)

## Endpointy

### Phase 1 (auth)

| Metoda | Ścieżka          | Auth | Opis                                       |
|--------|------------------|------|--------------------------------------------|
| GET    | `/healthz`       | —    | Liveness + ping bazy. 200 OK / 503.        |
| POST   | `/auth/register` | —    | Rejestracja konta. 201 + JWT.              |
| POST   | `/auth/login`    | —    | Logowanie. 200 + JWT.                      |
| GET    | `/me`            | JWT  | Info o zalogowanym koncie.                 |

JWT przekazywany w `Authorization: Bearer <token>`.

### Phase 2 (chat 1:1)

| Metoda | Ścieżka                    | Auth | Opis                                    |
|--------|----------------------------|------|-----------------------------------------|
| POST   | `/contacts`                | JWT  | Dodaj znajomego (auto-bidirectional).   |
| GET    | `/contacts`                | JWT  | Lista znajomych z flagą `online`.       |
| DELETE | `/contacts/:peer_id`       | JWT  | Usuń znajomego (oba kierunki).          |
| GET    | `/history?peer=&limit=&before=` | JWT | Historia konwersacji (paginowana).  |
| GET    | `/ws?token=<jwt>`          | query| Upgrade do WebSocketa.                  |

`limit` 1..=200 (default 50), `before` ISO 8601 (cursor — wiadomości starsze).

## WebSocket protokół

Auth: token w query stringu (`?token=<jwt>`), bo Tauri/przeglądarki nie mają
łatwego sposobu wysłania custom headera przy upgrade. JWT jest weryfikowany
*przed* upgrade'm, więc zły token = 401 bez handshake'u.

Po nawiązaniu połączenia, w kolejności:
1. `ServerEvent::Ready { account_id, username }`
2. Wszystkie niedostarczone wiadomości z bazy jako `Message` (FIFO).
3. Jeśli to było pierwsze połączenie tego usera → wszyscy jego znajomi
   z otwartymi WS dostają `Presence { username, online: true }`.
4. Gdy ostatnie połączenie usera zamyka się → broadcast `online: false`.

### Klient → serwer (`ClientEvent`)

```jsonc
// 1:1 wiadomość
{"type":"send", "to":"username", "body":"...", "client_msg_id":"opt"}

// Status pisania
{"type":"typing", "to":"username", "state":"start"|"stop"}

// Potwierdzenie odbioru (idempotentne)
{"type":"ack_delivery", "message_id":"<uuid>"}

// Heartbeat
{"type":"ping"}
```

### Serwer → klient (`ServerEvent`)

```jsonc
{"type":"ready", "account_id":"<uuid>", "username":"alice"}
{"type":"message", "id":"<uuid>", "from":"alice", "body":"...", "created_at":"..."}
{"type":"sent", "id":"<uuid>", "client_msg_id":"opt", "to":"bob", "created_at":"..."}
{"type":"typing", "from":"bob", "state":"start"|"stop"}
{"type":"presence", "username":"bob", "online":true}
{"type":"pong"}
{"type":"error", "code":"...", "message":"..."}
```

Limity: `body` ≤ 64 KiB. Większe = `error{code:"body_too_large"}`.

## Lokalny start

Wymagania: Rust 1.84+, Docker (na Postgresa).

```bash
cd server
cp .env.example .env

# Wystartuj Postgresa w tle. docker-compose up -d postgres
docker compose up -d postgres

# Pierwszy build dłużej (ściąga deps).
cargo run
```

Migracje SQL z `migrations/` wykonują się automatycznie przy starcie (sqlx
robi `migrate!().run()` w `AppState::from_config`). Nie trzeba osobno
odpalać `sqlx migrate run`.

## Smoke test

```bash
# Healthz
curl -s http://localhost:8080/healthz | jq

# Rejestracja
curl -s -X POST http://localhost:8080/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"hunter2hunter2"}' | jq

# Logowanie (lowercase działa, case-insensitive na username)
TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"ALICE","password":"hunter2hunter2"}' | jq -r .token)

# Sprawdz token
curl -s http://localhost:8080/me -H "authorization: Bearer $TOKEN" | jq

# Zlowane: zle haslo -> 401
curl -s -X POST http://localhost:8080/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"zle"}' -i | head -1

# Zlowane: drugi raz alice -> 409
curl -s -X POST http://localhost:8080/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"hunter2hunter2"}' -i | head -1
```

### Phase 2: contacts + chat WS

```bash
# Drugie konto
curl -s -X POST http://localhost:8080/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"bob","password":"hunter2hunter2"}' | jq

# Dodaj boba do kontaktów alice (auto-bidirectional)
curl -s -X POST http://localhost:8080/contacts \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"username":"bob"}' | jq

# Lista kontaktów alice
curl -s http://localhost:8080/contacts \
  -H "authorization: Bearer $TOKEN" | jq

# Historia z bobem (paginowana)
curl -s "http://localhost:8080/history?peer=bob&limit=20" \
  -H "authorization: Bearer $TOKEN" | jq

# WebSocket. Najprościej Node.js (ma natywny WebSocket od v22):
node -e '
const ws = new WebSocket("ws://localhost:8080/ws?token='"$TOKEN"'");
ws.onmessage = (e) => console.log("←", e.data);
ws.onopen = () => {
  setTimeout(() => ws.send(JSON.stringify({
    type:"send", to:"bob", body:"halo", client_msg_id:"x1"
  })), 200);
  setTimeout(() => ws.close(), 1500);
};
'
```

## Reset bazy lokalnie

```bash
docker compose down -v
docker compose up -d postgres
```

## Deploy na VPS (skrót, do uszczegółowienia w ADR-0003)

1. Sklonuj repo na VPS, zainstaluj Docker + Caddy.
2. W `server/.env` ustaw produkcyjny `JWT_SECRET` (`openssl rand -hex 64`)
   oraz `DATABASE_URL` wskazujący na Postgresa (też jako container).
3. Stwórz `docker-compose.prod.yml` rozszerzający `docker-compose.yml`
   o serwis `app` z lokalnym Dockerfile + sieci.
4. W Caddy:

   ```
   gaidu.example.com {
       reverse_proxy localhost:8080
   }
   ```

   ACME zrobi się sam.
5. Backup: cron `pg_dump | age | aws s3 cp -` raz dziennie.

## Reguły walidacji

- **Username**: 3–32 znaków, zestaw `[a-zA-Z0-9_.-]`. Lowercase
  porównywany w bazie (`alice` i `Alice` to to samo konto).
- **Hasło**: 8–128 znaków, brak innych ograniczeń (zgodnie z NIST
  SP 800-63B; nie wymuszamy „musi mieć dużą literę i znak specjalny").
- **Hashing**: argon2id z domyślnymi parametrami (m=19456 KiB, t=2, p=1
  jak w `argon2` crate 0.5).

## Limity, których jeszcze nie ma (TODO przed produkcją)

- Rate limiting na `/auth/login` (np. tower-governor: 5 prób / 15 min /
  IP). Bez tego brute force jest realnym ryzykiem.
- Audit log (kto, kiedy, skąd się logował).
- Refresh tokens (obecnie JWT 30 dni, brak rewokacji).
- Email verification (na razie nie ma email, tylko username).

Te issuesy idą do `issues/` jak będziemy się zbliżać do publicznego launchu.
