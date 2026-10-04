import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKey, runsIndexKey, shoeKey, shoesIndexKey, weightKey, weightsIndexKey } from "../shared/cosKeys";
import type { RunningRecord, RunningShoe, WeightRecord } from "../shared/types";
import { validateRunnerProfilePayload } from "../shared/validation";

const state = vi.hoisted(() => ({
  memory: new Map<string, string>(),
  failPut: "", failDelete: "", gateKey: "",
  started: undefined as undefined | (() => void), wait: undefined as undefined | Promise<void>
}));
vi.mock("../netlify/functions/_shared/storage", () => ({ storage: () => ({
  getText: async (key: string) => state.memory.get(key) ?? null,
  putText: async (key: string, value: string) => {
    if (state.failPut === key) { state.failPut = ""; throw new Error("synthetic write failure"); }
    state.memory.set(key, value);
    if (state.gateKey === key) { state.gateKey = ""; state.started?.(); await state.wait; }
  },
  putTextIfAbsent: async (key: string, value: string) => {
    if (state.memory.has(key)) return false;
    state.memory.set(key, value); return true;
  },
  delete: async (key: string) => {
    if (state.failDelete === key) { state.failDelete = ""; throw new Error("synthetic delete failure"); }
    state.memory.delete(key);
  },
  list: async (prefix: string) => [...state.memory.keys()].filter(key => key.startsWith(prefix)),
  getFile: async () => null, putFile: async () => undefined
}) }));
vi.mock("../netlify/functions/_shared/auth", () => ({ requireUsername: () => "runner" }));
import * as data from "../netlify/functions/_shared/data";
import weightsEndpoint from "../netlify/functions/weights";

const timestamp = "2026-10-01T00:00:00.000Z";
const run = (distanceKm = 5): RunningRecord => ({ id: "audit-run", dateTime: timestamp, localDate: "2026-10-01", shoeId: null,
  distanceKm, durationSec: 1800, avgPaceSecPerKm: 360, avgPowerW: 200, avgCadenceSpm: 170, avgHeartRateBpm: 150,
  weather: { temperatureC: null, humidityPct: null, aqi: null }, notes: "", splits: [], screenshotKeys: [], createdAt: timestamp, updatedAt: timestamp });
const shoe: RunningShoe = { id: "audit-shoe", name: "Synthetic shoe", photoKey: null, photoUrl: null, createdAt: timestamp, updatedAt: timestamp };
const weight = (date = "2026-10-01", weightKg = 70): WeightRecord => ({ date, weightKg, createdAt: timestamp, updatedAt: timestamp });

beforeEach(() => { state.memory.clear(); state.failPut = ""; state.failDelete = ""; state.gateKey = ""; state.started = undefined; state.wait = undefined; });
afterEach(() => vi.useRealTimers());

