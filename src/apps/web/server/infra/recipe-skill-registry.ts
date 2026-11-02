import type { SkillRegistry, SkillPublication } from "@muscle-memory/recipe-engine";
import { SHARED_OWNER } from "@agent-native/core/resources";
import { eq } from "drizzle-orm";
import type { ShopDb } from "../db/index.js";
import { recipeSkillPublications } from "../db/schema.js";
import { ResourceSkillRegistry } from "./resource-skill-registry.js";
import { assertRunLockActive, withRunLock } from "./run-lock.js";

/** The existing catalog is app-wide, so its generated capabilities are app-shared
 * too. Only trusted composition constructs this adapter for Studio operations. */
export class RecipeSkillRegistry implements SkillRegistry {
  private readonly resources = new ResourceSkillRegistry(SHARED_OWNER);
  constructor(private readonly db: ShopDb) {}
  withLock<T>(recipeId: string, work: () => Promise<T>): Promise<T> {
    return withRunLock(`skill:${recipeId}`, work);
  }
  async put(name: string, description: string, instructions: string): Promise<void> {
    assertRunLockActive();
    await this.resources.put(name, description, instructions);
  }
  async remove(name: string): Promise<void> {
    assertRunLockActive();
    await this.resources.remove(name);
  }
  async record(recipeId: string, publication: SkillPublication): Promise<void> {
    assertRunLockActive();
    await this.db.insert(recipeSkillPublications).values({ recipeId, publication })
      .onConflictDoUpdate({ target: recipeSkillPublications.recipeId, set: { publication } });
  }
  async publication(recipeId: string): Promise<SkillPublication | null> {
    const [row] = await this.db.select().from(recipeSkillPublications).where(eq(recipeSkillPublications.recipeId, recipeId));
    return row ? structuredClone(row.publication) : null;
  }
}
