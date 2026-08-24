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
      elevationGainM: "1",
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
      elevationGainM: "3",
      effortScore: "6"
    });
  });

  it("fills the run start time from a full-width Chinese time range", () => {
    const text = "7月17日 户外跑步 19：30–20：00 体能训练时间 0:30:00 距离 5.00公里";
    const result = extractRunDraftFromText(text, new Date(2026, 6, 17, 21, 0));

    expect(result.dateTime).toBe("2026-07-17T19:30");
  });

  it("uses the Apple Watch effort label to correct a misread score digit", () => {
    const text = "体能训练时间 0:22:32 距离 3.13公里 耗能 2 困难 摘要";
    expect(extractRunDraftFromText(text, referenceDate).effortScore).toBe("7");
  });

  it("uses the all-out effort label to recover score 9", () => {
    const text = "耗能评分 竭尽全力 体能训练时间 0:30:53 距离 5.01公里";
    expect(extractRunDraftFromText(text, referenceDate).effortScore).toBe("9");
  });

  it("recovers elevation from the garbled two-column overview layout", () => {
    const text = "体能训练时间 0:30:53 距离 5.01公里 平均功率 2K 248 F, 平均步频 166步/分";
    const result = extractRunDraftFromText(text, referenceDate);

    expect(result.elevationGainM).toBe("2");
    expect(result.avgPowerW).toBe("248");
  });

  it("parses the July 16 screenshot's actual combined OCR output", () => {
    const text = `耗能评分 9
      15:19 7月16日 周四 户外跑步 22:07-22:38 北京市
      体能训练详细信息 体能训练时间 距离 0:30:53 5.01公里
      动态干卡 总干卡数 440干卡 498FF RICH EE 平均功率 2K 248 F,
      平均步频 平均配速 166步/分 6'09'"/ 公里 平均心率 174次/分
      耗能 摘要 体能训练 共享`;

    expect(extractRunDraftFromText(text, referenceDate)).toEqual({
      dateTime: "2026-07-16T22:07",
      distanceKm: "5.01",
      duration: "0:30:53",
      avgPace: "6:09",
      avgHeartRateBpm: "174",
      avgCadenceSpm: "166",
      avgPowerW: "248",
      elevationGainM: "2",
      effortScore: "9"
    });
  });

  it("does not treat a split screenshot's 1.00-km heading as overview distance", () => {
    const text = "单段 1.00公里 时间 配速 心率 1 07:01 7'01\"/公里 140次/分";
    expect(extractRunDraftFromText(text, referenceDate)).toEqual({ avgPace: "7:01", avgHeartRateBpm: "140" });
  });
});

