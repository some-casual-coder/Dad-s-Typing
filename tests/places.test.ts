import "./env";
import { describe, expect, it } from "vitest";
import { isKenyanNumber, placeFromPin, placeFromText } from "@/delivery/places";
import { answerFromText } from "@/domain/destination";

describe("places", () => {
  it("maps pins to areas, towns or a county, offline", () => {
    expect(placeFromPin(-1.266, 36.804)).toEqual({ area: "Westlands", county: "Nairobi", approximate: false });
    expect(placeFromPin(-0.1, 34.76)).toMatchObject({ area: "near Kisumu", county: "Kisumu", approximate: true });
    expect(placeFromPin(51.5, -0.1)).toBe("outside_kenya");
    expect(placeFromPin(Number.NaN, 1)).toBe("invalid");
  });
  it("reads a typed place, longest name first", () => {
    expect(placeFromText("deliver to South B please")).toEqual({ area: "South B", county: "Nairobi" });
    expect(placeFromText("Uasin Gishu")).toEqual({ area: "Uasin Gishu", county: "Uasin Gishu" });
    expect(placeFromText("somewhere nice")).toBeNull();
  });
  it("knows a Kenyan number by country code only", () => {
    expect(isKenyanNumber("254712345678")).toBe(true);
    expect(isKenyanNumber("+254 712 345 678")).toBe(true);
    expect(isKenyanNumber("447700900123")).toBe(false);
  });
  it("treats yes as confirming the current guess", () => {
    const cur = { county: "Nairobi", area: "", handling: "door" as const, source: "country_code" as const, confirmed: false };
    expect(answerFromText("Yes!", cur)).toEqual({ county: "Nairobi", area: "", handling: "pickup" });
    expect(answerFromText("Kisumu", cur)).toEqual({ county: "Kisumu", area: "Kisumu", handling: "door" });
    expect(answerFromText("door please", cur)).toEqual({ county: "Nairobi", area: "", handling: "door" });
    expect(answerFromText("yes but it has to open from the top", cur)).toBeNull();
  });
});

describe("place labels", () => {
  it("never repeats the county", async () => {
    const { placeLabel } = await import("@/domain/destination");
    expect(placeLabel({ area: "near Kisumu", county: "Kisumu" })).toBe("near Kisumu");
    expect(placeLabel({ area: "Westlands", county: "Nairobi" })).toBe("Westlands, Nairobi");
    expect(placeLabel({ area: "", county: "Nairobi" })).toBe("Nairobi");
  });
});

describe("destination input never takes a street address", () => {
  it("keeps an unknown town but refuses an address", async () => {
    const { createTask } = await import("@/domain/tasks");
    const { setDestination } = await import("@/domain/destination");
    const t = await createTask({ title: "x", starterRoles: ["requester", "chooser"], starterLabel: "Me" });
    expect(await setDestination(t.taskId, t.token, { place: "Kakuma" })).toEqual({ county: "Kakuma", area: "" });
    await expect(setDestination(t.taskId, t.token, { place: "14 Riverside Drive, Apt 3" })).rejects.toMatchObject({ code: "invalid" });
  });
});
