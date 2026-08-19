# Capture Protection Test Report

- Platform: win32
- Windows version: Windows 11 Home China
- Capture path: WINDOW_CAPTURE
- BrowserWindow.setContentProtection API: SUCCESS
- Overlay local view remains visible: PASS
- Control capture with protection OFF: PASS
- Protected capture with protection ON: FAIL

Result: FAIL (the selected capture path still contains the marker while protection is enabled).