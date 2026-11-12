import type { Handoff } from "./types";

// Optional helper that fills a provider form. Off unless a driver is given;
// the handoff works the same when it is absent or fails.
export interface AssistDriver {
  fill(url: string, fields: Handoff["fields"]): Promise<void>;
}

export type AssistResult = { handoff: Handoff; assisted: boolean; error?: string };

export async function withAssist(handoff: Handoff, driver?: AssistDriver | null, enabled = false): Promise<AssistResult> {
  if (!driver || !enabled) return { handoff, assisted: false };
  try {
    await driver.fill(handoff.officialUrl, handoff.fields);
    return { handoff, assisted: true };
  } catch {
    return { handoff, assisted: false, error: "Autofill is unavailable. Use the copy buttons instead." };
  }
}
