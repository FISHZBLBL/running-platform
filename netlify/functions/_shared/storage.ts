import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { getEnv, isCloudFunctionRuntime } from "./env";

export type StoredFile = {
  body: Buffer;
  contentType: string;
};

export interface StorageAdapter {
  getText(key: string): Promise<string | null>;
  getFile(key: string): Promise<StoredFile | null>;
  putText(key: string, value: string): Promise<void>;
  putTextIfAbsent(key: string, value: string): Promise<boolean>;
  putFile(key: string, file: StoredFile): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

class CosStorage implements StorageAdapter {
  private bucket: string;
  private region: string;
  private requestHost: string;
  private secretId: string;
  private secretKey: string;
  private maxAttempts: number;
  private requestTimeoutMs: number;

  constructor() {
    this.bucket = getEnv("COS_BUCKET", "running-platform-1323797631")!;
    this.region = getEnv("COS_REGION", "ap-beijing")!;
    this.requestHost = normalizeCosHost(getEnv("COS_DOMAIN", `${this.bucket}.cos.${this.region}.myqcloud.com`)!);
    this.secretId = getEnv("COS_SECRET_ID")!;
    this.secretKey = getEnv("COS_SECRET_KEY")!;
    this.maxAttempts = numberEnv("COS_MAX_ATTEMPTS", 3);
    this.requestTimeoutMs = numberEnv("COS_REQUEST_TIMEOUT_MS", 15000);
    if (this.bucket.includes(".cos.")) {
      throw new Error("腾讯 COS 配置错误：COS_BUCKET 只能填写存储桶名称，例如 running-platform-1323797631，不能填写完整请求域名。");
    }
    if (this.region.includes(".")) {
      throw new Error("腾讯 COS 配置错误：COS_REGION 只能填写地域，例如 ap-beijing，不能填写完整请求域名。");
    }
  }

  async getText(key: string): Promise<string | null> {
    const response = await this.request("GET", key);
    if (response.status === 404) {
      return null;
    }
    await this.assertOk(response, key);
    return response.text();
  }

  async getFile(key: string): Promise<StoredFile | null> {
    const response = await this.request("GET", key);
    if (response.status === 404) {
      return null;
    }
    await this.assertOk(response, key);
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream"
    };
  }

  async putText(key: string, value: string): Promise<void> {
    await this.putObject(key, Buffer.from(value, "utf8"), "application/json; charset=utf-8");
  }

  async putTextIfAbsent(key: string, value: string): Promise<boolean> {
    return this.putObject(key, Buffer.from(value, "utf8"), "application/json; charset=utf-8", true);
  }

