import type { Config } from "@netlify/functions";
import { normalizeUsername } from "../../shared/cosKeys";
import { comparePassword, sessionCookie } from "./_shared/auth";
import { getProfile } from "./_shared/data";
import { errorResponse, json, methodNotAllowed, parseJson } from "./_shared/responses";

type LoginPayload = {
  username?: string;
  password?: string;
};

export default async function login(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return methodNotAllowed();
    const payload = (await parseJson(req)) as LoginPayload;
    const username = normalizeUsername(payload.username ?? "");
    const profile = await getProfile(username);
    if (!profile || !payload.password || !(await comparePassword(payload.password, profile.passwordHash))) {
      return json({ error: "用户名或密码错误。" }, { status: 401 });
    }
    return json(
      { user: { username } },
      {
        headers: {
          "Set-Cookie": sessionCookie(req, username)
        }
      }
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: "/api/auth/login"
};
