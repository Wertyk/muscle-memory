import {
  RecipeStudioError,
  recipeContent,
  parseRecipeVersion,
  type ActiveRecipeSource,
  type DemonstrationOwner,
  type Recipe,
  type RecipeDraft,
  type RecipeRepository,
  type RecipeVersion,
  type StudioDraft,
  type JsonValue,
} from "@muscle-memory/recipe-engine";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { ShopDb } from "../db/index.js";
import { recipeDrafts, recipes, recipeVersions } from "../db/schema.js";

const identifier = z
  .string()
  .max(31)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
const catalogSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(300),
    status: z.enum(["draft", "active"]),
    activeVersionId: identifier.nullable(),
  })
  .strict()
  .refine(
    (entry) => (entry.status === "active") === (entry.activeVersionId !== null),
  );

type VersionConnection = Pick<ShopDb, "insert" | "select">;
/** Shared by catalog writes and ad hoc executor snapshots. Never updates a version. */
export async function persistRecipeVersion(
  db: VersionConnection,
  input: RecipeVersion,
): Promise<void> {
  const recipe = parseRecipeVersion(input);
  await db
    .insert(recipeVersions)
    .values({
      id: recipe.id,
      recipeId: recipe.recipeId,
      version: recipe.version,
      snapshot: recipe,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: recipeVersions.id })
    .from(recipeVersions)
    .where(
      and(
        eq(recipeVersions.id, recipe.id),
        eq(recipeVersions.snapshot, recipe),
      ),
    );
  if (!row)
    throw new Error(
      "Recipe version identity or number already has a different snapshot.",
    );
}

