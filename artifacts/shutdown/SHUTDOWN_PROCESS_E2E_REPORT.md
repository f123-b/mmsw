# SHUTDOWN PROCESS E2E REPORT

Generated: 2026-08-19T16:57:18.286Z

- no-active: PASS {"processExit":"PASS","sqliteReopen":"PASS","interviews":0}
- active-interview: PASS {"processExit":"PASS","sqliteReopen":"PASS","endedAt":1787158635245,"status":"ended","partialText":"这是已经生成的部分答案","cancelReason":"user"}
- active-chat: PASS {"processExit":"PASS","sqliteReopen":"PASS","messageStatuses":["completed","cancelled"]}
- idempotent-process: PASS {"processExit":"PASS","sqliteReopen":"PASS","interviews":0,"duplicateClose":"PASS"}

- True Electron window-close -> window-all-closed -> app.quit: PASS
- Independent SQLite reopen after process exit: PASS
- SQLite misuse/unhandled rejection scan: PASS
