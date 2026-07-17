import { describe, expect, it } from "vitest";
import { keepKey, profileKey, runKey, runnerProfileKey, screenshotKey, shoeKey, shoePhotoKey, weightKey } from "../shared/cosKeys";
import { validateRunPayload, validateRunnerProfilePayload, validateShoePayload, validateWeightPayload } from "../shared/validation";

describe("cos key helpers", () => {
  it("generates stable user scoped keys", () => {
    expect(profileKey("fish")).toBe("users/fish/profile.json");
    expect(runnerProfileKey("fish")).toBe("users/fish/runner-profile.json");
    expect(keepKey("fish")).toBe("users/fish/.keep");
    expect(runKey("fish", "run-1")).toBe("users/fish/runs/run-1.json");
    expect(shoeKey("fish", "shoe-1")).toBe("users/fish/shoes/shoe-1.json");
    expect(shoePhotoKey("fish", "shoe-1", "photo-1", ".JPG")).toBe("users/fish/shoes/shoe-1/photos/photo-1.jpg");
    expect(weightKey("fish", "2026-01-01")).toBe("users/fish/weights/2026-01-01.json");
    expect(screenshotKey("fish", "run-1", "file-1", ".PNG")).toBe("users/fish/runs/run-1/screenshots/file-1.png");
  });
});

describe("validation", () => {
  it("normalizes a run payload and derives pace", () => {
    const run = validateRunPayload({
      id: "abc",
      dateTime: "2026-01-01T08:00:00.000Z",
      shoeId: "shoe-1",
      distanceKm: 10,
      durationSec: 3600,
      avgPowerW: 190,
      avgCadenceSpm: 172,
      avgHeartRateBpm: 150,
      effortScore: 8,
      effortSource: "apple-watch",
      performanceType: "race",
      elevationGainM: 120,
      weather: { temperatureC: 15, humidityPct: 40, aqi: 35 },
      notes: "  后半程感觉稳定  ",
      splits: [],
      screenshotKeys: ["key"]
    });
    expect(run.avgPaceSecPerKm).toBe(360);
    expect(run.shoeId).toBe("shoe-1");
    expect(run.screenshotKeys).toEqual(["key"]);
    expect(run.notes).toBe("后半程感觉稳定");
    expect(run.effortScore).toBe(8);
    expect(run.effortSource).toBe("apple-watch");
    expect(run.performanceType).toBe("race");
    expect(run.elevationGainM).toBe(120);
    expect(run.localDate).toBe("2026-01-01");
  });

  it("backfills a legacy morning run with its Shanghai calendar date", () => {
    const run = validateRunPayload({
      id: "morning-run",
      dateTime: "2026-07-13T23:32:00.000Z",
      shoeId: null,
      distanceKm: 5,
      durationSec: 2177,
      avgPowerW: 208,
      avgCadenceSpm: 165,
      avgHeartRateBpm: 159,
      weather: { temperatureC: null, humidityPct: null, aqi: null },
      notes: "",
      splits: [],
      screenshotKeys: []
    });

    expect(run.localDate).toBe("2026-07-14");
  });

  it("accepts a time-only tail split without requiring pace or sensor metrics", () => {
    const run = validateRunPayload({
      id: "tail-split-run",
      dateTime: "2026-07-16T14:07:00.000Z",
      distanceKm: 5.01,
      durationSec: 1853,
      avgPaceSecPerKm: 369,
      avgPowerW: 248,
      avgCadenceSpm: 166,
      avgHeartRateBpm: 174,
      weather: {},
      notes: "",
      screenshotKeys: [],
      splits: [{
        index: 6,
        kind: "tail",
        durationSec: 3,
        distanceKm: 999,
        paceSecPerKm: 999,
        heartRateBpm: 999,
        powerW: 999,
        cadenceSpm: 999
      }]
    });

    expect(run.splits).toEqual([{
      index: 6,
      kind: "tail",
      durationSec: 3,
      distanceKm: 0,
      paceSecPerKm: 0,
      heartRateBpm: 0,
      powerW: 0,
      cadenceSpm: 0
    }]);
  });

  it("normalizes a runner profile", () => {
    const profile = validateRunnerProfilePayload({
      birthDate: "1995-04-20",
      sex: "male",
      heightCm: 175,
      restingHeartRateBpm: 55,
      measuredMaxHeartRateBpm: 192
    });
    expect(profile.birthDate).toBe("1995-04-20");
    expect(profile.restingHeartRateBpm).toBe(55);
    expect(profile.measuredMaxHeartRateBpm).toBe(192);
  });

  it("normalizes a running shoe payload", () => {
    const shoe = validateShoePayload({
      id: "shoe-1",
      name: "  Pegasus 41  ",
      photoKey: "users/fish/shoes/shoe-1/photos/a.jpg",
      photoUrl: "https://example.com/a.jpg"
    });
    expect(shoe.name).toBe("Pegasus 41");
    expect(shoe.photoUrl).toBe("https://example.com/a.jpg");
  });

  it("rejects invalid weight dates", () => {
    expect(() => validateWeightPayload({ date: "2026/01/01", weightKg: 70 })).toThrow(/YYYY-MM-DD/);
  });
});
