[CmdletBinding()]
param(
  [int]$ParentProcessId,
  [string]$ParentStartedAt,
  [int]$Port = 9335
)
. (Join-Path $PSScriptRoot 'common-windows.ps1')

function Get-DreamSkinAutostartDecision {
  param([object]$Snapshot, [object]$State, [double]$NowMs)
  if (-not $Snapshot.Enabled -or $Snapshot.Paused) { return @{ Action = 'wait'; Reason = 'disabled-or-paused' } }
  if ($Snapshot.MainCount -eq 0) { return @{ Action = 'stopped'; Reason = 'codex-closed' } }
  if ($Snapshot.MainCount -ne 1) { return @{ Action = 'wait'; Reason = 'ambiguous-main-process' } }
  if ($Snapshot.EndpointReady -and $Snapshot.InjectorHealthy) { return @{ Action = 'wait'; Reason = 'healthy' } }
  if (-not $Snapshot.EndpointReady) {
    if ($Snapshot.MainHasDebugPort) { return @{ Action = 'wait'; Reason = 'debug-endpoint-not-ready' } }
    if (-not $Snapshot.AllowIdleRestart) { return @{ Action = 'wait'; Reason = 'restart-not-authorized' } }
    if ($Snapshot.StartedAtMs -le 0 -or $NowMs - $Snapshot.StartedAtMs -lt 10000) {
      return @{ Action = 'wait'; Reason = 'launch-grace' }
    }
    if ($State.RestartLatched) { return @{ Action = 'wait'; Reason = 'restart-latched' } }
  }
  if ($State.LastAttemptAt -and $NowMs - $State.LastAttemptAt -lt 300000) {
    return @{ Action = 'wait'; Reason = 'cooldown' }
  }
  if ($Snapshot.EndpointReady) { return @{ Action = 'repair'; Reason = 'injector-missing' } }
  return @{ Action = 'restart'; Reason = 'plain-launch' }
}

function Get-DreamSkinAutostartInventory {
  param([AllowEmptyCollection()][object[]]$Installs)
  # One complete inventory is essential: a stale Store path, inaccessible
  # command line, or failed WMI query is not evidence that the app closed.
  $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction Stop)
  $mains = @()
  foreach ($item in $processes) {
    if (-not $item.CommandLine) { return @{ MainCount = -1; Mains = @() } }
    try { $tokens = ConvertFrom-DreamSkinProcessCommandLine -CommandLine $item.CommandLine }
    catch { return @{ MainCount = -1; Mains = @() } }
    if ($tokens.Count -eq 0) { return @{ MainCount = -1; Mains = @() } }
    if (@($tokens | Where-Object { $_ -ceq '--type' -or $_.StartsWith('--type=', [StringComparison]::Ordinal) }).Count -gt 0) { continue }
    if (-not (Test-DreamSkinProcessProfile -ProcessInfo $item -ProfilePath $null)) { continue }
    $executable = Get-DreamSkinProcessExecutablePath -ProcessInfo $item
    $matches = @($Installs | Where-Object { Test-DreamSkinPathEqual -Left $executable -Right $_.Executable })
    if (-not $executable -or $matches.Count -ne 1) { return @{ MainCount = -1; Mains = @() } }
    $debugFlag = @($tokens | Where-Object { $_ -ceq '--remote-debugging-port' -or $_.StartsWith('--remote-debugging-port=', [StringComparison]::Ordinal) }).Count -gt 0
    $mains += @{ Process = $item; Codex = $matches[0]; HasDebugPort = $debugFlag }
  }
  return @{ MainCount = $mains.Count; Mains = $mains }
}

function Update-DreamSkinAutostartCloseObservation {
  param([object]$State, [int]$MainCount, [double]$NowMs)
  if ($MainCount -ne 0) {
    $State.ClosedSince = 0
    return $false
  }
  # A new observer must also recognize a closed app after a computer/tray
  # restart. Clearing history still requires the operation lock and a second
  # complete inventory below, so an in-flight startup cannot rearm itself.
  if (-not $State.ClosedSince) { $State.ClosedSince = $NowMs; return $false }
  return $NowMs - $State.ClosedSince -ge 10000
}

function Reserve-DreamSkinAutostartAttempt {
  param([string]$StateRoot, [object]$Snapshot, [double]$NowMs)
  $attemptLock = $null
  try {
    $attemptLock = Enter-DreamSkinOperationLock -TimeoutMilliseconds 0
    $latest = Get-DreamSkinAutostartRestartState -StateRoot $StateRoot
    $decision = Get-DreamSkinAutostartDecision -Snapshot $Snapshot -State $latest -NowMs $NowMs
    if ($decision.Action -notin @('repair', 'restart')) {
      return @{ Granted = $false; State = $latest; Decision = $decision }
    }
    $latest.LastAttemptAt = $NowMs
    Write-DreamSkinAutostartRestartState -StateRoot $StateRoot -State $latest
    return @{ Granted = $true; State = $latest; Decision = $decision }
  } finally {
    if ($null -ne $attemptLock) { Exit-DreamSkinOperationLock -Mutex $attemptLock }
  }
}

