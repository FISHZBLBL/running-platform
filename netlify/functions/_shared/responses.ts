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
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return json({ error: message }, { status: Number.isFinite(status) ? status : 500 });
}

export async function parseJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    const error = new Error("Request body must be valid JSON.");
    (error as Error & { status: number }).status = 400;
    throw error;
  }
}

export function methodNotAllowed(): Response {
  return json({ error: "Method not allowed." }, { status: 405 });
}
