# scripts

Automation scripts for build, CI, and packaging.

- `build/`: Local and release build scripts.
- `release/`: Version bump and release changelog scripts.
- `ci/`: CI workflow helper scripts.
- `package/`: Installer and distributable packaging scripts.

## sing-box library workflow

- GitHub workflow: `.github/workflows/sb-libs-release.yml`
- Download helper: `scripts/build/download-sb-libs.ps1`

## windows-only sing-box workflow

- GitHub workflow: `.github/workflows/sb-windows-release.yml`
- Download helper: `scripts/build/download-sb-windows.ps1`
- Local setup helper: `scripts/dev/setup-windows-dev.ps1`

## unified version release workflow

- Single version source: repository root `VERSION` (strict `X.Y.Z`).
- Release helper: `scripts/release/release_version.py`.
- Usage:
  - `python scripts/release/release_version.py minor`
  - `python scripts/release/release_version.py patch`
- Script side effects:
  - Update `VERSION`
  - Sync `ElectronApp/package.json` and `ElectronApp/package-lock.json`
  - Generate `docs/build/CHANGELOG_LATEST.md`
