import { describe, it, expect } from "vitest";
import { formatInt, formatNum, shortModel } from "./format";

describe("shortModel", () => {
  it("keeps the version dot and capitalises the family", () => {
    expect(shortModel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
  });

  it("drops the date suffix before reading the version", () => {
    expect(shortModel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
  });

  it("leaves names without a two-part version readable", () => {
    expect(shortModel("claude-3-opus-20240229")).toBe("3 opus");
    expect(shortModel("<synthetic>")).toBe("<synthetic>");
  });
});

describe("formatNum / formatInt", () => {
  it("groups every number of four digits or more", () => {
    expect(formatInt(1840)).toBe("1.840");
    expect(formatInt(96000)).toBe("96.000");
    expect(formatInt(340)).toBe("340");
  });

  it("uses compact notation with one decimal for tokens", () => {
    expect(formatNum(48_000_000)).toBe("48 M");
    expect(formatNum(1_060_000_000)).toBe("1,1 mil M");
    expect(formatNum(11_400)).toBe("11,4 mil");
    expect(formatNum(2_500_000_000_000)).toBe("2.500 mil M");
    expect(formatNum(340)).toBe("340");
  });
});
