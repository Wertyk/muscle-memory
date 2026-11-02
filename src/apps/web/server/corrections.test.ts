import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { resourceGetByPath, SHARED_OWNER } from "@agent-native/core/resources";
import { loadActionsFromStaticRegistry } from "@agent-native/core/server";
import { recipeContent } from "@muscle-memory/recipe-engine";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import getOrder from "../actions/get-order.js";
import sendReply from "../actions/send-reply.js";
import issueRefund from "../actions/issue-refund.js";
import tagRequest from "../actions/tag-request.js";
import getRequest from "../actions/get-request.js";
import getRun from "../actions/get-recipe-run.js";
import getRecipe from "../actions/get-recipe.js";
import updateDraft from "../actions/update-recipe-draft.js";
import saveVersion from "../actions/save-recipe-version.js";
import activate from "../actions/activate-recipe.js";
import decide from "../actions/record-correction-decision.js";
import { createRequestIntake, createRecipeUseCases } from "./composition.js";
import { getDb, type ShopDb } from "./db/index.js";
import * as tables from "./db/schema.js";
import { damagedItemFixture } from "./fixtures/intake-recipes.js";
import { RegistryActionInvoker } from "./infra/registry-action-invoker.js";
import { ResourceSkillRegistry } from "./infra/resource-skill-registry.js";
import { seedShop, resetShop } from "./infra/shop-demo-store.js";
import * as session from "./infra/teach-session.js";
import { studioContentInput } from "./studio-action-contracts.js";
import migrateApp from "./plugins/db.js";

const context = { caller: "frontend" as const, userEmail: "operator@example.test" };
const recipeId = damagedItemFixture.recipeId;
const notes = { description: "Keep the damaged piece", trigger: "Damaged purchased items", resolutions: [{ ambiguity: "Return policy", resolution: "Add a reusable no-return sentence to the reply template." }] };

