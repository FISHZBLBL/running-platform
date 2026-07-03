export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers ?? {})
    }
  });
}

export function errorResponse(error: unknown): Response {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 500;
  const safeStatus = Number.isFinite(status) ? status : 500;
  const message = error instanceof Error ? error.message : String(error || "未知服务器错误。");
  console.error("[api-error]", {
    status: safeStatus,
    message,
    stack: error instanceof Error ? error.stack : undefined,
    cause: error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined
  });
  return json({ error: message, status: safeStatus }, { status: safeStatus });
}

export async function parseJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    const error = new Error("请求体不是有效 JSON。请刷新页面后重试；如果仍然出现，说明前端提交的数据格式异常。");
    (error as Error & { status: number }).status = 400;
    throw error;
  }
}

export function methodNotAllowed(): Response {
  return json({ error: "请求方法不被当前接口支持。", status: 405 }, { status: 405 });
}
