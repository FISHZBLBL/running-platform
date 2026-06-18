import type { Config } from "@netlify/functions";
import { buildPrediction } from "../../shared/predictions";
import { requireUsername } from "./_shared/auth";
import { listRuns, listWeights } from "./_shared/data";
import { errorResponse, json, methodNotAllowed } from "./_shared/responses";

export default async function predictions(req: Request): Promise<Response> {
  try {
    if (req.method !== "GET") return methodNotAllowed();
    const username = requireUsername(req);
    const url = new URL(req.url);
    const targetDistanceKm = Number(url.searchParams.get("targetDistanceKm") ?? "21.0975");
    const [runs, weights] = await Promise.all([listRuns(username), listWeights(username)]);
    return json({ prediction: buildPrediction(runs, weights, Number.isFinite(targetDistanceKm) ? targetDistanceKm : 21.0975) });
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/predictions"
};
