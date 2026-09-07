[CmdletBinding()]
param(
  [switch]$Json,
  [switch]$Interactive
)

$ErrorActionPreference = 'Stop'
$engineRoot = Split-Path -Parent $PSScriptRoot
$versionPath = Join-Path $engineRoot 'VERSION'
$configPath = Join-Path $engineRoot 'repository.json'
$repository = ''
$releasePage = ''
. (Join-Path $PSScriptRoot 'localization-windows.ps1')
$stateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'
$language = Resolve-DreamSkinLanguage -StateRoot $stateRoot

function Get-DreamSkinUpdateText {
  param([Parameter(Mandatory = $true)][string]$Key, [object[]]$FormatArguments = @())
  Get-DreamSkinText -Key $Key -Language $language -FormatArguments $FormatArguments
}

function ConvertTo-DreamSkinVersion {
  param([Parameter(Mandatory = $true)][string]$Value)
  $normalized = $Value.Trim()
  if ($normalized.StartsWith('v', [System.StringComparison]::OrdinalIgnoreCase)) {
    $normalized = $normalized.Substring(1)
  }
  if ($normalized -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw "Invalid release version: $Value"
  }
  return $normalized
}

function Compare-DreamSkinVersionComponent {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )
  if ($Left.Length -gt $Right.Length) { return 1 }
  if ($Left.Length -lt $Right.Length) { return -1 }
  return [string]::Compare($Left, $Right, [System.StringComparison]::Ordinal)
}

function Compare-DreamSkinVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )
  $leftParts = $Left.Split('.')
  $rightParts = $Right.Split('.')
  for ($index = 0; $index -lt 3; $index += 1) {
    $comparison = Compare-DreamSkinVersionComponent `
      -Left $leftParts[$index] -Right $rightParts[$index]
    if ($comparison -ne 0) { return $comparison }
  }
  return 0
}

function Show-DreamSkinUpdateResult {
  param([Parameter(Mandatory = $true)][object]$Result)
  Add-Type -AssemblyName System.Windows.Forms
  if ($Result.updateAvailable) {
    $choice = [System.Windows.Forms.MessageBox]::Show(
      ((Get-DreamSkinUpdateText -Key 'UpdateAvailable' -FormatArguments @($Result.latestVersion)) +
        [Environment]::NewLine + [Environment]::NewLine +
        (Get-DreamSkinUpdateText -Key 'UpdateQuestion')),
      (Get-DreamSkinUpdateText -Key 'UpdateTitle'),
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Information
    )
    if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) {
      Start-Process -FilePath $Result.releaseUrl | Out-Null
    }
    return
  }
  [void][System.Windows.Forms.MessageBox]::Show(
    (Get-DreamSkinUpdateText -Key 'UpToDate' -FormatArguments @($Result.currentVersion)),
    (Get-DreamSkinUpdateText -Key 'UpdateTitle'),
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  )
}

try {
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "repository.json is missing: $configPath"
  }
  $repository = (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).githubRepository
  if ($repository -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw 'Update checks are disabled until githubRepository is configured.'
  }
  $releasePage = "https://github.com/$repository/releases/latest"
  if (-not (Test-Path -LiteralPath $versionPath -PathType Leaf)) {
    throw "Installed version file is missing: $versionPath"
  }
  $currentText = ([System.IO.File]::ReadAllText($versionPath)).Trim()
  $current = ConvertTo-DreamSkinVersion -Value $currentText
  $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'CodexDreamSkin' }
  $responsePath = [System.IO.Path]::GetTempFileName()
  try {
    $previousProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing `
        -Uri "https://api.github.com/repos/$repository/releases/latest" `
        -Headers $headers -Method Get -TimeoutSec 12 -OutFile $responsePath | Out-Null
    } finally {
      [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
    }
    $responseInfo = Get-Item -LiteralPath $responsePath -ErrorAction Stop
    if ($responseInfo.Length -le 0 -or $responseInfo.Length -gt 1048576) {
      throw 'GitHub returned an invalid response size.'
    }
    $responseText = [System.IO.File]::ReadAllText($responsePath)
    $release = $responseText | ConvertFrom-Json
  } finally {
    Remove-Item -LiteralPath $responsePath -Force -ErrorAction SilentlyContinue
  }
  if (-not $release.tag_name) { throw 'GitHub did not return a release tag.' }
  $latest = ConvertTo-DreamSkinVersion -Value "$($release.tag_name)"
  $latestComparison = Compare-DreamSkinVersion -Left $latest -Right $current
  $result = [pscustomobject]@{
    currentVersion = "v$current"
    latestVersion = "v$latest"
    updateAvailable = $latestComparison -gt 0
    releaseUrl = $releasePage
  }
  if ($Json) { $result | ConvertTo-Json -Compress }
  if ($Interactive) { Show-DreamSkinUpdateResult -Result $result }
  if (-not $Json -and -not $Interactive) {
    Write-Host "$($result.currentVersion) -> $($result.latestVersion); update=$($result.updateAvailable)"
  }
} catch {
  if ($Json) {
    [pscustomobject]@{ error = $_.Exception.Message; releaseUrl = $releasePage } | ConvertTo-Json -Compress
  }
  if ($Interactive) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show(
      ((Get-DreamSkinUpdateText -Key 'UpdateFailed') + [Environment]::NewLine +
        [Environment]::NewLine + $_.Exception.Message),
      (Get-DreamSkinUpdateText -Key 'UpdateTitle'),
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    )
  }
  if (-not $Json -and -not $Interactive) { throw }
  exit 1
}
