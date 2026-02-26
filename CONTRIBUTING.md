# Contributing

Thanks for your interest in contributing to wateray.

## Development setup

1. Fork the repository and create a feature branch.
2. Keep changes scoped to one concern per pull request.
3. Follow project rules in `.cursor/rules/`.

## Branch naming

- `feat/<short-name>`
- `fix/<short-name>`
- `chore/<short-name>`

## Commit style

Prefer conventional commits:

- `feat: ...`
- `fix: ...`
- `chore: ...`
- `docs: ...`
- `refactor: ...`

## Validation before opening PR

From `app/`:

- `flutter pub get`
- `flutter analyze`
- `flutter test`

From `core/`:

- `go test ./...`

## Networking constraints

- Do not recreate TUN device during node switch.
- Prefer outbound hot reload to keep user traffic stable.
- Keep core runtime asynchronous and non-blocking for UI calls.
