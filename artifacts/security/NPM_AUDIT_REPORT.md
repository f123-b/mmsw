# NPM AUDIT REPORT

Audit date: 2026-08-20

## Commands

- `npm audit --json`: PASS
- `npm audit --omit=dev --json`: PASS
- `npm audit fix --force`: NOT RUN

## Summary

Both audits reported zero vulnerabilities: 0 info, 0 low, 0 moderate, 0 high, and 0 critical.

| Package | Severity | Direct/transitive | Runtime/dev | Dependency path | Affected | Patched | Exploit status | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| None | None | None | None | None | None | None | No known audit finding | No action required |

## Runtime gate

`npm audit --omit=dev --audit-level=high` is clean. Runtime high vulnerabilities: 0. Runtime critical vulnerabilities: 0.

## Reproducibility

The audit was run against the committed lockfile after upgrading the Electron development/package toolchain to `43.4.1`. No remaining advisories require a forced upgrade.
