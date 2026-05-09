#!/usr/bin/env bash
# Skrypt do uruchamiania na VPS-ie. Pobiera świeży kod, buduje obraz,
# wymienia kontener bez zerwanego healthchecku.
#
# Wywołanie:
#   ./scripts/deploy.sh             # default: deploy aktualnego main
#   ./scripts/deploy.sh v0.7.0      # deploy konkretnego taga
#
# Wymaga:
#  - katalog z `.env` (skopiowane z .env.example, JWT_SECRET ustawione,
#    POSTGRES_PASSWORD ustawione)
#  - Docker + Docker Compose plugin
#  - git zainstalowane
#
# Idempotentne: można odpalać wielokrotnie.

set -euo pipefail

REF="${1:-main}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

cd "$HERE"

if [[ ! -f .env ]]; then
    echo "ERR: brak $HERE/.env. Skopiuj z .env.example, ustaw JWT_SECRET i POSTGRES_PASSWORD." >&2
    exit 1
fi

# Pre-flight: sprawdź sekrety
missing=()
for var in JWT_SECRET POSTGRES_PASSWORD; do
    if ! grep -q "^${var}=.\+" .env || grep -q "^${var}=development-only-secret-change-me-before-production" .env; then
        missing+=("$var")
    fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERR: w .env brak lub default w: ${missing[*]}" >&2
    echo "  JWT_SECRET=\$(openssl rand -hex 64)" >&2
    echo "  POSTGRES_PASSWORD=\$(openssl rand -hex 16)" >&2
    exit 1
fi

echo "==> git fetch + checkout $REF"
git fetch --all --tags --prune
git checkout "$REF"
git pull --ff-only origin "$REF" 2>/dev/null || true

echo "==> docker compose build app"
docker compose -f docker-compose.yml -f docker-compose.prod.yml build app

echo "==> docker compose up -d (z prod overlay)"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --remove-orphans

echo "==> czekam aż healthz zwróci 200..."
for i in {1..30}; do
    if curl -fs -o /dev/null http://127.0.0.1:8080/healthz; then
        echo "==> healthz OK po $((i*2))s"
        break
    fi
    sleep 2
    if [[ $i -eq 30 ]]; then
        echo "ERR: healthz nie odpowiedział w 60s. Logi:" >&2
        docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=50 app >&2
        exit 1
    fi
done

echo "==> deploy $REF: OK"
