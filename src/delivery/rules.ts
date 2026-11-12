import type { Component, Provider } from "./types";

// Dated, sourced fixtures. Nothing here is a quote.
export const RULES_AS_OF = "2026-11-12";

export const RULES = {
  kentex: {
    source: "kentexcargo.com/help/air-shipping-kenya, read 2026-11-12",
    airUsdPerKgMinor: 1799,
    minimumUsdMinor: { texas: 5000, delaware: 10000 } as Record<string, number>,
    // Inches cubed per kg, from the same page
    volumetricInchesDivisor: 306,
    // Assisted shopping terms, kentexcargo.com/help/usa/assisted-shopping, read 2026-11-12
    assistedFeePct: 10,
    insuranceThresholdMinor: 20000,
    insurancePct: 5,
    customs: "included" as const,
    customsNote: "Provider says clearance, duties and import taxes are in the rate for standard personal shipments; VAT is not mentioned.",
  },
  aquantuo: {
    source: "aquantuo.com price update (US, from 2025-05-30) and Kenya shipping page (UK), via search results 2026-11-12",
    airUsdPerKgMinor: 1800,
    // UK page figure seen only in a search summary; the page itself was not readable
    ukAirUsdPerKgMinor: 1400,
    buyForMeFeePct: 7.5,
    // Divisor not published on a page we could read
    customs: "unknown" as const,
    customsNote: "Homepage says it handles customs and applicable taxes; whether the Kenya rate includes them is unconfirmed.",
  },
};

export const SOURCE_URLS: Record<Provider, { estimator: string; quote: string }> = {
  aquantuo: { estimator: "https://aquantuo.com/Price-Estimator", quote: "https://aquantuo.com/request-a-quote" },
  kentex: { estimator: "https://kentexcargo.com/help/air-shipping-kenya", quote: "https://kentexcargo.com/ke/amazon" },
};

export const comp = (c: Omit<Component, "asOf">): Component => ({ ...c, asOf: RULES_AS_OF });
