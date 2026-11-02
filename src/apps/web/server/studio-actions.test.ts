import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import {
  recipeContent,
  type Demonstration,
  type RecipeDraft,
} from "@muscle-memory/recipe-engine";
import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import activateRecipe from "../actions/activate-recipe.js";
import deactivateRecipe from "../actions/deactivate-recipe.js";
import draftRecipe from "../actions/draft-recipe-from-demonstration.js";
import getDraft from "../actions/get-recipe-draft.js";
import getRecipe from "../actions/get-recipe.js";
import listRecipes from "../actions/list-recipes.js";
import runRecipe from "../actions/run-recipe.js";
import saveVersion from "../actions/save-recipe-version.js";
import updateDraft from "../actions/update-recipe-draft.js";
import * as composition from "./composition.js";
import { getDb, type ShopDb } from "./db/index.js";
import * as tables from "./db/schema.js";
import {
  damagedItemFixture,
  whereIsMyOrderFixture,
} from "./fixtures/intake-recipes.js";
import { DrizzleRecipeCatalog } from "./infra/recipe-catalog.js";
import { seedShop } from "./infra/shop-demo-store.js";
import { DrizzleTraceStore } from "./infra/trace-store.js";
import migrateApp from "./plugins/db.js";
import { studioDraftRead } from "./studio-action-contracts.js";

const context = {
  caller: "frontend" as const,
  userEmail: "operator@example.test",
};
const recipeId = damagedItemFixture.recipeId;
const content = recipeContent(damagedItemFixture);
async function editableDraft() {
  const draft = await getDraft.run({ recipeId }, context);
  if (!draft || !("content" in draft))
    throw new Error("Expected editable Studio draft");
  return draft;
}

