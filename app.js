const STORAGE_KEY = "run-platform-v1";
const SESSION_KEY = "run-platform-session-v1";

const state = loadState();
const syncClient = window.RunCosSync ? new window.RunCosSync() : null;
let syncTimer = null;

const el = (id) => document.getElementById(id);
const today = () => new Date().toISOString().slice(0, 10);

const fields = {
  date: el("date"),
  distance: el("distance"),
  duration: el("duration"),
  pace: el("pace"),
  heartRate: el("heartRate"),
  power: el("power"),
  cadence: el("cadence"),
  temp: el("temp"),
  humidity: el("humidity"),
  aqi: el("aqi"),
  splits: el("splits")
};

fields.date.value = today();
el("weightDate").value = today();
hydrateCloudForm();
showAuthModal();

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`[data-panel-id="${tab.dataset.panel}"]`).classList.add("active");
  });
});

el("runForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const distance = Number(fields.distance.value);
  const durationSec = parseTime(fields.duration.value);
  const paceSec = fields.pace.value ? parsePace(fields.pace.value) : durationSec / distance;
  const entry = {
    id: crypto.randomUUID(),
    date: fields.date.value,
    distance,
    durationSec,
    paceSec,
    heartRate: numberOrNull(fields.heartRate.value),
    power: numberOrNull(fields.power.value),
    cadence: numberOrNull(fields.cadence.value),
    temp: numberOrNull(fields.temp.value),
    humidity: numberOrNull(fields.humidity.value),
    aqi: numberOrNull(fields.aqi.value),
    splits: parseSplits(fields.splits.value),
    updatedAt: Date.now()
  };
  state.runs.push(entry);
  saveState();
  queueSync();
  el("runForm").reset();
  fields.date.value = today();
  render();
});

el("saveGoalBtn").addEventListener("click", () => {
  state.goalDistance = Number(el("goalDistance").value || 21.0975);
  state.settingsUpdatedAt = Date.now();
  saveState();
  queueSync();
  render();
});

el("addWeightBtn").addEventListener("click", () => {
  const weight = numberOrNull(el("weight").value);
  if (!weight) return;
  state.weights.push({ id: crypto.randomUUID(), date: el("weightDate").value || today(), weight, updatedAt: Date.now() });
  el("weight").value = "";
  saveState();
  queueSync();
  render();
});

el("clearBtn").addEventListener("click", () => {
  if (!confirm("确认清空全部跑步、目标和体重数据？")) return;
  state.deletedRunIds = unique([...(state.deletedRunIds || []), ...state.runs.map((run) => run.id)]);
  state.deletedWeightIds = unique([...(state.deletedWeightIds || []), ...state.weights.map((weight) => weight.id)]);
  state.runs = [];
  state.weights = [];
  state.goalDistance = 21.0975;
  state.settingsUpdatedAt = Date.now();
  saveState();
  queueSync();
  render();
});

el("sampleBtn").addEventListener("click", () => {
  state.runs = sampleRuns();
  state.weights = [
    { id: crypto.randomUUID(), date: "2026-05-15", weight: 72.6 },
    { id: crypto.randomUUID(), date: "2026-06-16", weight: 71.4 }
  ];
  state.goalDistance = 21.0975;
  state.settingsUpdatedAt = Date.now();
  saveState();
  queueSync();
  render();
});

el("chartMode").addEventListener("change", renderChart);

el("imageUpload").addEventListener("change", (event) => {
  const list = el("imageList");
  [...event.target.files].forEach((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const card = document.createElement("div");
      card.className = "image-card";
      card.innerHTML = `<img src="${reader.result}" alt="${escapeHtml(file.name)}"><div><strong>${escapeHtml(file.name)}</strong><span>仅在当前页面临时预览，不会写入本地缓存或云端。识别/核对后请录入结构化字段。</span></div>`;
      list.prepend(card);
    };
    reader.readAsDataURL(file);
  });
});

el("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `running-data-${today()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

el("importFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const imported = JSON.parse(await file.text());
  state.runs = Array.isArray(imported.runs) ? imported.runs : [];
  state.weights = Array.isArray(imported.weights) ? imported.weights : [];
  state.deletedRunIds = Array.isArray(imported.deletedRunIds) ? imported.deletedRunIds : [];
  state.deletedWeightIds = Array.isArray(imported.deletedWeightIds) ? imported.deletedWeightIds : [];
  state.goalDistance = Number(imported.goalDistance || 21.0975);
  saveState();
  queueSync();
  render();
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete]");
  if (!button) return;
  state.deletedRunIds = unique([...(state.deletedRunIds || []), button.dataset.delete]);
  state.runs = state.runs.filter((run) => run.id !== button.dataset.delete);
  saveState();
  queueSync();
  render();
});

