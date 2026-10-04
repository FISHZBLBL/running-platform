import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import type { RunnerProfile, WeightRecord } from "../shared/types";

const stateKey = "running-platform-local-preview";
const contents = new Map<string, string>();
const stamp = "2026-10-01T00:00:00.000Z";
const profile: RunnerProfile = {
  birthDate: "1990-01-02", sex: "male", heightCm: 175,
  restingHeartRateBpm: 55, measuredMaxHeartRateBpm: 190,
  predictionTarget: null, createdAt: stamp, updatedAt: stamp
};
const weight = (date: string, weightKg: number): WeightRecord => ({ date, weightKg, createdAt: stamp, updatedAt: stamp });

function seed(weights: WeightRecord[] = []) {
  contents.set(stateKey, JSON.stringify({
    sessionUsername: "runner", localSeedVersion: null, users: [],
    runsByUser: { runner: [] }, shoesByUser: { runner: [] },
    weightsByUser: { runner: weights }, runnerProfilesByUser: { runner: profile }
  }));
}

beforeEach(() => {
  contents.clear();
  vi.stubGlobal("window", { location: { hostname: "localhost", origin: "http://localhost:5173" } });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => contents.get(key) ?? null,
    setItem: (key: string, value: string) => contents.set(key, value)
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("local preview mutation semantics", () => {
  it("updates only the prediction target without erasing personal fields", async () => {
    seed();
    const target = { mode: "date-finish" as const, targetDistanceKm: 10, targetFinishSec: null, targetDate: "2027-01-01" };
    const saved = await api.savePredictionTarget(target);
    expect(saved.profile).toMatchObject({ ...profile, updatedAt: expect.any(String), predictionTarget: target });
    expect((await api.getRunnerProfile()).profile).toEqual(saved.profile);
  });

  it("rejects new entries and moves that collide with an existing date without changing either record", async () => {
    seed([weight("2026-10-01", 72), weight("2026-10-02", 71)]);
    const before = contents.get(stateKey);
    await expect(api.saveWeight({ date: "2026-10-02", weightKg: 73 })).rejects.toThrow("已有体重记录");
    await expect(api.saveWeight({ date: "2026-10-02", weightKg: 73, previousDate: "2026-10-01" })).rejects.toThrow("已有体重记录");
    expect(contents.get(stateKey)).toBe(before);
  });

  it("moves a weight in one local storage write and retains its creation date", async () => {
    seed([weight("2026-10-01", 72)]);
    const saved = await api.saveWeight({ date: "2026-10-03", weightKg: 73, previousDate: "2026-10-01" });
    expect(saved.weight).toMatchObject({ date: "2026-10-03", weightKg: 73, createdAt: stamp });
    expect((await api.listWeights()).weights).toEqual([saved.weight]);
  });

  it("allows an explicit edit on the same day and rejects editing a missing source", async () => {
    seed([weight("2026-10-01", 72)]);
    await api.saveWeight({ date: "2026-10-01", weightKg: 73, previousDate: "2026-10-01" });
    expect((await api.listWeights()).weights[0].weightKg).toBe(73);
    await expect(api.saveWeight({ date: "2026-10-03", weightKg: 70, previousDate: "2026-10-02" })).rejects.toThrow("不存在");
  });

  it("rejects impossible dates in the actual local request path", async () => {
    seed();
    await expect(api.saveWeight({ date: "2026-02-30", weightKg: 70 })).rejects.toThrow();
    expect((await api.listWeights()).weights).toEqual([]);
  });
});
