# Multi-stage build dla produkcji.
# Build na bookworm-slim (glibc), runtime też glibc dla zgodności z openssl/sqlx.

FROM rust:1-bookworm AS builder
WORKDIR /app

# Cache deps: skopiuj manifest, builduj pusty src, potem dorzuc reszte.
# Po COPY . . MUSIMY usunąć dummy binarkę i `touch` na main.rs, inaczej
# cargo zobaczy świeży binary i nie zrobi rebuildu — finalny obraz dostanie
# pustą binarkę (`fn main() {}`).
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs && \
    cargo build --release && \
    rm -rf src target/release/gaidu-server target/release/deps/gaidu_server*

COPY . .
RUN touch src/main.rs && cargo build --release && \
    test -s target/release/gaidu-server && \
    file target/release/gaidu-server

# ──────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/gaidu-server /usr/local/bin/gaidu-server
COPY migrations ./migrations

ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080

# Healthcheck: root /healthz musi zwrócić 200.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:8080/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/gaidu-server"]
