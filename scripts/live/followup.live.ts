import { expect, it } from "vitest";
import { getInterpreter } from "@/adapters";

// A text follow-up after a photo: the item is known, so the model proposes the
// requirement instead of asking what the item is
it("turns 'must open from the top, not the front' into an essential requirement", async () => {
  const r = await getInterpreter().interpret({ text: "It must open from the top, not the front.", item: "top opening cat carrier", currentRequirements: [] });
  console.log(JSON.stringify({ proposals: r.proposedRequirements, reply: r.reply }));
  expect(r.proposedRequirements.some((p) => p.key === "opening" && ((p.op === "eq" && p.value === "top") || (p.op === "neq" && p.value === "front")) && p.essential)).toBe(true);
  expect(r.reply).not.toMatch(/what item|what are you looking for/i);
}, 60_000);
