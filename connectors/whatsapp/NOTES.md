# Connector notes: comparison, research, decisions

Scope: WhatsApp connector built on whatsmeow (pin
`v0.0.0-20260730092514-662ad1dc6900`, same as the Bunema reference). Nothing
here was exercised against real WhatsApp.

## Comparison with the reference sidecar (read-only)

| Area | Reference | Here | Decision |
|---|---|---|---|
| Session store | whatsmeow sqlstore, own file | same (`session.db`), WAL, busy_timeout | same |
| Pairing | QR + `PairPhone` (Chrome client type) | same flow; fresh device after logout | adopted |
| LoggedOut / ban / stream replaced | stop sends, ban is timed | same, plus ban expiry timer event | adopted |
| Client outdated | not handled | halts sends, status says upgrade | added |
| KeepAliveTimeout | manual reconnect goroutine | rely on whatsmeow auto-reconnect | rejected* |
| Send ledger | dispatching/accepted/unknown | dispatching/sent/unknown/failed + acked flag | adapted |
| Stale dispatching at boot | `ExpireStaleDispatching` | `ExpireDispatching` at start | adopted |
| Pacing | spacing, daily cap, warm-up, window | min delay + jitter, per-recipient hourly cap | reduced** |
| Callback durability | durable callback outbox | ledger `acked` flag + lease redelivery | adapted |
| Signing | method, path, ts, nonce, body hash | contract format (ts, method, path, body) | contract |
| Config | many env vars | five env vars, fail fast | contract |
| Shutdown | signal ctx, serve until done | signal ctx, WaitGroup, in-flight send finishes | adopted |
| Health | `/readyz` | signed health POST every 30s + on change, `/healthz` | contract |

\* whatsmeow's keepalive loop forces a reconnect once pings have failed for
`KeepAliveMaxFailTime` (3 min) when `EnableAutoReconnect` is on; we set it
explicitly. Bunema's manual reconnect races Disconnect/Connect, so skipped.
\** Warm-up and business-hours windows suit bulk invoicing; this bot only
replies in 1:1 chats the user started. A global daily cap was not added.

## Research and what was folded in

