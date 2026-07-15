import type { Config } from "@netlify/functions";
import { isValidUsername, normalizeUsername } from "../../shared/cosKeys";
import type { UserProfile } from "../../shared/types";
import { comparePassword, hashPassword, sessionCookie } from "./_shared/auth";
import { createProfile, getProfile } from "./_shared/data";
import { inviteCode } from "./_shared/env";
import {
  errorResponse,
  json,
  methodNotAllowed,
  parseJson,
  requireJsonRequest,
  requireSameOrigin
} from "./_shared/responses";

type LoginPayload = {
  username?: string;
  password?: string;
};

type RegisterPayload = LoginPayload & {
  inviteCode?: string;
};

async function login(req: Request): Promise<Response> {
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
}

async function register(req: Request): Promise<Response> {
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
  if (!(await createProfile(profile))) {
    const concurrent = await getProfile(username);
    const passwordMatches = concurrent ? await comparePassword(payload.password, concurrent.passwordHash) : false;
    return json({ error: passwordMatches ? "该用户名已存在，请直接登录。" : "该用户名已存在。" }, { status: 409 });
  }
  return json(
    { user: { username } },
    {
      status: 201,
      headers: {
        "Set-Cookie": sessionCookie(req, username)
      }
    }
  );
}

export default async function auth(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return methodNotAllowed();
    requireSameOrigin(req);
    requireJsonRequest(req);
    const pathname = new URL(req.url).pathname;
    if (pathname === "/api/auth/login") return login(req);
    if (pathname === "/api/auth/register") return register(req);
    return json({ error: "认证接口不存在。" }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}

export const config: Config = {
  path: ["/api/auth/login", "/api/auth/register"],
  rateLimit: {
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ["ip", "domain"]
  }
} as Config;
