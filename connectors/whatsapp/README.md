# Dad's Typing WhatsApp connector

Independent Go service (own `go.mod`) that transports WhatsApp messages for the
Dad's Typing app using whatsmeow. The TS app decides everything; this service
only receives, forwards, sends queued replies and reports health. Protocol:
`docs/CHANNEL_CONTRACT.md` in the repo root. Design notes: `NOTES.md`.

## Run

    make check          # gofmt, vet, build, go test -race
    make build && ./bin/connector
    make docker         # image dt-whatsapp-connector, volume /data, non-root

## Environment

| Name | Meaning |
|---|---|
| `TS_BASE_URL` | App origin, no path. https required unless the host is loopback |
| `ALLOW_INSECURE_TS_URL` | `1` allows plain http to a non-loopback host (private docker network only); logs a warning |
| `ALLOWED_SENDERS` | Optional comma list of digits. Others are dropped before any download or write; the app stays the authority |
| `WHATSAPP_BRIDGE_SECRET` | Shared HMAC secret, >= 32 chars, same as the app |
| `DATA_DIR` | Persistent dir (0700); holds `session.db` and `connector.db` |
| `ADMIN_TOKEN` | Bearer token for the admin API, >= 32 chars, must differ from the bridge secret |
| `ADMIN_ADDR` | Loopback listen address, default `127.0.0.1:8091` |
| `WHATSMEOW_LOG_LEVEL` | Optional (`ERROR`); off by default as it can print ids |

Startup fails fast on bad config. Secrets, bodies, phones and signatures are
never logged. The admin API only accepts loopback peers and `localhost`,
`127.0.0.1` or `[::1]` Host headers with the configured port. In Docker it is
loopback inside the container and the image has no curl; the built-in probe
is `docker exec <c> connector healthz` (exit 0 only when connected, paired and
not halted). The image HEALTHCHECK uses it; expect "unhealthy" until paired.
A bind-mounted `/data` must be owned by uid 10001 (`chown 10001 data`, 0700).
For other admin calls run a one-off client in the same network namespace, e.g.
`docker run --rm --network container:<c> <curl-image> ...`.

## Pair a dedicated test number

1. Start the connector with an empty `DATA_DIR`.
2. `POST /pair {"phone":"2547XXXXXXXX"}` (digits, no `+`) returns an 8 char
   code; on the phone: Settings > Linked devices > Link a device > Link with
   phone number, enter the code. Or `POST /pair/qr` to start QR pairing, then
   `GET /pair/qr` (read-only, poll it) prints the current terminal QR.
3. `GET /status` shows `connected` and `paired` true; the app receives a
   signed health post.

Admin routes (all need the bearer): `GET /healthz` (200 only when connected,
paired and not halted), `GET /status` (includes `failedInbox`), `POST /pair`,
`POST /pair/qr`, `GET /pair/qr`, `POST /logout`.

In a container without curl, call them with the binary itself:
`connector admin GET /status`, `connector admin POST /pair '{"phone":"2547XXXXXXXX"}'`.

## Restart and persistence

The session lives in `DATA_DIR/session.db` and is reused on restart; no
re-pairing. Inbound messages are written to `inbox` before forwarding and
resume after a crash. Outages never drop a message: network, 5xx, 401, 403
and 404 retry forever with backoff capped at 1h. Only 400, 413 and 422 mark a
row `failed`; it keeps its payload, retries every 6h and is counted in
`/status.failedInbox` (health also sends `degraded: true`) until it forwards
or its 7 day TTL passes. The connector replies only to numbers that have
messaged it (`known_senders`); anything else is acked `failed`
`unknown_recipient`. Retention runs hourly: forwarded rows 72h, acked ledger
rows 7d, idle known senders 30d. The send ledger (`sent_ledger`) guarantees a
reply is never sent twice: a crash after sending acks `sent` without a resend,
a crash mid-send is acked `unknown` and never resent. SIGTERM finishes an
in-flight send, flushes and closes both databases.

## If the linked device is revoked

`/status` reports `loggedOut: true` with an instruction and the app gets
`loggedOut: true`. Sends stop. Run `POST /pair` or `GET /pair/qr` again (a
fresh device is created automatically). Stream replaced means another client
took the session: stop it and restart. A temporary ban pauses sends until it
expires; do not re-pair.

## Unverified

No real WhatsApp access was available. Pairing, reconnect, event shapes,
LID resolution, media download and sending are only covered by the fake
transport. Do the first run with a throwaway number. See `NOTES.md`.
