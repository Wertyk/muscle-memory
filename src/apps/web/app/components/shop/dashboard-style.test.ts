import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dashboardCss = readFileSync(
  new URL("./dashboard.css", import.meta.url),
  "utf8",
);
const globalCss = readFileSync(
  new URL("../../global.css", import.meta.url),
  "utf8",
);
function colors(css: string, name: string) {
  return [
    ...css.matchAll(
      new RegExp(`--${name}:\\s*([\\d.]+) ([\\d.]+)% ([\\d.]+)%`, "g"),
    ),
  ].map((match) => [
    Number(match[1]),
    Number(match[2]) / 100,
    Number(match[3]) / 100,
  ]);
}
function luminance([h = 0, s = 0, l = 0]: number[]) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - chroma / 2;
  const channels =
    h < 60
      ? [chroma, x, 0]
      : h < 120
        ? [x, chroma, 0]
        : h < 180
          ? [0, chroma, x]
          : h < 240
            ? [0, x, chroma]
            : h < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const linear = channels
    .map((c) => c + m)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

describe("dashboard handler contrast", () => {
  const agent = colors(dashboardCss, "dashboard-agent");
  const recipe = colors(globalCss, "shop-resolved");
  const cards = colors(globalCss, "card");
  it.each([0, 1])(
    "uses distinct warm/green hues with readable text and points against theme %i",
    (theme) => {
      expect(agent[theme]![0]).toBeLessThan(60);
      expect(recipe[theme]![0]).toBeGreaterThan(100);
      for (const foreground of [agent[theme]!, recipe[theme]!]) {
        const levels = [luminance(foreground), luminance(cards[theme]!)].sort(
          (a, b) => b - a,
        );
        expect(
          (levels[0]! + 0.05) / (levels[1]! + 0.05),
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});
