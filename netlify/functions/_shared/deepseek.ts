const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

type DeepseekModel = "deepseek-v4-flash" | "deepseek-v4-pro";

function upstreamError(status: number, detail = ""): Error {
  const message = status === 401 || status === 403
    ? "DeepSeek API Key 无效或已被撤销。"
    : status === 402
      ? "DeepSeek 账户余额不足。"
      : status === 429
        ? "DeepSeek 请求过于频繁，请稍后再试。"
        : `DeepSeek 服务暂时不可用${detail ? `：${detail}` : "。"}`;
  const error = new Error(message);
  (error as Error & { status: number }).status = status === 401 || status === 403 ? 400 : 502;
  return error;
}

async function fetchDeepseek(path: string, apiKey: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${DEEPSEEK_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(init.headers ?? {})
      }
    });
  } catch (error) {
    const result = new Error(error instanceof Error && error.name === "AbortError"
      ? "DeepSeek 请求超时，请稍后重试。"
      : "服务器无法连接 DeepSeek，请检查网络后重试。");
    (result as Error & { status: number }).status = 502;
    throw result;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyDeepseekApiKey(apiKey: string): Promise<void> {
  const response = await fetchDeepseek("/models", apiKey, { method: "GET", headers: { "Content-Type": "application/json" } }, 12_000);
  if (!response.ok) throw upstreamError(response.status);
}

function parseJsonContent(content: unknown): unknown {
  if (typeof content !== "string" || !content.trim()) throw upstreamError(502, "模型返回了空内容");
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw upstreamError(502, "模型返回内容无法解析");
  }
}

export async function callDeepseekJson(
  apiKey: string,
  model: DeepseekModel,
  systemPrompt: string,
  payload: unknown,
  maxTokens: number
): Promise<unknown> {
  const response = await fetchDeepseek("/chat/completions", apiKey, {
    method: "POST",
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `请依据以下 JSON 数据返回 JSON 结果：\n${JSON.stringify(payload)}` }
      ],
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      max_tokens: maxTokens,
      stream: false
    })
  }, 24_000);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw upstreamError(response.status, body?.error?.message?.slice(0, 120));
  }
  const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  return parseJsonContent(body.choices?.[0]?.message?.content);
}
