import type { OverlayPreferences, OverlayPreferencesPatch } from "../../shared/overlay-preferences";

export interface OverlayPreferencesDraftState {
  draft: OverlayPreferences;
  pendingPreviewPatch: OverlayPreferencesPatch;
  dirtyPersistPatch: OverlayPreferencesPatch;
}

export function mergeOverlayPreferencePatches(base: OverlayPreferencesPatch, next: OverlayPreferencesPatch): OverlayPreferencesPatch {
  const merged = { ...base, ...next } as OverlayPreferencesPatch;
  const interview = { ...(base.interview ?? {}), ...(next.interview ?? {}) };
  const writtenTest = { ...(base.writtenTest ?? {}), ...(next.writtenTest ?? {}) };
  for (const key of ["questionWindow", "dialogueWindow", "answerWindow", "scriptWindow", "controlBar"] as const) {
    const left = base.interview?.[key];
    const right = next.interview?.[key];
    if (left || right) interview[key] = { ...(left ?? {}), ...(right ?? {}) } as never;
  }
  for (const key of ["questionWindow", "answerWindow", "controlBar"] as const) {
    const left = base.writtenTest?.[key];
    const right = next.writtenTest?.[key];
    if (left || right) writtenTest[key] = { ...(left ?? {}), ...(right ?? {}) } as never;
  }
  if (base.interview || next.interview) merged.interview = interview;
  if (base.writtenTest || next.writtenTest) merged.writtenTest = writtenTest;
  if (base.behavior || next.behavior) merged.behavior = { ...(base.behavior ?? {}), ...(next.behavior ?? {}) };
  if (base.appearance || next.appearance) merged.appearance = { ...(base.appearance ?? {}), ...(next.appearance ?? {}) };
  if (base.screenshot || next.screenshot) merged.screenshot = { ...(base.screenshot ?? {}), ...(next.screenshot ?? {}) };
  return merged;
}

function mergeDraft(current: OverlayPreferences, patch: OverlayPreferencesPatch): OverlayPreferences {
  const interviewPatch = patch.interview ?? {};
  const writtenPatch = patch.writtenTest ?? {};
  return {
    ...current,
    ...patch,
    interview: {
      ...current.interview,
      ...interviewPatch,
      questionWindow: { ...current.interview.questionWindow, ...(interviewPatch.questionWindow ?? {}) },
      dialogueWindow: { ...current.interview.dialogueWindow, ...(interviewPatch.dialogueWindow ?? {}) },
      answerWindow: { ...current.interview.answerWindow, ...(interviewPatch.answerWindow ?? {}) },
      scriptWindow: { ...current.interview.scriptWindow, ...(interviewPatch.scriptWindow ?? {}) },
      controlBar: { ...current.interview.controlBar, ...(interviewPatch.controlBar ?? {}) }
    },
    writtenTest: {
      ...current.writtenTest,
      ...writtenPatch,
      questionWindow: { ...current.writtenTest.questionWindow, ...(writtenPatch.questionWindow ?? {}) },
      answerWindow: { ...current.writtenTest.answerWindow, ...(writtenPatch.answerWindow ?? {}) },
      controlBar: { ...current.writtenTest.controlBar, ...(writtenPatch.controlBar ?? {}) }
    },
    behavior: { ...current.behavior, ...(patch.behavior ?? {}) },
    appearance: { ...current.appearance, ...(patch.appearance ?? {}) },
    screenshot: { ...current.screenshot, ...(patch.screenshot ?? {}) }
  } as OverlayPreferences;
}

export function createOverlayPreferencesDraftState(value: OverlayPreferences): OverlayPreferencesDraftState {
  return { draft: value, pendingPreviewPatch: {}, dirtyPersistPatch: {} };
}

export function applyOverlayPreferencesDraftPatch(state: OverlayPreferencesDraftState, patch: OverlayPreferencesPatch, preview: boolean): void {
  if (Object.keys(patch).length === 0) return;
  state.draft = mergeDraft(state.draft, patch);
  state.dirtyPersistPatch = mergeOverlayPreferencePatches(state.dirtyPersistPatch, patch);
  if (preview) state.pendingPreviewPatch = mergeOverlayPreferencePatches(state.pendingPreviewPatch, patch);
}

export function takeOverlayPreferencesPreviewPatch(state: OverlayPreferencesDraftState): OverlayPreferencesPatch {
  const patch = state.pendingPreviewPatch;
  state.pendingPreviewPatch = {};
  return patch;
}

export function takeOverlayPreferencesPersistPatch(state: OverlayPreferencesDraftState): OverlayPreferencesPatch {
  const pending = state.pendingPreviewPatch;
  state.pendingPreviewPatch = {};
  return mergeOverlayPreferencePatches(state.dirtyPersistPatch, pending);
}

export function markOverlayPreferencesPersisted(state: OverlayPreferencesDraftState): void {
  state.dirtyPersistPatch = {};
}

export function syncOverlayPreferencesFromParent(state: OverlayPreferencesDraftState, value: OverlayPreferences): boolean {
  if (Object.keys(state.pendingPreviewPatch).length > 0 || Object.keys(state.dirtyPersistPatch).length > 0) return false;
  state.draft = value;
  return true;
}

export function hasOverlayPreferencesPatch(patch: OverlayPreferencesPatch): boolean {
  return Object.keys(patch).length > 0;
}
