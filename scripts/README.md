# scripts

Automation scripts for build, CI, and packaging.

- `build/`: Local and release build scripts.
- `ci/`: CI workflow helper scripts.
- `package/`: Installer and distributable packaging scripts.

## sing-box library workflow

- GitHub workflow: `.github/workflows/sb-libs-release.yml`
- Download helper: `scripts/build/download-sb-libs.ps1`

## windows-only sing-box workflow

- GitHub workflow: `.github/workflows/sb-windows-release.yml`
- Download helper: `scripts/build/download-sb-windows.ps1`
- Local setup helper: `scripts/dev/setup-windows-dev.ps1`
