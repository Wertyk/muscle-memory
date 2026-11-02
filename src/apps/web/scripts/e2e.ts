import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const web = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const origin = "http://localhost:8098";
const started = performance.now();
const children = new Set<ChildProcess>();
let directory: string | undefined;
let cleaning: Promise<void> | undefined;

function launch(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: "inherit" });
  children.add(child);
  return child;
}
function completion(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`E2E child failed (${signal ?? code})`)));
  });
}
function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
function cleanup() {
  return cleaning ??= (async () => {
    await Promise.all([...children].map(async (child) => {
      signalGroup(child, "SIGTERM");
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
      // The pnpm/CLI parent can exit before its worker; kill the whole owned group.
      signalGroup(child, "SIGKILL");
    }));
    if (directory) await rm(directory, { recursive: true, force: true });
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void cleanup().then(() => process.exit(signal === "SIGINT" ? 130 : 143)); });
}

try {
  // Refuse reuse or Vite's automatic fallback to a different port.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(8098, resolve); });
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  directory = await mkdtemp(join(tmpdir(), "muscle-memory-e2e-"));
  const app = join(directory, "app");
  await mkdir(app);
  // Whitelist sources: never copy/read .env files, credentials, local data or caches.
  for (const entry of ["app", "actions", "server", "shared", "public", "scripts/shop-data.ts", "package.json", "tsconfig.json", "vite.config.ts", "react-router.config.ts", "agent-native.config.ts", "agent-native.json", "ssr-entry.ts"]) {
    await cp(join(web, entry), join(app, entry), { recursive: true, filter: (path) => !path.split(/[\\/]/).some((part) => part.startsWith(".env")) });
  }
  // Packages are shared; Vite/Nitro caches must belong to the disposable app.
  await mkdir(join(app, "node_modules"));
  for (const entry of await readdir(join(web, "node_modules"))) {
    if (!entry.startsWith(".")) await symlink(join(web, "node_modules", entry), join(app, "node_modules", entry), "dir");
  }
  // Vite must be able to transform the reused workspace packages outside /tmp.
  await writeFile(join(app, "e2e.vite.config.ts"), `import { mergeConfig } from "vite";\nimport app from "./vite.config.ts";\nexport default mergeConfig(app, { server: { fs: { allow: ${JSON.stringify([app, fileURLToPath(new URL("../../../", import.meta.url))])} } } });\n`);
  // Read only these inherited values. In particular, never inherit provider keys,
  // NODE_OPTIONS, auth bypasses, external databases, proxies or deployment config.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "DISPLAY", "XAUTHORITY"]) {
    // guard:allow-env-credential — OS/runtime allowlist for disposable test subprocesses; no provider credentials.
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    NODE_ENV: "development", DATABASE_URL: `pglite:${directory}/db`, PORT: "8098",
    AUTH_DISABLED: "false",
    BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    AGENT_NATIVE_OWNER_EMAIL: "dev@local.test", AGENT_MODEL: "", EXTRACT_MODEL: "",
  });
  const playwright = require.resolve("@playwright/test/cli");
  try {
    const browser = await chromium.launch({ channel: "chrome", env });
    await browser.close();
    env.MUSCLE_MEMORY_E2E_BROWSER = "chrome";
    console.log("E2E browser: installed Google Chrome");
  } catch {
    console.log("Google Chrome unavailable; falling back to playwright install chromium.");
    await completion(launch([playwright, "install", "chromium"], web, env));
    env.MUSCLE_MEMORY_E2E_BROWSER = "chromium";
  }
  console.log("E2E: seed disposable PGlite (no .env files or provider credentials).");
  await completion(launch([require.resolve("tsx/cli"), "scripts/shop-data.ts", "seed"], app, env));
  const server = launch([join(web, "node_modules/@agent-native/core/bin/agent-native.js"), "dev", "--config", "e2e.vite.config.ts", "--port", "8098", "--strictPort"], app, env);
  await expect.poll(async () => {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error("E2E server exited before readiness");
    // Consume the framework's one-time automatic account creation without keeping
    // its cookie. The next unauthenticated visit presents Continue as local dev.
    // DISABLE_AUTO_DEV_ACCOUNT also disables that button in core 0.222.2.
    return fetch(`${origin}/sign-in`, { headers: { Accept: "text/html" }, redirect: "manual", signal: AbortSignal.timeout(2_000) }).then((response) => response.ok, () => false);
  }, { timeout: 90_000, message: "Isolated app sign-in must be ready on port 8098" }).toBe(true);
  await completion(launch([playwright, "test"], web, env));
} catch (error) {
  console.error(error instanceof Error ? error.message : "E2E failed");
  process.exitCode = 1;
} finally {
  await cleanup();
  console.log(`E2E finished in ${((performance.now() - started) / 1000).toFixed(2)}s; server stopped and temporary app/database removed.`);
}
