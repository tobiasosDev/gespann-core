# gespann-orchestrator. Build from the repo root: docker build -f orchestrator/Dockerfile .
FROM rust:1-slim-bookworm AS build
WORKDIR /src/orchestrator
# Dependencies first, against a dummy crate, so a source change does not rebuild them.
COPY orchestrator/Cargo.toml orchestrator/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs \
  && cargo build --release --locked \
  && rm -rf src
COPY orchestrator/src ./src
# COPY keeps the files' old times; touch them so cargo rebuilds the crate itself.
RUN touch src/main.rs src/lib.rs && cargo build --release --locked

FROM debian:bookworm-slim
# Clients for the docker and ssh sandbox providers (SANDBOX_PROVIDER).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
# uid and gid 1000 like the UI image's node user: both write the same /data volume.
RUN groupadd --gid 1000 gespann && useradd --uid 1000 --gid 1000 --create-home gespann \
  && mkdir -p /data && chown gespann:gespann /data
COPY --from=build /src/orchestrator/target/release/gespann-orchestrator /usr/local/bin/gespann-orchestrator
ENV DATA_DIR=/data NODE_ENV=production HEALTH_PORT=3001
USER gespann
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${HEALTH_PORT:-3001} && printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q '200 OK' <&3"]
CMD ["gespann-orchestrator"]
