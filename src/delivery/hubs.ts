// Where to collect, with provenance. Address, pin, hours and phone come from
// env once confirmed; unconfirmed fields stay null and are never sent.
export interface Hub {
  provider: "kentex" | "aquantuo";
  name: string;
  address: string | null;
  pin: { lat: number; lon: number; approximate: boolean; source: string } | null;
  phone: string | null;
  hours: string | null;
  bring: string;
  source: string;
}

type Env = Record<string, string | undefined>;

const pinFrom = (v: string | undefined) => {
  const m = v ? /^(-?\d{1,2}\.\d{3,8}),\s*(-?\d{1,3}\.\d{3,8})$/.exec(v.trim()) : null;
  return m ? { lat: Number(m[1]), lon: Number(m[2]), approximate: false, source: "Operator-confirmed pin" } : null;
};
const phoneFrom = (v: string | undefined) => (v && /^\+254\d{9}$/.test(v.trim()) ? v.trim() : null);
const text = (v: string | undefined, n: number) => v?.trim().slice(0, n) || null;

export function hubFor(provider: string, env: Env = process.env): Hub | null {
  if (provider === "kentex") return {
    provider, name: "Kentex Cargo, Westlands air cargo pickup",
    address: text(env.HUB_KENTEX_ADDRESS, 120) ?? "65 Muthithi Road, Westlands, Nairobi",
    // Without a confirmed pin, OpenStreetMap's road centre, labelled approximate
    pin: pinFrom(env.HUB_KENTEX_PIN) ?? { lat: -1.2679, lon: 36.8089, approximate: true, source: "OpenStreetMap, Muthithi Road centre, 2026-11-12" },
    phone: phoneFrom(env.HUB_KENTEX_PHONE), hours: text(env.HUB_KENTEX_HOURS, 80),
    bring: "Bring your Kentex account phone number, the tracking number and the collector's name and phone; pay any invoice balance first. No ID or code is needed. Collect within 7 days to avoid storage fees.",
    source: "kentexcargo.com/help/kenya-locations, read 2026-11-12 (P); air freight only, ocean uses Mombasa Road",
  };
  if (provider === "aquantuo") {
    const address = text(env.HUB_AQUANTUO_ADDRESS, 120);
    if (!address) return null;
    return {
      provider, name: "Aquantuo Nairobi office", address, pin: pinFrom(env.HUB_AQUANTUO_PIN),
      phone: phoneFrom(env.HUB_AQUANTUO_PHONE), hours: text(env.HUB_AQUANTUO_HOURS, 80),
      bring: "Bring your Aquantuo tracking or item ID.",
      source: "aquantuo.com Kenya page, office address and hours, per Nathan 2026-11-12",
    };
  }
  return null;
}

export const mapsLink = (p: { lat: number; lon: number }) => `https://maps.google.com/?q=${p.lat},${p.lon}`;
// No pin: a search link by address, so no coordinates are invented
export const mapsSearch = (address: string) => `https://maps.google.com/?q=${encodeURIComponent(address)}`;
