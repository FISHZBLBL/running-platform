import { randomUUID } from "node:crypto";
import {
  keepKey,
  aiDeepAnalysisKey,
  aiPredictionHistoryKey,
  aiPredictionLatestKey,
  deepseekSecretKey,
  deepseekPreferencesKey,
  profileKey,
  runnerProfileKey,
  runKey,
  runsIndexKey,
  runsPrefix,
  shoeKey,
  shoesIndexKey,
  shoesPrefix,
  weightKey,
  weightsIndexKey,
  weightsPrefix
} from "../../../shared/cosKeys";
import type {
  AiDeepAnalysis,
  AiPredictionAnalysis,
  AiPredictionSnapshot,
  RunnerProfile,
  RunningRecord,
  RunningShoe,
  UserProfile,
  WeightRecord
} from "../../../shared/types";
import { storage } from "./storage";
import type { EncryptedSecret } from "./secrets";

const INDEX_LOCK_STALE_MS = 90_000;
const INDEX_LOCK_ATTEMPTS = 20;

type LockOptions = {
  attempts?: number;
  staleMs?: number;
  heartbeatMs?: number;
};

type LockRecord = {
  owner: string;
  acquiredAt: number;
};

async function readJson<T>(key: string): Promise<T | null> {
  const text = await storage().getText(key);
  return text ? (JSON.parse(text) as T) : null;
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await storage().putText(key, JSON.stringify(value, null, 2));
}

function sortRuns(records: RunningRecord[]): RunningRecord[] {
  return [...records].sort((a, b) => new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime());
}

function sortShoes(records: RunningShoe[]): RunningShoe[] {
  return [...records].sort((a, b) => a.name.localeCompare(b.name));
}

function sortWeights(records: WeightRecord[]): WeightRecord[] {
  return [...records].sort((a, b) => b.date.localeCompare(a.date));
}

async function readListIndex<T>(key: string): Promise<T[] | null> {
  const index = await readJson<unknown>(key);
  return Array.isArray(index) ? (index as T[]) : null;
}

function parseLock(value: string | null): LockRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LockRecord>;
    return typeof parsed.owner === "string" && typeof parsed.acquiredAt === "number"
      ? { owner: parsed.owner, acquiredAt: parsed.acquiredAt }
      : null;
  } catch {
    return null;
  }
}

async function releaseLock(lockKey: string, owner: string): Promise<void> {
  const current = parseLock(await storage().getText(lockKey));
  if (current?.owner === owner) {
    await storage().delete(lockKey);
  }
}

async function withIndexLock<T>(indexKey: string, task: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const lockKey = `${indexKey}.lock`;
  const owner = randomUUID();
  const attempts = options.attempts ?? INDEX_LOCK_ATTEMPTS;
  const staleMs = options.staleMs ?? INDEX_LOCK_STALE_MS;
  const heartbeatMs = options.heartbeatMs;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lock: LockRecord = { owner, acquiredAt: Date.now() };
    if (await storage().putTextIfAbsent(lockKey, JSON.stringify(lock))) {
      const heartbeatKey = `${lockKey}.heartbeat.${owner}`;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      if (heartbeatMs) {
        const heartbeat = async () => storage().putText(heartbeatKey, String(Date.now()));
        await heartbeat();
        heartbeatTimer = setInterval(() => {
          void heartbeat().catch((error) => {
            console.error("[index-lock-heartbeat-error]", { lockKey, owner, error });
          });
        }, heartbeatMs);
      }
      try {
        return await task();
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        await releaseLock(lockKey, owner).catch((error) => {
          console.error("[index-lock-release-error]", { lockKey, owner, error });
        });
        if (heartbeatMs) {
          await storage().delete(heartbeatKey).catch((error) => {
            console.error("[index-lock-heartbeat-cleanup-error]", { lockKey, owner, error });
          });
        }
      }
    }

    const firstText = await storage().getText(lockKey);
    const existing = parseLock(firstText);
    let lastSeenAt = existing?.acquiredAt ?? 0;
    if (existing && heartbeatMs) {
      const heartbeatText = await storage().getText(`${lockKey}.heartbeat.${existing.owner}`);
      const heartbeatAt = Number(heartbeatText);
      if (Number.isFinite(heartbeatAt)) lastSeenAt = Math.max(lastSeenAt, heartbeatAt);
    }
    if (!existing || Date.now() - lastSeenAt > staleMs) {
      const confirmedText = await storage().getText(lockKey);
      if (confirmedText === firstText) {
        await storage().delete(lockKey);
        if (existing && heartbeatMs) {
          await storage().delete(`${lockKey}.heartbeat.${existing.owner}`);
        }
      }
    }
    await delay(100 + Math.floor(Math.random() * 150));
  }

  const error = new Error("数据正在被另一个设备或标签页更新，请稍后重试。");
  (error as Error & { status: number }).status = 409;
  throw error;
}