describe("durable record and index recovery", () => {
  const cases = [
    { name: "runs", index: runsIndexKey("runner"), key: runKey("runner", "audit-run"), save: () => data.saveRun("runner", run()), list: () => data.listRuns("runner"), remove: () => data.deleteRun("runner", "audit-run") },
    { name: "shoes", index: shoesIndexKey("runner"), key: shoeKey("runner", "audit-shoe"), save: () => data.saveShoe("runner", shoe), list: () => data.listShoes("runner"), remove: () => data.deleteShoe("runner", "audit-shoe") },
    { name: "weights", index: weightsIndexKey("runner"), key: weightKey("runner", "2026-10-01"), save: () => data.saveWeight("runner", weight()), list: () => data.listWeights("runner"), remove: () => data.deleteWeight("runner", "2026-10-01") }
  ];
  it.each(cases)("recovers a $name creation when index persistence fails", async c => {
    await c.list(); state.failPut = c.index;
    await expect(c.save()).rejects.toThrow("synthetic write failure");
    expect(state.memory.has(c.key)).toBe(true);
    expect(await c.list()).toHaveLength(1);
    expect(await c.list()).toHaveLength(1);
  });
  it.each(cases)("recovers a $name deletion when index persistence fails", async c => {
    await c.save(); state.failPut = c.index;
    await expect(c.remove()).rejects.toThrow("synthetic write failure");
    expect(state.memory.has(c.key)).toBe(false);
    expect(await c.list()).toHaveLength(0);
  });
  it("restores an edit after an index outage, even in a fresh function instance", async () => {
    await data.saveRun("runner", run()); state.failPut = runsIndexKey("runner");
    await expect(data.saveRun("runner", run(6))).rejects.toThrow();
    vi.resetModules();
    const fresh = await import("../netlify/functions/_shared/data");
    expect((await fresh.listRuns("runner"))[0].distanceKm).toBe(6);
    expect((await fresh.getRun("runner", "audit-run"))?.distanceKm).toBe(6);
  });
  it("keeps concurrent edit and delete serialized without restoring a deleted ghost", async () => {
    await data.saveRun("runner", run());
    let release!: () => void;
    const started = new Promise<void>(resolve => { state.started = resolve; });
    state.wait = new Promise<void>(resolve => { release = resolve; });
    state.gateKey = runKey("runner", "audit-run");
    const editing = data.saveRun("runner", run(6));
    await started;
    const deleting = data.deleteRun("runner", "audit-run");
    await new Promise(resolve => setTimeout(resolve, 30));
    release();
    await Promise.all([editing, deleting]);
    expect(await data.getRun("runner", "audit-run")).toBeNull();
    expect(await data.listRuns("runner")).toEqual([]);
  });
  it("repairs legacy indexes that already disagree with their objects", async () => {
    state.memory.set(runsIndexKey("runner"), JSON.stringify([run()]));
    expect(await data.listRuns("runner")).toEqual([]);
    state.memory.clear();
    state.memory.set(runsIndexKey("runner"), "[]");
    state.memory.set(runKey("runner", "audit-run"), JSON.stringify(run()));
    expect(await data.listRuns("runner")).toHaveLength(1);
  });
  it("does not mutate records when persisting the durable intent fails", async () => {
    await data.listRuns("runner");
    state.failPut = `${runsIndexKey("runner")}.pending`;
    await expect(data.saveRun("runner", run())).rejects.toThrow();
    expect(state.memory.has(runKey("runner", "audit-run"))).toBe(false);
    expect(await data.listRuns("runner")).toEqual([]);
  });
  it("replays a committed mutation if clearing its journal fails", async () => {
    await data.listRuns("runner"); state.failDelete = `${runsIndexKey("runner")}.pending`;
    await expect(data.saveRun("runner", run())).rejects.toThrow();
    expect(await data.listRuns("runner")).toHaveLength(1);
    expect(state.memory.has(`${runsIndexKey("runner")}.pending`)).toBe(false);
  });
  it("does not present stale data if the recovery itself is still failing", async () => {
    await data.saveRun("runner", run()); state.failPut = runsIndexKey("runner");
    await expect(data.saveRun("runner", run(6))).rejects.toThrow();
    state.failPut = runsIndexKey("runner");
    await expect(data.listRuns("runner")).rejects.toThrow();
    expect((await data.listRuns("runner"))[0].distanceKm).toBe(6);
  });
  it("does not alter objects when another live function owns the storage lock", async () => {
    vi.useFakeTimers();
    state.memory.set(`${runsIndexKey("runner")}.lock`, JSON.stringify({ owner: "another-function", acquiredAt: Date.now() }));
    const operation = data.saveRun("runner", run());
    const assertion = expect(operation).rejects.toMatchObject({ status: 409 });
    await vi.runAllTimersAsync(); await assertion;
    expect(state.memory.has(runKey("runner", "audit-run"))).toBe(false);
  });
  it("recovers an interrupted writer after its distributed lock expires", async () => {
    await data.listRuns("runner"); state.failPut = runsIndexKey("runner");
    await expect(data.saveRun("runner", run())).rejects.toThrow();
    vi.useFakeTimers();
    state.memory.set(`${runsIndexKey("runner")}.lock`, JSON.stringify({ owner: "terminated-function", acquiredAt: Date.now() - 100_000 }));
    const recovering = data.listRuns("runner");
    await vi.runAllTimersAsync(); expect(await recovering).toHaveLength(1);
  });
  it("recovers interrupted shoe unlinking before a deletion retry", async () => {
    await data.saveShoe("runner", shoe);
    await data.saveRun("runner", { ...run(), shoeId: shoe.id });
    state.failPut = runsIndexKey("runner");
    await expect(data.deleteShoe("runner", shoe.id)).rejects.toThrow();
    expect((await data.listRuns("runner"))[0].shoeId).toBeNull();
    await data.deleteShoe("runner", shoe.id);
    expect(await data.getShoe("runner", shoe.id)).toBeNull();
  });
  it("merges concurrent runner profile changes under the shared storage lock", async () => {
    await data.saveRunnerProfile("runner", validateRunnerProfilePayload({}));
    await Promise.all([
      data.updateRunnerProfile("runner", existing => ({ ...existing!, heightCm: 175 })),
      data.updateRunnerProfile("runner", existing => ({ ...existing!, restingHeartRateBpm: 55 }))
    ]);
    expect(await data.getRunnerProfile("runner")).toMatchObject({ heightCm: 175, restingHeartRateBpm: 55 });
  });
});

