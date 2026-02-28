# Wateray Design Tokens (MVP)

## Foundations

- Typography: Material 3 defaults
- Corner radius:
  - Card: 16
  - Button: 12
  - Chip: 10
- Spacing scale: 4, 8, 12, 16, 24, 32
- Elevation:
  - Surface card: 1
  - Highlight card: 2

## Semantic Colors

- `status.connected`: success green
- `status.connecting`: warning amber
- `status.disconnected`: neutral gray
- `status.error`: error red

All colors are derived from `ColorScheme` with semantic mapping in code, so both light and dark themes stay consistent.

## Component Tokens

- Connect card:
  - min height: 168
  - headline text: `titleLarge`
- Traffic panel:
  - metric label: `bodySmall`
  - metric value: `headlineSmall`
- Node tile:
  - supports latency badge and protocol badge
- Logs list:
  - monospace-like readability via `bodySmall` and dense spacing

## Motion

- State transitions: 150-250ms
- No decorative animations in MVP
- Loading state uses lightweight progress indicators only
