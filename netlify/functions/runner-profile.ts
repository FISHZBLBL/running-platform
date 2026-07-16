import type { Config } from "@netlify/functions";
import { validateRunnerProfilePayload } from "../../shared/validation";
import { requireUsername } from "./_shared/auth";
import { getRunnerProfile, saveRunnerProfile } from "./_shared/data";
import { errorResponse, json, methodNotAllowed, parseJson } from "./_shared/responses";

export default async function runnerProfile(req: Request): Promise<Response> {
  try {
    const username = requireUsername(req);
    if (req.method === "GET") {
      return json({ profile: await getRunnerProfile(username) });
    }
    if (req.method === "PUT") {
      const existing = await getRunnerProfile(username);
      const profile = validateRunnerProfilePayload(await parseJson(req), existing ?? undefined);
      await saveRunnerProfile(username, profile);
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
