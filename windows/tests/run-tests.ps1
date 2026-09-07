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
  $tests = @()
  $tests += Get-ChildItem -LiteralPath (Join-Path $root 'windows/tests') -Filter '*.test.mjs' -File
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
