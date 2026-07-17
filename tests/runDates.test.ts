import { describe, expect, it } from "vitest";
import { calendarDateFromDateTime, runLocalDate, runLocalMonth } from "../shared/runDates";

describe("running record calendar dates", () => {
  it("restores the July 14 morning run from its UTC timestamp", () => {
    expect(calendarDateFromDateTime("2026-07-13T23:32:00.000Z")).toBe("2026-07-14");
  });

  it("restores the July 7 morning run from its UTC timestamp", () => {
    expect(calendarDateFromDateTime("2026-07-06T23:58:00.000Z")).toBe("2026-07-07");
  });

  it("keeps an evening run on the same calendar date", () => {
    expect(calendarDateFromDateTime("2026-07-16T14:07:00.000Z")).toBe("2026-07-16");
  });

  it("uses the explicitly saved local date before deriving a legacy fallback", () => {
    expect(runLocalDate({ dateTime: "2026-07-13T23:32:00.000Z", localDate: "2026-07-15" })).toBe("2026-07-15");
  });

  it("groups an early first-of-month run into the correct month", () => {
    expect(runLocalMonth({ dateTime: "2026-06-30T23:30:00.000Z" })).toBe("2026-07");
  });
});
