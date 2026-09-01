import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiPredictionLatestKey } from "../shared/cosKeys";
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

import { createProfile, listRuns, saveRun, withAiPredictionLock } from "../netlify/functions/_shared/data";

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

afterEach(() => vi.useRealTimers());

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

  it("recovers quickly from an AI generation lock left by a terminated function", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T10:00:00.000Z"));
    const lockKey = `${aiPredictionLatestKey("runner", "target")}.generation.lock`;
    memory.set(lockKey, JSON.stringify({
      owner: "terminated-function",
      acquiredAt: Date.now() - 15_000
    }));

    const result = withAiPredictionLock("runner", "target", async () => "recovered");
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("recovered");
  });

  it("does not steal a live AI generation lock while its heartbeat is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T10:00:00.000Z"));
    let finishFirst: (() => void) | undefined;
    let secondStarted = false;
    const first = withAiPredictionLock("runner", "target", () => new Promise<string>((resolve) => {
      finishFirst = () => resolve("first");
    }));
    await vi.advanceTimersByTimeAsync(95_000);

    const second = withAiPredictionLock("runner", "target", async () => {
      secondStarted = true;
      return "second";
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(secondStarted).toBe(false);

    finishFirst?.();
    await vi.runAllTimersAsync();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
  });
});
