# 有招 0.1.15 Design QA

## Source visual truth

- Reference: `C:/Users/lenovo/AppData/Local/Temp/codex-clipboard-fbf4aeda-e9e6-4696-b94b-be9f864cb8ec.png`
- Icon source: `D:/面试记录/页面ui/ChatGPT Image 2026年9月5日 00_04_14.png`
- Target: iOS/macOS liquid-glass desktop shell with an ice-blue atmosphere, translucent left rail, glass hero, restrained blue accent, and four functional cards.

## Final implementation evidence

- Desktop capture: `D:/电脑面试/artifacts/ui/youzhao-0.1.14-final.png` (visual design unchanged in 0.1.15)
- Installer: `D:/电脑面试/apps/desktop/release/有招 Setup 0.1.15.exe`
- Product executable: `D:/电脑面试/apps/desktop/release/win-unpacked/有招.exe`

## Side-by-side judgment

- Brand: visible product name is now “有招”; the supplied glass waveform image is used for the installed app icon, sidebar brand, and hero artwork.
- Layout: the desktop shell follows the reference hierarchy—frosted left rail, dominant glass hero, primary action group, and four capability cards. The layout responsively collapses at narrower widths.
- Materials: sidebar, toolbar, forms, cards, dialogs, and content panels share translucent white surfaces, high-key borders, soft inner highlights, background blur, and blue-tinted shadows.
- Typography: large dark headline, blue-to-violet emphasis, muted secondary copy, and compact navigation hierarchy match the reference direction.
- Color: blue remains the only primary interaction color; purple, green, and orange are limited to small capability-card icon states.
- Product flow: existing interview, written-test, profile, project, knowledge, history, help, and settings routes remain functional and inherit the new shell.
- Responsive behavior: the welcome composer is hidden until a conversation starts, preserving the reference landing composition and returning the full height to the hero/cards.
- Window chrome: the Windows title bar and outer padding are removed; the rounded glass shell is the visible window edge. The red, yellow, and green controls invoke close, minimize, and maximize/restore respectively.
- Drag stability: a continuous 38 px drag strip spans the safe top area, while traffic lights, navigation, inputs, and buttons are explicitly excluded from dragging to prevent missed drags and accidental closes.
- Transparent-window stability: maximize uses the active display work area and a saved restore rectangle instead of Electron's unreliable native maximize path for transparent Windows windows.
- Icon: the second supplied RGBA artwork replaces the previous opaque source in the renderer, executable, and installer icon set.

## Verification

- TypeScript: passed.
- Unit/integration tests: 85 files passed, 448 tests passed, 2 intentionally skipped.
- Production build: passed.
- Windows NSIS packaging: passed.
- Packaged-window control smoke: passed; drag strip is active, traffic lights are non-draggable, and maximize, restore, minimize, and close all returned the expected state.
- Packaged-resource verification: passed; required binaries, VAD model, classifier resources, and renderer output are present; no user database, secrets, or logs are bundled.
- Actual Windows desktop capture inspected against the supplied reference; no blocking clipping, overlap, contrast, or asset failures remain.

final result: passed