describe("Recipe Studio real actions on PGlite", () => {
  let directory: string;
  let db: ShopDb;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "mm-studio-"));
    vi.stubEnv("DATABASE_URL", `pglite:${directory}`);
    await withMigrationRuntime(async () => {
      await migrateApp(undefined);
    });
    db = getDb();
  }, 30_000);
  beforeEach(async () => {
    await seedShop(db, { all: true });
    const catalog = new DrizzleRecipeCatalog(db);
    for (const version of [damagedItemFixture, whereIsMyOrderFixture]) {
      await catalog.saveVersion(version);
      await catalog.save({
        id: version.recipeId,
        name: version.name,
        status: "draft",
        activeVersionId: null,
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await closeDbExec();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("reads fixture catalog, draft and history without creating draft rows", async () => {
    expect(studioDraftRead.safeParse({ recipeId }).success).toBe(true);
    expect(
      studioDraftRead.safeParse({ versionId: damagedItemFixture.id }).success,
    ).toBe(true);
    expect(studioDraftRead.safeParse({}).success).toBe(false);
    expect(
      studioDraftRead.safeParse({ recipeId, versionId: damagedItemFixture.id })
        .success,
    ).toBe(false);
    expect(await listRecipes.run({}, context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: recipeId,
          version: 1,
          runs: 0,
          lastResult: null,
          status: "draft",
        }),
      ]),
    );
    expect(await editableDraft()).toMatchObject({
      recipeId,
      content,
      revision: 0,
      ambiguities: [],
      issues: [],
    });
    expect(await getRecipe.run({ recipeId }, context)).toMatchObject({
      history: [{ version: damagedItemFixture, diff: [] }],
    });
    expect(await db.select().from(tables.recipeDrafts)).toEqual([]);
  });
  it("edits bindings, trigger and approval via the same actions, saves immutable history, and selects an active pointer", async () => {
    await activateRecipe.run(
      { recipeId, versionId: damagedItemFixture.id },
      context,
    );
    const steps = structuredClone(content.steps) as any[];
    steps[1].then[0].args.reason = {
      mode: "template",
      template: "Damaged {{trigger.productId}}",
    };
    steps[1].then[0].approval = {
      ">": [{ var: "steps.order.output.total.amountMinor" }, 10000],
    };
    const next = {
      ...content,
      name: "Damage care",
      trigger: {
        event: "request.created",
        match: {
          and: [
            damagedItemFixture.trigger.match,
            { ">": [{ var: "trigger.quantity" }, 0] },
          ],
        },
      },
      steps,
    };
    const draft = await updateDraft.run(
      { recipeId, expectedRevision: 0, content: next },
      context,
    );
    expect(draft).toMatchObject({ revision: 1, issues: [] });
    const saved = await saveVersion.run(
      { recipeId, expectedRevision: 1 },
      context,
    );
    expect(saved).toMatchObject({ recipeId, version: 2, name: "Damage care" });
    expect(saved.id).not.toBe(damagedItemFixture.id);
    expect(
      (await getRecipe.run({ recipeId }, context)).recipe.activeVersionId,
    ).toBe(damagedItemFixture.id);
    const history = (await getRecipe.run({ recipeId }, context)).history;
    expect(history[0]?.version).toEqual(damagedItemFixture);
    expect(history[1]?.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/name",
          historical: String(content.name),
          intended: "Damage care",
        }),
        expect.objectContaining({
          path: "/steps/1/then/0/args/reason/mode",
          intended: "template",
        }),
      ]),
    );
    expect(
      await activateRecipe.run(
        { recipeId, versionId: saved.id },
        { ...context, caller: "tool" },
      ),
    ).toMatchObject({ status: "active", activeVersionId: saved.id });
    expect((await new DrizzleRecipeCatalog(db).listActive())[0]?.id).toBe(
      saved.id,
    );
    expect(await deactivateRecipe.run({ recipeId }, context)).toMatchObject({
      status: "draft",
      activeVersionId: null,
    });
    expect(await new DrizzleRecipeCatalog(db).listActive()).toEqual([]);
    await expect(
      db.execute(
        sql`UPDATE recipe_versions SET snapshot = ${JSON.stringify(saved)}::jsonb WHERE id = ${saved.id}`,
      ),
    ).rejects.toThrow();
  });
  it("retains invalid drafts with inline errors, rejects saving/activation and preserves ambiguity evidence", async () => {
    const evidence = {
      demonstrationId: "demo_test",
      ambiguities: [
        {
          stepId: "refund",
          argumentPath: "amount",
          kind: "constant-or-variable",
          message: "Choose a reusable refund rule",
          candidates: [],
        },
      ],
    };
    await db.execute(
      sql`INSERT INTO recipe_drafts (version_id, owner_email, workspace_id, evidence) VALUES (${damagedItemFixture.id}, ${context.userEmail}, 'personal', ${JSON.stringify(evidence)}::jsonb)`,
    );
    expect(
      await getDraft.run({ versionId: damagedItemFixture.id }, context),
    ).toMatchObject({
      demonstrationId: "demo_test",
      ambiguities: evidence.ambiguities,
    });
    expect(
      await getDraft.run(
        { versionId: damagedItemFixture.id },
        { ...context, userEmail: "another@example.test" },
      ),
    ).toBeNull();
    const invalid = {
      ...content,
      trigger: {
        event: "request.created",
        match: { eval: ["arbitrary code"] },
      },
    };
    const draft = await updateDraft.run(
      { recipeId, expectedRevision: 0, content: invalid },
      context,
    );
    expect(
      draft.issues.some((issue) => issue.path.startsWith("trigger.match")),
    ).toBe(true);
    expect(draft.ambiguities).toHaveLength(1);
    const foreign = await getDraft.run(
      { recipeId },
      { ...context, orgId: "other" },
    );
    expect(
      foreign && "content" in foreign ? foreign.ambiguities : null,
    ).toEqual([]);
    expect(
      (await db.select().from(tables.recipeDrafts))[0]?.evidence.ambiguities,
    ).toEqual(evidence.ambiguities);
    expect(
      await getDraft.run({ versionId: damagedItemFixture.id }, context),
    ).not.toHaveProperty("studio");
    await expect(
      saveVersion.run({ recipeId, expectedRevision: draft.revision }, context),
    ).rejects.toThrow(/validation/);
    await expect(
      activateRecipe.run({ recipeId, versionId: "ver_unsaved" }, context),
    ).rejects.toThrow(/not found/);
    // Even legacy/external invalid stored snapshots must fail activation validation.
    await db.insert(tables.recipeVersions).values({
      id: "ver_invalid",
      recipeId,
      version: 2,
      snapshot: {
        ...damagedItemFixture,
        id: "ver_invalid",
        version: 2,
        trigger: invalid.trigger,
      } as any,
    });
    await expect(
      activateRecipe.run({ recipeId, versionId: "ver_invalid" }, context),
    ).rejects.toThrow();
    expect((await new DrizzleRecipeCatalog(db).get(recipeId))?.status).toBe(
      "draft",
    );
    const repaired = await updateDraft.run(
      { recipeId, expectedRevision: draft.revision, content },
      context,
    );
    expect(repaired.issues).toEqual([]);
    await saveVersion.run(
      { recipeId, expectedRevision: repaired.revision },
      context,
    );
  });
  it("rejects stale/concurrent edits and saves without overwriting history", async () => {
    const edits = await Promise.allSettled([
      updateDraft.run(
        { recipeId, expectedRevision: 0, content: { ...content, name: "One" } },
        context,
      ),
      updateDraft.run(
        { recipeId, expectedRevision: 0, content: { ...content, name: "Two" } },
        context,
      ),
    ]);
    expect(edits.filter((edit) => edit.status === "fulfilled")).toHaveLength(1);
    const draft = await editableDraft();
    const saves = await Promise.allSettled([
      saveVersion.run({ recipeId, expectedRevision: draft.revision }, context),
      saveVersion.run({ recipeId, expectedRevision: draft.revision }, context),
    ]);
    expect(saves.filter((save) => save.status === "fulfilled")).toHaveLength(1);
    expect((await getRecipe.run({ recipeId }, context)).history).toHaveLength(
      2,
    );
    await expect(
      updateDraft.run({ recipeId, expectedRevision: 0, content }, context),
    ).rejects.toThrow(/changed/);
  });
  it("opens a TASK-11 draft from the stored broken-platter demonstration, edits the same canonical row and preserves its original read", async () => {
    const demo = JSON.parse(
      await readFile(
        new URL(
          "./fixtures/broken-platter-demonstration.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Demonstration;
    const actor = {
      caller: "frontend" as const,
      userEmail: demo.scope.userId,
      orgId: demo.scope.workspaceId,
    };
    await new DrizzleTraceStore(db).transaction((records) =>
      records.save(demo),
    );
    const original: RecipeDraft = await draftRecipe.run(
      { demonstrationId: demo.id },
      actor,
    );
    const read = await getDraft.run({ recipeId: original.recipe.id }, actor);
    if (!read || !("content" in read)) throw new Error("Expected Studio draft");
    expect(read.issues).toEqual([]);
    expect(read.ambiguities).toEqual(original.ambiguities);
    const source = JSON.stringify(read.content);
    for (const operator of ["find", "firstWord", "money", "cat"])
      expect(source).toContain(`"${operator}"`);
    const updated = await updateDraft.run(
      {
        recipeId: original.recipe.id,
        expectedRevision: read.revision,
        content: { ...read.content, name: "Broken platter care" },
      },
      actor,
    );
    const saved = await saveVersion.run(
      { recipeId: original.recipe.id, expectedRevision: updated.revision },
      actor,
    );
    expect(saved.version).toBe(2);
    expect(await getDraft.run({ versionId: original.draft.id }, actor)).toEqual(
      {
        ...original,
        recipe: { ...original.recipe, name: "Broken platter care" },
      },
    );
    const rows = await db.select().from(tables.recipeDrafts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.versionId).toBe(original.draft.id);
    expect(rows[0]?.evidence.studio?.baseVersionId).toBe(saved.id);
    expect(rows[0]?.evidence.studio?.revision).toBe(2);
    const forbidden = await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_name = 'recipe_studio_drafts'`,
    );
    expect((forbidden as unknown as { rows: unknown[] }).rows).toEqual([]);
    await seedShop(db);
    const afterReset = await getDraft.run(
      { recipeId: original.recipe.id },
      actor,
    );
    expect(afterReset).toMatchObject({
      revision: 2,
      content: { name: "Broken platter care" },
    });
    await seedShop(db, { all: true });
    expect(
      await getDraft.run({ versionId: original.draft.id }, actor),
    ).toBeNull();
  });
  it("reports actual run counts/results across versions using persisted run actions", async () => {
    // Dry-run handoff uses no shop mutations or model; it is a real executor action.
    const version = {
      ...whereIsMyOrderFixture,
      steps: [
        {
          id: "handoff",
          kind: "handoff" as const,
          to: "human" as const,
          note: { mode: "fixed" as const, value: "Review" },
        },
      ],
    };
    const cases = composition.createRecipeUseCases(db);
    vi.spyOn(composition, "getRecipeUseCases").mockReturnValue(cases);
    const run = await runRecipe.run(
      {
        recipe: { ...version, id: "ver_stats", version: 2 },
        trigger: {},
        dryRun: true,
      },
      context,
    );
    expect(
      (await listRecipes.run({}, context)).find(
        (row) => row.id === version.recipeId,
      ),
    ).toMatchObject({ version: 2, runs: 1, lastResult: run.status });
    const [checkpoint] = await db
      .select({ version: tables.recipeRuns.recipeVersionId })
      .from(tables.recipeRuns);
    expect(checkpoint?.version).toBe("ver_stats");
  });
});
