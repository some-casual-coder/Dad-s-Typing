export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startReconciler } = await import("@/payments/scheduler");
  startReconciler();
}
