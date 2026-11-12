import { expect, it } from "vitest";
import { getInterpreter } from "@/adapters";

// Mixed Kiswahili, Sheng and English requests: the item and the details that
// matter must survive. Logs the model's reading for the record.
const CASES: [string, RegExp][] = [
  ["Mum anataka cat carrier inayofunguka juu, isizidi 12k", /carrier/i],
  ["Nataka viatu za running size 42, budget elfu nane", /(running|shoe)/i],
  ["Rafiki yangu anataka headphones za wireless, kitu poa under 15k bob", /headphone/i],
  ["Natafuta handbag ya leather, rangi brown, si kubwa sana", /(bag|handbag)/i],
];

it("keeps the item and details in mixed-language requests", async () => {
  for (const [text, item] of CASES) {
    const r = await getInterpreter().interpret({ text, currentRequirements: [] });
    console.log(JSON.stringify({ text, item: r.item, proposals: r.proposedRequirements.map((p) => `${p.key} ${p.op} ${p.value}${p.unit ?? ""}`), reply: r.reply.slice(0, 140) }));
    expect(r.item ?? "").toMatch(item);
  }
}, 120_000);
