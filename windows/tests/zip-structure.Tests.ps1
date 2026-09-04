[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'test-host-platform.ps1')
$isWindowsHost = Test-DreamSkinWindowsHost
. (Join-Path $Root 'scripts\common-windows.ps1')
. (Join-Path $Root 'scripts\theme-windows.ps1')

$projectRoot = Split-Path -Parent $Root
$fixtureBuilder = Join-Path $projectRoot 'macos\tests\helpers\make-zip-fixture.mjs'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction Stop }
$nodePath = $nodeCommand.Source

# PowerShell Core on macOS is used only as an additional source-tree regression.
# Authenticode discovery remains covered by the real Windows suite.
if (-not $isWindowsHost) {
  function Get-DreamSkinNodeRuntime { return [pscustomobject]@{ Path = $nodePath } }
  $temporaryRoot = Join-Path $projectRoot ('.windows-zip-structure-' + [guid]::NewGuid().ToString('N'))
} else {
  $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
    ('dreamskin-windows-zip-structure-' + [guid]::NewGuid().ToString('N'))
}
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

function New-StructureFixture {
  param([Parameter(Mandatory = $true)][string]$Scenario)
  $archive = Join-Path $temporaryRoot "$Scenario.zip"
  & $nodePath $fixtureBuilder $archive $Scenario
  if ($LASTEXITCODE -ne 0) { throw "Could not build ZIP fixture: $Scenario" }
  return $archive
}

try {
  foreach ($scenario in @('valid-nested', 'valid-deflate')) {
    $archive = New-StructureFixture -Scenario $scenario
    $destination = Join-Path $temporaryRoot "accepted-$scenario"
    New-Item -ItemType Directory -Path $destination | Out-Null
    $sourceRoot = Expand-DreamSkinThemeZipSecurely `
      -ArchivePath $archive -DestinationRoot $destination
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'theme.json') -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $sourceRoot 'media\loop.mp4') -PathType Leaf)) {
      throw "Windows extraction did not preserve nested v2 media for $scenario."
    }
  }

  foreach ($scenario in @(
    'duplicate', 'case-collision', 'unicode-collision', 'traversal', 'absolute',
    'windows-device', 'control', 'symlink', 'fifo', 'unsupported', 'encrypted',
    'oversized-entry', 'oversized-total', 'nested-archive', 'too-many'
  )) {
    $archive = New-StructureFixture -Scenario $scenario
    $destination = Join-Path $temporaryRoot "rejected-$scenario"
    New-Item -ItemType Directory -Path $destination | Out-Null
    $rejected = $false
    try {
      $null = Expand-DreamSkinThemeZipSecurely `
        -ArchivePath $archive -DestinationRoot $destination
    } catch { $rejected = $true }
    if (-not $rejected) { throw "Windows extraction unexpectedly accepted $scenario." }
    if (@(Get-ChildItem -LiteralPath $destination -Force).Count -ne 0) {
      throw "Rejected ZIP left extracted output for $scenario."
    }
  }

  Write-Host 'PASS: Windows ZIP extraction accepts nested v2 media and rejects hostile structures.'
} finally {
  Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
