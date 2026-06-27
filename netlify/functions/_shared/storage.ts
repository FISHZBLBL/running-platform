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
  putFile(key: string, file: StoredFile): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

class CosStorage implements StorageAdapter {
  private bucket: string;
  private region: string;
  private secretId: string;
  private secretKey: string;

  constructor() {
    this.bucket = getEnv("COS_BUCKET", "running-platform-1323797631")!;
    this.region = getEnv("COS_REGION", "ap-beijing")!;
    this.secretId = getEnv("COS_SECRET_ID")!;
    this.secretKey = getEnv("COS_SECRET_KEY")!;
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

  private async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const response = await this.request("PUT", key, { body, contentType });
    await this.assertOk(response, key);
  }

  private async request(
    method: "GET" | "PUT" | "DELETE",
    key: string,
    payload?: { body: Buffer; contentType: string },
    query: Record<string, string> = {}
  ): Promise<Response> {
    const host = `${this.bucket}.cos.${this.region}.myqcloud.com`;
    const pathname = key ? `/${encodeCosPath(key)}` : "/";
    const searchParams = new URLSearchParams();
    for (const [paramKey, paramValue] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
      searchParams.set(paramKey, paramValue);
    }
    const queryString = searchParams.toString();
    const headers = new Headers({
      Authorization: this.authorization(method.toLowerCase(), pathname, query),
      Host: host
    });
    if (payload?.contentType) {
      headers.set("Content-Type", payload.contentType);
    }
    return fetch(`https://${host}${pathname}${queryString ? `?${queryString}` : ""}`, {
      method,
      headers,
      body: payload?.body ? new Uint8Array(payload.body) : undefined
    });
  }

  private authorization(method: string, pathname: string, query: Record<string, string>): string {
    const now = Math.floor(Date.now() / 1000);
    const keyTime = `${now - 60};${now + 600}`;
    const signKey = hmacSha1(this.secretKey, keyTime);
    const sortedQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b));
    const urlParamList = sortedQuery.map(([key]) => key.toLowerCase()).join(";");
    const httpParameters = sortedQuery
      .map(([key, value]) => `${encodeURIComponent(key).toLowerCase()}=${encodeURIComponent(value)}`)
      .join("&");
    const headerList = "host";
    const httpHeaders = `host=${this.bucket}.cos.${this.region}.myqcloud.com`;
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
    throw new Error(`COS request failed for ${key || "/"}: ${response.status} ${text.slice(0, 240)}`);
  }
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
    const hasCosSecrets = Boolean(getEnv("COS_SECRET_ID") && getEnv("COS_SECRET_KEY"));
    if (!hasCosSecrets && (getEnv("CONTEXT") === "production" || isCloudFunctionRuntime())) {
      throw new Error("COS_SECRET_ID and COS_SECRET_KEY must be configured for Netlify Functions.");
    }
    adapter = hasCosSecrets ? new CosStorage() : new LocalStorage();
  }
  return adapter;
}
