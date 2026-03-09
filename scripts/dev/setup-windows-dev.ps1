param(
  [string]$WindowsLibTag = "",

  [string]$Repository = "water-ray/wateray"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Host "=== Wateray Windows dev setup ==="

if (-not (Test-Command -Name "git")) {
  throw "git is required. Install Git for Windows first."
}

if (-not (Test-Command -Name "go")) {
  throw "go is required. Install Go 1.24+ first."
}

if (-not (Test-Command -Name "node")) {
  throw "node is required. Install Node.js 20+ first."
}

if (-not (Test-Command -Name "npm")) {
  throw "npm is required. Install npm first."
}

go version
node --version
npm --version

if (-not [string]::IsNullOrWhiteSpace($WindowsLibTag)) {
  $downloadScript = Join-Path $PSScriptRoot "..\build\download-sb-windows.ps1"
  Write-Host "Downloading Windows sb library tag: $WindowsLibTag"
  & $downloadScript -Tag $WindowsLibTag -Repository $Repository
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$electronDir = Join-Path $projectRoot "ElectronApp"

if (Test-Path $electronDir) {
  Push-Location $electronDir
  try {
    npm install
  } finally {
    Pop-Location
  }
} else {
  Write-Warning "ElectronApp directory not found. Skip npm install."
}

Write-Host "=== Setup done ==="
Write-Host "Next:"
Write-Host "1) Verify DLL and header under core/prebuilt/windows"
Write-Host "2) Start core daemon: cd core && go run -tags with_clash_api,with_gvisor,with_quic ./cmd/waterayd"
Write-Host "3) Start Electron frontend: cd ElectronApp && npm run dev"
