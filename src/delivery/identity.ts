// Identity evidence: how well a listing matches the item the AI named.
// Word overlap is a first signal; image match can replace it later.
const STOP = new Set(["a", "an", "the", "for", "with", "and", "or", "of", "in", "to", "my", "her", "his", "their", "our", "from", "on",
  "this", "that", "like", "one", "new", "mum", "mom", "dad", "please", "some", "same", "size", "item", "thing"]);

const stem = (w: string) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

export function words(s: string): string[] {
  const out = s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
  return [...new Set(out)];
}

export interface Identity { score: number; matched: string[]; missing: string[] }

export function identity(reference: string, candidate: { title: string; brand?: string; category?: string[] }): Identity {
  const ref = words(reference);
  if (!ref.length) return { score: 0, matched: [], missing: [] };
  const have = new Set(words([candidate.title, candidate.brand ?? "", ...(candidate.category ?? []).map((c) => c.replace(/-/g, " "))].join(" ")));
  const matched = ref.filter((w) => have.has(w));
  return { score: matched.length / ref.length, matched, missing: ref.filter((w) => !have.has(w)) };
}

export const MIN_MATCH = 0.5;
const NEAR_BEST = 0.2;

// Closest match: no failed or unresolved requirement, and the listing is
// among the best identity scores. Confirming requirements is not required.
export function closestMatch(status: string, score: number, best: number): boolean {
  if (status === "ineligible" || status === "unresolved") return false;
  return score >= MIN_MATCH && score >= best - NEAR_BEST;
}
