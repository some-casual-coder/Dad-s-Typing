# Dad's Typing WhatsApp connector

Independent Go service (own `go.mod`) that transports WhatsApp messages for the
Dad's Typing app using whatsmeow. The TS app decides everything; this service
only receives, forwards, sends queued replies and reports health. Protocol:
`docs/WHATSAPP_CONTRACT.md` in the repo root. Design notes: `NOTES.md`.

## Run

    make check          # gofmt, vet, build, go test -race
    make build && ./bin/connector
    make docker         # image dt-whatsapp-connector, volume /data, non-root

## Environment

| Name | Meaning |
|---|---|
| `TS_BASE_URL` | App origin, no path (e.g. `https://app.example.com`) |
| `WHATSAPP_BRIDGE_SECRET` | Shared HMAC secret, >= 32 chars, same as the app |
| `DATA_DIR` | Persistent dir (0700); holds `session.db` and `connector.db` |
| `ADMIN_TOKEN` | Bearer token for the admin API, >= 32 chars |
| `ADMIN_ADDR` | Loopback listen address, default `127.0.0.1:8091` |
| `WHATSMEOW_LOG_LEVEL` | Optional (`ERROR`); off by default as it can print ids |

Startup fails fast on bad config. Secrets, bodies, phones and signatures are
never logged. In Docker the admin API is loopback inside the container; use
`docker exec <c> curl -H "Authorization: Bearer $ADMIN_TOKEN" 127.0.0.1:8091/status`.

## Pair a dedicated test number

1. Start the connector with an empty `DATA_DIR`.
2. `POST /pair {"phone":"2547XXXXXXXX"}` (digits, no `+`) returns an 8 char
   code; on the phone: Settings > Linked devices > Link a device > Link with
   phone number, enter the code. Or `GET /pair/qr` prints a terminal QR to
   scan from Linked devices.
3. `GET /status` shows `connected` and `paired` true; the app receives a
   signed health post.

Admin routes (all need the bearer): `GET /healthz` (200 only when connected,
paired and not halted), `GET /status`, `POST /pair`, `GET /pair/qr`,
`POST /logout`.

## Restart and persistence

The session lives in `DATA_DIR/session.db` and is reused on restart; no
re-pairing. Inbound messages are written to `inbox` before forwarding and
resume after a crash (bounded retries with backoff, `failed` state after the
cap or on a permanent 4xx). The send ledger (`sent_ledger`) guarantees a
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
