import type { Config } from "@netlify/functions";
import { validatePredictionTargetPatch, validateRunnerProfilePayload } from "../../shared/validation";
import { requireUsername } from "./_shared/auth";
import { getRunnerProfile, updateRunnerProfile } from "./_shared/data";
import { errorResponse, json, methodNotAllowed, parseJson } from "./_shared/responses";

export default async function runnerProfile(req: Request): Promise<Response> {
  try {
    const username = requireUsername(req);
    if (req.method === "GET") {
      return json({ profile: await getRunnerProfile(username) });
    }
    if (req.method === "PUT") {
      const payload = await parseJson(req);
      const profile = await updateRunnerProfile(username, (existing) =>
        validateRunnerProfilePayload(payload, existing ?? undefined)
      );
      return json({ profile });
    }
    if (req.method === "PATCH") {
      const payload = await parseJson(req);
      const profile = await updateRunnerProfile(username, (existing) =>
        validatePredictionTargetPatch(payload, existing ?? undefined)
      );
      return json({ profile });
    }
    return methodNotAllowed();
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/runner-profile"
};
