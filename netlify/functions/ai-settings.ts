import type { Config } from "@netlify/functions";
import type { DeepseekKeyStatus } from "../../shared/types";
import { requireAiUsername } from "./_shared/session";
import {
  deleteDeepseekSecret,
  getDeepseekCustomPrompt,
  getDeepseekSecret,
  saveDeepseekCustomPrompt,
  saveDeepseekSecret
} from "./_shared/data";
import { verifyDeepseekApiKey } from "./_shared/deepseek";
import { encryptDeepseekApiKey, maskedDeepseekKey, validateDeepseekApiKey } from "./_shared/secrets";
import {
  errorResponse,
  json,
  methodNotAllowed,
  parseJson,
  requireJsonRequest,
  requireSameOrigin
} from "./_shared/responses";

function statusFromSecret(secret: Awaited<ReturnType<typeof getDeepseekSecret>>, customPrompt: string): DeepseekKeyStatus {
  return secret
    ? { configured: true, maskedKey: maskedDeepseekKey(secret), updatedAt: secret.updatedAt, customPrompt }
    : { configured: false, maskedKey: null, updatedAt: null, customPrompt };
}

export function validateDeepseekCustomPrompt(value: unknown): string {
  if (typeof value !== "string") {
    const error = new Error("个性化提示词格式无效。");
    (error as Error & { status: number }).status = 400;
    throw error;
  }
  const customPrompt = value.replace(/\r\n?/g, "\n").trim();
  if (customPrompt.length > 1000) {
    const error = new Error("个性化提示词不能超过 1000 个字符。");
    (error as Error & { status: number }).status = 400;
    throw error;
  }
  return customPrompt;
}

export default async function aiSettings(req: Request): Promise<Response> {
  try {
    const username = requireAiUsername(req);
    if (req.method === "GET") {
      const [secret, customPrompt] = await Promise.all([getDeepseekSecret(username), getDeepseekCustomPrompt(username)]);
      return json({ deepseek: statusFromSecret(secret, customPrompt) });
    }
    requireSameOrigin(req);
    if (req.method === "PUT") {
      requireJsonRequest(req);
      const payload = await parseJson(req) as { apiKey?: unknown };
      const apiKey = validateDeepseekApiKey(payload.apiKey);
      await verifyDeepseekApiKey(apiKey);
      const existing = await getDeepseekSecret(username);
      const secret = encryptDeepseekApiKey(username, apiKey, existing?.createdAt);
      await saveDeepseekSecret(username, secret);
      return json({ deepseek: statusFromSecret(secret, await getDeepseekCustomPrompt(username)) });
    }
    if (req.method === "PATCH") {
      requireJsonRequest(req);
      const payload = await parseJson(req) as { customPrompt?: unknown };
      const customPrompt = validateDeepseekCustomPrompt(payload.customPrompt);
      await saveDeepseekCustomPrompt(username, customPrompt);
      return json({ deepseek: statusFromSecret(await getDeepseekSecret(username), customPrompt) });
    }
    if (req.method === "DELETE") {
      await deleteDeepseekSecret(username);
      return json({ deepseek: statusFromSecret(null, await getDeepseekCustomPrompt(username)) });
    }
    return methodNotAllowed();
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/ai-settings/deepseek"
};
