import { getPayments } from "@/adapters";
import { reconcileOpenAttempts } from "./reconcile";

const g = globalThis as unknown as { __dtReconciler?: boolean };

export function startReconciler(everyMs = 60_000) {
  if (g.__dtReconciler) return;
  g.__dtReconciler = true;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await reconcileOpenAttempts(getPayments());
    } catch (e) {
      console.error("reconcile_failed", (e as Error)?.name);
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref();
}
