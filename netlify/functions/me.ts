import type { Config } from "@netlify/functions";
import { readSessionUsername } from "./_shared/auth";
import { json, methodNotAllowed } from "./_shared/responses";

export default async function me(req: Request): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();
  const username = readSessionUsername(req);
  return json({ user: username ? { username } : null }, { status: username ? 200 : 401 });
}

export const config: Config = {
  path: "/api/me"
};
