import "./env";
import { describe, expect, it } from "vitest";
import { estimateParcel } from "@/delivery/packaging";
import { calibrationSummary, recordActual, recordEstimate } from "@/domain/calibration";
import { tx } from "@/domain/db";
import { createTask, getComparison, recordOffers } from "@/domain/tasks";

describe("parcel calibration log", () => {
  it("logs the estimate once, then the actual, and summarises the error", async () => {
    const t = await createTask({ title: "Cat carrier", starterRoles: ["requester", "chooser", "payer"], starterLabel: "Me" });
    await recordOffers(t.taskId, [{ source: "channel3", sourceOfferId: "C-1", route: "external", seller: "shop.test", title: "Cat carrier",
      unitPriceMinor: 3000, currency: "USD", availability: "InStock", url: "https://shop.test/x", specs: { weightGrams: 1200 } }]);
    const offerId = (await getComparison(t.taskId, t.token)).offers[0].id;
    const e = estimateParcel({ title: "Cat carrier", specs: { weightGrams: 1200 } });
    await tx(async (c) => {
      await recordEstimate(c, t.taskId, offerId, "kentex", e, 1200);
      await recordEstimate(c, t.taskId, offerId, "kentex", { ...e, basis: "category" }, 1200);
      expect(await recordActual(c, t.taskId, offerId, "kentex", { grams: 1500, chargeableGrams: 4000, source: "Kentex invoice (fixture)" })).toBe(true);
      const row = (await c.query(`SELECT basis, actual_chargeable_grams FROM parcel_calibration WHERE task_id=$1`, [t.taskId])).rows;
      expect(row).toEqual([{ basis: "weight_only", actual_chargeable_grams: 4000 }]);
      const s = await calibrationSummary(c, "pet carrier");
      expect(s.n).toBeGreaterThanOrEqual(1);
    });
  });
});
