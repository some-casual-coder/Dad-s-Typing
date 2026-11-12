import { login, OP_COOKIE } from "@/domain/operatorSession";
import { clientIp, handle, json, rateLimit, readJson } from "../../_lib/http";

export const POST = handle(async (req) => {
  rateLimit(`oplogin:${clientIp(req)}`, 5);
  const b = await readJson(req, 500);
  const s = login(typeof b.secret === "string" ? b.secret : "");
  const res = json({ ok: true });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.headers.append("Set-Cookie", `${OP_COOKIE}=${s.value}; HttpOnly; SameSite=Strict; Path=/api/operator; Max-Age=${s.maxAge}${secure}`);
  return res;
});

export const DELETE = handle(async () => {
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", `${OP_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/operator; Max-Age=0`);
  return res;
});
