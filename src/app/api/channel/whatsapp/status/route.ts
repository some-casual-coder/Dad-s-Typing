import { publicStatus } from "@/channel/outbox";
import { handle, json } from "@/app/api/_lib/http";

export const GET = handle(async () => json(await publicStatus()));
