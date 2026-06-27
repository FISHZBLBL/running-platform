import type { Config } from "@netlify/functions";
import { validateShoePayload } from "../../shared/validation";
import { requireUsername } from "./_shared/auth";
import { listShoes, saveShoe } from "./_shared/data";
import { errorResponse, json, methodNotAllowed, parseJson } from "./_shared/responses";

export default async function shoes(req: Request): Promise<Response> {
  try {
    const username = requireUsername(req);
    if (req.method === "GET") {
      return json({ shoes: await listShoes(username) });
    }
    if (req.method === "POST") {
      const shoe = validateShoePayload(await parseJson(req));
      await saveShoe(username, shoe);
      return json({ shoe }, { status: 201 });
    }
    return methodNotAllowed();
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/shoes"
};
