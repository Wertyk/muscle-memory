import { parseRecipeVersion, type ActiveRecipeSource, type Recipe, type RecipeVersion } from "@muscle-memory/recipe-engine";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ShopDb } from "../db/index.js";
import { recipes, recipeVersions } from "../db/schema.js";

const identifier = z.string().max(31).regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
const catalogSchema = z.object({
  id: identifier, name: z.string().trim().min(1).max(300), status: z.enum(["draft", "active"]),
  activeVersionId: identifier.nullable(),
}).strict().refine((entry) => (entry.status === "active") === (entry.activeVersionId !== null));

type VersionConnection = Pick<ShopDb, "insert" | "select">;
/** Shared by catalog writes and ad hoc executor snapshots. Never updates a version. */
export async function persistRecipeVersion(db: VersionConnection, input: RecipeVersion): Promise<void> {
  const recipe = parseRecipeVersion(input);
  await db.insert(recipeVersions).values({ id: recipe.id, recipeId: recipe.recipeId, version: recipe.version, snapshot: recipe }).onConflictDoNothing();
  const [row] = await db.select({ id: recipeVersions.id }).from(recipeVersions).where(and(
    eq(recipeVersions.id, recipe.id), eq(recipeVersions.snapshot, recipe),
  ));
  if (!row) throw new Error("Recipe version identity or number already has a different snapshot.");
}

/** Small catalog surface for later drafting/editing/activation use-cases. */
export class DrizzleRecipeCatalog implements ActiveRecipeSource {
  constructor(private readonly db: ShopDb) {}
  saveVersion(version: RecipeVersion): Promise<void> { return persistRecipeVersion(this.db, version); }
  async save(entry: Recipe): Promise<void> {
    const value = catalogSchema.parse(entry);
    // Composite foreign key enforces ownership even under concurrent writes.
    await this.db.insert(recipes).values(value).onConflictDoUpdate({ target: recipes.id, set: value });
  }
  async get(id: string): Promise<Recipe | null> {
    const [row] = await this.db.select().from(recipes).where(eq(recipes.id, id));
    return row ? catalogSchema.parse(row) : null;
  }
  async listActive(): Promise<readonly RecipeVersion[]> {
    const rows = await this.db.select({ snapshot: recipeVersions.snapshot }).from(recipes)
      .innerJoin(recipeVersions, and(eq(recipes.activeVersionId, recipeVersions.id), eq(recipes.id, recipeVersions.recipeId)))
      .where(eq(recipes.status, "active")).orderBy(asc(recipes.id));
    return rows.map((row) => parseRecipeVersion(row.snapshot));
  }
}