/** Small catalog surface for later drafting/editing/activation use-cases. */
export class DrizzleRecipeCatalog
  implements ActiveRecipeSource, RecipeRepository
{
  constructor(private readonly db: ShopDb) {}
  async createDraft(
    owner: DemonstrationOwner,
    result: RecipeDraft,
  ): Promise<void> {
    const draft = parseRecipeVersion(result.draft);
    const entry = catalogSchema.parse(result.recipe);
    if (
      entry.status !== "draft" ||
      entry.activeVersionId !== null ||
      entry.id !== draft.recipeId
    )
      throw new Error("Expected new draft metadata.");
    await this.db.transaction(async (tx) => {
      // Plain inserts deliberately reject collisions; no existing recipe can be demoted.
      await tx
        .insert(recipeVersions)
        .values({
          id: draft.id,
          recipeId: draft.recipeId,
          version: draft.version,
          snapshot: draft,
        });
      await tx.insert(recipes).values(entry);
      await tx
        .insert(recipeDrafts)
        .values({
          versionId: draft.id,
          ownerEmail: owner.userId,
          workspaceId: owner.workspaceId,
          evidence: {
            demonstrationId: result.demonstrationId,
            ambiguities: result.ambiguities,
          },
        });
    });
  }
  async getDraft(
    owner: DemonstrationOwner,
    versionId: string,
  ): Promise<RecipeDraft | null> {
    const [row] = await this.db
      .select({
        evidence: recipeDrafts.evidence,
        snapshot: recipeVersions.snapshot,
        recipe: {
          id: recipes.id,
          name: recipes.name,
          status: recipes.status,
          activeVersionId: recipes.activeVersionId,
        },
      })
      .from(recipeDrafts)
      .innerJoin(recipeVersions, eq(recipeDrafts.versionId, recipeVersions.id))
      .innerJoin(recipes, eq(recipeVersions.recipeId, recipes.id))
      .where(
        and(
          eq(recipeDrafts.versionId, versionId),
          eq(recipeDrafts.ownerEmail, owner.userId),
          eq(recipeDrafts.workspaceId, owner.workspaceId),
        ),
      );
    // Studio-only edits of catalog fixtures have no demonstration provenance.
    // Preserve the original TASK-11 response exactly; do not leak editor metadata.
    return row?.evidence.demonstrationId
      ? structuredClone({
          demonstrationId: row.evidence.demonstrationId,
          ambiguities: row.evidence.ambiguities,
          recipe: catalogSchema.parse(row.recipe),
          draft: parseRecipeVersion(row.snapshot),
        })
      : null;
  }
  private async studioRow(owner: DemonstrationOwner, recipeId: string) {
    const [row] = await this.db
      .select({
        versionId: recipeDrafts.versionId,
        evidence: recipeDrafts.evidence,
      })
      .from(recipeDrafts)
      .innerJoin(recipeVersions, eq(recipeDrafts.versionId, recipeVersions.id))
      .where(
        and(
          eq(recipeVersions.recipeId, recipeId),
          eq(recipeDrafts.ownerEmail, owner.userId),
          eq(recipeDrafts.workspaceId, owner.workspaceId),
        ),
      )
      .orderBy(desc(recipeVersions.version))
      .limit(1);
    return row;
  }
  async getStudioDraft(
    owner: DemonstrationOwner,
    recipeId: string,
  ): Promise<StudioDraft | null> {
    const row = await this.studioRow(owner, recipeId);
    if (!row) return null;
    const [latest] = await this.db
      .select({ snapshot: recipeVersions.snapshot })
      .from(recipeVersions)
      .where(eq(recipeVersions.recipeId, recipeId))
      .orderBy(desc(recipeVersions.version))
      .limit(1);
    if (!latest) return null;
    return structuredClone({
      recipeId,
      revision: row.evidence.studio?.revision ?? 0,
      baseVersionId: row.evidence.studio?.baseVersionId ?? latest.snapshot.id,
      content: row.evidence.studio?.content ?? recipeContent(latest.snapshot),
      ambiguities: row.evidence.ambiguities as unknown as readonly JsonValue[],
    });
  }
  /** Called under RecipeStudioStore's DB-only transaction/locks. Original
   * demonstrationId and ambiguity evidence are preserved in the canonical row. */
  async saveStudioDraft(
    owner: DemonstrationOwner,
    draft: StudioDraft,
  ): Promise<void> {
    const row = await this.studioRow(owner, draft.recipeId);
    const studio = {
      revision: draft.revision,
      baseVersionId: draft.baseVersionId,
      content: draft.content,
    };
    if (row) {
      await this.db
        .update(recipeDrafts)
        .set({ evidence: { ...row.evidence, studio } })
        .where(
          and(
            eq(recipeDrafts.versionId, row.versionId),
            eq(recipeDrafts.ownerEmail, owner.userId),
            eq(recipeDrafts.workspaceId, owner.workspaceId),
          ),
        );
      return;
    }
    // Catalog fixtures/ad hoc versions can be edited without inventing a demo.
    const [anchor] = await this.db
      .select({ id: recipeVersions.id })
      .from(recipeVersions)
      .where(
        and(
          eq(recipeVersions.recipeId, draft.recipeId),
          eq(recipeVersions.id, draft.baseVersionId ?? ""),
        ),
      )
      .limit(1);
    if (!anchor)
      throw new RecipeStudioError(
        "NOT_FOUND",
        "A saved recipe version is required before editing this draft.",
      );
    const [occupied] = await this.db
      .select({ id: recipeDrafts.versionId })
      .from(recipeDrafts)
      .where(eq(recipeDrafts.versionId, anchor.id));
    if (occupied)
      throw new RecipeStudioError(
        "CONFLICT",
        "This version belongs to another operator's draft.",
      );
    await this.db
      .insert(recipeDrafts)
      .values({
        versionId: anchor.id,
        ownerEmail: owner.userId,
        workspaceId: owner.workspaceId,
        evidence: { ambiguities: [], studio },
      });
  }
  saveVersion(version: RecipeVersion): Promise<void> {
    return persistRecipeVersion(this.db, version);
  }
  async save(entry: Recipe): Promise<void> {
    const value = catalogSchema.parse(entry);
    // Composite foreign key enforces ownership even under concurrent writes.
    await this.db
      .insert(recipes)
      .values(value)
      .onConflictDoUpdate({ target: recipes.id, set: value });
  }
  async get(id: string): Promise<Recipe | null> {
    const [row] = await this.db
      .select()
      .from(recipes)
      .where(eq(recipes.id, id));
    return row ? catalogSchema.parse(row) : null;
  }
  async listActive(): Promise<readonly RecipeVersion[]> {
    const rows = await this.db
      .select({ snapshot: recipeVersions.snapshot })
      .from(recipes)
      .innerJoin(
        recipeVersions,
        and(
          eq(recipes.activeVersionId, recipeVersions.id),
          eq(recipes.id, recipeVersions.recipeId),
        ),
      )
      .where(eq(recipes.status, "active"))
      .orderBy(asc(recipes.id));
    return rows.map((row) => parseRecipeVersion(row.snapshot));
  }
}