  async putFile(key: string, file: StoredFile): Promise<void> {
    await this.putObject(key, file.body, file.contentType);
  }

  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    await this.assertOk(response, key);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let marker: string | undefined;
    do {
      const params: Record<string, string> = { prefix };
      if (marker) {
        params.marker = marker;
      }
      const response = await this.request("GET", "", undefined, params);
      await this.assertOk(response, prefix);
      const xml = await response.text();
      keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => decodeXml(match[1])));
      marker = xml.match(/<NextMarker>([^<]+)<\/NextMarker>/)?.[1];
    } while (marker);
    return keys;
  }

  private async putObject(key: string, body: Buffer, contentType: string, forbidOverwrite = false): Promise<boolean> {
    const response = await this.request("PUT", key, {
      body,
      contentType,
      headers: forbidOverwrite ? { "x-cos-forbid-overwrite": "true" } : undefined
    });
    if (forbidOverwrite && (response.status === 409 || response.status === 412)) {
      return false;
    }
    await this.assertOk(response, key);
    return true;
  }

  private async request(
    method: "GET" | "PUT" | "DELETE",
    key: string,
    payload?: { body: Buffer; contentType: string; headers?: Record<string, string> },
    query: Record<string, string> = {}
  ): Promise<Response> {
    const host = this.requestHost;
    const pathname = key ? `/${encodeCosPath(key)}` : "/";
    const searchParams = new URLSearchParams();
    for (const [paramKey, paramValue] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
      searchParams.set(paramKey, paramValue);
    }
    const queryString = searchParams.toString();
    const signingHeaders = { host, ...(payload?.headers ?? {}) };
    const headers = new Headers(payload?.headers);
    headers.set("Authorization", this.authorization(method.toLowerCase(), pathname, query, signingHeaders));
    headers.set("Host", host);
    if (payload?.contentType) {
      headers.set("Content-Type", payload.contentType);
    }
    const url = `https://${host}${pathname}${queryString ? `?${queryString}` : ""}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          url,
          {
            method,
            headers,
            body: payload?.body ? new Uint8Array(payload.body) : undefined
          },
          this.requestTimeoutMs
        );
        if (attempt < this.maxAttempts && shouldRetryStatus(response.status)) {
          await delay(backoffMs(attempt));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxAttempts) {
          await delay(backoffMs(attempt));
          continue;
        }
      }
    }
    throw new Error(
      [
        "服务器连接腾讯 COS 失败。",
        `操作：${method} ${key || "/"}`,
        `目标：${host}`,
        `尝试：${this.maxAttempts}/${this.maxAttempts}`,
        `原因：${describeNetworkFailure(lastError)}`
      ].join(" ")
    );
  }

  private authorization(
    method: string,
    pathname: string,
    query: Record<string, string>,
    headers: Record<string, string>
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const keyTime = `${now - 60};${now + 600}`;
    const signKey = hmacSha1(this.secretKey, keyTime);
    const sortedQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b));
    const urlParamList = sortedQuery.map(([key]) => key.toLowerCase()).join(";");
    const httpParameters = sortedQuery
      .map(([key, value]) => `${encodeURIComponent(key).toLowerCase()}=${encodeURIComponent(value)}`)
      .join("&");
    const sortedHeaders = Object.entries(headers)
      .map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const headerList = sortedHeaders.map(([key]) => key).join(";");
    const httpHeaders = sortedHeaders
      .map(([key, value]) => `${encodeURIComponent(key).toLowerCase()}=${encodeURIComponent(value).toLowerCase()}`)
      .join("&");
    const httpString = `${method}\n${pathname}\n${httpParameters}\n${httpHeaders}\n`;
    const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`;
    const signature = hmacSha1(signKey, stringToSign);
    return [
      "q-sign-algorithm=sha1",
      `q-ak=${this.secretId}`,
      `q-sign-time=${keyTime}`,
      `q-key-time=${keyTime}`,
      `q-header-list=${headerList}`,
      `q-url-param-list=${urlParamList}`,
      `q-signature=${signature}`
    ].join("&");
  }

  private async assertOk(response: Response, key: string): Promise<void> {
    if (response.ok) {
      return;
    }
    const text = await response.text().catch(() => "");
    const requestId = response.headers.get("x-cos-request-id") ?? response.headers.get("x-cos-trace-id");
    const details = [
      `腾讯 COS 请求失败。对象：${key || "/"}`,
      `HTTP 状态：${response.status} ${response.statusText || ""}`.trim(),
      requestId ? `请求 ID：${requestId}` : "",
      `可能原因：${cosStatusHint(response.status)}`,
      text ? `COS 返回：${compactText(text).slice(0, 240)}` : ""
    ].filter(Boolean);
    throw new Error(details.join(" "));
  }
}

function describeNetworkFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const causeInfo = objectDetails(cause);
  const code = causeInfo.code ?? codeFromMessage(message);
  const hint = networkHint(code, message);
  return [
    message || "未知网络错误",
    causeInfo.summary ? `底层原因：${causeInfo.summary}` : "",
    hint ? `建议检查：${hint}` : ""
  ].filter(Boolean).join("；");
}

