# ADR-0001: Architektura czatu między użytkownikami

- **Status:** Accepted
- **Data:** 2026-05-09
- **Autor:** stakeholder (z asystą Claude)

## Kontekst

GAIdu GAIdu jest obecnie klientem desktop (Tauri 2 + React) rozmawiającym
z modelami AI przez API trzecich providerów (Anthropic, OpenAI, Moonshot).
Cały stack jest klient-only: nie mamy serwera, nie mamy kont, nie mamy
backendu.

Pojawia się wymaganie: dorzucić czat między użytkownikami w stylu
Gadu-Gadu. Po dyskusji ze stakeholderem ustalono następujący
zakres MVP:

| # | Wymaganie                                       | Wartość |
|---|-------------------------------------------------|---------|
| 1 | Tryb rozmów                                     | 1:1 oraz grupy |
| 2 | Dostarczanie offline                            | TAK (wiadomość zostaje w kolejce do reloginu adresata) |
| 3 | Identyfikacja                                   | username (system kont, login + hasło) |
| 4 | Szyfrowanie end-to-end                          | TAK |
| 5 | Multi-device (kilka urządzeń per konto)         | TAK |

To jest zakres klasy Signal/Wire/Matrix. Spodziewamy się 3–6 miesięcy
pracy do wersji production-ready (jedna osoba, weekendy/wieczory).

## Decyzja

### Crypto: **OpenMLS** (RFC 9420 — Messaging Layer Security)

Wybieramy MLS zamiast Signal Protocol (Double Ratchet + Sender Keys),
bo:

1. **MLS jest natywnie grupowy.** Skalowanie operacji w grupie to O(log n)
   zamiast O(n) w Sender Keys. Wymaganie #1 (grupy) sprawia, że to ma
   znaczenie nawet przy małych grupach.
2. **Multi-device w MLS jest jednolite.** Każde urządzenie to liść drzewa,
   konwersacja Alice↔Bob z 2+3 urządzeniami to po prostu grupa MLS o 5
   liściach. To samo API co dla 50-osobowej grupy.
3. **Specyfikacja jest publiczna, ustabilizowana** (RFC 9420, marzec 2023).
4. **Crate `openmls`** ma stabilne API i jest aktywnie utrzymywany
   (Phoenix R&D + społeczność).
5. **Forward secrecy + Post-Compromise Security** są wbudowane w protokół
   przez wymagane commits.

Crate: `openmls` + `openmls_rust_crypto` w `src-tauri/`.

#### Co odrzucamy

- **Signal Protocol bezpośrednio** — Sender Keys w grupach to praca, której
  MLS już nie wymaga. Reference impl `libsignal` jest świetna do 1:1, ale
  do grup musielibyśmy implementować sender key distribution sami.
- **Roll-our-own na Curve25519/ChaCha20-Poly1305** — droga do CVE.
- **Federation z Matrix** — gigantyczny scope, nie potrzebny przy zamkniętej
  sieci znajomych.

### Backend: **Rust + Axum + Postgres + Redis**

- **Rust+Axum** — re-use kodu (typy DTO współdzielone z klientem przez
  shared crate), jeden język w stacku, pasuje do tego co już mamy w
  `src-tauri/`. Async-friendly.
- **Postgres** — identity, KeyPackages, encrypted message queue, presence,
  members. SQL, transakcje, sprawdzony.
- **Redis** — pub/sub do fan-outu wiadomości między procesami serwera, gdy
  za jakiś czas wskoczymy na 2+ instancje. Na początek opcjonalny.

#### Hosting

Fly.io albo własny VPS (Hetzner CX22 ~5 EUR/mc). Postgres jako addon na
Fly albo na osobnym CX22. Decyzja w osobnym ADR przed deploymentem
phase 1.

#### Co odrzucamy

- **Bun + Hono** — szybsze do napisania, ale stracilibyśmy zysk z jednego
  języka i shared crate dla MLS struktur. Akceptujemy ~30% wolniejszy
  development w zamian za lepszą integrację.
- **Supabase / Convex** — vendor lock-in, nie kontrolujemy presence
  ani protokołu wire. Dla E2E-first projektu, gdzie serwer ma być cienki
  i niezaufany, lepsze własne rozwiązanie.
- **Matrix Synapse / Conduit** — overkill, federation której nie używamy,
  duża powierzchnia ataku.

### Transport: **WebSocket + binary frames (CBOR)**

- HTTPS/REST dla operacji „cold": auth, KeyPackage publish/fetch,
  device linking, history paging.
