[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)

# Execute the real startup script with every OS/process/config boundary mocked.
# Neither Codex nor an injector is launched, stopped, or contacted by this test.
$ErrorActionPreference = 'Stop'
. (Join-Path $Root 'scripts/localization-windows.ps1')
$source = [IO.File]::ReadAllText((Join-Path $Root 'scripts/start-dream-skin.ps1'))
$source = [regex]::Replace($source, '(?m)^\.\s+\(Join-Path \$PSScriptRoot ''(?:common-windows|theme-windows|localization-windows)\.ps1''\)\r?\n', '')
$source = $source.Replace('$Injector = Join-Path $PSScriptRoot ''injector.mjs''', '$Injector = Join-Path $env:LOCALAPPDATA ''mock-injector.mjs''')
$source = $source.Replace('(Split-Path -Parent $PSScriptRoot)', '''mock-skill-root''')
$source = $source.Replace('exit 0', 'return').Replace('exit 1', 'throw $startError')
if ($source.Contains('$PSScriptRoot')) { throw 'Fixture left a real runtime import.' }

function Invoke-StartFixture {
  param([string]$Mode, [string]$Activity = 'idle', [switch]$Recycled, [switch]$Paused,
    [switch]$DisappearDuringProbe, [switch]$FailVerify,
    [switch]$LockBusy, [switch]$Latched, [switch]$CorruptHistory,
    [switch]$FailHistoryWrite, [switch]$FailStop, [switch]$FailLaunch,
    [ValidateSet('alive','missing','reused','at-lock','at-probe','after-stop','at-endpoint')][string]$ParentState = 'alive',
    [ValidateSet('enabled','missing','revoked-during-probe')][string]$ConsentState = 'enabled')
  $script:events = @()
  $script:operationHeld = $false
  $script:history = @{ RestartLatched = [bool]$Latched; LastAttemptAt = 1234 }
  $script:identityCalls = 0
  $script:clockCalls = 0
  $script:ready = $Mode -like 'repair-*'
  $script:running = $Mode -ne 'repair-closed'
  if ($Mode -eq 'repair-closed') { $script:ready = $false }
  $script:lastFailure = ''
  $script:allowForce = $false
  $script:probeActivity = $Activity
  $script:probeDisappears = [bool]$DisappearDuringProbe
  $script:verifyFails = [bool]$FailVerify
  $script:paused = [bool]$Paused
  $script:parentState = $ParentState
  $script:consentState = $ConsentState
  $script:consentEnabled = $ConsentState -ne 'missing'
  $script:parent = [pscustomobject]@{ Id=808; Handle=41; HasExited=$false; StartTime=[datetime]'2026-01-01T00:00:00Z' }
  if ($ParentState -eq 'reused') { $script:parent.StartTime = $script:parent.StartTime.AddSeconds(1) }
  $script:parent | Add-Member ScriptMethod Dispose {}
  $script:process = [pscustomobject]@{ Id=909; Handle=42; HasExited=$false; Path='mock-codex.exe'; StartTime=[datetime]'2026-01-01T00:00:00Z' }
  if ($Recycled) { $script:process.StartTime = $script:process.StartTime.AddSeconds(1) }
  $script:process | Add-Member ScriptMethod Dispose {}
  $script:daemon = [pscustomobject]@{Id=4242; HasExited=$false}
  $script:daemon | Add-Member ScriptMethod WaitForExit { param($Milliseconds); return $this.HasExited }

  function Enter-DreamSkinOperationLock {
    param($TimeoutMilliseconds)
    $script:events += 'lock'
    if ($LockBusy) { throw 'Operation is busy.' }
    $script:operationHeld = $true
    if ($script:parentState -eq 'at-lock') { $script:parent.HasExited = $true }
    return 'mock-lock'
  }
  function Exit-DreamSkinOperationLock { param($Mutex); $script:events += 'unlock'; $script:operationHeld = $false }
  function Get-DreamSkinAutostartRestartState {
    param($StateRoot)
    if (-not $script:operationHeld) { throw 'Child read history outside its operation lock.' }
    $script:events += 'read-history'
    if ($CorruptHistory) { return @{ RestartLatched = $true; LastAttemptAt = 0 } }
    return $script:history.Clone()
  }
  function Write-DreamSkinAutostartRestartState {
    param($StateRoot, $State)
    if (-not $script:operationHeld) { throw 'Child wrote history outside its operation lock.' }
    if ($FailHistoryWrite) { throw 'History write failed.' }
    $script:events += 'write-history'
    $script:history = $State.Clone()
  }
  function Assert-DreamSkinPort { param($Port) }
  function Get-DreamSkinNodeRuntime { return [pscustomobject]@{Path='mock-node.exe';Version='22.23.1'} }
  function Get-DreamSkinCodexInstall { return [pscustomobject]@{Executable='mock-codex.exe';PackageRoot='mock-package';Version='1.0.0'} }
  function Get-DreamSkinThemePaths {
    param($StateRoot)
    return [pscustomobject]@{Root=$StateRoot; Active=(Join-Path $StateRoot 'active'); Saved=(Join-Path $StateRoot 'themes'); PauseFile=(Join-Path $StateRoot 'paused')}
  }
  function Ensure-DreamSkinManagedDirectory { param($Path,$Root) }
  function Initialize-DreamSkinThemeStore { param($SkillRoot,$StateRoot); return Get-DreamSkinThemePaths $StateRoot }
  function Test-DreamSkinPaused { param($StateRoot); return $script:paused }
  function Test-Path {
    param($LiteralPath,$PathType)
    if ("$LiteralPath".EndsWith('autostart-idle-restart.enabled')) { return $script:consentEnabled }
    return $false
  }
  function Test-DreamSkinBackgroundPlaybackEnabled { param($StateRoot); return $false }
  function Test-DreamSkinBackgroundPlaybackCapable { param($Codex,$ProfilePath); return $false }
  function Test-DreamSkinPendingAppearanceTransaction { param($BackupPath); return $false }
  function Read-DreamSkinState { param($Path); return $null }
  function Test-DreamSkinStateProfileMatch { param($State,$ProfilePath); return $true }
  function Get-DreamSkinCodexStatePathCandidate { param($State); return $null }
  function Get-DreamSkinCodexInstallFromState { param($State); return $null }
  function Test-DreamSkinPathEqual { param($Left,$Right); return $Left -eq $Right }
  function Get-DreamSkinCodexProcesses {
    param($Codex,$ProfilePath,[switch]$AllProfiles)
    if ($script:running) { return @([pscustomobject]@{ProcessId=909}) }; return @()
  }
  function Get-Process {
    param($Id)
    if ($Id -eq 808) {
      if ($script:parentState -eq 'missing') { throw 'Parent exited.' }
      $script:events += 'parent-check'
      return $script:parent
    }
    if ($Id -ne 909) { throw 'Unexpected OS process query.' }; return $script:process
  }
  function Get-DreamSkinVerifiedCdpIdentity {
    param($Port,$Codex,$ProfilePath)
    $script:identityCalls += 1
    if ($script:parentState -eq 'at-endpoint') { $script:parent.HasExited = $true }
    if ($Mode -eq 'repair-disappeared' -and $script:identityCalls -gt 1) { return $null }
    if ($script:ready) { return [pscustomobject]@{BrowserId='fixture-browser';ProfilePath=$null} }; return $null
  }
  function Get-DreamSkinVerifiedCdpIdentityForAnyRegistered { param($Port,$ProfilePath); return $null }
  function Test-DreamSkinPortAvailable { param($Port); return $true }
  function Stop-DreamSkinCodex {
    param($Codex,$ProfilePath,$ExpectedProcessId,$ExpectedStartedAt,[switch]$AllowForce)
    if ($ExpectedProcessId -ne 909 -or -not $ExpectedStartedAt) { throw 'Automatic stop omitted the expected process identity.' }
    if (-not $script:history.RestartLatched) { throw 'Automatic stop did not durably arm the restart latch first.' }
    $script:events += 'stop-codex'; $script:allowForce = [bool]$AllowForce
    if ($FailStop) { throw 'Graceful close failed.' }
    $script:running=$false; $script:ready=$false
    if ($script:parentState -eq 'after-stop') { $script:parent.HasExited = $true }
  }
  function Start-DreamSkinCodexForDebugging {
    param($Codex,$Arguments,$Port,$ProfilePath,$PreserveProcessIds)
    $script:events += 'launch-codex'; $script:running=$true; $script:ready=$true
    if ($FailLaunch) { throw 'CDP launch failed.' }
    return [pscustomobject]@{Strategy='package-activation'}
  }
  function Start-DreamSkinCodex { param($Codex); $script:events += 'rollback-launch'; throw 'Unexpected rollback launch.' }
  function Get-DreamSkinActiveThemeAppearance { param($ThemeDirectory); return 'dark' }
  function Install-DreamSkinBaseTheme { param($ConfigPath,$BackupPath,$AppearanceTheme,[switch]$PassThruTransaction); return $null }
  function Stop-DreamSkinRecordedInjector { param($State); $script:events += 'stop-watcher'; return $true }
  function Set-DreamSkinPaused { param($Paused,$StateRoot) }
  function ConvertTo-DreamSkinProcessArgument { param($Value); return $Value }
  function Get-DreamSkinProcessStartedAt { param($ProcessId); return '2026-01-01T00:00:00Z' }
  function Write-DreamSkinState { param($Path,$State) }
  function Write-DreamSkinUtf8FileAtomically { param($Path,$Content) }
  function Get-DreamSkinStartFailureCategory { param($Exception,$FallbackCategory); return $FallbackCategory }
  function Invoke-DreamSkinCodexWindowActivation { param($Codex,$ProfilePath); return $true }
  function Invoke-DreamSkinNative {
    param($FilePath,$ArgumentList,[switch]$DiscardStderr)
    if ($ArgumentList -contains '--sessions-root') {
      $script:events += 'activity-probe'
      if ($script:probeDisappears) { $script:running=$false }
      if ($script:parentState -eq 'at-probe') { $script:parent.HasExited = $true }
      if ($script:consentState -eq 'revoked-during-probe') { $script:consentEnabled = $false }
      if ($script:probeActivity -eq 'bad-json') { return [pscustomobject]@{ExitCode=0;Output=@('broken')} }
      if ($script:probeActivity -eq 'failed') { return [pscustomobject]@{ExitCode=1;Output=@()} }
      $count = if ($script:probeActivity -eq 'busy') { 1 } else { 0 }
      return [pscustomobject]@{ExitCode=0;Output=@((@{status=$script:probeActivity;activeCount=$count} | ConvertTo-Json -Compress))}
    }
    if ($ArgumentList -contains '--verify') {
      if ($ArgumentList -notcontains '--theme-library' -or $ArgumentList -notcontains '--settings') { throw 'Dynamic runtime arguments were omitted.' }
      $code = if ($script:verifyFails) { 2 } else { 0 }
      return [pscustomobject]@{ExitCode=$code;Output=@('{}')}
    }
    if ($ArgumentList -contains '--remove') { return [pscustomobject]@{ExitCode=0;Output=@()} }
    throw 'Unexpected native invocation.'
  }
  function Start-Process {
    param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError)
    if ($FilePath -ne 'mock-node.exe') { throw 'Unexpected app launch.' }
    if ($ArgumentList -notcontains '--theme-library' -or $ArgumentList -notcontains '--settings') { throw 'Watcher dynamic runtime arguments were omitted.' }
    $script:events += 'launch-watcher'; return $script:daemon
  }
  function Stop-Process { param($InputObject,[switch]$Force); $InputObject.HasExited=$true }
  function Remove-Item { param($LiteralPath,[switch]$Force) }
  function Get-Date { $script:clockCalls += 1; return ([datetime]'2026-01-01T00:00:00Z').AddSeconds(60*$script:clockCalls) }
  function Start-Sleep { param($Milliseconds,$Seconds) }
  function Write-Host { param($Object) }
  function Write-Warning { param($Message) }
  function Write-Error { param($Message); $script:lastFailure = "$Message" }

  $savedLocalAppData=$env:LOCALAPPDATA
  $env:LOCALAPPDATA=Join-Path ([IO.Path]::GetTempPath()) 'dream-skin-mock-start'
  try {
    $parameters = if ($Mode -like 'repair-*') { @{RepairWatcherOnly=$true} } else {
      @{AutoRestartIdleOnly=$true;ExpectedCodexPid=909;ExpectedCodexStartedAt='2026-01-01T00:00:00Z'}
    }
    $parameters.ParentProcessId = 808
    $parameters.ParentStartedAt = '2026-01-01T00:00:00Z'
    try { & ([scriptblock]::Create($source)) @parameters } catch { $script:lastFailure = $_.Exception.Message }
  } finally { $env:LOCALAPPDATA=$savedLocalAppData }
  return [pscustomobject]@{Events=@($script:events);Failure=$script:lastFailure;AllowForce=$script:allowForce;History=$script:history.Clone()}
}

