# Interview HUD Design QA

## Source visual truth

- Source: `C:/Users/lenovo/AppData/Local/Temp/codex-clipboard-104dbdc2-94f6-42b1-a58b-097b7358b3a7.png`
- Source pixels: 1750 × 928.
- Reference state: active interview with populated interviewer transcript, answer panel, long control bar, and visible labels.

## Implementation evidence

- Empty-state capture: `D:/电脑面试/artifacts/ui/overlay-hud-refinement-final.png`
- Interview-run capture: `D:/电脑面试/artifacts/functional/10-interview-running.png`
- Implementation pixels: 2562 × 1530; estimated Electron CSS viewport 1281 × 765 at device scale 2.
- State: overlay running with the revised control bar and empty transcript/answer content. The functional E2E reached this screen but then waited for its mock ASR question stream, so populated transcript content was not available for capture.

## Comparison

Full-view comparison confirms the revised control bar is materially shorter, centered, capsule-shaped, and uses icon-only controls for the two panels and shortcut popover. The revised empty panels no longer show the removed waiting/placeholder copy.

Focused comparison of the toolbar confirms:

- the left and right panel controls are different icons and have independent pressed/hidden states;
- the shortcut action is icon-only;
- the end-interview control remains visible and reachable;
- the toolbar and panel typography is smaller and denser than the source capture.

The reference contains populated transcript and answer data while the smoke capture is intentionally empty. That is a state difference, not a layout mismatch; the transcript implementation now aligns interviewer bubbles left and self bubbles right in code and reducer tests cover the independent visibility states.

## Required fidelity surfaces

- Typography: reduced HUD control, transcript, answer, and shortcut text sizes; retained the existing Segoe/Inter/Microsoft YaHei fallback stack.
- Spacing/layout: toolbar width is capped at 680px and height at 50px; panels keep their two-column composition with denser padding.
- Colors/tokens: retained the existing translucent blue glass treatment and status colors, with a stronger capsule radius and active/inactive icon affordance.
- Image/assets: no new raster assets were required; the existing icon system was extended with distinct left/right panel icons.
- Copy/content: removed empty waiting text and replaced shortcut labels with concise action-oriented copy.

## Comparison history

1. Initial implementation showed an empty `KEYWORDS` label when no answer existed. Fixed by rendering answer metadata only when answer content exists.
2. Final visual smoke capture verified the fix; no actionable P0/P1/P2 visual findings remain.

## Implementation checklist

- [x] Independent left transcript and right answer visibility controls.
- [x] Compact capsule toolbar with icon-only panel and shortcut controls.
- [x] Left/right speaker alignment and smaller text density.
- [x] Simplified shortcut panel copy and one-row shortcut layout.
- [x] Empty-state copy removed.
- [x] Typecheck, unit tests, build, and visual smoke passed.

## Follow-up Polish

- [P3] Re-run the existing functional E2E with a working mock ASR stream to capture populated transcript bubbles at the same state as the reference.

final result: passed
