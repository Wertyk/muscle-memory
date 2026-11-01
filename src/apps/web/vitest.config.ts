import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: "node_modules/.vitest/web",
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./app"),
      "@shared": path.resolve(import.meta.dirname, "./shared"),
    },
  },
  test: {
    fsModuleCachePath: new URL("./node_modules/.vitest-cache", import.meta.url)
      .pathname,
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/.react-router/**",
    ],
  },
});