async function readRunsFromObjects(username: string): Promise<RunningRecord[]> {
  const keys = (await storage().list(runsPrefix(username))).filter((key) => key.endsWith(".json"));
  const records = await Promise.all(keys.map((key) => readJson<RunningRecord>(key)));
  return sortRuns(records.filter((record): record is RunningRecord => Boolean(record)));
}

async function readShoesFromObjects(username: string): Promise<RunningShoe[]> {
  const keys = (await storage().list(shoesPrefix(username))).filter((key) => key.endsWith(".json"));
  const records = await Promise.all(keys.map((key) => readJson<RunningShoe>(key)));
  return sortShoes(records.filter((record): record is RunningShoe => Boolean(record)));
}

async function readWeightsFromObjects(username: string): Promise<WeightRecord[]> {
  const keys = (await storage().list(weightsPrefix(username))).filter((key) => key.endsWith(".json"));
  const records = await Promise.all(keys.map((key) => readJson<WeightRecord>(key)));
  return sortWeights(records.filter((record): record is WeightRecord => Boolean(record)));
}

export async function getProfile(username: string): Promise<UserProfile | null> {
  return readJson<UserProfile>(profileKey(username));
}

export async function createProfile(profile: UserProfile): Promise<boolean> {
  const created = await storage().putTextIfAbsent(profileKey(profile.username), JSON.stringify(profile, null, 2));
  if (created) {
    await storage().putText(keepKey(profile.username), "").catch((error) => {
      console.error("[profile-marker-error]", error);
    });
  }
  return created;
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  await writeJson(profileKey(profile.username), profile);
  await storage().putText(keepKey(profile.username), "");
}

export async function getRunnerProfile(username: string): Promise<RunnerProfile | null> {
  return readJson<RunnerProfile>(runnerProfileKey(username));
}

export async function saveRunnerProfile(username: string, profile: RunnerProfile): Promise<void> {
  await writeJson(runnerProfileKey(username), profile);
}

export async function getDeepseekSecret(username: string): Promise<EncryptedSecret | null> {
  return readJson<EncryptedSecret>(deepseekSecretKey(username));
}

export async function saveDeepseekSecret(username: string, secret: EncryptedSecret): Promise<void> {
  await writeJson(deepseekSecretKey(username), secret);
}

export async function deleteDeepseekSecret(username: string): Promise<void> {
  await storage().delete(deepseekSecretKey(username));
}

export async function getDeepseekCustomPrompt(username: string): Promise<string> {
  const preferences = await readJson<{ customPrompt?: unknown }>(deepseekPreferencesKey(username));
  return typeof preferences?.customPrompt === "string" ? preferences.customPrompt : "";
}

export async function saveDeepseekCustomPrompt(username: string, customPrompt: string): Promise<void> {
  await writeJson(deepseekPreferencesKey(username), {
    customPrompt,
    updatedAt: new Date().toISOString()
  });
}

export async function getAiPrediction(username: string, targetHash: string): Promise<AiPredictionAnalysis | null> {
  return readJson<AiPredictionAnalysis>(aiPredictionLatestKey(username, targetHash));
}

export async function saveAiPrediction(
  username: string,
  targetHash: string,
  analysis: AiPredictionAnalysis,
  snapshot: AiPredictionSnapshot
): Promise<void> {
  const historyKey = aiPredictionHistoryKey(username, targetHash);
  const history = (await readJson<AiPredictionSnapshot[]>(historyKey)) ?? [];
  const compactHistory = [snapshot, ...history.filter((item) => item.dataFingerprint !== snapshot.dataFingerprint)].slice(0, 50);
  await Promise.all([
    writeJson(aiPredictionLatestKey(username, targetHash), analysis),
    writeJson(historyKey, compactHistory)
  ]);
}

export async function getAiDeepAnalysis(username: string, targetHash: string): Promise<AiDeepAnalysis | null> {
  return readJson<AiDeepAnalysis>(aiDeepAnalysisKey(username, targetHash));
}

export async function saveAiDeepAnalysis(username: string, targetHash: string, analysis: AiDeepAnalysis): Promise<void> {
  await writeJson(aiDeepAnalysisKey(username, targetHash), analysis);
}

export async function withAiPredictionLock<T>(username: string, targetHash: string, task: () => Promise<T>): Promise<T> {
  return withIndexLock(`${aiPredictionLatestKey(username, targetHash)}.generation`, task, {
    attempts: 80,
    staleMs: 10_000,
    heartbeatMs: 2_000
  });
}

export async function listRuns(username: string): Promise<RunningRecord[]> {
  const indexed = await readListIndex<RunningRecord>(runsIndexKey(username));
  if (indexed) return sortRuns(indexed);

  return withIndexLock(runsIndexKey(username), async () => {
    const current = await readListIndex<RunningRecord>(runsIndexKey(username));
    if (current) return sortRuns(current);
    const records = await readRunsFromObjects(username);
    await writeJson(runsIndexKey(username), records);
    return records;
  });
}

