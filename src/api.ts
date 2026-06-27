import type { PredictionResult, PublicUser, RunningRecord, RunningShoe, WeightRecord } from "@shared/types";
import { buildPrediction } from "@shared/predictions";

type LocalUser = PublicUser & {
  password: string;
};

type LocalState = {
  sessionUsername: string | null;
  users: LocalUser[];
  runsByUser: Record<string, RunningRecord[]>;
  shoesByUser: Record<string, RunningShoe[]>;
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
  const fallback: LocalState = { sessionUsername: null, users: [], runsByUser: {}, shoesByUser: {}, weightsByUser: {} };
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_STATE_KEY) ?? "{}") as Partial<LocalState>;
    return {
      sessionUsername: typeof parsed.sessionUsername === "string" ? parsed.sessionUsername : null,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      runsByUser: parsed.runsByUser && typeof parsed.runsByUser === "object" ? parsed.runsByUser : {},
      shoesByUser: parsed.shoesByUser && typeof parsed.shoesByUser === "object" ? parsed.shoesByUser : {},
      weightsByUser: parsed.weightsByUser && typeof parsed.weightsByUser === "object" ? parsed.weightsByUser : {}
    };
  } catch {
    return fallback;
  }
}

function writeLocalState(state: LocalState) {
  try {
    localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    if (error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")) {
      throw new Error("本地预览存储空间不足。请换一张更小的图片，或先删除部分本地预览数据。");
    }
    throw error;
  }
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
  state.shoesByUser[LOCAL_PREVIEW_USERNAME] ??= [];
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
    state.shoesByUser[username] ??= [];
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
  state.shoesByUser[username] ??= [];
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
  if (url.pathname.startsWith("/api/runs/") && method === "DELETE") {
    const runId = decodeURIComponent(url.pathname.replace("/api/runs/", ""));
    state.runsByUser[username] = state.runsByUser[username].filter((item) => item.id !== runId);
    writeLocalState(state);
    return { ok: true } as T;
  }
  if (url.pathname === "/api/shoes" && method === "GET") {
    return { shoes: [...state.shoesByUser[username]].sort((a, b) => a.name.localeCompare(b.name)) } as T;
  }
  if (url.pathname === "/api/shoes" && method === "POST") {
    const now = new Date().toISOString();
    const shoe: RunningShoe = {
      id: String(jsonBody.id),
      name: String(jsonBody.name ?? "").trim(),
      photoKey: typeof jsonBody.photoKey === "string" ? jsonBody.photoKey : null,
      photoUrl: typeof jsonBody.photoUrl === "string" ? jsonBody.photoUrl : null,
      createdAt: now,
      updatedAt: now
    };
    state.shoesByUser[username] = [shoe, ...state.shoesByUser[username].filter((item) => item.id !== shoe.id)];
    writeLocalState(state);
    return { shoe } as T;
  }
  if (url.pathname.startsWith("/api/shoes/") && method === "PUT") {
    const shoeId = decodeURIComponent(url.pathname.replace("/api/shoes/", ""));
    const existing = state.shoesByUser[username].find((item) => item.id === shoeId);
    const now = new Date().toISOString();
    const shoe: RunningShoe = {
      id: shoeId,
      name: String(jsonBody.name ?? existing?.name ?? "").trim(),
      photoKey: typeof jsonBody.photoKey === "string" ? jsonBody.photoKey : existing?.photoKey ?? null,
      photoUrl: typeof jsonBody.photoUrl === "string" ? jsonBody.photoUrl : existing?.photoUrl ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    state.shoesByUser[username] = [shoe, ...state.shoesByUser[username].filter((item) => item.id !== shoe.id)];
    writeLocalState(state);
    return { shoe } as T;
  }
  if (url.pathname.startsWith("/api/shoes/") && method === "DELETE") {
    const shoeId = decodeURIComponent(url.pathname.replace("/api/shoes/", ""));
    state.shoesByUser[username] = state.shoesByUser[username].filter((item) => item.id !== shoeId);
    state.runsByUser[username] = state.runsByUser[username].map((run) => (run.shoeId === shoeId ? { ...run, shoeId: null } : run));
    writeLocalState(state);
    return { ok: true } as T;
  }
  if (url.pathname === "/api/shoe-photo" && method === "POST") {
    const form = init.body instanceof FormData ? init.body : new FormData();
    const shoeId = String(form.get("shoeId") ?? "");
    const file = form.get("photo");
    if (!(file instanceof File)) throw new Error("请选择跑鞋照片。");
    const url = await fileToCompressedDataUrl(file);
    return { key: `local-preview/shoes/${shoeId}/${file.name}`, url } as T;
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
  if (url.pathname === "/api/weights" && method === "DELETE") {
    const date = url.searchParams.get("date");
    if (!date) throw new Error("缺少体重记录日期。");
    state.weightsByUser[username] = state.weightsByUser[username].filter((item) => item.date !== date);
    writeLocalState(state);
    return { ok: true } as T;
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

async function fileToCompressedDataUrl(file: File): Promise<string> {
  const image =
    "createImageBitmap" in window ? await createImageBitmap(file) : await loadImageFromFile(file);
  const maxSide = 900;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    if ("close" in image) image.close();
    throw new Error("当前浏览器无法压缩图片，请换一张更小的图片。");
  }
  context.drawImage(image, 0, 0, width, height);
  if ("close" in image) image.close();
  return canvas.toDataURL("image/jpeg", 0.72);
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("读取跑鞋照片失败，请换一张图片。"));
    };
    image.src = url;
  });
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
  deleteRun: (runId: string) => request<{ ok: boolean }>(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }),
  listShoes: () => request<{ shoes: RunningShoe[] }>("/api/shoes"),
  createShoe: (shoe: RunningShoe) => request<{ shoe: RunningShoe }>("/api/shoes", { method: "POST", body: JSON.stringify(shoe) }),
  updateShoe: (shoe: RunningShoe) =>
    request<{ shoe: RunningShoe }>(`/api/shoes/${encodeURIComponent(shoe.id)}`, { method: "PUT", body: JSON.stringify(shoe) }),
  deleteShoe: (shoeId: string) => request<{ ok: boolean }>(`/api/shoes/${encodeURIComponent(shoeId)}`, { method: "DELETE" }),
  uploadShoePhoto: (shoeId: string, photo: File) => {
    const form = new FormData();
    form.set("shoeId", shoeId);
    form.set("photo", photo);
    return request<{ key: string; url: string | null }>("/api/shoe-photo", { method: "POST", body: form });
  },
  listWeights: () => request<{ weights: WeightRecord[] }>("/api/weights"),
  saveWeight: (weight: Pick<WeightRecord, "date" | "weightKg">) =>
    request<{ weight: WeightRecord }>("/api/weights", { method: "POST", body: JSON.stringify(weight) }),
  deleteWeight: (date: string) => request<{ ok: boolean }>(`/api/weights?date=${encodeURIComponent(date)}`, { method: "DELETE" }),
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
