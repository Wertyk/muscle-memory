import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";

const workspace = resolve(import.meta.dirname, "..");

function check(args = []) {
  return spawnSync("pnpm", ["lint:arch", ...args], {
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

  test(`${name}: application still rejects a non-Zod package resolved through pnpm`, () => {
    const probe = resolve(workspace, "packages", name, "src/application/__architecture-probe.ts");
    const webRequire = createRequire(resolve(workspace, "apps/web/package.json"));
    const specifier = relative(dirname(probe), webRequire.resolve("react"));
    writeFileSync(probe, `import ${JSON.stringify(specifier)};`, { flag: "wx" });
    try {
      const result = check(["--output-type", "json"]);
      const graph = JSON.parse(result.stdout);
      // The JSON reporter communicates violations in the graph, not the exit status.
      assert.ok(graph.summary.error > 0);
      const module = graph.modules.find((entry) => entry.source === relative(workspace, probe));
      const dependency = module?.dependencies.find((entry) => entry.module === specifier);
      assert.ok(dependency, "The probe must actually import the resolved non-Zod package");
      assert.equal(dependency.couldNotResolve, false);
      assert.match(dependency.resolved, /^node_modules\/\.pnpm\/react@[^/]+\/node_modules\/react\//);
      assert.ok(graph.summary.violations.some((violation) => violation.from === relative(workspace, probe) && violation.rule.name === `${name}-application-dependencies`));
    } finally {
      unlinkSync(probe);
    }
  });
}

test("recipe-engine: application may import Zod resolved through pnpm", () => {
  const probe = resolve(workspace, "packages/recipe-engine/src/application/__architecture-probe.ts");
  writeFileSync(probe, 'import { z } from "zod";\nexport const schema = z.string();', { flag: "wx" });
  try {
    const result = check(["--output-type", "json"]);
    const graph = JSON.parse(result.stdout);
    const module = graph.modules.find((entry) => entry.source === relative(workspace, probe));
    const dependency = module?.dependencies.find((entry) => entry.module === "zod");
    assert.ok(dependency, "The probe must actually import Zod");
    assert.equal(dependency.couldNotResolve, false);
    assert.match(dependency.resolved, /^node_modules\/\.pnpm\/zod@[^/]+\/node_modules\/zod\//);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(graph.summary.error, 0, JSON.stringify(graph.summary.violations));
  } finally {
    unlinkSync(probe);
  }
});

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
