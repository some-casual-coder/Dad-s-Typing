// Where to collect, with provenance. Only verified fields are sent to people;
// an operator sets the rest by env once confirmed with the provider.
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

const pinFrom = (v: string | undefined) => {
  const m = v ? /^(-?\d{1,2}\.\d{3,7}),(-?\d{1,3}\.\d{3,7})$/.exec(v.trim()) : null;
  return m ? { lat: Number(m[1]), lon: Number(m[2]), approximate: false, source: "Operator-confirmed pin" } : null;
};
const phoneFrom = (v: string | undefined) => (v && /^\+254\d{9}$/.test(v.trim()) ? v.trim() : null);

export function hubFor(provider: string, env: Record<string, string | undefined> = process.env): Hub | null {
  if (provider === "kentex") return {
    provider, name: "Kentex Cargo, Westlands office", address: "65 Muthithi Road, Westlands, Nairobi",
    // OpenStreetMap places the road, not No. 65, so the pin is labelled approximate
    pin: pinFrom(env.HUB_KENTEX_PIN) ?? { lat: -1.2679, lon: 36.8089, approximate: true, source: "OpenStreetMap, Muthithi Road centre, 2026-11-12" },
    phone: phoneFrom(env.HUB_KENTEX_PHONE), hours: env.HUB_KENTEX_HOURS?.trim().slice(0, 60) || null,
    bring: "Pay any balance on your Kentex invoice first; Kentex says no ID or collection code is needed.",
    source: "kentexcargo.com/help/air-shipping-kenya, read 2026-11-12 (P)",
  };
  // Aquantuo's Nairobi collection point is not confirmed yet
  if (provider === "aquantuo") return null;
  return null;
}

export const mapsLink = (p: { lat: number; lon: number }) => `https://maps.google.com/?q=${p.lat},${p.lon}`;
