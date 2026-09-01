import type { Config } from "@netlify/functions";
import type { AiPredictionSnapshot, RunnerProfile, RunningRecord, WeightRecord } from "../../shared/types";
import {
  aiDataFingerprint,
  buildPlanningContext,
  deepAnalysisFingerprint,
  generateDeepAnalysis,
  hasCurrentStructuredTrainingPlan,
  generateStandardAnalysis,
  hydrateCachedDeepAnalysis,
  predictionTargetHash,
  type AiPredictionTarget
} from "./_shared/aiPrediction";
import { getEnv } from "./_shared/env";
import { requireAiUsername } from "./_shared/session";
import {
  getAiDeepAnalysis,
  getAiPrediction,
  getDeepseekCustomPrompt,
  getDeepseekSecret,
  getRunnerProfile,
  listRuns,
  listWeights,
  saveAiDeepAnalysis,
  saveAiPrediction,
  withAiPredictionLock
} from "./_shared/data";
import { decryptDeepseekApiKey } from "./_shared/secrets";
import {
  errorResponse,
  json,
  methodNotAllowed,
  parseJson,
  requireJsonRequest,
  requireSameOrigin
} from "./_shared/responses";

function optionalPositiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    const error = new Error("目标完赛时间格式无效。");
    (error as Error & { status: number }).status = 400;
    throw error;
  }
  return number;
}

function parseTarget(payload: Record<string, unknown>): AiPredictionTarget {
  const targetDistanceKm = Number(payload.targetDistanceKm);
  if (!Number.isFinite(targetDistanceKm) || targetDistanceKm <= 0 || targetDistanceKm > 200) {
    const error = new Error("目标距离需要在 0 到 200 km 之间。");
    (error as Error & { status: number }).status = 400;
    throw error;
  }
  const targetDate = typeof payload.targetDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.targetDate)
    ? payload.targetDate
    : null;
  return { targetDistanceKm, targetFinishSec: optionalPositiveNumber(payload.targetFinishSec), targetDate };
}

export default async function aiPrediction(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return methodNotAllowed();
    requireSameOrigin(req);
    requireJsonRequest(req);
    const username = requireAiUsername(req);
    const payload = await parseJson(req) as Record<string, unknown>;
    const kind = payload.kind === "deep" ? "deep" : payload.kind === "current" ? "current" : "standard";
    const forceDeep = kind === "deep" && payload.force === true;
    const target = parseTarget(payload);
    const localData = getEnv("NETLIFY_DEV") === "true" && payload.localPreviewData && typeof payload.localPreviewData === "object"
      ? payload.localPreviewData as { runs?: unknown; weights?: unknown; profile?: unknown }
      : null;
    const [runs, weights, profile, secret, customPrompt] = await Promise.all([
      localData && Array.isArray(localData.runs) ? Promise.resolve(localData.runs) : listRuns(username),
      localData && Array.isArray(localData.weights) ? Promise.resolve(localData.weights) : listWeights(username),
      localData ? Promise.resolve(localData.profile ?? null) : getRunnerProfile(username),
      getDeepseekSecret(username),
      getDeepseekCustomPrompt(username)
    ]) as [RunningRecord[], WeightRecord[], RunnerProfile | null, Awaited<ReturnType<typeof getDeepseekSecret>>, string];
    if (!secret) {
      const error = new Error("请先在个人资料中配置 DeepSeek API Key。");
      (error as Error & { status: number }).status = 409;
      throw error;
    }
    const targetHash = predictionTargetHash(target);
    const fingerprint = aiDataFingerprint(runs, weights, profile, target, secret.updatedAt, customPrompt);
    return await withAiPredictionLock(username, targetHash, async () => {
      const cachedStandard = await getAiPrediction(username, targetHash);
      if (kind === "standard" && cachedStandard?.dataFingerprint === fingerprint) {
        return json({ analysis: { ...cachedStandard, cached: true } });
      }

      if (kind === "current" && cachedStandard?.dataFingerprint === fingerprint) {
        const standard = { ...cachedStandard, cached: true };
        const cachedDeep = await getAiDeepAnalysis(username, targetHash);
        const deepFingerprint = deepAnalysisFingerprint(fingerprint, customPrompt);
        const cacheMatches = cachedDeep && (
          cachedDeep.dataFingerprint === deepFingerprint ||
          (customPrompt === "" && cachedDeep.dataFingerprint === fingerprint)
        );
        if (cacheMatches && hasCurrentStructuredTrainingPlan(cachedDeep, target)) {
          const hydrated = hydrateCachedDeepAnalysis(cachedDeep, standard, deepFingerprint);
          if (cachedDeep.dataFingerprint !== deepFingerprint || cachedDeep.flashPredictionSec === undefined) {
            await saveAiDeepAnalysis(username, targetHash, hydrated);
          }
          return json({ analysis: hydrated, standard, proCacheStatus: "restored" });
        }
        // No matching unified cache: reuse the local/Flash baseline below and create one complete analysis.
      }

      const apiKey = decryptDeepseekApiKey(username, secret);
      let standard = cachedStandard?.dataFingerprint === fingerprint ? cachedStandard : null;
      if (!standard) {
        const generated = await generateStandardAnalysis(apiKey, runs, weights, profile, target, fingerprint, customPrompt);
        standard = generated.analysis;
        const snapshot: AiPredictionSnapshot = {
          generatedAt: standard.generatedAt,
          dataFingerprint: fingerprint,
          targetDistanceKm: target.targetDistanceKm,
          targetFinishSec: target.targetFinishSec,
          targetDate: target.targetDate,
          algorithmPredictionSec: standard.algorithmPredictionSec,
          aiPredictionSec: standard.aiPredictionSec,
          adjustmentPercent: standard.appliedAdjustmentPercent,
          confidenceScore: generated.prediction.smartPrediction?.confidenceScore ?? 0,
          model: standard.model
        };
        await saveAiPrediction(username, targetHash, standard, snapshot);
      }
      if (kind === "standard") {
        return json({
          analysis: standard,
        });
      }

      const cachedDeep = await getAiDeepAnalysis(username, targetHash);
      const deepFingerprint = deepAnalysisFingerprint(fingerprint, customPrompt);
      const reusableDeep = !forceDeep && cachedDeep && (
        cachedDeep.dataFingerprint === deepFingerprint ||
        (customPrompt === "" && cachedDeep.dataFingerprint === fingerprint)
      ) && hasCurrentStructuredTrainingPlan(cachedDeep, target);
      if (reusableDeep) {
        const hydrated = hydrateCachedDeepAnalysis(cachedDeep, standard, deepFingerprint);
        if (cachedDeep.dataFingerprint !== deepFingerprint || cachedDeep.flashPredictionSec === undefined) {
          await saveAiDeepAnalysis(username, targetHash, hydrated);
        }
        return json({ analysis: hydrated, standard });
      }
      const deep = await generateDeepAnalysis(apiKey, runs, weights, profile, target, standard, deepFingerprint, customPrompt);
      await saveAiDeepAnalysis(username, targetHash, deep);
      return json({ analysis: deep, standard });
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/ai-prediction"
};
