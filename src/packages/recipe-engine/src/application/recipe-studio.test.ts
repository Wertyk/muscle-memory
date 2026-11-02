import { describe, expect, it } from "vitest";

import type { JsonObject, RecipeVersion } from "../domain/model.js";
import {
  RecipeStudio,
  type RecipeStudioStore,
  type StudioRecord,
} from "./recipe-studio.js";
const version: RecipeVersion = {
  id: "ver_one",
  recipeId: "recipe_test",
  version: 1,
  name: "Care",
  trigger: { event: "request.created", match: true },
  steps: [
    {
      id: "tag",
      kind: "action",
      action: "tag-request",
      args: { tag: { mode: "fixed", value: "care" } },
    },
  ],
};
function setup() {
  let value: StudioRecord = {
    recipe: {
      id: version.recipeId,
      name: "Care",
      status: "draft",
      activeVersionId: null,
    },
    versions: [version],
    draft: null,
    runs: [],
  };
  let seq = 0;
  const store: RecipeStudioStore = {
    list: async () => [value],
    get: async (id) => (id === value.recipe.id ? value : null),
    transaction: async (_id, work) => {
      let pending: StudioRecord = JSON.parse(JSON.stringify(value));
      const result = await work({
        get: async () => pending,
        saveDraft: async (draft) => {
          pending = { ...pending, draft };
        },
        saveRecipe: async (recipe) => {
          pending = { ...pending, recipe };
        },
        saveVersion: async (saved) => {
          pending = { ...pending, versions: [...pending.versions, saved] };
        },
      });
      value = pending;
      return result;
    },
  };
  return new RecipeStudio(store, () => `ver_new${++seq}`);
}
describe("RecipeStudio application", () => {
  it("returns detached frozen drafts and saves new identities without altering the active snapshot", async () => {
    const studio = setup();
    await studio.activate({
      recipeId: version.recipeId,
      versionId: version.id,
    });
    const draft = await studio.getDraft(version.recipeId);
    expect(Object.isFrozen(draft.content)).toBe(true);
    const updated = await studio.update({
      recipeId: version.recipeId,
      expectedRevision: 0,
      content: { ...draft.content, name: "Better care" },
    });
    const saved = await studio.save({
      recipeId: version.recipeId,
      expectedRevision: updated.revision,
    });
    expect(saved).toMatchObject({ version: 2, id: "ver_new1" });
    expect((await studio.get(version.recipeId)).recipe.activeVersionId).toBe(
      version.id,
    );
    expect((await studio.get(version.recipeId)).history[0]?.version.name).toBe(
      "Care",
    );
    await expect(
      studio.save({
        recipeId: version.recipeId,
        expectedRevision: updated.revision,
      }),
    ).rejects.toThrow(/changed/);
  });
  it("retains invalid formulas/references/templates and reports their field paths; rejects immutable save", async () => {
    const studio = setup();
    const invalidBindings: JsonObject[] = [
      { mode: "expr", expr: { eval: ["x"] } },
      { mode: "path", path: "steps.future.output.id" },
      { mode: "template", template: "{{trigger.orderId}" },
    ];
    for (const binding of invalidBindings) {
      const draft = await studio.getDraft(version.recipeId);
      const updated = await studio.update({
        recipeId: version.recipeId,
        expectedRevision: draft.revision,
        content: {
          ...draft.content,
          steps: [
            {
              id: "tag",
              kind: "action",
              action: "tag-request",
              args: { tag: binding },
            },
          ],
        },
      });
      expect(
        updated.issues.some((issue) => issue.path.startsWith("steps")),
      ).toBe(true);
      await expect(
        studio.save({
          recipeId: version.recipeId,
          expectedRevision: updated.revision,
        }),
      ).rejects.toThrow(/validation/);
      expect((await studio.get(version.recipeId)).history).toHaveLength(1);
    }
  });
  it("cannot activate another recipe's version or an absent draft", async () => {
    const studio = setup();
    await expect(
      studio.activate({ recipeId: version.recipeId, versionId: "ver_other" }),
    ).rejects.toThrow(/not found/);
    await expect(studio.getDraft("recipe_unknown")).rejects.toThrow(
      /not found/,
    );
  });
  it("keeps version diffs focused on recipe content and can intentionally save identical content", async () => {
    const studio = setup();
    const saved = await studio.save({
      recipeId: version.recipeId,
      expectedRevision: 0,
    });
    expect(saved.version).toBe(2);
    expect((await studio.get(version.recipeId)).history[1]?.diff).toEqual([]);
    expect((await studio.list())[0]).toMatchObject({
      runs: 0,
      lastResult: null,
      version: 2,
    });
  });
});
