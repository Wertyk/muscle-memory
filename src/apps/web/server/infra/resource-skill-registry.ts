import {
  resourceDeleteByPath,
  resourceGetByPath,
  resourcePut,
} from "@agent-native/core/resources";

function skillPath(name: string): string {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("Invalid runtime skill name.");
  }
  return `skills/${name}/SKILL.md`;
}

/** Caller supplies an authorized resource owner, e.g. ctx.userEmail.
 * Organization publication must be authorized before constructing this adapter. */
export class ResourceSkillRegistry {
  constructor(private readonly owner: string) {
    if (!owner.trim())
      throw new Error("Runtime skills require a resource owner.");
  }

  async put(
    name: string,
    description: string,
    instructions: string,
  ): Promise<void> {
    const path = skillPath(name);
    if (!description.trim() || !instructions.trim()) {
      throw new Error("Runtime skills require a description and instructions.");
    }
    const content = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nscope: runtime\n---\n\n${instructions}\n`;
    await resourcePut(this.owner, path, content, "text/markdown");
  }

  async read(name: string): Promise<string | null> {
    return (
      (await resourceGetByPath(this.owner, skillPath(name)))?.content ?? null
    );
  }

  async remove(name: string): Promise<void> {
    await resourceDeleteByPath(this.owner, skillPath(name));
  }
}
