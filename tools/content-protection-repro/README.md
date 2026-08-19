# Windows content-protection minimal repro

This isolates two compositor cases from the Interview Copilot overlay:

1. A normal opaque magenta window.
2. A transparent, borderless, always-on-top magenta window.

Run the control and protected experiments from the repository root in a visible Windows session:

```powershell
$electron = "node_modules/electron/dist/electron.exe"
& $electron tools/content-protection-repro
& $electron tools/content-protection-repro --protected
```

The independent `tools/capture-helper` process writes `display-control.png` and `display-protected.png` plus JSON diagnostics. A control run that does not contain the magenta ROI is invalid and must be recorded as FAIL/ENV_UNSUPPORTED; it is never treated as a protected PASS. This repro does not inject into Tencent Meeting or alter the production overlay.
