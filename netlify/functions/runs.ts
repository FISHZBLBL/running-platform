import type { Config } from "@netlify/functions";
import { validateRunPayload } from "../../shared/validation";
import { requireUsername } from "./_shared/auth";
import { listRuns, saveRun } from "./_shared/data";
import { errorResponse, json, methodNotAllowed, parseJson } from "./_shared/responses";

export default async function runs(req: Request): Promise<Response> {
  try {
    const username = requireUsername(req);
    if (req.method === "GET") {
      return json({ runs: await listRuns(username) });
    }
    if (req.method === "POST") {
      const run = validateRunPayload(await parseJson(req));
      await saveRun(username, run);
      return json({ run }, { status: 201 });
    }
    return methodNotAllowed();
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/runs"
};
