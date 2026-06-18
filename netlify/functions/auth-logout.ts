import type { Config } from "@netlify/functions";
import { clearSessionCookie } from "./_shared/auth";
import { json, methodNotAllowed } from "./_shared/responses";

export default async function logout(req: Request): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  return json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": clearSessionCookie()
      }
    }
  );
}

export const config: Config = {
  path: "/api/auth/logout"
};
