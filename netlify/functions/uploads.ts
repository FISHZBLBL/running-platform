import type { Config } from "@netlify/functions";
import { screenshotKey } from "../../shared/cosKeys";
import { requireUsername } from "./_shared/auth";
import { errorResponse, json, methodNotAllowed } from "./_shared/responses";
import { storage } from "./_shared/storage";

function extensionFromName(name: string): string {
  const match = name.match(/\.([a-zA-Z0-9]+)$/);
  return match?.[1] ?? "png";
}

export default async function uploads(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return methodNotAllowed();
    const username = requireUsername(req);
    const form = await req.formData();
    const runId = String(form.get("runId") ?? "");
    if (!runId) {
      return json({ error: "runId is required before uploading screenshots." }, { status: 400 });
    }
    const files = form.getAll("screenshots").filter((value): value is File => value instanceof File);
    if (files.length === 0) {
      return json({ error: "At least one screenshot is required." }, { status: 400 });
    }
    const keys: string[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        return json({ error: "Only image files are accepted." }, { status: 400 });
      }
      const key = screenshotKey(username, runId, crypto.randomUUID(), extensionFromName(file.name));
      await storage().putFile(key, {
        body: Buffer.from(await file.arrayBuffer()),
        contentType: file.type || "application/octet-stream"
      });
      keys.push(key);
    }
    return json({ keys }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/uploads"
};
