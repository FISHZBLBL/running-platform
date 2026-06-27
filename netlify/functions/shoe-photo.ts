import type { Config } from "@netlify/functions";
import { shoePhotoKey, shoesPrefix } from "../../shared/cosKeys";
import { requireUsername } from "./_shared/auth";
import { errorResponse, json, methodNotAllowed } from "./_shared/responses";
import { storage } from "./_shared/storage";

function extensionFromName(name: string): string {
  const match = name.match(/\.([a-zA-Z0-9]+)$/);
  return match?.[1] ?? "jpg";
}

function shoePhotoUrl(key: string): string {
  return `/api/shoe-photo?key=${encodeURIComponent(key)}`;
}

function isUserShoePhotoKey(username: string, key: string): boolean {
  return key.startsWith(shoesPrefix(username)) && key.includes("/photos/");
}

export default async function shoePhoto(req: Request): Promise<Response> {
  try {
    const username = requireUsername(req);
    if (req.method === "GET") {
      const key = new URL(req.url).searchParams.get("key") ?? "";
      if (!key || !isUserShoePhotoKey(username, key)) {
        return json({ error: "Shoe photo key is invalid." }, { status: 400 });
      }
      const file = await storage().getFile(key);
      if (!file) {
        return json({ error: "Shoe photo not found." }, { status: 404 });
      }
      return new Response(new Uint8Array(file.body), {
        headers: {
          "Content-Type": file.contentType,
          "Cache-Control": "private, max-age=3600"
        }
      });
    }

    if (req.method !== "POST") return methodNotAllowed();
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
    return json({ key, url: shoePhotoUrl(key) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/shoe-photo"
};
