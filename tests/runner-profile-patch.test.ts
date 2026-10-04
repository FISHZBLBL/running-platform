import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerProfile } from "../shared/types";

const fixtures = vi.hoisted(() => ({ profile: null as RunnerProfile | null }));
vi.mock("../netlify/functions/_shared/auth", () => ({ requireUsername: () => "runner" }));
vi.mock("../netlify/functions/_shared/data", () => ({
  getRunnerProfile: vi.fn(async () => fixtures.profile),
  updateRunnerProfile: vi.fn(async (_username: string, update: (profile: RunnerProfile | null) => RunnerProfile) => {
    fixtures.profile = update(fixtures.profile);
    return fixtures.profile;
  })
}));

import runnerProfile from "../netlify/functions/runner-profile";

const target = { mode: "date-finish", targetDistanceKm: 10, targetFinishSec: null, targetDate: "2027-10-04" };
const request = (body: unknown) => new Request("https://audit.invalid/api/runner-profile", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fixtures.profile = {
    birthDate: "1992-04-20", sex: "female", heightCm: 167,
    restingHeartRateBpm: 54, measuredMaxHeartRateBpm: 190, predictionTarget: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  };
});

afterEach(() => vi.restoreAllMocks());

describe("prediction target PATCH", () => {
  it("preserves stored personal details without requiring them from the browser", async () => {
    const previous = { ...fixtures.profile! };
    const response = await runnerProfile(request({ predictionTarget: target }));
    expect(response.status).toBe(200);
    const { profile } = await response.json();
    expect(profile).toMatchObject({ ...previous, predictionTarget: target, updatedAt: expect.any(String) });
    expect(fixtures.profile).toEqual(profile);
  });

  it("rejects personal fields and invalid dates without overwriting stored data", async () => {
    const previous = { ...fixtures.profile! };
    for (const body of [
      { predictionTarget: target, birthDate: null },
      { predictionTarget: { ...target, targetDate: "2027-02-29" } },
      {}, null, []
    ]) {
      const response = await runnerProfile(request(body));
      expect(response.status).toBe(400);
      expect(fixtures.profile).toEqual(previous);
    }
  });

  it("initializes a target for a new profile and permits explicitly clearing it", async () => {
    fixtures.profile = null;
    const created = await runnerProfile(request({ predictionTarget: target }));
    expect(created.status).toBe(200);
    expect(fixtures.profile).toMatchObject({ birthDate: null, heightCm: null, predictionTarget: target });
    const cleared = await runnerProfile(request({ predictionTarget: null }));
    expect(cleared.status).toBe(200);
    expect((fixtures.profile as RunnerProfile | null)?.predictionTarget).toBeNull();
  });
});
