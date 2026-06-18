import type { PredictionResult, PublicUser, RunningRecord, WeightRecord } from "@shared/types";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init.headers ?? {})
    }
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? "请求失败。");
  }
  return data;
}

export const api = {
  me: () => request<{ user: PublicUser | null }>("/api/me"),
  register: (payload: { username: string; password: string; inviteCode: string }) =>
    request<{ user: PublicUser }>("/api/auth/register", { method: "POST", body: JSON.stringify(payload) }),
  login: (payload: { username: string; password: string }) =>
    request<{ user: PublicUser }>("/api/auth/login", { method: "POST", body: JSON.stringify(payload) }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  listRuns: () => request<{ runs: RunningRecord[] }>("/api/runs"),
  createRun: (run: RunningRecord) => request<{ run: RunningRecord }>("/api/runs", { method: "POST", body: JSON.stringify(run) }),
  listWeights: () => request<{ weights: WeightRecord[] }>("/api/weights"),
  saveWeight: (weight: Pick<WeightRecord, "date" | "weightKg">) =>
    request<{ weight: WeightRecord }>("/api/weights", { method: "POST", body: JSON.stringify(weight) }),
  uploadScreenshots: (runId: string, files: File[]) => {
    const form = new FormData();
    form.set("runId", runId);
    files.forEach((file) => form.append("screenshots", file));
    return request<{ keys: string[] }>("/api/uploads", { method: "POST", body: form });
  },
  prediction: (targetDistanceKm: number) =>
    request<{ prediction: PredictionResult }>(`/api/predictions?targetDistanceKm=${encodeURIComponent(targetDistanceKm)}`)
};
