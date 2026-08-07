import * as echarts from "echarts";
import { Component, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import {
  extractRunDraftFromText as extractRunDraftFromOcrText,
  extractSplitsFromText as extractSplitsFromOcrText,
  getRunOcrWarnings,
  type SplitDraft,
  type SplitOcrResult
} from "./ocr";
import { buildHeartRateBaseline, type HeartRateBaseline } from "@shared/physiology";
import { buildPrediction, buildPredictionBacktest } from "@shared/predictions";
import { runLocalDate, runLocalMonth } from "@shared/runDates";
import { normalizeTailDurationInput } from "@shared/timeInputs";
import type {
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
type PredictionMode = "distance-date" | "finish-date" | "date-finish";
type AppView = "home" | "records" | "vdot" | "prediction" | "shoes";
type VolumeChartMode = "weekly" | "monthly";
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
    incompleteIndexes: []
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

async function detectTextFromImages(files: File[], includeEffortRegion = false): Promise<string> {
  const texts: string[] = [];
  const priorityTexts: string[] = [];

  if (window.TextDetector) {
    const detector = new window.TextDetector();
    for (const file of files) {
      const bitmap = await createImageBitmap(file);
      const results = await detector.detect(bitmap);
      const fullText = results.map((result) => result.rawValue ?? "").filter(Boolean).join("\n");
      if (fullText) texts.push(fullText);
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
    } else if (name === "心率拟合" && Array.isArray(value)) {
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

function chartTooltip(extra: echarts.EChartsOption["tooltip"] = {}): echarts.EChartsOption["tooltip"] {
  return {
    formatter: chartTooltipFormatter,
    confine: true,
    position: boundedTooltipPosition,
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
      type: "inside",
      xAxisIndex: 0,
      start,
      end: 100,
      filterMode: "filter",
      moveOnMouseMove: true,
      moveOnMouseWheel: true,
      zoomOnMouseWheel: false
    },
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
      type: "inside",
      xAxisIndex: 0,
      start: 0,
      end: 100,
      filterMode: "filter",
      moveOnMouseMove: true,
      moveOnMouseWheel: true,
      zoomOnMouseWheel: false
    },
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

function ChartCanvas({ option, className = "" }: { option: echarts.EChartsOption; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chart.setOption(option, true);
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, [option]);

  return <div className={`chart ${className}`} ref={ref} />;
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

function RunTrendChart({ runs }: { runs: RunningRecord[] }) {
  const isNarrow = useNarrowViewport();
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
      color: ["#1864ab", "#2b8a3e", "#c92a2a", "#f08c00"],
      tooltip: chartTooltip({ trigger: "axis" }),
      legend: {
        top: 8,
        left: isNarrow ? 4 : 12,
        right: isNarrow ? 4 : undefined,
        type: "plain",
        itemGap: isNarrow ? 5 : 12,
        itemWidth: isNarrow ? 18 : 25,
        itemHeight: isNarrow ? 10 : 14,
        textStyle: { fontSize: isNarrow ? 11 : 12 },
        data: ["实际配速", "3次移动平均", "单次距离", "平均心率"]
      },
      grid: isNarrow
        ? { top: 112, left: 42, right: 38, bottom: 58, containLabel: true }
        : { top: 70, left: 62, right: 166, bottom: 58, containLabel: true },
      dataZoom: xAxisZoom(dates.length, 8),
      xAxis: { type: "category", data: dates, boundaryGap: false },
      yAxis: [
        {
          type: "value",
          name: isNarrow ? "" : "配速 /km",
          nameLocation: "middle",
          nameGap: isNarrow ? 0 : 46,
          inverse: true,
          min: paceRange.min,
          max: paceRange.max,
          axisLabel: { formatter: (value: number) => formatPace(value) }
        },
        {
          type: "value",
          name: isNarrow ? "" : "距离 km",
          nameLocation: "middle",
          nameGap: isNarrow ? 0 : 50,
          position: "right",
          min: distanceRange.min,
          max: distanceRange.max,
          axisLabel: { margin: 10 }
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
          axisLabel: { show: !isNarrow, margin: 10 },
          axisTick: { show: !isNarrow },
          splitLine: { show: false }
        }
      ],
      series: [
        { name: "实际配速", type: "line", data: paces, smooth: true, symbolSize: 8, clip: true },
        { name: "3次移动平均", type: "line", data: paceAverage, smooth: true, lineStyle: { type: "dashed", width: 2 }, symbol: "none", clip: true },
        { name: "单次距离", type: "bar", yAxisIndex: 1, data: distances, barMaxWidth: 20, opacity: 0.42, clip: true },
        { name: "平均心率", type: "line", yAxisIndex: 2, data: heartRates, smooth: true, symbolSize: 7, clip: true }
      ]
    };
  }, [runs, isNarrow]);

  return (
    <div className="chart-block">
      <h3>跑步表现趋势</h3>
      <ChartCanvas option={option} className="run-trend-chart" />
    </div>
  );
}

function WeightRelationChart({ runs, weights }: { runs: RunningRecord[]; weights: WeightRecord[] }) {
  const isNarrow = useNarrowViewport();
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
        return weight ? [weight.weightKg, run.avgPaceSecPerKm, run.distanceKm] : null;
      })
      .filter(Boolean);
    const weightHeartRateScatter = sorted
      .map((run) => {
        const weight = nearestWeight(run, weights);
        return weight ? [weight.weightKg, run.avgHeartRateBpm, run.distanceKm] : null;
      })
      .filter(Boolean);

    return {
      color: ["#d59b3a", "#7048e8"],
      tooltip: chartTooltip(),
      legend: { top: 8, left: 12, itemGap: isNarrow ? 8 : 12, data: ["体重-配速", "体重-心率"] },
      grid: isNarrow
        ? { top: 70, left: 42, right: 38, bottom: 58, containLabel: true }
        : { top: 64, left: 62, right: 86, bottom: 58, containLabel: true },
      dataZoom: xValueZoom(),
      xAxis: {
        type: "value",
        name: "体重 kg",
        nameLocation: "middle",
        nameGap: isNarrow ? 24 : 32,
        min: weightRange.min,
        max: weightRange.max,
        splitLine: { lineStyle: { type: "dashed" } }
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
          axisLabel: { formatter: (value: number) => formatPace(value) }
        },
        {
          type: "value",
          name: isNarrow ? "" : "心率 bpm",
          nameLocation: "middle",
          nameGap: isNarrow ? 0 : 48,
          position: "right",
          min: heartRateRange.min,
          max: heartRateRange.max
        }
      ],
      series: [
        {
          name: "体重-配速",
          type: "scatter",
          data: weightPaceScatter,
          symbolSize: (value: number[]) => Math.max(8, Math.min(24, value[2] * 1.5)),
          clip: true
        },
        {
          name: "体重-心率",
          type: "scatter",
          yAxisIndex: 1,
          data: weightHeartRateScatter,
          symbolSize: (value: number[]) => Math.max(8, Math.min(24, value[2] * 1.5)),
          clip: true
        }
      ]
    };
  }, [runs, weights, isNarrow]);

  return (
    <div className="chart-block">
      <h3>体重与跑步表现</h3>
      <ChartCanvas option={option} className="relation-chart" />
    </div>
  );
}

