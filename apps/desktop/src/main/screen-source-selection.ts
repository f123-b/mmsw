export interface ScreenSourceLike {
  id: string;
  display_id?: string;
}

export function selectPrimaryScreenSource<T extends ScreenSourceLike>(
  sources: readonly T[],
  primaryDisplayId: number | string
): T | undefined {
  const wantedId = String(primaryDisplayId);
  return sources.find((source) => String(source.display_id ?? "") === wantedId) ?? sources[0];
}
