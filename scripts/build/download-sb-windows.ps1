param(
  [Parameter(Mandatory = $true)]
  [string]$Tag,

  [string]$Repository = "water-ray/wateray",

  [string]$OutputDir = "core/prebuilt/windows",

  [string]$AssetName = "wateray-core-windows-amd64.zip",

  [string]$Token = $env:GITHUB_TOKEN
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Token)) {
  throw "GITHUB_TOKEN is required for private repository downloads."
}

$headers = @{
  Authorization = "Bearer $Token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

$release = Invoke-RestMethod `
  -Method Get `
  -Uri "https://api.github.com/repos/$Repository/releases/tags/$Tag" `
  -Headers $headers

$asset = $release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
if (-not $asset) {
  throw "Asset $AssetName not found in release $Tag."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$targetZip = Join-Path $OutputDir $asset.name
$extractDir = Join-Path $OutputDir ([System.IO.Path]::GetFileNameWithoutExtension($asset.name))

$binaryHeaders = @{
  Authorization = "Bearer $Token"
  Accept = "application/octet-stream"
  "X-GitHub-Api-Version" = "2022-11-28"
}

Invoke-WebRequest `
  -Uri "https://api.github.com/repos/$Repository/releases/assets/$($asset.id)" `
  -Headers $binaryHeaders `
  -OutFile $targetZip

if (Test-Path $extractDir) {
  Remove-Item -Path $extractDir -Recurse -Force
}

Expand-Archive -Path $targetZip -DestinationPath $extractDir -Force
Write-Host "Downloaded and extracted: $targetZip"
Write-Host "Extracted to: $extractDir"
