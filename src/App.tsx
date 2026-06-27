import * as echarts from "echarts";
import { Component, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { PredictionResult, PublicUser, RunningRecord, RunningShoe, RunSplit, WeightRecord } from "@shared/types";
import { TRAINING_PACE_LABELS, VDOT_DISTANCES, buildVdotModel } from "@shared/vdot";

type AuthMode = "login" | "register";
type PredictionMode = "distance-date" | "finish-date" | "date-finish";
type AppView = "home" | "records" | "vdot" | "shoes";
type VolumeChartMode = "weekly" | "monthly";
type HistoryMonth = {
  month: string;
  runs: RunningRecord[];
  weights: WeightRecord[];
};

type SplitDraft = {
  distanceKm: string;
  pace: string;
  heartRateBpm: string;
  powerW: string;
  cadenceSpm: string;
};

type SplitOcrResult = {
  splits: SplitDraft[];
  detectedCount: number;
  fullSplitCount: number;
  droppedIndexes: number[];
};

type RunDraft = {
  id: string;
  dateTime: string;
  shoeId: string;
  distanceKm: string;
  duration: string;
  avgPace: string;
  avgPowerW: string;
  avgCadenceSpm: string;
  avgHeartRateBpm: string;
  temperatureC: string;
  humidityPct: string;
  aqi: string;
  notes: string;
  splits: SplitDraft[];
  screenshotKeys: string[];
};

type TextDetectionResult = {
  rawValue?: string;
};

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="boot-screen">
          <div className="panel error-panel">
            <p className="eyebrow">Preview Error</p>
            <h1>页面预览出错</h1>
            <p>{this.state.error.message}</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

declare global {
  interface Window {
    TextDetector?: new () => {
      detect(source: ImageBitmapSource): Promise<TextDetectionResult[]>;
    };
  }
}

const emptySplit: SplitDraft = {
  distanceKm: "1",
  pace: "",
  heartRateBpm: "",
  powerW: "",
  cadenceSpm: ""
};

function createLocalId(): string {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function localDateTime(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function newRunDraft(): RunDraft {
  return {
    id: createLocalId(),
    dateTime: localDateTime(),
    shoeId: "",
    distanceKm: "",
    duration: "",
    avgPace: "",
    avgPowerW: "",
    avgCadenceSpm: "",
    avgHeartRateBpm: "",
    temperatureC: "",
    humidityPct: "",
    aqi: "",
    notes: "",
    splits: [],
    screenshotKeys: []
  };
}

function draftFromRun(run: RunningRecord): RunDraft {
  const date = new Date(run.dateTime);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return {
    id: run.id,
    dateTime: date.toISOString().slice(0, 16),
    shoeId: run.shoeId ?? "",
    distanceKm: String(run.distanceKm),
    duration: formatDuration(run.durationSec),
    avgPace: formatPace(run.avgPaceSecPerKm),
    avgPowerW: String(run.avgPowerW),
    avgCadenceSpm: String(run.avgCadenceSpm),
    avgHeartRateBpm: String(run.avgHeartRateBpm),
    temperatureC: run.weather.temperatureC === null ? "" : String(run.weather.temperatureC),
    humidityPct: run.weather.humidityPct === null ? "" : String(run.weather.humidityPct),
    aqi: run.weather.aqi === null ? "" : String(run.weather.aqi),
    notes: run.notes ?? "",
    splits: run.splits.map((split) => ({
      distanceKm: String(split.distanceKm),
      pace: formatPace(split.paceSecPerKm),
      heartRateBpm: String(split.heartRateBpm),
      powerW: String(split.powerW),
      cadenceSpm: String(split.cadenceSpm)
    })),
    screenshotKeys: run.screenshotKeys
  };
}

function parseNumber(value: string, fallback = 0): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function parseDuration(value: string): number {
  const parts = value
    .trim()
    .split(":")
    .map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return Number(value) * 60;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] * 60;
}

function parsePace(value: string): number {
  const parts = value
    .trim()
    .split(":")
    .map((part) => Number(part));
  if (parts.length === 2 && parts.every((part) => Number.isFinite(part))) {
    return parts[0] * 60 + parts[1];
  }
  return parseNumber(value, 0);
}

function formatPace(seconds: number): string {
  if (!Number.isFinite(seconds)) return "-";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "-";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.round(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatKm(value: number): string {
  if (!Number.isFinite(value)) return "0.0";
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function isCompleteDecimalInput(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value.trim());
}

function movingAverage(values: number[], windowSize = 3): number[] {
  return values.map((_value, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const window = values.slice(start, index + 1);
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
}

function monthlyMileage(runs: RunningRecord[]): Array<{ month: string; distanceKm: number; longestDistanceKm: number }> {
  const totals = new Map<string, { distanceKm: number; longestDistanceKm: number }>();
  for (const run of runs) {
    const month = run.dateTime.slice(0, 7);
    const current = totals.get(month) ?? { distanceKm: 0, longestDistanceKm: 0 };
    totals.set(month, {
      distanceKm: current.distanceKm + run.distanceKm,
      longestDistanceKm: Math.max(current.longestDistanceKm, run.distanceKm)
    });
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, value]) => ({ month, ...value }));
}

function isoWeekKey(dateTime: string): string {
  const date = new Date(dateTime);
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function weeklyMileage(runs: RunningRecord[]): Array<{ week: string; distanceKm: number; longestDistanceKm: number }> {
  const totals = new Map<string, { distanceKm: number; longestDistanceKm: number }>();
  for (const run of runs) {
    const week = isoWeekKey(run.dateTime);
    const current = totals.get(week) ?? { distanceKm: 0, longestDistanceKm: 0 };
    totals.set(week, {
      distanceKm: current.distanceKm + run.distanceKm,
      longestDistanceKm: Math.max(current.longestDistanceKm, run.distanceKm)
    });
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, value]) => ({ week, ...value }));
}

function groupHistoryByMonth(runs: RunningRecord[], weights: WeightRecord[]): HistoryMonth[] {
  const grouped = new Map<string, HistoryMonth>();
  for (const run of runs) {
    const month = run.dateTime.slice(0, 7);
    if (!grouped.has(month)) grouped.set(month, { month, runs: [], weights: [] });
    grouped.get(month)!.runs.push(run);
  }
  for (const weight of weights) {
    const month = weight.date.slice(0, 7);
    if (!grouped.has(month)) grouped.set(month, { month, runs: [], weights: [] });
    grouped.get(month)!.weights.push(weight);
  }
  return [...grouped.values()]
    .map((entry) => ({
      ...entry,
      runs: entry.runs.sort((a, b) => new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime()),
      weights: entry.weights.sort((a, b) => b.date.localeCompare(a.date))
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

function shoePhotoSrc(shoe: RunningShoe): string {
  if (shoe.photoKey?.startsWith("users/")) {
    return `/api/shoe-photo?key=${encodeURIComponent(shoe.photoKey)}`;
  }
  return shoe.photoUrl ?? "";
}

function normalizeDurationToken(value: string): string {
  const parts = value.split(":");
  if (parts.length === 2 && parts[0].length === 3) {
    return `${parts[0][0]}:${parts[0].slice(1)}:${parts[1]}`;
  }
  return value;
}

function sectionAfterLabel(text: string, label: RegExp, stopLabels: string[]): string {
  const match = label.exec(text);
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const stop = stopLabels
    .map((item) => text.indexOf(item, start))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return text.slice(start, stop ?? start + 120);
}

function metricInRange(section: string, min: number, max: number): string | null {
  const matches = [...section.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const value = matches.find((item) => item >= min && item <= max);
  return value === undefined ? null : String(value);
}

function formatPaceCandidate(minutesText: string, secondsText: string): string | null {
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (minutes < 2 || minutes > 15 || seconds < 0 || seconds >= 60) return null;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function extractPaceValue(text: string, section: string): string | null {
  const pacePatterns = [
    /(\d{1,2})\s*['′’‘＇´:：]\s*(\d{2})\s*(?:['"″”]|''|’’|…|\d|\s){0,5}(?:[\/／]?\s*(?:km|KM|公里))/,
    /(\d{1,2})\s+(\d{2})\s*(?:"|″|”|''|’’)?\s*(?:[\/／]\s*(?:km|KM|公里))/,
    /(\d{1,2})\s*['′’‘＇´:：]\s*(\d{2})\s*(?:"|″|”|''|’’)?/
  ];
  for (const pattern of pacePatterns) {
    const match = section.match(pattern);
    if (!match) continue;
    const value = formatPaceCandidate(match[1], match[2]);
    if (value) return value;
  }

  const labeledMatch = text.match(
    /(?:平均配速|配速).{0,180}?(\d{1,2})\s*['′’‘＇´:：]\s*(\d{2})\s*(?:['"″”]|''|’’|…|\d|\s){0,5}(?:[\/／]?\s*(?:km|KM|公里))/
  );
  if (labeledMatch) return formatPaceCandidate(labeledMatch[1], labeledMatch[2]);

  const unitMatch = text.match(/(\d{1,2})\s*['′’‘＇´:：]\s*(\d{2})\s*(?:['"″”]|''|’’|…|\d|\s){0,5}(?:[\/／]?\s*(?:km|KM|公里))/);
  return unitMatch ? formatPaceCandidate(unitMatch[1], unitMatch[2]) : null;
}

function extractCadenceValue(text: string, section: string): string | null {
  const unitMatch = text.match(/(\d{2,3})\s*(?:步\s*[\/／]\s*(?:分|分钟|分鐘)|步\s*(?:分|分钟|分鐘)|spm|SPM)/);
  if (unitMatch) {
    const value = Number(unitMatch[1]);
    if (value >= 120 && value <= 230) return String(value);
  }
  return metricInRange(section, 120, 230);
}

function normalizeSplitText(text: string): string {
  return text
    .replace(/[，,]/g, "")
    .replace(/[：]/g, ":")
    .replace(/[／]/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeOcrLine(line: string): string {
  return line
    .replace(/[，,]/g, "")
    .replace(/[：]/g, ":")
    .replace(/[／]/g, "/")
    .replace(/[′’‘＇´]/g, "'")
    .replace(/[″”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function splitOcrLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(normalizeOcrLine)
    .filter(Boolean);
}

function splitLinesAfter(lines: string[], labels: string[]): string[] {
  const index = lines.findIndex((line) => labels.some((label) => line.includes(label)));
  return index >= 0 ? lines.slice(index + 1) : lines;
}

function numberInLine(line: string, min: number, max: number): string | null {
  const values = [...line.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const value = values.find((item) => item >= min && item <= max);
  return value === undefined ? null : String(value);
}

function paceFromLine(line: string): string | null {
  const direct = extractPaceValue(line, line);
  if (direct) return direct;
  const compact = line.match(/(?:^|\D)(\d{1,2})\s*(\d{2})\s*(?:"|''|’’|公里|km|KM)/);
  return compact ? formatPaceCandidate(compact[1], compact[2]) : null;
}

function parseTimePaceHeartSplits(lines: string[]): SplitDraft[] {
  const source = splitLinesAfter(lines, ["时间", "配速"]);
  const splits: SplitDraft[] = [];
  let pendingTime = "";
  let pendingPace = "";

  for (const line of source) {
    const timeMatch = line.match(/\b(\d{1,2}:\d{2})\b/);
    if (timeMatch && !pendingTime) {
      pendingTime = timeMatch[1];
      continue;
    }

    const pace = paceFromLine(line);
    if (pace) {
      pendingPace = pace;
      continue;
    }

    const heartRate = line.includes("次") || /bpm|BPM/.test(line) ? numberInLine(line, 60, 220) : null;
    if (heartRate && (pendingTime || pendingPace)) {
      splits.push({
        ...emptySplit,
        distanceKm: "1",
        pace: pendingPace || pendingTime,
        heartRateBpm: heartRate
      });
      pendingTime = "";
      pendingPace = "";
    }
  }

  return splits;
}

function parseEffortSplits(lines: string[]): SplitDraft[] {
  const source = splitLinesAfter(lines, ["心率", "功率", "步频"]);
  const splits: SplitDraft[] = [];
  let pendingHeartRate = "";
  let pendingPower = "";

  for (const line of source) {
    const heartRate = line.includes("次") || /bpm|BPM/.test(line) ? numberInLine(line, 60, 220) : null;
    if (heartRate && !pendingHeartRate) {
      pendingHeartRate = heartRate;
      continue;
    }

    const power = /瓦|W|w|FR|R\b|K\b/.test(line) ? numberInLine(line, 50, 600) : null;
    if (power && pendingHeartRate && !pendingPower) {
      pendingPower = power;
      continue;
    }

    const cadence = /步|spm|SPM|%\s*\/\s*(?:9|%)/.test(line) ? numberInLine(line, 120, 230) : null;
    if (cadence && pendingHeartRate) {
      splits.push({
        ...emptySplit,
        distanceKm: "1",
        heartRateBpm: pendingHeartRate,
        powerW: pendingPower,
        cadenceSpm: cadence
      });
      pendingHeartRate = "";
      pendingPower = "";
    }
  }

  return splits;
}

function upsertSplit(map: Map<number, SplitDraft>, index: number, patch: Partial<SplitDraft>) {
  const current = map.get(index) ?? { ...emptySplit };
  map.set(index, { ...current, ...patch });
}

function extractSplitRows(text: string): Map<number, SplitDraft> {
  const normalized = normalizeSplitText(text);
  const rowPattern = /(?:^|\s)(\d{1,2})(?=\s+(?:\d{1,2}:\d{2}|\d{2,3}\s*(?:次|bpm|BPM)))/g;
  const rows = [...normalized.matchAll(rowPattern)].map((match) => ({ index: Number(match[1]), start: match.index ?? 0 }));
  const splits = new Map<number, SplitDraft>();

  rows.forEach((row, rowPosition) => {
    const next = rows[rowPosition + 1]?.start ?? normalized.length;
    const chunk = normalized.slice(row.start, next);
    const timeMatch = chunk.match(/\b(\d{1,2}:\d{2})\b/);
    const paceValue = extractPaceValue(chunk, chunk);
    const heartRate = metricInRange(chunk.match(/\d{2,3}\s*次\s*\/\s*分/)?.[0] ?? "", 60, 220);
    const power = metricInRange(chunk.match(/\d{2,4}\s*(?:瓦|W|w)/)?.[0] ?? "", 50, 600);
    const cadence = extractCadenceValue(chunk, chunk);
    const patch: Partial<SplitDraft> = { distanceKm: "1" };

    if (paceValue) {
      patch.pace = paceValue;
    } else if (timeMatch) {
      patch.pace = timeMatch[1];
    }
    if (heartRate) patch.heartRateBpm = heartRate;
    if (power) patch.powerW = power;
    if (cadence) patch.cadenceSpm = cadence;

    upsertSplit(splits, row.index, patch);
  });

  return splits;
}

function mergeSplitLists(primary: SplitDraft[], secondary: SplitDraft[]): Map<number, SplitDraft> {
  const splitMap = new Map<number, SplitDraft>();
  const count = Math.max(primary.length, secondary.length);
  for (let index = 0; index < count; index += 1) {
    const first = primary[index] ?? emptySplit;
    const second = secondary[index] ?? emptySplit;
    const merged: SplitDraft = {
      distanceKm: first.distanceKm || second.distanceKm || "1",
      pace: first.pace || second.pace,
      heartRateBpm: first.heartRateBpm || second.heartRateBpm,
      powerW: first.powerW || second.powerW,
      cadenceSpm: first.cadenceSpm || second.cadenceSpm
    };
    splitMap.set(index + 1, merged);
  }
  return splitMap;
}

function extractSplitsFromText(text: string, totalDistanceKm: number): SplitOcrResult {
  const fullSplitCount = Math.max(0, Math.floor(totalDistanceKm));
  const lines = splitOcrLines(text);
  const timePaceHeartSplits = parseTimePaceHeartSplits(lines);
  const effortSplits = parseEffortSplits(lines);
  const splitMap =
    timePaceHeartSplits.length > 0 || effortSplits.length > 0 ? mergeSplitLists(timePaceHeartSplits, effortSplits) : extractSplitRows(text);
  const detectedIndexes = [...splitMap.keys()].sort((a, b) => a - b);
  const droppedIndexes = detectedIndexes.filter((index) => fullSplitCount > 0 && index > fullSplitCount);
  const splits = detectedIndexes
    .filter((index) => fullSplitCount === 0 || index <= fullSplitCount)
    .map((index) => splitMap.get(index)!)
    .filter((split) => split.pace || split.heartRateBpm || split.powerW || split.cadenceSpm);

  return {
    splits,
    detectedCount: detectedIndexes.length,
    fullSplitCount,
    droppedIndexes
  };
}

function extractRunDraftFromText(text: string): Partial<RunDraft> {
  const normalized = text.replace(/\s+/g, " ");
  const distanceMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:km|KM|公里)/);
  const durationMatch =
    normalized.match(/(?:体能训练时间|训练时间|总用时|用时).{0,80}?(\d{1,3}:\d{2}(?::\d{2})?)/) ??
    normalized.match(/(\d{1,3}:\d{2}(?::\d{2})?)/);
  const paceSection = sectionAfterLabel(normalized, /(?:平均配速|配速)/, ["平均心率", "平均步频", "平均功率", "环境"]);
  const heartRateSection = sectionAfterLabel(normalized, /(?:平均心率|心率)/, ["平均步频", "平均功率", "平均配速", "环境"]);
  const cadenceSection = sectionAfterLabel(normalized, /(?:平均步频|步频)/, ["平均配速", "平均心率", "平均功率", "环境"]);
  const powerSection = sectionAfterLabel(normalized, /(?:平均功率|功率)/, ["平均配速", "平均步频", "平均心率", "环境"]);
  const paceValue = extractPaceValue(normalized, paceSection);
  const result: Partial<RunDraft> = {};
  if (distanceMatch) result.distanceKm = distanceMatch[1];
  if (durationMatch) result.duration = normalizeDurationToken(durationMatch[1]);
  if (paceValue) result.avgPace = paceValue;
  result.avgHeartRateBpm = metricInRange(heartRateSection, 60, 220) ?? result.avgHeartRateBpm;
  result.avgCadenceSpm = extractCadenceValue(normalized, cadenceSection) ?? result.avgCadenceSpm;
  result.avgPowerW = metricInRange(powerSection, 50, 600) ?? result.avgPowerW;
  return result;
}

async function detectTextFromImages(files: File[]): Promise<string> {
  const texts: string[] = [];

  if (window.TextDetector) {
    const detector = new window.TextDetector();
    for (const file of files) {
      const bitmap = await createImageBitmap(file);
      const results = await detector.detect(bitmap);
      texts.push(...results.map((result) => result.rawValue ?? "").filter(Boolean));
    }
    return texts.join("\n");
  }

  const { createWorker, PSM } = await import("tesseract.js");
  const worker = await createWorker(["eng", "chi_sim"]);
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: "1"
    });
    for (const file of files) {
      const result = await worker.recognize(file);
      if (result.data.text.trim()) {
        texts.push(result.data.text.trim());
      }
    }
  } finally {
    await worker.terminate();
  }
  return texts.join("\n");
}

function nearestWeight(run: RunningRecord, weights: WeightRecord[]): WeightRecord | null {
  const runMs = new Date(run.dateTime).getTime();
  let best: { weight: WeightRecord; delta: number } | null = null;
  for (const weight of weights) {
    const delta = Math.abs(new Date(`${weight.date}T00:00:00`).getTime() - runMs);
    if (delta <= 3 * 86_400_000 && (!best || delta < best.delta)) {
      best = { weight, delta };
    }
  }
  return best?.weight ?? null;
}

function AuthDialog({ onAuthed }: { onAuthed: (user: PublicUser) => void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "login"
          ? await api.login({ username, password })
          : await api.register({ username, password, inviteCode });
      onAuthed(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-panel" onSubmit={submit}>
        <div>
          <p className="eyebrow">Running Platform</p>
          <h1>{mode === "login" ? "登录账户" : "创建新账户"}</h1>
        </div>
        <div className="segmented" aria-label="auth mode">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            登录
          </button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
            注册
          </button>
        </div>
        <label>
          用户名
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </label>
        <label>
          密码
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
        </label>
        {mode === "register" && (
          <label>
            邀请码
            <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={busy}>
          {busy ? "处理中..." : mode === "login" ? "登录" : "注册并进入"}
        </button>
      </form>
    </div>
  );
}

function roundDownToStep(value: number, step: number) {
  return Math.floor(value / step) * step;
}

function roundUpToStep(value: number, step: number) {
  return Math.ceil(value / step) * step;
}

function paceAxis(values: number[]) {
  if (values.length === 0) return { min: 180, max: 540 };
  const fastest = Math.min(...values);
  const slowest = Math.max(...values);
  const padding = Math.max(35, (slowest - fastest) * 0.25);
  return {
    min: Math.max(120, roundDownToStep(fastest - padding, 30)),
    max: roundUpToStep(slowest + padding, 30)
  };
}

function valueAxis(values: number[], fallback: { min: number; max: number }, step: number, minRange: number) {
  if (values.length === 0) return fallback;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = Math.max(minRange, high - low);
  const padding = range * 0.35;
  return {
    min: Math.max(0, roundDownToStep(low - padding, step)),
    max: roundUpToStep(high + padding, step)
  };
}

function simpleRegressionLine(points: number[][], xIndex: number, yIndex: number): number[][] {
  if (points.length < 2) return [];
  const xs = points.map((point) => point[xIndex]);
  const ys = points.map((point) => point[yIndex]);
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const numerator = xs.reduce((sum, value, index) => sum + (value - xMean) * (ys[index] - yMean), 0);
  const denominator = xs.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
  if (denominator === 0) return [];
  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  return [
    [minX, slope * minX + intercept],
    [maxX, slope * maxX + intercept]
  ];
}

function chartTooltipFormatter(params: unknown) {
  const items = Array.isArray(params) ? params : [params];
  const first = items[0] as { axisValueLabel?: string; name?: string } | undefined;
  const lines = [`<strong>${first?.axisValueLabel ?? first?.name ?? ""}</strong>`];
  items.forEach((item) => {
    const point = item as { marker?: string; seriesName?: string; value?: unknown };
    const name = point.seriesName ?? "";
    const value = point.value;
    let formatted = "";
    if (name === "体重-配速" && Array.isArray(value)) {
      formatted = `${Number(value[0]).toFixed(1)} kg · ${formatPace(Number(value[1]))} /km · ${Number(value[2]).toFixed(1)} km`;
    } else if (name === "体重-心率" && Array.isArray(value)) {
      formatted = `${Number(value[0]).toFixed(1)} kg · ${Number(value[1]).toFixed(0)} bpm · ${Number(value[2]).toFixed(1)} km`;
    } else if (name === "配速-心率" && Array.isArray(value)) {
      formatted = `${formatPace(Number(value[0]))} /km · ${Number(value[1]).toFixed(0)} bpm · ${Number(value[2]).toFixed(1)} km · ${value[3]}`;
    } else if (name === "心率拟合" && Array.isArray(value)) {
      formatted = `${formatPace(Number(value[0]))} /km · ${Number(value[1]).toFixed(0)} bpm`;
    } else if (name.includes("配速") || name.includes("移动平均")) {
      formatted = `${formatPace(Number(value))} /km`;
    } else if (name.includes("心率")) {
      formatted = `${Number(value).toFixed(0)} bpm`;
    } else if (name.includes("距离") || name.includes("跑量") || name.includes("最长单次")) {
      formatted = `${Number(value).toFixed(2)} km`;
    } else {
      formatted = String(value ?? "");
    }
    lines.push(`${point.marker ?? ""}${name}: ${formatted}`);
  });
  return lines.join("<br />");
}

function ResearchChart({ runs, weights }: { runs: RunningRecord[]; weights: WeightRecord[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [volumeMode, setVolumeMode] = useState<VolumeChartMode>("weekly");

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    const sorted = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
    const dates = sorted.map((run) => run.dateTime.slice(0, 10));
    const paces = sorted.map((run) => run.avgPaceSecPerKm);
    const paceAverage = movingAverage(paces);
    const distances = sorted.map((run) => run.distanceKm);
    const heartRates = sorted.map((run) => run.avgHeartRateBpm);
    const monthly = monthlyMileage(sorted);
    const weekly = weeklyMileage(sorted);
    const volumeData = volumeMode === "weekly" ? weekly : monthly;
    const volumeLabels = volumeData.map((item) => ("week" in item ? item.week : item.month));
    const volumeLabel = volumeMode === "weekly" ? "周跑量" : "月跑量";
    const volumeLongestLabel = volumeMode === "weekly" ? "周内最长单次" : "月内最长单次";
    const paceRange = paceAxis(paces);
    const weightRange = valueAxis(weights.map((weight) => weight.weightKg), { min: 65, max: 105 }, 2, 12);
    const distanceRange = valueAxis(distances, { min: 0, max: 15 }, 2, 6);
    const heartRateRange = valueAxis(heartRates, { min: 120, max: 180 }, 5, 20);
    const volumeDistanceRange = valueAxis(
      [...volumeData.map((item) => item.distanceKm), ...volumeData.map((item) => item.longestDistanceKm)],
      volumeMode === "weekly" ? { min: 0, max: 40 } : { min: 0, max: 80 },
      volumeMode === "weekly" ? 5 : 10,
      volumeMode === "weekly" ? 20 : 30
    );
    const weightPaceScatter = sorted
      .map((run) => {
        const weight = nearestWeight(run, weights);
        return weight ? [weight.weightKg, run.avgPaceSecPerKm, run.distanceKm] : null;
      })
      .filter(Boolean);
    const weightHeartRateScatter = sorted
      .map((run) => {
        const weight = nearestWeight(run, weights);
        return weight ? [weight.weightKg, run.avgHeartRateBpm, run.distanceKm] : null;
      })
      .filter(Boolean);
    const paceHeartScatter = sorted
      .map((run) => {
        if (!Number.isFinite(run.avgPaceSecPerKm) || !Number.isFinite(run.avgHeartRateBpm)) return null;
        return [run.avgPaceSecPerKm, run.avgHeartRateBpm, run.distanceKm, run.dateTime.slice(0, 10)];
      })
      .filter((item): item is [number, number, number, string] => Boolean(item));
    const paceHeartLine = simpleRegressionLine(
      paceHeartScatter.map(([pace, heartRate]) => [pace, heartRate]),
      0,
      1
    );

    chart.setOption({
      color: ["#1864ab", "#2b8a3e", "#c92a2a", "#f08c00", "#0f766e", "#7048e8", "#7c2d12"],
      tooltip: {
        formatter: chartTooltipFormatter
      },
      legend: [
        { top: 8, left: 16, data: ["实际配速", "3次移动平均", "单次距离", "平均心率"] },
        { top: 342, left: 16, data: ["体重-配速", "体重-心率"] },
        { top: 572, left: 16, data: ["配速-心率", "心率拟合"] },
        { top: 814, left: 16, data: [volumeLabel, volumeLongestLabel] }
      ],
      grid: [
        { top: 72, left: 64, right: 112, height: 235, containLabel: true },
        { top: 398, left: 64, right: 80, height: 135, containLabel: true },
        { top: 628, left: 64, right: 64, height: 135, containLabel: true },
        { top: 872, left: 64, right: 64, height: 166, containLabel: true }
      ],
      xAxis: [
        { type: "category", data: dates, boundaryGap: false, gridIndex: 0, nameGap: 24 },
        {
          type: "value",
          name: "体重 kg",
          nameLocation: "middle",
          nameGap: 32,
          gridIndex: 1,
          min: weightRange.min,
          max: weightRange.max,
          splitLine: { lineStyle: { type: "dashed" } }
        },
        {
          type: "value",
          name: "配速 /km",
          nameLocation: "middle",
          nameGap: 32,
          gridIndex: 2,
          min: paceRange.min,
          max: paceRange.max,
          axisLabel: { formatter: (value: number) => formatPace(value) },
          splitLine: { lineStyle: { type: "dashed" } }
        },
        { type: "category", data: volumeLabels, gridIndex: 3, nameGap: 24 }
      ],
      yAxis: [
        {
          type: "value",
          name: "配速 /km",
          nameLocation: "middle",
          nameGap: 46,
          inverse: true,
          gridIndex: 0,
          min: paceRange.min,
          max: paceRange.max,
          axisLabel: { formatter: (value: number) => formatPace(value) }
        },
        {
          type: "value",
          name: "距离 km",
          nameLocation: "middle",
          nameGap: 46,
          gridIndex: 0,
          position: "right",
          min: distanceRange.min,
          max: distanceRange.max
        },
        {
          type: "value",
          name: "心率 bpm",
          nameLocation: "middle",
          nameGap: 48,
          gridIndex: 0,
          position: "right",
          offset: 52,
          min: heartRateRange.min,
          max: heartRateRange.max
        },
        {
          type: "value",
          name: "配速 /km",
          nameLocation: "middle",
          nameGap: 46,
          inverse: true,
          gridIndex: 1,
          min: paceRange.min,
          max: paceRange.max,
          axisLabel: { formatter: (value: number) => formatPace(value) }
        },
        {
          type: "value",
          name: "心率 bpm",
          nameLocation: "middle",
          nameGap: 48,
          gridIndex: 1,
          position: "right",
          min: heartRateRange.min,
          max: heartRateRange.max
        },
        {
          type: "value",
          name: "心率 bpm",
          nameLocation: "middle",
          nameGap: 46,
          gridIndex: 2,
          min: heartRateRange.min,
          max: heartRateRange.max
        },
        {
          type: "value",
          name: `${volumeLabel} km`,
          nameLocation: "middle",
          nameGap: 44,
          gridIndex: 3,
          min: volumeDistanceRange.min,
          max: volumeDistanceRange.max
        }
      ],
      series: [
        { name: "实际配速", type: "line", data: paces, smooth: true, symbolSize: 8 },
        { name: "3次移动平均", type: "line", data: paceAverage, smooth: true, lineStyle: { type: "dashed", width: 2 }, symbol: "none" },
        { name: "单次距离", type: "bar", yAxisIndex: 1, data: distances, barMaxWidth: 20, opacity: 0.42 },
        { name: "平均心率", type: "line", yAxisIndex: 2, data: heartRates, smooth: true, symbolSize: 7 },
        {
          name: "体重-配速",
          type: "scatter",
          xAxisIndex: 1,
          yAxisIndex: 3,
          data: weightPaceScatter,
          symbolSize: (value: number[]) => Math.max(8, Math.min(24, value[2] * 1.5))
        },
        {
          name: "体重-心率",
          type: "scatter",
          xAxisIndex: 1,
          yAxisIndex: 4,
          data: weightHeartRateScatter,
          symbolSize: (value: number[]) => Math.max(8, Math.min(24, value[2] * 1.5))
        },
        {
          name: "配速-心率",
          type: "scatter",
          xAxisIndex: 2,
          yAxisIndex: 5,
          data: paceHeartScatter,
          symbolSize: (value: number[]) => Math.max(8, Math.min(24, value[2] * 1.5))
        },
        {
          name: "心率拟合",
          type: "line",
          xAxisIndex: 2,
          yAxisIndex: 5,
          data: paceHeartLine,
          symbol: "none",
          lineStyle: { type: "dashed", width: 2 }
        },
        {
          name: volumeLabel,
          type: "bar",
          xAxisIndex: 3,
          yAxisIndex: 6,
          data: volumeData.map((item) => Number(item.distanceKm.toFixed(1))),
          barMaxWidth: 28
        },
        {
          name: volumeLongestLabel,
          type: "line",
          xAxisIndex: 3,
          yAxisIndex: 6,
          data: volumeData.map((item) => Number(item.longestDistanceKm.toFixed(1))),
          smooth: true,
          symbolSize: 8
        }
      ]
    });
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, [runs, weights, volumeMode]);

  return (
    <div className="research-chart">
      <div className="chart-volume-tabs" aria-label="跑量图切换">
        <button type="button" className={volumeMode === "weekly" ? "active" : ""} onClick={() => setVolumeMode("weekly")}>
          周跑量
        </button>
        <button type="button" className={volumeMode === "monthly" ? "active" : ""} onClick={() => setVolumeMode("monthly")}>
          月跑量
        </button>
      </div>
      <div className="chart" ref={ref} />
    </div>
  );
}

function PredictionPanel({ prediction, mode }: { prediction: PredictionResult | null; mode: PredictionMode }) {
  if (!prediction) {
    return <div className="panel muted-panel">等待预测数据...</div>;
  }
  const modeTitle =
    mode === "distance-date"
      ? "距离达成预测"
      : mode === "finish-date"
        ? "目标用时达成预测"
        : "指定日期完赛预测";
  const primaryLabel =
    mode === "distance-date" ? "距离达成日期" : mode === "finish-date" ? "预计达标日期" : "预计最快完赛";
  const primaryValue =
    mode === "distance-date"
      ? prediction.achievedTargetDate
        ? `已于 ${prediction.achievedTargetDate} 达成`
        : prediction.predictedDistanceDate ?? "-"
      : mode === "finish-date"
        ? prediction.predictedGoalFinishDate ?? "-"
        : prediction.predictedFinishSecAtTargetDate
          ? formatDuration(prediction.predictedFinishSecAtTargetDate)
          : "-";
  const vdotRange = prediction.vdotModel.range;
  const vdotRangeText = vdotRange ? `${vdotRange.min.toFixed(1)}-${vdotRange.max.toFixed(1)}` : "-";
  const vdotFinishText = prediction.vdotPredictedFinishRangeSec
    ? `${formatDuration(prediction.vdotPredictedFinishRangeSec.fastest)} - ${formatDuration(prediction.vdotPredictedFinishRangeSec.conservative)}`
    : "-";
  return (
    <section className="panel prediction-panel">
      <div className="prediction-hero">
        <div>
          <p className="eyebrow">{modeTitle}</p>
          <h2>{prediction.status === "ready" ? `${prediction.targetDistanceKm.toFixed(1)} km` : "数据不足"}</h2>
        </div>
        <span>{mode === "distance-date" ? "Distance" : mode === "finish-date" ? "Time Goal" : "Race Day"}</span>
      </div>
      <div className="metric-grid">
        <div className="prediction-metric primary-metric">
          <span>{primaryLabel}</span>
          <strong>{primaryValue}</strong>
        </div>
        {mode === "distance-date" && (
          <div className="prediction-metric">
            <span>VDOT 估算完赛</span>
            <strong>{vdotFinishText}</strong>
          </div>
        )}
        <div className="prediction-metric">
          <span>历史最长距离</span>
          <strong>{prediction.longestDistanceKm.toFixed(1)} km</strong>
        </div>
        <div className="prediction-metric">
          <span>当前 VDOT 范围</span>
          <strong>{vdotRangeText}</strong>
        </div>
        {mode === "finish-date" && (
          <div className="prediction-metric">
            <span>目标所需 VDOT</span>
            <strong>{prediction.requiredVdotForTargetFinish ? prediction.requiredVdotForTargetFinish.toFixed(1) : "-"}</strong>
          </div>
        )}
      </div>
      {prediction.warnings.length > 0 && (
        <ul className="warning-list">
          {prediction.warnings.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      <ul className="advice-list">
        {prediction.recommendations.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function VdotPage({ runs }: { runs: RunningRecord[] }) {
  const model = useMemo(() => buildVdotModel(runs), [runs]);
  const range = model.range;

  return (
    <section className="vdot-page">
      <section className="panel vdot-summary-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">VDOT Model</p>
            <h2>跑力值分析</h2>
          </div>
        </div>
        <div className="vdot-summary-grid">
          <div className="prediction-metric primary-metric">
            <span>当前 VDOT 范围</span>
            <strong>{range ? `${range.min.toFixed(1)}-${range.max.toFixed(1)}` : "数据不足"}</strong>
          </div>
        </div>
        <div className="pb-grid">
          {model.personalBests.map((pb) => (
            <article className="pb-card" key={pb.key}>
              <span>{pb.label}</span>
              <strong>{formatDuration(pb.estimatedDurationSec)}</strong>
              <small>
                {formatPace(pb.paceSecPerKm)} /km · VDOT {pb.vdot.toFixed(1)}
              </small>
              <small>
                来源：{pb.sourceDate} · {pb.sourceDistanceKm.toFixed(2)} km
              </small>
            </article>
          ))}
          {model.personalBests.length === 0 && <p className="muted-text">保存跑步记录后，这里会根据不同标准距离 PB 估算 VDOT。</p>}
        </div>
      </section>

      <section className="panel vdot-table-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">VDOT Chart</p>
            <h2>完整 VDOT 表</h2>
          </div>
        </div>
        <div className="vdot-table-wrap">
          <table className="vdot-table">
            <thead>
              <tr>
                <th rowSpan={2}>VDOT</th>
                {VDOT_DISTANCES.map((distance) => (
                  <th key={distance.key}>{distance.label}</th>
                ))}
                {Object.entries(TRAINING_PACE_LABELS).map(([key, label]) => (
                  <th key={key}>{label}</th>
                ))}
              </tr>
              <tr>
                {VDOT_DISTANCES.map((distance) => (
                  <th key={distance.key}>时间 / 配速</th>
                ))}
                {Object.keys(TRAINING_PACE_LABELS).map((key) => (
                  <th key={key}>/km</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.table.map((row) => (
                <tr key={row.vdot} className={row.highlighted ? "highlighted-vdot-row" : ""}>
                  <th>{row.vdot}</th>
                  {VDOT_DISTANCES.map((distance) => {
                    const race = row.racePaces[distance.key];
                    return (
                      <td key={distance.key}>
                        <strong>{formatDuration(race.durationSec)}</strong>
                        <span>{formatPace(race.paceSecPerKm)}</span>
                      </td>
                    );
                  })}
                  {Object.keys(TRAINING_PACE_LABELS).map((key) => (
                    <td key={key}>
                      <strong>{formatPace(row.trainingPaces[key as keyof typeof TRAINING_PACE_LABELS])}</strong>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function RunForm({
  editingRun,
  shoes,
  onCancelEdit,
  onSaved
}: {
  editingRun: RunningRecord | null;
  shoes: RunningShoe[];
  onCancelEdit: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<RunDraft>(() => (editingRun ? draftFromRun(editingRun) : newRunDraft()));
  const [files, setFiles] = useState<File[]>([]);
  const [filePreviews, setFilePreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [recognizedText, setRecognizedText] = useState("");

  useEffect(() => {
    setDraft(editingRun ? draftFromRun(editingRun) : newRunDraft());
    setFiles([]);
    setRecognizedText("");
  }, [editingRun]);

  useEffect(() => {
    const previews = files.map((file) => URL.createObjectURL(file));
    setFilePreviews(previews);
    return () => previews.forEach((preview) => URL.revokeObjectURL(preview));
  }, [files]);

  function setField<K extends keyof RunDraft>(key: K, value: RunDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function setSplit(index: number, key: keyof SplitDraft, value: string) {
    setDraft((current) => ({
      ...current,
      splits: current.splits.map((split, splitIndex) => (splitIndex === index ? { ...split, [key]: value } : split))
    }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const durationSec = parseDuration(draft.duration);
      const distanceKm = parseNumber(draft.distanceKm);
      const uploaded = files.length > 0 ? await api.uploadScreenshots(draft.id, files) : { keys: [] };
      const splits: RunSplit[] = draft.splits.map((split, index) => ({
        index: index + 1,
        distanceKm: parseNumber(split.distanceKm, 1),
        paceSecPerKm: parsePace(split.pace),
        heartRateBpm: parseNumber(split.heartRateBpm),
        powerW: parseNumber(split.powerW),
        cadenceSpm: parseNumber(split.cadenceSpm)
      }));
      const payload: RunningRecord = {
        id: draft.id,
        dateTime: new Date(draft.dateTime).toISOString(),
        shoeId: draft.shoeId || null,
        distanceKm,
        durationSec,
        avgPaceSecPerKm: draft.avgPace ? parsePace(draft.avgPace) : durationSec / distanceKm,
        avgPowerW: parseNumber(draft.avgPowerW),
        avgCadenceSpm: parseNumber(draft.avgCadenceSpm),
        avgHeartRateBpm: parseNumber(draft.avgHeartRateBpm),
        weather: {
          temperatureC: draft.temperatureC ? parseNumber(draft.temperatureC) : null,
          humidityPct: draft.humidityPct ? parseNumber(draft.humidityPct) : null,
          aqi: draft.aqi ? parseNumber(draft.aqi) : null
        },
        notes: draft.notes,
        splits,
        screenshotKeys: [...draft.screenshotKeys, ...uploaded.keys],
        createdAt: editingRun?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if (editingRun) {
        await api.updateRun(payload);
      } else {
        await api.createRun(payload);
      }
      setDraft(newRunDraft());
      setFiles([]);
      setRecognizedText("");
      setMessage(editingRun ? "跑步记录已更新。" : "跑步记录已保存。");
      onSaved();
      onCancelEdit();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }

  async function recognizeScreenshots() {
    if (files.length === 0) {
      setMessage("请先选择一张或多张截图。");
      return;
    }
    setMessage(window.TextDetector ? "正在使用浏览器内置识别，请稍等。" : "正在使用兼容 OCR 识别，首次加载可能需要几十秒。");
    try {
      const text = await detectTextFromImages(files);
      const patch = extractRunDraftFromText(text);
      setRecognizedText(text || "未识别到文本。");
      setDraft((current) => ({ ...current, ...patch }));
      setMessage("已根据截图尝试预填，请检查并确认后再保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "截图识别失败，请手动校对录入。");
    }
  }

  async function recognizeSplits() {
    if (files.length === 0) {
      setMessage("请先选择一张或多张单段截图。");
      return;
    }
    const totalDistanceKm = Number(draft.distanceKm);
    if (!Number.isFinite(totalDistanceKm) || totalDistanceKm <= 0) {
      setMessage("请先填写本次跑步总距离，再识别单段数据。");
      return;
    }
    setMessage(window.TextDetector ? "正在识别单段截图，请稍等。" : "正在使用兼容 OCR 识别单段，首次加载可能需要几十秒。");
    try {
      const text = await detectTextFromImages(files);
      const result = extractSplitsFromText(text, totalDistanceKm);
      setRecognizedText(text || "未识别到文本。");
      if (result.splits.length === 0) {
        setMessage("未识别到可用单段数据，请检查截图是否包含段号、配速、心率、功率或步频。");
        return;
      }
      setDraft((current) => ({ ...current, splits: result.splits }));
      const droppedText =
        result.droppedIndexes.length > 0 ? `已按总距离丢弃第 ${result.droppedIndexes.join("、")} 段尾段。` : "没有发现需要丢弃的尾段。";
      setMessage(`已识别 ${result.detectedCount} 段，保留 ${result.splits.length} 段完整公里。${droppedText}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "单段截图识别失败，请手动校对录入。");
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Run Entry</p>
          <h2>{editingRun ? "编辑跑步记录" : "跑步记录"}</h2>
        </div>
        <div className="inline-actions">
          {editingRun && (
            <button type="button" className="ghost-button" onClick={onCancelEdit}>
              取消编辑
            </button>
          )}
          <button type="button" className="ghost-button" onClick={() => setField("splits", [...draft.splits, { ...emptySplit }])}>
            + 分段
          </button>
        </div>
      </div>
      <form className="data-form run-form" onSubmit={submit}>
        <label className="wide">
          日期时间
          <input type="datetime-local" value={draft.dateTime} onChange={(event) => setField("dateTime", event.target.value)} />
        </label>
        <label className="wide">
          本次跑鞋
          <select value={draft.shoeId} onChange={(event) => setField("shoeId", event.target.value)}>
            <option value="">未选择跑鞋</option>
            {shoes.map((shoe) => (
              <option key={shoe.id} value={shoe.id}>
                {shoe.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-row wide two-cols">
          <label>
            距离 km
            <input value={draft.distanceKm} onChange={(event) => setField("distanceKm", event.target.value)} inputMode="decimal" />
          </label>
          <label>
            总用时
            <input value={draft.duration} onChange={(event) => setField("duration", event.target.value)} placeholder="45:30 或 1:35:20" />
          </label>
        </div>
        <div className="form-section wide">
          <p>跑步表现</p>
          <div className="performance-grid">
            <label>
              平均配速
              <input value={draft.avgPace} onChange={(event) => setField("avgPace", event.target.value)} placeholder="5:20" />
            </label>
            <label>
              平均心率 bpm
              <input value={draft.avgHeartRateBpm} onChange={(event) => setField("avgHeartRateBpm", event.target.value)} inputMode="decimal" />
            </label>
            <label>
              平均步频 spm
              <input value={draft.avgCadenceSpm} onChange={(event) => setField("avgCadenceSpm", event.target.value)} inputMode="decimal" />
            </label>
            <label>
              平均功率 W
              <input value={draft.avgPowerW} onChange={(event) => setField("avgPowerW", event.target.value)} inputMode="decimal" />
            </label>
          </div>
        </div>
        <div className="form-section weather-section wide">
          <p>环境</p>
          <div className="weather-grid">
            <label>
              气温 ℃
              <input value={draft.temperatureC} onChange={(event) => setField("temperatureC", event.target.value)} inputMode="decimal" />
            </label>
            <label>
              湿度 %
              <input value={draft.humidityPct} onChange={(event) => setField("humidityPct", event.target.value)} inputMode="decimal" />
            </label>
            <label>
              AQI
              <input value={draft.aqi} onChange={(event) => setField("aqi", event.target.value)} inputMode="decimal" />
            </label>
          </div>
        </div>
        <label className="wide">
          主观感受 / 备注
          <textarea
            value={draft.notes}
            maxLength={2000}
            onChange={(event) => setField("notes", event.target.value)}
            placeholder="例如：感觉轻松、后半程心率偏高、睡眠不足、天气闷热、腿部疲劳等"
          />
        </label>
        <label className="wide">
          Apple Watch 截图
          <input type="file" accept="image/*" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
        </label>
        {filePreviews.length > 0 && (
          <div className="wide screenshot-review">
            <div className="screenshot-toolbar">
              <strong>截图待确认</strong>
              <div className="inline-actions">
                <button type="button" className="ghost-button" onClick={recognizeScreenshots}>
                  识别总览
                </button>
                <button type="button" className="ghost-button" onClick={recognizeSplits}>
                  识别单段
                </button>
              </div>
            </div>
            <div className="screenshot-grid">
              {filePreviews.map((preview, index) => (
                <img key={preview} src={preview} alt={`running screenshot ${index + 1}`} />
              ))}
            </div>
            {recognizedText && <textarea readOnly value={recognizedText} aria-label="recognized text" />}
          </div>
        )}
        {draft.splits.length > 0 && (
          <div className="split-table wide">
            {draft.splits.map((split, index) => (
              <div className="split-row" key={index}>
                <strong>{index + 1}</strong>
                <input value={split.distanceKm} onChange={(event) => setSplit(index, "distanceKm", event.target.value)} placeholder="km" />
                <input value={split.pace} onChange={(event) => setSplit(index, "pace", event.target.value)} placeholder="配速" />
                <input value={split.heartRateBpm} onChange={(event) => setSplit(index, "heartRateBpm", event.target.value)} placeholder="心率" />
                <input value={split.powerW} onChange={(event) => setSplit(index, "powerW", event.target.value)} placeholder="功率" />
                <input value={split.cadenceSpm} onChange={(event) => setSplit(index, "cadenceSpm", event.target.value)} placeholder="步频" />
              </div>
            ))}
          </div>
        )}
        {message && <p className="form-message wide">{message}</p>}
        <button className="primary-button wide" disabled={busy}>
          {busy ? "保存中..." : editingRun ? "确认更新记录" : "保存跑步记录"}
        </button>
      </form>
    </section>
  );
}

function ShoeLibrary({
  shoes,
  runs,
  onChanged
}: {
  shoes: RunningShoe[];
  runs: RunningRecord[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState("");
  const [editingShoe, setEditingShoe] = useState<RunningShoe | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!photo) {
      setPhotoPreview("");
      return;
    }
    const preview = URL.createObjectURL(photo);
    setPhotoPreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [photo]);

  useEffect(() => {
    if (!editingShoe) return;
    setName(editingShoe.name);
    setPhoto(null);
    setMessage("");
  }, [editingShoe]);

  const mileageByShoe = useMemo(() => {
    const totals = new Map<string, number>();
    for (const run of runs) {
      if (!run.shoeId) continue;
      totals.set(run.shoeId, (totals.get(run.shoeId) ?? 0) + run.distanceKm);
    }
    return totals;
  }, [runs]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setMessage("请填写跑鞋名称。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const now = new Date().toISOString();
      const shoeId = editingShoe?.id ?? createLocalId();
      const uploaded = photo ? await api.uploadShoePhoto(shoeId, photo) : { key: null, url: null };
      const shoe: RunningShoe = {
        id: shoeId,
        name: trimmedName,
        photoKey: uploaded.key ?? editingShoe?.photoKey ?? null,
        photoUrl: uploaded.url ?? editingShoe?.photoUrl ?? null,
        createdAt: editingShoe?.createdAt ?? now,
        updatedAt: now
      };
      if (editingShoe) {
        await api.updateShoe(shoe);
      } else {
        await api.createShoe(shoe);
      }
      setName("");
      setPhoto(null);
      setEditingShoe(null);
      setMessage(editingShoe ? "跑鞋已更新。" : "跑鞋已添加。");
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存跑鞋失败。");
    } finally {
      setBusy(false);
    }
  }

  function cancelEdit() {
    setEditingShoe(null);
    setName("");
    setPhoto(null);
    setMessage("");
  }

  async function removeShoe(shoe: RunningShoe) {
    const usedKm = mileageByShoe.get(shoe.id) ?? 0;
    const ok = window.confirm(`确定删除「${shoe.name}」吗？已关联的 ${formatKm(usedKm)} km 跑步记录会变为未选择跑鞋。`);
    if (!ok) return;
    await api.deleteShoe(shoe.id);
    onChanged();
  }

  return (
    <section className="shoe-page">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Shoe Library</p>
            <h2>{editingShoe ? "编辑跑鞋" : "鞋库"}</h2>
          </div>
          {editingShoe && (
            <button type="button" className="ghost-button" onClick={cancelEdit}>
              取消编辑
            </button>
          )}
        </div>
        <form className="shoe-form" onSubmit={submit}>
          <label>
            跑鞋名称
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 Nike Pegasus 41" />
          </label>
          <label>
            跑鞋照片
            <input type="file" accept="image/*" onChange={(event) => setPhoto(event.target.files?.[0] ?? null)} />
          </label>
          {(photoPreview || (editingShoe && shoePhotoSrc(editingShoe))) && (
            <img className="shoe-preview" src={photoPreview || shoePhotoSrc(editingShoe!)} alt="跑鞋照片预览" />
          )}
          <button className="primary-button" disabled={busy}>
            {busy ? "保存中..." : editingShoe ? "保存修改" : "添加跑鞋"}
          </button>
          {message && <p className="form-message">{message}</p>}
        </form>
      </section>

      <section className="shoe-grid">
        {shoes.map((shoe) => {
          const usedKm = mileageByShoe.get(shoe.id) ?? 0;
          const imageSrc = shoePhotoSrc(shoe);
          return (
            <article className="shoe-card" key={shoe.id}>
              <div className="shoe-photo">
                {imageSrc ? <img src={imageSrc} alt={shoe.name} /> : <span>{shoe.name.slice(0, 2).toUpperCase()}</span>}
              </div>
              <div className="shoe-card-body">
                <div className="shoe-card-heading">
                  <div>
                    <p className="eyebrow">Running Shoe</p>
                    <h3>{shoe.name}</h3>
                  </div>
                  <div className="shoe-actions">
                    <button type="button" className="ghost-button small-button" onClick={() => setEditingShoe(shoe)}>
                      编辑
                    </button>
                    <button type="button" className="ghost-button small-button danger-button" onClick={() => removeShoe(shoe)}>
                      删除
                    </button>
                  </div>
                </div>
                <div className="shoe-mileage">
                  <span>累计跑量</span>
                  <strong>{formatKm(usedKm)} km</strong>
                </div>
              </div>
            </article>
          );
        })}
        {shoes.length === 0 && <div className="empty-shoes">添加第一双跑鞋后，这里会显示它的照片、名称和累计里程。</div>}
      </section>
    </section>
  );
}

function WeightForm({ editingWeight, onCancelEdit, onSaved }: { editingWeight: WeightRecord | null; onCancelEdit: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(editingWeight?.date ?? new Date().toISOString().slice(0, 10));
  const [weightKg, setWeightKg] = useState(editingWeight ? String(editingWeight.weightKg) : "");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setDate(editingWeight?.date ?? new Date().toISOString().slice(0, 10));
    setWeightKg(editingWeight ? String(editingWeight.weightKg) : "");
    setMessage("");
  }, [editingWeight]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.saveWeight({ date, weightKg: parseNumber(weightKg) });
      if (editingWeight && editingWeight.date !== date) {
        await api.deleteWeight(editingWeight.date);
      }
      setWeightKg("");
      setMessage(editingWeight ? "体重记录已更新。" : "体重记录已保存。");
      onSaved();
      onCancelEdit();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败。");
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Weight Entry</p>
          <h2>{editingWeight ? "编辑体重记录" : "体重记录"}</h2>
        </div>
        {editingWeight && (
          <button type="button" className="ghost-button" onClick={onCancelEdit}>
            取消编辑
          </button>
        )}
      </div>
      <form className="data-form compact" onSubmit={submit}>
        <label>
          日期
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        <label>
          体重 kg
          <input value={weightKg} onChange={(event) => setWeightKg(event.target.value)} inputMode="decimal" />
        </label>
        <button className="primary-button">{editingWeight ? "确认更新体重" : "保存体重"}</button>
        {message && <p className="form-message wide">{message}</p>}
      </form>
    </section>
  );
}

function HistoryManager({
  runs,
  shoes,
  weights,
  onEditRun,
  onEditWeight,
  onDeleteRun,
  onDeleteWeight
}: {
  runs: RunningRecord[];
  shoes: RunningShoe[];
  weights: WeightRecord[];
  onEditRun: (run: RunningRecord) => void;
  onEditWeight: (weight: WeightRecord) => void;
  onDeleteRun: (run: RunningRecord) => void;
  onDeleteWeight: (weight: WeightRecord) => void;
}) {
  const months = groupHistoryByMonth(runs, weights);
  const shoeNames = useMemo(() => new Map(shoes.map((shoe) => [shoe.id, shoe.name])), [shoes]);
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(() => new Set());

  function toggleMonth(month: string) {
    setExpandedMonths((current) => {
      const next = new Set(current);
      if (next.has(month)) {
        next.delete(month);
      } else {
        next.add(month);
      }
      return next;
    });
  }

  return (
    <section className="panel history-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">History</p>
          <h2>历史记录管理</h2>
        </div>
      </div>
      <div className="history-list">
        {months.map((month) => {
          const isExpanded = expandedMonths.has(month.month);
          return (
            <section className="history-month" key={month.month}>
              <button
                type="button"
                className="history-month-heading"
                aria-expanded={isExpanded}
                onClick={() => toggleMonth(month.month)}
              >
                <span className="history-month-title">
                  <strong>{month.month}</strong>
                  <span>
                    {month.runs.length} 次跑步 · {month.weights.length} 条体重
                  </span>
                </span>
                <span className="history-month-toggle">{isExpanded ? "收起" : "展开"}</span>
              </button>
              {isExpanded && (
                <div className="history-columns">
                  <div>
                    <h3>跑步</h3>
                    <div className="history-items">
                      {month.runs.map((run) => {
                        const shoeName = run.shoeId ? shoeNames.get(run.shoeId) ?? "已删除跑鞋" : "";
                        return (
                          <div className="history-item" key={run.id}>
                            <div className="history-item-main">
                              <div className="history-title-row">
                                <strong>{run.dateTime.slice(0, 10)}</strong>
                                <span className="history-badges">
                                  {run.splits.length > 0 && (
                                    <span className="history-badge split-badge" title={`${run.splits.length} 段`} aria-label={`${run.splits.length} 段`}>
                                      <span className="badge-icon" aria-hidden="true">≡</span>
                                      <span className="badge-check" aria-hidden="true">✓</span>
                                    </span>
                                  )}
                                  {run.shoeId && (
                                    <span className="history-badge shoe-badge" title={shoeName} aria-label={shoeName}>
                                      <span className="badge-icon" aria-hidden="true">⌁</span>
                                      <span className="badge-check" aria-hidden="true">✓</span>
                                    </span>
                                  )}
                                </span>
                              </div>
                              <div className="history-stat-row">
                                <span className="history-stat">
                                  <small>里程</small>
                                  <b>{run.distanceKm.toFixed(2)} km</b>
                                </span>
                                <span className="history-stat">
                                  <small>配速</small>
                                  <b>{formatPace(run.avgPaceSecPerKm)} /km</b>
                                </span>
                                <span className="history-stat">
                                  <small>用时</small>
                                  <b>{formatDuration(run.durationSec)}</b>
                                </span>
                              </div>
                            </div>
                            <div className="record-actions">
                              <button type="button" className="ghost-button small-button" onClick={() => onEditRun(run)}>
                                编辑
                              </button>
                              <button type="button" className="ghost-button small-button danger-button" onClick={() => onDeleteRun(run)}>
                                删除
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      {month.runs.length === 0 && <p className="muted-text">本月没有跑步记录。</p>}
                    </div>
                  </div>
                  <div>
                    <h3>体重</h3>
                    <div className="history-items">
                      {month.weights.map((weight) => (
                        <div className="history-item" key={weight.date}>
                          <div className="history-item-main">
                            <strong>{weight.date}</strong>
                            <div className="history-stat-row weight-stat-row">
                              <span className="history-stat weight-stat">
                                <small>体重</small>
                                <b>{weight.weightKg.toFixed(1)} kg</b>
                              </span>
                            </div>
                          </div>
                          <div className="record-actions">
                            <button type="button" className="ghost-button small-button" onClick={() => onEditWeight(weight)}>
                              编辑
                            </button>
                            <button type="button" className="ghost-button small-button danger-button" onClick={() => onDeleteWeight(weight)}>
                              删除
                            </button>
                          </div>
                        </div>
                      ))}
                      {month.weights.length === 0 && <p className="muted-text">本月没有体重记录。</p>}
                    </div>
                  </div>
                </div>
              )}
            </section>
          );
        })}
        {months.length === 0 && <p className="muted-text">还没有历史记录。</p>}
      </div>
    </section>
  );
}

function Dashboard({ user, onLogout }: { user: PublicUser; onLogout: () => void }) {
  const [runs, setRuns] = useState<RunningRecord[]>([]);
  const [shoes, setShoes] = useState<RunningShoe[]>([]);
  const [weights, setWeights] = useState<WeightRecord[]>([]);
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [targetDistance, setTargetDistance] = useState(21.0975);
  const [targetDistanceInput, setTargetDistanceInput] = useState("21.0975");
  const [predictionMode, setPredictionMode] = useState<PredictionMode>("distance-date");
  const [appliedPredictionMode, setAppliedPredictionMode] = useState<PredictionMode>("distance-date");
  const [targetFinishInput, setTargetFinishInput] = useState("2:00:00");
  const [appliedTargetFinishInput, setAppliedTargetFinishInput] = useState("2:00:00");
  const [targetDateInput, setTargetDateInput] = useState(() => {
    const date = new Date();
    date.setMonth(date.getMonth() + 6);
    return date.toISOString().slice(0, 10);
  });
  const [appliedTargetDateInput, setAppliedTargetDateInput] = useState(targetDateInput);
  const [targetError, setTargetError] = useState("");
  const [loading, setLoading] = useState(true);
  const [editingRun, setEditingRun] = useState<RunningRecord | null>(null);
  const [editingWeight, setEditingWeight] = useState<WeightRecord | null>(null);
  const [activeView, setActiveView] = useState<AppView>("home");

  function scrollToForms() {
    setActiveView("records");
    requestAnimationFrame(() => {
      document.querySelector(".records-page")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function refresh() {
    setLoading(true);
    const [runData, shoeData, weightData, predictionData] = await Promise.all([
      api.listRuns(),
      api.listShoes(),
      api.listWeights(),
      api.prediction({
        targetDistanceKm: targetDistance,
        targetFinishSec: appliedPredictionMode === "finish-date" ? parseDuration(appliedTargetFinishInput) : null,
        targetDate: appliedPredictionMode === "date-finish" ? appliedTargetDateInput : null
      })
    ]);
    setRuns(runData.runs);
    setShoes(shoeData.shoes);
    setWeights(weightData.weights);
    setPrediction(predictionData.prediction);
    setLoading(false);
  }

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [targetDistance, appliedPredictionMode, appliedTargetFinishInput, appliedTargetDateInput]);

  const summary = useMemo(() => {
    const totalDistance = runs.reduce((sum, run) => sum + run.distanceKm, 0);
    const bestPace = runs.length ? Math.min(...runs.map((run) => run.avgPaceSecPerKm)) : null;
    const latestWeight = weights[0]?.weightKg ?? null;
    return { totalDistance, bestPace, latestWeight };
  }, [runs, weights]);

  const targetIsDirty =
    targetDistanceInput !== String(targetDistance) ||
    predictionMode !== appliedPredictionMode ||
    targetFinishInput !== appliedTargetFinishInput ||
    targetDateInput !== appliedTargetDateInput;

  function applyPredictionTarget(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const trimmedDistance = targetDistanceInput.trim();
    if (!isCompleteDecimalInput(trimmedDistance)) {
      setTargetError("请先完整输入目标距离。");
      return;
    }

    const nextDistance = Number(trimmedDistance);
    if (!Number.isFinite(nextDistance) || nextDistance <= 0) {
      setTargetError("目标距离需要大于 0。");
      return;
    }

    setTargetError("");
    setTargetDistance(nextDistance);
    setTargetDistanceInput(String(nextDistance));
    setAppliedPredictionMode(predictionMode);
    setAppliedTargetFinishInput(targetFinishInput);
    setAppliedTargetDateInput(targetDateInput);
  }

  async function deleteRunRecord(run: RunningRecord) {
    const ok = window.confirm(`确定删除 ${run.dateTime.slice(0, 10)} 的跑步记录吗？此操作不能撤销。`);
    if (!ok) return;
    await api.deleteRun(run.id);
    if (editingRun?.id === run.id) {
      setEditingRun(null);
    }
    await refresh();
  }

  async function deleteWeightRecord(weight: WeightRecord) {
    const ok = window.confirm(`确定删除 ${weight.date} 的体重记录吗？此操作不能撤销。`);
    if (!ok) return;
    await api.deleteWeight(weight.date);
    if (editingWeight?.date === weight.date) {
      setEditingWeight(null);
    }
    await refresh();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Running Platform</p>
          <h1>跑步数据分析台</h1>
          <nav className="view-tabs" aria-label="页面切换">
            <button
              type="button"
              className={activeView === "home" ? "active" : ""}
              onClick={() => setActiveView("home")}
              aria-current={activeView === "home" ? "page" : undefined}
            >
              主页
            </button>
            <button
              type="button"
              className={activeView === "records" ? "active" : ""}
              onClick={() => setActiveView("records")}
              aria-current={activeView === "records" ? "page" : undefined}
            >
              记录
            </button>
            <button
              type="button"
              className={activeView === "vdot" ? "active" : ""}
              onClick={() => setActiveView("vdot")}
              aria-current={activeView === "vdot" ? "page" : undefined}
            >
              跑力值
            </button>
            <button
              type="button"
              className={activeView === "shoes" ? "active" : ""}
              onClick={() => setActiveView("shoes")}
              aria-current={activeView === "shoes" ? "page" : undefined}
            >
              鞋库
            </button>
          </nav>
        </div>
        <div className="user-actions">
          <span>{user.username}</span>
          <button className="ghost-button" onClick={onLogout}>退出</button>
        </div>
      </header>

      {activeView === "home" && (
        <>
          <section className="hero-grid">
            <div className="chart-panel">
              <div className="panel-heading chart-heading">
                <div>
                  <p className="eyebrow">Trend Model</p>
                  <h2>跑步表现与训练负荷</h2>
                </div>
                <form className="target-controls" onSubmit={applyPredictionTarget}>
                  <label className="target-input">
                    预测模式
                    <select value={predictionMode} onChange={(event) => setPredictionMode(event.target.value as PredictionMode)}>
                      <option value="distance-date">只看距离达成日期</option>
                      <option value="finish-date">目标距离 + 完赛时间</option>
                      <option value="date-finish">目标距离 + 达成日期</option>
                    </select>
                  </label>
                  <label className="target-input">
                    目标距离 km
                    <input
                      inputMode="decimal"
                      value={targetDistanceInput}
                      onChange={(event) => setTargetDistanceInput(event.target.value)}
                    />
                  </label>
                  {predictionMode === "finish-date" && (
                    <label className="target-input">
                      目标完赛
                      <input value={targetFinishInput} onChange={(event) => setTargetFinishInput(event.target.value)} placeholder="2:00:00" />
                    </label>
                  )}
                  {predictionMode === "date-finish" && (
                    <label className="target-input">
                      目标日期
                      <input type="date" value={targetDateInput} onChange={(event) => setTargetDateInput(event.target.value)} />
                    </label>
                  )}
                  <div className="target-apply">
                    <button type="submit" className="primary-button small-primary">
                      更新预测
                    </button>
                    {targetIsDirty && <span>未应用</span>}
                  </div>
                  {targetError && <p className="target-error">{targetError}</p>}
                </form>
              </div>
              {runs.length ? <ResearchChart runs={runs} weights={weights} /> : <div className="empty-chart">保存跑步记录后显示趋势图。</div>}
            </div>
            <PredictionPanel prediction={prediction} mode={appliedPredictionMode} />
          </section>

          <section className="summary-grid">
            <div className="metric-card">
              <span>累计距离</span>
              <strong>{summary.totalDistance.toFixed(1)} km</strong>
            </div>
            <div className="metric-card">
              <span>最佳平均配速</span>
              <strong>{summary.bestPace ? formatPace(summary.bestPace) : "-"}</strong>
            </div>
            <div className="metric-card">
              <span>最新体重</span>
              <strong>{summary.latestWeight ? `${summary.latestWeight.toFixed(1)} kg` : "-"}</strong>
            </div>
            <div className="metric-card">
              <span>记录次数</span>
              <strong>{runs.length}</strong>
            </div>
          </section>
        </>
      )}

      {activeView === "records" && (
        <section className="records-page">
          <section className="workspace-grid">
            <RunForm shoes={shoes} editingRun={editingRun} onCancelEdit={() => setEditingRun(null)} onSaved={refresh} />
            <div className="side-column">
              <WeightForm editingWeight={editingWeight} onCancelEdit={() => setEditingWeight(null)} onSaved={refresh} />
              {loading && <span className="loading-dot">同步中</span>}
            </div>
          </section>
          <HistoryManager
            runs={runs}
            shoes={shoes}
            weights={weights}
            onEditRun={(run) => {
              setEditingRun(run);
              scrollToForms();
            }}
            onEditWeight={(weight) => {
              setEditingWeight(weight);
              scrollToForms();
            }}
            onDeleteRun={deleteRunRecord}
            onDeleteWeight={deleteWeightRecord}
          />
        </section>
      )}

      {activeView === "vdot" && <VdotPage runs={runs} />}

      {activeView === "shoes" && (
        <ShoeLibrary shoes={shoes} runs={runs} onChanged={refresh} />
      )}
    </main>
  );
}

export default function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => setBooted(true));
  }, []);

  async function logout() {
    await api.logout().catch(() => undefined);
    setUser(null);
  }

  if (!booted) {
    return <div className="boot-screen">Loading...</div>;
  }

  return <ErrorBoundary>{user ? <Dashboard user={user} onLogout={logout} /> : <AuthDialog onAuthed={setUser} />}</ErrorBoundary>;
}
