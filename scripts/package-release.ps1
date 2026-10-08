param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $SkipBuild) {
    & node (Join-Path $PSScriptRoot 'build-local.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Local build failed.' }
}
& node (Join-Path $PSScriptRoot 'package-release.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Release packaging failed.' }
