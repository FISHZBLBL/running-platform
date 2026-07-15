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

export function requireJsonRequest(req: Request): void {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("请求必须使用 application/json 格式。");
    (error as Error & { status: number }).status = 415;
    throw error;
  }
}

export function requireSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin) {
    if (!isCloudFunctionRuntime()) return;
    const error = new Error("请求缺少来源信息，已拒绝登录或注册操作。");
    (error as Error & { status: number }).status = 403;
    throw error;
  }

  let requestOrigin: string;
  let suppliedOrigin: string;
  try {
    requestOrigin = new URL(req.url).origin;
    suppliedOrigin = new URL(origin).origin;
  } catch {
    const error = new Error("请求来源格式无效。");
    (error as Error & { status: number }).status = 403;
    throw error;
  }
  if (requestOrigin !== suppliedOrigin) {
    const error = new Error("请求来源与本站不一致，已拒绝登录或注册操作。");
    (error as Error & { status: number }).status = 403;
    throw error;
  }
}

export function methodNotAllowed(): Response {
  return json({ error: "请求方法不被当前接口支持。", status: 405 }, { status: 405 });
}
import { isCloudFunctionRuntime } from "./env";
