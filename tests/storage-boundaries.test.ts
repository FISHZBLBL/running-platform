import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStorage } from "../netlify/functions/_shared/storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      throw new Error("Unexpected temporary storage path");
    }
    await rm(directory, { recursive: true, force: true });
  }
});

describe("local storage boundaries", () => {
  it("rejects traversal for every operation and keeps the other user's file intact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "running-platform-storage-test-"));
    temporaryDirectories.push(root);
    const adapter = new LocalStorage(root);
    const victimKey = "users/victim/profile.json";
    await adapter.putText(victimKey, "synthetic private profile");

    for (const key of [
      "users/runner/runs/../../victim/profile.json",
      "users/runner/shoes/x/photos/../../../../victim/profile.json",
      "../outside.json",
      "users\\victim\\profile.json",
      "/users/victim/profile.json",
      "C:/users/victim/profile.json",
      "users/runner/%2e%2e/profile.json"
    ]) {
      await expect(adapter.getText(key)).rejects.toMatchObject({ status: 400 });
      await expect(adapter.getFile(key)).rejects.toMatchObject({ status: 400 });
      await expect(adapter.putText(key, "overwritten")).rejects.toMatchObject({ status: 400 });
      await expect(adapter.putTextIfAbsent(key, "overwritten")).rejects.toMatchObject({ status: 400 });
      await expect(adapter.putFile(key, { body: Buffer.from("overwritten"), contentType: "image/png" })).rejects.toMatchObject({ status: 400 });
      await expect(adapter.delete(key)).rejects.toMatchObject({ status: 400 });
      await expect(adapter.list(key)).rejects.toMatchObject({ status: 400 });
    }

    expect(await readFile(path.join(root, victimKey), "utf8")).toBe("synthetic private profile");
    expect(await adapter.list("users/victim/")).toEqual([victimKey]);
    expect(await adapter.getText("users/runner/missing.json")).toBeNull();
  });
});
