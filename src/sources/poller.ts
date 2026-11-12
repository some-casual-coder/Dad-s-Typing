import { pollDue } from "./intake";

const g = globalThis as unknown as { __dtSourcePoller?: boolean };

// Chat-only shoppers have no page polling; this advances their jobs
export function startSourcePoller(everyMs = 3_000) {
  if (g.__dtSourcePoller) return;
  g.__dtSourcePoller = true;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await pollDue(); } catch (e) { console.error("source_poll_failed", (e as Error)?.name); } finally { running = false; }
  }, everyMs);
  timer.unref();
}
