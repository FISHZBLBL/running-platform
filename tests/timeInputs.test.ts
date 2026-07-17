import { describe, expect, it } from "vitest";
import { normalizeTailDurationInput } from "../shared/timeInputs";

describe("tail duration input", () => {
  it.each([
    ["3", "0:03"],
    ["11", "0:11"],
    ["75", "1:15"],
    ["0011", "0:11"]
  ])("treats %s as total seconds", (input, expected) => {
    expect(normalizeTailDurationInput(input)).toBe(expected);
  });

  it("keeps an already formatted duration unchanged", () => {
    expect(normalizeTailDurationInput("00:15")).toBe("00:15");
  });

  it("does not rewrite invalid text", () => {
    expect(normalizeTailDurationInput("abc")).toBe("abc");
  });
});
