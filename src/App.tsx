import * as echarts from "echarts";
import { Component, Fragment, type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { classifyGestureDirection, nearestPixelIndex, type GestureDirection } from "./chartInteraction";
import {
  extractRunDraftFromText as extractRunDraftFromOcrText,
  extractSplitsFromText as extractSplitsFromOcrText,
  getRunOcrWarnings,
  type SplitDraft,
  type SplitMetricField,
  type SplitOcrResult
} from "./ocr";
import { buildHeartRateBaseline, type HeartRateBaseline } from "@shared/physiology";
import { buildPrediction, buildPredictionBacktest } from "@shared/predictions";
import { runLocalDate, runLocalMonth } from "@shared/runDates";
import { normalizeTailDurationInput } from "@shared/timeInputs";
import { TRAINING_PLAN_SYSTEM_GUIDANCE } from "@shared/aiPrompts";
import type {
  AiDeepAnalysis,
  AiPredictionAnalysis,
  DeepseekKeyStatus,
  PredictionMode,
  PredictionBacktestEntry,
  PredictionBacktestResult,
  PredictionResult,
  PublicUser,
  RunnerProfile,
  RunnerSex,
  RunningRecord,
  RunningShoe,
  RunSplit,
  WeightRecord
} from "@shared/types";
import { TRAINING_PACE_LABELS, VDOT_DISTANCES, buildVdotModel } from "@shared/vdot";

type AuthMode = "login" | "register";
type AppView = "home" | "records" | "vdot" | "prediction" | "shoes";
type VolumeChartMode = "weekly" | "monthly";
type ProCacheStatus = "restored" | "missing" | "outdated" | "target-date-passed" | "target-date-required";
type HistoryMonth = {
  month: string;
  runs: RunningRecord[];
  weights: WeightRecord[];
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
  effortScore: string;
  performanceType: "" | "race";
  elevationGainM: string;
  temperatureC: string;
  humidityPct: string;
  aqi: string;
  notes: string;
  splits: SplitDraft[];
  screenshotKeys: string[];
};

type RunnerProfileDraft = {
  birthDate: string;
  sex: RunnerSex | "";
  heightCm: string;
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

const emptyTailSplit: SplitDraft = {
  kind: "tail",
  duration: "",
  distanceKm: "",
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
    effortScore: "",
    performanceType: "",
    elevationGainM: "",
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
    effortScore: run.effortScore === null || run.effortScore === undefined ? "" : String(run.effortScore),
    performanceType: run.performanceType === "race" ? "race" : "",
    elevationGainM: run.elevationGainM === null || run.elevationGainM === undefined ? "" : String(run.elevationGainM),
    temperatureC: run.weather.temperatureC === null ? "" : String(run.weather.temperatureC),
    humidityPct: run.weather.humidityPct === null ? "" : String(run.weather.humidityPct),
    aqi: run.weather.aqi === null ? "" : String(run.weather.aqi),
    notes: run.notes ?? "",
    splits: run.splits.map((split) => split.kind === "tail"
      ? {
          kind: "tail",
          duration: formatDuration(split.durationSec ?? 0),
          distanceKm: "",
          pace: "",
          heartRateBpm: "",
          powerW: "",
          cadenceSpm: ""
        }
      : {
          distanceKm: String(split.distanceKm),
          pace: formatPace(split.paceSecPerKm),
          heartRateBpm: String(split.heartRateBpm),
          powerW: String(split.powerW),
          cadenceSpm: String(split.cadenceSpm)
        }),
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

function normalizeClockInput(value: string): string {
  const compact = value.trim().replace(/\s/g, "");
  if (!compact || compact.includes(":") || !/^\d+$/.test(compact) || compact.length <= 2) {
    return value.trim();
  }
  if (compact.length <= 4) {
    return `${compact.slice(0, -2)}:${compact.slice(-2)}`;
  }
  if (compact.length <= 6) {
    return `${compact.slice(0, -4)}:${compact.slice(-4, -2)}:${compact.slice(-2)}`;
  }
  return value.trim();
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
  const roundedSeconds = Math.round(seconds);
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const rest = roundedSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function predictionErrorLabel(errorSec: number, actualFinishSec: number): string {
  if (!Number.isFinite(errorSec) || !Number.isFinite(actualFinishSec) || actualFinishSec <= 0) return "误差 -";
  if (Math.abs(errorSec) < 0.5) return "与实际一致";
  const errorPercent = Math.abs(errorSec) / actualFinishSec * 100;
  return `预测偏${errorSec > 0 ? "慢" : "快"} ${formatDuration(Math.abs(errorSec))}（${errorPercent.toFixed(1)}%）`;
}

function BacktestDetailRow({ entry }: { entry: PredictionBacktestEntry }) {
  return (
    <article className="backtest-history-row">
      <header><span>{entry.date}</span><strong>{entry.benchmarkLabel}</strong></header>
      <div className="backtest-history-values">
        <div><span>实际成绩</span><strong>{formatDuration(entry.actualFinishSec)}</strong></div>
        <div><span>智能预测</span><strong>{formatDuration(entry.smartPredictedFinishSec)}</strong></div>
        <div><span>VDOT 对照</span><strong>{formatDuration(entry.vdotPredictedFinishSec)}</strong></div>
      </div>
      <p className="backtest-history-error">{predictionErrorLabel(entry.smartErrorSec, entry.actualFinishSec)}</p>
      <p className="backtest-history-inputs">
        当时使用 {entry.inputRunCount} 条历史跑步 · {entry.performanceSampleCount} 条表现数据 · {entry.calibrationSampleCount} 条个人校准样本 · 可信度 {entry.smartConfidenceScore}/100
      </p>
    </article>
  );
}

function formatKm(value: number): string {
  if (!Number.isFinite(value)) return "0.0";
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function sortRuns(records: RunningRecord[]): RunningRecord[] {
  return [...records].sort((a, b) => new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime());
}

function sortShoes(records: RunningShoe[]): RunningShoe[] {
  return [...records].sort((a, b) => a.name.localeCompare(b.name));
}

function sortWeights(records: WeightRecord[]): WeightRecord[] {
  return [...records].sort((a, b) => b.date.localeCompare(a.date));
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
    const month = runLocalMonth(run);
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

function isoWeekKey(dateKey: string): string {
  const [year, month, dayOfMonth] = dateKey.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, dayOfMonth));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function weeklyMileage(runs: RunningRecord[]): Array<{ week: string; distanceKm: number; longestDistanceKm: number }> {
  const totals = new Map<string, { distanceKm: number; longestDistanceKm: number }>();
  for (const run of runs) {
    const week = isoWeekKey(runLocalDate(run));
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
    const month = runLocalMonth(run);
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

function SplitBadgeIcon() {
  return (
    <svg className="badge-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 6h10M7 12h10M7 18h10" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="18" r="1" />
    </svg>
  );
}

function ShoeBadgeIcon() {
  return (
    <svg className="badge-svg shoe-svg" viewBox="0 0 32 24" aria-hidden="true">
      <path d="M4 15.5c3.6 1.2 7.1 1.7 10.5 1.4 1.5-.1 2.6-1 3.2-2.4l.5-1.1c2.4 2.2 5 3.5 7.8 4 .9.2 1.5.9 1.4 1.8-.1.8-.8 1.4-1.7 1.4H6.2c-1.7 0-3.2-1-3.8-2.6-.4-1 .5-2.1 1.6-1.7Z" />
      <path d="M8.4 8.4c1.5 1.8 3.2 3 5.2 3.7" />
      <path d="M22.8 15.5c.8-1.1 1.1-2.2 1-3.4" />
    </svg>
  );
}

function HistoryDataBadge({
  present,
  title,
  children,
  className
}: {
  present: boolean;
  title: string;
  children: ReactNode;
  className: string;
}) {
  return (
    <span
      className={`history-badge ${className} ${present ? "present" : "missing"}`}
      title={title}
      aria-label={title}
    >
      <span className="badge-icon" aria-hidden="true">{children}</span>
      <span className="badge-check" aria-hidden="true">{present ? "✓" : "×"}</span>
    </span>
  );
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
    droppedIndexes,
    incompleteIndexes: [],
    missingIndexes: [],
    ambiguousFields: []
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

function effortCropRectangle(width: number, height: number) {
  const left = Math.floor(width * 0.06);
  const top = Math.floor(height * 0.82);
  const right = Math.floor(width * 0.18);
  const bottom = Math.floor(height * 0.88);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

async function createEffortScoreCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const rectangle = effortCropRectangle(bitmap.width, bitmap.height);
  const scale = 4;
  const canvas = document.createElement("canvas");
  canvas.width = rectangle.width * scale;
  canvas.height = rectangle.height * scale;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error("无法创建耗能评分识别画布");
  }
  context.imageSmoothingEnabled = false;
  context.drawImage(
    bitmap,
    rectangle.left,
    rectangle.top,
    rectangle.width,
    rectangle.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
  bitmap.close();

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < image.data.length; index += 4) {
    const isBrightGlyph = Math.max(image.data[index], image.data[index + 1], image.data[index + 2]) >= 125;
    const value = isBrightGlyph ? 0 : 255;
    image.data[index] = value;
    image.data[index + 1] = value;
    image.data[index + 2] = value;
    image.data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

async function createSplitOcrCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const isPortraitScreenshot = bitmap.height > bitmap.width * 1.3;
  const sourceHeight = isPortraitScreenshot ? Math.floor(bitmap.height * 0.68) : bitmap.height;
  const scale = 1.5;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(sourceHeight * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error("无法创建单段增强识别画布");
  }
  context.imageSmoothingEnabled = false;
  context.drawImage(bitmap, 0, 0, bitmap.width, sourceHeight, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < image.data.length; index += 4) {
    // Apple Watch 深色页面上的白色和彩色数字都具有较高的单通道亮度。
    // 二值化后再识别一次，可减少 3 的开口被噪点封闭成 8 的情况。
    const maxChannel = Math.max(image.data[index], image.data[index + 1], image.data[index + 2]);
    const value = maxChannel >= 120 ? 0 : 255;
    image.data[index] = value;
    image.data[index + 1] = value;
    image.data[index + 2] = value;
    image.data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

async function detectTextFromImages(files: File[], includeEffortRegion = false, includeSplitEnhancement = false): Promise<string> {
  const texts: string[] = [];
  const priorityTexts: string[] = [];

  if (window.TextDetector) {
    const detector = new window.TextDetector();
    for (const file of files) {
      const bitmap = await createImageBitmap(file);
      const results = await detector.detect(bitmap);
      const fullText = results.map((result) => result.rawValue ?? "").filter(Boolean).join("\n");
      if (fullText) texts.push(fullText);
      if (includeSplitEnhancement) {
        const enhancedCanvas = await createSplitOcrCanvas(file);
        const enhancedResults = await detector.detect(enhancedCanvas);
        const enhancedText = enhancedResults.map((result) => result.rawValue ?? "").filter(Boolean).join("\n");
        if (enhancedText) texts.push(enhancedText);
      }
      if (includeEffortRegion && /耗能|体能训练详细信息/.test(fullText)) {
        const rectangle = effortCropRectangle(bitmap.width, bitmap.height);
        const effortBitmap = await createImageBitmap(
          file,
          rectangle.left,
          rectangle.top,
          rectangle.width,
          rectangle.height
        );
        const effortResults = await detector.detect(effortBitmap);
        const effortText = effortResults.map((result) => result.rawValue ?? "").filter(Boolean).join("\n");
        if (effortText) priorityTexts.push(`耗能评分\n${effortText}`);
        effortBitmap.close();
      }
      bitmap.close();
    }
    return [...priorityTexts, ...texts].join("\n");
  }

  const { createWorker, PSM } = await import("tesseract.js");
  const worker = await createWorker(["eng", "chi_sim"]);
  try {
    for (const file of files) {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        tessedit_char_whitelist: "",
        preserve_interword_spaces: "1"
      });
      const result = await worker.recognize(file);
      if (result.data.text.trim()) {
        texts.push(result.data.text.trim());
      }
      if (includeSplitEnhancement) {
        const enhancedCanvas = await createSplitOcrCanvas(file);
        const enhancedResult = await worker.recognize(enhancedCanvas);
        if (enhancedResult.data.text.trim()) {
          texts.push(enhancedResult.data.text.trim());
        }
      }
      if (includeEffortRegion && /耗能|体能训练详细信息/.test(result.data.text)) {
        const effortCanvas = await createEffortScoreCanvas(file);
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_CHAR,
          tessedit_char_whitelist: "0123456789",
          preserve_interword_spaces: "1"
        });
        const effortResult = await worker.recognize(effortCanvas);
        if (effortResult.data.text.trim()) {
          priorityTexts.push(`耗能评分\n${effortResult.data.text.trim()}`);
        }
      }
    }
  } finally {
    await worker.terminate();
  }
  return [...priorityTexts, ...texts].join("\n");
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
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "register" ? 6 : undefined}
          />
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
  const header = first?.axisValueLabel ?? first?.name ?? "";
  const lines = header ? [`<strong>${header}</strong>`] : [];
  items.forEach((item) => {
    const point = item as { marker?: string; seriesName?: string; value?: unknown };
    const name = point.seriesName ?? "";
    const value = point.value;
    let formatted = "";
    if (name === "体重-配速" && Array.isArray(value)) {
      lines.push(`${point.marker ?? ""}${name}`);
      lines.push(`体重：${Number(value[0]).toFixed(1)} kg`);
      lines.push(`配速：${formatPace(Number(value[1]))} /km`);
      lines.push(`距离：${Number(value[2]).toFixed(1)} km`);
      return;
    } else if (name === "体重-心率" && Array.isArray(value)) {
      lines.push(`${point.marker ?? ""}${name}`);
      lines.push(`体重：${Number(value[0]).toFixed(1)} kg`);
      lines.push(`心率：${Number(value[1]).toFixed(0)} bpm`);
      lines.push(`距离：${Number(value[2]).toFixed(1)} km`);
      return;
    } else if (name === "配速-心率" && Array.isArray(value)) {
      lines.push(`${point.marker ?? ""}${name}`);
      lines.push(`日期：${value[3]}`);
      lines.push(`配速：${formatPace(Number(value[0]))} /km`);
      lines.push(`心率：${Number(value[1]).toFixed(0)} bpm`);
      lines.push(`距离：${Number(value[2]).toFixed(1)} km`);
      return;
    } else if ((name === "心率拟合" || name === "线性趋势") && Array.isArray(value)) {
      lines.push(`${point.marker ?? ""}${name}`);
      lines.push(`配速：${formatPace(Number(value[0]))} /km`);
      lines.push(`心率：${Number(value[1]).toFixed(0)} bpm`);
      return;
    } else if (name.includes("配速") || name.includes("移动平均")) {
      formatted = `${formatPace(Number(value))} /km`;
    } else if (name.includes("心率")) {
      formatted = `${Number(value).toFixed(0)} bpm`;
    } else if (name.includes("体重")) {
      formatted = `${Number(value).toFixed(1)} kg`;
    } else if (name.includes("距离") || name.includes("跑量") || name.includes("最长单次")) {
      formatted = `${Number(value).toFixed(2)} km`;
    } else {
      formatted = String(value ?? "");
    }
    lines.push(`${point.marker ?? ""}${name}: ${formatted}`);
  });
  return lines.join("<br />");
}

type TooltipPositionSize = {
  contentSize: [number, number];
  viewSize: [number, number];
};

function boundedTooltipPosition(point: number[], _params: unknown, _dom: unknown, _rect: unknown, size: TooltipPositionSize) {
  const margin = 8;
  const [pointX, pointY] = point;
  const [contentWidth, contentHeight] = size.contentSize;
  const [viewWidth, viewHeight] = size.viewSize;
  let left = pointX + 12;
  let top = pointY + 12;

  if (left + contentWidth + margin > viewWidth) {
    left = pointX - contentWidth - 12;
  }
  if (top + contentHeight + margin > viewHeight) {
    top = pointY - contentHeight - 12;
  }

  return [
    Math.max(margin, Math.min(left, viewWidth - contentWidth - margin)),
    Math.max(margin, Math.min(top, viewHeight - contentHeight - margin))
  ];
}

const CHART_COLORS = {
  primary: "#176b9c",
  trend: "#168b72",
  load: "#e76f51",
  heart: "#d58716",
  violet: "#665cc9",
  grid: "#e5ebf1",
  axis: "#9aabbb",
  label: "#607286"
} as const;

function pearsonCoefficient(points: Array<[number, number]>): number | null {
  if (points.length < 3) return null;
  const meanX = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  const numerator = points.reduce((sum, point) => sum + (point[0] - meanX) * (point[1] - meanY), 0);
  const denominator = Math.sqrt(
    points.reduce((sum, point) => sum + (point[0] - meanX) ** 2, 0) *
      points.reduce((sum, point) => sum + (point[1] - meanY) ** 2, 0)
  );
  return denominator === 0 ? null : numerator / denominator;
}

function formatCorrelation(value: number | null): string {
  return value === null ? "样本不足" : `r ${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

const scienceAxisLine = { lineStyle: { color: CHART_COLORS.axis, width: 1 } };
const scienceAxisTick = { lineStyle: { color: CHART_COLORS.axis } };
const scienceAxisLabel = { color: CHART_COLORS.label, fontSize: 11 };
const scienceSplitLine = { lineStyle: { color: CHART_COLORS.grid, width: 1 } };

function chartTooltip(extra: echarts.EChartsOption["tooltip"] = {}): echarts.EChartsOption["tooltip"] {
  return {
    formatter: chartTooltipFormatter,
    confine: true,
    position: boundedTooltipPosition,
    backgroundColor: "rgba(255, 255, 255, 0.97)",
    borderColor: "#cbd7e3",
    borderWidth: 1,
    textStyle: { color: "#203247", fontSize: 12 },
    extraCssText:
      "max-width:min(260px, calc(100vw - 32px));white-space:normal;line-height:1.45;overflow-wrap:anywhere;box-shadow:0 12px 30px rgba(15,23,42,.18);",
    ...extra
  };
}

function ResearchChart({ runs, weights }: { runs: RunningRecord[]; weights: WeightRecord[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [volumeMode, setVolumeMode] = useState<VolumeChartMode>("weekly");
  const chartMinWidth = Math.max(760, runs.length * 44, weights.length * 34);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    const sorted = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
    const dates = sorted.map(runLocalDate);
    const paces = sorted.map((run) => run.avgPaceSecPerKm);
    const paceAverage = movingAverage(paces);
    const distances = sorted.map((run) => run.distanceKm);
    const heartRates = sorted.map((run) => run.avgHeartRateBpm);
    const monthly = monthlyMileage(sorted);
    const weekly = weeklyMileage(sorted);
    const sortedWeights = [...weights].sort((a, b) => a.date.localeCompare(b.date));
    const weightDates = sortedWeights.map((weight) => weight.date);
    const weightValues = sortedWeights.map((weight) => weight.weightKg);
    const volumeData = volumeMode === "weekly" ? weekly : monthly;
    const volumeLabels = volumeData.map((item) => ("week" in item ? item.week : item.month));
    const volumeLabel = volumeMode === "weekly" ? "周跑量" : "月跑量";
    const volumeLongestLabel = volumeMode === "weekly" ? "周内最长单次" : "月内最长单次";
    const paceRange = paceAxis(paces);
    const weightRange = valueAxis(weightValues, { min: 65, max: 105 }, 2, 12);
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
        return [run.avgPaceSecPerKm, run.avgHeartRateBpm, run.distanceKm, runLocalDate(run)];
      })
      .filter((item): item is [number, number, number, string] => Boolean(item));
    const paceHeartLine = simpleRegressionLine(
      paceHeartScatter.map(([pace, heartRate]) => [pace, heartRate]),
      0,
      1
    );

    chart.setOption({
      color: ["#1864ab", "#2b8a3e", "#c92a2a", "#f08c00", "#0f766e", "#7048e8", "#7c2d12"],
      tooltip: chartTooltip(),
      legend: [
        { top: 8, left: 16, data: ["实际配速", "3次移动平均", "单次距离", "平均心率"] },
        { top: 342, left: 16, data: ["体重-配速", "体重-心率"] },
        { top: 572, left: 16, data: ["配速-心率", "心率拟合"] },
        { top: 814, left: 16, data: [volumeLabel, volumeLongestLabel] },
        { top: 1084, left: 16, data: ["体重"] }
      ],
      grid: [
        { top: 72, left: 64, right: 126, height: 250, containLabel: true },
        { top: 398, left: 64, right: 80, height: 135, containLabel: true },
        { top: 628, left: 64, right: 64, height: 135, containLabel: true },
        { top: 872, left: 64, right: 64, height: 166, containLabel: true },
        { top: 1142, left: 64, right: 64, height: 150, containLabel: true }
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
        { type: "category", data: volumeLabels, gridIndex: 3, nameGap: 24 },
        { type: "category", data: weightDates, boundaryGap: false, gridIndex: 4, nameGap: 24 }
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
        },
        {
          type: "value",
          name: "体重 kg",
          nameLocation: "middle",
          nameGap: 46,
          gridIndex: 4,
          min: weightRange.min,
          max: weightRange.max
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
        },
        {
          name: "体重",
          type: "line",
          xAxisIndex: 4,
          yAxisIndex: 7,
          data: weightValues,
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
      <div className="chart" ref={ref} style={{ minWidth: chartMinWidth }} />
    </div>
  );
}

function xAxisZoom(count: number, visibleCount = 8): echarts.EChartsOption["dataZoom"] {
  const start = count > visibleCount ? Math.max(0, ((count - visibleCount) / count) * 100) : 0;
  return [
    {
      type: "slider",
      xAxisIndex: 0,
      start,
      end: 100,
      bottom: 8,
      height: 26,
      filterMode: "filter",
      showDataShadow: false,
      brushSelect: false,
      handleSize: "160%",
      moveHandleSize: 12,
      fillerColor: "rgba(24, 100, 171, 0.16)",
      borderColor: "#cfd8e5",
      handleStyle: {
        color: "#ffffff",
        borderColor: "#93b6df",
        borderWidth: 2
      },
      moveHandleStyle: {
        color: "#93b6df"
      }
    }
  ];
}

function xValueZoom(): echarts.EChartsOption["dataZoom"] {
  return [
    {
      type: "slider",
      xAxisIndex: 0,
      start: 0,
      end: 100,
      bottom: 8,
      height: 26,
      filterMode: "filter",
      showDataShadow: false,
      brushSelect: false,
      handleSize: "160%",
      moveHandleSize: 12,
      fillerColor: "rgba(24, 100, 171, 0.16)",
      borderColor: "#cfd8e5",
      handleStyle: {
        color: "#ffffff",
        borderColor: "#93b6df",
        borderWidth: 2
      },
      moveHandleStyle: {
        color: "#93b6df"
      }
    }
  ];
}

type ChartInteractionMode = "category" | "scatter";

type InteractiveChartSeries = {
  name?: string;
  type?: string;
  data?: unknown[];
  xAxisIndex?: number;
};

type InteractiveChartAxis = {
  data?: Array<string | number>;
};

type ChartSelectionItem = {
  label: string;
  value: string;
  color: string;
};

type ChartSelection = {
  key: string;
  heading: string;
  items: ChartSelectionItem[];
  seriesIndexes: number[];
  dataIndex: number;
  left: number;
  top: number;
};

type ChartGesture = {
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  direction: GestureDirection;
  ignore: boolean;
};

type ChartZoomState = {
  start: number;
  end: number;
  startValue?: string | number;
  endValue?: string | number;
  atEnd: boolean;
};

function optionArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function chartDataValue(item: unknown): unknown {
  if (item && typeof item === "object" && "value" in item) {
    return (item as { value: unknown }).value;
  }
  return item;
}

function chartMetricValue(name: string, value: unknown): string {
  const numericValue = Number(value);
  if (name.includes("配速") || name.includes("移动平均")) return `${formatPace(numericValue)} /km`;
  if (name.includes("心率")) return `${numericValue.toFixed(0)} bpm`;
  if (name.includes("体重")) return `${numericValue.toFixed(1)} kg`;
  if (name.includes("距离") || name.includes("跑量") || name.includes("最长单次")) return `${numericValue.toFixed(2)} km`;
  return String(value ?? "-");
}

function chartSeriesColors(option: echarts.EChartsOption): string[] {
  if (!Array.isArray(option.color)) return [];
  return option.color.filter((color): color is string => typeof color === "string");
}

function categorySelection(
  option: echarts.EChartsOption,
  dataIndex: number,
  left: number,
  top: number
): ChartSelection | null {
  const axis = optionArray(option.xAxis as InteractiveChartAxis | InteractiveChartAxis[] | undefined)[0];
  const heading = axis?.data?.[dataIndex];
  const series = optionArray(option.series as InteractiveChartSeries | InteractiveChartSeries[] | undefined);
  const colors = chartSeriesColors(option);
  const items: ChartSelectionItem[] = [];
  const seriesIndexes: number[] = [];

  series.forEach((entry, seriesIndex) => {
    if ((entry.xAxisIndex ?? 0) !== 0 || !entry.name || !entry.data) return;
    const value = chartDataValue(entry.data[dataIndex]);
    if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) return;
    items.push({
      label: entry.name,
      value: chartMetricValue(entry.name, value),
      color: colors[seriesIndex % Math.max(colors.length, 1)] ?? CHART_COLORS.primary
    });
    seriesIndexes.push(seriesIndex);
  });

  if (heading === undefined || items.length === 0) return null;
  return {
    key: `category-${dataIndex}`,
    heading: String(heading),
    items,
    seriesIndexes,
    dataIndex,
    left,
    top
  };
}

function scatterSelection(
  option: echarts.EChartsOption,
  seriesIndex: number,
  dataIndex: number,
  left: number,
  top: number
): ChartSelection | null {
  const series = optionArray(option.series as InteractiveChartSeries | InteractiveChartSeries[] | undefined);
  const entry = series[seriesIndex];
  const value = chartDataValue(entry?.data?.[dataIndex]);
  if (!entry?.name || !Array.isArray(value)) return null;
  const colors = chartSeriesColors(option);
  const color = colors[seriesIndex % Math.max(colors.length, 1)] ?? CHART_COLORS.primary;
  let heading = String(value[3] ?? entry.name);
  let items: ChartSelectionItem[] = [];

  if (entry.name === "体重-配速" || entry.name === "体重-心率") {
    heading = String(value[3] ?? entry.name);
    const pace = entry.name === "体重-配速" ? Number(value[1]) : Number(value[4]);
    const heartRate = entry.name === "体重-心率" ? Number(value[1]) : Number(value[4]);
    items = [
      { label: "体重", value: `${Number(value[0]).toFixed(1)} kg`, color },
      { label: "配速", value: `${formatPace(pace)} /km`, color: CHART_COLORS.primary },
      { label: "心率", value: `${heartRate.toFixed(0)} bpm`, color: CHART_COLORS.violet },
      { label: "距离", value: `${Number(value[2]).toFixed(1)} km`, color: CHART_COLORS.load }
    ];
  } else if (entry.name === "配速-心率") {
    items = [
      { label: "配速", value: `${formatPace(Number(value[0]))} /km`, color },
      { label: "心率", value: `${Number(value[1]).toFixed(0)} bpm`, color: CHART_COLORS.trend },
      { label: "距离", value: `${Number(value[2]).toFixed(1)} km`, color: CHART_COLORS.load }
    ];
  }

  if (items.length === 0) return null;
  const relatedSeriesIndexes = series
    .map((candidate, candidateIndex) => candidate.type === "scatter" && candidate.data?.[dataIndex] !== undefined ? candidateIndex : -1)
    .filter((candidateIndex) => candidateIndex >= 0);
  return {
    key: `scatter-${seriesIndex}-${dataIndex}`,
    heading,
    items,
    seriesIndexes: relatedSeriesIndexes,
    dataIndex,
    left,
    top
  };
}

function interactiveChartOption(option: echarts.EChartsOption, zoomState?: ChartZoomState): echarts.EChartsOption {
  const dataZoom = optionArray(option.dataZoom).map((zoom) => {
    if (!zoomState || zoomState.atEnd || typeof zoom !== "object" || zoom === null) return zoom;
    return {
      ...zoom,
      start: zoomState.start,
      end: zoomState.end,
      ...(zoomState.startValue !== undefined ? { startValue: zoomState.startValue } : {}),
      ...(zoomState.endValue !== undefined ? { endValue: zoomState.endValue } : {})
    };
  });
  return {
    ...option,
    tooltip: { ...(typeof option.tooltip === "object" && !Array.isArray(option.tooltip) ? option.tooltip : {}), show: false, triggerOn: "none" },
    dataZoom
  };
}

function ChartCanvas({
  option,
  className = "",
  label,
  interaction,
  zoomKey = "default"
}: {
  option: echarts.EChartsOption;
  className?: string;
  label: string;
  interaction: ChartInteractionMode;
  zoomKey?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const optionRef = useRef(option);
  const interactionRef = useRef(interaction);
  const zoomKeyRef = useRef(zoomKey);
  const zoomStatesRef = useRef(new Map<string, ChartZoomState>());
  const gestureRef = useRef<ChartGesture | null>(null);
  const pinnedRef = useRef(false);
  const selectionRef = useRef<ChartSelection | null>(null);
  const [selection, setSelection] = useState<ChartSelection | null>(null);
  const selectionId = useId();

  optionRef.current = option;
  interactionRef.current = interaction;
  zoomKeyRef.current = zoomKey;

  useEffect(() => {
    if (!ref.current) return;
    const element = ref.current;
    const chart = echarts.init(element);
    chartRef.current = chart;

    const clearSelection = () => {
      const current = selectionRef.current;
      if (current) {
        current.seriesIndexes.forEach((seriesIndex) => chart.dispatchAction({ type: "downplay", seriesIndex, dataIndex: current.dataIndex }));
      }
      selectionRef.current = null;
      pinnedRef.current = false;
      setSelection(null);
    };

    const publishSelection = (nextSelection: ChartSelection | null) => {
      if (!nextSelection) return false;
      const previous = selectionRef.current;
      if (previous && previous.key !== nextSelection.key) {
        previous.seriesIndexes.forEach((seriesIndex) => chart.dispatchAction({ type: "downplay", seriesIndex, dataIndex: previous.dataIndex }));
      }
      nextSelection.seriesIndexes.forEach((seriesIndex) => chart.dispatchAction({ type: "highlight", seriesIndex, dataIndex: nextSelection.dataIndex }));
      selectionRef.current = nextSelection;
      setSelection(nextSelection);
      window.dispatchEvent(new CustomEvent("running-platform:chart-selection", { detail: { id: selectionId } }));
      return true;
    };

    const localPoint = (event: PointerEvent): [number, number] => {
      const bounds = element.getBoundingClientRect();
      return [event.clientX - bounds.left, event.clientY - bounds.top];
    };

    const selectionAt = (x: number, y: number): ChartSelection | null => {
      if (!chart.containPixel({ gridIndex: 0 }, [x, y])) return null;
      const currentOption = optionRef.current;
      const width = element.clientWidth;
      const height = element.clientHeight;
      const popoverLeft = Math.max(8, Math.min(x + 12, width - 292));
      const popoverTop = Math.max(8, Math.min(y + 12, height - 112));

      if (interactionRef.current === "category") {
        const axis = optionArray(currentOption.xAxis as InteractiveChartAxis | InteractiveChartAxis[] | undefined)[0];
        const axisData = axis?.data ?? [];
        const positions = axisData.map((axisValue) => {
          const pixel = chart.convertToPixel({ xAxisIndex: 0 }, axisValue);
          return typeof pixel === "number" ? pixel : Number.NaN;
        });
        const dataIndex = nearestPixelIndex(positions, x);
        return dataIndex < 0 ? null : categorySelection(currentOption, dataIndex, popoverLeft, popoverTop);
      }

      const series = optionArray(currentOption.series as InteractiveChartSeries | InteractiveChartSeries[] | undefined);
      let nearest: { seriesIndex: number; dataIndex: number; distance: number } | null = null;
      series.forEach((entry, seriesIndex) => {
        if (entry.type !== "scatter" || !entry.data) return;
        entry.data.forEach((dataItem, dataIndex) => {
          const value = chartDataValue(dataItem);
          if (!Array.isArray(value)) return;
          const pixel = chart.convertToPixel({ seriesIndex }, [Number(value[0]), Number(value[1])]);
          if (!Array.isArray(pixel) || !Number.isFinite(pixel[0]) || !Number.isFinite(pixel[1])) return;
          const distance = Math.hypot(pixel[0] - x, pixel[1] - y);
          if (!nearest || distance < nearest.distance) nearest = { seriesIndex, dataIndex, distance };
        });
      });
      if (!nearest) return null;
      const resolvedNearest = nearest as { seriesIndex: number; dataIndex: number; distance: number };
      return scatterSelection(currentOption, resolvedNearest.seriesIndex, resolvedNearest.dataIndex, popoverLeft, popoverTop);
    };

    const handlePointerDown = (event: PointerEvent) => {
      gestureRef.current = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startY: event.clientY,
        direction: "pending",
        ignore: event.pointerType === "touch" && event.clientX <= 20
      };
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse") {
        if (pinnedRef.current || event.buttons !== 0) return;
        const [x, y] = localPoint(event);
        publishSelection(selectionAt(x, y));
        return;
      }

      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.ignore) return;
      if (gesture.direction === "pending") {
        gesture.direction = classifyGestureDirection(event.clientX - gesture.startX, event.clientY - gesture.startY);
      }
      if (gesture.direction !== "horizontal") return;
      if (event.cancelable) event.preventDefault();
      const [x, y] = localPoint(event);
      publishSelection(selectionAt(x, y));
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      if (gesture.ignore || gesture.direction === "vertical") return;
      const [x, y] = localPoint(event);
      const nextSelection = gesture.direction === "pending" ? selectionAt(x, y) : selectionRef.current;
      if (nextSelection) {
        publishSelection(nextSelection);
        pinnedRef.current = true;
      } else if (gesture.direction === "pending") {
        clearSelection();
      }
    };

    const handlePointerLeave = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && !pinnedRef.current) clearSelection();
    };

    const handleSelectionFromAnotherChart = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string }>).detail;
      if (detail?.id !== selectionId) clearSelection();
    };

    const handleZoom = () => {
      const appliedOption = chart.getOption() as {
        dataZoom?: Array<{ start?: number; end?: number; startValue?: string | number; endValue?: string | number }>;
      };
      const zoom = appliedOption.dataZoom?.[0];
      if (typeof zoom?.start !== "number" || typeof zoom.end !== "number") return;
      zoomStatesRef.current.set(zoomKeyRef.current, {
        start: zoom.start,
        end: zoom.end,
        startValue: zoom.startValue,
        endValue: zoom.endValue,
        atEnd: zoom.end >= 99.5
      });
    };

    const resize = () => chart.resize();
    element.addEventListener("pointerdown", handlePointerDown);
    element.addEventListener("pointermove", handlePointerMove, { passive: false });
    element.addEventListener("pointerup", handlePointerUp);
    element.addEventListener("pointercancel", handlePointerUp);
    element.addEventListener("pointerleave", handlePointerLeave);
    window.addEventListener("running-platform:chart-selection", handleSelectionFromAnotherChart);
    window.addEventListener("resize", resize);
    chart.on("datazoom", handleZoom);
    return () => {
      element.removeEventListener("pointerdown", handlePointerDown);
      element.removeEventListener("pointermove", handlePointerMove);
      element.removeEventListener("pointerup", handlePointerUp);
      element.removeEventListener("pointercancel", handlePointerUp);
      element.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("running-platform:chart-selection", handleSelectionFromAnotherChart);
      window.removeEventListener("resize", resize);
      chart.off("datazoom", handleZoom);
      chart.dispose();
      chartRef.current = null;
    };
  }, [selectionId]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const currentSelection = selectionRef.current;
    if (currentSelection) {
      currentSelection.seriesIndexes.forEach((seriesIndex) => chart.dispatchAction({ type: "downplay", seriesIndex, dataIndex: currentSelection.dataIndex }));
    }
    selectionRef.current = null;
    pinnedRef.current = false;
    setSelection(null);
    chart.setOption(interactiveChartOption(option, zoomStatesRef.current.get(zoomKey)), true);
  }, [option, zoomKey]);

  return (
    <div className={`chart-interaction-shell ${selection ? "has-selection" : ""}`}>
      <div className={`chart chart-interaction-surface ${className}`} ref={ref} role="img" aria-label={label} />
      {selection && (
        <div
          className="chart-selection-popover"
          style={{ left: selection.left, top: selection.top }}
          role="status"
          aria-live="polite"
        >
          <strong>{selection.heading}</strong>
          <span className="chart-selection-items">
            {selection.items.map((item) => (
              <span className="chart-selection-item" key={`${item.label}-${item.value}`}>
                <i style={{ backgroundColor: item.color }} />
                <small>{item.label}</small>
                <b>{item.value}</b>
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

function useNarrowViewport() {
  const [isNarrow, setIsNarrow] = useState(() => (typeof window === "undefined" ? false : window.matchMedia("(max-width: 720px)").matches));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 720px)");
    const update = () => setIsNarrow(media.matches);
    update();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  return isNarrow;
}

type ScientificChartMetric = {
  label: string;
  value: string;
  tone?: "primary" | "trend" | "neutral";
};

function ScientificChartHeading({
  title,
  description,
  metrics,
  actions
}: {
  title: string;
  description: string;
  metrics: ScientificChartMetric[];
  actions?: ReactNode;
}) {
  return (
    <div className="science-chart-header">
      <div className="science-chart-title-row">
        <div className="science-chart-copy">
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {actions}
      </div>
      <div className="science-chart-metrics" aria-label={`${title}统计摘要`}>
        {metrics.map((metric) => (
          <span className={`science-chart-metric ${metric.tone ?? "neutral"}`} key={`${metric.label}-${metric.value}`}>
            <small>{metric.label}</small>
            <strong>{metric.value}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function RunTrendChart({ runs }: { runs: RunningRecord[] }) {
  const isNarrow = useNarrowViewport();
  const summary = useMemo(() => {
    const sorted = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
    const latest = sorted[sorted.length - 1];
    const rolling = movingAverage(sorted.map((run) => run.avgPaceSecPerKm));
    return {
      count: sorted.length,
      latestPace: latest ? formatPace(latest.avgPaceSecPerKm) : "-",
      rollingPace: rolling.length > 0 ? formatPace(rolling[rolling.length - 1]) : "-"
    };
  }, [runs]);
  const option = useMemo<echarts.EChartsOption>(() => {
    const sorted = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
    const dates = sorted.map(runLocalDate);
    const paces = sorted.map((run) => run.avgPaceSecPerKm);
    const paceAverage = movingAverage(paces);
    const distances = sorted.map((run) => run.distanceKm);
    const heartRates = sorted.map((run) => run.avgHeartRateBpm);
    const paceRange = paceAxis(paces);
    const distanceRange = valueAxis(distances, { min: 0, max: 15 }, 2, 6);
    const heartRateRange = valueAxis(heartRates, { min: 120, max: 180 }, 5, 20);

    return {
      aria: { enabled: true },
      animationDuration: 360,
      color: [CHART_COLORS.primary, CHART_COLORS.trend, CHART_COLORS.load, CHART_COLORS.heart],
      tooltip: chartTooltip({ trigger: "axis" }),
      legend: {
        top: 10,
        left: isNarrow ? 4 : 12,
        right: isNarrow ? 4 : undefined,
        type: "plain",
        itemGap: isNarrow ? 5 : 12,
        itemWidth: isNarrow ? 18 : 25,
        itemHeight: isNarrow ? 10 : 14,
        textStyle: { color: CHART_COLORS.label, fontSize: isNarrow ? 10 : 12 },
        data: ["实际配速", "3次移动平均", "单次距离", "平均心率"]
      },
      grid: isNarrow
        ? { top: 92, left: 42, right: 34, bottom: 68, containLabel: true }
        : { top: 70, left: 62, right: 162, bottom: 68, containLabel: true },
      dataZoom: xAxisZoom(dates.length, 8),
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: true,
        axisLine: scienceAxisLine,
        axisTick: scienceAxisTick,
        axisLabel: { ...scienceAxisLabel, hideOverlap: true },
        splitLine: { show: false }
      },
      yAxis: [
        {
          type: "value",
          name: isNarrow ? "" : "配速 /km",
          nameLocation: "middle",
          nameGap: isNarrow ? 0 : 46,
          inverse: true,
          min: paceRange.min,
          max: paceRange.max,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { ...scienceAxisLabel, formatter: (value: number) => formatPace(value) },
          splitLine: scienceSplitLine
        },
        {
          type: "value",
          name: isNarrow ? "" : "距离 km",
          nameLocation: "middle",
          nameGap: isNarrow ? 0 : 50,
          position: "right",
          min: distanceRange.min,
          max: distanceRange.max,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { ...scienceAxisLabel, margin: 10 },
          splitLine: { show: false }
        },
        {
          type: "value",
          name: isNarrow ? "" : "心率 bpm",
          nameLocation: "middle",
          nameGap: isNarrow ? 0 : 52,
          position: "right",
          offset: isNarrow ? 0 : 82,
          min: heartRateRange.min,
          max: heartRateRange.max,
          axisLine: { show: false },
          axisLabel: { ...scienceAxisLabel, show: !isNarrow, margin: 10 },
          axisTick: { show: !isNarrow },
          splitLine: { show: false }
        }
      ],
      series: [
        {
          name: "实际配速",
          type: "line",
          data: paces,
          smooth: 0.38,
          smoothMonotone: "x",
          symbol: "circle",
          symbolSize: 7,
          lineStyle: { width: 2.4 },
          itemStyle: { borderColor: "#ffffff", borderWidth: 2 },
          z: 4,
          clip: true
        },
        {
          name: "3次移动平均",
          type: "line",
          data: paceAverage,
          smooth: 0.44,
          smoothMonotone: "x",
          lineStyle: { type: "dashed", width: 2.2 },
          symbol: "none",
          z: 3,
          clip: true
        },
        {
          name: "单次距离",
          type: "bar",
          yAxisIndex: 1,
          data: distances,
          barMaxWidth: 18,
          itemStyle: { opacity: 0.46, borderRadius: [2, 2, 0, 0] },
          z: 1,
          clip: true
        },
        {
          name: "平均心率",
          type: "line",
          yAxisIndex: 2,
          data: heartRates,
          smooth: 0.38,
          smoothMonotone: "x",
          symbol: "circle",
          symbolSize: 6,
          lineStyle: { width: 1.8 },
          itemStyle: { borderColor: "#ffffff", borderWidth: 1.5 },
          z: 3,
          clip: true
        }
      ]
    };
  }, [runs, isNarrow]);

  return (
    <div className="chart-block">
      <ScientificChartHeading
        title="跑步表现趋势"
        description="以实际配速为主，结合移动平均、单次距离和心率观察训练变化。"
        metrics={[
          { label: "记录", value: `${summary.count} 次`, tone: "neutral" },
          { label: "最近配速", value: `${summary.latestPace} /km`, tone: "primary" },
          { label: "3次均值", value: `${summary.rollingPace} /km`, tone: "trend" }
        ]}
      />
      <ChartCanvas
        option={option}
        className="run-trend-chart"
        label="跑步配速、移动平均、单次距离与平均心率趋势图"
        interaction="category"
      />
    </div>
  );
}

function WeightRelationChart({ runs, weights }: { runs: RunningRecord[]; weights: WeightRecord[] }) {
  const isNarrow = useNarrowViewport();
  const summary = useMemo(() => {
    const matched = runs
      .map((run) => {
        const weight = nearestWeight(run, weights);
        return weight ? { weight: weight.weightKg, pace: run.avgPaceSecPerKm, heartRate: run.avgHeartRateBpm } : null;
      })
      .filter((item): item is { weight: number; pace: number; heartRate: number } => Boolean(item));
    return {
      count: matched.length,
      paceCorrelation: pearsonCoefficient(matched.map((item) => [item.weight, item.pace])),
      heartCorrelation: pearsonCoefficient(matched.map((item) => [item.weight, item.heartRate]))
    };
  }, [runs, weights]);
  const option = useMemo<echarts.EChartsOption>(() => {
    const sorted = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
    const paces = sorted.map((run) => run.avgPaceSecPerKm);
    const heartRates = sorted.map((run) => run.avgHeartRateBpm);
    const sortedWeights = [...weights].sort((a, b) => a.date.localeCompare(b.date));
    const weightValues = sortedWeights.map((weight) => weight.weightKg);
    const paceRange = paceAxis(paces);
    const weightRange = valueAxis(weightValues, { min: 65, max: 105 }, 2, 12);
    const heartRateRange = valueAxis(heartRates, { min: 120, max: 180 }, 5, 20);
    const weightPaceScatter = sorted
      .map((run) => {
        const weight = nearestWeight(run, weights);
        return weight
          ? [weight.weightKg, run.avgPaceSecPerKm, run.distanceKm, runLocalDate(run), run.avgHeartRateBpm]
          : null;
      })
      .filter(Boolean);
    const weightHeartRateScatter = sorted
      .map((run) => {
        const weight = nearestWeight(run, weights);
        return weight
          ? [weight.weightKg, run.avgHeartRateBpm, run.distanceKm, runLocalDate(run), run.avgPaceSecPerKm]
          : null;
      })
      .filter(Boolean);

    return {
      aria: { enabled: true },
      animationDuration: 360,
      color: [CHART_COLORS.heart, CHART_COLORS.violet],
      tooltip: chartTooltip(),
      legend: {
        top: 10,
        left: 12,
        itemGap: isNarrow ? 8 : 14,
        textStyle: { color: CHART_COLORS.label, fontSize: isNarrow ? 10 : 12 },
        data: ["体重-配速", "体重-心率"]
      },
      grid: isNarrow
        ? { top: 64, left: 42, right: 38, bottom: 68, containLabel: true }
        : { top: 64, left: 62, right: 86, bottom: 68, containLabel: true },
      dataZoom: xValueZoom(),
      xAxis: {
        type: "value",
        name: "体重 kg",
        nameLocation: "middle",
        nameGap: isNarrow ? 24 : 32,
        min: weightRange.min,
        max: weightRange.max,
        axisLine: scienceAxisLine,
        axisTick: scienceAxisTick,
        axisLabel: scienceAxisLabel,
        splitLine: { lineStyle: { color: CHART_COLORS.grid, type: "dashed" } }
      },
      yAxis: [
        {
          type: "value",
          name: isNarrow ? "" : "配速 /km",
          nameLocation: "middle",
          nameGap: isNarrow ? 0 : 46,
          inverse: true,
          min: paceRange.min,
          max: paceRange.max,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { ...scienceAxisLabel, formatter: (value: number) => formatPace(value) },
          splitLine: scienceSplitLine
        },
        {
          type: "value",
          name: isNarrow ? "" : "心率 bpm",
          nameLocation: "middle",
          nameGap: isNarrow ? 0 : 48,
          position: "right",
          min: heartRateRange.min,
          max: heartRateRange.max,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: scienceAxisLabel,
          splitLine: { show: false }
        }
      ],
      series: [
        {
          name: "体重-配速",
          type: "scatter",
          data: weightPaceScatter,
          symbolSize: (value: number[]) => Math.max(8, Math.min(24, value[2] * 1.5)),
          itemStyle: { opacity: 0.78, borderColor: "#ffffff", borderWidth: 1.5 },
          clip: true
        },
        {
          name: "体重-心率",
          type: "scatter",
          yAxisIndex: 1,
          data: weightHeartRateScatter,
          symbolSize: (value: number[]) => Math.max(8, Math.min(24, value[2] * 1.5)),
          itemStyle: { opacity: 0.7, borderColor: "#ffffff", borderWidth: 1.5 },
          clip: true
        }
      ]
    };
  }, [runs, weights, isNarrow]);

  return (
    <div className="chart-block">
      <ScientificChartHeading
        title="体重与跑步表现"
        description="匹配跑步日前后 3 天内最近体重；点越大代表单次距离越长。"
        metrics={[
          { label: "配对样本", value: `${summary.count} 次`, tone: "neutral" },
          { label: "体重-配速", value: formatCorrelation(summary.paceCorrelation), tone: "primary" },
          { label: "体重-心率", value: formatCorrelation(summary.heartCorrelation), tone: "trend" }
        ]}
      />
      <ChartCanvas
        option={option}
        className="relation-chart"
        label="体重与跑步配速、平均心率关系散点图"
        interaction="scatter"
      />
    </div>
  );
}

function PaceHeartChart({ runs }: { runs: RunningRecord[] }) {
  const summary = useMemo(() => {
    const points = runs
      .filter((run) => Number.isFinite(run.avgPaceSecPerKm) && Number.isFinite(run.avgHeartRateBpm))
      .map((run): [number, number] => [run.avgPaceSecPerKm, run.avgHeartRateBpm]);
    return { count: points.length, correlation: pearsonCoefficient(points) };
  }, [runs]);
  const option = useMemo<echarts.EChartsOption>(() => {
    const sorted = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
    const paces = sorted.map((run) => run.avgPaceSecPerKm);
    const heartRates = sorted.map((run) => run.avgHeartRateBpm);
    const paceRange = paceAxis(paces);
    const heartRateRange = valueAxis(heartRates, { min: 120, max: 180 }, 5, 20);
    const paceHeartScatter = sorted
      .map((run) => {
        if (!Number.isFinite(run.avgPaceSecPerKm) || !Number.isFinite(run.avgHeartRateBpm)) return null;
        return [run.avgPaceSecPerKm, run.avgHeartRateBpm, run.distanceKm, runLocalDate(run)];
      })
      .filter((item): item is [number, number, number, string] => Boolean(item));
    const paceHeartLine = simpleRegressionLine(
      paceHeartScatter.map(([pace, heartRate]) => [pace, heartRate]),
      0,
      1
    );

    return {
      aria: { enabled: true },
      animationDuration: 360,
      color: [CHART_COLORS.primary, CHART_COLORS.trend],
      tooltip: chartTooltip(),
      legend: {
        top: 10,
        left: 12,
        textStyle: { color: CHART_COLORS.label, fontSize: 12 },
        data: ["配速-心率", "线性趋势"]
      },
      grid: { top: 64, left: 62, right: 52, bottom: 68, containLabel: true },
      dataZoom: xValueZoom(),
      xAxis: {
        type: "value",
        name: "配速 /km",
        nameLocation: "middle",
        nameGap: 32,
        min: paceRange.min,
        max: paceRange.max,
        axisLine: scienceAxisLine,
        axisTick: scienceAxisTick,
        axisLabel: { ...scienceAxisLabel, formatter: (value: number) => formatPace(value) },
        splitLine: { lineStyle: { color: CHART_COLORS.grid, type: "dashed" } }
      },
      yAxis: {
        type: "value",
        name: "心率 bpm",
        nameLocation: "middle",
        nameGap: 46,
        min: heartRateRange.min,
        max: heartRateRange.max,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: scienceAxisLabel,
        splitLine: scienceSplitLine
      },
      series: [
        {
          name: "配速-心率",
          type: "scatter",
          data: paceHeartScatter,
          symbolSize: (value: number[]) => Math.max(8, Math.min(24, value[2] * 1.5)),
          itemStyle: { opacity: 0.78, borderColor: "#ffffff", borderWidth: 1.5 },
          clip: true
        },
        {
          name: "线性趋势",
          type: "line",
          data: paceHeartLine,
          symbol: "none",
          lineStyle: { type: "dashed", width: 2.2 },
          clip: true
        }
      ]
    };
  }, [runs]);

  return (
    <div className="chart-block">
      <ScientificChartHeading
        title="配速与心率"
        description="用于观察相近配速下心率是否下降；点越大代表单次距离越长。"
        metrics={[
          { label: "有效样本", value: `${summary.count} 次`, tone: "neutral" },
          { label: "Pearson 相关", value: formatCorrelation(summary.correlation), tone: "primary" }
        ]}
      />
      <ChartCanvas
        option={option}
        className="scatter-chart"
        label="平均配速与平均心率关系散点图和线性趋势"
        interaction="scatter"
      />
    </div>
  );
}

function VolumeChart({ runs }: { runs: RunningRecord[] }) {
  const [volumeMode, setVolumeMode] = useState<VolumeChartMode>("weekly");
  const summary = useMemo(() => {
    const data = volumeMode === "weekly" ? weeklyMileage(runs) : monthlyMileage(runs);
    const latest = data[data.length - 1];
    return {
      count: data.length,
      distance: latest?.distanceKm ?? 0,
      longest: latest?.longestDistanceKm ?? 0
    };
  }, [runs, volumeMode]);
  const option = useMemo<echarts.EChartsOption>(() => {
    const sorted = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
    const monthly = monthlyMileage(sorted);
    const weekly = weeklyMileage(sorted);
    const volumeData = volumeMode === "weekly" ? weekly : monthly;
    const volumeLabels = volumeData.map((item) => ("week" in item ? item.week : item.month));
    const volumeLabel = volumeMode === "weekly" ? "周跑量" : "月跑量";
    const volumeLongestLabel = volumeMode === "weekly" ? "周内最长单次" : "月内最长单次";
    const volumeDistanceRange = valueAxis(
      [...volumeData.map((item) => item.distanceKm), ...volumeData.map((item) => item.longestDistanceKm)],
      volumeMode === "weekly" ? { min: 0, max: 40 } : { min: 0, max: 80 },
      volumeMode === "weekly" ? 5 : 10,
      volumeMode === "weekly" ? 20 : 30
    );

    return {
      aria: { enabled: true },
      animationDuration: 360,
      color: [CHART_COLORS.trend, CHART_COLORS.primary],
      tooltip: chartTooltip({ trigger: "axis" }),
      legend: {
        top: 10,
        left: 12,
        textStyle: { color: CHART_COLORS.label, fontSize: 12 },
        data: [volumeLabel, volumeLongestLabel]
      },
      grid: { top: 64, left: 62, right: 52, bottom: 68, containLabel: true },
      dataZoom: xAxisZoom(volumeLabels.length, 6),
      xAxis: {
        type: "category",
        data: volumeLabels,
        axisLine: scienceAxisLine,
        axisTick: scienceAxisTick,
        axisLabel: { ...scienceAxisLabel, hideOverlap: true },
        splitLine: { show: false }
      },
      yAxis: {
        type: "value",
        name: `${volumeLabel} km`,
        nameLocation: "middle",
        nameGap: 44,
        min: volumeDistanceRange.min,
        max: volumeDistanceRange.max,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: scienceAxisLabel,
        splitLine: scienceSplitLine
      },
      series: [
        {
          name: volumeLabel,
          type: "bar",
          data: volumeData.map((item) => Number(item.distanceKm.toFixed(1))),
          barMaxWidth: 28,
          itemStyle: { borderRadius: [3, 3, 0, 0], opacity: 0.88 },
          clip: true
        },
        {
          name: volumeLongestLabel,
          type: "line",
          data: volumeData.map((item) => Number(item.longestDistanceKm.toFixed(1))),
          smooth: 0.18,
          symbolSize: 7,
          lineStyle: { width: 2.2 },
          itemStyle: { borderColor: "#ffffff", borderWidth: 2 },
          clip: true
        }
      ]
    };
  }, [runs, volumeMode]);

  return (
    <div className="chart-block volume-chart-block">
      <ScientificChartHeading
        title={volumeMode === "weekly" ? "周跑量" : "月跑量"}
        description="总跑量反映训练负荷，最长单次用于观察长距离能力。"
        metrics={[
          { label: "统计周期", value: `${summary.count} 个`, tone: "neutral" },
          { label: "最近跑量", value: `${summary.distance.toFixed(1)} km`, tone: "trend" },
          { label: "最长单次", value: `${summary.longest.toFixed(1)} km`, tone: "primary" }
        ]}
        actions={
          <div className="chart-volume-tabs" aria-label="跑量图切换">
            <button type="button" className={volumeMode === "weekly" ? "active" : ""} onClick={() => setVolumeMode("weekly")}>
              周跑量
            </button>
            <button type="button" className={volumeMode === "monthly" ? "active" : ""} onClick={() => setVolumeMode("monthly")}>
              月跑量
            </button>
          </div>
        }
      />
      <ChartCanvas
        option={option}
        className="volume-chart"
        label={`${volumeMode === "weekly" ? "周" : "月"}跑量与周期内最长单次距离趋势图`}
        interaction="category"
        zoomKey={volumeMode}
      />
    </div>
  );
}

function WeightTrendChart({ weights }: { weights: WeightRecord[] }) {
  const summary = useMemo(() => {
    const sorted = [...weights].sort((a, b) => a.date.localeCompare(b.date));
    const first = sorted[0];
    const latest = sorted[sorted.length - 1];
    const change = first && latest ? latest.weightKg - first.weightKg : 0;
    return { count: sorted.length, latest: latest?.weightKg ?? 0, change };
  }, [weights]);
  const option = useMemo<echarts.EChartsOption>(() => {
    const sortedWeights = [...weights].sort((a, b) => a.date.localeCompare(b.date));
    const weightDates = sortedWeights.map((weight) => weight.date);
    const weightValues = sortedWeights.map((weight) => weight.weightKg);
    const weightRange = valueAxis(weightValues, { min: 65, max: 105 }, 2, 12);

    return {
      aria: { enabled: true },
      animationDuration: 360,
      color: [CHART_COLORS.primary],
      tooltip: chartTooltip({ trigger: "axis" }),
      legend: { top: 10, left: 12, textStyle: { color: CHART_COLORS.label, fontSize: 12 }, data: ["体重"] },
      grid: { top: 64, left: 62, right: 52, bottom: 68, containLabel: true },
      dataZoom: xAxisZoom(weightDates.length, 10),
      xAxis: {
        type: "category",
        data: weightDates,
        boundaryGap: false,
        axisLine: scienceAxisLine,
        axisTick: scienceAxisTick,
        axisLabel: { ...scienceAxisLabel, hideOverlap: true },
        splitLine: { show: false }
      },
      yAxis: {
        type: "value",
        name: "体重 kg",
        nameLocation: "middle",
        nameGap: 46,
        min: weightRange.min,
        max: weightRange.max,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: scienceAxisLabel,
        splitLine: scienceSplitLine
      },
      series: [
        {
          name: "体重",
          type: "line",
          data: weightValues,
          smooth: false,
          symbol: "circle",
          symbolSize: 7,
          lineStyle: { width: 2.3 },
          itemStyle: { borderColor: "#ffffff", borderWidth: 2 },
          areaStyle: { color: "rgba(23, 107, 156, 0.08)" },
          clip: true
        }
      ]
    };
  }, [weights]);

  return (
    <div className="chart-block">
      <ScientificChartHeading
        title="体重趋势"
        description="展示原始体重记录，不计算移动平均。"
        metrics={[
          { label: "记录", value: `${summary.count} 条`, tone: "neutral" },
          { label: "最近体重", value: `${summary.latest.toFixed(1)} kg`, tone: "primary" },
          {
            label: "区间变化",
            value: `${summary.change > 0 ? "+" : ""}${summary.change.toFixed(1)} kg`,
            tone: summary.change <= 0 ? "trend" : "neutral"
          }
        ]}
      />
      <ChartCanvas
        option={option}
        className="weight-trend-chart"
        label="按日期排列的体重原始记录趋势图"
        interaction="category"
      />
    </div>
  );
}

function IndependentResearchCharts({ runs, weights }: { runs: RunningRecord[]; weights: WeightRecord[] }) {
  return (
    <div className="research-chart">
      {runs.length > 0 && <RunTrendChart runs={runs} />}
      {runs.length > 0 && weights.length > 0 && <WeightRelationChart runs={runs} weights={weights} />}
      {runs.length > 0 && <PaceHeartChart runs={runs} />}
      {runs.length > 0 && <VolumeChart runs={runs} />}
      {weights.length > 0 && <WeightTrendChart weights={weights} />}
    </div>
  );
}

function clarifyAiText(value: string): string {
  return value.replace(/PA\s*数据/gi, "跑步表现分析数据");
}

function AiInsightList({ items }: { items: AiDeepAnalysis["metricConflicts"] }) {
  if (items.length === 0) return null;
  return (
    <div className="ai-signal-list">
      {items.slice(0, 6).map((item, index) => (
        <details key={`${item.title}-${index}`}>
          <summary>
            <span>{item.severity === "critical" ? "高风险" : item.severity === "warning" ? "需留意" : "观察"}</span>
            <strong>{item.title}</strong>
          </summary>
          <p>{clarifyAiText(item.detail)}</p>
          {item.evidence ? <small>依据：{clarifyAiText(item.evidence)}</small> : null}
        </details>
      ))}
    </div>
  );
}

function FlashAnalysisContent({ analysis }: { analysis: AiPredictionAnalysis }) {
  return (
    <>
      <div className="ai-summary-grid">
        <article><span>综合结论</span><p>{clarifyAiText(analysis.summary)}</p></article>
        <article><span>近期能力趋势</span><p>{clarifyAiText(analysis.recentTrend)}</p></article>
      </div>
      <AiInsightList items={[...analysis.anomalies, ...analysis.risks].slice(0, 4)} />
      <details className="ai-adjustment-details">
        <summary><span>查看算法基线、Flash 调整与依据</span><strong>{signedPercent(analysis.appliedAdjustmentPercent)}</strong></summary>
        <div className="ai-adjustment-metrics">
          <div><span>算法基线</span><strong>{formatDuration(analysis.algorithmPredictionSec)}</strong></div>
          <div><span>Flash 综合预测</span><strong>{formatDuration(analysis.aiPredictionSec)}</strong></div>
          <div><span>动态区间</span><strong>{formatDuration(analysis.dynamicRangeSec.optimistic)} - {formatDuration(analysis.dynamicRangeSec.conservative)}</strong></div>
        </div>
        <p>{clarifyAiText(analysis.predictionExplanation)}</p>
        {analysis.adjustmentStatus === "rejected-outside-range" ? <p className="ai-boundary-note">Flash 建议超出当前证据区间，数值调整未采用。</p> : null}
        {analysis.evidence.length > 0 ? (
          <div className="ai-evidence-list">{analysis.evidence.map((item) => <p key={`${item.metric}-${item.value}`}><strong>{item.metric} · {item.value}</strong><span>{item.impact}</span></p>)}</div>
        ) : null}
      </details>
    </>
  );
}

function ProAnalysisContent({ analysis }: { analysis: AiDeepAnalysis }) {
  return (
    <>
      <div className="ai-summary-grid pro-summary-grid">
        <article><span>综合结论</span><p>{clarifyAiText(analysis.overview)}</p></article>
        <article><span>能力演变</span><p>{clarifyAiText(analysis.capabilityEvolution)}</p></article>
      </div>
      <AiInsightList items={[...analysis.metricConflicts, ...analysis.riskCauses]} />
      <details className="ai-adjustment-details" open>
        <summary><span>预测调整与依据</span><strong>{signedPercent(analysis.appliedAdjustmentPercent)}</strong></summary>
        <div className="ai-adjustment-metrics">
          <div><span>算法基线</span><strong>{formatDuration(analysis.flashPredictionSec)}</strong></div>
          <div><span>智能预测</span><strong>{formatDuration(analysis.aiPredictionSec)}</strong></div>
          <div><span>动态区间</span><strong>{formatDuration(analysis.dynamicRangeSec.optimistic)} - {formatDuration(analysis.dynamicRangeSec.conservative)}</strong></div>
        </div>
        <p>{clarifyAiText(analysis.predictionExplanation)}</p>
        {analysis.adjustmentStatus === "rejected-outside-range" ? <p className="ai-boundary-note">建议超出本地算法动态区间，本次调整未采用。</p> : null}
        {analysis.evidence.length > 0 ? (
          <div className="ai-evidence-list">{analysis.evidence.map((item) => <p key={`${item.metric}-${item.value}`}><strong>{item.metric} · {item.value}</strong><span>{item.impact}</span></p>)}</div>
        ) : null}
      </details>
    </>
  );
}

function formatKilometerRange(range: { min: number; max: number }): string {
  return range.min === range.max ? `${range.min} km` : `${range.min}-${range.max} km`;
}

function TrainingPlanContent({ analysis }: { analysis: AiDeepAnalysis }) {
  if (!analysis.trainingPlan.length) return null;
  const remaining = analysis.trainingPlanDaysRemaining === null ? "" : ` · 距比赛 ${analysis.trainingPlanDaysRemaining} 天`;
  return (
    <section className="pro-training-plan" aria-label="下一步训练计划">
      <div className="pro-training-plan-heading">
        <div><span>下一步训练计划</span><small>{analysis.trainingPlanTargetDate ? `从 ${analysis.trainingPlanStartDate} 到 ${analysis.trainingPlanTargetDate}${remaining}` : `从 ${analysis.trainingPlanStartDate} 起的 6 周能力建设路线`} · 智能生成</small></div>
        <i>按周执行</i>
      </div>
      <div className="pro-training-week-list">
        {analysis.trainingPlan.map((week) => (
          <article key={`${week.label}-${week.startDate}`}>
            <header><strong>{week.label}</strong><span>{week.startDate} 至 {week.endDate}</span></header>
            <div className="pro-training-week-metrics">
              <p><span>周跑量</span><strong>{formatKilometerRange(week.weeklyDistanceKm)}</strong></p>
              <p><span>跑步次数</span><strong>{week.sessionsPerWeek} 次</strong></p>
              <p><span>长跑</span><strong>{formatKilometerRange(week.longRunKm)}</strong></p>
            </div>
            <dl>
              <div><dt>关键训练</dt><dd>{clarifyAiText(week.keySession)}</dd></div>
              <div><dt>轻松跑</dt><dd>{clarifyAiText(week.easyRunFocus)}</dd></div>
              <div><dt>恢复安排</dt><dd>{clarifyAiText(week.recovery)}</dd></div>
              <details className="plan-adjustment-reason"><summary>调整理由</summary><p>{clarifyAiText(week.adjustmentReason)}</p></details>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function FlashTrainingPlanContent({ recommendations, warnings }: { recommendations: string[]; warnings: string[] }) {
  if (!recommendations.length) return null;
  return (
    <section className="pro-training-plan flash-training-plan" aria-label="下一步训练计划">
      <div className="pro-training-plan-heading">
        <div><span>下一步训练计划</span><small>Flash 基础版 · 生成 Pro 后会替换为按周计划</small></div>
        <i>基础版</i>
      </div>
      <div className="coach-recommendations">
        {recommendations.map((item, index) => <div key={item}><span>建议 {index + 1}</span><p>{clarifyAiText(item)}</p></div>)}
      </div>
      {warnings.length > 0 ? <div className="coach-warning-list">{warnings.map((item) => <p key={item}>{item}</p>)}</div> : null}
    </section>
  );
}

function DeepPromptEditor({
  id,
  value,
  savedValue,
  saving,
  error,
  onChange,
  onSave,
  showSystemGuidance = false
}: {
  id: string;
  value: string;
  savedValue: string;
  saving: boolean;
  error: string;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
  showSystemGuidance?: boolean;
}) {
  const dirty = value.trim() !== savedValue;
  return (
    <div className="deep-prompt-editor">
      <label htmlFor={id}>个性化分析提示词 <span>可选 · 账户内同步</span></label>
      <textarea
        id={id}
        value={value}
        maxLength={1000}
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        placeholder="例如：重点关注半程马拉松耐力，训练建议以每周跑 4 次为前提，表达直接一些。"
      />
      <div className="deep-prompt-meta">
        <span>{value.length}/1000 · 影响智能建议重点，不能绕过安全规则</span>
        <button type="button" className="ghost-button small-button" disabled={!dirty || saving} onClick={() => void onSave().catch(() => undefined)}>
          {saving ? "保存并分析中..." : dirty ? "保存并重新分析" : "已保存"}
        </button>
      </div>
      {showSystemGuidance ? (
        <details className="system-prompt-details" open>
          <summary>内置训练计划提示词 <span>每次智能分析都会使用</span></summary>
          <p>以下规则由系统固定附加；上方内容是你可自行补充的个性化偏好。</p>
          <pre>{TRAINING_PLAN_SYSTEM_GUIDANCE}</pre>
        </details>
      ) : null}
      {error ? <p className="target-error">{error}</p> : null}
    </div>
  );
}

function PredictionPanel({
  prediction,
  mode,
  backtest,
  deepseekConfigured,
  aiAnalysis,
  deepAnalysis,
  aiLoading,
  deepLoading,
  deepPhase,
  deepElapsedSeconds,
  aiError,
  deepError,
  proCacheStatus,
  deepPrompt,
  savedDeepPrompt,
  promptSaving,
  promptError,
  onDeepPromptChange,
  onSaveDeepPrompt,
  onRequestDeepAnalysis
}: {
  prediction: PredictionResult | null;
  mode: PredictionMode;
  backtest: PredictionBacktestResult;
  deepseekConfigured: boolean;
  aiAnalysis: AiPredictionAnalysis | null;
  deepAnalysis: AiDeepAnalysis | null;
  aiLoading: boolean;
  deepLoading: boolean;
  deepPhase: "preparing" | "analyzing" | "finalizing";
  deepElapsedSeconds: number;
  aiError: string;
  deepError: string;
  proCacheStatus: ProCacheStatus;
  deepPrompt: string;
  savedDeepPrompt: string;
  promptSaving: boolean;
  promptError: string;
  onDeepPromptChange: (value: string) => void;
  onSaveDeepPrompt: () => Promise<void>;
  onRequestDeepAnalysis: (force?: boolean) => void;
}) {
  const [backtestPhase, setBacktestPhase] = useState<"collapsed" | "expanding-latest" | "expanding-history" | "expanded" | "collapsing-history" | "collapsing-latest">("collapsed");
  const [backtestRevealedCount, setBacktestRevealedCount] = useState(0);
  const [activeBacktestFlipIndex, setActiveBacktestFlipIndex] = useState<number | null>(null);
  const backtestFlipTimers = useRef<number[]>([]);

  useEffect(() => () => {
    backtestFlipTimers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  function expandBacktestHistory() {
    if (backtestPhase !== "collapsed") return;
    const latestEntryCount = Math.min(3, backtest.sampleCount);
    const historyEntryCount = Math.max(0, backtest.sampleCount - latestEntryCount);
    if (latestEntryCount === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setBacktestRevealedCount(latestEntryCount);
      setBacktestPhase("expanded");
      return;
    }

    function openHistoryEntries() {
      if (historyEntryCount === 0) {
        setBacktestPhase("expanded");
        backtestFlipTimers.current = [];
        return;
      }

      setBacktestPhase("expanding-history");
      const completeTimer = window.setTimeout(() => {
        setBacktestPhase("expanded");
        backtestFlipTimers.current = [];
      }, historyEntryCount * 95 + 135);
      backtestFlipTimers.current.push(completeTimer);
    }

    function flipEntry(index: number) {
      setActiveBacktestFlipIndex(index);
      const revealTimer = window.setTimeout(() => setBacktestRevealedCount(index + 1), 85);
      const nextTimer = window.setTimeout(() => {
        if (index + 1 < latestEntryCount) {
          flipEntry(index + 1);
          return;
        }
        setActiveBacktestFlipIndex(null);
        openHistoryEntries();
      }, 180);
      backtestFlipTimers.current.push(revealTimer, nextTimer);
    }

    backtestFlipTimers.current.forEach((timer) => window.clearTimeout(timer));
    backtestFlipTimers.current = [];
    setBacktestPhase("expanding-latest");
    flipEntry(0);
  }

  function collapseBacktestHistory() {
    if (backtestPhase !== "expanded") return;
    const latestEntryCount = Math.min(3, backtest.sampleCount);
    const historyEntryCount = Math.max(0, backtest.sampleCount - latestEntryCount);
    backtestFlipTimers.current.forEach((timer) => window.clearTimeout(timer));
    backtestFlipTimers.current = [];
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setActiveBacktestFlipIndex(null);
      setBacktestRevealedCount(0);
      setBacktestPhase("collapsed");
      return;
    }

    function flipLatestEntryBack(index: number) {
      if (index < 0) {
        setActiveBacktestFlipIndex(null);
        setBacktestPhase("collapsed");
        backtestFlipTimers.current = [];
        return;
      }

      setBacktestPhase("collapsing-latest");
      setActiveBacktestFlipIndex(index);
      const concealTimer = window.setTimeout(() => setBacktestRevealedCount(index), 65);
      const nextTimer = window.setTimeout(() => flipLatestEntryBack(index - 1), 140);
      backtestFlipTimers.current.push(concealTimer, nextTimer);
    }

    function closeHistoryEntries() {
      setBacktestPhase("collapsing-history");
      const completeTimer = window.setTimeout(() => {
        flipLatestEntryBack(latestEntryCount - 1);
      }, historyEntryCount * 48 + 105);
      backtestFlipTimers.current.push(completeTimer);
    }

    if (historyEntryCount === 0) {
      flipLatestEntryBack(latestEntryCount - 1);
      return;
    }
    closeHistoryEntries();
  }

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
  const smart = prediction.smartPrediction;
  const smartConfidence = smart
    ? `${smart.confidence === "high" ? "高" : smart.confidence === "medium" ? "中" : "低"}可信 · ${smart.confidenceScore}/100`
    : "数据不足";
  const smartFinishText = deepAnalysis
    ? formatDuration(deepAnalysis.aiPredictionSec)
    : aiAnalysis
      ? formatDuration(aiAnalysis.aiPredictionSec)
      : smart
        ? formatDuration(smart.predictedFinishSec)
        : vdotFinishText;
  const coveragePercent = prediction.targetDistanceKm > 0
    ? Math.min(100, Math.round((prediction.longestDistanceKm / prediction.targetDistanceKm) * 100))
    : 0;
  const currentMarkerPosition = Math.min(96, Math.max(5, coveragePercent));
  const loadFactor = smart?.factors.find((factor) => factor.key === "training-load");
  const loadMatch = loadFactor?.detail.match(/最近 7 天负荷\s*([\d.]+).*?负荷比\s*([\d.]+)/);
  const loadSummary = loadMatch
    ? `${loadMatch[1]} · 比值 ${loadMatch[2]}`
    : loadFactor
      ? signedPercent(loadFactor.impactPercent)
      : "数据不足";
  const smartError = backtest.smartMetrics?.meanAbsolutePercentageError ?? null;
  const vdotError = backtest.vdotMetrics?.meanAbsolutePercentageError ?? null;
  const improvement = backtest.smartImprovementPercent;
  const errorScale = Math.max(vdotError ?? 0, smartError ?? 0, 1);
  const actionable = prediction.recommendations.filter((item) => /训练|跑量|节奏|长距离|恢复|配速|距离/.test(item));
  const flashTrainingRecommendations = [...new Set([
    ...(aiAnalysis?.recommendations.map((item) => item.title) ?? []),
    ...actionable,
    ...prediction.recommendations
  ])].slice(0, 3);
  const confidenceLabel = smart
    ? smart.confidence === "high"
      ? "高可信"
      : smart.confidence === "medium"
        ? "中可信"
        : "低可信"
    : "数据不足";
  const deepPhaseIndex = deepPhase === "preparing" ? 0 : deepPhase === "analyzing" ? 1 : 2;
  const deepPhaseLabels = ["准备数据", "智能分析中", "整理结果"];
  const backtestEntries = [...backtest.entries].reverse();
  const latestBacktestEntries = backtestEntries.slice(0, 3);
  const historyBacktestEntries = backtestEntries.slice(latestBacktestEntries.length);
  const backtestIsOpen = backtestPhase !== "collapsed";
  const backtestIsAnimating = backtestPhase !== "collapsed" && backtestPhase !== "expanded";
  const showHistoryBacktestEntries = backtestPhase === "expanding-history" || backtestPhase === "expanded" || backtestPhase === "collapsing-history";
  return (
    <section className="panel prediction-panel prediction-fusion-panel">
      <div className="prediction-core">
        <div className="prediction-core-main">
          <div className="prediction-forecast">
            <div>
              <span>智能综合预测</span>
              <strong>{smartFinishText}</strong>
              <small>{primaryLabel}：{primaryValue}</small>
            </div>
            <div className="prediction-target-summary">
              <span>目标距离</span>
              <strong>{prediction.targetDistanceKm.toFixed(1)} km</strong>
              <small>当前最长 {prediction.longestDistanceKm.toFixed(1)} km</small>
            </div>
          </div>
          <div className="prediction-key-metrics">
            <div><span>速度能力</span><strong>VDOT {vdotRangeText}</strong></div>
            <div><span>距离准备</span><strong>目标覆盖 {coveragePercent}%</strong></div>
            <div>
              <span>近期负荷</span>
              <strong>{loadSummary}</strong>
              {loadFactor && <small>{signedPercent(loadFactor.impactPercent)} 调整</small>}
            </div>
            <div>
              <span>历史回测</span>
              <strong>{smartError === null ? "数据不足" : `误差 ${smartError.toFixed(1)}%`}</strong>
              {improvement !== null && <small>改善 {signedPercent(improvement)}</small>}
            </div>
          </div>
        </div>
        <div className="prediction-confidence" aria-label={`模型可信度 ${smart?.confidenceScore ?? 0} 分，${confidenceLabel}`}>
          <div className="prediction-confidence-ring">
            <svg viewBox="0 0 44 44" aria-hidden="true">
              <circle className="confidence-track" cx="22" cy="22" r="18" pathLength="100" />
              <circle
                className="confidence-value"
                cx="22"
                cy="22"
                r="18"
                pathLength="100"
                style={{ strokeDasharray: `${smart?.confidenceScore ?? 0} 100` }}
              />
            </svg>
            <strong>{smart?.confidenceScore ?? "-"}</strong>
          </div>
          <span>模型可信度 / 100</span>
          <small>{confidenceLabel}</small>
          {smart && smart.calibrationSampleCount > 0 && <small>个人模型强度 {Math.round(smart.calibrationStrengthPercent)}%</small>}
        </div>
      </div>

      <section className="ai-analysis-sheet" aria-live="polite">
        <div className="prediction-section-heading compact-heading">
          <div>
            <h3>智能训练建议</h3>
            <span>数据或目标变化后自动更新一次；无变化时直接展示已保存结果。</span>
          </div>
          {deepLoading ? (
            <i className="ai-model-badge pro-badge">智能分析中</i>
          ) : deepAnalysis ? (
            <i className="ai-model-badge pro-badge">{deepAnalysis.cached ? "已保存" : "已更新"}</i>
          ) : aiAnalysis ? (
            <i className="ai-model-badge">Flash · {aiAnalysis.cached ? "缓存" : "新分析"}</i>
          ) : null}
        </div>
        {!deepseekConfigured ? (
          <p className="ai-empty-state">在右上角个人资料中配置 DeepSeek API Key 后启用。现有算法预测仍可正常使用。</p>
        ) : aiLoading ? (
          <p className="ai-loading-state"><i />正在恢复已保存的分析或检查最新数据...</p>
        ) : aiError ? (
          <p className="coach-warning-list ai-error-state">{aiError}</p>
        ) : deepLoading ? (
          <div className="deep-progress-card" role="status" aria-label={`${deepPhaseLabels[deepPhaseIndex]}，已等待 ${deepElapsedSeconds} 秒`}>
            <div className="deep-progress-orbit"><i /><span>AI</span></div>
            <div className="deep-progress-copy">
              <strong>{deepPhaseLabels[deepPhaseIndex]}</strong>
              <span>已等待 {deepElapsedSeconds} 秒 · 请保持页面开启</span>
            </div>
            <ol>
              {deepPhaseLabels.map((label, index) => (
                <li key={label} className={index < deepPhaseIndex ? "complete" : index === deepPhaseIndex ? "active" : ""}>
                  <i>{index < deepPhaseIndex ? "✓" : index + 1}</i><span>{label}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : deepAnalysis && aiAnalysis ? (
          <>
            <ProAnalysisContent analysis={deepAnalysis} />
            <TrainingPlanContent analysis={deepAnalysis} />
            <DeepPromptEditor id="prediction-analysis-prompt" value={deepPrompt} savedValue={savedDeepPrompt} saving={promptSaving} error={promptError} onChange={onDeepPromptChange} onSave={onSaveDeepPrompt} />
          </>
        ) : aiAnalysis ? (
          <>
            {deepError ? (
              <div className="deep-error-banner">
                <span>{deepError}</span>
                <button type="button" className="ghost-button small-button" onClick={() => onRequestDeepAnalysis()}>重新尝试</button>
              </div>
            ) : null}
            {proCacheStatus === "outdated" ? <p className="ai-boundary-note">历史 Pro 缓存不包含新版逐周训练计划，已切换至 Flash；需要时可手动生成新版 Pro。</p> : null}
            {proCacheStatus === "target-date-required" ? <p className="ai-boundary-note">请先在上方选择“目标距离 + 达成日期”并点击“更新预测”；Pro 才会生成按周训练计划。</p> : null}
            {proCacheStatus === "target-date-passed" ? <p className="ai-boundary-note">目标比赛日期已过，请先修改为未来日期后再生成 Pro 训练计划。</p> : null}
            <FlashAnalysisContent analysis={aiAnalysis} />
            <FlashTrainingPlanContent recommendations={flashTrainingRecommendations} warnings={prediction.warnings} />
            <DeepPromptEditor
              id="prediction-flash-analysis-prompt"
              value={deepPrompt}
              savedValue={savedDeepPrompt}
              saving={promptSaving}
              error={promptError}
              onChange={onDeepPromptChange}
              onSave={onSaveDeepPrompt}
            />
            {proCacheStatus !== "target-date-passed" && proCacheStatus !== "target-date-required" ? (
              <div className="deep-analysis-action">
                <div><strong>需要更完整的训练规划？</strong><span>Pro 会替代当前主分析，并在本地动态区间内给出最终预测调整。</span></div>
                <button type="button" className="ghost-button" onClick={() => onRequestDeepAnalysis()}>生成深度分析</button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="ai-empty-state">当前数据不足，暂时保留现有算法预测。</p>
        )}
      </section>

      <div className="prediction-roadmap">
        <div className="prediction-section-heading">
          <h3>{prediction.targetDistanceKm >= 20 ? "半程马拉松达标路线" : `${prediction.targetDistanceKm.toFixed(1)} km 达标路线`}</h3>
          <span>从当前最长距离逐步建立目标完赛能力</span>
        </div>
        <div className="roadmap-line" aria-label={`当前最长 ${prediction.longestDistanceKm.toFixed(1)} km，目标 ${prediction.targetDistanceKm.toFixed(1)} km，覆盖 ${coveragePercent}%`}>
          <i className="roadmap-progress" style={{ width: `${coveragePercent}%` }} />
          <span className="roadmap-marker roadmap-start"><i /><b>训练起点</b><small>持续记录</small></span>
          <span className="roadmap-marker roadmap-current" style={{ left: `${currentMarkerPosition}%` }}><i /><b>当前 {prediction.longestDistanceKm.toFixed(1)} km</b><small>覆盖 {coveragePercent}%</small></span>
          <span className="roadmap-marker roadmap-goal"><i /><b>目标 {prediction.targetDistanceKm.toFixed(1)} km</b><small>{primaryValue}</small></span>
        </div>
      </div>

      <div className="prediction-analysis-grid">
          <section className="prediction-factor-sheet">
            <div className="prediction-section-heading compact-heading">
              <h3>智能模型影响因素</h3><span>{smartConfidence}</span>
            </div>
            {smart ? (
              <div className="prediction-factor-bars">
                {smart.factors.map((factor) => {
                  const barWidth = factor.impactPercent === 0 ? 24 : Math.min(100, Math.max(16, Math.abs(factor.impactPercent) * 8));
                  const impactLabel = factor.impactPercent === 0 ? "权重项" : signedPercent(factor.impactPercent);
                  return (
                    <details key={factor.key} className="prediction-factor-row">
                      <summary>
                        <span>{factor.label}</span>
                        <i className="factor-track"><i style={{ width: `${barWidth}%` }} /></i>
                        <strong>{impactLabel}</strong>
                      </summary>
                      <p>{factor.detail}</p>
                    </details>
                  );
                })}
              </div>
            ) : <p className="muted-text">数据不足，暂时无法分析模型影响因素。</p>}
          </section>

          <section className="prediction-backtest-sheet">
            <div className="prediction-section-heading compact-heading">
              <h3>历史预测回测</h3>
              {backtest.status === "ready" ? (
                <button
                  type="button"
                  className={`backtest-history-toggle backtest-heading-toggle${backtestIsOpen ? " is-open" : ""}`}
                  aria-expanded={backtestIsOpen}
                  aria-controls="prediction-backtest-history"
                  onClick={backtestIsOpen ? collapseBacktestHistory : expandBacktestHistory}
                  disabled={backtestIsAnimating}
                >
                  <span>全部参与回测的数据</span><strong>{backtest.sampleCount} 条</strong>
                </button>
              ) : <span>等待样本</span>}
            </div>
            {backtest.status === "ready" ? (
              <>
                <div className="backtest-bars" aria-label={`原始 VDOT 误差 ${vdotError?.toFixed(1) ?? "-"}%，智能模型误差 ${smartError?.toFixed(1) ?? "-"}%`}>
                  <div><i style={{ height: `${Math.max(22, ((vdotError ?? 0) / errorScale) * 100)}%` }}>{vdotError?.toFixed(1)}%</i><span>原始 VDOT</span></div>
                  <div><i className="smart-bar" style={{ height: `${Math.max(22, ((smartError ?? 0) / errorScale) * 100)}%` }}>{smartError?.toFixed(1)}%</i><span>智能模型</span></div>
                  <p>智能误差改善 <strong>{signedPercent(improvement)}</strong></p>
                </div>
                <div
                  id="prediction-backtest-history"
                  className="backtest-records-stage"
                >
                  <div className="backtest-latest-list" aria-label="最近三条历史回测">
                    {latestBacktestEntries.map((entry, index) => (
                      <div key={entry.runId} className={`backtest-reveal-row${activeBacktestFlipIndex === index ? " is-flipping" : ""}${backtestPhase === "collapsing-latest" ? " is-collapsing" : ""}`}>
                        {index < backtestRevealedCount ? (
                          <BacktestDetailRow entry={entry} />
                        ) : (
                          <div className="backtest-latest-row">
                            <span>{entry.date} · {entry.benchmarkLabel}</span>
                            <div>
                              <span>智能预测 <strong>{formatDuration(entry.smartPredictedFinishSec)}</strong></span>
                              <span>实际 <strong>{formatDuration(entry.actualFinishSec)}</strong></span>
                            </div>
                            <small>{predictionErrorLabel(entry.smartErrorSec, entry.actualFinishSec)}</small>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {showHistoryBacktestEntries ? (
                    <>
                      <p className="backtest-history-intro">按日期倒序展示；每次预测只使用该日期之前的跑步和回测样本。</p>
                      <div id="prediction-backtest-history-list" className="backtest-history-list" aria-label="其余参与回测的数据">
                        {historyBacktestEntries.map((entry, index) => (
                          <div
                            key={entry.runId}
                              className={`backtest-history-shutter${backtestPhase === "expanding-history" ? " is-opening" : backtestPhase === "collapsing-history" ? " is-closing" : ""}`}
                              style={{ animationDelay: `${backtestPhase === "collapsing-history" ? (historyBacktestEntries.length - index - 1) * 48 : index * 95}ms` }}
                          >
                            <div className="backtest-history-shutter-content">
                              <BacktestDetailRow entry={entry} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              </>
            ) : <p className="muted-text">系统会使用历史 PB 与比赛记录验证预测误差。</p>}
          </section>
      </div>
    </section>
  );
}

function runnerProfileDraft(profile: RunnerProfile | null): RunnerProfileDraft {
  return {
    birthDate: profile?.birthDate ?? "",
    sex: profile?.sex ?? "",
    heightCm: profile?.heightCm === null || profile?.heightCm === undefined ? "" : String(profile.heightCm)
  };
}

function nullableDraftNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function RunnerProfileMenu({
  username,
  profile,
  deepseekStatus,
  deepPrompt,
  promptSaving,
  promptError,
  onSaved,
  onDeepseekStatusChanged,
  onDeepPromptChange,
  onSaveDeepPrompt,
  onLogout
}: {
  username: string;
  profile: RunnerProfile | null;
  deepseekStatus: DeepseekKeyStatus;
  deepPrompt: string;
  promptSaving: boolean;
  promptError: string;
  onSaved: (profile: RunnerProfile) => void;
  onDeepseekStatusChanged: (status: DeepseekKeyStatus) => void;
  onDeepPromptChange: (value: string) => void;
  onSaveDeepPrompt: () => Promise<void>;
  onLogout: () => void;
}) {
  const [draft, setDraft] = useState<RunnerProfileDraft>(() => runnerProfileDraft(profile));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState("");
  const [showKey, setShowKey] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft(runnerProfileDraft(profile));
  }, [profile]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function setField<K extends keyof RunnerProfileDraft>(key: K, value: RunnerProfileDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const now = new Date().toISOString();
      const payload: RunnerProfile = {
        birthDate: draft.birthDate || null,
        sex: draft.sex || null,
        heightCm: nullableDraftNumber(draft.heightCm),
        restingHeartRateBpm: null,
        measuredMaxHeartRateBpm: null,
        predictionTarget: profile?.predictionTarget ?? null,
        createdAt: profile?.createdAt ?? now,
        updatedAt: now
      };
      const saved = (await api.saveRunnerProfile(payload)).profile;
      onSaved(saved);
      setMessage("个人资料已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存个人资料失败。");
    } finally {
      setBusy(false);
    }
  }

  async function saveDeepseekKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setKeyBusy(true);
    setKeyMessage("");
    try {
      const result = await api.saveDeepseekKey(keyDraft);
      onDeepseekStatusChanged(result.deepseek);
      setKeyDraft("");
      setShowKey(false);
      setKeyMessage("API Key 验证成功并已加密保存。");
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : "保存 DeepSeek API Key 失败。");
    } finally {
      setKeyBusy(false);
    }
  }

  async function deleteDeepseekKey() {
    if (!window.confirm("确定删除当前账户绑定的 DeepSeek API Key 吗？历史分析会保留。")) return;
    setKeyBusy(true);
    setKeyMessage("");
    try {
      const result = await api.deleteDeepseekKey();
      onDeepseekStatusChanged(result.deepseek);
      setKeyDraft("");
      setKeyMessage("DeepSeek API Key 已删除，历史分析仍然保留。");
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : "删除 DeepSeek API Key 失败。");
    } finally {
      setKeyBusy(false);
    }
  }

  return (
    <div className="profile-menu" ref={menuRef}>
      <button
        type="button"
        className="profile-menu-trigger"
        aria-expanded={open}
        aria-controls="runner-profile-popover"
        onClick={() => {
          setMessage("");
          setOpen((current) => !current);
        }}
      >
        <span className="user-avatar" aria-hidden="true">{username.slice(0, 1).toUpperCase()}</span>
        <span className="user-name">{username}</span>
        <span className="profile-menu-caret" aria-hidden="true" />
      </button>
      {open ? (
        <div className="profile-popover" id="runner-profile-popover" role="dialog" aria-label="个人资料">
          <div className="profile-popover-heading">
            <p className="eyebrow">Runner Profile</p>
            <h2>个人资料</h2>
            <span className="profile-account-name">{username}</span>
          </div>
          <form className="profile-popover-form" onSubmit={submit}>
          <label>
            出生日期
            <input type="date" value={draft.birthDate} onChange={(event) => setField("birthDate", event.target.value)} />
          </label>
          <label>
            性别
            <select value={draft.sex} onChange={(event) => setField("sex", event.target.value as RunnerProfileDraft["sex"])}>
              <option value="">暂不填写</option>
              <option value="female">女</option>
              <option value="male">男</option>
              <option value="other">其他</option>
              <option value="prefer-not-to-say">不愿透露</option>
            </select>
          </label>
          <label>
            身高 cm
            <input type="text" inputMode="decimal" value={draft.heightCm} onChange={(event) => setField("heightCm", event.target.value)} />
          </label>
          <button className="primary-button" disabled={busy}>{busy ? "保存中..." : "保存个人资料"}</button>
          <button type="button" className="ghost-button profile-logout-action" onClick={onLogout}>退出账户</button>
          {message && <p className="form-message profile-message">{message}</p>}
        </form>
        <section className="deepseek-settings" aria-labelledby="deepseek-settings-title">
          <div className="deepseek-settings-heading">
            <div>
              <span>AI Service</span>
              <h3 id="deepseek-settings-title">DeepSeek 智能分析</h3>
            </div>
            <i className={deepseekStatus.configured ? "configured" : ""}>
              {deepseekStatus.configured ? "已配置" : "未配置"}
            </i>
          </div>
          {deepseekStatus.configured ? (
            <p className="deepseek-key-status">
              当前密钥 <strong>{deepseekStatus.maskedKey}</strong>
              <small>保存后不会再次显示完整 Key</small>
            </p>
          ) : (
            <p className="deepseek-key-help">绑定个人 API Key 后，进入预测页才会按最新数据生成分析。</p>
          )}
          <form className="deepseek-key-form" onSubmit={saveDeepseekKey}>
            <label>
              {deepseekStatus.configured ? "替换 API Key" : "API Key"}
              <span className="secret-input-wrap">
                <input
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  placeholder="sk-..."
                  disabled={keyBusy}
                />
                <button type="button" onClick={() => setShowKey((current) => !current)}>{showKey ? "隐藏" : "显示"}</button>
              </span>
            </label>
            <div className="deepseek-key-actions">
              <button className="primary-button" disabled={keyBusy || !keyDraft.trim()}>
                {keyBusy ? "验证中..." : "验证并保存"}
              </button>
              {deepseekStatus.configured ? (
                <button type="button" className="danger-text-button" disabled={keyBusy} onClick={deleteDeepseekKey}>删除 Key</button>
              ) : null}
            </div>
          </form>
          {keyMessage ? <p className="form-message profile-message">{keyMessage}</p> : null}
          <DeepPromptEditor
            id="profile-analysis-prompt"
            value={deepPrompt}
            savedValue={deepseekStatus.customPrompt}
            saving={promptSaving}
            error={promptError}
            onChange={onDeepPromptChange}
            onSave={onSaveDeepPrompt}
            showSystemGuidance
          />
        </section>
        </div>
      ) : null}
    </div>
  );
}

function HeartRateBaselinePanel({ baseline }: { baseline: HeartRateBaseline }) {
  return (
    <section className="panel heart-rate-baseline-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Heart Rate Baseline</p>
          <h2>公式心率分区</h2>
        </div>
        <span className="formula-badge">208 - 0.7 × 年龄</span>
      </div>
      <div className="heart-rate-baseline-layout">
        <div className="estimated-max-heart-rate">
          <span>估算最大心率</span>
          <strong>{baseline.effectiveMaxHeartRateBpm ?? "-"}</strong>
          <small>{baseline.effectiveMaxHeartRateBpm ? "bpm · 根据出生日期自动计算" : "在右上角个人资料中填写出生日期后生成"}</small>
        </div>
        <div className="baseline-zones">
          <div className="zone-header"><strong>当前心率分区</strong><span>最大心率比例</span></div>
          <div className="zone-strip">
            {baseline.zones.map((zone) => (
              <div key={zone.zone} className={`zone-item zone-${zone.zone}`}>
                <span>Z{zone.zone}</span>
                <strong>{zone.minBpm}-{zone.maxBpm}</strong>
              </div>
            ))}
            {baseline.zones.length === 0 ? <p className="muted-text">填写出生日期后自动生成心率分区。</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function signedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function PredictionBacktestPanel({ backtest }: { backtest: PredictionBacktestResult }) {
  return (
    <section className="panel backtest-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Walk-forward Backtest</p>
          <h2>历史预测回测</h2>
        </div>
      </div>
      {backtest.status === "ready" ? (
        <>
          <div className="backtest-metrics">
            <div><span>PB/比赛样本</span><strong>{backtest.sampleCount}</strong></div>
            <div><span>原始 VDOT 误差</span><strong>{backtest.vdotMetrics ? `${backtest.vdotMetrics.meanAbsolutePercentageError.toFixed(1)}%` : "-"}</strong></div>
            <div><span>智能模型误差</span><strong>{backtest.smartMetrics ? `${backtest.smartMetrics.meanAbsolutePercentageError.toFixed(1)}%` : "-"}</strong></div>
            <div><span>智能误差改善</span><strong>{signedPercent(backtest.smartImprovementPercent)}</strong></div>
          </div>
          <details className="backtest-history" open>
            <summary><span>全部参与回测的数据</span><strong>{backtest.sampleCount} 条</strong></summary>
            <div className="backtest-history-list">
              {[...backtest.entries].reverse().map((entry) => (
                <article key={entry.runId} className="backtest-history-row">
                  <header><span>{entry.date}</span><strong>{entry.benchmarkLabel}</strong></header>
                  <div className="backtest-history-values">
                    <div><span>实际成绩</span><strong>{formatDuration(entry.actualFinishSec)}</strong></div>
                    <div><span>智能预测</span><strong>{formatDuration(entry.smartPredictedFinishSec)}</strong></div>
                    <div><span>VDOT 对照</span><strong>{formatDuration(entry.vdotPredictedFinishSec)}</strong></div>
                  </div>
                  <p className="backtest-history-error">{predictionErrorLabel(entry.smartErrorSec, entry.actualFinishSec)}</p>
                  <p className="backtest-history-inputs">
                    当时使用 {entry.inputRunCount} 条历史跑步 · {entry.performanceSampleCount} 条表现数据 · {entry.calibrationSampleCount} 条个人校准样本 · 可信度 {entry.smartConfidenceScore}/100
                  </p>
                </article>
              ))}
            </div>
          </details>
        </>
      ) : (
        <div className="empty-chart">系统会自动识别标准距离 PB，并将 PB 与比赛记录作为回测目标。每次回测只使用该日期之前的跑步数据。</div>
      )}
    </section>
  );
}

function VdotPage({ runs }: { runs: RunningRecord[] }) {
  const model = useMemo(() => buildVdotModel(runs), [runs]);
  const range = model.range;
  const [openPbKey, setOpenPbKey] = useState<string | null>(null);

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
          <div className="pb-cards-wrapper">
            {model.personalBests.map((pb) => {
              const history = model.performanceHistory[pb.key];
              const isOpen = openPbKey === pb.key;
              return (
                <Fragment key={pb.key}>
                  <button
                    aria-expanded={isOpen}
                    className={`pb-card${isOpen ? " pb-card-active" : ""}`}
                    data-pb-distance={pb.key}
                    onClick={() => setOpenPbKey(isOpen ? null : pb.key)}
                    type="button"
                  >
                    <span>{pb.label}</span>
                    <strong>{formatDuration(pb.estimatedDurationSec)}</strong>
                    <small>
                      {formatPace(pb.paceSecPerKm)} /km · VDOT {pb.vdot.toFixed(1)}
                    </small>
                    <small>
                      {pb.sourceDate} · {history.length} 条历史成绩
                    </small>
                  </button>
                  {isOpen && (
                    <div className="pb-history-drawer pb-history-drawer-open" data-pb-distance={pb.key}>
                      <div className="pb-history-list">
                        {history.map((entry, index) => {
                          const isCurrentPb = entry.runId === pb.sourceRunId && Math.abs(entry.durationSec - pb.estimatedDurationSec) < 0.5;
                          const statusText = entry.isPersonalBest
                            ? entry.improvementSec === null
                              ? "首个 PB"
                              : `比上次 PB 快 ${formatDuration(entry.improvementSec)}`
                            : "比赛成绩，未刷新 PB";
                          return (
                            <article
                              className="pb-history-entry"
                              key={entry.runId}
                              style={{ ["--blind-index" as unknown as string]: index }}
                            >
                              <div className="pb-history-main">
                                <div className="pb-history-performance">
                                  <time dateTime={entry.date}>{entry.date}</time>
                                  <strong>{formatDuration(entry.durationSec)}</strong>
                                  <span>{formatPace(entry.paceSecPerKm)} /km · VDOT {entry.vdot.toFixed(1)}</span>
                                </div>
                                <div className="pb-history-badges">
                                  {entry.isPersonalBest && <span>{isCurrentPb ? "当前 PB" : "PB"}</span>}
                                  {entry.isRace && <span className="race-badge">比赛</span>}
                                </div>
                              </div>
                              <div className="pb-history-metrics">
                                <div><span>平均心率</span><strong>{entry.averageHeartRateBpm === null ? "-" : `${Math.round(entry.averageHeartRateBpm)} bpm`}</strong></div>
                                <div><span>平均功率</span><strong>{entry.averagePowerW === null ? "-" : `${Math.round(entry.averagePowerW)} W`}</strong></div>
                                <div><span>平均步频</span><strong>{entry.averageCadenceSpm === null ? "-" : `${Math.round(entry.averageCadenceSpm)} spm`}</strong></div>
                                <div><span>耗能评分</span><strong>{entry.effortScore === null ? "-" : `${entry.effortScore}/10`}</strong></div>
                              </div>
                              <footer>{statusText}</footer>
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </Fragment>
              );
            })}
            {model.personalBests.length === 0 && <p className="muted-text">保存跑步记录后，这里会根据不同标准距离 PB 估算 VDOT。</p>}
          </div>
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
  onSaved: (run: RunningRecord) => void;
}) {
  const [draft, setDraft] = useState<RunDraft>(() => (editingRun ? draftFromRun(editingRun) : newRunDraft()));
  const [files, setFiles] = useState<File[]>([]);
  const [filePreviews, setFilePreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [recognizedText, setRecognizedText] = useState("");
  const [splitReviewFields, setSplitReviewFields] = useState<string[]>([]);
  const isNarrow = useNarrowViewport();
  const [mobileSections, setMobileSections] = useState({ performance: false, environment: false, notes: false });

  useEffect(() => {
    setDraft(editingRun ? draftFromRun(editingRun) : newRunDraft());
    setFiles([]);
    setRecognizedText("");
    setSplitReviewFields([]);
    setMobileSections({
      performance: Boolean(editingRun),
      environment: Boolean(editingRun),
      notes: Boolean(editingRun)
    });
  }, [editingRun]);

  useEffect(() => {
    const previews = files.map((file) => URL.createObjectURL(file));
    setFilePreviews(previews);
    return () => previews.forEach((preview) => URL.revokeObjectURL(preview));
  }, [files]);

  function setField<K extends keyof RunDraft>(key: K, value: RunDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function toggleMobileSection(section: keyof typeof mobileSections) {
    setMobileSections((current) => ({ ...current, [section]: !current[section] }));
  }

  function setSplit(index: number, key: keyof SplitDraft, value: string) {
    setDraft((current) => ({
      ...current,
      splits: current.splits.map((split, splitIndex) => (splitIndex === index ? { ...split, [key]: value } : split))
    }));
    setSplitReviewFields((current) => current.filter((item) => item !== `${index + 1}:${key}`));
  }

  function splitNeedsReview(index: number, field: SplitMetricField): boolean {
    return splitReviewFields.includes(`${index + 1}:${field}`);
  }

  function addCompleteSplit() {
    setDraft((current) => {
      const splits = [...current.splits];
      const tailIndex = splits.findIndex((split) => split.kind === "tail");
      if (tailIndex >= 0) {
        splits.splice(tailIndex, 0, { ...emptySplit });
      } else {
        splits.push({ ...emptySplit });
      }
      return { ...current, splits };
    });
  }

  function removeSplit(index: number) {
    setDraft((current) => ({
      ...current,
      splits: current.splits.filter((_split, splitIndex) => splitIndex !== index)
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
      const splits: RunSplit[] = draft.splits.map((split, index) => split.kind === "tail"
        ? {
            index: index + 1,
            kind: "tail",
            durationSec: parseDuration(split.duration ?? ""),
            distanceKm: 0,
            paceSecPerKm: 0,
            heartRateBpm: 0,
            powerW: 0,
            cadenceSpm: 0
          }
        : {
            index: index + 1,
            distanceKm: parseNumber(split.distanceKm, 1),
            paceSecPerKm: parsePace(split.pace),
            heartRateBpm: parseNumber(split.heartRateBpm),
            powerW: parseNumber(split.powerW),
            cadenceSpm: parseNumber(split.cadenceSpm)
          });
      const payload: RunningRecord = {
        id: draft.id,
        dateTime: new Date(draft.dateTime).toISOString(),
        localDate: draft.dateTime.slice(0, 10),
        shoeId: draft.shoeId || null,
        distanceKm,
        durationSec,
        avgPaceSecPerKm: draft.avgPace ? parsePace(draft.avgPace) : durationSec / distanceKm,
        avgPowerW: parseNumber(draft.avgPowerW),
        avgCadenceSpm: parseNumber(draft.avgCadenceSpm),
        avgHeartRateBpm: parseNumber(draft.avgHeartRateBpm),
        effortScore: draft.effortScore ? parseNumber(draft.effortScore) : null,
        effortSource: draft.effortScore ? "apple-watch" : null,
        performanceType: draft.performanceType === "race" ? "race" : null,
        elevationGainM: draft.elevationGainM ? parseNumber(draft.elevationGainM) : null,
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
      let savedRun: RunningRecord;
      if (editingRun) {
        savedRun = (await api.updateRun(payload)).run;
      } else {
        savedRun = (await api.createRun(payload)).run;
      }
      setDraft(newRunDraft());
      setFiles([]);
      setRecognizedText("");
      setMessage(editingRun ? "跑步记录已更新。" : "跑步记录已保存。");
      onSaved(savedRun);
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
      const text = await detectTextFromImages(files, true);
      const patch = extractRunDraftFromOcrText(text);
      setRecognizedText(text || "未识别到文本。");
      if (Object.keys(patch).length === 0) {
        setMessage("未识别到可用的跑步总览数据，请检查截图是否包含体能训练时间和距离。");
        return;
      }
      setDraft((current) => ({ ...current, ...patch }));
      const warnings = getRunOcrWarnings(patch);
      setMessage(
        warnings.length > 0
          ? `已根据截图预填；${warnings.join("；")}。请校对后再保存。`
          : "已识别总览数据，请校对后再保存。"
      );
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
    setSplitReviewFields([]);
    setMessage(window.TextDetector ? "正在识别单段截图，请稍等。" : "正在使用兼容 OCR 识别单段，首次加载可能需要几十秒。");
    try {
      const text = await detectTextFromImages(files, false, true);
      const result = extractSplitsFromOcrText(text, totalDistanceKm);
      setRecognizedText(text || "未识别到文本。");
      if (result.splits.length === 0) {
        setMessage("未识别到可用单段数据，请检查截图是否包含段号、配速、心率、功率或步频。");
        return;
      }
      setDraft((current) => ({ ...current, splits: result.splits }));
      setSplitReviewFields(result.ambiguousFields.map(({ index, field }) => `${index}:${field}`));
      const droppedText =
        result.droppedIndexes.length > 0 ? `已忽略超出总距离的第 ${result.droppedIndexes.join("、")} 段。` : "";
      const missingText =
        result.missingIndexes.length > 0 ? `未找到第 ${result.missingIndexes.join("、")} 段，已保留空行等待补录。` : "";
      const incompleteText =
        result.incompleteIndexes.length > 0 ? `第 ${result.incompleteIndexes.join("、")} 段有字段未可靠识别，请重点校对。` : "各保留分段字段完整。";
      const fieldLabels: Record<SplitMetricField, string> = {
        pace: "配速",
        heartRateBpm: "心率",
        powerW: "功率",
        cadenceSpm: "步频"
      };
      const ambiguityText = result.ambiguousFields.length > 0
        ? `存在候选冲突：${result.ambiguousFields.map(({ index, field, candidates }) => `第${index}段${fieldLabels[field]} ${candidates.join(" / ")}`).join("；")}，黄色字段请人工确认。`
        : "";
      const completeSplitCount = result.splits.filter((split) => split.kind !== "tail").length;
      const tailText = result.tailDuration ? `已追加尾段 ${result.tailDuration}，仅保留时间。` : "未发现可确认的短尾段。";
      setMessage(`已识别 ${result.detectedCount} 段，保留 ${completeSplitCount} 段完整公里。${tailText}${droppedText}${missingText}${incompleteText}${ambiguityText}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "单段截图识别失败，请手动校对录入。");
    }
  }

  return (
    <section className="panel run-entry-panel">
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
          <button type="button" className="ghost-button" onClick={addCompleteSplit}>
            + 分段
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={draft.splits.some((split) => split.kind === "tail")}
            onClick={() => setField("splits", [...draft.splits, { ...emptyTailSplit }])}
          >
            + 尾段
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
            <input
              value={draft.duration}
              onChange={(event) => setField("duration", event.target.value)}
              onBlur={(event) => setField("duration", normalizeClockInput(event.target.value))}
              inputMode="numeric"
              placeholder="4530 或 13520"
            />
          </label>
        </div>
        <button
          type="button"
          className="mobile-form-section-toggle wide"
          aria-expanded={!isNarrow || mobileSections.performance}
          onClick={() => toggleMobileSection("performance")}
        >
          <span><strong>跑步表现</strong><small>配速、心率、步频、功率等</small></span>
          <i aria-hidden="true" />
        </button>
        {(!isNarrow || mobileSections.performance) && <div className="form-section wide">
          <p>跑步表现</p>
          <div className="performance-grid">
            <label>
              平均配速
              <input
                value={draft.avgPace}
                onChange={(event) => setField("avgPace", event.target.value)}
                onBlur={(event) => setField("avgPace", normalizeClockInput(event.target.value))}
                inputMode="numeric"
                placeholder="例如 520"
              />
            </label>
            <label>
              平均心率 bpm
              <input value={draft.avgHeartRateBpm} onChange={(event) => setField("avgHeartRateBpm", event.target.value)} inputMode="numeric" />
            </label>
            <label>
              平均步频 spm
              <input value={draft.avgCadenceSpm} onChange={(event) => setField("avgCadenceSpm", event.target.value)} inputMode="numeric" />
            </label>
            <label>
              平均功率 W
              <input value={draft.avgPowerW} onChange={(event) => setField("avgPowerW", event.target.value)} inputMode="numeric" />
            </label>
            <label>
              Apple Watch 耗能评分
              <input
                type="text"
                value={draft.effortScore}
                onChange={(event) => setField("effortScore", event.target.value)}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={2}
                placeholder="1-10，可后补"
              />
            </label>
            <label>
              成绩性质
              <select value={draft.performanceType} onChange={(event) => setField("performanceType", event.target.value as RunDraft["performanceType"])}>
                <option value="">普通跑步</option>
                <option value="race">比赛</option>
              </select>
            </label>
            <label>
              累计爬升 m（可选）
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={draft.elevationGainM}
                onChange={(event) => setField("elevationGainM", event.target.value)}
              />
            </label>
          </div>
        </div>}
        <button
          type="button"
          className="mobile-form-section-toggle wide"
          aria-expanded={!isNarrow || mobileSections.environment}
          onClick={() => toggleMobileSection("environment")}
        >
          <span><strong>环境</strong><small>气温、湿度与空气质量</small></span>
          <i aria-hidden="true" />
        </button>
        {(!isNarrow || mobileSections.environment) && <div className="form-section weather-section wide">
          <p>环境</p>
          <div className="weather-grid">
            <label>
              气温 ℃
              <input value={draft.temperatureC} onChange={(event) => setField("temperatureC", event.target.value)} inputMode="decimal" />
            </label>
            <label>
              湿度 %
              <input value={draft.humidityPct} onChange={(event) => setField("humidityPct", event.target.value)} inputMode="numeric" />
            </label>
            <label>
              AQI
              <input value={draft.aqi} onChange={(event) => setField("aqi", event.target.value)} inputMode="numeric" />
            </label>
          </div>
        </div>}
        <button
          type="button"
          className="mobile-form-section-toggle wide"
          aria-expanded={!isNarrow || mobileSections.notes}
          onClick={() => toggleMobileSection("notes")}
        >
          <span><strong>主观感受</strong><small>备注本次训练状态</small></span>
          <i aria-hidden="true" />
        </button>
        {(!isNarrow || mobileSections.notes) && <div className="form-section notes-section wide">
          <p>主观感受</p>
          <label>
            备注
            <textarea
              value={draft.notes}
              maxLength={2000}
              onChange={(event) => setField("notes", event.target.value)}
              placeholder="例如：感觉轻松、后半程心率偏高、睡眠不足、天气闷热、腿部疲劳等"
            />
          </label>
        </div>}
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
            {draft.splits.map((split, index) => split.kind === "tail" ? (
              <div className="split-row tail-split-row" key={index}>
                <strong>尾段</strong>
                <input
                  aria-label="尾段时间"
                  value={split.duration ?? ""}
                  onChange={(event) => setSplit(index, "duration", event.target.value)}
                  onBlur={(event) => setSplit(index, "duration", normalizeTailDurationInput(event.target.value))}
                  inputMode="numeric"
                  placeholder="时间"
                />
                <span className="tail-split-note">仅记录时间，不填写配速、心率、功率和步频</span>
                <button type="button" className="ghost-button small-button danger-button split-delete-button" onClick={() => removeSplit(index)}>
                  删除
                </button>
              </div>
            ) : (
              <div className="split-row" key={index}>
                <strong>{index + 1}</strong>
                <input value={split.distanceKm} onChange={(event) => setSplit(index, "distanceKm", event.target.value)} inputMode="decimal" placeholder="km" />
                <input
                  className={splitNeedsReview(index, "pace") ? "ocr-review-field" : undefined}
                  value={split.pace}
                  onChange={(event) => setSplit(index, "pace", event.target.value)}
                  onBlur={(event) => setSplit(index, "pace", normalizeClockInput(event.target.value))}
                  inputMode="numeric"
                  placeholder="配速"
                />
                <input className={splitNeedsReview(index, "heartRateBpm") ? "ocr-review-field" : undefined} value={split.heartRateBpm} onChange={(event) => setSplit(index, "heartRateBpm", event.target.value)} inputMode="numeric" placeholder="心率" />
                <input className={splitNeedsReview(index, "powerW") ? "ocr-review-field" : undefined} value={split.powerW} onChange={(event) => setSplit(index, "powerW", event.target.value)} inputMode="numeric" placeholder="功率" />
                <input className={splitNeedsReview(index, "cadenceSpm") ? "ocr-review-field" : undefined} value={split.cadenceSpm} onChange={(event) => setSplit(index, "cadenceSpm", event.target.value)} inputMode="numeric" placeholder="步频" />
                <button type="button" className="ghost-button small-button danger-button split-delete-button" onClick={() => removeSplit(index)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
        {message && <p className="form-message wide">{message}</p>}
        <div className="run-save-bar wide">
          <button className="primary-button" disabled={busy}>
            {busy ? "保存中..." : editingRun ? "确认更新记录" : "保存跑步记录"}
          </button>
        </div>
      </form>
    </section>
  );
}

function ShoeLibrary({
  shoes,
  runs,
  onSaved,
  onDeleted
}: {
  shoes: RunningShoe[];
  runs: RunningRecord[];
  onSaved: (shoe: RunningShoe) => void;
  onDeleted: (shoeId: string) => void;
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

  const runCountByShoe = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of runs) {
      if (!run.shoeId) continue;
      counts.set(run.shoeId, (counts.get(run.shoeId) ?? 0) + 1);
    }
    return counts;
  }, [runs]);

  const lastRunByShoe = useMemo(() => {
    const dates = new Map<string, string>();
    for (const run of runs) {
      if (!run.shoeId) continue;
      const date = runLocalDate(run);
      if (!dates.has(run.shoeId) || date > dates.get(run.shoeId)!) {
        dates.set(run.shoeId, date);
      }
    }
    return dates;
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
      let savedShoe: RunningShoe;
      if (editingShoe) {
        savedShoe = (await api.updateShoe(shoe)).shoe;
      } else {
        savedShoe = (await api.createShoe(shoe)).shoe;
      }
      setName("");
      setPhoto(null);
      setEditingShoe(null);
      setMessage(editingShoe ? "跑鞋已更新。" : "跑鞋已添加。");
      onSaved(savedShoe);
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
    onDeleted(shoe.id);
  }

  return (
    <section className="shoe-page">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Shoe Library</p>
            <h2>{editingShoe ? "编辑跑鞋" : "鞋库"}</h2>
          </div>
          <div className="shoe-library-actions">
            <span className="shoe-count">{shoes.length} 双跑鞋</span>
            {editingShoe && (
              <button type="button" className="ghost-button" onClick={cancelEdit}>
                取消编辑
              </button>
            )}
          </div>
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
          const runCount = runCountByShoe.get(shoe.id) ?? 0;
          const lastRunDate = lastRunByShoe.get(shoe.id) ?? "-";
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
                </div>
                <div className="shoe-performance-strip">
                  <div className="shoe-mileage">
                    <span>累计跑量</span>
                    <strong>{formatKm(usedKm)} km</strong>
                  </div>
                  <div className="shoe-run-count">
                    <span>关联跑步</span>
                    <strong>{runCount} 次</strong>
                  </div>
                  <div className="shoe-last-run">
                    <span>最近使用</span>
                    <strong>{lastRunDate}</strong>
                  </div>
                </div>
                <div className="shoe-mileage-line" aria-hidden="true">
                  <span className={usedKm > 0 ? "has-mileage" : ""} />
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
            </article>
          );
        })}
        {shoes.length === 0 && <div className="empty-shoes">添加第一双跑鞋后，这里会显示它的照片、名称和累计里程。</div>}
      </section>
    </section>
  );
}

function WeightForm({
  editingWeight,
  onCancelEdit,
  onSaved
}: {
  editingWeight: WeightRecord | null;
  onCancelEdit: () => void;
  onSaved: (weight: WeightRecord, previousDate: string | null) => void;
}) {
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
      const saved = await api.saveWeight({ date, weightKg: parseNumber(weightKg) });
      const previousDate = editingWeight && editingWeight.date !== date ? editingWeight.date : null;
      if (editingWeight && editingWeight.date !== date) {
        await api.deleteWeight(editingWeight.date);
      }
      setWeightKg("");
      setMessage(editingWeight ? "体重记录已更新。" : "体重记录已保存。");
      onSaved(saved.weight, previousDate);
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

function RecordOverview({
  runs,
  weights,
  shoes,
  loading
}: {
  runs: RunningRecord[];
  weights: WeightRecord[];
  shoes: RunningShoe[];
  loading: boolean;
}) {
  const latestRun = runs[0] ?? null;
  return (
    <section className="panel record-overview-panel" aria-label="记录概览">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Record Overview</p>
          <h2>记录概览</h2>
        </div>
        {loading && <span className="loading-dot">同步中</span>}
      </div>
      <div className="record-overview-grid">
        <div><span>跑步</span><strong>{runs.length} 次</strong></div>
        <div><span>体重</span><strong>{weights.length} 条</strong></div>
        <div><span>跑鞋</span><strong>{shoes.length} 双</strong></div>
      </div>
      <div className="record-latest-run">
        <span>最近一次跑步</span>
        {latestRun ? (
          <strong>{runLocalDate(latestRun)} · {latestRun.distanceKm.toFixed(2)} km · {formatPace(latestRun.avgPaceSecPerKm)} /km</strong>
        ) : (
          <strong>暂无记录</strong>
        )}
      </div>
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
                        const completeSplitCount = run.splits.filter((split) => split.kind !== "tail").length;
                        const tailSplit = run.splits.find((split) => split.kind === "tail");
                        const hasSplits = completeSplitCount > 0 || Boolean(tailSplit);
                        const hasShoe = Boolean(run.shoeId);
                        const shoeName = run.shoeId ? shoeNames.get(run.shoeId) ?? "已删除跑鞋" : "未关联跑鞋";
                        return (
                          <div className="history-item" key={run.id}>
                            <div className="history-item-main">
                              <div className="history-title-row">
                                <strong>{runLocalDate(run)}</strong>
                                <span className="history-badges">
                                  <HistoryDataBadge
                                    present={hasSplits}
                                    title={hasSplits
                                      ? `${completeSplitCount} 段${tailSplit ? ` + 尾段 ${formatDuration(tailSplit.durationSec ?? 0)}` : ""}`
                                      : "未录入分段"}
                                    className="split-badge"
                                  >
                                    <SplitBadgeIcon />
                                  </HistoryDataBadge>
                                  <HistoryDataBadge present={hasShoe} title={shoeName} className="shoe-badge">
                                    <ShoeBadgeIcon />
                                  </HistoryDataBadge>
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
                                <span className="history-stat">
                                  <small>耗能评分</small>
                                  <b>{run.effortScore ?? "-"}</b>
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
  const [runnerProfile, setRunnerProfile] = useState<RunnerProfile | null>(null);
  const [deepseekStatus, setDeepseekStatus] = useState<DeepseekKeyStatus>({ configured: false, maskedKey: null, updatedAt: null, customPrompt: "" });
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<AiPredictionAnalysis | null>(null);
  const [deepAnalysis, setDeepAnalysis] = useState<AiDeepAnalysis | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepPhase, setDeepPhase] = useState<"preparing" | "analyzing" | "finalizing">("preparing");
  const [deepElapsedSeconds, setDeepElapsedSeconds] = useState(0);
  const [aiError, setAiError] = useState("");
  const [deepError, setDeepError] = useState("");
  const [proCacheStatus, setProCacheStatus] = useState<ProCacheStatus>("missing");
  const [deepPrompt, setDeepPrompt] = useState("");
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptError, setPromptError] = useState("");
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

  function switchView(view: AppView) {
    setActiveView(view);
    requestAnimationFrame(() => window.scrollTo({ top: 0 }));
  }

  function scrollToForms() {
    setActiveView("records");
    requestAnimationFrame(() => {
      document.querySelector(".records-page")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function refresh() {
    setLoading(true);
    const [runData, shoeData, weightData, profileData, aiSettingsData] = await Promise.all([
      api.listRuns(),
      api.listShoes(),
      api.listWeights(),
      api.getRunnerProfile(),
      api.getDeepseekSettings().catch(() => ({ deepseek: { configured: false, maskedKey: null, updatedAt: null, customPrompt: "" } satisfies DeepseekKeyStatus }))
    ]);
    setRuns(sortRuns(runData.runs));
    setShoes(sortShoes(shoeData.shoes));
    setWeights(sortWeights(weightData.weights));
    setRunnerProfile(profileData.profile);
    const savedTarget = profileData.profile?.predictionTarget;
    if (savedTarget) {
      setTargetDistance(savedTarget.targetDistanceKm);
      setTargetDistanceInput(String(savedTarget.targetDistanceKm));
      setPredictionMode(savedTarget.mode);
      setAppliedPredictionMode(savedTarget.mode);
      const finishInput = savedTarget.targetFinishSec ? formatDuration(savedTarget.targetFinishSec) : "2:00:00";
      setTargetFinishInput(finishInput);
      setAppliedTargetFinishInput(finishInput);
      if (savedTarget.targetDate) {
        setTargetDateInput(savedTarget.targetDate);
        setAppliedTargetDateInput(savedTarget.targetDate);
      }
    }
    setDeepseekStatus(aiSettingsData.deepseek);
    setDeepPrompt(aiSettingsData.deepseek.customPrompt);
    setLoading(false);
  }

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    try {
      setPrediction(
        buildPrediction(runs, weights, targetDistance, {
          targetFinishSec: appliedPredictionMode === "finish-date" ? parseDuration(appliedTargetFinishInput) : null,
          targetDate: appliedPredictionMode === "date-finish" ? appliedTargetDateInput : null,
          runnerProfile
        })
      );
    } catch {
      setPrediction(null);
    }
  }, [runs, weights, runnerProfile, targetDistance, appliedPredictionMode, appliedTargetFinishInput, appliedTargetDateInput]);

  const aiTargetFinishSec = appliedPredictionMode === "finish-date" ? parseDuration(appliedTargetFinishInput) : null;
  const aiTargetDate = appliedPredictionMode === "date-finish" ? appliedTargetDateInput : null;

  useEffect(() => {
    if (activeView !== "prediction" || !deepseekStatus.configured || prediction?.status !== "ready") return;
    let ignore = false;
    setAiAnalysis(null);
    setDeepAnalysis(null);
    setDeepError("");
    setProCacheStatus("missing");
    setAiLoading(true);
    setAiError("");
    api.aiPrediction({
      kind: "current",
      targetDistanceKm: targetDistance,
      targetFinishSec: aiTargetFinishSec,
      targetDate: aiTargetDate
    }).then((result) => {
      if (!ignore) {
        setProCacheStatus(result.proCacheStatus ?? "missing");
        if (result.analysis.kind === "deep") {
          setDeepAnalysis(result.analysis);
          if (result.standard) setAiAnalysis(result.standard);
        } else {
          setAiAnalysis(result.analysis);
          setDeepAnalysis(null);
        }
      }
    }).catch((error) => {
      if (!ignore) setAiError(error instanceof Error ? error.message : "AI 分析生成失败。");
    }).finally(() => {
      if (!ignore) setAiLoading(false);
    });
    return () => { ignore = true; };
  }, [
    activeView,
    deepseekStatus.configured,
    prediction?.status,
    targetDistance,
    aiTargetFinishSec,
    aiTargetDate,
    runs,
    weights,
    runnerProfile
  ]);

  useEffect(() => {
    if (!deepLoading) return;
    setDeepElapsedSeconds(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setDeepElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [deepLoading]);

  async function saveDeepPrompt(regenerate = true): Promise<void> {
    setPromptSaving(true);
    setPromptError("");
    try {
      const result = await api.saveDeepseekPrompt(deepPrompt);
      setDeepseekStatus(result.deepseek);
      setDeepPrompt(result.deepseek.customPrompt);
      if (regenerate && result.deepseek.configured && prediction?.status === "ready") {
        await generateDeepAnalysis(true).catch(() => undefined);
      }
    } catch (error) {
      setPromptError(error instanceof Error ? error.message : "个性化提示词保存失败。");
      throw error;
    } finally {
      setPromptSaving(false);
    }
  }

  async function generateDeepAnalysis(force = false): Promise<void> {
    setDeepLoading(true);
    setDeepPhase("preparing");
    setDeepError("");
    try {
      setDeepPhase("analyzing");
      const result = await api.aiPrediction({
        kind: "deep",
        targetDistanceKm: targetDistance,
        targetFinishSec: aiTargetFinishSec,
        targetDate: aiTargetDate,
        force
      });
      setDeepPhase("finalizing");
      await new Promise((resolve) => window.setTimeout(resolve, 320));
      if (result.analysis.kind === "deep") setDeepAnalysis(result.analysis);
      if (result.standard) setAiAnalysis(result.standard);
      if (result.analysis.kind === "deep") setProCacheStatus("restored");
    } catch (error) {
      setDeepError(error instanceof Error ? error.message : "深度分析生成失败。");
      throw error;
    } finally {
      setDeepLoading(false);
    }
  }

  async function requestDeepAnalysis(force = false) {
    if (deepPrompt.trim() !== deepseekStatus.customPrompt) {
      try {
        await saveDeepPrompt(false);
      } catch {
        return;
      }
    }
    await generateDeepAnalysis(force).catch(() => undefined);
  }

  function upsertRun(run: RunningRecord) {
    setRuns((current) => sortRuns([run, ...current.filter((item) => item.id !== run.id)]));
  }

  function upsertWeight(weight: WeightRecord, previousDate: string | null = null) {
    setWeights((current) =>
      sortWeights([weight, ...current.filter((item) => item.date !== weight.date && item.date !== previousDate)])
    );
  }

  function upsertShoe(shoe: RunningShoe) {
    setShoes((current) => sortShoes([shoe, ...current.filter((item) => item.id !== shoe.id)]));
  }

  function removeShoeFromState(shoeId: string) {
    setShoes((current) => current.filter((shoe) => shoe.id !== shoeId));
    setRuns((current) => current.map((run) => (run.shoeId === shoeId ? { ...run, shoeId: null, updatedAt: new Date().toISOString() } : run)));
  }

  const summary = useMemo(() => {
    const totalDistance = runs.reduce((sum, run) => sum + run.distanceKm, 0);
    const bestPace = runs.length ? Math.min(...runs.map((run) => run.avgPaceSecPerKm)) : null;
    const latestWeight = weights[0]?.weightKg ?? null;
    return { totalDistance, bestPace, latestWeight };
  }, [runs, weights]);

  const heartRateBaseline = useMemo(() => buildHeartRateBaseline(runnerProfile, runs), [runnerProfile, runs]);
  const predictionBacktest = useMemo(
    () => buildPredictionBacktest(runs, weights, { runnerProfile }),
    [runs, weights, runnerProfile]
  );

  const targetIsDirty =
    targetDistanceInput !== String(targetDistance) ||
    predictionMode !== appliedPredictionMode ||
    targetFinishInput !== appliedTargetFinishInput ||
    targetDateInput !== appliedTargetDateInput;

  async function applyPredictionTarget(event?: FormEvent<HTMLFormElement>) {
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

    const nextMode = predictionMode;
    const nextFinishSec = nextMode === "finish-date" ? parseDuration(targetFinishInput) : null;
    const nextDate = nextMode === "date-finish" ? targetDateInput : null;
    if (nextMode === "date-finish" && (typeof nextDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(nextDate))) {
      setTargetError("请选择有效的目标日期。");
      return;
    }
    const now = new Date().toISOString();
    const profilePayload: RunnerProfile = {
      birthDate: runnerProfile?.birthDate ?? null,
      sex: runnerProfile?.sex ?? null,
      heightCm: runnerProfile?.heightCm ?? null,
      restingHeartRateBpm: runnerProfile?.restingHeartRateBpm ?? null,
      measuredMaxHeartRateBpm: runnerProfile?.measuredMaxHeartRateBpm ?? null,
      predictionTarget: { mode: nextMode, targetDistanceKm: nextDistance, targetFinishSec: nextFinishSec, targetDate: nextDate },
      createdAt: runnerProfile?.createdAt ?? now,
      updatedAt: now
    };
    try {
      const saved = (await api.saveRunnerProfile(profilePayload)).profile;
      setRunnerProfile(saved);
    } catch (error) {
      setTargetError(error instanceof Error ? `目标未保存：${error.message}` : "目标保存失败，请稍后重试。");
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
    const ok = window.confirm(`确定删除 ${runLocalDate(run)} 的跑步记录吗？此操作不能撤销。`);
    if (!ok) return;
    await api.deleteRun(run.id);
    if (editingRun?.id === run.id) {
      setEditingRun(null);
    }
    setRuns((current) => current.filter((item) => item.id !== run.id));
  }

  async function deleteWeightRecord(weight: WeightRecord) {
    const ok = window.confirm(`确定删除 ${weight.date} 的体重记录吗？此操作不能撤销。`);
    if (!ok) return;
    await api.deleteWeight(weight.date);
    if (editingWeight?.date === weight.date) {
      setEditingWeight(null);
    }
    setWeights((current) => current.filter((item) => item.date !== weight.date));
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-main">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <h1>RUNNING PLATFORM</h1>
          </div>
          <nav className="view-tabs" aria-label="页面切换">
            <button
              type="button"
              className={activeView === "home" ? "active" : ""}
              onClick={() => switchView("home")}
              aria-current={activeView === "home" ? "page" : undefined}
            >
              主页
            </button>
            <button
              type="button"
              className={activeView === "records" ? "active" : ""}
              onClick={() => switchView("records")}
              aria-current={activeView === "records" ? "page" : undefined}
            >
              记录
            </button>
            <button
              type="button"
              className={activeView === "vdot" ? "active" : ""}
              onClick={() => switchView("vdot")}
              aria-current={activeView === "vdot" ? "page" : undefined}
            >
              跑力值
            </button>
            <button
              type="button"
              className={activeView === "prediction" ? "active" : ""}
              onClick={() => switchView("prediction")}
              aria-current={activeView === "prediction" ? "page" : undefined}
            >
              预测建议
            </button>
            <button
              type="button"
              className={activeView === "shoes" ? "active" : ""}
              onClick={() => switchView("shoes")}
              aria-current={activeView === "shoes" ? "page" : undefined}
            >
              鞋库
            </button>
          </nav>
        </div>
        <div className="user-actions">
          <RunnerProfileMenu
            username={user.username}
            profile={runnerProfile}
            deepseekStatus={deepseekStatus}
            deepPrompt={deepPrompt}
            promptSaving={promptSaving}
            promptError={promptError}
            onSaved={setRunnerProfile}
            onDeepseekStatusChanged={(status) => {
              setDeepseekStatus(status);
              if (!status.configured) {
                setAiAnalysis(null);
                setDeepAnalysis(null);
              }
            }}
            onDeepPromptChange={(value) => {
              setDeepPrompt(value.slice(0, 1000));
              setPromptError("");
            }}
            onSaveDeepPrompt={saveDeepPrompt}
            onLogout={onLogout}
          />
          <button className="ghost-button desktop-logout-button" onClick={onLogout}>退出</button>
        </div>
      </header>

      {activeView === "home" && (
        <section className="home-dashboard">
          <section className="summary-grid" aria-label="跑步数据概览">
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

          <section className="hero-grid">
            <div className="chart-panel">
              <div className="panel-heading chart-heading">
                <div>
                  <p className="eyebrow">Trend Model</p>
                  <h2>跑步表现与训练负荷</h2>
                </div>
              </div>
              {runs.length || weights.length ? (
                <IndependentResearchCharts runs={runs} weights={weights} />
              ) : (
                <div className="empty-chart">保存跑步或体重记录后显示趋势图。</div>
              )}
            </div>
          </section>
        </section>
      )}

      {activeView === "prediction" && (
        <section className="prediction-page">
          <section className="panel prediction-control-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Prediction Workspace</p>
                <h2>目标预测与训练建议</h2>
              </div>
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
                <input inputMode="decimal" value={targetDistanceInput} onChange={(event) => setTargetDistanceInput(event.target.value)} />
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
                <button type="submit" className="primary-button small-primary">更新预测</button>
                {targetIsDirty && <span>未应用</span>}
              </div>
              {targetError && <p className="target-error">{targetError}</p>}
            </form>
          </section>
          <PredictionPanel
            prediction={prediction}
            mode={appliedPredictionMode}
            backtest={predictionBacktest}
            deepseekConfigured={deepseekStatus.configured}
            aiAnalysis={aiAnalysis}
            deepAnalysis={deepAnalysis}
            aiLoading={aiLoading}
            deepLoading={deepLoading}
            deepPhase={deepPhase}
            deepElapsedSeconds={deepElapsedSeconds}
            aiError={aiError}
            deepError={deepError}
            proCacheStatus={proCacheStatus}
            deepPrompt={deepPrompt}
            savedDeepPrompt={deepseekStatus.customPrompt}
            promptSaving={promptSaving}
            promptError={promptError}
            onDeepPromptChange={(value) => {
              setDeepPrompt(value.slice(0, 1000));
              setPromptError("");
            }}
            onSaveDeepPrompt={saveDeepPrompt}
            onRequestDeepAnalysis={requestDeepAnalysis}
          />
        </section>
      )}

      {activeView === "records" && (
        <section className="records-page">
          <section className="workspace-grid">
            <RunForm shoes={shoes} editingRun={editingRun} onCancelEdit={() => setEditingRun(null)} onSaved={upsertRun} />
            <div className="side-column">
              <WeightForm editingWeight={editingWeight} onCancelEdit={() => setEditingWeight(null)} onSaved={upsertWeight} />
              <RecordOverview runs={runs} weights={weights} shoes={shoes} loading={loading} />
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
        <ShoeLibrary shoes={shoes} runs={runs} onSaved={upsertShoe} onDeleted={removeShoeFromState} />
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