# Dot sourcing exposes only policy/helper definitions for portable mock tests.
if ($MyInvocation.InvocationName -eq '.') { return }
$ErrorActionPreference = 'Stop'
if ($ParentProcessId -le 0 -or -not $ParentStartedAt) { throw 'A verified tray parent is required.' }
. (Join-Path $PSScriptRoot 'theme-windows.ps1')
$explicitPort = $PSBoundParameters.ContainsKey('Port')
$StateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'
$consentPath = Join-Path $StateRoot 'autostart-idle-restart.enabled'
$node = Get-DreamSkinNodeRuntime
$shellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = [System.Threading.Mutex]::new($false, "Local\CodexDreamSkin.$sid.Autostart")
$acquired = $false
$watchState = @{ RestartLatched = $false; LastAttemptAt = 0 }
$lastReason = ''
$lastActivityProbeAt = 0
$closeObservation = @{ ClosedSince = 0 }

function Test-DreamSkinAutostartParent {
  $parent = $null
  try {
    $parent = Get-Process -Id $ParentProcessId -ErrorAction Stop
    [void]$parent.Handle
    return -not $parent.HasExited -and $parent.StartTime.ToUniversalTime().ToString('o') -ceq $ParentStartedAt
  } catch { return $false } finally { if ($null -ne $parent) { $parent.Dispose() } }
}

