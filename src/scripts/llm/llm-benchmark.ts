// Opt-in, outside the app bundle. Run from apps/web using the package script.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { candidates, cases, gradeCalls, tools } from "./llm-benchmark-cases";

export interface Measurement {
  role: string;
  model: string;
  case: string;
  verdict: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export function summarize(rows: Measurement[]) {
  return candidates.map(({ model, role }) => {
    const runs = rows.filter(row => row.model === model);
    const total = (key: "inputTokens" | "outputTokens" | "totalTokens") =>
      runs.every(row => row[key] !== null) ? runs.reduce((sum, row) => sum + (row[key] ?? 0), 0) : null;
    return {
      role, model, passed: runs.filter(row => row.verdict === "pass").length, cases: runs.length,
      meanLatencyMs: Math.round(runs.reduce((sum, row) => sum + row.latencyMs, 0) / Math.max(1, runs.length)),
      inputTokens: total("inputTokens"), outputTokens: total("outputTokens"), totalTokens: total("totalTokens"),
    };
  });
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function runBenchmark() {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!apiKey || baseUrl !== "https://ollama.com/v1") throw new Error("Ollama benchmark environment is missing or invalid.");
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const modelsResponse = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!modelsResponse.ok) throw new Error(`Models endpoint HTTP ${modelsResponse.status}`);
  const catalog = await modelsResponse.json() as { data: { id: string }[] };
  const available = catalog.data.map(item => item.id);
  if (candidates.some(item => !available.includes(item.model))) throw new Error("A benchmark candidate is unavailable; verify the models endpoint.");

  const startedAt = new Date().toISOString();
  const rows: Measurement[] = [];
  // Sequential requests, 60 attempts total, no automatic retries, no follow-up turns.
  // Failures remain failures; their missing usage is never silently counted as zero.
  for (const { model, role } of candidates) {
    for (const test of cases) {
      const started = performance.now();
      const row: Measurement = { role, model, case: test.id, verdict: "network-error", latencyMs: 0, inputTokens: null, outputTokens: null, totalTokens: null };
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST", headers, signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            model, messages: [
              { role: "system", content: "Call exactly one appropriate tool with the requested arguments. Do not answer in prose." },
              { role: "user", content: test.prompt },
            ],
            tools, max_tokens: 256, temperature: 0,
            // Ollama does not accept tool_choice. Deliberately omit it.
          }),
        });
        if (!response.ok) {
          row.verdict = `http-${response.status}`;
        } else {
          const body = await response.json();
          row.verdict = gradeCalls(body.choices?.[0]?.message?.tool_calls, test);
          row.inputTokens = tokenCount(body.usage?.prompt_tokens);
          row.outputTokens = tokenCount(body.usage?.completion_tokens);
          row.totalTokens = tokenCount(body.usage?.total_tokens);
        }
      } catch (error) {
        row.verdict = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network-or-response-error";
        // Never serialize provider error objects, bodies, headers or model output.
      }
      row.latencyMs = Math.round(performance.now() - started);
      rows.push(row);
      console.log(`${model} ${test.id}: ${row.verdict} (${row.latencyMs} ms)`);
    }
  }
  const summary = summarize(rows);
  const date = startedAt.slice(0, 10);
  const dir = fileURLToPath(new URL("../../benchmarks/", import.meta.url));
  await mkdir(dir, { recursive: true });
  const report = {
    startedAt, finishedAt: new Date().toISOString(), frameworkVersion: "0.222.2", endpoint: baseUrl,
    settings: { maxTokens: 256, temperature: 0, timeoutMs: 30_000, attemptsPerCase: 1, toolChoice: "omitted" },
    availableModels: available, summary, measurements: rows,
  };
  await writeFile(`${dir}ollama-${date}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const table = summary.map(row => `| ${row.role} | \`${row.model}\` | ${row.passed}/${row.cases} (${Math.round(100 * row.passed / row.cases)}%) | ${row.meanLatencyMs} | ${row.inputTokens ?? "unknown"} | ${row.outputTokens ?? "unknown"} | ${row.totalTokens ?? "unknown"} |`).join("\n");
  await writeFile(`${dir}ollama-${date}.md`, `# Ollama Cloud benchmark — ${date} UTC\n\nStarted ${startedAt}. Agent-Native 0.222.2. Exact IDs verified with authenticated \`GET /v1/models\`.\n\nRun: \`pnpm -C src/apps/web benchmark:llm\`. This explicitly spends tokens; normal tests are offline.\n\nTen fixed synthetic cases per model, one sequential attempt each, five offered tools, no tools execute, no follow-up turns or retries. Success requires exactly one tool call with the exact name and parsed arguments. Cases cover lookup, tag arrays, cents conversion, quoted reply text, nested addresses, leading zeros and Unicode. All models receive the same prompts and schemas. Output cap 256 tokens, temperature 0, 30 s/request timeout; tool_choice omitted.\n\n| Role | Exact model ID | Tool success | Mean ms (all attempts) | Input tokens | Output tokens | Total tokens |\n| --- | --- | --- | ---: | ---: | ---: | ---: |\n${table}\n\nPer-case evidence and settings: [JSON](ollama-${date}.json). Unknown usage stays unknown, including errors/timeouts. Reported tokens come from the provider, not estimates.\n\nThis is a small screening benchmark, not a production reliability or pricing study. Ten short, independent calls cannot establish multi-step agent reliability. Output caps may penalize reasoning models. Latency includes network and provider load. Token counts do not establish monetary cost without per-model prices.\n`);
  console.log(`Saved src/benchmarks/ollama-${date}.{json,md}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBenchmark().catch(() => {
    console.error("Benchmark could not finish; check environment/network. Provider details suppressed.");
    process.exitCode = 1;
  });
}
