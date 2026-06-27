import { describe, expect, it } from "vitest";
import { keepKey, profileKey, runKey, screenshotKey, shoeKey, shoePhotoKey, weightKey } from "../shared/cosKeys";
import { validateRunPayload, validateShoePayload, validateWeightPayload } from "../shared/validation";

describe("cos key helpers", () => {
  it("generates stable user scoped keys", () => {
    expect(profileKey("fish")).toBe("users/fish/profile.json");
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
      weather: { temperatureC: 15, humidityPct: 40, aqi: 35 },
      notes: "  后半程感觉稳定  ",
      splits: [],
      screenshotKeys: ["key"]
    });
    expect(run.avgPaceSecPerKm).toBe(360);
    expect(run.shoeId).toBe("shoe-1");
    expect(run.screenshotKeys).toEqual(["key"]);
    expect(run.notes).toBe("后半程感觉稳定");
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
