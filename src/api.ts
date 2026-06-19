import type { PredictionResult, PublicUser, RunningRecord, WeightRecord } from "@shared/types";
import { buildPrediction } from "@shared/predictions";

type LocalUser = PublicUser & {
  password: string;
};

type LocalState = {
  sessionUsername: string | null;
  users: LocalUser[];
  runsByUser: Record<string, RunningRecord[]>;
  weightsByUser: Record<string, WeightRecord[]>;
};

const LOCAL_STATE_KEY = "running-platform-local-preview";
const LOCAL_PREVIEW_USERNAME = "local-preview";

function isLocalPreviewHost() {
  const host = window.location.hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

function readLocalState(): LocalState {
  const fallback: LocalState = { sessionUsername: null, users: [], runsByUser: {}, weightsByUser: {} };
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_STATE_KEY) ?? "{}") as Partial<LocalState>;
    return {
      sessionUsername: typeof parsed.sessionUsername === "string" ? parsed.sessionUsername : null,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      runsByUser: parsed.runsByUser && typeof parsed.runsByUser === "object" ? parsed.runsByUser : {},
      weightsByUser: parsed.weightsByUser && typeof parsed.weightsByUser === "object" ? parsed.weightsByUser : {}
    };
  } catch {
    return fallback;
  }
}

function writeLocalState(state: LocalState) {
  localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
}

function localUser(state: LocalState): PublicUser | null {
  return state.sessionUsername ? { username: state.sessionUsername } : null;
}

function ensureLocalPreviewSession(state: LocalState): PublicUser {
  if (!state.users.some((user) => user.username === LOCAL_PREVIEW_USERNAME)) {
    state.users.push({ username: LOCAL_PREVIEW_USERNAME, password: "local-preview" });
  }
  state.sessionUsername = LOCAL_PREVIEW_USERNAME;
  state.runsByUser[LOCAL_PREVIEW_USERNAME] ??= [];
  state.weightsByUser[LOCAL_PREVIEW_USERNAME] ??= [];
  writeLocalState(state);
  return { username: LOCAL_PREVIEW_USERNAME };
}

function requireLocalUsername(state: LocalState): string {
  if (!state.sessionUsername) {
    throw new Error("请先登录本地预览账户。");
  }
  return state.sessionUsername;
}