- WSS dla real-time: doręczanie message blobs, MLS group events,
  presence updates, typing indicators.
- Binary frames (CBOR) zamiast JSON, bo MLS commits potrafią mieć
  kilkanaście kB, a base64 w JSON spuchnie ich o 33%.
- Crate: `tokio-tungstenite` po stronie klienta (w Rust), `axum::ws` po
  stronie serwera. CBOR via `ciborium`.

### Lokalna persistencja: **SQLite via `tauri-plugin-sql`**

Każde urządzenie ma swoją bazę:

- Identity keys (zaszyfrowane master keyem, master key w OS keychain
  via `tauri-plugin-keyring` lub własny wrapper).
- MLS group states (serializowany `MlsGroup` per grupa).
- Plain text history (decrypted, bo i tak masz lokalny dostęp).
- Cache profili znajomych.

Crate: `sqlx` w Rust, w TS używamy Tauri commands jako jedyny entry
point do bazy (TS nigdy nie dotyka SQLite bezpośrednio).

### Identity model

```
Account
├── username (unique, primary identyfikator)
├── master_signing_key (Ed25519, generowany przy rejestracji)
└── Devices [N urządzeń]
    ├── device_id (UUID)
    ├── device_signing_key (Ed25519, per device)
    ├── device_name (np. "MacBook Pro Mateusza")
    └── certificate {device_pubkey, account_id, podpis przez master_key}
```

Master key nie opuszcza primary device. Dodanie nowego urządzenia
wymaga primary device do podpisania DeviceCertificate (flow QR-based).

### Konwersacje

- **1:1 chat z Bobem** = MLS group, leaves = wszystkie devices Alice +
  wszystkie devices Boba.
- **Grupowy chat** = MLS group z N×devices_per_member liści.
- **Self-group** (sync między własnymi devices) = MLS group z samymi
  Twoimi devices. Każdą wysłaną wiadomość duplikujemy do self-group,
  żeby telefon i laptop widziały to samo.

Group membership jest publiczne dla serwera (musi wiedzieć, do kogo
routować ciphertext). Treść — niewidoczna.

### Schema bazy (skrót)

```sql
accounts (
  id            uuid primary key,
  username      text unique not null,
  password_hash text not null,         -- bcrypt
  master_pubkey bytea not null,
  created_at    timestamptz default now()
);

devices (
  id              uuid primary key,
  account_id      uuid references accounts(id),
  name            text not null,
  signing_pubkey  bytea not null,
  certificate     bytea not null,      -- podpisany przez master_key
  last_seen_at    timestamptz,
  revoked_at      timestamptz
);

key_packages (
  id              uuid primary key,
  device_id       uuid references devices(id),
  data            bytea not null,      -- serializowany MLS KeyPackage
  consumed        bool default false,
  created_at      timestamptz default now()
);

message_blobs (
  id                  uuid primary key,
  recipient_device_id uuid references devices(id),
  group_id            bytea not null,
  epoch               bigint not null,
  ciphertext          bytea not null,
  created_at          timestamptz default now(),
  delivered_at        timestamptz
);

welcomes (
  id                  uuid primary key,
  recipient_device_id uuid references devices(id),
  ciphertext          bytea not null,  -- MLS Welcome message
  created_at          timestamptz default now()
);

-- Index na queue per device:
-- CREATE INDEX ON message_blobs (recipient_device_id, delivered_at NULLS FIRST);
```

Serwer **nigdy** nie widzi plaintextu wiadomości. Widzi metadata: kto
do kogo, kiedy, ile bajtów. To jest świadomy trade-off i powinno być
ujawnione w docs/PRIVACY.md przy launchu.

## Phased plan

| Faza | Zakres                                    | Czas (estymata) |
|------|-------------------------------------------|-----------------|
| 1    | Server + auth (rejestracja, login, JWT)   | 1–2 tygodnie    |
| 2    | Plain-text WebSocket chat 1:1, offline    | 2 tygodnie      |
| 3    | MLS 1:1 (jeden device per user na razie)  | 3–4 tygodnie    |
| 4    | Multi-device: linking, self-group         | 2–3 tygodnie    |
| 5    | Grupy (UI + MLS Add/Remove)               | 2 tygodnie      |
| 6    | Polish: push notifications, typing, etc.  | otwarte         |

Po phase 2 mamy DZIAŁAJĄCY messenger (bez E2E). To jest świadomy etap
walidacji UX zanim wlejemy crypto.

## Konsekwencje

### Pozytywne

- Pełna kontrola nad protokołem, danymi, hostingiem.
- E2E-first: serwer jest „dumb pipe", można go atakować i nadal nie
  wycieka treść rozmów.
