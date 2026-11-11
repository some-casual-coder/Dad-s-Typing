# Tags are pinned to versions, not digests: no local image cache to resolve
# digests from. Pin digests in CI (docker buildx imagetools inspect).
FROM golang:1.25.13-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" \
    -o /out/connector ./cmd/connector

FROM debian:12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data connector \
    && mkdir /data && chown 10001 /data && chmod 700 /data
COPY --from=build /out/connector /usr/local/bin/connector
USER 10001
ENV DATA_DIR=/data ADMIN_ADDR=127.0.0.1:8091
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=6s --start-period=60s --retries=3 \
    CMD ["/usr/local/bin/connector", "healthz"]
ENTRYPOINT ["/usr/local/bin/connector"]
