# Wateray Cursor Rules Index

This file documents the intent, scope, and precedence of rules under `.cursor/rules/`.

## Rule Precedence

When multiple rules apply at the same time, use this order:

1. Architecture/runtime boundary rules (`00`, `05`)
2. Mandatory cleanup rule (`30`)
3. Language/framework rules by file scope (`10`, `12`, `13`, `20`)

If two rules appear to conflict, prefer the stricter runtime-boundary rule and keep logic in the core daemon.

## Rule Catalog

| File | Scope | alwaysApply | Primary Intent |
|---|---|---:|---|
| `00-project-baseline.mdc` | global | true | Project-level boundaries, ownership, and verification baseline |
| `05-runtime-framework.mdc` | global | true | UI/daemon runtime split and source-of-truth boundaries |
| `10-electron-ui.mdc` | `TauriApp/src/renderer/src/**/*.{ts,tsx}` | false | Tauri renderer implementation conventions |
| `12-electron-ui-framework.mdc` | `TauriApp/src/renderer/src/**/*.{ts,tsx,css}` | false | React + Ant Design component usage and UI framework standards |
| `13-ui-token-conventions.mdc` | `TauriApp/src/renderer/src/**/*.{ts,tsx,css}` | false | Token naming and shared style organization conventions |
| `20-go-core.mdc` | `core/**/*.go` | false | Go daemon/control-plane and lifecycle conventions |
| `21-singbox-latest-config.mdc` | `core/internal/control/**/*.go` | false | Enforce latest sing-box config syntax and migration-safe fields |
| `30-remove-obsolete-code.mdc` | global | true | Remove replaced/legacy code and stale aliases |

## Maintenance Checklist

- Keep each rule focused on one concern; avoid cross-rule duplication.
- Keep frontmatter complete: `description`, optional `globs`, `alwaysApply`.
- Keep examples concrete (`BAD` / `GOOD`) for enforceable guidance.
- Keep rule numbering stable and grouped by concern:
  - `00-09`: baseline/runtime
  - `10-19`: frontend/UI
  - `20-29`: core/backend
  - `30+`: cross-cutting quality gates
- Update this index whenever adding, removing, renaming, or changing scope of a rule.

## Typical Usage Map

- Editing Tauri renderer pages: `10` + `12` (+ `30`)
- Editing token files: `12` + `13` (+ `30`)
- Editing Go daemon/control API: `20` + `05` (+ `30`)
- Cross-layer architecture changes: `00` + `05` (+ scoped rules + `30`)