describe("correction → Studio proposal → decision, real actions and PGlite", () => {
  let directory: string;
  let db: ShopDb;
  let sequence = 0;
  const registry = new RegistryActionInvoker(async () => loadActionsFromStaticRegistry({
    "get-order": { default: getOrder }, "issue-refund": { default: issueRefund },
    "send-reply": { default: sendReply }, "tag-request": { default: tagRequest },
  }));
  const options = () => ({ context, registry, ids: { next: () => `run_correction${++sequence}` }, extractor: { extract: vi.fn(async () => { throw new Error("No model in tests"); }) } });
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "mm-corrections-"));
    vi.stubEnv("DATABASE_URL", `pglite:${directory}`);
    await withMigrationRuntime(async () => { await migrateApp(undefined); });
    db = getDb();
  }, 30_000);
  beforeEach(async () => { await seedShop(db, { all: true }); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await closeDbExec(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

  async function corrected() {
    const intake = createRequestIntake(db, options());
    await intake.catalog.saveVersion(damagedItemFixture);
    await intake.catalog.save({ id: recipeId, name: damagedItemFixture.name, status: "active", activeVersionId: damagedItemFixture.id });
    const request = await intake.intake.create({ customerId: "cus_0016", subject: "Damaged piece", content: { source: "structured", fields: { type: "damaged_item", orderId: "ord_1016", productId: "prd_0002", quantity: 1, description: "Chipped" } } });
    const [processing] = await intake.processing.list([request.id]);
    expect(processing?.state).toBe("auto_handled");
    expect(await db.select().from(tables.recipeCorrections)).toEqual([]);
    vi.spyOn(session, "teachNavigation").mockResolvedValue({ view: "request", requestId: request.id });
    const reply = await sendReply.run({ requestId: request.id, template: "Please keep the piece; no return needed.", variables: {} }, context);
    const [row] = await db.select().from(tables.recipeCorrections);
    expect(row?.snapshot).toMatchObject({ requestId: request.id, runId: processing!.runId, recipe: { id: damagedItemFixture.id, version: 1 }, stepId: "reply", input: { template: reply.template }, status: "recorded" });
    expect((await getRequest.run({ requestId: request.id }, context)) as any).toMatchObject({ corrections: [{ id: row!.id }] });
    expect(await getRun.run({ runId: processing!.runId }, context)).toMatchObject({ corrections: [{ id: row!.id }] });
    expect(await getRun.run({ runId: processing!.runId }, { ...context, userEmail: "other@example.test" })).not.toHaveProperty("corrections");
    return { correction: row!.snapshot, request, intake };
  }
  async function propose(id: string) {
    const content = structuredClone(recipeContent(damagedItemFixture));
    const steps = content.steps as any[];
    steps[1].then[1].args.template.value += " Please keep the piece; no return needed.";
    const draft = await updateDraft.run({ recipeId, expectedRevision: 0, content }, context);
    const saved = await saveVersion.run({ recipeId, expectedRevision: draft.revision, correctionId: id, proposal: notes }, context);
    expect(saved.version).toBe(2);
    const detail = await getRecipe.run({ recipeId }, context);
    expect(detail.recipe.activeVersionId).toBe(damagedItemFixture.id);
    expect(detail.history[1]?.diff.length).toBeGreaterThan(0);
    expect(detail.corrections[0]).toMatchObject({ id, status: "proposed", proposal: { version: { id: saved.id }, notes } });
    return saved;
  }
  it("keeps the draft update tool schema representable to the live agent", () => {
    expect(z.toJSONSchema(studioContentInput, { io: "input" }).type).toBe("object");
    expect(studioContentInput.safeParse({ name: "Valid JSON", trigger: {}, steps: [] }).success).toBe(true);
  });
  it.each(["accept", "reject"])("persists %s and retains pinned run effects/history after reload", async choice => {
    const { correction, intake } = await corrected();
    const saved = await propose(correction.id);
    if (choice === "accept") {
      await activate.run({ recipeId, versionId: saved.id }, context);
      expect((await intake.catalog.listActive())[0]?.id).toBe(saved.id);
      await expect(decide.run({ correctionId: correction.id, decision: "rejected", reason: "Too late" }, context)).rejects.toThrow(/pending/);
    } else {
      await decide.run({ correctionId: correction.id, decision: "rejected", reason: "Keep current policy" }, context);
      await expect(activate.run({ recipeId, versionId: saved.id }, context)).rejects.toThrow(/rejected/);
      expect((await intake.catalog.listActive())[0]?.id).toBe(damagedItemFixture.id);
    }
    const persisted = (await db.select().from(tables.recipeCorrections))[0]!.snapshot;
    expect(persisted.status).toBe(choice === "accept" ? "accepted" : "rejected");
    expect(persisted.decision?.reason).toBe(choice === "accept" ? null : "Keep current policy");
    const [run] = await db.select().from(tables.recipeRuns);
    expect(run?.recipeVersionId).toBe(damagedItemFixture.id);
    expect(run?.checkpoint.recipe.version).toBe(1);
    await expect(saveVersion.run({ recipeId, expectedRevision: 2, correctionId: correction.id, proposal: notes }, context)).rejects.toThrow(/already/);
    expect(await db.select().from(tables.recipeVersions)).toHaveLength(2);
    await seedShop(db);
    expect(await db.select().from(tables.recipeCorrections)).toEqual([]);
    expect(await db.select().from(tables.recipeVersions)).toHaveLength(2);
    await resetShop(db, { all: true });
    expect(await db.select().from(tables.recipeVersions)).toEqual([]);
  });
  it("accepts a correction proposal and publishes its runtime skill after commit", async () => {
    const { correction } = await corrected();
    const saved = await propose(correction.id);
    const acceptanceAtPublication: string[] = [];
    const put = ResourceSkillRegistry.prototype.put;
    vi.spyOn(ResourceSkillRegistry.prototype, "put").mockImplementation(async function (this: ResourceSkillRegistry, ...args) {
      acceptanceAtPublication.push((await getDb().select().from(tables.recipeCorrections))[0]!.snapshot.status);
      return put.apply(this, args);
    });
    expect(await activate.run({ recipeId, versionId: saved.id }, context)).toMatchObject({
      activeVersionId: saved.id, skillPublication: { status: "published", versionId: saved.id, retryable: false },
    });
    expect(acceptanceAtPublication).toEqual(["accepted"]);
    expect((await db.select().from(tables.recipeCorrections))[0]?.snapshot).toMatchObject({
      id: correction.id, status: "accepted", proposal: { version: { id: saved.id } }, decision: { by: { userId: context.userEmail } },
    });
    const name = `recipe-${Array.from(recipeId, char => char.charCodeAt(0).toString(16)).join("")}`;
    const skill = await resourceGetByPath(SHARED_OWNER, `skills/${name}/SKILL.md`);
    expect(skill?.content).toContain(saved.id);
    expect((await getRecipe.run({ recipeId }, context)).skillPublication).toMatchObject({ status: "published", versionId: saved.id });
  });
  it("maps additional refunds/tags, rejects unrelated targets/agent/recipe calls and captures only successful effects", async () => {
    const { request } = await corrected();
    await issueRefund.run({ orderId: "ord_1016", reason: "Additional compensation", amount: { amountMinor: 100, currency: "USD" } }, context);
    await tagRequest.run({ requestId: request.id, tag: "care-followup" }, context);
    await tagRequest.run({ requestId: request.id, tag: "  care-followup  " }, context);
    expect((await db.select().from(tables.recipeCorrections)).map(row => row.snapshot.stepId).sort()).toEqual(["refund", "reply", "tag"]);
    await expect(issueRefund.run({ orderId: "ord_1016", reason: "Invalid", amount: { amountMinor: 99999999, currency: "USD" } }, context)).rejects.toThrow();
    await sendReply.run({ requestId: request.id, template: "Agent reply", variables: {} }, { ...context, caller: "tool" });
    await sendReply.run({ requestId: request.id, template: "Recipe reply", variables: {} }, { ...context, runId: "run_nested", toolCallId: "run_nested:reply" });
    await tagRequest.run({ requestId: "req_0001", tag: "another-request" }, context);
    await issueRefund.run({ orderId: "ord_1001", reason: "Another order", amount: { amountMinor: 1, currency: "USD" } }, context);
    expect(await db.select().from(tables.recipeCorrections)).toHaveLength(3);
  });
  it("rolls back immutable proposal saving if correction linkage is invalid", async () => {
    const { correction } = await corrected();
    const invalid = { ...correction, recipe: { ...correction.recipe, recipeId: "other_recipe" } };
    await db.update(tables.recipeCorrections).set({ snapshot: invalid }).where(eq(tables.recipeCorrections.id, correction.id));
    await expect(propose(correction.id)).rejects.toThrow(/new version/);
    expect(await db.select().from(tables.recipeVersions)).toHaveLength(1);
    expect((await db.select().from(tables.recipeCorrections))[0]?.snapshot.status).toBe("recorded");
  });
  it("does not attribute an operation to an older automatic run after a newer run starts", async () => {
    const { request } = await corrected();
    await createRecipeUseCases(db, options()).runRecipe.execute({ recipe: damagedItemFixture, trigger: { requestId: request.id, orderId: request.orderId }, mode: "dry-run" });
    await sendReply.run({ requestId: request.id, template: "After a newer dry run", variables: {} }, context);
    expect(await db.select().from(tables.recipeCorrections)).toHaveLength(1);
  });
});
