param(
  [Parameter(Mandatory = $true)]
  [string]$Tag,

  [string]$Repository = "water-ray/wateray-src",

  [string]$OutputDir = "core/prebuilt",

  [string]$Token = $env:GITHUB_TOKEN
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Token)) {
  throw "私有仓库下载需要 GITHUB_TOKEN。请先设置环境变量 GITHUB_TOKEN。"
}

$apiHeaders = @{
  Authorization = "Bearer $Token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

$release = Invoke-RestMethod `
  -Method Get `
  -Uri "https://api.github.com/repos/$Repository/releases/tags/$Tag" `
  -Headers $apiHeaders

if (-not $release.assets -or $release.assets.Count -eq 0) {
  throw "Release $Tag 没有可下载资产。"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$assetPattern = "^wateray-core-(windows-amd64|android-so|ios-xcframework)\.zip$"
$targetAssets = @($release.assets | Where-Object { $_.name -match $assetPattern })

if ($targetAssets.Count -eq 0) {
  throw "Release $Tag 中未找到目标库资产。"
}

foreach ($asset in $targetAssets) {
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
  Write-Host "Downloaded and extracted: $($asset.name)"
}

Write-Host "Done. Output: $OutputDir"
