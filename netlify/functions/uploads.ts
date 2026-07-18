import type { Config } from "@netlify/functions";
import { screenshotKey } from "../../shared/cosKeys";
import { requireUsername } from "./_shared/auth";
import { errorResponse, json, methodNotAllowed } from "./_shared/responses";
import { storage } from "./_shared/storage";

const MAX_FILES_PER_REQUEST = 6;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif"
};

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
    if (files.length > MAX_FILES_PER_REQUEST) {
      return json({ error: `每次最多上传 ${MAX_FILES_PER_REQUEST} 张截图。` }, { status: 413 });
    }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      return json({ error: "本次截图总大小不能超过 4 MB。" }, { status: 413 });
    }
    const keys: string[] = [];
    for (const file of files) {
      const extension = IMAGE_EXTENSIONS[file.type.toLowerCase()];
      if (!extension) {
        return json({ error: "仅支持 JPG、PNG、WebP、HEIC 或 HEIF 图片。" }, { status: 400 });
      }
      const key = screenshotKey(username, runId, crypto.randomUUID(), extension);
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
  path: "/api/uploads",
  rateLimit: {
    windowLimit: 12,
    windowSize: 60,
    aggregateBy: ["ip", "domain"]
  }
};
