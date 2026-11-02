import { describe, expect, it } from "vitest";

import type { SkillRegistry, SkillPublication } from "./ports.js";
import { recipeSkill, recipeSkillName } from "./recipe-skill.js";
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
function setup(skills?: SkillRegistry) {
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
  return new RecipeStudio(store, () => `ver_new${++seq}`, skills);
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
      ).rejects.toThrow(/steps\.0\.args/);
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

function fakeSkills() {
  const skills = new Map<string, string>();
  const receipts = new Map<string, SkillPublication>();
  let failing = false;
  const registry: SkillRegistry = {
    withLock: async (_id, work) => work(),
    put: async (name, description, instructions) => {
      if (failing) throw new Error("sensitive storage failure must never escape");
      skills.set(name, `${description}\n${instructions}`);
    },
    remove: async name => {
      if (failing) throw new Error("sensitive storage failure must never escape");
      skills.delete(name);
    },
    record: async (id, receipt) => { receipts.set(id, receipt); },
    publication: async id => receipts.get(id) ?? null,
  };
  return { registry, skills, fail: (value: boolean) => { failing = value; } };
}

describe("Studio runtime skill lifecycle", () => {
  it("publishes idempotently, updates the same skill for another active version, then removes it", async () => {
    const fake = fakeSkills();
    const studio = setup(fake.registry);
    const input = { recipeId: version.recipeId, versionId: version.id };
    expect(await studio.activate(input)).toMatchObject({ status: "active", skillPublication: { status: "published", versionId: version.id } });
    await studio.activate(input);
    expect(fake.skills.size).toBe(1);
    const draft = await studio.getDraft(version.recipeId);
    await studio.update({ recipeId: version.recipeId, expectedRevision: draft.revision, content: { ...draft.content, name: "New care" } });
    const second = await studio.save({ recipeId: version.recipeId, expectedRevision: 1 });
    await studio.activate({ recipeId: version.recipeId, versionId: second.id });
    expect(fake.skills.size).toBe(1);
    expect(fake.skills.get(recipeSkillName(version.recipeId))).toContain("New care");
    expect(fake.skills.get(recipeSkillName(version.recipeId))).toContain(second.id);
    expect((await studio.list("active"))[0]?.activeVersion?.id).toBe(second.id);
    expect(await studio.deactivate(version.recipeId)).toMatchObject({ status: "draft", skillPublication: { status: "removed" } });
    expect(fake.skills.size).toBe(0);
    expect(await studio.list("active")).toEqual([]);
    await studio.deactivate(version.recipeId);
  });

  it("records safe failures without undoing activation; retries the current pointer, including failed removal", async () => {
    const fake = fakeSkills();
    const studio = setup(fake.registry);
    fake.fail(true);
    const active = await studio.activate({ recipeId: version.recipeId, versionId: version.id });
    expect(active.status).toBe("active");
    expect(active.skillPublication).toMatchObject({ status: "failed", retryable: true });
    expect(JSON.stringify(await studio.get(version.recipeId))).not.toContain("sensitive");
    expect((await studio.get(version.recipeId)).skillPublication?.status).toBe("failed");
    fake.fail(false);
    expect(await studio.syncSkill(version.recipeId)).toMatchObject({ status: "published", retryable: false });
    fake.fail(true);
    expect(await studio.deactivate(version.recipeId)).toMatchObject({ status: "draft", skillPublication: { status: "failed", versionId: null } });
    fake.fail(false);
    expect(await studio.syncSkill(version.recipeId)).toMatchObject({ status: "removed", versionId: null });
    expect(fake.skills.size).toBe(0);
  });

  it("does not republish an obsolete failed version after a new activation", async () => {
    const fake = fakeSkills();
    const studio = setup(fake.registry);
    fake.fail(true);
    await studio.activate({ recipeId: version.recipeId, versionId: version.id });
    const second = await studio.save({ recipeId: version.recipeId, expectedRevision: 0 });
    fake.fail(false);
    await studio.activate({ recipeId: version.recipeId, versionId: second.id });
    expect(await studio.syncSkill(version.recipeId)).toMatchObject({ versionId: second.id });
    expect(fake.skills.get(recipeSkillName(version.recipeId))).toContain(second.id);
  });

  it("keeps activation successful even if receipt persistence fails", async () => {
    const fake = fakeSkills();
    fake.registry.record = async () => { throw new Error("private DB error"); };
    expect(await setup(fake.registry).activate({ recipeId: version.recipeId, versionId: version.id }))
      .toMatchObject({ status: "active", skillPublication: { status: "failed", retryable: true } });
  });

  it("describes the trigger, required inputs, active readback, dry-run and concise card replies", () => {
    const skill = recipeSkill({ ...version, trigger: { event: "request.created", match: { "==": [{ var: "type" }, "damaged_item"] } } });
    expect(skill.description).toContain("type is damaged item");
    for (const expected of ["Inputs:", "requestId", "get-recipe", "activeVersionId", "dryRun:true", "dryRun:false", "one or two sentences"]) expect(skill.instructions).toContain(expected);
    expect(recipeSkillName("recipe_A")).not.toBe(recipeSkillName("recipe-a"));
  });
});
