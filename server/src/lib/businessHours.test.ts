import { describe, expect, it } from "vitest";
import { addBusinessHours, businessHoursBetween, isWithinBusinessHours } from "./businessHours";

// All test instants fall in a clean week with no BG holidays (Sept 2026)
// and during Sofia's summer UTC+3 offset (DST ends late October), so the
// UTC comments below are exact: Sofia local = UTC + 3h.
// 2026-09-14 Mon, 15 Tue, 16 Wed, 17 Thu, 18 Fri, 19 Sat, 20 Sun, 21 Mon.

describe("addBusinessHours", () => {
  it("starts immediately when submitted inside the business window", () => {
    // Tue 10:00 Sofia (07:00 UTC) + 8h -> exactly Tue 18:00 Sofia (15:00 UTC)
    const from = new Date("2026-09-15T07:00:00.000Z");
    const result = addBusinessHours(from, 8);
    expect(result.toISOString()).toBe("2026-09-15T15:00:00.000Z");
  });

  it("jumps to the next working day's opening when submitted in the evening", () => {
    // Fri 20:00 Sofia (17:00 UTC) + 1h -> Mon 09:00 Sofia + 1h = Mon 10:00 Sofia (07:00 UTC)
    const from = new Date("2026-09-18T17:00:00.000Z");
    const result = addBusinessHours(from, 1);
    expect(result.toISOString()).toBe("2026-09-21T07:00:00.000Z");
  });

  it("jumps clean over a weekend when submitted on Saturday", () => {
    // Sat 13:00 Sofia (10:00 UTC) + 2h -> Mon 09:00 Sofia + 2h = Mon 11:00 Sofia (08:00 UTC)
    const from = new Date("2026-09-19T10:00:00.000Z");
    const result = addBusinessHours(from, 2);
    expect(result.toISOString()).toBe("2026-09-21T08:00:00.000Z");
  });

  it("pauses at closing and resumes the next working day mid-add", () => {
    // Tue 16:00 Sofia (13:00 UTC) + 4h -> 2h used to 18:00 Tue, 2h remaining
    // resumes Wed 09:00 Sofia -> Wed 11:00 Sofia (08:00 UTC)
    const from = new Date("2026-09-15T13:00:00.000Z");
    const result = addBusinessHours(from, 4);
    expect(result.toISOString()).toBe("2026-09-16T08:00:00.000Z");
  });

  it("starts at the beginning of the day when submitted before opening", () => {
    // Tue 06:00 Sofia (03:00 UTC) + 1h -> Tue 09:00 Sofia + 1h = Tue 10:00 Sofia (07:00 UTC)
    const from = new Date("2026-09-15T03:00:00.000Z");
    const result = addBusinessHours(from, 1);
    expect(result.toISOString()).toBe("2026-09-15T07:00:00.000Z");
  });
});

describe("businessHoursBetween", () => {
  it("counts only same-day business time within one day", () => {
    // Tue 10:00 -> Tue 14:00 Sofia = 4h
    const from = new Date("2026-09-15T07:00:00.000Z");
    const to = new Date("2026-09-15T11:00:00.000Z");
    expect(businessHoursBetween(from, to)).toBe(4);
  });

  it("excludes a full weekend in between", () => {
    // Fri 18:00 Sofia (exactly closing) -> Mon 10:00 Sofia = only Mon's 09:00-10:00 = 1h
    const from = new Date("2026-09-18T15:00:00.000Z");
    const to = new Date("2026-09-21T07:00:00.000Z");
    expect(businessHoursBetween(from, to)).toBe(1);
  });

  it("returns 0 for a same-instant or backwards range", () => {
    const t = new Date("2026-09-15T07:00:00.000Z");
    expect(businessHoursBetween(t, t)).toBe(0);
    expect(businessHoursBetween(t, new Date(t.getTime() - 1000))).toBe(0);
  });
});

describe("isWithinBusinessHours", () => {
  it("is true during a working day's window", () => {
    expect(isWithinBusinessHours(new Date("2026-09-15T07:00:00.000Z"))).toBe(true); // Tue 10:00
  });

  it("is false outside the window on a working day", () => {
    expect(isWithinBusinessHours(new Date("2026-09-15T16:00:00.000Z"))).toBe(false); // Tue 19:00
  });

  it("is false on a weekend regardless of hour", () => {
    expect(isWithinBusinessHours(new Date("2026-09-19T09:00:00.000Z"))).toBe(false); // Sat 12:00
  });
});
