import { connection } from "next/server";
import { listOrders, requireOperator } from "@/domain/operatorSession";
import { handle, json } from "../../_lib/http";

export const GET = handle(async (req) => {
  await connection();
  requireOperator(req);
  return json({ orders: await listOrders() });
});
