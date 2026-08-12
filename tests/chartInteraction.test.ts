import { describe, expect, it } from "vitest";
import { classifyGestureDirection, nearestPixelIndex } from "../src/chartInteraction";

describe("chart gesture direction", () => {
  it("waits until the movement threshold is reached", () => {
    expect(classifyGestureDirection(6, 5)).toBe("pending");
  });

  it("locks deliberate horizontal movement to chart inspection", () => {
    expect(classifyGestureDirection(18, 4)).toBe("horizontal");
  });

  it("prefers page scrolling for vertical and diagonal movement", () => {
    expect(classifyGestureDirection(4, 18)).toBe("vertical");
    expect(classifyGestureDirection(12, 12)).toBe("vertical");
  });
});

describe("nearest chart point", () => {
  it("returns the point closest to the pointer", () => {
    expect(nearestPixelIndex([20, 80, 140], 91)).toBe(1);
  });

  it("ignores invalid pixel coordinates", () => {
    expect(nearestPixelIndex([Number.NaN, 80], 20)).toBe(1);
    expect(nearestPixelIndex([Number.NaN], 20)).toBe(-1);
  });
});
