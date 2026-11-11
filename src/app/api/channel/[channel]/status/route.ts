import { publicStatus } from "@/channel/outbox";
import { getChannel } from "@/channel/registry";
import { handle, json } from "@/app/api/_lib/http";

export const GET = handle<{ channel: string }>(async (_req, { channel }) => json(await publicStatus(getChannel(channel).id)));
