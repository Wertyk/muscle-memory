import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../kiln.css", import.meta.url), "utf8");
const global = readFileSync(new URL("../../global.css", import.meta.url), "utf8");
function tokens(source: string, selector: string) {
  const block = source.slice(source.indexOf(`${selector} {`)).split("}")[0]!;
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([\d.]+) ([\d.]+)% ([\d.]+)%;/g)].map(([, name, h, s, l]) => [name, [Number(h), Number(s), Number(l)] as const]));
}
function luminance([h, sat, light]: readonly number[]) {
  const s = sat! / 100, l = light! / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h! / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
}
const contrast = (a: readonly number[], b: readonly number[]) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe("Kiln theme contract", () => {
  it.each([":root", ".dark"])("has AA semantic ink and foreground on surfaces/background in %s", selector => {
    const kiln = tokens(css, selector), theme = tokens(global, selector);
    for (const family of ["ember", "celadon"]) {
      for (const ink of [family, `${family}-foreground`]) {
        expect(contrast(kiln[ink]!, kiln[`${family}-surface`]!), `${selector} ${ink} on surface`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(kiln[ink]!, theme.background!), `${selector} ${ink} on background`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("gives run outcome costs explicit semantic colour above link inheritance", () => {
    expect(css).toContain('.kiln-run-row .kiln-cost[data-handler="recipe"] { color: hsl(var(--celadon)); }');
    expect(css).toContain('.kiln-run-row .kiln-cost[data-handler="neutral"] { color: hsl(var(--muted-foreground)); }');
  });
  it("gates every new animation behind reduced-motion preference and retains the 2px minimum", () => {
    const motion = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(css.slice(0, motion)).not.toMatch(/\banimation\s*:/);
    expect(css.slice(0, motion)).not.toContain("@keyframes");
    expect(css).toContain("min-width: 2px");
    expect(global.match(/@import "\.\/kiln.css"/g)).toHaveLength(1);
  });
});
