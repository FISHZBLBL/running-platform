import type { Config } from "@netlify/functions";
import { validateWeightPayload } from "../../shared/validation";
import { requireUsername } from "./_shared/auth";
import { deleteWeight, listWeights, saveWeight } from "./_shared/data";
import { errorResponse, json, methodNotAllowed, parseJson } from "./_shared/responses";

export default async function weights(req: Request): Promise<Response> {
  try {
    const username = requireUsername(req);
    if (req.method === "GET") {
      return json({ weights: await listWeights(username) });
    }
    if (req.method === "POST") {
      const payload = await parseJson(req);
      const weight = validateWeightPayload(payload);
      const requestedPreviousDate = (payload as { previousDate?: unknown }).previousDate;
      const previousDate = requestedPreviousDate === undefined
        ? undefined
        : validateWeightPayload({ date: requestedPreviousDate, weightKg: weight.weightKg }).date;
      const saved = await saveWeight(username, weight, previousDate);
      return json({ weight: saved }, { status: previousDate === undefined ? 201 : 200 });
    }
    if (req.method === "DELETE") {
      const date = new URL(req.url).searchParams.get("date");
      if (!date) {
        return json({ error: "Weight date is required." }, { status: 400 });
      }
      await deleteWeight(username, date);
      return json({ ok: true });
    }
    return methodNotAllowed();
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/weights"
};