function Write-DreamSkinAutostartReason([string]$Reason) {
  if ($Reason -ceq $script:lastReason) { return }
  $script:lastReason = $Reason
  # A bounded last-status file avoids a polling log growing indefinitely.
  Write-DreamSkinUtf8FileAtomically -Path (Join-Path $StateRoot 'autostart-status.json') -Content (
    @{ reason = $Reason; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)
}

try {
  try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { exit 0 }
  Ensure-DreamSkinManagedDirectory -Path $StateRoot -Root $StateRoot
  $installs = @()
  $lastInstallProbe = 0
  $installProbeInterval = 60000
  while (Test-DreamSkinAutostartParent) {
    $delay = 2000
    try {
      if (-not (Test-Path -LiteralPath $StateRoot -PathType Container)) { break }
      # The startup child may have armed a latch since our previous snapshot.
      $watchState = Get-DreamSkinAutostartRestartState -StateRoot $StateRoot
      $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      if ($now - $lastInstallProbe -ge $installProbeInterval) {
        $installs = @(Get-DreamSkinRegisteredCodexInstalls)
        $lastInstallProbe = $now
      }
      $inventory = Get-DreamSkinAutostartInventory -Installs $installs
      $mains = @($inventory.Mains)
      # Refresh updated package metadata promptly without running expensive
      # Appx discovery on every two-second poll while an identity is unknown.
      $installProbeInterval = if ($inventory.MainCount -lt 0) { 10000 } else { 60000 }
      $closedConfirmed = Update-DreamSkinAutostartCloseObservation -State $closeObservation `
        -MainCount $inventory.MainCount -NowMs $now
      $paused = Test-DreamSkinPaused -StateRoot $StateRoot
      $state = Read-DreamSkinState -Path (Join-Path $StateRoot 'state.json')
      # Never adopt state from a user's separately managed test instance.
      $profileMatches = Test-DreamSkinStateProfileMatch -State $state -ProfilePath $null
      $snapshot = @{ MainCount = $inventory.MainCount; Enabled = $profileMatches; Paused = $paused;
        EndpointReady = $false; InjectorHealthy = $false; StartedAtMs = 0; MainHasDebugPort = $false;
        AllowIdleRestart = (Test-Path -LiteralPath $consentPath -PathType Leaf) }
      $currentPort = if (-not $explicitPort -and $state -and $state.port) { [int]$state.port } else { $Port }
      if ($mains.Count -eq 1 -and $profileMatches -and -not $paused) {
        $main = $mains[0]
        $snapshot.MainHasDebugPort = $main.HasDebugPort
        $startedAt = Get-DreamSkinProcessStartedAt -ProcessId ([int]$main.Process.ProcessId)
        if ($startedAt) { $snapshot.StartedAtMs = [DateTimeOffset]::Parse($startedAt).ToUnixTimeMilliseconds() }
        $identity = Get-DreamSkinVerifiedCdpIdentity -Port $currentPort -Codex $main.Codex
        $snapshot.EndpointReady = $null -ne $identity
        $snapshot.InjectorHealthy = $snapshot.EndpointReady -and $state -and
          $state.browserId -ceq $identity.BrowserId -and (Test-DreamSkinRecordedInjectorAlive -State $state)
      }
      $decision = Get-DreamSkinAutostartDecision -Snapshot $snapshot -State $watchState -NowMs $now
      if ($decision.Action -eq 'stopped') {
        if ($closedConfirmed -and ($watchState.RestartLatched -or $watchState.LastAttemptAt)) {
          # A crashed observer can leave a child startup in progress. Take the
          # same operation lock and re-enumerate before clearing restart history.
          $closeLock = $null
          try {
            $closeLock = Enter-DreamSkinOperationLock -TimeoutMilliseconds 0
            $closingInventory = Get-DreamSkinAutostartInventory -Installs $installs
            if ($closingInventory.MainCount -eq 0) {
              $watchState = @{ RestartLatched = $false; LastAttemptAt = 0 }
              Write-DreamSkinAutostartRestartState -StateRoot $StateRoot -State $watchState
              $closeObservation = @{ ClosedSince = 0 }
            } else { $closeObservation.ClosedSince = 0 }
          } finally { if ($null -ne $closeLock) { Exit-DreamSkinOperationLock -Mutex $closeLock } }
        }
      } elseif ($decision.Action -in @('repair', 'restart')) {
        if ($decision.Action -eq 'restart') {
          if ($now - $lastActivityProbeAt -lt 30000) { Start-Sleep -Milliseconds $delay; continue }
          $lastActivityProbeAt = $now
          $codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
          $activityResult = Invoke-DreamSkinNative -FilePath $node.Path -ArgumentList @(
            (Join-Path $PSScriptRoot 'session-activity.mjs'), '--sessions-root', (Join-Path $codexRoot 'sessions'),
            '--app-started-at-ms', "$($snapshot.StartedAtMs)")
          $activity = if ($activityResult.ExitCode -eq 0) { ($activityResult.Output -join "`n") | ConvertFrom-Json } else { $null }
          if (-not $activity -or $activity.status -cne 'idle' -or $activity.activeCount -ne 0) {
            Write-DreamSkinAutostartReason 'active-task-or-unknown-preserved'
            Start-Sleep -Milliseconds $delay
            continue
          }
        }
        if (-not (Test-DreamSkinAutostartParent) -or (Test-DreamSkinPaused -StateRoot $StateRoot)) { continue }
        $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned',
          '-File', (Join-Path $PSScriptRoot 'start-dream-skin.ps1'), '-RequireUnpaused',
          '-ParentProcessId', "$ParentProcessId", '-ParentStartedAt', $ParentStartedAt)
        if ($explicitPort -or $snapshot.EndpointReady) { $arguments += @('-Port', "$currentPort") }
        if ($decision.Action -eq 'repair') { $arguments += '-RepairWatcherOnly' }
        else {
          # The start command repeats the idle and process-identity checks under
          # its operation lock immediately before requesting a graceful close.
          $arguments += @('-AutoRestartIdleOnly', '-ExpectedCodexPid', "$($main.Process.ProcessId)",
            '-ExpectedCodexStartedAt', $startedAt)
        }
        # Dispatch is not a restart. Refusal by a busy operation, new task, or
        # revoked consent must leave only the retry cooldown, never a latch.
        $reservation = Reserve-DreamSkinAutostartAttempt -StateRoot $StateRoot -Snapshot $snapshot `
          -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        $watchState = $reservation.State
        if (-not $reservation.Granted) {
          Write-DreamSkinAutostartReason $reservation.Decision.Reason
          continue
        }
        Write-DreamSkinAutostartReason ($decision.Action + '-started')
        $result = Invoke-DreamSkinNative -FilePath $shellPath -ArgumentList $arguments
        $watchState = Get-DreamSkinAutostartRestartState -StateRoot $StateRoot
        Write-DreamSkinAutostartReason ($decision.Action + '-exit-' + $result.ExitCode)
      } else {
        Write-DreamSkinAutostartReason $decision.Reason
        if ($decision.Reason -eq 'healthy') { $delay = 10000 }
      }
    } catch {
      # Inspection failure is not proof that Codex is closed or idle.
      $closeObservation.ClosedSince = 0
      try { Write-DreamSkinAutostartReason 'inspection-failed-preserved' } catch {}
      $delay = 10000
    }
    Start-Sleep -Milliseconds $delay
  }
} finally {
  if ($acquired) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