export async function getRun(username: string, runId: string): Promise<RunningRecord | null> {
  return readJson<RunningRecord>(runKey(username, runId));
}

export async function saveRun(username: string, run: RunningRecord): Promise<void> {
  await writeJson(runKey(username, run.id), run);
  await withIndexLock(runsIndexKey(username), async () => {
    const persisted = (await getRun(username, run.id)) ?? run;
    const records = (await readListIndex<RunningRecord>(runsIndexKey(username))) ?? (await readRunsFromObjects(username));
    await writeJson(runsIndexKey(username), sortRuns([persisted, ...records.filter((record) => record.id !== run.id)]));
  });
}

export async function deleteRun(username: string, runId: string): Promise<void> {
  await storage().delete(runKey(username, runId));
  await withIndexLock(runsIndexKey(username), async () => {
    const records = (await readListIndex<RunningRecord>(runsIndexKey(username))) ?? (await readRunsFromObjects(username));
    await writeJson(runsIndexKey(username), sortRuns(records.filter((record) => record.id !== runId)));
  });
}

export async function listShoes(username: string): Promise<RunningShoe[]> {
  const indexed = await readListIndex<RunningShoe>(shoesIndexKey(username));
  if (indexed) return sortShoes(indexed);

  return withIndexLock(shoesIndexKey(username), async () => {
    const current = await readListIndex<RunningShoe>(shoesIndexKey(username));
    if (current) return sortShoes(current);
    const records = await readShoesFromObjects(username);
    await writeJson(shoesIndexKey(username), records);
    return records;
  });
}

export async function getShoe(username: string, shoeId: string): Promise<RunningShoe | null> {
  return readJson<RunningShoe>(shoeKey(username, shoeId));
}

export async function saveShoe(username: string, shoe: RunningShoe): Promise<void> {
  await writeJson(shoeKey(username, shoe.id), shoe);
  await withIndexLock(shoesIndexKey(username), async () => {
    const persisted = (await getShoe(username, shoe.id)) ?? shoe;
    const records = (await readListIndex<RunningShoe>(shoesIndexKey(username))) ?? (await readShoesFromObjects(username));
    await writeJson(shoesIndexKey(username), sortShoes([persisted, ...records.filter((record) => record.id !== shoe.id)]));
  });
}

export async function deleteShoe(username: string, shoeId: string): Promise<void> {
  await storage().delete(shoeKey(username, shoeId));
  await withIndexLock(shoesIndexKey(username), async () => {
    const records = (await readListIndex<RunningShoe>(shoesIndexKey(username))) ?? (await readShoesFromObjects(username));
    await writeJson(shoesIndexKey(username), sortShoes(records.filter((record) => record.id !== shoeId)));
  });

  await withIndexLock(runsIndexKey(username), async () => {
    const runs = (await readListIndex<RunningRecord>(runsIndexKey(username))) ?? (await readRunsFromObjects(username));
    const now = new Date().toISOString();
    const updatedRuns = runs.map((run) => (run.shoeId === shoeId ? { ...run, shoeId: null, updatedAt: now } : run));
    const changedRuns = updatedRuns.filter((run, index) => run !== runs[index]);
    await Promise.all(changedRuns.map((run) => writeJson(runKey(username, run.id), run)));
    if (changedRuns.length > 0) {
      await writeJson(runsIndexKey(username), sortRuns(updatedRuns));
    }
  });
}

export async function listWeights(username: string): Promise<WeightRecord[]> {
  const indexed = await readListIndex<WeightRecord>(weightsIndexKey(username));
  if (indexed) return sortWeights(indexed);

  return withIndexLock(weightsIndexKey(username), async () => {
    const current = await readListIndex<WeightRecord>(weightsIndexKey(username));
    if (current) return sortWeights(current);
    const records = await readWeightsFromObjects(username);
    await writeJson(weightsIndexKey(username), records);
    return records;
  });
}

export async function getWeight(username: string, date: string): Promise<WeightRecord | null> {
  return readJson<WeightRecord>(weightKey(username, date));
}

export async function saveWeight(username: string, weight: WeightRecord): Promise<void> {
  await writeJson(weightKey(username, weight.date), weight);
  await withIndexLock(weightsIndexKey(username), async () => {
    const persisted = (await getWeight(username, weight.date)) ?? weight;
    const records = (await readListIndex<WeightRecord>(weightsIndexKey(username))) ?? (await readWeightsFromObjects(username));
    await writeJson(weightsIndexKey(username), sortWeights([persisted, ...records.filter((record) => record.date !== weight.date)]));
  });
}

export async function deleteWeight(username: string, date: string): Promise<void> {
  await storage().delete(weightKey(username, date));
  await withIndexLock(weightsIndexKey(username), async () => {
    const records = (await readListIndex<WeightRecord>(weightsIndexKey(username))) ?? (await readWeightsFromObjects(username));
    await writeJson(weightsIndexKey(username), sortWeights(records.filter((record) => record.date !== date)));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
