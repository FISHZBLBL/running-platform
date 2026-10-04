import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({
  getText: vi.fn(async () => null), getFile: vi.fn(async () => ({ body: Buffer.from("synthetic photo"), contentType: "image/png" })),
  putText: vi.fn(async () => undefined), putTextIfAbsent: vi.fn(async () => true),
  putFile: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), list: vi.fn(async () => [])
}));
vi.mock("../netlify/functions/_shared/auth", () => ({ requireUsername: () => "runner" }));
vi.mock("../netlify/functions/_shared/storage", () => ({ storage: () => adapter }));

import runById from "../netlify/functions/run-by-id";
import runs from "../netlify/functions/runs";
import shoes from "../netlify/functions/shoes";
import shoePhoto from "../netlify/functions/shoe-photo";
import uploads from "../netlify/functions/uploads";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const jsonRequest = (pathname: string, body: unknown) => new Request(`https://audit.invalid${pathname}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
});
const run = {
  id: "run-1", dateTime: "2026-10-01T08:00:00Z", distanceKm: 5, durationSec: 1800,
  avgPowerW: 200, avgCadenceSpm: 170, avgHeartRateBpm: 150, screenshotKeys: []
};

describe("HTTP storage ownership", () => {
  it("rejects a cross-user run read or overwrite before accessing storage", async () => {
    const id = "../../victim/profile";
    const read = await runById(new Request(`https://audit.invalid/api/runs/${encodeURIComponent(id)}`), { params: { id } });
    const write = await runs(jsonRequest("/api/runs", { ...run, id }));
    expect(read.status).toBe(400);
    expect(write.status).toBe(400);
    expect(adapter.getText).not.toHaveBeenCalled();
    expect(adapter.putText).not.toHaveBeenCalled();
  });

  it("rejects traversal and other users' shoe photos before reading their bytes", async () => {
    for (const key of [
      "users/runner/shoes/x/photos/../../../../victim/profile.json",
      "users/victim/shoes/shoe-1/photos/photo-1.jpg"
    ]) {
      const response = await shoePhoto(new Request(`https://audit.invalid/api/shoe-photo?key=${encodeURIComponent(key)}`));
      expect(response.status).toBe(400);
    }
    expect(adapter.getFile).not.toHaveBeenCalled();
  });

  it("serves the current user's photo with private caching", async () => {
    const key = "users/runner/shoes/shoe-1/photos/photo-1.png";
    const response = await shoePhoto(new Request(`https://audit.invalid/api/shoe-photo?key=${encodeURIComponent(key)}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("synthetic photo");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(adapter.getFile).toHaveBeenCalledWith(key);
  });

  it("refuses attaching a different user's screenshot or shoe photo", async () => {
    expect((await runs(jsonRequest("/api/runs", { ...run, screenshotKeys: ["users/victim/runs/run-1/screenshots/photo-1.png"] }))).status).toBe(400);
    expect((await shoes(jsonRequest("/api/shoes", { id: "shoe-1", name: "Synthetic shoe", photoKey: "users/victim/shoes/shoe-1/photos/photo-1.jpg" }))).status).toBe(400);
    expect(adapter.putText).not.toHaveBeenCalled();
  });

  it("refuses traversing identifiers on multipart uploads", async () => {
    const screenshots = new FormData();
    screenshots.set("runId", "../../victim/profile");
    const photo = new FormData();
    photo.set("shoeId", "../../victim/profile");
    expect((await uploads(new Request("https://audit.invalid/api/uploads", { method: "POST", body: screenshots }))).status).toBe(400);
    expect((await shoePhoto(new Request("https://audit.invalid/api/shoe-photo", { method: "POST", body: photo }))).status).toBe(400);
    expect(adapter.putFile).not.toHaveBeenCalled();
  });
});
