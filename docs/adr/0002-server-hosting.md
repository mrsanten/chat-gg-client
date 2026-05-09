# ADR-0002: Hosting serwera

- **Status:** Accepted
- **Data:** 2026-05-09
- **Autor:** stakeholder
- **Powiązany ADR:** [0001](0001-network-chat-architecture.md)

## Kontekst

ADR-0001 ustalił, że stawiamy własny serwer (Rust + Axum + Postgres). Zostaje
decyzja: gdzie ten serwer fizycznie żyje.

## Decyzja

**Własny VPS** zarządzany przez stakeholdera.

Konkretne decyzje wykonawcze (provider, region, rozmiar) zostają poza
ADR-em — to jest decyzja operacyjna stakeholdera, nie architektoniczna.
Zakładamy minimum:

- Linux (Debian/Ubuntu LTS).
- Publiczne IPv4 + AAAA, port 443 otwarty na świat.
- Co najmniej 1 vCPU + 1 GB RAM + 20 GB SSD do MVP.
- Możliwość zainstalowania Dockera (production deploy via docker-compose
  lub systemd unit).

## Konsekwencje

### Pozytywne

- Pełna kontrola nad konfiguracją (firewall, fail2ban, własne TLS przez
  Caddy/Let's Encrypt, własne backupy).
- Brak vendor lock-in; przeniesienie na inny VPS = `rsync` bazy + reset
  DNS.
- Jeden bill, przewidywalne koszty (~5–10 EUR/mc).

### Negatywne

- Stakeholder odpowiada za uptime, security patche, backup, rotację TLS.
- Bez SLA, bez „pewnej" uptime'u; awaria = projekt offline.
- Skalowanie pionowe na początku (większy VPS); horyzontalne wymaga
  Redisa + load balancera, ale to zostaje na później.

### Mitigation operacyjny (do zrobienia osobno przed produkcją)

- `unattended-upgrades` na security packages.
- `ufw` lub `nftables` z whitelistą tylko na 22/80/443.
- Automatyczne backupy Postgresa do S3/B2 (raz dziennie, 7-dniowa retencja).
- Healthcheck endpoint `/healthz` w serwerze + zewnętrzny monitor (Uptime
  Kuma na drugim VPS-ie albo BetterUptime free tier).

## Layout produkcyjny

```
VPS (Linux, public IP)
├── Caddy / nginx          — TLS termination, automatyczny ACME
│     └── proxy_pass do app:8080  (HTTP) / app:8080  (WSS upgrade)
├── docker-compose
│     ├── app  (gaidu-server, port 8080 wewnątrz Dockera)
│     └── postgres  (volume mounted na /var/lib/postgresql)
└── /backups               — cron z pg_dump → encrypted upload
```

Caddy wybrany domyślnie, bo automatyczny Let's Encrypt out-of-box. Można
zastąpić nginxem/Traefikiem bez zmian w aplikacji.

## Co odrzucamy

- **Fly.io / Railway / Render** — wygodne, ale dodają abstrakcję nad
  hostingiem i koszt skali rośnie szybko. Stakeholder preferuje pełną
  kontrolę.
- **Hosting na maszynie domowej** za NAT-em — wymaga IPv6/Cloudflare
  Tunnel/Tailscale; działa, ale uptime zależy od domowego internetu i
  prądu.
- **Kubernetes** — overkill na MVP, dwustopniowa krzywa learning (k8s +
  app).