$checks=0
foreach ($mode in @('repair-closed','repair-disappeared')) {
  $result = Invoke-StartFixture -Mode $mode
  if (-not $result.Failure -or $result.Events -contains 'launch-codex' -or $result.Events -contains 'stop-codex') {
    throw "$mode launched or stopped Codex, or failed to reject a missing endpoint."
  }
  $checks++
}
$result=Invoke-StartFixture -Mode repair-ready
if ($result.Failure -or $result.Events -notcontains 'launch-watcher' -or $result.Events -contains 'launch-codex') {
  throw "Verified watcher repair failed: $($result.Failure)"
}
$checks++
foreach ($activity in @('busy','unknown','bad-json','failed')) {
  $result=Invoke-StartFixture -Mode auto -Activity $activity
  if (-not $result.Failure -or $result.Events -contains 'stop-codex' -or $result.Events -contains 'launch-codex') {
    throw "Automatic startup did not fail closed for activity=$activity."
  }
  $checks++
}
foreach ($extra in @(@{Recycled=$true},@{Paused=$true},@{DisappearDuringProbe=$true})) {
  $result=Invoke-StartFixture -Mode auto @extra
  if (-not $result.Failure -or $result.Events -contains 'stop-codex' -or $result.Events -contains 'launch-codex') {
    throw 'Automatic startup ignored pause, process reuse, or process disappearance.'
  }
  $checks++
}
$result=Invoke-StartFixture -Mode auto
if ($result.Failure -or $result.AllowForce -or
  @($result.Events | Where-Object { $_ -eq 'stop-codex' }).Count -ne 1 -or
  @($result.Events | Where-Object { $_ -eq 'launch-codex' }).Count -ne 1 -or
  $result.Events.IndexOf('activity-probe') -gt $result.Events.IndexOf('stop-codex')) {
  throw "Idle automatic startup did not perform one non-force, activity-checked restart: $($result.Failure)"
}
$checks++
$result=Invoke-StartFixture -Mode auto -FailVerify
if (-not $result.Failure -or @($result.Events | Where-Object { $_ -eq 'stop-codex' }).Count -ne 1 -or
  @($result.Events | Where-Object { $_ -eq 'launch-codex' }).Count -ne 1 -or $result.Events -contains 'rollback-launch') {
  throw 'Automatic verification failure attempted another close/reopen cycle.'
}
$checks++
foreach ($mode in @('auto','repair-ready')) {
  foreach ($parentState in @('missing','reused','at-lock')) {
    $result = Invoke-StartFixture -Mode $mode -ParentState $parentState
    if (-not $result.Failure -or $result.Events -contains 'stop-codex' -or
      $result.Events -contains 'launch-codex' -or $result.Events -contains 'launch-watcher') {
      throw "$mode ignored parent state $parentState after acquiring the operation lock."
    }
    $checks++
  }
}
$result = Invoke-StartFixture -Mode auto -ParentState at-probe
if (-not $result.Failure -or $result.Events -contains 'stop-codex' -or $result.Events -contains 'launch-codex') {
  throw 'Automatic restart ignored parent exit during session activity probing.'
}
$checks++
$result = Invoke-StartFixture -Mode repair-ready -ParentState at-endpoint
if (-not $result.Failure -or $result.Events -contains 'stop-watcher' -or $result.Events -contains 'launch-watcher') {
  throw 'Watcher repair ignored parent exit during endpoint probing.'
}
$checks++
$result = Invoke-StartFixture -Mode auto -ParentState after-stop
if ($result.Failure -or @($result.Events | Where-Object { $_ -eq 'stop-codex' }).Count -ne 1 -or
  @($result.Events | Where-Object { $_ -eq 'launch-codex' }).Count -ne 1) {
  throw "Parent exit after closing Codex left the app closed: $($result.Failure)"
}
$checks++
foreach ($consentState in @('missing','revoked-during-probe')) {
  $result = Invoke-StartFixture -Mode auto -ConsentState $consentState
  if (-not $result.Failure -or $result.Events -contains 'stop-codex' -or $result.Events -contains 'launch-codex') {
    throw "Automatic restart ignored missing or revoked consent: $consentState."
  }
  $checks++
}
foreach ($extra in @(
  @{LockBusy=$true}, @{Activity='busy'}, @{Activity='unknown'}, @{Activity='failed'},
  @{ParentState='at-probe'}, @{ConsentState='revoked-during-probe'}, @{Paused=$true},
  @{DisappearDuringProbe=$true}, @{FailHistoryWrite=$true}
)) {
  $result = Invoke-StartFixture -Mode auto @extra
  if (-not $result.Failure -or $result.History.RestartLatched -or
    $result.Events -contains 'stop-codex' -or $result.Events -contains 'launch-codex') {
    throw 'A refusal before closing Codex permanently latched restart or touched the app.'
  }
  $checks++
}
foreach ($extra in @(@{Latched=$true}, @{CorruptHistory=$true})) {
  $result = Invoke-StartFixture -Mode auto @extra
  if (-not $result.Failure -or $result.Events -contains 'write-history' -or
    $result.Events -contains 'stop-codex' -or $result.Events -contains 'launch-codex') {
    throw 'The child ignored a durable restart latch or corrupted history.'
  }
  $checks++
}
foreach ($extra in @(@{}, @{FailStop=$true}, @{FailLaunch=$true}, @{FailVerify=$true})) {
  $result = Invoke-StartFixture -Mode auto @extra
  if (-not $result.History.RestartLatched -or
    @($result.Events | Where-Object { $_ -eq 'write-history' }).Count -ne 1 -or
    $result.Events.IndexOf('write-history') -gt $result.Events.IndexOf('stop-codex') -or
    $result.Events.IndexOf('write-history') -lt $result.Events.IndexOf('activity-probe')) {
    throw 'A real close attempt was not durably latched after checks and before the stop.'
  }
  $checks++
}
Write-Output "PASS: $checks automatic-start safety scenarios (all OS boundaries mocked)."
