// What the forwarder will fly, decided by fixed rules on the listing's words
// and category, never by the model. Source: kentexcargo.com/help/general/
// prohibited-goods, read 2026-11-12 (P). Ambiguous words go to review, so a
// false match costs a quote, not a wrong shipment.
export type Verdict = "ok" | "declare" | "review" | "no_air" | "prohibited";
export interface Check { verdict: Verdict; reason: string }

export const RESTRICTED_SOURCE = "kentexcargo.com/help/general/prohibited-goods, read 2026-11-12 (P)";

type Rule = [Verdict, RegExp, string];
const RULES: Rule[] = [
  ["prohibited", /\b(firearms?|rifles?|pistols?|revolvers?|shotguns?|ammunition|ammo)\b|(?<!(glue|massage|nerf|water|toy|heat|nail|staple|spray|caulk|caulking|grease|tattoo|bubble|foam|hot ?glue)[ -])\bguns?\b/,
    "Weapons and ammunition cannot be shipped."],
  ["prohibited", /\b(fireworks?|explosives?|flares?|sparklers?)\b/, "Explosives and fireworks cannot be shipped."],
  ["prohibited", /\b(lighter fluid|butane|propane|gasoline|kerosene|fuel can|aerosols?|spray paint|compressed gas|gas canister)\b/,
    "Flammable liquids, aerosols and compressed gases cannot be shipped."],
  ["prohibited", /\b(acrylic|oil|wall|enamel|latex|exterior|interior) paint\b|\bpaint (can|tin|gallon|quart)s?\b/, "Paint counts as a flammable liquid and cannot be shipped."],
  ["prohibited", /\b(pesticides?|insecticides?|herbicides?|weed killer|rat poison|bleach|drain cleaner|muriatic|sulfuric acid|corrosive)\b/,
    "Corrosive and toxic chemicals cannot be shipped."],
  ["prohibited", /\b(live (plants?|animals?|fish)|fresh (meat|fish|fruit|produce)|frozen food|perishable)\b/, "Live animals, plants and perishable food cannot be shipped."],
  ["prohibited", /\b(radioactive|uranium)\b/, "Radioactive materials cannot be shipped."],
  ["no_air", /\b(power ?banks?|portable chargers?|battery packs?|spare batter(y|ies)|lithium batter(y|ies)|li-?ion batter(y|ies)|18650|jump starters?)\b/,
    "Power banks and loose lithium batteries cannot go by air."],
  ["review", /\b(vapes?|e-?cig(arette)?s?|cigars?|cigarettes?|tobacco|nicotine)\b/, "Tobacco and vapes have duty limits; Kentex must confirm."],
  ["review", /\b(wine|whisk(e)?y|vodka|rum|tequila|liquor|champagne|bourbon|cognac)\b(?! (glass|glasses|rack|opener|decanter|cooler|stopper))/,
    "Alcohol has duty and quantity limits; Kentex must confirm."],
  ["review", /\b(prescription|rx only|medication|antibiotics?)\b/, "Prescription medicine needs a prescription and may need Kenyan clearance."],
  ["review", /\b(supplements?|vitamins?|protein powder|probiotics?|melatonin|creatine)\b/, "Supplements need proper labels and documents; Kentex must confirm."],
  ["review", /\b(e-?bikes?|electric (bike|scooter)s?|hoverboards?|e-?scooters?)\b/, "Large lithium batteries need Kentex's confirmation before flying."],
  ["review", /\b(seeds?|bulbs? for planting)\b/, "Seeds and plant material may need a permit; Kentex must confirm."],
  ["declare", /\b(phones?|smartphones?|laptops?|tablets?|ipads?|headphones?|earbuds?|earphones?|smart ?watch(es)?|speakers?|cameras?|kindle|e-?readers?|drones?|electric toothbrush|shavers?|trimmers?|game controllers?|wireless|bluetooth|rechargeable|cordless)\b/,
    "Has a built-in battery: we declare it to Kentex for you."],
];

const ML = /(\d+(?:\.\d+)?)\s*(ml|millilit(er|re)s?|fl\.? ?oz|ounces?)\b/;

function perfume(t: string): Check | null {
  if (!/\b(perfume|cologne|eau de (parfum|toilette)|fragrance mist|body mist)\b/.test(t)) return null;
  const m = ML.exec(t);
  if (!m) return { verdict: "review", reason: "Perfume over 500 ml cannot fly; the bottle size is not listed." };
  const ml = m[2].startsWith("m") ? Number(m[1]) : Number(m[1]) * 29.57;
  return ml > 500 ? { verdict: "no_air", reason: "Perfume over 500 ml counts as a flammable liquid on air cargo." } : null;
}

// Strictest rule wins: prohibited, then no air, then review, then declare
const RANK: Record<Verdict, number> = { prohibited: 4, no_air: 3, review: 2, declare: 1, ok: 0 };

export function checkItem(item: { title: string; category?: string[] }): Check {
  const t = [item.title, ...(item.category ?? []).map((c) => c.replace(/-/g, " "))].join(" ").toLowerCase();
  const hits: Check[] = RULES.filter(([, re]) => re.test(t)).map(([verdict, , reason]) => ({ verdict, reason }));
  const p = perfume(t);
  if (p) hits.push(p);
  return hits.sort((a, b) => RANK[b.verdict] - RANK[a.verdict])[0] ?? { verdict: "ok", reason: "" };
}
