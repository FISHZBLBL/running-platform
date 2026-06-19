import * as echarts from "echarts";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { PredictionResult, PublicUser, RunningRecord, RunSplit, WeightRecord } from "@shared/types";

type AuthMode = "login" | "register";
type PredictionMode = "distance-date" | "finish-date" | "date-finish";

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
};

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
    splits: []
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

function trend(values: number[]): number[] {
  if (values.length < 2) return values;
  const n = values.length;
  const sumX = values.reduce((sum, _value, index) => sum + index, 0);
  const sumY = values.reduce((sum, value) => sum + value, 0);
  const sumXY = values.reduce((sum, value, index) => sum + index * value, 0);
  const sumXX = values.reduce((sum, _value, index) => sum + index * index, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return values;
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  return values.map((_value, index) => slope * index + intercept);
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

function ResearchChart({ runs, weights }: { runs: RunningRecord[]; weights: WeightRecord[] }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    const sorted = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
    const dates = sorted.map((run) => run.dateTime.slice(0, 10));
    const paces = sorted.map((run) => run.avgPaceSecPerKm);
    const distances = sorted.map((run) => run.distanceKm);
    const scatter = sorted
      .map((run) => {
        const weight = nearestWeight(run, weights);
        return weight ? [weight.weightKg, run.avgPaceSecPerKm, run.distanceKm] : null;
      })
      .filter(Boolean);

    chart.setOption({
      color: ["#1864ab", "#2b8a3e", "#c92a2a", "#7048e8", "#f08c00"],
      tooltip: {
        trigger: "axis",
        valueFormatter: (value: unknown) => (typeof value === "number" ? value.toFixed(2) : String(value))
      },
      legend: { top: 8, left: 16 },
      grid: [
        { top: 56, left: 58, right: 58, height: "48%" },
        { bottom: 46, left: 58, right: 58, height: "24%" }
      ],
      xAxis: [
        { type: "category", data: dates, boundaryGap: false, gridIndex: 0 },
        { type: "value", name: "体重 kg", gridIndex: 1, splitLine: { lineStyle: { type: "dashed" } } }
      ],
      yAxis: [
        {
          type: "value",
          name: "配速 /km",
          inverse: true,
          gridIndex: 0,
          axisLabel: { formatter: (value: number) => formatPace(value) }
        },
        { type: "value", name: "距离 km", gridIndex: 0 },
        {
          type: "value",
          name: "配速 /km",
          inverse: true,
          gridIndex: 1,
          axisLabel: { formatter: (value: number) => formatPace(value) }
        }
      ],
      series: [
        { name: "实际配速", type: "line", data: paces, smooth: true, symbolSize: 8 },
        { name: "配速拟合", type: "line", data: trend(paces), smooth: true, lineStyle: { type: "dashed", width: 2 }, symbol: "none" },
        { name: "实际距离", type: "bar", yAxisIndex: 1, data: distances, barMaxWidth: 20, opacity: 0.45 },
        { name: "距离拟合", type: "line", yAxisIndex: 1, data: trend(distances), lineStyle: { type: "dashed" }, symbol: "none" },
        {
          name: "体重-配速",
          type: "scatter",
          xAxisIndex: 1,
          yAxisIndex: 2,
          data: scatter,
          symbolSize: (value: number[]) => Math.max(8, Math.min(24, value[2] * 1.5))
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
      <div>
        <p className="eyebrow">{modeTitle}</p>
        <h2>{prediction.status === "ready" ? `${prediction.targetDistanceKm.toFixed(1)} km` : "数据不足"}</h2>
      </div>
      <div className="metric-grid">
        <div>
          <span>{primaryLabel}</span>
          <strong>{primaryValue}</strong>
        </div>
        <div>
          <span>按当前趋势完赛</span>
          <strong>{prediction.predictedTargetFinishSec ? formatDuration(prediction.predictedTargetFinishSec) : "-"}</strong>
        </div>
        <div>
          <span>历史最长距离</span>
          <strong>{prediction.longestDistanceKm.toFixed(1)} km</strong>
        </div>
        <div>
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

function RunForm({ onSaved }: { onSaved: () => void }) {
  const [draft, setDraft] = useState<RunDraft>(newRunDraft());
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

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
      await api.createRun({
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
        screenshotKeys: uploaded.keys,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      setDraft(newRunDraft());
      setFiles([]);
      setMessage("跑步记录已保存。");
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Run Entry</p>
          <h2>跑步记录</h2>
        </div>
        <button type="button" className="ghost-button" onClick={() => setField("splits", [...draft.splits, { ...emptySplit }])}>
          + 分段
        </button>
      </div>
      <form className="data-form" onSubmit={submit}>
        <label>
          日期时间
          <input type="datetime-local" value={draft.dateTime} onChange={(event) => setField("dateTime", event.target.value)} />
        </label>
        <label>
          距离 km
          <input value={draft.distanceKm} onChange={(event) => setField("distanceKm", event.target.value)} inputMode="decimal" />
        </label>
        <label>
          总用时
          <input value={draft.duration} onChange={(event) => setField("duration", event.target.value)} placeholder="45:30 或 1:35:20" />
        </label>
        <label>
          平均配速
          <input value={draft.avgPace} onChange={(event) => setField("avgPace", event.target.value)} placeholder="5:20" />
        </label>
        <label>
          平均功率 W
          <input value={draft.avgPowerW} onChange={(event) => setField("avgPowerW", event.target.value)} inputMode="decimal" />
        </label>
        <label>
          平均步频 spm
          <input value={draft.avgCadenceSpm} onChange={(event) => setField("avgCadenceSpm", event.target.value)} inputMode="decimal" />
        </label>
        <label>
          平均心率 bpm
          <input value={draft.avgHeartRateBpm} onChange={(event) => setField("avgHeartRateBpm", event.target.value)} inputMode="decimal" />
        </label>
        <label>
          气温 C
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
        <label className="wide">
          Apple Watch 截图
          <input type="file" accept="image/*" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
        </label>
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
          {busy ? "保存中..." : "保存跑步记录"}
        </button>
      </form>
    </section>
  );
}

function WeightForm({ onSaved }: { onSaved: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [weightKg, setWeightKg] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.saveWeight({ date, weightKg: parseNumber(weightKg) });
      setWeightKg("");
      setMessage("体重记录已保存。");
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败。");
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Weight Entry</p>
          <h2>体重记录</h2>
        </div>
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
        <button className="primary-button">保存体重</button>
        {message && <p className="form-message wide">{message}</p>}
      </form>
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
  const [targetFinishInput, setTargetFinishInput] = useState("2:00:00");
  const [targetDateInput, setTargetDateInput] = useState(() => {
    const date = new Date();
    date.setMonth(date.getMonth() + 6);
    return date.toISOString().slice(0, 10);
  });
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    const [runData, weightData, predictionData] = await Promise.all([
      api.listRuns(),
      api.listWeights(),
      api.prediction({
        targetDistanceKm: targetDistance,
        targetFinishSec: predictionMode === "finish-date" ? parseDuration(targetFinishInput) : null,
        targetDate: predictionMode === "date-finish" ? targetDateInput : null
      })
    ]);
    setRuns(runData.runs);
    setWeights(weightData.weights);
    setPrediction(predictionData.prediction);
    setLoading(false);
  }

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [targetDistance, predictionMode, targetFinishInput, targetDateInput]);

  const summary = useMemo(() => {
    const totalDistance = runs.reduce((sum, run) => sum + run.distanceKm, 0);
    const bestPace = runs.length ? Math.min(...runs.map((run) => run.avgPaceSecPerKm)) : null;
    const latestWeight = weights[0]?.weightKg ?? null;
    return { totalDistance, bestPace, latestWeight };
  }, [runs, weights]);

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
            <div className="target-controls">
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
                  onBlur={() => setTargetDistanceInput(String(targetDistance))}
                  onChange={(event) => {
                    const value = event.target.value;
                    setTargetDistanceInput(value);
                    if (isCompleteDecimalInput(value)) {
                      setTargetDistance(Number(value));
                    }
                  }}
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
            </div>
          </div>
          {runs.length ? <ResearchChart runs={runs} weights={weights} /> : <div className="empty-chart">保存跑步记录后显示趋势图。</div>}
        </div>
        <PredictionPanel prediction={prediction} mode={predictionMode} />
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
        <RunForm onSaved={refresh} />
        <div className="side-column">
          <WeightForm onSaved={refresh} />
          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Recent</p>
                <h2>最近记录</h2>
              </div>
              {loading && <span className="loading-dot">同步中</span>}
            </div>
            <div className="record-list">
              {runs.slice(0, 6).map((run) => (
                <div className="record-item" key={run.id}>
                  <div>
                    <strong>{run.dateTime.slice(0, 10)}</strong>
                    <span>{run.distanceKm.toFixed(2)} km · {formatPace(run.avgPaceSecPerKm)} /km</span>
                  </div>
                  <small>{run.screenshotKeys.length} 张截图</small>
                </div>
              ))}
              {!runs.length && <p className="muted-text">还没有跑步记录。</p>}
            </div>
          </section>
        </div>
      </section>
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