function PaceHeartChart({ runs }: { runs: RunningRecord[] }) {
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
      color: ["#1864ab", "#2b8a3e"],
      tooltip: chartTooltip(),
      legend: { top: 8, left: 12, data: ["配速-心率", "心率拟合"] },
      grid: { top: 64, left: 62, right: 52, bottom: 58, containLabel: true },
      dataZoom: xValueZoom(),
      xAxis: {
        type: "value",
        name: "配速 /km",
        nameLocation: "middle",
        nameGap: 32,
        min: paceRange.min,
        max: paceRange.max,
        axisLabel: { formatter: (value: number) => formatPace(value) },
        splitLine: { lineStyle: { type: "dashed" } }
      },
      yAxis: {
        type: "value",
        name: "心率 bpm",
        nameLocation: "middle",
        nameGap: 46,
        min: heartRateRange.min,
        max: heartRateRange.max
      },
      series: [
        {
          name: "配速-心率",
          type: "scatter",
          data: paceHeartScatter,
          symbolSize: (value: number[]) => Math.max(8, Math.min(24, value[2] * 1.5)),
          clip: true
        },
        {
          name: "心率拟合",
          type: "line",
          data: paceHeartLine,
          symbol: "none",
          lineStyle: { type: "dashed", width: 2 },
          clip: true
        }
      ]
    };
  }, [runs]);

  return (
    <div className="chart-block">
      <h3>配速与心率</h3>
      <ChartCanvas option={option} className="scatter-chart" />
    </div>
  );
}

