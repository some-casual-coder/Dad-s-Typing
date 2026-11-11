export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startReconciler } = await import("@/payments/scheduler");
  startReconciler();
  const { channelIds, isConfigured } = await import("@/channel/registry");
  if (channelIds().some((id) => isConfigured(id))) {
    const { startChannelWorker } = await import("@/channel/worker");
    startChannelWorker();
  }
}