Sources: whatsmeow godoc (https://pkg.go.dev/go.mau.fi/whatsmeow), the pinned
module source in the Go module cache (authoritative for behaviour below), and
LID write-ups (https://green-api.com/en/docs/faq/lid-important-differences/,
https://whapi.cloud/blog/how-to-resolve-whatsapp-lid-to-phone-number,
https://github.com/WhiskeySockets/Baileys/discussions/2551). Web results were
secondary and mostly about other libraries; claims were checked in source.

Adopted:
- Reconnect: `EnableAutoReconnect = true`; initial connect retried with capped
  exponential backoff and jitter (1s to 60s); stops once halted.
- Duplicate delivery on reconnect/offline sync: dedupe on the unique provider
  id (checked before the image download); the app dedupes again.
- Offline/history flood: messages older than 48h are dropped (`stale`);
  history sync payloads are never stored. Newer backlog is forwarded.
- Media: sender-declared length is capped at 4 MB before download, the real
  bytes are re-checked and mime is taken from magic bytes. Each attempt has a
  60s timeout. Ingestion is sequential, so at most one image is in memory.
  `Download` buffers (no streaming API fits base64 JSON), hence the caps.
- Handler backpressure: the whatsmeow handler only maps and enqueues; the
  download and DB work run in our goroutine. Emits unblock on shutdown.
- Retry receipts / decryption failures: whatsmeow requests retries itself; we
  log `UndecryptableMessage` (no content) and never synthesise a message.
- SQLite: WAL, busy_timeout 5s, single connection per file, dir 0700, files
  0600, clean close on SIGTERM so WAL is checkpointed.
- Goroutines: every loop selects on the root context; channel sends select on
  a `done` channel; shutdown waits on a WaitGroup before closing stores.
- LID vs phone JIDs: sender digits come from `Sender` when it is a phone JID,
  else `SenderAlt`, else the whatsmeow LID-to-PN store; if none resolves the
  message is dropped (`no_sender`) because the app needs phone digits. Replies
  go to `digits@s.whatsapp.net`; whatsmeow looks up or fetches the LID itself
  when sending (`send.go`, LID/PN mapping), so no manual LID handling.
- Ban avoidance for low volume: min 3s plus jitter between sends, 20 sends per
  recipient per hour, never reply when disconnected, no bulk or unsolicited
  sends (the app only queues replies).
- Version hygiene: whatsmeow is pinned by pseudo-version; `ClientOutdated`
  halts sends and the status instruction says to upgrade and rebuild. Upgrade
  by bumping the pin, `go mod tidy`, rerunning tests and re-testing pairing.

Rejected:
- Presence/typing indicators and read receipts: extra traffic and ban surface
  for no contract requirement; can be added later via `SendChatPresence`.
- Message ordering guarantees: the forwarder orders by due time, so a retried
  message can arrive after a newer one. `receivedAt` carries the true order.
- Persisting history sync or media to disk: not needed, adds retention risk.
- Redirect following on TS calls: disabled so signed requests are never
  replayed to another host.

## Known gaps and unverified against real WhatsApp

Everything touching WhatsApp: pairing (code and QR), reconnect after network
loss, LoggedOut/stream replaced/ban event shapes, LID sender resolution,
sending to a PN JID that maps to a LID, image download of real media, offline
sync volume, retry receipts, and whether `Info.Edit` marks every edit. The
fake transport covers the pipelines only. Reactions inside LID chats, view-once
images and ephemeral wrappers rely on whatsmeow's unwrap and are untested.

Security scan: `govulncheck` on the local Go 1.25.4 reports standard-library
findings fixed in later 1.25.x/1.26.x patch releases and x/net findings (v0.57
in the pinned family; fixed in v0.60, which needs go 1.26) that the tool
reports as not called. The Dockerfile builds on the current golang 1.25 image;
bump the pin and Go version together when moving to 1.26.

## Contract notes for the TS side

- Sign the exact raw body bytes and the request path as sent; the connector
  signs `/api/channel/whatsapp/outbox/<uuid>/ack` literally, uuid required.
- Replies to a recipient beyond 20/hour are acked `failed` with
  `error: "recipient_cap"`; other failure codes: `rejected`, `invalid_item`.
- Ambiguous sends ack `unknown` with `error: "send_error"` or `"interrupted"`.
- Claims use limit 2 and lease 300s; undelivered items rely on lease expiry.
- Paths use `/api/channel/{channel}/...` with `config.Channel` = `whatsapp`.
- Health `loggedOut` is true for logged out, stream replaced, ban and
  client outdated; `connected` is the live socket state.

## Review fixes (second pass)

1. TS URL and recipients: https is required unless the host is loopback;
   `ALLOW_INSECURE_TS_URL=1` opts into plain http and logs a warning. The
   outbox only sends to numbers in `known_senders` (filled when an inbound
   row is stored, removed if the app answers `ignored`); others are acked
   `failed` / `unknown_recipient`, so a forged claim cannot message arbitrary
   numbers.
2. Settling after a send uses a context detached from shutdown with its own
   timeout. If the ledger write fails after a send, `unknown` is acked, never
   `sent`.
3. Pairing guard moved to `pair.go` with a generation counter: every failure
   path cancels, releases the guard and drains the QR channel.
4. Inbound is never dropped for an outage: only 400/413/422 are permanent;
   those rows keep their payload, retry every 6h, show in `/status`
   `failedInbox` and as `degraded` in the health post (the app ignores unknown
   fields today). Acks: a failed ack (404 included) keeps the ledger row and
   retries with backoff up to 1h, even if the app stops redelivering the item.
5. `ALLOWED_SENDERS` pre-filter runs before download or any write.
6. Hourly purge: forwarded rows 72h (covers the 48h stale cutoff; payload is
   already wiped at forward), failed rows 7d, acked ledger rows 7d, idle known
   senders 30d. Unacked ledger rows are never purged.
7. Media: declared size 0 or over 4 MB rejected; the download writes into a
   capped in-memory file so the cap holds while reading (whatsmeow's
   `Download` is an unbounded `ReadAll`); then magic bytes plus
   `image.DecodeConfig` (<= 12000 per side, <= 40 MP). WebP via x/image v0.24.
8. Dedupe key is `(sender, provider_id)`; the schema was changed in place
   because nothing is deployed (a pre-existing dev DB must be deleted).
9. Container: `.dockerignore`, `connector healthz` plus HEALTHCHECK, no curl,
   uid 10001. Base images are pinned by version tag, not digest (digests
   cannot be resolved offline); pin digests in CI.
10. Lease: limit 2, lease 300s; before each send the worker checks that
    pace wait plus send timeout still fits the remaining lease.
11. Admin: loopback RemoteAddr and Host checks, timeouts, `POST /pair/qr`
    starts QR pairing, `GET /pair/qr` is read-only, token must differ from
    the bridge secret.
12. Channel id is `config.Channel`, passed to the TS client.

Deviations: forwarded rows are purged at 72h rather than 7d because they hold
the sender number and only the 48h stale window needs the dedupe key.
