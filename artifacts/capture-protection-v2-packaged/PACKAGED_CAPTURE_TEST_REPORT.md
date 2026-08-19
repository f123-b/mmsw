# Capture Protection v2 Test Report

FINAL COMMIT: pending
WINDOWS VERSION: Windows 11 Home China
ELECTRON VERSION: 37.2.0
CAPTURE PROTECTION API: PASS
PASS/FAIL: PASS
isContentProtected: PASS
LOCAL OVERLAY: PASS
INDEPENDENT CAPTURE HELPER: PASS
WINDOW CAPTURE CONTROL OFF: PASS
WINDOW CAPTURE PROTECTED ON: PASS
DISPLAY CAPTURE CONTROL OFF: FAIL
DISPLAY CAPTURE PROTECTED ON: FAIL
INTERNAL SCREENSHOT: PASS
PASSIVE MODE: PASS
INTERACTIVE MODE: PASS
PACKAGED APP: PASS
npm test: PASS (separate validation)
typecheck: PASS (separate validation)
build: PASS
capture-protection:smoke: FAIL
package:win: PASS (installer/unpacked package verified separately)
CI: pending
Run ID: pending
TENCENT MEETING DESKTOP SHARE: REAL_REMOTE_VALIDATION_PENDING
TENCENT MEETING WINDOW SHARE: REAL_REMOTE_VALIDATION_PENDING
KNOWN LIMITATIONS: The independent Windows Graphics Capture display image did not contain the OFF control marker; display result is FAIL.
ARTIFACTS: D:\电脑面试\artifacts\capture-protection-v2-packaged

Result: FAIL (the selected independent capture path did not satisfy the OFF control and ON protected experiment).
