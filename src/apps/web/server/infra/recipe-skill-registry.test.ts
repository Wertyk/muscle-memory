import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { resourceGetByPath, SHARED_OWNER } from "@agent-native/core/resources";
import { loadResourcesForPrompt } from "@agent-native/core/server";
import type { RecipeVersion } from "@muscle-memory/recipe-engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import activateRecipe from "../../actions/activate-recipe.js";
import deactivateRecipe from "../../actions/deactivate-recipe.js";
import listRecipes from "../../actions/list-recipes.js";
import retryRecipeSkill from "../../actions/retry-recipe-skill.js";
import { getDb } from "../db/index.js";
import { recipes } from "../db/schema.js";
import migrateApp from "../plugins/db.js";
import { persistRecipeVersion } from "./recipe-catalog.js";
import { ResourceSkillRegistry } from "./resource-skill-registry.js";

const version: RecipeVersion = {
  id: "ver_registry1", recipeId: "recipe_registry", version: 1, name: "Registry shipment lookup",
  trigger: { event: "request.created", match: { "==": [{ var: "trigger.type" }, "where_is_my_order"] } },
  steps: [{ id: "lookup", kind: "action", action: "get-request", args: { requestId: { mode: "path", path: "trigger.requestId" } } }],
};
const context = { caller: "frontend" as const, userEmail: "operator@example.test" };
const name = `recipe-${Array.from(version.recipeId, char => char.charCodeAt(0).toString(16)).join("")}`;
const path = `skills/${name}/SKILL.md`;
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(`${tmpdir()}/muscle-memory-registry-test-`);
  vi.stubEnv("DATABASE_URL", `pglite:${directory}`);
  await withMigrationRuntime(async () => { await migrateApp(undefined); });
  const db = getDb();
  await persistRecipeVersion(db, version);
  await db.insert(recipes).values({ id: version.recipeId, name: version.name, status: "draft", activeVersionId: null });
}, 30_000);
afterAll(async () => {
  await closeDbExec();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("Recipe Studio with real framework resource storage", () => {
  it("publishes valid discoverable shared frontmatter, updates in place and removes without a restart", async () => {
    await activateRecipe.run({ recipeId: version.recipeId, versionId: version.id }, context);
    const first = await resourceGetByPath(SHARED_OWNER, path);
    expect(first?.content).toMatch(/^---\nname:/);
    expect(first?.content).toContain(`description: "${version.name}. Handles`);
    expect(first?.content).toContain("dryRun:true");
    expect(await loadResourcesForPrompt(context.userEmail)).toContain("where is my order");
    expect(await loadResourcesForPrompt("second@example.test")).toContain(version.name);
    await activateRecipe.run({ recipeId: version.recipeId, versionId: version.id }, context);
    expect((await resourceGetByPath(SHARED_OWNER, path))?.id).toBe(first?.id);
    const second = { ...version, id: "ver_registry2", version: 2, name: "Updated registry lookup" };
    await persistRecipeVersion(getDb(), second);
    await activateRecipe.run({ recipeId: version.recipeId, versionId: second.id }, context);
    expect((await resourceGetByPath(SHARED_OWNER, path))?.content).toContain(second.id);
    expect((await listRecipes.run({ status: "active" }, context))[0]).toMatchObject({ activeVersion: { id: second.id }, skillPublication: { status: "published", versionId: second.id } });
    await deactivateRecipe.run({ recipeId: version.recipeId }, context);
    expect(await resourceGetByPath(SHARED_OWNER, path)).toBeNull();
    expect(await loadResourcesForPrompt(context.userEmail)).not.toContain(second.name);
  });

  it("persists a sanitized failure and retries through the same shared action", async () => {
    const put = vi.spyOn(ResourceSkillRegistry.prototype, "put").mockRejectedValue(new Error("private storage details"));
    try {
      expect(await activateRecipe.run({ recipeId: version.recipeId, versionId: version.id }, context)).toMatchObject({ status: "active", skillPublication: { status: "failed", retryable: true } });
      const listed = await listRecipes.run({ status: "active" }, context);
      expect(listed[0]?.skillPublication?.status).toBe("failed");
      expect(JSON.stringify(listed)).not.toContain("private storage details");
    } finally { put.mockRestore(); }
    expect(await retryRecipeSkill.run({ recipeId: version.recipeId }, context)).toMatchObject({ skillPublication: { status: "published", retryable: false } });
    expect((await resourceGetByPath(SHARED_OWNER, path))?.content).toContain(version.id);
    await deactivateRecipe.run({ recipeId: version.recipeId }, context);
  });
});