function normalizeCosHost(value: string): string {
  const host = value.trim().replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  if (!host) {
    throw new Error("腾讯 COS 配置错误：COS_DOMAIN 不能为空。");
  }
  return host;
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(getEnv(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
  return Math.min(800 * 2 ** (attempt - 1), 2500);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function objectDetails(value: unknown): { code?: string; summary?: string } {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const fields = ["code", "name", "message", "syscall", "hostname", "host", "address", "port"]
    .map((field) => [field, record[field]] as const)
    .filter(([, fieldValue]) => typeof fieldValue === "string" || typeof fieldValue === "number")
    .map(([field, fieldValue]) => `${field}=${String(fieldValue)}`);
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    summary: fields.join(", ")
  };
}

function codeFromMessage(message: string): string | undefined {
  return ["ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"].find((code) =>
    message.includes(code)
  );
}

function networkHint(code: string | undefined, message: string): string {
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "域名解析失败，重点检查 COS_BUCKET 和 COS_REGION 是否正确。";
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || message.toLowerCase().includes("timeout")) {
    return "Netlify Functions 到腾讯 COS 连接超时，可以稍后重试；如果反复出现，考虑把数据接口迁到国内云函数或增加重试。";
  }
  if (code === "ECONNRESET") {
    return "连接被中途重置，通常是跨境网络波动或 COS 侧临时断开。";
  }
  if (code === "ECONNREFUSED") {
    return "目标服务拒绝连接，重点检查请求域名、地域和网络出口。";
  }
  if (message.toLowerCase().includes("certificate") || message.toLowerCase().includes("tls")) {
    return "TLS/证书校验失败，检查 COS 请求域名是否正确。";
  }
  return "检查 Netlify 环境变量、COS 桶地域、腾讯云权限和当前网络连通性。";
}

function cosStatusHint(status: number): string {
  if (status === 400) return "请求参数或签名格式错误，重点检查 COS_BUCKET、COS_REGION、对象路径编码和服务器时间。";
  if (status === 401) return "腾讯云密钥无效或签名校验失败，检查 COS_SECRET_ID 和 COS_SECRET_KEY。";
  if (status === 403) return "密钥权限不足、桶策略拒绝访问，或当前 Secret 未授权读写该存储桶。";
  if (status === 404) return "对象不存在，或存储桶名称/地域配置不匹配。";
  if (status === 409) return "COS 对象状态冲突，可能是并发写入或删除导致。";
  if (status === 429) return "COS 请求过于频繁或被限流。";
  if (status >= 500) return "腾讯 COS 服务端错误或跨云网络波动，可以稍后重试。";
  return "查看 COS 返回内容和 Netlify Function 日志。";
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function hmacSha1(key: string, value: string): string {
  return createHmac("sha1", key).update(value).digest("hex");
}

function encodeCosPath(key: string): string {
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function contentTypeFromKey(key: string): string {
  const extension = key.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "svg") return "image/svg+xml";
  return "image/jpeg";
}

class LocalStorage implements StorageAdapter {
  private root = path.join(process.cwd(), ".netlify", "local-data");

  async getText(key: string): Promise<string | null> {
    try {
      return await readFile(this.resolve(key), "utf8");
    } catch {
      return null;
    }
  }

  async getFile(key: string): Promise<StoredFile | null> {
    try {
      return {
        body: await readFile(this.resolve(key)),
        contentType: contentTypeFromKey(key)
      };
    } catch {
      return null;
    }
  }

  async putText(key: string, value: string): Promise<void> {
    const filePath = this.resolve(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, value, "utf8");
  }

  async putTextIfAbsent(key: string, value: string): Promise<boolean> {
    const filePath = this.resolve(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      await writeFile(filePath, value, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  }

  async putFile(key: string, file: StoredFile): Promise<void> {
    const filePath = this.resolve(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.body);
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const directory = this.resolve(prefix);
    const keys: string[] = [];
    await this.walk(directory, prefix, keys);
    return keys;
  }

  private resolve(key: string): string {
    return path.join(this.root, key);
  }

  private async walk(directory: string, prefix: string, keys: string[]): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativeKey = `${prefix}${entry.name}`;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.walk(fullPath, `${relativeKey}/`, keys);
      } else {
        keys.push(relativeKey);
      }
    }
  }
}

let adapter: StorageAdapter | null = null;

export function storage(): StorageAdapter {
  if (!adapter) {
    const missing = ["COS_SECRET_ID", "COS_SECRET_KEY"].filter((name) => !getEnv(name));
    const hasCosSecrets = missing.length === 0;
    if (!hasCosSecrets && (getEnv("CONTEXT") === "production" || isCloudFunctionRuntime())) {
      throw new Error(
        `腾讯 COS 环境变量缺失：${missing.join(", ")}。请在 Netlify Site configuration -> Environment variables 中配置后重新部署。`
      );
    }
    adapter = hasCosSecrets ? new CosStorage() : new LocalStorage();
  }
  return adapter;
}
