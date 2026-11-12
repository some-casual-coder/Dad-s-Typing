import type { Component, Provider } from "./types";

// Dated, sourced fixtures. Nothing here is a quote. Confidence key as in
// doc 17 section 7: P read on the provider page, S search summary, N Nathan's
// reading, M our model (an assumption to calibrate).
export const RULES_AS_OF = "2026-11-12";

export const RULES = {
  kentex: {
    source: "kentexcargo.com/help/air-shipping-kenya, read 2026-11-12 (P)",
    airUsdPerKgMinor: 1799,
    minimumUsdMinor: { texas: 5000, delaware: 10000 } as Record<string, number>,
    volumetricInchesDivisor: 306,
    // Assisted shopping, kentexcargo.com/help/usa/assisted-shopping (P)
    assistedSource: "kentexcargo.com/help/usa/assisted-shopping, read 2026-11-12 (P)",
    assistedFeePct: 10,
    insuranceThresholdMinor: 20000,
    insurancePct: 5,
    // Amazon tool, kentexcargo.com/help/amazon-shopping (P): Texas warehouse
    amazonSource: "kentexcargo.com/help/amazon-shopping, read 2026-11-12 (P)",
    amazonFeePct: 5,
    texasSalesTaxBp: 825,
    customs: "included" as const,
    customsNote: "Kentex says clearance, duties and import taxes are in the rate for standard personal shipments; VAT is not mentioned.",
    // Pickup at the Westlands office has no extra fee; door is billed by
    // chargeable weight, same countrywide, amount not published (P)
    pickupNote: "Collect from Kentex, Westlands, Nairobi. No extra fee.",
  },
  aquantuo: {
    source: "aquantuo.com price update (US, from 2025-05-30), via search results 2026-11-12 (S)",
    airUsdPerKgMinor: 1800,
    ukSource: "aquantuo.com Kenya rate card, UK air, per Nathan 2026-11-12 (N)",
    ukAirUsdPerKgMinor: 1400,
    buyForMeFeePct: 7.5,
    customs: "unknown" as const,
    customsNote: "Aquantuo says it handles customs; whether the Kenya rate includes duties and VAT is unconfirmed.",
  },
  // Our model, not a provider fee: Kentex publishes no door fee. Range
  // from Nairobi courier list prices (base about KSh 250 plus per kg).
  door: { kesBaseMinor: [30_000, 80_000], kesPerKgMinor: [3_000, 10_000], source: "Modelled from Nairobi courier list prices (M)" },
  // US sales tax and store delivery before the warehouse (M)
  usStore: { taxBp: [0, 1000], deliveryUsdMinor: [0, 1000], source: "Modelled: US state sales tax 0 to 10%, store delivery $0 to $10 (M)" },
};

export const SOURCE_URLS: Record<Provider, { estimator: string; quote: string; tracking: string }> = {
  aquantuo: { estimator: "https://aquantuo.com/Price-Estimator", quote: "https://aquantuo.com/request-a-quote", tracking: "https://aquantuo.com/track-order" },
  kentex: { estimator: "https://kentexcargo.com/help/air-shipping-kenya", quote: "https://kentexcargo.com/ke/amazon", tracking: "https://kentexcargo.com/tracking" },
};

export const comp = (c: Omit<Component, "asOf">): Component => ({ ...c, asOf: RULES_AS_OF });
