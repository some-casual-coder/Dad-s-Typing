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
| AI | Real model calls (OpenRouter by default, Gemini through Google also supported) that read text and photos and propose requirements. The person confirms them; the model cannot choose, pay or change roles. |
| Offers | A clearly labelled **demo seller** ("Whisker & Co (demo)") is the only payable seller. Channel3 results (US/GB) appear as external "View at retailer" links and are never payable here. |
| Chat | A browser simulation. It is **not** WhatsApp. Text, photo upload and push-to-talk voice all feed the same engine. |
| Connectors | The engine is channel-agnostic. A WhatsApp connector (Go, Whatsmeow, an unofficial client) is in `connectors/whatsapp`; it has been tested against the app with a fake transport only, not against real WhatsApp. SMS and others plug in the same way. |
| Refunds | Operator-only, sandbox. There is no public refund control and no merchant UI: a signed local command (`scripts/operator-refund.mjs`, needs `OPERATOR_SECRET`) issues them. Buyers see refunded and pending amounts on the receipt, separate from the payment. |
| Webhook | `POST /api/webhooks/paypal` is off unless `PAYPAL_WEBHOOK_ID` is set and a reachable HTTPS URL is registered on the sandbox app. Without it the app reconciles payments and refunds by polling PayPal. |
| Not verified | A real phone gallery/camera pick, a real microphone on a phone, Kenyan-accented or Kiswahili speech, a delivered PayPal webhook, and real WhatsApp. |

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

## Try the journey (judge path)

1. Open `/`. Choose **Upload photo** and pick a photo of a cat carrier. No photo handy? Use
   **Download a sample photo** on the same screen (a synthetic drawing). Optionally add a note such
   as "For Mum. It must open from the top and be at least 45 cm long", then **Start with this photo**.
   You can also type a request and choose **Start for Mum**, or speak it with **Speak**.
2. The assistant reads the photo and note and proposes requirements, each with the words it relied on.
   Nothing is applied until a person confirms it.
3. Choose **Send to Mum** and open the link in a **different browser profile** (a private window shares
   no sign-in). As Mum, confirm the requirements: the shortlist changes, mismatches move to
   "Doesn't match", and unverified external offers stay marked **Unverified**.
4. Mum chooses an option. As the payer, review the exact item, seller and total, then
   **Pay with PayPal (sandbox)** and sign in with a PayPal **Personal sandbox** buyer
   (create one under Testing Tools > Sandbox Accounts in the PayPal developer dashboard).
5. The server captures and verifies the payment; both views show the same receipt.

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

## Voice

Push-to-talk on the chat: press Speak, talk for up to 20 seconds, Stop or Cancel, then check and edit the transcript before using it. Nothing is sent automatically and a transcript never authorises payment or any other action; you still press Send.

- Audio goes to the server route `POST /api/tasks/:id/transcribe` (message permission, rate limited, max 2.5 MB; webm, ogg or mp4 only) and on to the speech-to-text model set by `STT_MODEL` via OpenRouter. The server does not keep the audio.
- Needs HTTPS or localhost for microphone access and a browser with MediaRecorder. If voice is unavailable the text box works as before.
- Read aloud uses the browser speech synthesis where present; the full text always stays on screen.
- Checked so far: Chrome (desktop) recording and transcription with a synthetic audio source. Safari/iOS, Firefox and real microphone speech are not yet tested.

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
