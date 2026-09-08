[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
. (Join-Path $Root 'scripts/autostart-dream-skin.ps1')
function Assert-Action($Expected, $Snapshot, $State = @{}) {
  $actual = Get-DreamSkinAutostartDecision -Snapshot $Snapshot -State $State -NowMs 1000000
  if ($actual.Action -cne $Expected) { throw "Expected $Expected, got $($actual | ConvertTo-Json -Compress)" }
}
$base = @{ MainCount = 1; StartedAtMs = 980000; Enabled = $true; Paused = $false;
  EndpointReady = $false; InjectorHealthy = $false; AllowIdleRestart = $true }
Assert-Action 'restart' $base
foreach ($field in @('Enabled', 'AllowIdleRestart')) {
  $value = $base.Clone(); $value[$field] = $false; Assert-Action 'wait' $value
}
$value = $base.Clone(); $value.Paused = $true; Assert-Action 'wait' $value
$value = $base.Clone(); $value.MainCount = 0; Assert-Action 'stopped' $value
$value = $base.Clone(); $value.MainCount = 2; Assert-Action 'wait' $value
$value = $base.Clone(); $value.StartedAtMs = 995000; Assert-Action 'wait' $value
$value = $base.Clone(); $value.StartedAtMs = 0; Assert-Action 'wait' $value
$value = $base.Clone(); $value.MainHasDebugPort = $true; Assert-Action 'wait' $value
Assert-Action 'wait' $base @{ RestartLatched = $true }
Assert-Action 'wait' $base @{ LastAttemptAt = 990000 }
$value = $base.Clone(); $value.EndpointReady = $true; $value.AllowIdleRestart = $false
Assert-Action 'repair' $value
$value.InjectorHealthy = $true
Assert-Action 'wait' $value
# A restart latch never suppresses a safe watcher-only repair after successful launch.
$value.InjectorHealthy = $false
Assert-Action 'repair' $value @{ RestartLatched = $true; LastAttemptAt = 600000 }

# Closed is trustworthy only after a complete process inventory. Missing package
# matches, command lines, or WMI permissions must not clear the restart latch.
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction)
  if ($script:inventoryFails) { throw 'WMI unavailable' }
  if ($ErrorAction -cne 'Stop') { throw 'Inventory must fail closed' }
  return $script:processFixture
}
function ConvertFrom-DreamSkinProcessCommandLine { param($CommandLine) return ,([string[]]$CommandLine.Split(' ')) }
function Get-DreamSkinProcessExecutablePath { param($ProcessInfo) return $ProcessInfo.ExecutablePath }
function Test-DreamSkinPathEqual { param($Left, $Right) return $Left -ieq $Right }
function Test-DreamSkinProcessProfile { param($ProcessInfo, $ProfilePath)
  return $ProcessInfo.CommandLine -notmatch '--user-data-dir'
}
$installs = @(@{ Executable = 'C:\\Codex\\ChatGPT.exe' })
$script:processFixture = @()
$inventory = Get-DreamSkinAutostartInventory -Installs $installs
if ($inventory.MainCount -ne 0) { throw 'A complete empty inventory should be closed' }
$script:processFixture = @(@{ ProcessId = 41; ExecutablePath = 'C:\\Updated\\ChatGPT.exe'; CommandLine = 'ChatGPT.exe' })
$inventory = Get-DreamSkinAutostartInventory -Installs $installs
if ($inventory.MainCount -ne -1) { throw 'An unknown updated package must not appear closed' }
$script:processFixture[0].ExecutablePath = 'C:\\Codex\\ChatGPT.exe'
$inventory = Get-DreamSkinAutostartInventory -Installs $installs
if ($inventory.MainCount -ne 1 -or $inventory.Mains[0].Process.ProcessId -ne 41) { throw 'Known default main not found' }
foreach ($command in @('ChatGPT.exe --ordinary-flag', 'ChatGPT.exe --remote-debugging-port=9335')) {
  $script:processFixture[0].CommandLine = $command
  if ((Get-DreamSkinAutostartInventory -Installs $installs).MainCount -ne 1) { throw 'Main process flags were mistaken for a renderer' }
}
$script:processFixture[0].CommandLine = 'ChatGPT.exe --type=renderer'
if ((Get-DreamSkinAutostartInventory -Installs $installs).MainCount -ne 0) { throw 'Renderer should not be a main process' }
$script:processFixture[0].CommandLine = 'ChatGPT.exe --user-data-dir=C:\\test'
if ((Get-DreamSkinAutostartInventory -Installs $installs).MainCount -ne 0) { throw 'Isolated profile must be excluded' }
$script:processFixture[0].CommandLine = $null
if ((Get-DreamSkinAutostartInventory -Installs $installs).MainCount -ne -1) { throw 'Hidden command line is unknown, not closed' }
$script:inventoryFails = $true
try { Get-DreamSkinAutostartInventory -Installs $installs; throw 'Inventory failure was swallowed' }
catch { if ($_.Exception.Message -cne 'WMI unavailable') { throw } }
$script:inventoryFails = $false

$closeState = @{ SeenMain = $false; ClosedSince = 0 }
if (Update-DreamSkinAutostartCloseObservation -State $closeState -MainCount 0 -NowMs 1000000) { throw 'First empty frame cannot rearm' }
[void](Update-DreamSkinAutostartCloseObservation -State $closeState -MainCount 1 -NowMs 1000001)
if (Update-DreamSkinAutostartCloseObservation -State $closeState -MainCount 0 -NowMs 1000002) { throw 'Temporary close cannot rearm' }
if (Update-DreamSkinAutostartCloseObservation -State $closeState -MainCount 0 -NowMs 1009002) { throw 'Close grace was not respected' }
if (-not (Update-DreamSkinAutostartCloseObservation -State $closeState -MainCount 0 -NowMs 1010002)) { throw 'Stable observed close should rearm' }
[void](Update-DreamSkinAutostartCloseObservation -State $closeState -MainCount -1 -NowMs 1010003)
if (Update-DreamSkinAutostartCloseObservation -State $closeState -MainCount 0 -NowMs 1010004) { throw 'Unknown snapshot must break continuous close proof' }
foreach ($content in @('{}', '{"RestartLatched":null}', '{"RestartLatched":false,"LastAttemptAt":"0"}', '{"RestartLatched":false,"LastAttemptAt":-1}')) {
  $failed = $false
  try { Read-DreamSkinAutostartRestartState -Content $content } catch { $failed = $true }
  if (-not $failed) { throw "Invalid restart history accepted: $content" }
}
$valid = Read-DreamSkinAutostartRestartState -Content '{"RestartLatched":true,"LastAttemptAt":900000}'
if (-not $valid.RestartLatched -or $valid.LastAttemptAt -ne 900000) { throw 'Valid restart history rejected' }
Write-Output 'PASS: autostart preserves paused/busy profiles, startup grace, cooldown, and restart latch.'
