export const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`;
export const recipeVersionPath = (recipeId: string, versionId: string) =>
  `/recipes/${encodeURIComponent(recipeId)}?version=${encodeURIComponent(versionId)}`;
export function runIdFromPath(path: string): string | undefined {
  const encoded = path.match(/^\/runs\/([^/]+)\/?$/)?.[1];
  try {
    return encoded ? decodeURIComponent(encoded) : undefined;
  } catch {
    return undefined;
  }
}
export function durationText(ms: number) {
  return ms < 1000
    ? `${Math.round(ms)} ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(2)} s`
      : `${(ms / 60_000).toFixed(1)} min`;
}
