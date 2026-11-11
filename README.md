# Dad's Typing...

A shared buying task for families. Someone describes what they need, the assistant asks
what matters, checks exact options, and the person it is for chooses. A designated payer
then approves the exact item and total in PayPal (Sandbox), and everyone sees a receipt
tied to the same task.

**Status:** a working browser journey against PayPal Sandbox. Not a production service.

## What is real and what is not

| Part | State |
|---|---|
| Checkout | Real PayPal **Sandbox** order, approved by a sandbox buyer and captured by the server. No real money moves. |
| AI | Real model calls (Gemini through Google or OpenRouter) that propose requirements. The person confirms them; the model cannot choose, pay or change roles. |
| Offers | A clearly labelled **demo seller** ("Whisker & Co (demo)") is the only payable seller. Channel3 results (US/GB) appear as external "View at retailer" links and are never payable here. |
| Chat | A browser simulation. It is **not** WhatsApp. WhatsApp is a separate later adapter. |
| Not built yet | Voice, webhooks (needs a public HTTPS URL), refunds, WhatsApp. |

## Run it locally

Prerequisites: Node 22+, npm, Docker (for Postgres).

```bash
npm install
cp .env.example .env.local        # then fill in the values below
docker run -d --name dads-typing-pg -p 127.0.0.1:5433:5432 \
  -e POSTGRES_USER=dt -e POSTGRES_PASSWORD=<choose> -e POSTGRES_DB=dads_typing \
  postgres:16-alpine
# set DATABASE_URL=postgres://dt:<choose>@127.0.0.1:5433/dads_typing
npm run db:migrate
npm run build && npm start        # http://localhost:3000
```

Environment variables (names only; see `.env.example`):

- `PAYPAL_ENV=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID`
  (the Business sandbox account's merchant id), optional `PAYPAL_WEBHOOK_ID`.
- One AI provider: `GEMINI_API_KEY` + `GEMINI_MODEL`, or `INTERPRETER_PROVIDER=openrouter`
  with `OPENROUTER_API_KEY` + `OPENROUTER_MODEL`.
- `CHANNEL3_API_KEY` (optional; without it only demo offers appear).
- `APP_BASE_URL` (PayPal returns here), `DATABASE_URL`, `TRUST_PROXY=1` only behind a trusted proxy.

The server refuses to start PayPal unless `PAYPAL_ENV=sandbox`.

## Try the journey

1. Open `/`, enter a request, and choose **Start for Mum** (you help and pay).
2. **Send to Mum** makes a private link. Open it in a different browser profile.
3. As Mum, say something like "it must open from the top and be at least 45 cm long".
   Confirm the proposed requirements; the shortlist changes.
4. Mum chooses an option. You (the payer) review the exact item and total, then
   **Pay with PayPal (sandbox)** and sign in with a PayPal **Personal sandbox** buyer
   (create one under Testing Tools > Sandbox Accounts in the PayPal developer dashboard).
5. The server captures and verifies the payment; both views show the receipt.

Cancelling at PayPal leaves no receipt and the payment can be retried.

## Connectors (any channel)

The engine does not know about WhatsApp, SMS or any other channel. A connector is a small
transport that posts inbound messages to the engine and sends the replies the engine queues,
over a signed HTTP bridge (`/api/channel/{channel}/...`).

To add a channel:

1. Add one entry to `src/channel/registry.ts` (sender id format, reply length, images or not).
2. Set `CHANNEL_<ID>_SECRET` (32+ characters) and `CHANNEL_<ID>_ALLOWED` (sender ids that may
   use it; empty means nobody) in the environment. Each channel has its own secret.
3. Write the connector: sign each request with `HMAC-SHA256(secret, ts \n METHOD \n path \n body)`
   (headers `X-DT-Timestamp`, `X-DT-Signature`), `POST .../inbound`, then `POST .../outbox/claim`
   and `POST .../outbox/{id}/ack`. An ack of `unknown` means "may have been delivered" and is never resent.

Try any channel without a real connector:

```bash
node --env-file=.env.local scripts/channel-sim.mjs sms 254700000009 "a cat carrier for Mum"
```

`connectors/whatsapp` is a WhatsApp connector (Go, Whatsmeow, an unofficial client; see its README
for the risks and for pairing). The browser chat is the built-in connector. The browser path keeps
working when any connector is down.

## Checks

```bash
npm run typecheck   # next typegen + tsc
npm run lint
npm test            # deterministic tests against a separate *_test database
npm run live:providers   # real calls: AI, Channel3, PayPal create-order (no capture)
```

Deterministic tests use mocks and a local database; they are separate from the live
provider checks and from a real Sandbox checkout.

## Design notes

- Money is integer minor units; the server computes totals and freezes the approved offer.
- An order is marked paid only from a COMPLETED capture whose order, merchant, amount and
  currency match the frozen order. Redirects and approvals alone prove nothing.
- Access is a scoped, expiring, revocable grant checked on every request. Links carry the
  grant in the URL fragment, which browsers do not send to the server.
- A scheduled reconciler resolves payments whose capture response was lost.

## Licence

Apache-2.0. See `LICENSE`.
