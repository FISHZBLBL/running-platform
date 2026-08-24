export type SplitDraft = {
  kind?: "tail";
  duration?: string;
  distanceKm: string;
  pace: string;
  heartRateBpm: string;
  powerW: string;
  cadenceSpm: string;
};

export type SplitMetricField = "pace" | "heartRateBpm" | "powerW" | "cadenceSpm";

export type SplitOcrAmbiguity = {
  index: number;
  field: SplitMetricField;
  candidates: string[];
};

export type SplitOcrResult = {
  splits: SplitDraft[];
  detectedCount: number;
  fullSplitCount: number;
  droppedIndexes: number[];
  incompleteIndexes: number[];
  missingIndexes: number[];
  ambiguousFields: SplitOcrAmbiguity[];
  tailIndex?: number;
  tailDuration?: string;
};

export type RunOcrPatch = Partial<{
  dateTime: string;
  distanceKm: string;
  duration: string;
  avgPace: string;
  avgPowerW: string;
  avgCadenceSpm: string;
  avgHeartRateBpm: string;
  elevationGainM: string;
  effortScore: string;
}>;

const emptySplit: SplitDraft = {
  distanceKm: "1",
  pace: "",
  heartRateBpm: "",
  powerW: "",
  cadenceSpm: ""
};

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
  return text.slice(start, stop ?? start + 160);
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
    /(\d{1,2})\s*['′’‘＇´:：.]\s*(\d{2})\s*(?:['"″”]|''|’’|…|\d|\s){0,5}(?:[\/／]?\s*(?:km|KM|公里))/, 
    /(\d{1,2})\s+(\d{2})\s*(?:"|″|”|''|’’)?\s*(?:[\/／]\s*(?:km|KM|公里))/, 
    /(\d{1,2})\s*['′’‘＇´:：.]\s*(\d{2})\s*(?:['"″”]|''|’’)?/,
    /(?:^|\D)(\d{1,2})(\d{2})\s*(?:"|″|”|''|’’)(?=\s|\/|公里|km|KM|$)/
  ];
  for (const pattern of pacePatterns) {
    const match = section.match(pattern);
    if (!match) continue;
    const value = formatPaceCandidate(match[1], match[2]);
    if (value) return value;
  }

  const labeledSection = sectionAfterLabel(text, /(?:平均配速|配速)/, ["平均心率", "平均步频", "平均功率", "环境"]);
  if (labeledSection && labeledSection !== section) {
    const value = extractPaceValue(labeledSection, labeledSection);
    if (value) return value;
  }

  const unitMatch = text.match(/(\d{1,2})\s*['′’‘＇´:：]\s*(\d{2})\s*(?:['"″”]|''|’’|…|\d|\s){0,5}(?:[\/／]?\s*(?:km|KM|公里))/);
  return unitMatch ? formatPaceCandidate(unitMatch[1], unitMatch[2]) : null;
}

function extractCadenceValue(text: string, section: string): string | null {
  const unitMatch = text.match(/(\d{2,3})\s*(?:步\s*[\/／]\s*(?:分|分钟|分鐘)|步\s*(?:分|分钟|分鐘)|spm|SPM|%\s*[\/／]\s*[%9])/);
  if (unitMatch) {
    const value = Number(unitMatch[1]);
    if (value >= 120 && value <= 230) return String(value);
  }
  return metricInRange(section, 120, 230);
}

function extractEffortScore(text: string): string | null {
  const section = sectionAfterLabel(text, /(?:耗能(?:评分)?|努力程度)/, ["摘要", "Fitness+", "体能训练", "共享"]);
  if (!section) return null;

  // Apple Watch 的中文等级名称可以在数字被误识别时提供更可靠的校正依据。
  if (section.includes("竭尽全力")) return "9";
  if (section.includes("困难")) return "7";
  if (section.includes("适中")) return "6";

  const scoreMatch = section.match(/(?:^|\D)(10|[1-9])(?=\D|$)/);
  return scoreMatch?.[1] ?? null;
}

function normalizeSplitText(text: string): string {
  return text
    .split(/\r?\n/)
    .map(normalizeOcrLine)
    .filter(Boolean)
    .join("\n")
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

    const power = /瓦|W|w|FR|HR|R\b|K\b/.test(line) ? numberInLine(line, 50, 600) : null;
    if (power && pendingHeartRate && !pendingPower) {
      pendingPower = power;
      continue;
    }

    const cadence = /步|spm|SPM|%\s*\/\s*(?:9|%)/.test(line) ? numberInLine(line, 120, 230) : null;
    if (cadence && pendingHeartRate) {
      splits.push({
        ...emptySplit,
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
  const next = { ...current };
  if (patch.kind) next.kind = patch.kind;
  if (patch.duration) next.duration = patch.duration;
  if (patch.distanceKm) next.distanceKm = patch.distanceKm;
  if (patch.pace) next.pace = patch.pace;
  if (patch.heartRateBpm) next.heartRateBpm = patch.heartRateBpm;
  if (patch.powerW) next.powerW = patch.powerW;
  if (patch.cadenceSpm) next.cadenceSpm = patch.cadenceSpm;
  map.set(index, next);
}

function powerAfterHeartRate(chunk: string): string | null {
  const heartRate = chunk.match(/\d{2,3}\s*次\s*\/?\s*分/);
  if (!heartRate || heartRate.index === undefined) return null;
  const afterHeartRate = chunk.slice(heartRate.index + heartRate[0].length);
  const cadence = afterHeartRate.match(/\d{2,3}\s*(?:步|spm|SPM|%\s*\/)/);
  const powerSection = cadence?.index === undefined ? afterHeartRate : afterHeartRate.slice(0, cadence.index);
  return numberInLine(powerSection, 50, 600);
}

function cadenceFromSplitChunk(chunk: string): string | null {
  const match = chunk.match(/(\d{2,3})\s*(?:步\s*[\/／]\s*(?:分|分钟|分鐘)|步\s*(?:分|分钟|分鐘)|spm|SPM|%\s*[\/／]\s*[%9])/);
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 120 && value <= 230 ? String(value) : null;
}

type SplitCandidate = {
  count: number;
  firstSeen: number;
};

type SplitCandidateMap = Map<number, Map<SplitMetricField, Map<string, SplitCandidate>>>;

type SplitRowExtraction = {
  splits: Map<number, SplitDraft>;
  ambiguousFields: SplitOcrAmbiguity[];
};

// Apple Watch 的横向翻页箭头可能压在第 4、5 行左侧。OCR 常把它输出为 >、›、〉等前缀，
// 因此这里只容忍明确的箭头字符，不放宽为任意噪声，避免把状态栏数字误当成段号。
const splitRowPattern = /(?:^|\n)\s*(?:[>›❯»〉❭❱|｜]\s*){0,3}(\d{1,2})(?=\s+(?:\d{1,2}:\d{2}|\d{2,3}\s*次))/g;

function splitRowStarts(normalized: string): Array<{ index: number; start: number }> {
  return [...normalized.matchAll(new RegExp(splitRowPattern.source, splitRowPattern.flags))].map((match) => ({
    index: Number(match[1]),
    start: match.index ?? 0
  }));
}

function addSplitCandidate(
  candidates: SplitCandidateMap,
  index: number,
  field: SplitMetricField,
  value: string | null | undefined,
  order: number
) {
  if (!value) return;
  const fields = candidates.get(index) ?? new Map<SplitMetricField, Map<string, SplitCandidate>>();
  const values = fields.get(field) ?? new Map<string, SplitCandidate>();
  const current = values.get(value);
  values.set(value, current ? { ...current, count: current.count + 1 } : { count: 1, firstSeen: order });
  fields.set(field, values);
  candidates.set(index, fields);
}

function resolveSplitCandidates(candidates: SplitCandidateMap): SplitRowExtraction {
  const splits = new Map<number, SplitDraft>();
  const ambiguousFields: SplitOcrAmbiguity[] = [];

  for (const [index, fields] of candidates) {
    const split = { ...emptySplit };
    for (const [field, values] of fields) {
      const ranked = [...values.entries()].sort((left, right) => {
        const countDifference = right[1].count - left[1].count;
        return countDifference || left[1].firstSeen - right[1].firstSeen;
      });
      split[field] = ranked[0][0];
      if (ranked.length > 1) {
        ambiguousFields.push({
          index,
          field,
          candidates: ranked.map(([value]) => value)
        });
      }
    }
    splits.set(index, split);
  }

  return { splits, ambiguousFields };
}

function extractSplitRows(text: string): SplitRowExtraction {
  const normalized = normalizeSplitText(text);
  const rows = splitRowStarts(normalized);
  const candidates: SplitCandidateMap = new Map();
  let candidateOrder = 0;

  rows.forEach((row, rowPosition) => {
    const next = rows[rowPosition + 1]?.start ?? normalized.length;
    const chunk = normalized.slice(row.start, next);
    const timeMatch = chunk.match(/\b(\d{1,2}:\d{2})\b/);
    const paceValue = extractPaceValue(chunk, chunk);
    const heartRate = metricInRange(chunk.match(/\d{2,3}\s*次\s*\/?\s*分/)?.[0] ?? "", 60, 220);
    const power = powerAfterHeartRate(chunk);
    const cadence = cadenceFromSplitChunk(chunk);
    addSplitCandidate(candidates, row.index, "pace", paceValue ?? timeMatch?.[1], candidateOrder++);
    addSplitCandidate(candidates, row.index, "heartRateBpm", heartRate, candidateOrder++);
    addSplitCandidate(candidates, row.index, "powerW", power, candidateOrder++);
    addSplitCandidate(candidates, row.index, "cadenceSpm", cadence, candidateOrder++);
  });

  return resolveSplitCandidates(candidates);
}

function mergeSplitLists(primary: SplitDraft[], secondary: SplitDraft[]): Map<number, SplitDraft> {
  const splitMap = new Map<number, SplitDraft>();
  const count = Math.max(primary.length, secondary.length);
  for (let index = 0; index < count; index += 1) {
    const first = primary[index] ?? emptySplit;
    const second = secondary[index] ?? emptySplit;
    splitMap.set(index + 1, {
      distanceKm: first.distanceKm || second.distanceKm || "1",
      pace: first.pace || second.pace,
      heartRateBpm: first.heartRateBpm || second.heartRateBpm,
      powerW: first.powerW || second.powerW,
      cadenceSpm: first.cadenceSpm || second.cadenceSpm
    });
  }
  return splitMap;
}

function isPlausibleTailDuration(
  durationSec: number,
  pace: string | null,
  totalDistanceKm: number,
  fullSplitCount: number
): boolean {
  // 保留原有短尾段规则，避免改变已经支持的 00:06、00:55 等场景。
  if (durationSec < 60) return true;

  const fractionalDistanceKm = totalDistanceKm - fullSplitCount;
  if (fractionalDistanceKm < 0.01 || fractionalDistanceKm >= 1) return false;

  const impliedPaceSecPerKm = durationSec / fractionalDistanceKm;
  if (impliedPaceSecPerKm < 120 || impliedPaceSecPerKm > 900) return false;

  const paceSecPerKm = pace ? clockToSeconds(pace) : null;
  if (paceSecPerKm === null) return true;
  const expectedDurationSec = paceSecPerKm * fractionalDistanceKm;
  const toleranceSec = Math.max(8, expectedDurationSec * 0.12);
  return Math.abs(durationSec - expectedDurationSec) <= toleranceSec;
}

function extractTailSplit(
  text: string,
  fullSplitCount: number,
  totalDistanceKm: number
): { index: number; split: SplitDraft } | null {
  if (fullSplitCount < 1) return null;
  const normalized = normalizeSplitText(text);
  const rows = splitRowStarts(normalized);
  const expectedIndex = fullSplitCount + 1;
  const candidatePositions = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.index === expectedIndex);

  for (const { row, index } of candidatePositions) {
    const next = rows[index + 1]?.start ?? normalized.length;
    const chunk = normalized.slice(row.start, next);
    const time = chunk.match(/\b(\d{1,2}:\d{2})\b/)?.[1];
    if (!time) continue;
    const durationSec = clockToSeconds(time);
    const pace = extractPaceValue(chunk, chunk);
    if (
      durationSec === null ||
      durationSec <= 0 ||
      !isPlausibleTailDuration(durationSec, pace, totalDistanceKm, fullSplitCount)
    ) {
      continue;
    }

    return {
      index: expectedIndex,
      split: {
        kind: "tail",
        duration: normalizeDurationToken(time),
        distanceKm: "",
        pace: "",
        heartRateBpm: "",
        powerW: "",
        cadenceSpm: ""
      }
    };
  }

  return null;
}

export function extractSplitsFromText(text: string, totalDistanceKm: number): SplitOcrResult {
  const fullSplitCount = Math.max(0, Math.floor(totalDistanceKm));
  const rowExtraction = extractSplitRows(text);
  const rowMap = rowExtraction.splits;
  const lines = splitOcrLines(text);
  const fallbackMap = mergeSplitLists(parseTimePaceHeartSplits(lines), parseEffortSplits(lines));
  const splitMap = new Map<number, SplitDraft>(rowMap);
  for (const [index, fallback] of fallbackMap) {
    const current = splitMap.get(index);
    if (!current) {
      splitMap.set(index, fallback);
      continue;
    }
    upsertSplit(splitMap, index, {
      distanceKm: current.distanceKm || fallback.distanceKm,
      pace: current.pace || fallback.pace,
      heartRateBpm: current.heartRateBpm || fallback.heartRateBpm,
      powerW: current.powerW || fallback.powerW,
      cadenceSpm: current.cadenceSpm || fallback.cadenceSpm
    });
  }
  const detectedIndexes = [...splitMap.keys()].sort((a, b) => a - b);
  const tail = extractTailSplit(text, fullSplitCount, totalDistanceKm);
  const droppedIndexes = detectedIndexes.filter(
    (index) => fullSplitCount > 0 && index > fullSplitCount && index !== tail?.index
  );
  const expectedIndexes = fullSplitCount > 0
    ? Array.from({ length: fullSplitCount }, (_, index) => index + 1)
    : detectedIndexes;
  const retainedEntries = expectedIndexes
    .map((index) => [index, splitMap.get(index) ?? { ...emptySplit }] as const)
    .filter(([, split]) => fullSplitCount > 0 || split.pace || split.heartRateBpm || split.powerW || split.cadenceSpm);
  const missingIndexes = retainedEntries
    .filter(([index, split]) => !splitMap.has(index) || (!split.pace && !split.heartRateBpm && !split.powerW && !split.cadenceSpm))
    .map(([index]) => index);
  const incompleteIndexes = retainedEntries
    .filter(([, split]) => !split.pace || !split.heartRateBpm || !split.powerW || !split.cadenceSpm)
    .map(([index]) => index);
  const ambiguousFields = rowExtraction.ambiguousFields.filter(({ index }) => fullSplitCount === 0 || index <= fullSplitCount);

  return {
    splits: [...retainedEntries.map(([, split]) => split), ...(tail ? [tail.split] : [])],
    detectedCount: detectedIndexes.length,
    fullSplitCount,
    droppedIndexes,
    incompleteIndexes,
    missingIndexes,
    ambiguousFields,
    tailIndex: tail?.index,
    tailDuration: tail?.split.duration
  };
}

function localDateTimeFromText(text: string, referenceDate: Date): string | null {
  const normalizedTimeText = text
    .replace(/[：﹕︰]/g, ":")
    .replace(/[－–—~～]/g, "-")
    .replace(/\s*至\s*/g, "-");
  const dateMatch = normalizedTimeText.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const timeMatch = normalizedTimeText.match(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)\s*-\s*(?:[01]?\d|2[0-3]):[0-5]\d/);
  if (!dateMatch || !timeMatch) return null;

  const month = Number(dateMatch[1]);
  const day = Number(dateMatch[2]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  let year = referenceDate.getFullYear();
  let inferred = new Date(year, month - 1, day, hour, minute);
  if (inferred.getTime() > referenceDate.getTime() + 2 * 86_400_000) {
    year -= 1;
    inferred = new Date(year, month - 1, day, hour, minute);
  }
  if (
    inferred.getFullYear() !== year ||
    inferred.getMonth() !== month - 1 ||
    inferred.getDate() !== day ||
    inferred.getHours() !== hour ||
    inferred.getMinutes() !== minute
  ) {
    return null;
  }

  const pad = (value: number) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

export function extractRunDraftFromText(text: string, referenceDate = new Date()): RunOcrPatch {
  const normalized = text.replace(/\s+/g, " ");
  const hasOverviewMarkers = /体能训练时间|训练时间|总用时|动态[干千]卡|总[干千]卡数/.test(normalized);
  const labeledDistance =
    normalized.match(/(?:距离|距高).{0,50}?(\d+\.\d+)\b/) ??
    normalized.match(/(?:距离|距高).{0,50}?(\d+(?:\.\d+)?)\s*(?:km|KM|公里)/);
  const distanceMatch = labeledDistance ?? (hasOverviewMarkers ? normalized.match(/(\d+(?:\.\d+)?)\s*(?:km|KM|公里)/) : null);
  const durationMatch =
    normalized.match(/(?:体能训练时间|训练时间|总用时|用时).{0,80}?(\d{1,3}:\d{2}(?::\d{2})?)/) ??
    (hasOverviewMarkers ? normalized.match(/\b(\d{1,3}:\d{2}:\d{2})\b/) : null);
  const elevationMatch =
    normalized.match(/(?:总爬升高度|累计爬升).{0,50}?(\d{1,4})\s*(?:米|m\b)/i) ??
    (hasOverviewMarkers ? normalized.match(/平均功率.{0,12}?(\d{1,4})\s*(?:米|K)(?=\s+\d{2,4})/) : null);
  const paceSection = sectionAfterLabel(normalized, /(?:平均配速|配速)/, ["平均心率", "平均步频", "平均功率", "环境"]);
  const heartRateSection = sectionAfterLabel(normalized, /(?:平均心率|心率)/, ["平均步频", "平均功率", "平均配速", "环境"]);
  const cadenceSection = sectionAfterLabel(normalized, /(?:平均步频|步频)/, ["平均配速", "平均心率", "平均功率", "环境"]);
  const powerSection = sectionAfterLabel(normalized, /(?:平均功率|功率)/, ["平均配速", "平均步频", "平均心率", "环境"]);
  const paceValue = extractPaceValue(normalized, paceSection);
  const result: RunOcrPatch = {};
  const dateTime = localDateTimeFromText(normalized, referenceDate);
  if (dateTime) result.dateTime = dateTime;
  if (distanceMatch) result.distanceKm = distanceMatch[1];
  if (durationMatch) result.duration = normalizeDurationToken(durationMatch[1]);
  if (elevationMatch) result.elevationGainM = elevationMatch[1];
  if (paceValue) result.avgPace = paceValue;
  const heartRate = metricInRange(heartRateSection, 60, 220);
  const cadence = extractCadenceValue(normalized, cadenceSection);
  const power = metricInRange(powerSection, 50, 600);
  const effortScore = extractEffortScore(normalized);
  if (heartRate) result.avgHeartRateBpm = heartRate;
  if (cadence) result.avgCadenceSpm = cadence;
  if (power) result.avgPowerW = power;
  if (effortScore) result.effortScore = effortScore;
  return result;
}

function clockToSeconds(value: string): number | null {
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

export function getRunOcrWarnings(patch: RunOcrPatch): string[] {
  const required: Array<[keyof RunOcrPatch, string]> = [
    ["distanceKm", "距离"],
    ["duration", "总用时"],
    ["avgPace", "平均配速"],
    ["avgHeartRateBpm", "平均心率"],
    ["avgCadenceSpm", "平均步频"],
    ["avgPowerW", "平均功率"],
    ["effortScore", "耗能评分"]
  ];
  const missing = required.filter(([key]) => !patch[key]).map(([, label]) => label);
  const warnings = missing.length > 0 ? [`未可靠识别：${missing.join("、")}`] : [];

  const distance = Number(patch.distanceKm);
  const duration = patch.duration ? clockToSeconds(patch.duration) : null;
  const pace = patch.avgPace ? clockToSeconds(patch.avgPace) : null;
  if (Number.isFinite(distance) && distance > 0 && duration && pace) {
    const calculatedPace = duration / distance;
    if (Math.abs(calculatedPace - pace) / calculatedPace > 0.08) {
      warnings.push("平均配速与距离、总用时不一致");
    }
  }
  return warnings;
}
