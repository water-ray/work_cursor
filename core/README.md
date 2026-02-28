# core

Go runtime core for routing, tunnel, and proxy orchestration.

## Responsibilities

- Manage engine lifecycle in an isolated runtime.
- Keep TUN adapter persistent across node switches.
- Expose control-plane contract for frontend clients.
- Keep runtime config/subscription/rule state as authoritative backend source.
- Expose stable C ABI adapters when embedding mode is required.
