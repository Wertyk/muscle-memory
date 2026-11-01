import { defineConfig } from "vitest/config";
export default defineConfig({
  cacheDir: "node_modules/.vitest/shop-domain",
  test: {
    fsModuleCachePath: new URL("./node_modules/.vitest-cache", import.meta.url)
      .pathname,
  },
});
