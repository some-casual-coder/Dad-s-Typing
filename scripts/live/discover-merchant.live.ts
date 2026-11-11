import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { discoverMerchantId, paypalFromEnv } from "@/adapters/paypal";

// Creates a $1 sandbox order, reads the payee, never approves or captures
it("discovers the sandbox merchant id", async () => {
  const p = paypalFromEnv();
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const { paypalOrderId } = await p.createOrder({
    requestId: randomUUID(), referenceId: "merchant-discovery", currency: "USD", totalMinor: 100, itemMinor: 100,
    shippingMinor: 0, description: "Merchant discovery", returnUrl: `${base}/return`, cancelUrl: `${base}/cancel`,
  });
  const id = await discoverMerchantId(p, paypalOrderId);
  if (!id || !/^[A-Z0-9]{8,20}$/.test(id)) throw new Error("no merchant id found");
  const file = ".env.local";
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const next = lines.filter((l) => !l.startsWith("PAYPAL_MERCHANT_ID="));
  while (next.length && next.at(-1) === "") next.pop();
  next.push(`PAYPAL_MERCHANT_ID=${id}`, "");
  writeFileSync(file, next.join("\n"), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`merchant id: ${id}`);
});
