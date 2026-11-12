import "./env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({ calls: 0, fail: false }));
vi.mock("@/adapters", () => ({
  getFx: () => ({ kesRate: async (cur: string) => {
    fx.calls++;
    if (fx.fail) throw new (class extends Error { kind = "unavailable"; })("down");
    return { rate: cur === "USD" ? 130.5 : 175.25, date: "2026-11-11", source: "test CBK" };
  } }),
}));

import { pool } from "@/domain/db";
import { currentFx } from "@/domain/fx";
import { fxLabel, toKes } from "@/delivery/fx";

beforeEach(async () => { await pool.query("DELETE FROM fx_rates"); fx.calls = 0; fx.fail = false; });

describe("FX source, cache and fallback", () => {
  it("fetches, stores with source and date, and reuses a fresh rate without calling again", async () => {
    const now = new Date("2026-11-12T08:00:00Z");
    const a = await currentFx(now);
    expect(a.USD).toMatchObject({ kesPerUnitMicro: 130_500_000, source: "test CBK", rateDate: "2026-11-11", stale: false });
    expect(fx.calls).toBe(2);
    await currentFx(new Date(now.getTime() + 3600_000));
    expect(fx.calls).toBe(2);
    expect((await pool.query("SELECT count(*)::int n FROM fx_rates")).rows[0].n).toBe(2);
  });

  it("uses the last stored rate, marked out of date, when the source is down", async () => {
    await currentFx(new Date("2026-11-11T08:00:00Z"));
    fx.fail = true;
    const b = await currentFx(new Date("2026-11-12T08:00:00Z"));
    expect(b.USD).toMatchObject({ kesPerUnitMicro: 130_500_000, stale: true });
    expect(fxLabel(b)).toMatch(/may be out of date$/);
    expect(toKes(10_000, "USD", b)!.low).toBe(1_305_000);
  });

  it("falls back to a labelled offline rate when nothing is stored and the source is down", async () => {
    fx.fail = true;
    const c = await currentFx(new Date("2026-11-12T08:00:00Z"));
    expect(c.USD).toMatchObject({ source: "Offline fallback, not a market rate", stale: true });
    expect(fxLabel(c)).toMatch(/Offline fallback, not a market rate.*may be out of date/);
  });
});
