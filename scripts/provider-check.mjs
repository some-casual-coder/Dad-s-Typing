// Prints statuses and non-sensitive fields only
const e = process.env;
const out = (k, v) => console.log(`${k}: ${v}`);

async function paypal() {
  if (e.PAYPAL_ENV !== "sandbox") return out("paypal", "REFUSED (PAYPAL_ENV must be sandbox)");
  const base = "https://api-m.sandbox.paypal.com";
  const auth = Buffer.from(`${e.PAYPAL_CLIENT_ID}:${e.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const t = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const tj = await t.json().catch(() => ({}));
  out("paypal.auth", `${t.status}${t.ok ? ` (expires_in=${tj.expires_in}s)` : ` ${tj.error ?? ""}`}`);
  if (!t.ok) return;
  const o = await fetch(`${base}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tj.access_token}`, "Content-Type": "application/json", "PayPal-Request-Id": `check-${Date.now()}` },
    body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ reference_id: "check", amount: { currency_code: "USD", value: "1.00" } }] }),
  });
  const oj = await o.json().catch(() => ({}));
  out("paypal.create_order", `${o.status} status=${oj.status ?? oj.name ?? "?"}`);
}

async function gemini() {
  const model = e.GEMINI_MODEL || "gemini-3.8-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": e.GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'Mum sent a cat carrier screenshot and says "it must open from the top". Return the requirement.' }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { attribute: { type: "STRING" }, essential: { type: "BOOLEAN" } }, required: ["attribute", "essential"] } },
    }),
  });
  const j = await r.json().catch(() => ({}));
  const txt = j.candidates?.[0]?.content?.parts?.[0]?.text;
  out("gemini", `${r.status} model=${model} ${r.ok ? `parsed=${txt}` : (j.error?.status ?? "")}`);
}

async function channel3() {
  for (const country of ["US", "GB", "KE"]) {
    const r = await fetch("https://api.trychannel3.com/v1/search", {
      method: "POST",
      headers: { "x-api-key": e.CHANNEL3_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "top-opening cat carrier", limit: 5, config: { country } }),
    });
    const j = await r.json().catch(() => ({}));
    const items = j.products ?? [];
    out(`channel3.${country}`, `${r.status} products=${items.length}${r.ok ? "" : ` ${JSON.stringify(j.detail ?? j.error ?? "").slice(0, 120)}`}`);
    if (country !== "US") continue;
    for (const p of items.slice(0, 3)) {
      const o = p.offers?.[0];
      out("  -", `${String(p.title).slice(0, 55)} | offers=${p.offers?.length ?? 0} | ${o ? `${o.domain} ${o.price?.price} ${o.price?.currency} ${o.availability}` : "no offer"} | variants=${p.variants ? p.variants.options.length : 0}`);
    }
  }
}

for (const [n, f] of [["paypal", paypal], ["gemini", gemini], ["channel3", channel3]]) {
  try { await f(); } catch (err) { out(n, `ERROR ${err.name}`); }
}
