import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv, jwtSecret } from "./env";

const COOKIE_NAME = "rp_session";
const SESSION_SECONDS = 60 * 60 * 24 * 14;

type TokenPayload = { sub: string; iat: number; exp: number };

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createSessionToken(username: string, secret = jwtSecret()): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ sub: username, iat: now, exp: now + SESSION_SECONDS } satisfies TokenPayload));
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign(unsigned, secret)}`;
}

export function verifySessionToken(token: string, secret = jwtSecret()): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`, secret);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length || !timingSafeEqual(expectedBuffer, signatureBuffer)) return null;
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenPayload;
  return decoded.sub && decoded.exp >= Math.floor(Date.now() / 1000) ? decoded : null;
}

export function readSessionUsername(req: Request): string | null {
  const sessionCookie = (req.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!sessionCookie) return null;
  return verifySessionToken(decodeURIComponent(sessionCookie.slice(COOKIE_NAME.length + 1)))?.sub ?? null;
}

export function requireUsername(req: Request): string {
  const username = readSessionUsername(req);
  if (username) return username;
  const error = new Error("Authentication required.");
  (error as Error & { status: number }).status = 401;
  throw error;
}

export function requireAiUsername(req: Request): string {
  const username = readSessionUsername(req);
  if (username) return username;
  if (getEnv("NETLIFY_DEV") === "true" && req.headers.get("x-local-preview-user") === "local-preview") return "local-preview";
  const error = new Error("Authentication required.");
  (error as Error & { status: number }).status = 401;
  throw error;
}

export function sessionCookie(req: Request, username: string): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(createSessionToken(username))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
