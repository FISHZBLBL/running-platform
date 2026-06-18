import { describe, expect, it } from "vitest";
import { keepKey, profileKey, runKey, screenshotKey, weightKey } from "../shared/cosKeys";
import { validateRunPayload, validateWeightPayload } from "../shared/validation";

describe("cos key helpers", () => {
  it("generates stable user scoped keys", () => {
    expect(profileKey("fish")).toBe("users/fish/profile.json");
    expect(keepKey("fish")).toBe("users/fish/.keep");
    expect(runKey("fish", "run-1")).toBe("users/fish/runs/run-1.json");
    expect(weightKey("fish", "2026-01-01")).toBe("users/fish/weights/2026-01-01.json");
    expect(screenshotKey("fish", "run-1", "file-1", ".PNG")).toBe("users/fish/runs/run-1/screenshots/file-1.png");
  });
});

describe("validation", () => {
  it("normalizes a run payload and derives pace", () => {
    const run = validateRunPayload({
      id: "abc",
      dateTime: "2026-01-01T08:00:00.000Z",
      distanceKm: 10,
      durationSec: 3600,
      avgPowerW: 190,
      avgCadenceSpm: 172,
      avgHeartRateBpm: 150,
      weather: { temperatureC: 15, humidityPct: 40, aqi: 35 },
      splits: [],
      screenshotKeys: ["key"]
    });
    expect(run.avgPaceSecPerKm).toBe(360);
    expect(run.screenshotKeys).toEqual(["key"]);
  });

  it("rejects invalid weight dates", () => {
    expect(() => validateWeightPayload({ date: "2026/01/01", weightKg: 70 })).toThrow(/YYYY-MM-DD/);
  });
});
