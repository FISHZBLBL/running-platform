import type { Config } from "@netlify/functions";
import { validateWeightPayload } from "../../shared/validation";
import { requireUsername } from "./_shared/auth";
import { getWeight, listWeights, saveWeight } from "./_shared/data";
import { errorResponse, json, methodNotAllowed, parseJson } from "./_shared/responses";

export default async function weights(req: Request): Promise<Response> {
  try {
    const username = requireUsername(req);
    if (req.method === "GET") {
      return json({ weights: await listWeights(username) });
    }
    if (req.method === "POST") {
      const payload = await parseJson(req);
      const existing = await getWeight(username, (payload as { date?: string }).date ?? "");
      const weight = validateWeightPayload(payload, existing ?? undefined);
      await saveWeight(username, weight);
      return json({ weight }, { status: existing ? 200 : 201 });
    }
    return methodNotAllowed();
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/weights"
};
