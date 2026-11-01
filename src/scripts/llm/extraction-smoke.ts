import { extractRequest } from "../../apps/web/server/infra/complete-text-extraction";

// Explicit opt-in paid smoke, never imported by the UI or automated tests.
async function main() {
  const model = process.env.EXTRACT_MODEL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!model || !apiKey || process.env.OPENAI_BASE_URL !== "https://ollama.com/v1") {
    throw new Error("Missing extraction environment.");
  }
  const started = performance.now();
  const result = await extractRequest("The mug in order ord_1042 arrived broken. Can you help?", { model, apiKey });
  if (result.fields.category !== "damaged_item" || result.fields.orderId !== "ord_1042") {
    throw new Error("Extraction did not match the synthetic fixture.");
  }
  console.log(JSON.stringify({ model: result.model, fields: result.fields, usage: result.usage, latencyMs: Math.round(performance.now() - started) }));
}

// Core's server barrel can leave background handles alive. This standalone CLI
// has finished its only operation once the result (or sanitized error) is written.
main().then(() => {
  process.stdout.write("Extraction smoke passed.\n", () => process.exit(0));
}).catch(() => {
  process.stderr.write("Extraction smoke failed; provider details suppressed.\n", () => process.exit(1));
});