describe("Apple Watch split screenshot merging", () => {
  it("keeps the fifth full split when an Apple Watch side-arrow is OCRed before its row number", () => {
    const text = `
      单段 1.00公里
      时间 配速 心率 功率
      1 06:32 6'32"/公里 153次/分 230瓦
      2 06:32 6'32"/公里 172次/分 229瓦
      3 06:33 6'33"/公里 178次/分 228瓦
      〉 4 06:33 6'33"/公里 183次/分 226瓦
      > 5 06:54 6'54"/公里 184次/分 217瓦
      6 00:14 7'13"/公里 185次/分 216瓦
      单段 1.00公里
      心率 功率 步频
      1 153次/分 230瓦 171步/分
      2 172次/分 229瓦 168步/分
      3 178次/分 228瓦 167步/分
      ❯ 4 183次/分 226瓦 167步/分
      › 5 184次/分 217瓦 168步/分
      6 185次/分 216瓦 164步/分
    `;

    const result = extractSplitsFromText(text, 5);

    expect(result.splits.slice(0, 5).map((split) => split.pace)).toEqual(["6:32", "6:32", "6:33", "6:33", "6:54"]);
    expect(result.splits[4]).toMatchObject({
      heartRateBpm: "184",
      powerW: "217",
      cadenceSpm: "168"
    });
    expect(result.tailDuration).toBe("00:14");
    expect(result.incompleteIndexes).toEqual([]);
  });

  it("reports metric digit conflicts such as 183 being OCRed as 188 instead of silently accepting one value", () => {
    const text = `
      单段 1.00公里
      时间 配速 心率 功率
      1 06:32 6'32"/公里 153次/分 230瓦
      2 06:32 6'32"/公里 172次/分 229瓦
      3 06:33 6'33"/公里 178次/分 228瓦
      4 06:33 6'33"/公里 183次/分 223瓦
      5 06:54 6'54"/公里 184次/分 217瓦
      6 00:14 7'13"/公里 185次/分 216瓦
      单段 1.00公里
      心率 功率 步频
      1 153次/分 230瓦 171步/分
      2 172次/分 229瓦 168步/分
      3 178次/分 228瓦 167步/分
      4 188次/分 228瓦 168步/分
      5 184次/分 217瓦 168步/分
      6 185次/分 216瓦 164步/分
      单段 1.00公里
      心率 功率 步频
      1 153次/分 230瓦 171步/分
      2 172次/分 229瓦 168步/分
      3 178次/分 228瓦 167步/分
      4 183次/分 223瓦 163步/分
      5 184次/分 217瓦 168步/分
      6 185次/分 216瓦 164步/分
      单段 1.00公里
      心率 功率 步频
      1 153次/分 230瓦 171步/分
      2 172次/分 229瓦 168步/分
      3 178次/分 228瓦 167步/分
      4 183次/分 223瓦 163步/分
      5 184次/分 217瓦 168步/分
      6 185次/分 216瓦 164步/分
    `;

    const result = extractSplitsFromText(text, 5);

    expect(result.ambiguousFields).toContainEqual({
      index: 4,
      field: "heartRateBpm",
      candidates: ["183", "188"]
    });
    expect(result.ambiguousFields).toContainEqual({
      index: 4,
      field: "powerW",
      candidates: ["223", "228"]
    });
    expect(result.ambiguousFields).toContainEqual({
      index: 4,
      field: "cadenceSpm",
      candidates: ["163", "168"]
    });
    expect(result.splits[3]).toMatchObject({ heartRateBpm: "183", powerW: "223", cadenceSpm: "163" });
  });

  it("merges the two six-row views and appends the short sixth row as a time-only tail", () => {
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
    expect(result.droppedIndexes).toEqual([]);
    expect(result.incompleteIndexes).toEqual([]);
    expect(result.tailIndex).toBe(6);
    expect(result.tailDuration).toBe("00:06");
    expect(result.splits).toEqual([
      { distanceKm: "1", pace: "7:01", heartRateBpm: "140", powerW: "218", cadenceSpm: "169" },
      { distanceKm: "1", pace: "7:21", heartRateBpm: "159", powerW: "207", cadenceSpm: "168" },
      { distanceKm: "1", pace: "6:50", heartRateBpm: "165", powerW: "219", cadenceSpm: "170" },
      { distanceKm: "1", pace: "7:42", heartRateBpm: "164", powerW: "194", cadenceSpm: "160" },
      { distanceKm: "1", pace: "7:14", heartRateBpm: "167", powerW: "207", cadenceSpm: "165" },
      { kind: "tail", duration: "00:06", distanceKm: "", pace: "", heartRateBpm: "", powerW: "", cadenceSpm: "" }
    ]);
  });

  it("merges duplicate rows, keeps the clearer power value, and appends the 55-second tail", () => {
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
    expect(result.droppedIndexes).toEqual([]);
    expect(result.incompleteIndexes).toEqual([]);
    expect(result.tailIndex).toBe(4);
    expect(result.tailDuration).toBe("00:55");
    expect(result.splits).toEqual([
      { distanceKm: "1", pace: "7:21", heartRateBpm: "149", powerW: "211", cadenceSpm: "173" },
      { distanceKm: "1", pace: "6:37", heartRateBpm: "164", powerW: "228", cadenceSpm: "170" },
      { distanceKm: "1", pace: "7:35", heartRateBpm: "162", powerW: "198", cadenceSpm: "160" },
      { kind: "tail", duration: "00:55", distanceKm: "", pace: "", heartRateBpm: "", powerW: "", cadenceSpm: "" }
    ]);
  });

  it("recognizes the supplied 5.26-km run's 1:45 sixth row as a distance-consistent time-only tail", () => {
    const text = `
      单段 1.00公里
      心率 功率 步频
      1 141次/分 240瓦 168步/分
      2 155次/分 228瓦 164步/分
      3 158次/分 208瓦 165步/分
      4 163次/分 217瓦 166步/分
      5 170次/分 226瓦 167步/分
      6 170次/分 235瓦 165步/分
      单段 1.00公里
      时间 配速 心率 功率
      1 06:20 6'20"/公里 141次/分 240瓦
      2 06:37 6'37"/公里 155次/分 228瓦
      3 07:17 7'17"/公里 158次/分 208瓦
      4 06:59 6'59"/公里 163次/分 217瓦
      5 06:40 6'40"/公里 170次/分 226瓦
      6 01:45 6'34"/公里 170次/分 235瓦
    `;

    const result = extractSplitsFromText(text, 5.26);

    expect(result.detectedCount).toBe(6);
    expect(result.droppedIndexes).toEqual([]);
    expect(result.incompleteIndexes).toEqual([]);
    expect(result.tailIndex).toBe(6);
    expect(result.tailDuration).toBe("01:45");
    expect(result.splits.slice(0, 5).map((split) => split.pace)).toEqual(["6:20", "6:37", "7:17", "6:59", "6:40"]);
    expect(result.splits[5]).toEqual({
      kind: "tail",
      duration: "01:45",
      distanceKm: "",
      pace: "",
      heartRateBpm: "",
      powerW: "",
      cadenceSpm: ""
    });
  });

  it("rejects a long extra row when its time does not match the remaining fractional distance", () => {
    const text = `
      单段 1.00公里
      时间 配速 心率 功率
      1 05:52 5'52"/公里 150次/分 220瓦
      2 06:26 6'26"/公里 155次/分 215瓦
      3 06:15 6'15"/公里 158次/分 218瓦
      4 06:27 6'27"/公里 160次/分 214瓦
      5 05:56 5'56"/公里 162次/分 225瓦
      6 06:10 6'10"/公里 164次/分 226瓦
    `;

    const result = extractSplitsFromText(text, 5.26);

    expect(result.splits).toHaveLength(5);
    expect(result.tailDuration).toBeUndefined();
    expect(result.droppedIndexes).toEqual([6]);
  });

  it("keeps the existing rejection behavior when an extra row is not a short tail", () => {
    const text = `
      单段 1.00公里
      时间 配速 心率 功率
      1 05:52 5'52"/公里 150次/分 220瓦
      2 06:26 6'26"/公里 155次/分 215瓦
      3 06:15 6'15"/公里 158次/分 218瓦
      4 06:27 6'27"/公里 160次/分 214瓦
      5 05:56 5'56"/公里 162次/分 225瓦
      6 06:10 6'10"/公里 164次/分 226瓦
    `;

    const result = extractSplitsFromText(text, 5);

    expect(result.splits).toHaveLength(5);
    expect(result.tailDuration).toBeUndefined();
    expect(result.droppedIndexes).toEqual([6]);
  });
});
