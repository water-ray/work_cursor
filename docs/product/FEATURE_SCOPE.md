# Wateray MVP Feature Scope

## Product Positioning

- Audience: entry-level users first.
- Goal: connect in under 5 seconds on first launch.
- Principle: advanced capabilities are available but hidden behind clear entry points.

## P0 (Launch Mandatory)

- Connection lifecycle:
  - Connect, disconnect, auto-reconnect
  - Optional auto-connect on app startup
- Node lifecycle:
  - Add node manually
  - Import subscription URL
  - Group and favorite nodes
  - Basic latency test
- Rules:
  - Recommended mode
  - Rule mode
  - Global mode
- Core/system controls:
  - TUN toggle
  - System proxy toggle
  - Local proxy port display (read-only)
- Runtime visibility:
  - Current node
  - Connection stage
  - Real-time up/down speed
  - Session duration
  - Total traffic
- Diagnostics:
  - Core/client logs
  - User-friendly error messages
  - Copy diagnostics

## P1 (Post-launch Enhancement)

- Node quality panel:
  - Latency, packet loss, availability trend
- Smart selection:
  - Auto-pick by latency/region
- Rules center:
  - Rule subscription update
  - Rule hit summary
- Desktop integration:
  - Tray quick actions
  - Fast node switching
- Config safety:
  - Export/import profile
  - Rollback to last known-good config

## Deferred (P2+)

- Multi-profile parallel runtime
- Visual advanced rule editor
- Scriptable automation hooks
- One-click anonymized diagnostic bundle

## Acceptance Baseline

- Connect/disconnect and node switch do not recreate TUN adapter.
- Node switch uses outbound hot reload.
- Core stats and state are polled/pushed asynchronously to UI.