function VolumeChart({ runs }: { runs: RunningRecord[] }) {
  const [volumeMode, setVolumeMode] = useState<VolumeChartMode>("weekly");
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
      color: ["#0f766e", "#1864ab"],
      tooltip: chartTooltip({ trigger: "axis" }),
      legend: { top: 8, left: 12, data: [volumeLabel, volumeLongestLabel] },
      grid: { top: 64, left: 62, right: 52, bottom: 58, containLabel: true },
      dataZoom: xAxisZoom(volumeLabels.length, 6),
      xAxis: { type: "category", data: volumeLabels },
      yAxis: {
        type: "value",
        name: `${volumeLabel} km`,
        nameLocation: "middle",
        nameGap: 44,
        min: volumeDistanceRange.min,
        max: volumeDistanceRange.max
      },
      series: [
        {
          name: volumeLabel,
          type: "bar",
          data: volumeData.map((item) => Number(item.distanceKm.toFixed(1))),
          barMaxWidth: 28,
          clip: true
        },
        {
          name: volumeLongestLabel,
          type: "line",
          data: volumeData.map((item) => Number(item.longestDistanceKm.toFixed(1))),
          smooth: true,
          symbolSize: 8,
          clip: true
        }
      ]
    };
  }, [runs, volumeMode]);

  return (
    <div className="chart-block volume-chart-block">
      <div className="chart-block-heading">
        <h3>{volumeMode === "weekly" ? "周跑量" : "月跑量"}</h3>
        <div className="chart-volume-tabs" aria-label="跑量图切换">
          <button type="button" className={volumeMode === "weekly" ? "active" : ""} onClick={() => setVolumeMode("weekly")}>
            周跑量
          </button>
          <button type="button" className={volumeMode === "monthly" ? "active" : ""} onClick={() => setVolumeMode("monthly")}>
            月跑量
          </button>
        </div>
      </div>
      <ChartCanvas option={option} className="volume-chart" />
    </div>
  );
}

