[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$requiredStaticTokens = @(
  '[string]$PauseNoSessionMessage',
  '[string]$PauseSucceededMessage',
  '[string]$PauseFailedMessage'
)
$themeSource = [IO.File]::ReadAllText((Join-Path $root 'windows/scripts/theme-windows.ps1'))
foreach ($token in $requiredStaticTokens) {
  if (-not $themeSource.Contains($token)) { throw "Windows runtime is missing $token" }
}
$traySource = [IO.File]::ReadAllText((Join-Path $root 'windows/scripts/tray-dream-skin.ps1'))
foreach ($token in @(
  "Get-DreamSkinTrayText -Key 'PauseNoSession'",
  "Get-DreamSkinTrayText -Key 'PauseSucceeded'",
  "Get-DreamSkinTrayText -Key 'PauseFailed'"
)) {
  if (-not $traySource.Contains($token)) { throw "Windows tray is missing $token" }
}
Push-Location $root
try {
  foreach ($directory in @('windows/scripts', 'windows/installer', 'windows/tests')) {
    foreach ($script in @(Get-ChildItem -LiteralPath (Join-Path $root $directory) -Filter '*.ps1' -File)) {
      $parseErrors = $null; $tokens = $null
      [void][System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$parseErrors)
      if ($parseErrors.Count -gt 0) { throw "PowerShell syntax errors in $($script.FullName): $parseErrors" }
    }
  }
  $tests = @()
  $tests += Get-ChildItem -LiteralPath (Join-Path $root 'windows/tests') -Filter '*.test.mjs' -File
  # Shared suites do not invoke macOS launchers or external UI applications.
  foreach ($name in @('asset-host', 'audio-bus', 'content-manifest', 'controls',
      'dynamic-controller', 'dynamic-settings', 'effect-runtime', 'media-layer',
      'media-signatures', 'payload-composer', 'renderer-asset-bridge',
      'theme-contract', 'theme-loader', 'zip-preflight')) {
    $tests += Get-Item -LiteralPath (Join-Path $root "tools/tests/$name.test.mjs")
  }
  & node --test @($tests.FullName)
  if ($LASTEXITCODE -ne 0) { throw "Windows JavaScript tests failed with exit code $LASTEXITCODE" }
  $powerShellPath = (Get-Process -Id $PID -ErrorAction Stop).Path
  & node (Join-Path $root 'windows/tests/native-suite-runner.mjs') `
    '--shell' $powerShellPath `
    '--tests-dir' (Join-Path $root 'windows/tests') `
    '--root' (Join-Path $root 'windows')
  if ($LASTEXITCODE -ne 0) {
    throw "Windows PowerShell native tests failed with exit code $LASTEXITCODE"
  }
  Write-Host 'PASS: public Windows source and portable theme runtime'
} finally {
  Pop-Location
}