- MLS daje group + multi-device w jednym mechanizmie.
- Stack Rust+Postgres+Tauri to mainstream — łatwo o pomoc i biblioteki.

### Negatywne / ryzyka

- **Scope.** 3–6 miesięcy. Realne ryzyko, że projekt utknie po phase 2.
  Mitigation: po phase 2 mamy działający messenger, można żyć bez E2E.
- **Crypto bugs.** Mimo użycia openmls, można źle złożyć protokół na
  poziomie aplikacji (np. zignorować epoch mismatch, nie weryfikować
  certyfikatów device). Mitigation: testy integracyjne dwóch klientów,
  audit przed launchem.
- **Storage growth.** Każdy commit MLS rotuje klucze i obciąża bazę
  klienta. Po roku rozmów lokalna baza może mieć kilkaset MB. Mitigation:
  garbage collect epok > N (do uzgodnienia w future ADR).
- **Mobile.** Tauri 2 wspiera mobile, ale nie testowaliśmy. Linkowanie
  device QR-em zakłada, że mamy mobilną apkę. Phase 4 może wymagać
  zwrotu na desktop-only multi-device (drugi laptop tej samej osoby).
- **Brak push notifications dla iOS** bez płatnego konta Apple Developer.
  Phase 6 pokaże, czy to blocker.
- **Operacyjny ciężar.** Mam serwer = mam uptime, backupy, monitoring,
  patche. To nie zniknie. Mitigation: na razie najlżejsze możliwe
  rozwiązanie (Postgres on Fly + healthcheck).

## Alternatywy rozważone

### A. Matrix Synapse + własny client w Tauri
- Plus: gotowe E2E (Olm/Megolm), federation za free, gotowy ekosystem.
- Minus: Synapse to ~150k linii Pythona z reputacją zasobożernego.
  Zbudowanie Matrix client to znowu ~6 miesięcy. **Nie redukuje pracy
  klienta w ogóle.** Federation której nie potrzebujemy.

### B. Signal Protocol (libsignal-protocol-rust) zamiast MLS
- Plus: dojrzała impl, używana przez Signal, WhatsApp, Wire.
- Minus: Sender Keys do grup są oddzielnym protokołem od Double Ratchet.
  Jeden więcej protokół do zrozumienia, zaimplementowania, debugować.

### C. Backend w Bun + Hono zamiast Rust + Axum
- Plus: szybciej napiszemy, ekosystem JS/TS ma więcej narzędzi do
  WS i auth.
- Minus: dwie różne reprezentacje DTO (TS server, Rust client), gorsza
  integracja z openmls (które jest tylko w Rust).

### D. BaaS (Supabase, Convex, Pocketbase)
- Plus: dni do wystartowania, presence i WS gotowe.
- Minus: vendor lock-in. Nasz model zaufania (E2E, server widzi tylko
  ciphertext) wymaga, żebyśmy mieli pełną kontrolę nad tym, co serwer
  robi z bytami. BaaS-y tego nie gwarantują.

### E. P2P (libp2p, gun.js, automerge)
- Plus: zero serwera, „cypherpunk".
- Minus: dostarczanie offline jest właściwie nierozwiązane bez
  „supernodes". NAT traversal. Brak globalnej spójności historii.
  **Nie spełnia wymagania #2.**

## Otwarte pytania (do rozstrzygnięcia w kolejnych ADR)

- **0002**: Wybór hostingu serwera (Fly.io vs VPS vs domowy serwer).
- **0003**: Schema device-linking flow (QR vs deep link vs SMS).
- **0004**: Polityka rotacji KeyPackage (TTL, max usage count).
- **0005**: Strategia backupu wiadomości (encrypted backup do GCS / S3 vs
  „tylko lokalne, jak stracisz to fuckup").
- **0006**: Push notifications: FCM/APNs vs własny WebSocket-keepalive.
- **0007**: Polityka GDPR / „prawo do usunięcia konta" (jak współgra z
  message_blobs, do których ten user był adresatem).

## Ślady w kodzie

Po implementacji niniejszy ADR powinien być linkowany z:

- `server/README.md` (gdy powstanie)
- `src-tauri/src/network.rs` (gdy powstanie)
- `src/lib/network.ts` (gdy powstanie)
- `docs/PRIVACY.md` (gdy powstanie, sekcja „co serwer wie")

## Zatwierdzenie

Stakeholder zatwierdził kierunek 2026-05-09 na rozmowie z
Claude. Phase 1 startuje po opublikowaniu tego ADR.
