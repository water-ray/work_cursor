param(
  [string]$WindowsLibTag = "",

  [string]$Repository = "water-ray/wateray",

  [switch]$InitFlutterWindowsRunner
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

go version

$flutterReady = Test-Command -Name "flutter"
if (-not $flutterReady) {
  Write-Warning "flutter not found. Install Flutter SDK and add it to PATH."
  Write-Host "Suggested: winget install Flutter.Flutter"
} else {
  flutter --version
  flutter config --enable-windows-desktop
  flutter doctor -v
}

if (-not [string]::IsNullOrWhiteSpace($WindowsLibTag)) {
  $downloadScript = Join-Path $PSScriptRoot "..\build\download-sb-windows.ps1"
  Write-Host "Downloading Windows sb library tag: $WindowsLibTag"
  & $downloadScript -Tag $WindowsLibTag -Repository $Repository
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$appDir = Join-Path $projectRoot "app"

if ($flutterReady -and (Test-Path $appDir)) {
  Push-Location $appDir
  try {
    if ($InitFlutterWindowsRunner -and -not (Test-Path (Join-Path $appDir "windows"))) {
      flutter create --platforms=windows .
    }
    flutter pub get
  } finally {
    Pop-Location
  }
}

Write-Host "=== Setup done ==="
Write-Host "Next:"
Write-Host "1) Verify DLL and header under core/prebuilt/windows"
Write-Host "2) Wire FFI dynamic loading in app"
Write-Host "3) Run a minimal Windows lifecycle integration test"
