import { readSigned } from "@/channel/bridge";
import { reportHealth } from "@/channel/outbox";
import { handle, invalid } from "@/app/api/_lib/http";

export const POST = handle<{ channel: string }>(async (req, { channel }) => {
  const b = await readSigned(channel, req);
  const { connected, paired, loggedOut, version, at } = b;
  if (typeof connected !== "boolean" || typeof paired !== "boolean" || typeof loggedOut !== "boolean") throw invalid("health flags");
  if (typeof version !== "string" || version.length > 40 || typeof at !== "string" || Number.isNaN(Date.parse(at))) throw invalid("health fields");
  await reportHealth(channel, { connected, paired, loggedOut, version, at: new Date(at).toISOString() });
  return new Response(null, { status: 204 });
});
