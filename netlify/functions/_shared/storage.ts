import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { getEnv } from "./env";

const require = createRequire(import.meta.url);

export type StoredFile = {
  body: Buffer;
  contentType: string;
};

export interface StorageAdapter {
  getText(key: string): Promise<string | null>;
  putText(key: string, value: string): Promise<void>;
  putFile(key: string, file: StoredFile): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

type CosClient = {
  getObject(options: Record<string, unknown>, callback: (error: Error | null, data: { Body?: Buffer | string }) => void): void;
  putObject(options: Record<string, unknown>, callback: (error: Error | null) => void): void;
  deleteObject(options: Record<string, unknown>, callback: (error: Error | null) => void): void;
  getBucket(options: Record<string, unknown>, callback: (error: Error | null, data: { Contents?: Array<{ Key: string }> }) => void): void;
};

class CosStorage implements StorageAdapter {
  private client: CosClient;
  private bucket: string;
  private region: string;

  constructor() {
    this.bucket = getEnv("COS_BUCKET")!;
    this.region = getEnv("COS_REGION")!;
    const COS = require("cos-nodejs-sdk-v5") as new (options: Record<string, string | undefined>) => CosClient;
    this.client = new COS({
      SecretId: getEnv("COS_SECRET_ID"),
      SecretKey: getEnv("COS_SECRET_KEY")
    });
  }

  async getText(key: string): Promise<string | null> {
    try {
      const data = await new Promise<{ Body?: Buffer | string }>((resolve, reject) => {
        this.client.getObject({ Bucket: this.bucket, Region: this.region, Key: key }, (error, response) => {
          if (error) reject(error);
          else resolve(response);
        });
      });
      return Buffer.isBuffer(data.Body) ? data.Body.toString("utf8") : String(data.Body ?? "");
    } catch (error) {
      if (error instanceof Error && /NoSuchKey|not exist|404/.test(error.message)) {
        return null;
      }
      throw error;
    }
  }

  async putText(key: string, value: string): Promise<void> {
    await this.putObject(key, Buffer.from(value, "utf8"), "application/json; charset=utf-8");
  }

  async putFile(key: string, file: StoredFile): Promise<void> {
    await this.putObject(key, file.body, file.contentType);
  }

  async delete(key: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.deleteObject({ Bucket: this.bucket, Region: this.region, Key: key }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let marker: string | undefined;
    do {
      const data = await new Promise<{ Contents?: Array<{ Key: string }>; NextMarker?: string }>((resolve, reject) => {
        this.client.getBucket({ Bucket: this.bucket, Region: this.region, Prefix: prefix, Marker: marker }, (error, response) => {
          if (error) reject(error);
          else resolve(response);
        });
      });
      keys.push(...(data.Contents ?? []).map((item) => item.Key).filter(Boolean));
      marker = data.NextMarker;
    } while (marker);
    return keys;
  }

  private async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.putObject(
        { Bucket: this.bucket, Region: this.region, Key: key, Body: body, ContentType: contentType },
        (error) => {
          if (error) reject(error);
          else resolve();
        }
      );
    });
  }
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
    const hasCos = getEnv("COS_SECRET_ID") && getEnv("COS_SECRET_KEY") && getEnv("COS_BUCKET") && getEnv("COS_REGION");
    if (!hasCos && getEnv("CONTEXT") === "production") {
      throw new Error("COS environment variables must be configured in production.");
    }
    adapter = hasCos ? new CosStorage() : new LocalStorage();
  }
  return adapter;
}
