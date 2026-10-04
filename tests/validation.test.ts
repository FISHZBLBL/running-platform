import { afterEach, describe, expect, it, vi } from "vitest";
import { isUserShoePhotoKey, keepKey, profileKey, runKey, runnerProfileKey, screenshotKey, shoeKey, shoePhotoKey, weightKey } from "../shared/cosKeys";
import { validateRunPayload, validateRunnerProfilePayload, validateShoePayload, validateWeightPayload } from "../shared/validation";

afterEach(() => vi.useRealTimers());

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

  it.each(["../../victim/profile", "..", "../outside", "run/id", "run\\id", "%2e%2e", "", "x".repeat(129)])("rejects unsafe object ids: %s", (id) => {
    expect(() => runKey("fish", id)).toThrow();
    expect(() => shoeKey("fish", id)).toThrow();
    expect(() => screenshotKey("fish", id, "photo-1", "png")).toThrow();
    expect(() => shoePhotoKey("fish", "shoe-1", id, "jpg")).toThrow();
  });

  it("rejects traversal and cross-account photo keys while accepting normal photos", () => {
    expect(isUserShoePhotoKey("fish", "users/fish/shoes/shoe-1/photos/a.jpg", "shoe-1")).toBe(true);
    for (const key of [
      "users/other/shoes/shoe-1/photos/a.jpg",
      "users/fish/shoes/x/photos/../../../../other/profile.json",
      "users/fish/shoes/shoe-1/photos/%2e%2e.jpg",
      "users/fish/shoes/shoe-2/photos/a.jpg",
      "users/fish/shoes/shoe-1/photos/a.jpg/extra"
    ]) expect(isUserShoePhotoKey("fish", key, "shoe-1")).toBe(false);
    expect(() => profileKey("../fish")).toThrow();
    expect(() => weightKey("fish", "2026-02-30")).toThrow();
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

  it("saves a future race date while still rejecting a future birth date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    const predictionTarget = {
      mode: "date-finish",
      targetDistanceKm: 21.0975,
      targetFinishSec: null,
      targetDate: "2026-09-26"
    };

    expect(validateRunnerProfilePayload({ predictionTarget }).predictionTarget).toEqual(predictionTarget);
    expect(() => validateRunnerProfilePayload({ birthDate: "2026-09-26" })).toThrow(/not in the future/);
  });

  it.each(["2027-02-29", "2026-02-30", "2026-13-01", "2026/09/26"])(
    "rejects an invalid target calendar date: %s",
    (targetDate) => {
      expect(() => validateRunnerProfilePayload({ predictionTarget: {
        mode: "date-finish", targetDistanceKm: 21.0975, targetFinishSec: null, targetDate
      } })).toThrow(/predictionTarget.targetDate/);
    }
  );

  it("accepts a valid future leap day", () => {
    const predictionTarget = {
      mode: "date-finish", targetDistanceKm: 21.0975, targetFinishSec: null, targetDate: "2028-02-29"
    };
    expect(validateRunnerProfilePayload({ predictionTarget }).predictionTarget?.targetDate).toBe("2028-02-29");
  });

  it("accepts today's birth date during the early morning in Shanghai", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T16:30:00Z"));
    expect(validateRunnerProfilePayload({ birthDate: "2026-10-04" }).birthDate).toBe("2026-10-04");
    expect(() => validateRunnerProfilePayload({ birthDate: "2026-10-05" })).toThrow(/not in the future/);
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

  it.each(["2026-02-30", "2027-02-29", "2026-13-01", "2026-00-01", "2026-04-31"])("rejects nonexistent weight and run dates: %s", (date) => {
    expect(() => validateWeightPayload({ date, weightKg: 70 })).toThrow(/calendar date/);
    const run = {
      id: "run-date-test", dateTime: "2026-10-01T08:00:00Z", distanceKm: 5, durationSec: 1800,
      avgPowerW: 200, avgCadenceSpm: 170, avgHeartRateBpm: 150
    };
    expect(() => validateRunPayload({ ...run, localDate: date })).toThrow(/localDate/);
    expect(() => validateRunPayload({ ...run, dateTime: `${date}T08:00:00Z` })).toThrow(/dateTime/);
  });

  it("accepts real leap dates and enforces media ownership for backend payloads", () => {
    expect(validateWeightPayload({ date: "2028-02-29", weightKg: 70 }).date).toBe("2028-02-29");
    const run = {
      id: "run-media", dateTime: "2028-02-29T08:00:00+08:00", localDate: "2028-02-29",
      distanceKm: 5, durationSec: 1800, avgPowerW: 200, avgCadenceSpm: 170, avgHeartRateBpm: 150,
      screenshotKeys: ["users/fish/runs/run-media/screenshots/photo-1.png"]
    };
    expect(validateRunPayload(run, undefined, "fish").screenshotKeys).toEqual(run.screenshotKeys);
    expect(() => validateRunPayload({ ...run, id: "../victim/profile" })).toThrow();
    expect(() => validateRunPayload({ ...run, screenshotKeys: ["users/other/runs/run-media/screenshots/photo-1.png"] }, undefined, "fish")).toThrow(/screenshotKeys/);
    expect(() => validateShoePayload({ id: "shoe-1", name: "Shoe", photoKey: "users/other/shoes/shoe-1/photos/photo-1.jpg" }, undefined, "fish")).toThrow(/photoKey/);
  });
});
