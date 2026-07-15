import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningRecord, UserProfile } from "../shared/types";

const memory = vi.hoisted(() => new Map<string, string>());

vi.mock("../netlify/functions/_shared/storage", () => ({
  storage: () => ({
    getText: async (key: string) => memory.get(key) ?? null,
    getFile: async () => null,
    putText: async (key: string, value: string) => {
      await Promise.resolve();
      memory.set(key, value);
    },
    putTextIfAbsent: async (key: string, value: string) => {
      if (memory.has(key)) return false;
      memory.set(key, value);
      return true;
    },
    putFile: async () => undefined,
    delete: async (key: string) => {
      memory.delete(key);
    },
    list: async (prefix: string) => [...memory.keys()].filter((key) => key.startsWith(prefix))
  })
}));

import { createProfile, listRuns, saveRun } from "../netlify/functions/_shared/data";

function run(id: string, day: number): RunningRecord {
  const timestamp = `2026-07-${String(day).padStart(2, "0")}T08:00:00.000Z`;
  return {
    id,
    dateTime: timestamp,
    shoeId: null,
    distanceKm: 5,
    durationSec: 1800,
    avgPaceSecPerKm: 360,
    avgPowerW: 200,
    avgCadenceSpm: 170,
    avgHeartRateBpm: 160,
    weather: { temperatureC: null, humidityPct: null, aqi: null },
    notes: "",
    splits: [],
    screenshotKeys: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

beforeEach(() => memory.clear());

describe("concurrent COS-style writes", () => {
  it("keeps both runs when two saves update the same index", async () => {
    await Promise.all([saveRun("runner", run("run-a", 1)), saveRun("runner", run("run-b", 2))]);
    const records = await listRuns("runner");
    expect(records.map((record) => record.id).sort()).toEqual(["run-a", "run-b"]);
  });

  it("allows only one atomic profile creation for a username", async () => {
    const profile: UserProfile = {
      username: "runner",
      passwordHash: "hash",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z"
    };
    const results = await Promise.all([createProfile(profile), createProfile(profile)]);
    expect(results.sort()).toEqual([false, true]);
  });
});