el("loginBtn").addEventListener("click", async () => {
  await runAuthAction(async () => {
    const remote = await syncClient.login(readAuthForm());
    replaceState(remote);
    saveState();
    saveSession();
    hideAuthModal();
    render();
    setSyncUi("已同步", "登录成功，已加载这个账号的云端数据。");
  });
});

el("registerBtn").addEventListener("click", async () => {
  await runAuthAction(async () => {
    await syncClient.register(readAuthForm());
    await syncClient.push(state);
    state.lastSyncedAt = Date.now();
    saveState();
    saveSession();
    hideAuthModal();
    render();
    setSyncUi("已同步", "注册成功，已在 COS 中创建你的账号目录并上传当前数据。");
  });
});

el("manualSyncBtn").addEventListener("click", async () => {
  await syncNow();
});

el("switchAccountBtn").addEventListener("click", () => {
  showAuthModal();
});

el("logoutBtn").addEventListener("click", async () => {
  await runSyncAction(async () => {
    syncClient.lock();
    sessionStorage.removeItem(SESSION_KEY);
    showAuthModal();
    setSyncUi("已退出", "已退出账号。当前页面数据仍保留在本地缓存。");
  });
});

function loadState() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return normalizeState(null);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function normalizeState(input) {
  return {
    runs: Array.isArray(input?.runs) ? input.runs : [],
    weights: Array.isArray(input?.weights) ? input.weights : [],
    deletedRunIds: Array.isArray(input?.deletedRunIds) ? input.deletedRunIds : [],
    deletedWeightIds: Array.isArray(input?.deletedWeightIds) ? input.deletedWeightIds : [],
    goalDistance: Number(input?.goalDistance || 21.0975),
    settingsUpdatedAt: input?.settingsUpdatedAt || 0,
    lastSyncedAt: input?.lastSyncedAt || 0
  };
}

function render() {
  state.runs.sort((a, b) => new Date(a.date) - new Date(b.date));
  el("goalDistance").value = state.goalDistance || 21.0975;
  renderMetrics();
  renderChart();
  renderText();
  renderRecords();
}

function renderMetrics() {
  const runs = state.runs;
  const model = buildModel();
  el("runCount").textContent = runs.length;
  el("longestRun").textContent = runs.length ? `${max(runs.map((run) => run.distance)).toFixed(1)} km` : "--";
  el("predictedTime").textContent = model.predictedTargetTime ? formatDuration(model.predictedTargetTime) : "--";
  el("halfReady").textContent = model.readyWeeks === null ? "--" : model.readyWeeks <= 1 ? "现在可尝试" : `${model.readyWeeks} 周`;
}

function renderText() {
  const model = buildModel();
  const prediction = el("predictionText");
  const training = el("trainingText");
  if (state.runs.length < 3) {
    prediction.innerHTML = `<div class="callout">至少录入 3 次跑步后，预测会更稳定。1km/2km/3km 全力跑和日常轻松跑交替录入，会让短距离爆发与耐力趋势更清楚。</div>`;
    training.innerHTML = `<ul><li>先建立数据基线：连续记录 2-3 周。</li><li>每周保留一次轻松长跑、一次短距离快跑、一次恢复跑。</li><li>不要让单周总距离比上一周增加超过约 10%。</li></ul>`;
    return;
  }

  prediction.innerHTML = `
    <div class="callout">按当前趋势，${model.goalDistance.toFixed(1)} km 预测用时为 <strong>${formatDuration(model.predictedTargetTime)}</strong>，折算配速约 <strong>${formatPace(model.predictedTargetTime / model.goalDistance)}</strong>。</div>
    <ul>
      <li>当前最长距离 ${model.longest.toFixed(1)} km，半马完整跑完预计还需 ${model.readyWeeks <= 1 ? "0-1" : model.readyWeeks} 周。</li>
      <li>近几次配速趋势：${model.paceTrendText}。</li>
      <li>训练承受能力：${model.capacityText}。</li>
      <li>短距离爆发：${model.speedText}。</li>
      <li>体重趋势：${model.weightText}。</li>
    </ul>`;

  training.innerHTML = `
    <ul>
      <li>长距离：每周 1 次，把最长跑从 ${model.longest.toFixed(1)} km 逐步推到 ${Math.min(model.goalDistance, model.longest * 1.12).toFixed(1)} km，单次增加控制在 8%-12%。</li>
      <li>短距离：每 7-10 天一次 1km/2km/3km 较高强度跑，用来校准爆发力和速度上限。</li>
      <li>节奏跑：每周 1 次，用目标配速慢 10-25 秒/km 的强度跑 15-30 分钟。</li>
      <li>恢复跑：心率明显偏高或配速效率下降时，把下一次训练改成轻松跑或休息。</li>
    </ul>`;
}

