import type { Config } from "@netlify/functions";
import { shoePhotoKey } from "../../shared/cosKeys";
import { getEnv } from "./_shared/env";
import { requireUsername } from "./_shared/auth";
import { errorResponse, json, methodNotAllowed } from "./_shared/responses";
import { storage } from "./_shared/storage";

function extensionFromName(name: string): string {
  const match = name.match(/\.([a-zA-Z0-9]+)$/);
  return match?.[1] ?? "jpg";
}

function publicUrl(key: string): string | null {
  const domain = getEnv("COS_DOMAIN");
  if (!domain) return null;
  return `https://${domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}/${key}`;
}

export default async function shoePhoto(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return methodNotAllowed();
    const username = requireUsername(req);
    const form = await req.formData();
    const shoeId = String(form.get("shoeId") ?? "");
    const file = form.get("photo");
    if (!shoeId) {
      return json({ error: "shoeId is required before uploading a shoe photo." }, { status: 400 });
    }
    if (!(file instanceof File) || !file.type.startsWith("image/")) {
      return json({ error: "A shoe photo image file is required." }, { status: 400 });
    }
    const key = shoePhotoKey(username, shoeId, crypto.randomUUID(), extensionFromName(file.name));
    await storage().putFile(key, {
      body: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || "application/octet-stream"
    });
    return json({ key, url: publicUrl(key) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/shoe-photo"
};
