import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { build } from "vite";

describe("production public assets", () => {
  it("omits private preview data while preserving ordinary public assets", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "running-platform-build-test-"));
    try {
      await mkdir(path.join(fixtureRoot, "public"));
      await writeFile(path.join(fixtureRoot, "index.html"), "<!doctype html><title>Synthetic build fixture</title>");
      for (const resource of ["runs", "shoes", "weights"]) {
        await writeFile(path.join(fixtureRoot, "public", `local-preview-${resource}.json`), JSON.stringify([{ private: "synthetic" }]));
      }
      await writeFile(path.join(fixtureRoot, "public", "manifest.webmanifest"), '{"name":"Synthetic fixture"}');
      await build({
        configFile: path.resolve("vite.config.mjs"), root: fixtureRoot, logLevel: "silent",
        build: { outDir: "dist", emptyOutDir: true }
      });
      for (const resource of ["runs", "shoes", "weights"]) {
        await expect(readFile(path.join(fixtureRoot, "dist", `local-preview-${resource}.json`))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(path.join(fixtureRoot, "public", `local-preview-${resource}.json`), "utf8")).resolves.toContain("synthetic");
      }
      await expect(readFile(path.join(fixtureRoot, "dist", "manifest.webmanifest"), "utf8")).resolves.toContain("Synthetic fixture");
    } finally {
      if (!path.resolve(fixtureRoot).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
        throw new Error("Unexpected temporary build path");
      }
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