function WeightTrendChart({ weights }: { weights: WeightRecord[] }) {
  const option = useMemo<echarts.EChartsOption>(() => {
    const sortedWeights = [...weights].sort((a, b) => a.date.localeCompare(b.date));
    const weightDates = sortedWeights.map((weight) => weight.date);
    const weightValues = sortedWeights.map((weight) => weight.weightKg);
    const weightRange = valueAxis(weightValues, { min: 65, max: 105 }, 2, 12);

    return {
      color: ["#1864ab"],
      tooltip: chartTooltip({ trigger: "axis" }),
      legend: { top: 8, left: 12, data: ["体重"] },
      grid: { top: 64, left: 62, right: 52, bottom: 58, containLabel: true },
      dataZoom: xAxisZoom(weightDates.length, 10),
      xAxis: { type: "category", data: weightDates, boundaryGap: false },
      yAxis: {
        type: "value",
        name: "体重 kg",
        nameLocation: "middle",
        nameGap: 46,
        min: weightRange.min,
        max: weightRange.max
      },
      series: [{ name: "体重", type: "line", data: weightValues, smooth: true, symbolSize: 8, clip: true }]
    };
  }, [weights]);

  return (
    <div className="chart-block">
      <h3>体重趋势</h3>
      <ChartCanvas option={option} className="weight-trend-chart" />
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

function PredictionPanel({
  prediction,
  mode,
  backtest,
  baseline
}: {
  prediction: PredictionResult | null;
  mode: PredictionMode;
  backtest: PredictionBacktestResult;
  baseline: HeartRateBaseline;
}) {
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
  const smartFinishText = smart ? formatDuration(smart.predictedFinishSec) : vdotFinishText;
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
  const trainingRecommendations = [...new Set([...actionable, ...prediction.recommendations])].slice(0, 3);
  const confidenceLabel = smart
    ? smart.confidence === "high"
      ? "高可信"
      : smart.confidence === "medium"
        ? "中可信"
        : "低可信"
    : "数据不足";
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

      <div className="prediction-lower-grid">
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
              <h3>历史预测回测</h3><span>{backtest.status === "ready" ? `${backtest.sampleCount} 条样本` : "等待样本"}</span>
            </div>
            {backtest.status === "ready" ? (
              <>
                <div className="backtest-bars" aria-label={`原始 VDOT 误差 ${vdotError?.toFixed(1) ?? "-"}%，智能模型误差 ${smartError?.toFixed(1) ?? "-"}%`}>
                  <div><i style={{ height: `${Math.max(22, ((vdotError ?? 0) / errorScale) * 100)}%` }}>{vdotError?.toFixed(1)}%</i><span>原始 VDOT</span></div>
                  <div><i className="smart-bar" style={{ height: `${Math.max(22, ((smartError ?? 0) / errorScale) * 100)}%` }}>{smartError?.toFixed(1)}%</i><span>智能模型</span></div>
                  <p>智能误差改善 <strong>{signedPercent(improvement)}</strong></p>
                </div>
                <div className="backtest-latest-list" aria-label="最近三条历史回测">
                  {backtest.entries.slice(-3).reverse().map((entry) => (
                    <div key={entry.runId} className="backtest-latest-row">
                      <span>{entry.date} · {entry.benchmarkLabel}</span>
                      <div>
                        <span>智能预测 <strong>{formatDuration(entry.smartPredictedFinishSec)}</strong></span>
                        <span>实际 <strong>{formatDuration(entry.actualFinishSec)}</strong></span>
                      </div>
                      <small>{predictionErrorLabel(entry.smartErrorSec, entry.actualFinishSec)}</small>
                    </div>
                  ))}
                </div>
                <details className="backtest-history">
                  <summary><span>全部参与回测的数据</span><strong>{backtest.sampleCount} 条</strong></summary>
                  <p>按日期倒序展示；每次预测只使用该日期之前的跑步和回测样本。</p>
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
            ) : <p className="muted-text">系统会使用历史 PB 与比赛记录验证预测误差。</p>}
          </section>
        </div>

        <aside className="prediction-coach-rail">
          <div className="prediction-section-heading compact-heading"><div><h3>下一步训练</h3><span>根据当前预测生成的行动重点</span></div></div>
          <div className="coach-recommendations">
            {trainingRecommendations.map((item, index) => (
              <div key={item}><span>建议 {index + 1}</span><p>{item}</p></div>
            ))}
          </div>
          {prediction.warnings.length > 0 && (
            <div className="coach-warning-list">{prediction.warnings.map((item) => <p key={item}>{item}</p>)}</div>
          )}
          <div className="coach-heart-zones">
            <div className="prediction-section-heading compact-heading"><h3>心率分区</h3><span>{baseline.effectiveMaxHeartRateBpm ? `最大心率 ${baseline.effectiveMaxHeartRateBpm}` : "待补充出生日期"}</span></div>
            {baseline.zones.length > 0 ? (
              <div className="coach-zone-strip">
                {baseline.zones.map((zone) => <div key={zone.zone} className={`zone-${zone.zone}`}><span>Z{zone.zone}</span><strong>{zone.minBpm}-{zone.maxBpm}</strong></div>)}
              </div>
            ) : <p className="muted-text">填写出生日期后自动生成心率分区。</p>}
          </div>
        </aside>
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
  onSaved
}: {
  username: string;
  profile: RunnerProfile | null;
  onSaved: (profile: RunnerProfile) => void;
}) {
  const [draft, setDraft] = useState<RunnerProfileDraft>(() => runnerProfileDraft(profile));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
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
          {message && <p className="form-message profile-message">{message}</p>}
        </form>
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
          {model.personalBests.map((pb) => {
            const history = model.performanceHistory[pb.key];
            return (
                <details className="pb-history-group" key={pb.key} data-pb-distance={pb.key}>
                <summary className="pb-card">
                  <span>{pb.label}</span>
                  <strong>{formatDuration(pb.estimatedDurationSec)}</strong>
                  <small>
                    {formatPace(pb.paceSecPerKm)} /km · VDOT {pb.vdot.toFixed(1)}
                  </small>
                  <small>
                    {pb.sourceDate} · {history.length} 条历史成绩
                  </small>
                </summary>
                <div className="pb-history-list">
                  {history.map((entry) => {
                    const isCurrentPb = entry.runId === pb.sourceRunId && Math.abs(entry.durationSec - pb.estimatedDurationSec) < 0.5;
                    const statusText = entry.isPersonalBest
                      ? entry.improvementSec === null
                        ? "首个 PB"
                        : `比上次 PB 快 ${formatDuration(entry.improvementSec)}`
                      : "比赛成绩，未刷新 PB";
                    return (
                      <article className="pb-history-entry" key={entry.runId}>
                        <header>
                          <time dateTime={entry.date}>{entry.date}</time>
                          <div className="pb-history-badges">
                            {entry.isPersonalBest && <span>{isCurrentPb ? "当前 PB" : "PB"}</span>}
                            {entry.isRace && <span className="race-badge">比赛</span>}
                          </div>
                        </header>
                        <div className="pb-history-performance">
                          <strong>{formatDuration(entry.durationSec)}</strong>
                          <span>{formatPace(entry.paceSecPerKm)} /km · VDOT {entry.vdot.toFixed(1)}</span>
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
              </details>
            );
          })}
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
  onSaved: (run: RunningRecord) => void;
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
    setMessage(window.TextDetector ? "正在识别单段截图，请稍等。" : "正在使用兼容 OCR 识别单段，首次加载可能需要几十秒。");
    try {
      const text = await detectTextFromImages(files);
      const result = extractSplitsFromOcrText(text, totalDistanceKm);
      setRecognizedText(text || "未识别到文本。");
      if (result.splits.length === 0) {
        setMessage("未识别到可用单段数据，请检查截图是否包含段号、配速、心率、功率或步频。");
        return;
      }
      setDraft((current) => ({ ...current, splits: result.splits }));
      const droppedText =
        result.droppedIndexes.length > 0 ? `已忽略超出总距离的第 ${result.droppedIndexes.join("、")} 段。` : "";
      const incompleteText =
        result.incompleteIndexes.length > 0 ? `第 ${result.incompleteIndexes.join("、")} 段有字段未可靠识别，请重点校对。` : "各保留分段字段完整。";
      const completeSplitCount = result.splits.filter((split) => split.kind !== "tail").length;
      const tailText = result.tailDuration ? `已追加尾段 ${result.tailDuration}，仅保留时间。` : "未发现可确认的短尾段。";
      setMessage(`已识别 ${result.detectedCount} 段，保留 ${completeSplitCount} 段完整公里。${tailText}${droppedText}${incompleteText}`);
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
        <div className="form-section wide">
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
              <input value={draft.humidityPct} onChange={(event) => setField("humidityPct", event.target.value)} inputMode="numeric" />
            </label>
            <label>
              AQI
              <input value={draft.aqi} onChange={(event) => setField("aqi", event.target.value)} inputMode="numeric" />
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
                  value={split.pace}
                  onChange={(event) => setSplit(index, "pace", event.target.value)}
                  onBlur={(event) => setSplit(index, "pace", normalizeClockInput(event.target.value))}
                  inputMode="numeric"
                  placeholder="配速"
                />
                <input value={split.heartRateBpm} onChange={(event) => setSplit(index, "heartRateBpm", event.target.value)} inputMode="numeric" placeholder="心率" />
                <input value={split.powerW} onChange={(event) => setSplit(index, "powerW", event.target.value)} inputMode="numeric" placeholder="功率" />
                <input value={split.cadenceSpm} onChange={(event) => setSplit(index, "cadenceSpm", event.target.value)} inputMode="numeric" placeholder="步频" />
                <button type="button" className="ghost-button small-button danger-button split-delete-button" onClick={() => removeSplit(index)}>
                  删除
                </button>
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
    const [runData, shoeData, weightData, profileData] = await Promise.all([
      api.listRuns(),
      api.listShoes(),
      api.listWeights(),
      api.getRunnerProfile()
    ]);
    setRuns(sortRuns(runData.runs));
    setShoes(sortShoes(shoeData.shoes));
    setWeights(sortWeights(weightData.weights));
    setRunnerProfile(profileData.profile);
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
              className={activeView === "prediction" ? "active" : ""}
              onClick={() => setActiveView("prediction")}
              aria-current={activeView === "prediction" ? "page" : undefined}
            >
              预测建议
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
          <RunnerProfileMenu username={user.username} profile={runnerProfile} onSaved={setRunnerProfile} />
          <button className="ghost-button" onClick={onLogout}>退出</button>
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
            baseline={heartRateBaseline}
          />
        </section>
      )}

      {activeView === "records" && (
        <section className="records-page">
          <section className="workspace-grid">
            <RunForm shoes={shoes} editingRun={editingRun} onCancelEdit={() => setEditingRun(null)} onSaved={upsertRun} />
            <div className="side-column">
              <WeightForm editingWeight={editingWeight} onCancelEdit={() => setEditingWeight(null)} onSaved={upsertWeight} />
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