async function localPreviewRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  const method = (init.method ?? "GET").toUpperCase();
  const state = readLocalState();
  const jsonBody = typeof init.body === "string" ? JSON.parse(init.body) : {};

  if (url.pathname === "/api/me") {
    return { user: ensureLocalPreviewSession(state) } as T;
  }
  if (url.pathname === "/api/auth/logout") {
    state.sessionUsername = null;
    writeLocalState(state);
    return { ok: true } as T;
  }
  if (url.pathname === "/api/auth/register" && method === "POST") {
    const username = String(jsonBody.username ?? "").trim().toLowerCase();
    const password = String(jsonBody.password ?? "");
    const inviteCode = String(jsonBody.inviteCode ?? "");
    if (!username || !password) throw new Error("请输入用户名和密码。");
    if (inviteCode !== "FISH_Z") throw new Error("邀请码不正确。");
    if (state.users.some((user) => user.username === username)) throw new Error("用户名已存在。");
    state.users.push({ username, password });
    state.sessionUsername = username;
    state.runsByUser[username] ??= [];
    state.weightsByUser[username] ??= [];
    writeLocalState(state);
    return { user: { username } } as T;
  }
  if (url.pathname === "/api/auth/login" && method === "POST") {
    const username = String(jsonBody.username ?? "").trim().toLowerCase();
    const password = String(jsonBody.password ?? "");
    const user = state.users.find((item) => item.username === username && item.password === password);
    if (!user) throw new Error("本地预览账户不存在或密码不正确。");
    state.sessionUsername = username;
    writeLocalState(state);
    return { user: { username } } as T;
  }

  const username = requireLocalUsername(state);
  state.runsByUser[username] ??= [];
  state.weightsByUser[username] ??= [];

  if (url.pathname === "/api/runs" && method === "GET") {
    return { runs: [...state.runsByUser[username]].sort((a, b) => new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime()) } as T;
  }
  if (url.pathname === "/api/runs" && method === "POST") {
    const run = jsonBody as RunningRecord;
    state.runsByUser[username] = [run, ...state.runsByUser[username].filter((item) => item.id !== run.id)];
    writeLocalState(state);
    return { run } as T;
  }
  if (url.pathname.startsWith("/api/runs/") && method === "PUT") {
    const run = jsonBody as RunningRecord;
    state.runsByUser[username] = [run, ...state.runsByUser[username].filter((item) => item.id !== run.id)];
    writeLocalState(state);
    return { run } as T;
  }
  if (url.pathname === "/api/weights" && method === "GET") {
    return { weights: [...state.weightsByUser[username]].sort((a, b) => b.date.localeCompare(a.date)) } as T;
  }
  if (url.pathname === "/api/weights" && method === "POST") {
    const now = new Date().toISOString();
    const existing = state.weightsByUser[username].find((item) => item.date === jsonBody.date);
    const weight: WeightRecord = {
      date: String(jsonBody.date),
      weightKg: Number(jsonBody.weightKg),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    state.weightsByUser[username] = [weight, ...state.weightsByUser[username].filter((item) => item.date !== weight.date)];
    writeLocalState(state);
    return { weight } as T;
  }
  if (url.pathname === "/api/uploads" && method === "POST") {
    const form = init.body instanceof FormData ? init.body : new FormData();
    const files = form.getAll("screenshots").filter((item): item is File => item instanceof File);
    return { keys: files.map((file, index) => `local-preview/screenshots/${Date.now()}-${index}-${file.name}`) } as T;
  }
  if (url.pathname === "/api/predictions") {
    const targetDistanceKm = Number(url.searchParams.get("targetDistanceKm") ?? 21.0975);
    const targetFinishSec = url.searchParams.get("targetFinishSec") ? Number(url.searchParams.get("targetFinishSec")) : null;
    const targetDate = url.searchParams.get("targetDate");
    return {
      prediction: buildPrediction(state.runsByUser[username], state.weightsByUser[username], targetDistanceKm, {
        targetFinishSec,
        targetDate
      })
    } as T;
  }

  throw new Error("本地预览暂不支持这个 API。");
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (isLocalPreviewHost() && path.startsWith("/api/")) {
    return localPreviewRequest<T>(path, init);
  }
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
  updateRun: (run: RunningRecord) =>
    request<{ run: RunningRecord }>(`/api/runs/${encodeURIComponent(run.id)}`, { method: "PUT", body: JSON.stringify(run) }),
  listWeights: () => request<{ weights: WeightRecord[] }>("/api/weights"),
  saveWeight: (weight: Pick<WeightRecord, "date" | "weightKg">) =>
    request<{ weight: WeightRecord }>("/api/weights", { method: "POST", body: JSON.stringify(weight) }),
  uploadScreenshots: (runId: string, files: File[]) => {
    const form = new FormData();
    form.set("runId", runId);
    files.forEach((file) => form.append("screenshots", file));
    return request<{ keys: string[] }>("/api/uploads", { method: "POST", body: form });
  },
  prediction: (params: { targetDistanceKm: number; targetFinishSec?: number | null; targetDate?: string | null }) => {
    const searchParams = new URLSearchParams({ targetDistanceKm: String(params.targetDistanceKm) });
    if (params.targetFinishSec) {
      searchParams.set("targetFinishSec", String(params.targetFinishSec));
    }
    if (params.targetDate) {
      searchParams.set("targetDate", params.targetDate);
    }
    return request<{ prediction: PredictionResult }>(`/api/predictions?${searchParams.toString()}`);
  }
};
