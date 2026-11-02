import { describe, expect, it } from "vitest";

import {
  axisDates,
  formatDuration,
  formatTimeTick,
  formatTokens,
  formatTokenTick,
} from "./dashboard-format";
import { costScale, COST_PLOT } from "./dashboard-scale";

describe("human-readable handling measurements", () => {
  it("rounds tokens to integers and uses compact notation only from 10K", () => {
    expect(formatTokens(1307.5, "en-US")).toBe("1,308");
    expect(formatTokens(9999, "en-US")).toBe("9,999");
    expect(formatTokens(10_000, "en-US")).toBe("10K");
    expect(formatTokens(106562.4, "en-US")).toBe("107K");
    expect(formatTokens(530197, "en-US")).toBe("530K");
    expect(formatTokens(0, "en-US")).toBe("0");
    expect(formatTokens(1307.5, "de-DE")).toBe("1.308");
    expect(formatTokenTick(1000, "en-US")).toBe("1K");
  });
  it("uses milliseconds below 1000 and seconds from 1000, preserving useful precision", () => {
    expect(formatDuration(18.84, "en-US")).toBe("18.8 ms");
    expect(formatDuration(999, "en-US")).toBe("999 ms");
    expect(formatDuration(1000, "en-US")).toBe("1 s");
    expect(formatDuration(4899, "en-US")).toBe("4.9 s");
    expect(formatDuration(47448, "en-US")).toBe("47.4 s");
    expect(formatTimeTick(60000, "en-US")).toBe("1 min");
    expect(formatDuration(1880, "de-DE")).toBe("1,9 Sek.");
  });
  it("uses time-only axis labels on one local day and includes dates across days", () => {
    const first = Date.UTC(2026, 10, 2, 3, 50);
    expect(axisDates([first, first + 60000], "en-US", "UTC")).toEqual([
      "3:50 AM",
      "3:51 AM",
    ]);
    expect(axisDates([first, first + 86400000], "en-US", "UTC")[0]).toContain(
      "Nov 2",
    );
    const midnight = Date.UTC(2026, 10, 2, 23, 50);
    expect(
      axisDates([midnight, midnight + 1200000], "en-US", "America/New_York")[0],
    ).toBe("6:50 PM");
  });
});

describe("log evidence plot with an exact-zero lane", () => {
  it("places equal ratios equally far apart and puts exact zero below the positive log range", () => {
    const scale = costScale([0, 1, 10, 100, 1308, 530197, null], "tokens");
    expect(scale.ticks).toEqual([1, 10, 100, 1000, 10000, 100000, 1000000]);
    expect(scale.y(1)! - scale.y(10)!).toBeCloseTo(
      scale.y(10)! - scale.y(100)!,
    );
    expect(scale.y(0)).toBe(COST_PLOT.zero);
    expect(scale.y(0)!).toBeGreaterThan(scale.y(1)!);
    expect(scale.y(1308)!).toBeLessThan(scale.y(1000)!);
    expect(scale.y(530197)!).toBeGreaterThan(scale.y(1000000)!);
    expect(scale.y(null)).toBeNull();
  });
  it("uses a minute upper tick for measured time and expands below 10ms without clamping observations", () => {
    const scale = costScale([0, 2, 18.8, 4899, 47448], "durationMs");
    expect(scale.ticks).toEqual([1, 10, 100, 1000, 10000, 60000]);
    expect(scale.y(2)!).toBeLessThan(scale.y(1)!);
    expect(scale.y(18.8)!).toBeLessThan(scale.y(10)!);
    expect(scale.y(0)).toBe(COST_PLOT.zero);
    expect(costScale([0], "tokens").y(0)).toBe(COST_PLOT.zero);
    expect(costScale([0.2], "durationMs").y(0.2)!).toBeLessThan(
      COST_PLOT.bottom,
    );
  });
});
