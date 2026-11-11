export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startReconciler } = await import("@/payments/scheduler");
  startReconciler();
  if ((process.env.WHATSAPP_BRIDGE_SECRET ?? "").length >= 32) {
    const { startChannelWorker } = await import("@/channel/worker");
    startChannelWorker();
  }
}
