import type { Config } from "@netlify/functions";
import { validateRunPayload } from "../../shared/validation";
import { requireUsername } from "./_shared/auth";
import { deleteRun, getRun, saveRun } from "./_shared/data";
import { errorResponse, json, methodNotAllowed, parseJson } from "./_shared/responses";

export default async function runById(req: Request, context: { params?: { id?: string } }): Promise<Response> {
  try {
    const username = requireUsername(req);
    const runId = context.params?.id;
    if (!runId) {
      return json({ error: "Run id is required." }, { status: 400 });
    }
    if (req.method === "GET") {
      const run = await getRun(username, runId);
      return run ? json({ run }) : json({ error: "Run not found." }, { status: 404 });
    }
    if (req.method === "PUT") {
      const existing = await getRun(username, runId);
      const body = await parseJson(req);
      const payload = typeof body === "object" && body !== null ? body : {};
      const run = validateRunPayload({ ...payload, id: runId }, existing ?? undefined);
      await saveRun(username, run);
      return json({ run });
    }
    if (req.method === "DELETE") {
      await deleteRun(username, runId);
      return json({ ok: true });
    }
    return methodNotAllowed();
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/runs/:id"
};
