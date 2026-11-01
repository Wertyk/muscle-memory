// Explicit live proof; normal tests never start a model or a server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { proofFiles } from "./fixtures";

const web = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function runSmoke() {
  assert(
    process.env.OPENAI_API_KEY && process.env.AGENT_MODEL,
    "Configured model environment required.",
  );
  const port = 8093;
  const origin = `http://localhost:${port}`;
  const directory = await mkdtemp(resolve(tmpdir(), "muscle-memory-task3-"));
  const staged: string[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  let cookie = "";
  let installed = false;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `Local request failed (${response.status})`);
    const result = await response.json();
    assert(!result.error, "Local request returned an error.");
    return result;
  };
  const control = (operation: string, label?: string) =>
    request("/_agent-native/actions/task3-proof-control", { operation, label });
  try {
    // Refuse overwrites and a port already in use. Never attach to another app.
    const busy = await fetch(`${origin}/_agent-native/ping`).then(
      () => true,
      () => false,
    );
    assert(!busy, "Smoke port 8093 is occupied.");
    for (const [name, content] of Object.entries(proofFiles)) {
      const path = resolve(web, name);
      await writeFile(path, content, { flag: "wx" });
      staged.push(path);
    }
    child = spawn("pnpm", ["dev", "--port", String(port)], {
      cwd: web,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        DATABASE_URL: `pglite:${directory}/db`,
        NODE_ENV: "development",
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        BETTER_AUTH_URL: origin,
      },
    });
    for (let attempt = 0; ; attempt++) {
      const ready = await fetch(`${origin}/_agent-native/ping`).then(
        (r) => r.ok,
        () => false,
      );
      if (ready) break;
      assert(
        attempt < 45 && child.exitCode === null,
        "Local smoke server did not become ready.",
      );
      await delay(1_000);
    }
    // Framework's standard one-time loopback dev sign-in, not an auth bypass.
    let signIn = await fetch(`${origin}/sign-in`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    for (let attempt = 0; signIn.status === 503 && attempt < 20; attempt++) {
      await delay(500);
      signIn = await fetch(`${origin}/sign-in`, {
        headers: { Accept: "text/html" },
        redirect: "manual",
      });
    }
    cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert(cookie, "Fresh local database did not issue a development session.");
    await request("/_agent-native/actions/hello?name=proof");
    console.log("Authenticated isolated local app ready.");

    const { proveFrontendTrace, renderProofCard } =
      await import("../../apps/web/scripts/mechanism-ui");
    const trace = await proveFrontendTrace(origin, cookie);
    const invocation = await request(
      "/_agent-native/actions/task3-proof-invoke",
      { label: "registry-proof" },
    );
    assert.equal(invocation.actionName, "task3-proof-mutate");
    assert.equal(invocation.eventsHandled, 3);
    const status = await control("status");
    assert(
      status.audit.some(
        (event: { action: string }) => event.action === "task3-proof-mutate",
      ),
    );
    assert(
      status.audit.some(
        (event: { action: string }) => event.action === "task3-proof-invoke",
      ),
    );
    console.log(
      "UI tracing, nested audit identity, and awaited events passed.",
    );

    // Warm a real chat turn before writing the skill. Same server/process after publication.
    const chat = async (message: string) => {
      const response = await fetch(`${origin}/_agent-native/agent-chat`, {
        method: "POST",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          model: process.env.AGENT_MODEL,
          engine: process.env.AGENT_ENGINE,
        }),
        signal: AbortSignal.timeout(180_000),
      });
      assert(response.ok, `Local chat HTTP ${response.status}`);
      const stream = await response.text();
      // Raw model/provider output deliberately stays in memory.
      return stream
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .flatMap((line) => {
          try {
            return [JSON.parse(line.slice(6))];
          } catch {
            return [];
          }
        });
    };
    const warm = await chat("Reply with READY only. Do not call tools.");
    assert(
      warm.some((event) => event.type === "text") &&
        !warm.some((event) => event.type === "error"),
      "Warm local chat failed.",
    );
    console.log(
      "Real chat warmed; publishing a runtime skill without restarting.",
    );
    const label = `kiln-${randomBytes(6).toString("hex")}`;
    await control("install-skill", label);
    installed = true;
    const events = await chat(
      "Use the task3-runtime-proof skill. Read its instructions and carry them out using the action it names. Do not invent the label.",
    );
    const done = events.find(
      (event) =>
        event.type === "tool_done" && event.tool === "task3-proof-card",
    );
    assert(
      done && !done.isError,
      "Agent did not complete the runtime skill card action.",
    );
    const result =
      done.chatUIResult ??
      (typeof done.result === "string" ? JSON.parse(done.result) : done.result);
    assert.equal(
      result.label,
      label,
      "Agent did not use the secret-free runtime skill nonce.",
    );
    assert.equal(done.chatUI?.renderer, "muscle-memory.task3-proof");
    const toolId = done.id ?? "tool_live_proof";
    const html = await renderProofCard(
      {
        id: toolId,
        name: done.tool,
        input: { label },
        output: result,
        status: "completed",
      },
      {
        id: "widget_live_proof",
        kind: done.chatUI.renderer,
        data: { toolCallId: toolId },
      },
    );
    assert(
      html.includes('data-task3-card="rendered"') && html.includes(label),
      "Live agent result did not render in the custom card.",
    );
    await control("remove-skill");
    installed = false;
    const core = JSON.parse(
      await readFile(
        resolve(web, "node_modules/@agent-native/core/package.json"),
        "utf8",
      ),
    );
    const evidence = {
      executedAt: new Date().toISOString(),
      frameworkVersion: core.version,
      model: process.env.AGENT_MODEL,
      trace,
      registry: {
        actionName: invocation.actionName,
        auditActions: [
          ...new Set(status.audit.map((e: { action: string }) => e.action)),
        ],
      },
      events: { handledBeforeResponse: invocation.eventsHandled },
      chat: {
        endpoint: "/_agent-native/agent-chat",
        warmBeforePublication: true,
        restarted: false,
        completedTools: events
          .filter((e) => e.type === "tool_done")
          .map((e) => e.tool),
        runtimeSkillNonceMatched: true,
        renderer: done.chatUI.renderer,
        renderedVia: "public AgentKitActionWidget + registered React renderer",
      },
      limitation:
        "Browser control host unavailable; DOM clicks use Happy DOM and card rendering uses React SSR with the real chat action result.",
    };
    await writeFile(
      new URL("./evidence.json", import.meta.url),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log(
      "Runtime skill discovery/use and real chat custom-card rendering passed. Sanitized evidence saved.",
    );
  } finally {
    if (installed) await control("remove-skill").catch(() => {});
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already stopped */
      }
      await Promise.race([
        new Promise((done) => child!.once("exit", done)),
        delay(5_000),
      ]);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
    for (const path of staged.reverse()) await rm(path, { force: true });
    await rm(directory, { force: true, recursive: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The imported browser/framework clients retain background timers. This
  // finite CLI exits only after runSmoke's finally has removed every fixture.
  runSmoke().then(
    () => process.exit(0),
    (error) => {
      // Provider responses, cookies and exception objects are never serialized.
      console.error(
        error instanceof assert.AssertionError
          ? error.message
          : "Mechanism smoke failed; details suppressed.",
      );
      process.exit(1);
    },
  );
}