describe("weight date changes", () => {
  it("rejects a duplicate creation and a date change onto an existing date", async () => {
    await data.saveWeight("runner", weight());
    await expect(data.saveWeight("runner", weight("2026-10-01", 80))).rejects.toMatchObject({ status: 409 });
    await data.saveWeight("runner", weight("2026-10-02", 71));
    await expect(data.saveWeight("runner", weight("2026-10-02", 80), "2026-10-01")).rejects.toMatchObject({ status: 409 });
    expect((await data.listWeights("runner")).map(w => w.weightKg).sort()).toEqual([70, 71]);
  });
  it("moves the record and preserves its original creation date", async () => {
    await data.saveWeight("runner", weight());
    const moved = await data.saveWeight("runner", { ...weight("2026-10-02", 72), createdAt: "2026-10-03T00:00:00.000Z" }, "2026-10-01");
    expect(moved.createdAt).toBe(timestamp);
    expect(await data.getWeight("runner", "2026-10-01")).toBeNull();
    expect((await data.listWeights("runner")).map(w => w.date)).toEqual(["2026-10-02"]);
  });
  it("requires an existing source for explicit edits", async () => {
    await expect(data.saveWeight("runner", weight(), "2026-10-01")).rejects.toMatchObject({ status: 404 });
    await data.saveWeight("runner", weight());
    await data.saveWeight("runner", weight("2026-10-01", 72), "2026-10-01");
    expect((await data.getWeight("runner", "2026-10-01"))?.weightKg).toBe(72);
  });
  it.each(["destination-write", "source-delete", "index-write"])("recovers a date move after a %s failure", async stage => {
    await data.saveWeight("runner", weight());
    if (stage === "destination-write") state.failPut = weightKey("runner", "2026-10-02");
    if (stage === "source-delete") state.failDelete = weightKey("runner", "2026-10-01");
    if (stage === "index-write") state.failPut = weightsIndexKey("runner");
    await expect(data.saveWeight("runner", weight("2026-10-02", 72), "2026-10-01")).rejects.toThrow();
    vi.resetModules(); const fresh = await import("../netlify/functions/_shared/data");
    expect((await fresh.listWeights("runner")).map(w => [w.date, w.weightKg])).toEqual([["2026-10-02", 72]]);
    expect(await fresh.getWeight("runner", "2026-10-01")).toBeNull();
  });
  it("allows only one concurrent creation of a weight date", async () => {
    const outcomes = await Promise.allSettled([data.saveWeight("runner", weight()), data.saveWeight("runner", weight("2026-10-01", 80))]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    expect(await data.listWeights("runner")).toHaveLength(1);
  });
  it("checks collisions through the POST endpoint without overwriting", async () => {
    const post = (body: unknown) => weightsEndpoint(new Request("http://audit.invalid/api/weights", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    expect((await post({ date: "2026-10-01", weightKg: 70 })).status).toBe(201);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await post({ date: "2026-10-01", weightKg: 80 })).status).toBe(409);
      expect((await post({ date: "2026-10-02", previousDate: "../../profile", weightKg: 70 })).status).toBe(400);
      const moved = await post({ date: "2026-10-02", previousDate: "2026-10-01", weightKg: 72 });
      expect(moved.status).toBe(200);
      expect((await moved.json()).weight.weightKg).toBe(72);
      expect((await data.listWeights("runner")).map(w => w.date)).toEqual(["2026-10-02"]);
    } finally { errorLog.mockRestore(); }
  });
});
