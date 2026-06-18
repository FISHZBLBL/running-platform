import type { Config } from "@netlify/functions";
import { isValidUsername, normalizeUsername } from "../../shared/cosKeys";
import type { UserProfile } from "../../shared/types";
import { comparePassword, hashPassword, sessionCookie } from "./_shared/auth";
import { getProfile, saveProfile } from "./_shared/data";
import { inviteCode } from "./_shared/env";
import { errorResponse, json, methodNotAllowed, parseJson } from "./_shared/responses";

type RegisterPayload = {
  username?: string;
  password?: string;
  inviteCode?: string;
};

export default async function register(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return methodNotAllowed();
    const payload = (await parseJson(req)) as RegisterPayload;
    const username = normalizeUsername(payload.username ?? "");
    if (!isValidUsername(username)) {
      return json({ error: "用户名只能包含字母、数字、下划线和短横线，长度 3-32。" }, { status: 400 });
    }
    if (!payload.password || payload.password.length < 6) {
      return json({ error: "密码至少需要 6 位。" }, { status: 400 });
    }
    if (payload.inviteCode !== inviteCode()) {
      return json({ error: "邀请码不正确。" }, { status: 403 });
    }
    const existing = await getProfile(username);
    if (existing) {
      const passwordMatches = await comparePassword(payload.password, existing.passwordHash);
      return json({ error: passwordMatches ? "该用户名已存在，请直接登录。" : "该用户名已存在。" }, { status: 409 });
    }
    const now = new Date().toISOString();
    const profile: UserProfile = {
      username,
      passwordHash: await hashPassword(payload.password),
      createdAt: now,
      updatedAt: now
    };
    await saveProfile(profile);
    return json(
      { user: { username } },
      {
        status: 201,
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
  path: "/api/auth/register"
};
