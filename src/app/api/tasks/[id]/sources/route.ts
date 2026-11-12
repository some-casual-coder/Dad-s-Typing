import { authorize } from "@/domain/access";
import { tx } from "@/domain/db";
import { analysisConfigured, pollDue, sourcesView, uploadCandidates } from "@/sources/intake";
import { bearer, handle, json, uuid } from "../../../_lib/http";

export const GET = handle<{ id: string }>(async (req, { id }) => {
  const taskId = uuid(id), token = bearer(req);
  await tx((c) => authorize(c, taskId, token, "view"));
  if (analysisConfigured()) await pollDue(undefined, taskId).catch(() => console.error("source_error", "poll"));
  return json(await tx(async (c) => ({ sources: await sourcesView(c, taskId), uploads: await uploadCandidates(c, taskId) })));
});
