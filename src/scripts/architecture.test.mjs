import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const workspace = resolve(import.meta.dirname, "..");

function check() {
  return spawnSync("pnpm", ["lint:arch"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30_000,
  });
}

for (const name of ["recipe-engine", "shop-domain"]) {
  const other = name === "recipe-engine" ? "shop-domain" : "recipe-engine";
  const cases = [
    ["domain", 'import type { ZodType } from "zod";', "domain-is-pure"],
    ["domain", 'import "node:fs";', "domain-is-pure"],
    ["domain", 'import "../application/__architecture-probe.js";', "domain-is-pure"],
    ["application", 'import "react";', "application-dependencies"],
    ["application", `import "../../../${other}/src/index.js";`, "package-boundary"],
    ["application", 'import "../../../../apps/web/app/lib/app-config.ts";', "package-boundary"],
    ["", 'import "@agent-native/core/action";', "entrypoint-is-pure"],
  ];

  for (const [layer, source, rule] of cases) {
    test(`${name}: rejects ${source}`, () => {
      const probe = resolve(workspace, "packages", name, "src", layer, "__architecture-probe.ts");
      // Exclusive creation protects an existing file, even on an interrupted rerun.
      writeFileSync(probe, source, { flag: "wx" });
      try {
        const result = check();
        assert.ok(result.status > 0, result.stdout + result.stderr);
        assert.match(result.stdout + result.stderr, new RegExp(`${name}-${rule}`));
      } finally {
        unlinkSync(probe);
      }
    });
  }

  test(`${name}: application may import its domain and zod`, () => {
    const probe = resolve(workspace, "packages", name, "src/application/__architecture-probe.ts");
    writeFileSync(probe, 'import "../domain/index.js";\nimport "zod";', { flag: "wx" });
    try {
      const result = check();
      assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally {
      unlinkSync(probe);
    }
  });
}

for (const sdk of [
  "ai",
  "@ai-sdk/openai",
  "ai-sdk-ollama",
  "@openrouter/ai-sdk-provider",
  "openai",
  "openai/resources/chat/completions",
]) {
  test(`UI rejects LLM SDK import ${sdk}`, () => {
    const probe = resolve(workspace, "apps/web/app/__architecture-probe.ts");
    writeFileSync(probe, `import "${sdk}";`, { flag: "wx" });
    try {
      const result = check();
      assert.ok(result.status > 0, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /ui-never-imports-llm-sdk/);
    } finally {
      unlinkSync(probe);
    }
  });
}

test("clean tree passes and actually inspects TypeScript modules", () => {
  const result = check();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /[1-9]\d* modules/);
});