function renderRecords() {
  const body = el("recordsBody");
  body.innerHTML = "";
  if (!state.runs.length) {
    body.innerHTML = `<tr><td colspan="8">${document.getElementById("emptyState").innerHTML}</td></tr>`;
    return;
  }
  state.runs.slice().reverse().forEach((run) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${run.date}</td>
      <td>${run.distance.toFixed(2)} km</td>
      <td>${formatDuration(run.durationSec)}</td>
      <td>${formatPace(run.paceSec)}</td>
      <td>${run.heartRate || "--"}</td>
      <td>${run.power || "--"}</td>
      <td>${run.cadence || "--"}</td>
      <td><button class="delete-button" data-delete="${run.id}" title="删除" aria-label="删除">×</button></td>`;
    body.appendChild(tr);
  });
}

function renderChart() {
  const target = el("chart");
  if (!state.runs.length) {
    target.innerHTML = document.getElementById("emptyState").innerHTML;
    return;
  }
  const mode = el("chartMode").value;
  const runs = state.runs;
  const width = 980;
  const height = 390;
  const pad = { left: 58, right: 28, top: 28, bottom: 48 };
  const xVals = runs.map((run) => new Date(run.date).getTime());
  const xMin = min(xVals);
  const xMax = max(xVals);
  const series = chartSeries(mode, runs);
  const allY = series.flatMap((item) => item.values.map((point) => point.y)).filter(Number.isFinite);
  if (!allY.length) {
    target.innerHTML = `<div class="empty-state"><strong>这个指标还没有足够数据</strong><span>继续录入功率、心率或对应字段后，图表会自动生成。</span></div>`;
    return;
  }
  const yMin = min(allY);
  const yMax = max(allY);
  const x = (value) => pad.left + ((value - xMin) / Math.max(1, xMax - xMin)) * (width - pad.left - pad.right);
  const y = (value) => height - pad.bottom - ((value - yMin) / Math.max(1, yMax - yMin)) * (height - pad.top - pad.bottom);
  const yTicks = ticks(yMin, yMax, 5);
  const paths = series.map((item) => {
    const d = item.values.map((point, index) => `${index ? "L" : "M"} ${x(point.x).toFixed(1)} ${y(point.y).toFixed(1)}`).join(" ");
    const dots = item.values.map((point) => `<circle cx="${x(point.x).toFixed(1)}" cy="${y(point.y).toFixed(1)}" r="4" fill="${item.color}"><title>${point.label}</title></circle>`).join("");
    return `<path d="${d}" fill="none" stroke="${item.color}" stroke-width="2.5"/>${dots}`;
  }).join("");
  const trend = linearTrend(series[0].values.map((point, index) => ({ x: index, y: point.y })));
  const trendPath = series[0].values.length > 1
    ? `<path d="M ${x(series[0].values[0].x)} ${y(trend.predict(0))} L ${x(series[0].values.at(-1).x)} ${y(trend.predict(series[0].values.length - 1))}" stroke="#222" stroke-dasharray="6 5" stroke-width="1.8" fill="none"/>`
    : "";
  target.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="跑步趋势图">
      ${yTicks.map((tick) => `<line class="grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick)}" y2="${y(tick)}"/><text class="note" x="12" y="${y(tick) + 4}">${formatAxis(tick, mode)}</text>`).join("")}
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}" stroke="#9aaca4"/>
      <line x1="${pad.left}" x2="${pad.left}" y1="${pad.top}" y2="${height - pad.bottom}" stroke="#9aaca4"/>
      ${paths}
      ${trendPath}
      ${runs.map((run) => `<text class="note" x="${x(new Date(run.date).getTime()) - 25}" y="${height - 18}">${run.date.slice(5)}</text>`).join("")}
      ${series.map((item, index) => `<circle cx="${width - 190 + index * 92}" cy="20" r="5" fill="${item.color}"/><text class="legend" x="${width - 180 + index * 92}" y="24">${item.name}</text>`).join("")}
    </svg>`;
}

function chartSeries(mode, runs) {
  const toPoint = (run, y, label) => ({ x: new Date(run.date).getTime(), y, label });
  if (mode === "heart") {
    return [
      { name: "心率", color: "#b44459", values: runs.filter((r) => r.heartRate).map((r) => toPoint(r, r.heartRate, `${r.date} 心率 ${r.heartRate}`)) },
      { name: "配速", color: "#215c9b", values: runs.map((r) => toPoint(r, r.paceSec / 60, `${r.date} 配速 ${formatPace(r.paceSec)}`)) }
    ];
  }
  if (mode === "power") {
    return [
      { name: "功率", color: "#9a6a12", values: runs.filter((r) => r.power).map((r) => toPoint(r, r.power, `${r.date} 功率 ${r.power}`)) },
      { name: "效率", color: "#0b7a53", values: runs.filter((r) => r.power).map((r) => toPoint(r, 1000 / r.paceSec / r.power * 10000, `${r.date} 效率`)) }
    ];
  }
  if (mode === "load") {
    return [
      { name: "负荷", color: "#0b7a53", values: runs.map((r) => toPoint(r, trainingLoad(r), `${r.date} 负荷 ${trainingLoad(r).toFixed(0)}`)) }
    ];
  }
  return [
    { name: "配速", color: "#215c9b", values: runs.map((r) => toPoint(r, r.paceSec / 60, `${r.date} 配速 ${formatPace(r.paceSec)}`)) },
    { name: "距离", color: "#0b7a53", values: runs.map((r) => toPoint(r, r.distance, `${r.date} 距离 ${r.distance}`)) }
  ];
}

function buildModel() {
  const runs = state.runs;
  const goalDistance = Number(state.goalDistance || 21.0975);
  if (!runs.length) return { goalDistance, readyWeeks: null, predictedTargetTime: null };
  const longest = max(runs.map((run) => run.distance));
  const bestEquivalent = min(runs.map((run) => run.durationSec * Math.pow(goalDistance / run.distance, 1.06)));
  const predictedTargetTime = bestEquivalent;
  const paceTrend = linearTrend(runs.map((run, index) => ({ x: index, y: run.paceSec })));
  const paceDelta = runs.length > 1 ? paceTrend.slope * 4 : 0;
  const paceTrendText = Math.abs(paceDelta) < 5 ? "基本稳定" : paceDelta < 0 ? `每 4 次记录约提升 ${Math.abs(paceDelta).toFixed(0)} 秒/km` : `近期变慢约 ${paceDelta.toFixed(0)} 秒/km，可能需要恢复或降低强度`;
  const weeklyDistance = recentWeeklyDistance(runs);
  const targetLongRun = goalDistance * 0.9;
  const readyWeeks = longest >= targetLongRun ? 1 : Math.ceil(Math.log(targetLongRun / Math.max(longest, 1)) / Math.log(1.09));
  const avgLoad = average(runs.slice(-5).map(trainingLoad));
  const lastLoad = trainingLoad(runs.at(-1));
  const hrRuns = runs.filter((run) => run.heartRate);
  const avgHr = average(hrRuns.slice(-5).map((run) => run.heartRate));
  const weightText = describeWeightTrend();
  const capacityText = lastLoad > avgLoad * 1.35
    ? "最近一次负荷偏高，下一次建议轻松跑或休息"
    : avgHr && avgHr > 168
      ? "心率压力偏高，提升距离时要控制配速"
      : weeklyDistance > 18
        ? "有一定连续训练基础，可以小幅增加长跑距离"
        : "基础负荷还在建立阶段，适合稳步累积";
  const shortRuns = runs.filter((run) => run.distance <= 3.2);
  const longRuns = runs.filter((run) => run.distance >= 5);
  const speedText = shortRuns.length && longRuns.length
    ? compareSpeed(shortRuns, longRuns)
    : "短距离和中长距离样本还不够，建议补充 1km/2km/3km 测试";
  return { goalDistance, longest, predictedTargetTime, readyWeeks, paceTrendText, capacityText, speedText, weightText };
}

function describeWeightTrend() {
  if (state.weights.length < 2) return "体重记录不足，暂不纳入趋势判断";
  const weights = state.weights.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const first = weights[0].weight;
  const last = weights.at(-1).weight;
  const delta = last - first;
  if (Math.abs(delta) < 0.4) return `体重基本稳定，当前约 ${last.toFixed(1)} kg`;
  return delta < 0
    ? `体重下降 ${Math.abs(delta).toFixed(1)} kg，可能改善功率体重比`
    : `体重上升 ${delta.toFixed(1)} kg，长距离配速预测会更依赖心率稳定性`;
}

function compareSpeed(shortRuns, longRuns) {
  const bestShort = min(shortRuns.map((run) => run.paceSec));
  const bestLong = min(longRuns.map((run) => run.paceSec));
  const gap = bestLong - bestShort;
  if (gap > 55) return "速度上限不错，耐力转化不足，长距离和节奏跑更重要";
  if (gap < 25) return "耐力保持较好，但短距离速度储备可以加强";
  return "速度与耐力较均衡，可以交替安排短距离快跑和长距离";
}

function trainingLoad(run) {
  const hrFactor = run.heartRate ? run.heartRate / 150 : 1;
  const heatFactor = run.temp && run.temp > 26 ? 1 + (run.temp - 26) * 0.015 : 1;
  const airFactor = run.aqi && run.aqi > 100 ? 1.08 : 1;
  return run.distance * run.durationSec / 60 * hrFactor * heatFactor * airFactor;
}

function recentWeeklyDistance(runs) {
  const latest = new Date(runs.at(-1).date).getTime();
  return runs
    .filter((run) => latest - new Date(run.date).getTime() <= 1000 * 60 * 60 * 24 * 7)
    .reduce((sum, run) => sum + run.distance, 0);
}

function parseSplits(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [distance, pace, heartRate, power, cadence] = line.split(",").map((part) => part.trim());
    return {
      distance: Number(distance),
      paceSec: parsePace(pace),
      heartRate: numberOrNull(heartRate),
      power: numberOrNull(power),
      cadence: numberOrNull(cadence)
    };
  });
}

