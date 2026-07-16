import { describe, expect, it } from "vitest";
import { extractRunDraftFromText, extractSplitsFromText, getRunOcrWarnings } from "../src/ocr";

const referenceDate = new Date(2026, 6, 15, 16, 30);

describe("Apple Watch overview OCR parsing", () => {
  it("extracts the July 15 overview including inferred date and compact pace", () => {
    const text = `
      7月15日 周三
      户外跑步
      07:38-08:01
      体能训练详细信息
      体能训练时间 距离
      0:22:32 3.13 公里
      总爬升高度 平均功率
      1米 211瓦
      平均步频 平均配速
      166步/分 712" 公里
      平均心率
      159次/分
      耗能
      7 困难
    `;

    const result = extractRunDraftFromText(text, referenceDate);

    expect(result).toEqual({
      dateTime: "2026-07-15T07:38",
      distanceKm: "3.13",
      duration: "0:22:32",
      avgPace: "7:12",
      avgHeartRateBpm: "159",
      avgCadenceSpm: "166",
      avgPowerW: "211",
      effortScore: "7"
    });
    expect(getRunOcrWarnings(result)).toEqual([]);
  });

  it("extracts the July 14 five-kilometre overview", () => {
    const text = `
      7月14日 周二
      07:32-08:08
      体能训练时间 距离
      0:36:17 5.00公里
      总爬升高度 平均功率
      3米 208瓦
      平均步频 平均配速
      165步/分 7'15"/公里
      平均心率 159次/分
      耗能 6 适中
    `;

    expect(extractRunDraftFromText(text, referenceDate)).toEqual({
      dateTime: "2026-07-14T07:32",
      distanceKm: "5.00",
      duration: "0:36:17",
      avgPace: "7:15",
      avgHeartRateBpm: "159",
      avgCadenceSpm: "165",
      avgPowerW: "208",
      effortScore: "6"
    });
  });

  it("uses the Apple Watch effort label to correct a misread score digit", () => {
    const text = "体能训练时间 0:22:32 距离 3.13公里 耗能 2 困难 摘要";
    expect(extractRunDraftFromText(text, referenceDate).effortScore).toBe("7");
  });

  it("does not treat a split screenshot's 1.00-km heading as overview distance", () => {
    const text = "单段 1.00公里 时间 配速 心率 1 07:01 7'01\"/公里 140次/分";
    expect(extractRunDraftFromText(text, referenceDate)).toEqual({ avgPace: "7:01", avgHeartRateBpm: "140" });
  });
});

describe("Apple Watch split screenshot merging", () => {
  it("merges the two six-row views and drops the partial sixth segment for 5.00 km", () => {
    const text = `
      单段 1.00公里
      时间 配速 心率 功率
      1 07:01 7'01"/公里 140次/分 2
      2 07:21 7'21"/公里 159次/分 2
      3 06:50 6'50"/公里 165次/分 2
      4 07:42 7'42"/公里 164次/分 1
      5 07:14 7'14"/公里 167次/分 2
      6 00:06 12'40"/公里 171次/分 2
      单段 1.00公里
      心率 功率 步频
      1 140次/分 218K 169步/分
      2 159次/分 207瓦 168步/分
      3 165次/分 219FR 170步/分
      4 164次/分 194K 160步/分
      5 167次/分 207Rg 165% /%
      6 171次/分 206瓦 117步/分
    `;

    const result = extractSplitsFromText(text, 5);

    expect(result.detectedCount).toBe(6);
    expect(result.droppedIndexes).toEqual([6]);
    expect(result.incompleteIndexes).toEqual([]);
    expect(result.splits).toEqual([
      { distanceKm: "1", pace: "7:01", heartRateBpm: "140", powerW: "218", cadenceSpm: "169" },
      { distanceKm: "1", pace: "7:21", heartRateBpm: "159", powerW: "207", cadenceSpm: "168" },
      { distanceKm: "1", pace: "6:50", heartRateBpm: "165", powerW: "219", cadenceSpm: "170" },
      { distanceKm: "1", pace: "7:42", heartRateBpm: "164", powerW: "194", cadenceSpm: "160" },
      { distanceKm: "1", pace: "7:14", heartRateBpm: "167", powerW: "207", cadenceSpm: "165" }
    ]);
  });

  it("merges duplicate rows, keeps the clearer power value, and drops segment four for 3.13 km", () => {
    const text = `
      单段 1.00公里
      时间 配速 心率 功率
      1 07:21 7'21"/公里 149次/分 211
      2 06:37 6'37"/公里 164次/分 22:
      3 07:35 7'35"/公里 162次/分 19¢
      4 00:55 7'02"/公里 163次/分 204
      单段 1.00公里
      心率 功率 步频
      1 149次/分 21K 173步/分
      2 164次/分 228FR 170步/分
      3 162次/分 198HR 160步/分
      4 163次/分 200瓦 151步/分
    `;

    const result = extractSplitsFromText(text, 3.13);

    expect(result.detectedCount).toBe(4);
    expect(result.droppedIndexes).toEqual([4]);
    expect(result.incompleteIndexes).toEqual([]);
    expect(result.splits).toEqual([
      { distanceKm: "1", pace: "7:21", heartRateBpm: "149", powerW: "211", cadenceSpm: "173" },
      { distanceKm: "1", pace: "6:37", heartRateBpm: "164", powerW: "228", cadenceSpm: "170" },
      { distanceKm: "1", pace: "7:35", heartRateBpm: "162", powerW: "198", cadenceSpm: "160" }
    ]);
  });
});
