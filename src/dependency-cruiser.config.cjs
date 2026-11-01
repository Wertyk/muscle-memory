const packages = ["recipe-engine", "shop-domain"];

module.exports = {
  forbidden: [
    {
      name: "ui-never-imports-llm-sdk",
      severity: "error",
      from: { path: "^apps/web/app/" },
      to: {
        // Match both unresolved specifiers and resolved pnpm package paths.
        path: [
          "^(?:ai|ai-sdk-ollama|openai)(?:/|$)",
          "^@(?:ai-sdk|openrouter)/",
          "(?:^|/)node_modules/(?:ai|ai-sdk-ollama|openai)(?:/|$)",
          "(?:^|/)node_modules/@(?:ai-sdk|openrouter)/",
        ],
      },
    },
    ...packages.flatMap((name) => {
      const own = `packages/${name}/src`;
      return [
        {
          name: `${name}-domain-is-pure`,
          severity: "error",
          from: { path: `^${own}/domain/` },
          to: { pathNot: `^${own}/domain/` },
        },
        {
          name: `${name}-application-dependencies`,
          severity: "error",
          from: { path: `^${own}/application/` },
          to: {
            pathNot: [
              `^${own}/domain/`,
              `^${own}/application/`,
              "^node_modules/zod/",
              // pnpm resolves Zod to its own versioned store directory.
              "^node_modules/\\.pnpm/zod@[^/]+/node_modules/zod/",
              "^zod(?:/|$)",
            ],
          },
        },
        {
          name: `${name}-entrypoint-is-pure`,
          severity: "error",
          from: { path: `^${own}/(?!domain/|application/)` },
          to: { pathNot: `^${own}/` },
        },
        {
          name: `${name}-package-boundary`,
          severity: "error",
          from: { path: `^packages/${name}/` },
          to: { path: `^(?:apps/|packages/(?!${name}/))` },
        },
      ];
    }),
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // Ignore workspace output, while retaining SDK exports under node_modules/*/dist.
    exclude: { path: "^packages/[^/]+/(?:dist|build)/|^apps/web/(?:dist|build|data|\\.generated|\\.react-router)/|\\.(?:test|spec)\\.[cm]?[jt]sx?$" },
    // SWC includes type-only imports without depending on the pre-7 TS API.
    parser: "swc",
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types", "default"] },
  },
};