function parseTime(value) {
  const parts = value.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(value) * 60;
}

function parsePace(value) {
  const parts = value.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(value) * 60;
}

function formatDuration(seconds) {
  const sec = Math.round(seconds);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function formatPace(seconds) {
  const sec = Math.round(seconds);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}/km`;
}

function numberOrNull(value) {
  return value === "" || value === null || Number.isNaN(Number(value)) ? null : Number(value);
}

function linearTrend(points) {
  const n = points.length;
  const sx = points.reduce((sum, point) => sum + point.x, 0);
  const sy = points.reduce((sum, point) => sum + point.y, 0);
  const sxy = points.reduce((sum, point) => sum + point.x * point.y, 0);
  const sx2 = points.reduce((sum, point) => sum + point.x * point.x, 0);
  const denom = n * sx2 - sx * sx || 1;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept, predict: (x) => intercept + slope * x };
}

function ticks(a, b, count) {
  if (a === b) return [a - 1, a, a + 1];
  const step = (b - a) / (count - 1);
  return Array.from({ length: count }, (_, index) => a + step * index);
}

function formatAxis(value, mode) {
  if (mode === "pace" || mode === "heart") return value < 20 ? `${value.toFixed(1)}` : value.toFixed(0);
  return value.toFixed(0);
}

function max(values) {
  return Math.max(...values.filter(Number.isFinite));
}

function min(values) {
  return Math.min(...values.filter(Number.isFinite));
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function hydrateCloudForm() {
  if (!syncClient) return;
  el("authUsername").value = syncClient.config.username || "";
  el("authCredentialUrl").value = syncClient.config.credentialUrl || "";
  refreshAccountUi();
  setSyncUi("未登录", "登录后会同步到腾讯云 COS。");
}

function readAuthForm() {
  return {
    username: el("authUsername").value,
    password: el("authPassword").value,
    credentialUrl: el("authCredentialUrl").value.trim()
  };
}

function setSyncUi(status, message) {
  el("syncState").textContent = status;
  el("syncMessage").textContent = message;
}

async function runSyncAction(action) {
  if (!syncClient) {
    setSyncUi("不可用", "云同步模块未加载，本地缓存仍可正常使用。");
    return;
  }
  try {
    setSyncUi("同步中", "正在连接 COS 并合并加密数据...");
    await action();
  } catch (error) {
    setSyncUi("待同步", error.message || "云同步失败，数据已保存在本地，稍后可重试。");
  }
}

async function runAuthAction(action) {
  if (!syncClient) {
    el("authMessage").textContent = "云同步模块未加载。";
    return;
  }
  try {
    el("authMessage").textContent = "正在连接腾讯云 COS...";
    await action();
  } catch (error) {
    el("authMessage").textContent = error.message || "登录失败，请检查用户名、密码或临时密钥接口。";
  }
}

function queueSync() {
  if (!syncClient?.unlocked) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 800);
}

async function syncNow() {
  await runSyncAction(async () => {
    const pulled = await syncClient.sync(state);
    if (pulled) mergeCloudState(pulled);
    await syncClient.push(state);
    state.lastSyncedAt = Date.now();
    saveState();
    render();
    setSyncUi("已同步", `最近同步：${new Date(state.lastSyncedAt).toLocaleString()}`);
  });
}

function mergeCloudState(remote) {
  const deletedRunIds = unique([...(state.deletedRunIds || []), ...(remote.deletedRunIds || []), ...(remote.cloudMeta?.deletedRunIds || [])]);
  const deletedWeightIds = unique([...(state.deletedWeightIds || []), ...(remote.deletedWeightIds || []), ...(remote.cloudMeta?.deletedWeightIds || [])]);
  state.runs = mergeById(state.runs, remote.runs || []).filter((run) => !deletedRunIds.includes(run.id));
  state.weights = mergeById(state.weights, remote.weights || []).filter((weight) => !deletedWeightIds.includes(weight.id));
  state.deletedRunIds = deletedRunIds;
  state.deletedWeightIds = deletedWeightIds;
  if (Number.isFinite(remote.goalDistance) && (remote.settingsUpdatedAt || 0) >= (state.settingsUpdatedAt || 0)) {
    state.goalDistance = remote.goalDistance;
    state.settingsUpdatedAt = remote.settingsUpdatedAt || state.settingsUpdatedAt;
  }
}

function replaceState(nextState) {
  const normalized = normalizeState(nextState);
  state.runs = normalized.runs;
  state.weights = normalized.weights;
  state.deletedRunIds = normalized.deletedRunIds;
  state.deletedWeightIds = normalized.deletedWeightIds;
  state.goalDistance = normalized.goalDistance;
  state.settingsUpdatedAt = normalized.settingsUpdatedAt;
  state.lastSyncedAt = normalized.lastSyncedAt;
}

function showAuthModal() {
  el("authOverlay").classList.add("active");
  refreshAccountUi();
}

function hideAuthModal() {
  el("authOverlay").classList.remove("active");
  refreshAccountUi();
}

function refreshAccountUi() {
  const username = syncClient?.username || syncClient?.config?.username || "";
  const key = syncClient?.config?.key || (username ? `users/${username}/encrypted-data.json` : "--");
  el("currentUser").textContent = username || "未登录";
  el("currentKey").textContent = key;
}

function saveSession() {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ username: syncClient.username, key: syncClient.config.key }));
  refreshAccountUi();
}

function mergeById(localItems, remoteItems) {
  const byId = new Map();
  [...localItems, ...remoteItems].forEach((item) => {
    if (!item?.id) return;
    const existing = byId.get(item.id);
    if (!existing || (item.updatedAt || 0) >= (existing.updatedAt || 0)) {
      byId.set(item.id, item);
    }
  });
  return [...byId.values()];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sampleRuns() {
  const rows = [
    ["2026-05-18", 2.0, "11:30", 162, 240, 178, 22, 58, 48],
    ["2026-05-22", 3.0, "18:20", 154, 218, 171, 23, 64, 52],
    ["2026-05-27", 5.0, "33:10", 157, 210, 169, 24, 63, 60],
    ["2026-06-02", 1.0, "05:08", 171, 265, 184, 25, 70, 72],
    ["2026-06-06", 6.2, "40:15", 156, 214, 170, 26, 66, 55],
    ["2026-06-11", 3.0, "17:20", 165, 238, 178, 24, 61, 44],
    ["2026-06-15", 8.0, "52:10", 158, 216, 171, 25, 68, 50]
  ];
  return rows.map(([date, distance, duration, heartRate, power, cadence, temp, humidity, aqi]) => ({
    id: crypto.randomUUID(),
    date,
    distance,
    durationSec: parseTime(duration),
    paceSec: parseTime(duration) / distance,
    heartRate,
    power,
    cadence,
    temp,
    humidity,
    aqi,
    splits: [],
    updatedAt: Date.now()
  }));
}

render();
