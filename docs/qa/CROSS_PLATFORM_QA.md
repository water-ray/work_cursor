# Cross-platform QA Checklist

## Automated checks executed in current environment

- `npm run typecheck` on `ElectronApp/`: pass
- `npm run build` on `ElectronApp/`: pass
- `go test ./...` on `core/`: pass

## Runtime checks (manual)

### Windows

- [ ] Launch desktop stack with `wateray: run desktop stack`
- [ ] Validate connect/disconnect from Dashboard
- [ ] Validate node switch triggers hot reload logs
- [ ] Validate rule mode change updates logs and runtime state

### macOS / Linux

- [ ] Run Electron desktop build
- [ ] Verify navigation, context menu, and table interactions
- [ ] Verify daemon reconnect after UI restart
- [ ] Verify core runtime label and version visibility
