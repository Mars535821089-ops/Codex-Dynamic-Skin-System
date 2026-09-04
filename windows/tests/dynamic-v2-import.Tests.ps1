[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'test-host-platform.ps1')
if (-not (Test-DreamSkinWindowsHost -Platform ([System.PlatformID]::Win32NT)) -or
  (Test-DreamSkinWindowsHost -Platform ([System.PlatformID]::Unix))) {
  throw 'Windows host detection is not portable across Windows PowerShell 5.1 and PowerShell Core.'
}
$isWindowsHost = Test-DreamSkinWindowsHost
. (Join-Path $Root 'scripts\common-windows.ps1')
. (Join-Path $Root 'scripts\theme-windows.ps1')

$projectRoot = Split-Path -Parent $Root
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction Stop }
$nodePath = $nodeCommand.Source

$recoverySource = (Get-Command Invoke-DreamSkinThemeReplacementRecovery).Definition
foreach ($requiredRecoveryContract in @(
  'publish-theme-import.mjs',
  "'--recover'",
  "status -cne 'recovered'"
)) {
  if (-not $recoverySource.Contains($requiredRecoveryContract)) {
    throw "Windows startup recovery does not cover dynamic v2 transactions: $requiredRecoveryContract"
  }
}

if (-not $isWindowsHost) {
  function Get-DreamSkinNodeRuntime { return [pscustomobject]@{ Path = $nodePath } }
  function New-DreamSkinThemeImportMutex {
    return [System.Threading.Mutex]::new($false, 'CodexDreamSkin.DynamicV2Import.Test')
  }
  function Assert-DreamSkinNoReparseComponents {
    param([Parameter(Mandatory = $true)][string]$Path)
    $current = [System.IO.Path]::GetFullPath($Path)
    while ($current -and (Test-Path -LiteralPath $current)) {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Managed Dream Skin path contains a symbolic link: $current"
      }
      $parent = [System.IO.Path]::GetDirectoryName($current)
      if (-not $parent -or $parent -ceq $current) { break }
      $current = $parent
    }
  }
  function Ensure-DreamSkinManagedDirectory {
    param(
      [Parameter(Mandatory = $true)][string]$Path,
      [Parameter(Mandatory = $true)][string]$Root
    )
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $prefix = $fullRoot + [System.IO.Path]::DirectorySeparatorChar
    if ($fullPath -cne $fullRoot -and -not $fullPath.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
      throw "Managed Dream Skin path escaped its state root: $fullPath"
    }
    [System.IO.Directory]::CreateDirectory($fullPath) | Out-Null
    Assert-DreamSkinNoReparseComponents -Path $fullPath
  }
}

$temporaryRoot = if ($isWindowsHost) {
  Join-Path ([System.IO.Path]::GetTempPath()) `
    ('dreamskin-dynamic-v2-import-' + [guid]::NewGuid().ToString('N'))
} else {
  Join-Path $projectRoot ('.windows-dynamic-v2-import-' + [guid]::NewGuid().ToString('N'))
}
$sourceRoot = Join-Path $temporaryRoot 'source'
$stateRoot = Join-Path $temporaryRoot 'state'
$archivePath = Join-Path $temporaryRoot 'dynamic-v2.zip'
[System.IO.Directory]::CreateDirectory((Join-Path $sourceRoot 'media')) | Out-Null

try {
  Copy-Item -LiteralPath (Join-Path $projectRoot 'tools/tests/fixtures/media/loop-h264.mp4') `
    -Destination (Join-Path $sourceRoot 'media/visual.mp4')
  Copy-Item -LiteralPath (Join-Path $projectRoot 'tools/tests/fixtures/media/tiny.png') `
    -Destination (Join-Path $sourceRoot 'media/poster.png')
  $theme = [ordered]@{
    schemaVersion = 2
    id = 'test.windows.dynamic-v2'
    name = 'Windows Dynamic V2'
    version = '1.0.0'
    capabilities = @('animated-background', 'sound-pack')
    visual = [ordered]@{
      kind = 'video'; asset = 'media/visual.mp4'; poster = 'media/poster.png'
      fit = 'adaptive'; opacity = 1; overscan = 1.08; loop = $true
    }
    audio = [ordered]@{
      ambient = [ordered]@{ source = 'visual'; loop = $true; volume = 0.7; analyze = $true }
      ui = [ordered]@{ volume = 0.8; events = [ordered]@{} }
    }
    tokens = [ordered]@{}
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $sourceRoot 'theme.json'),
    (($theme | ConvertTo-Json -Depth 12) + "`n"),
    [System.Text.UTF8Encoding]::new($false)
  )
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($sourceRoot, $archivePath)

  $imported = Import-DreamSkinThemeZip -ArchivePath $archivePath -StateRoot $stateRoot
  if ($imported.Status -cne 'Imported' -or $imported.Id -cne 'test.windows.dynamic-v2') {
    throw 'Windows v2 import did not return the committed dynamic theme identity.'
  }
  foreach ($relative in @('theme.json', 'media/visual.mp4', 'media/poster.png')) {
    if (-not (Test-Path -LiteralPath (Join-Path $imported.Path $relative) -PathType Leaf)) {
      throw "Windows v2 import did not publish runtime file: $relative"
    }
  }
  $published = Get-Content -LiteralPath (Join-Path $imported.Path 'theme.json') -Raw | ConvertFrom-Json
  if ([int]$published.schemaVersion -ne 2 -or "$($published.visual.asset)" -cne 'media/visual.mp4') {
    throw 'Windows v2 import rewrote the dynamic theme as a legacy static theme.'
  }
  if (Test-Path -LiteralPath (Join-Path $imported.Path 'manifest.json')) {
    throw 'Windows v2 import published package-only manifest metadata into the runtime theme.'
  }
  Write-Host 'PASS: Windows import publishes a complete nested Skin API v2 runtime theme.'
} finally {
  Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
