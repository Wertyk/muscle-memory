---
name: recipe-studio
description: Inspect recipe binding sources, edit drafts, save immutable versions, and activate or deactivate catalog recipes with the same actions as Recipe Studio.
scope: runtime
metadata:
  internal: true
---

# Recipe Studio

Read `view-screen` for the selected recipe. `navigate({view:"recipes"})` opens
`/recipes`; `navigate({view:"recipe",recipeId})` opens a recipe. Do not write the
UI-owned navigation key. The Backtest slot is reserved for TASK-18.

1. `list-recipes({})` returns status, latest saved version, runs and last result.
   `get-recipe({recipeId})` returns metadata and immutable history/diffs.
2. `get-recipe-draft({recipeId})` returns editable `content: {name,trigger,steps}`,
   `revision`, `baseVersionId`, original scoped ambiguity entries and `issues`.
   TASK-11's `get-recipe-draft({versionId})` remains the original immutable draft
   read (null for absent/unowned review evidence). Preserve its version ID.
3. Edit a detached copy of content, then call
   `update-recipe-draft({recipeId,expectedRevision:revision,content})`.
   Bindings: `fixed.value`, `path.path`, `expr.expr` (safe JSONLogic),
   `template.template` with `{{trigger.field}}` / `{{steps.id.output.field}}`.
   Steps: action/extract/branch/handoff; each may have an `approval` expression.
   A false approval never pauses. Trigger matches reference only trigger fields.
4. Review returned issues and ambiguities; fix invalid references/operators and
   templates. Original ambiguity evidence remains available after edits and is
   never silently marked resolved. The UI shows the same issues inline.
5. `save-recipe-version({recipeId,expectedRevision})` creates a NEW immutable
   version; it never activates or overwrites one. Read back on uncertain failure;
   the revision increments on a successful save, so stale retries fail closed.
6. Review the history diff, then `activate-recipe({recipeId,versionId})` explicitly
   selects that saved version for future intake. Invalid snapshots cannot activate.
   `deactivate-recipe({recipeId})` clears the active pointer, retaining history/runs.

Draft edits never execute shop actions or invoke a model. Money uses integer
minor units; USD 100 is 10000. References may use only earlier unconditional
outputs/ancestors. Do not add operators: the engine owns its allowlist. A conflict
can mean a stale revision or another operator’s owned draft; read the reason and
the latest permitted state before reapplying. Studio edits and original provenance
use the canonical recipe_drafts row, under the same owner/workspace scope.
