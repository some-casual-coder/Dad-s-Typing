export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startReconciler } = await import("@/payments/scheduler");
  startReconciler();
  const { assertDistinctSecrets, channelIds, isConfigured } = await import("@/channel/registry");
  assertDistinctSecrets();
  if (channelIds().some((id) => isConfigured(id))) {
    const { startChannelWorker } = await import("@/channel/worker");
    startChannelWorker();
  }
}
