import { processInboxOnce } from "./inbox";

const g = globalThis as unknown as { __dtChannelWorker?: boolean };

export function startChannelWorker(everyMs = 2_000) {
  if (g.__dtChannelWorker) return;
  g.__dtChannelWorker = true;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processInboxOnce();
    } catch (e) {
      console.error("channel_worker_failed", (e as Error)?.name);
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref();
}
