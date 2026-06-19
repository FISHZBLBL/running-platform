import * as echarts from "echarts";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { PredictionResult, PublicUser, RunningRecord, RunSplit, WeightRecord } from "@shared/types";

type AuthMode = "login" | "register";
type PredictionMode = "distance-date" | "finish-date" | "date-finish";
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

type RunDraft = {
  id: string;
  dateTime: string;
  distanceKm: string;
  duration: string;
  avgPace: string;
  avgPowerW: string;
  avgCadenceSpm: string;
  avgHeartRateBpm: string;
  temperatureC: string;
  humidityPct: string;
  aqi: string;
  splits: SplitDraft[];
  screenshotKeys: string[];
};

type TextDetectionResult = {
  rawValue?: string;
};

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

function localDateTime(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function newRunDraft(): RunDraft {
  return {
    id: crypto.randomUUID(),
    dateTime: localDateTime(),
    distanceKm: "",
    duration: "",
    avgPace: "",
    avgPowerW: "",
    avgCadenceSpm: "",
    avgHeartRateBpm: "",
    temperatureC: "",
    humidityPct: "",
    aqi: "",
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
    distanceKm: String(run.distanceKm),
    duration: formatDuration(run.durationSec),
    avgPace: formatPace(run.avgPaceSecPerKm),
    avgPowerW: String(run.avgPowerW),
    avgCadenceSpm: String(run.avgCadenceSpm),
    avgHeartRateBpm: String(run.avgHeartRateBpm),
    temperatureC: run.weather.temperatureC === null ? "" : String(run.weather.temperatureC),
    humidityPct: run.weather.humidityPct === null ? "" : String(run.weather.humidityPct),
    aqi: run.weather.aqi === null ? "" : String(run.weather.aqi),
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

function extractRunDraftFromText(text: string): Partial<RunDraft> {
  const normalized = text.replace(/\s+/g, " ");
  const distanceMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:km|KM|公里)/);
  const durationMatch = normalized.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
  const paceMatch = normalized.match(/(\d{1,2})['′:](\d{2})(?:"|″)?\s*(?:\/?\s*(?:km|公里))?/);
  const heartRateMatch = normalized.match(/(?:心率|bpm|BPM)[^\d]*(\d{2,3})/);
  const cadenceMatch = normalized.match(/(?:步频|spm|SPM)[^\d]*(\d{2,3})/);
  const powerMatch = normalized.match(/(?:功率|W|w)[^\d]*(\d{2,4})/);
  const result: Partial<RunDraft> = {};
  if (distanceMatch) result.distanceKm = distanceMatch[1];
  if (durationMatch) result.duration = durationMatch[1];
  if (paceMatch) result.avgPace = `${paceMatch[1]}:${paceMatch[2]}`;
  if (heartRateMatch) result.avgHeartRateBpm = heartRateMatch[1];
  if (cadenceMatch) result.avgCadenceSpm = cadenceMatch[1];
  if (powerMatch) result.avgPowerW = powerMatch[1];
  return result;
}

async function detectTextFromImages(files: File[]): Promise<string> {
  if (!window.TextDetector) {
    throw new Error("当前浏览器不支持内置截图文字识别，请根据截图预览手动校对录入。");
  }
  const detector = new window.TextDetector();
  const texts: string[] = [];
  for (const file of files) {
    const bitmap = await createImageBitmap(file);
    const results = await detector.detect(bitmap);
    texts.push(...results.map((result) => result.rawValue ?? "").filter(Boolean));
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
    } else if (name.includes("配速") || name.includes("移动平均")) {
      formatted = `${formatPace(Number(value))} /km`;
    } else if (name.includes("心率")) {
      formatted = `${Number(value).toFixed(0)} bpm`;
    } else if (name.includes("距离") || name.includes("月跑量") || name.includes("最长单次")) {
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
    const paceRange = paceAxis(paces);
    const weightRange = valueAxis(weights.map((weight) => weight.weightKg), { min: 65, max: 105 }, 2, 12);
    const distanceRange = valueAxis(distances, { min: 0, max: 15 }, 2, 6);
    const heartRateRange = valueAxis(heartRates, { min: 120, max: 180 }, 5, 20);
    const monthlyDistanceRange = valueAxis(
      [...monthly.map((item) => item.distanceKm), ...monthly.map((item) => item.longestDistanceKm)],
      { min: 0, max: 80 },
      10,
      30
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

    chart.setOption({
      color: ["#1864ab", "#2b8a3e", "#c92a2a", "#f08c00", "#0f766e", "#7048e8"],
      tooltip: {
        trigger: "axis",
        formatter: chartTooltipFormatter
      },
      legend: [
        { top: 8, left: 16, data: ["实际配速", "3次移动平均", "单次距离", "平均心率"] },
        { top: 352, left: 16, data: ["体重-配速", "体重-心率"] },
        { top: 602, left: 16, data: ["月跑量", "最长单次距离"] }
      ],
      grid: [
        { top: 72, left: 64, right: 112, height: 250, containLabel: true },
        { top: 410, left: 64, right: 80, height: 160, containLabel: true },
        { top: 660, left: 64, right: 64, height: 160, containLabel: true }
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
        { type: "category", data: monthly.map((item) => item.month), gridIndex: 2, nameGap: 24 }
      ],
      yAxis: [
        {
          type: "value",
          name: "配速 /km",
          nameGap: 30,
          inverse: true,
          gridIndex: 0,
          min: paceRange.min,
          max: paceRange.max,
          axisLabel: { formatter: (value: number) => formatPace(value) }
        },
        {
          type: "value",
          name: "距离 km",
          nameGap: 30,
          gridIndex: 0,
          position: "right",
          min: distanceRange.min,
          max: distanceRange.max
        },
        {
          type: "value",
          name: "心率 bpm",
          nameGap: 32,
          gridIndex: 0,
          position: "right",
          offset: 52,
          min: heartRateRange.min,
          max: heartRateRange.max
        },
        {
          type: "value",
          name: "配速 /km",
          nameGap: 30,
          inverse: true,
          gridIndex: 1,
          min: paceRange.min,
          max: paceRange.max,
          axisLabel: { formatter: (value: number) => formatPace(value) }
        },
        {
          type: "value",
          name: "心率 bpm",
          nameGap: 34,
          gridIndex: 1,
          position: "right",
          min: heartRateRange.min,
          max: heartRateRange.max
        },
        {
          type: "value",
          name: "跑量 km",
          nameLocation: "middle",
          nameGap: 44,
          gridIndex: 2,
          min: monthlyDistanceRange.min,
          max: monthlyDistanceRange.max
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
          name: "月跑量",
          type: "bar",
          xAxisIndex: 2,
          yAxisIndex: 5,
          data: monthly.map((item) => Number(item.distanceKm.toFixed(1))),
          barMaxWidth: 28
        },
        {
          name: "最长单次距离",
          type: "line",
          xAxisIndex: 2,
          yAxisIndex: 5,
          data: monthly.map((item) => Number(item.longestDistanceKm.toFixed(1))),
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
  }, [runs, weights]);

  return <div className="chart" ref={ref} />;
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
            <span>按当前趋势完赛</span>
            <strong>{prediction.predictedTargetFinishSec ? formatDuration(prediction.predictedTargetFinishSec) : "-"}</strong>
          </div>
        )}
        <div className="prediction-metric">
          <span>历史最长距离</span>
          <strong>{prediction.longestDistanceKm.toFixed(1)} km</strong>
        </div>
        <div className="prediction-metric">
          <span>体重-配速相关</span>
          <strong>{prediction.weightPaceCorrelation?.toFixed(2) ?? "-"}</strong>
        </div>
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

function RunForm({ editingRun, onCancelEdit, onSaved }: { editingRun: RunningRecord | null; onCancelEdit: () => void; onSaved: () => void }) {
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
    setMessage("");
    if (files.length === 0) {
      setMessage("请先选择一张或多张截图。");
      return;
    }
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
          Apple Watch 截图
          <input type="file" accept="image/*" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
        </label>
        {filePreviews.length > 0 && (
          <div className="wide screenshot-review">
            <div className="screenshot-toolbar">
              <strong>截图待确认</strong>
              <button type="button" className="ghost-button" onClick={recognizeScreenshots}>
                识别并预填
              </button>
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
  weights,
  onEditRun,
  onEditWeight
}: {
  runs: RunningRecord[];
  weights: WeightRecord[];
  onEditRun: (run: RunningRecord) => void;
  onEditWeight: (weight: WeightRecord) => void;
}) {
  const months = groupHistoryByMonth(runs, weights);
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
                      {month.runs.map((run) => (
                        <div className="history-item" key={run.id}>
                          <div>
                            <strong>{run.dateTime.slice(0, 10)}</strong>
                            <span>
                              {run.distanceKm.toFixed(2)} km · {formatPace(run.avgPaceSecPerKm)} /km · {formatDuration(run.durationSec)}
                            </span>
                          </div>
                          <button type="button" className="ghost-button small-button" onClick={() => onEditRun(run)}>
                            编辑
                          </button>
                        </div>
                      ))}
                      {month.runs.length === 0 && <p className="muted-text">本月没有跑步记录。</p>}
                    </div>
                  </div>
                  <div>
                    <h3>体重</h3>
                    <div className="history-items">
                      {month.weights.map((weight) => (
                        <div className="history-item" key={weight.date}>
                          <div>
                            <strong>{weight.date}</strong>
                            <span>{weight.weightKg.toFixed(1)} kg</span>
                          </div>
                          <button type="button" className="ghost-button small-button" onClick={() => onEditWeight(weight)}>
                            编辑
                          </button>
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
  const [historyOpen, setHistoryOpen] = useState(false);

  function scrollToForms() {
    requestAnimationFrame(() => {
      document.querySelector(".workspace-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function refresh() {
    setLoading(true);
    const [runData, weightData, predictionData] = await Promise.all([
      api.listRuns(),
      api.listWeights(),
      api.prediction({
        targetDistanceKm: targetDistance,
        targetFinishSec: appliedPredictionMode === "finish-date" ? parseDuration(appliedTargetFinishInput) : null,
        targetDate: appliedPredictionMode === "date-finish" ? appliedTargetDateInput : null
      })
    ]);
    setRuns(runData.runs);
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Running Platform</p>
          <h1>跑步数据分析台</h1>
        </div>
        <div className="user-actions">
          <span>{user.username}</span>
          <button className="ghost-button" onClick={onLogout}>退出</button>
        </div>
      </header>

      <section className="hero-grid">
        <div className="chart-panel">
          <div className="panel-heading chart-heading">
            <div>
              <p className="eyebrow">Trend Model</p>
              <h2>跑步表现与体重趋势</h2>
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

      <section className="workspace-grid">
        <RunForm editingRun={editingRun} onCancelEdit={() => setEditingRun(null)} onSaved={refresh} />
        <div className="side-column">
          <WeightForm editingWeight={editingWeight} onCancelEdit={() => setEditingWeight(null)} onSaved={refresh} />
          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">History</p>
                <h2>历史记录</h2>
              </div>
              {loading && <span className="loading-dot">同步中</span>}
            </div>
            <div className="history-launch">
              <p className="muted-text">按月份管理跑步记录和体重记录，进入后可编辑历史数据。</p>
              <button type="button" className="primary-button" onClick={() => setHistoryOpen((open) => !open)}>
                {historyOpen ? "收起历史记录" : "打开历史记录"}
              </button>
            </div>
          </section>
        </div>
      </section>
      {historyOpen && (
        <HistoryManager
          runs={runs}
          weights={weights}
          onEditRun={(run) => {
            setEditingRun(run);
            scrollToForms();
          }}
          onEditWeight={(weight) => {
            setEditingWeight(weight);
            scrollToForms();
          }}
        />
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

  return user ? <Dashboard user={user} onLogout={logout} /> : <AuthDialog onAuthed={setUser} />;
}
