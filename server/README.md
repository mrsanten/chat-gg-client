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

## Deploy na VPS

Wymaga: VPS z Linuxem (Debian/Ubuntu LTS), publicznego IPv4, domeny z
rekordem A wskazującym na ten VPS.

### Jednorazowo

1. **Zainstaluj Docker + Caddy:**
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo apt update
   sudo apt install -y caddy git
   ```

2. **Sklonuj repo, ustaw sekrety:**
   ```bash
   git clone https://github.com/mrsanten/chat-gg-client.git
   cd chat-gg-client/server
   cp .env.example .env
   sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 64)|" .env
   echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> .env
   chmod 600 .env
   ```
   `POSTGRES_PASSWORD` jest brane z env do `docker-compose.prod.yml` (patrz
   tam — DATABASE_URL składamy z tego pola).

3. **Caddy:**
   ```bash
   sudo cp Caddyfile.example /etc/caddy/Caddyfile
   sudo sed -i "s|DOMAIN.example.com|gg.tojadomena.pl|" /etc/caddy/Caddyfile
   sudo sed -i "s|admin@example.com|ty@tojadomena.pl|" /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```
   Caddy automatycznie pobierze cert z Let's Encrypt przy pierwszym żądaniu
   na domenę. Zobacz logi: `sudo journalctl -u caddy -f`.

4. **Pierwszy start:**
   ```bash
   ./scripts/deploy.sh main
   ```
   Skrypt zbuduje obraz, odpali compose z prod overlay, poczeka na
   `/healthz`. Wynik: aplikacja działa na `127.0.0.1:8080`, Caddy odbiera
   z `https://gg.tojadomena.pl` i forwarduje.

### Aktualizacja do nowej wersji

Z VPS-a (lub przez ssh):

```bash
cd ~/chat-gg-client/server
./scripts/deploy.sh main          # ostatni main
# albo:
./scripts/deploy.sh v0.7.0        # konkretny tag
```

Skrypt robi `git fetch + checkout`, rebuild obrazu, `docker compose up -d`,
i czeka aż healthcheck odpowie 200. Jeśli nie odpowie w 60s, dumpuje
ostatnie 50 linii logów.

### Backupy

Ręcznie:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm backup
# Tworzy ./backups/gaidu-YYYYMMDD-HHMMSS.sql.gz
# Auto-rotation: pliki starsze niż 14 dni są kasowane
```

W cronie hosta (codziennie o 3:00):
```bash
crontab -e
# 0 3 * * * cd /home/USER/chat-gg-client/server && docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm backup >> /var/log/gaidu-backup.log 2>&1
```

Folder `./backups/` warto syncować na zewnątrz (rclone do S3/B2, `borg`,
albo ręczny scp).

### Klient → produkcyjny serwer

W aplikacji desktop:

1. Toolbar → 🌐 Sieć
2. Server URL: `https://gg.tojadomena.pl`
3. „Sprawdź" — powinno pokazać ✓.
4. Zarejestruj się.

WSS i auto-reconnect działają same — `lib/network.ts` dobiera schemat
WS/WSS po prefixie http/https.

### Pliki używane przez deploy

- [`docker-compose.yml`](docker-compose.yml) — wspólne dla dev i prod
  (Postgres, healthcheck, volume).
- [`docker-compose.prod.yml`](docker-compose.prod.yml) — overlay: chowa
  port Postgresa, dorzuca serwis `app` zbudowany z `Dockerfile`, wystawia
  8080 tylko na localhost, dorzuca `backup` worker.
- [`Caddyfile.example`](Caddyfile.example) — szablon TLS termination z
  HSTS, JSON access logs, ukrytym `Server` headerem.
- [`scripts/deploy.sh`](scripts/deploy.sh) — git pull + rebuild + restart
  + healthcheck wait. Idempotentny.

### Co jeszcze jest poza scope tego setupu

- **Rate limiting** na `/auth/login`. Realnie potrzebne przed publicznym
  launchem; tower-governor + skonfigurowana whitelista IP.
- **Audit log** prób logowania (kto, kiedy, skąd, sukces/porażka).
- **Rewokacja JWT** — obecnie token żyje 30 dni od wystawienia, brak
  blacklisty. Wylogowanie w kliencie czyści go tylko lokalnie.
- **Refresh tokens** + krótszy access TTL (np. 1h).
- **Monitoring** (Prometheus exporter, alerty na padający `/healthz`).

Te punkty pojadą w issuesach zanim publicznie powiemy „dołącz do GAIdu".

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
