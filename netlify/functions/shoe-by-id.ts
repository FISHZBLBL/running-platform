import type { Config } from "@netlify/functions";
import { validateShoePayload } from "../../shared/validation";
import { requireUsername } from "./_shared/auth";
import { deleteShoe, saveShoe } from "./_shared/data";
import { errorResponse, json, methodNotAllowed, parseJson } from "./_shared/responses";

export default async function shoeById(req: Request, context: { params?: { id?: string } }): Promise<Response> {
  try {
    const username = requireUsername(req);
    const shoeId = context.params?.id;
    if (!shoeId) {
      return json({ error: "Shoe id is required." }, { status: 400 });
    }
    if (req.method === "PUT") {
      const body = await parseJson(req);
      const payload = typeof body === "object" && body !== null ? body : {};
      const shoe = validateShoePayload({ ...payload, id: shoeId });
      await saveShoe(username, shoe);
      return json({ shoe });
    }
    if (req.method === "DELETE") {
      await deleteShoe(username, shoeId);
      return json({ ok: true });
    }
    return methodNotAllowed();
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/shoes/:id"
};
