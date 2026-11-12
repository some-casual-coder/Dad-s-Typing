import { FX_SOURCE } from "@/delivery/fx";
import { failFor, jsonOf, send } from "./http";
import { AdapterError, type FxSource } from "./types";

const BASE = "https://api.frankfurter.dev/v2/rates";

export class FrankfurterCbk implements FxSource {
  async kesRate(currency: "USD" | "GBP") {
    const r = await send(`${BASE}?base=${currency}&quotes=KES&providers=CBK`, { headers: { accept: "application/json" } }, 4_000);
    if (!r.ok) throw failFor(r.status, "FX");
    const j = await jsonOf(r, "FX");
    const row = Array.isArray(j) ? j[0] : null;
    const rate = row?.rate, date = row?.date;
    if (row?.base !== currency || row?.quote !== "KES" || typeof rate !== "number" || !(rate > 1 && rate < 10_000)
      || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AdapterError("unavailable", "FX returned an unexpected shape");
    return { rate, date, source: FX_SOURCE };
  }
}

class Offline implements FxSource {
  async kesRate(): Promise<never> {
    throw new AdapterError("unavailable", "FX is offline");
  }
}

export const fxFromEnv = (env = process.env): FxSource => (env.FX_PROVIDER === "offline" ? new Offline() : new FrankfurterCbk());
