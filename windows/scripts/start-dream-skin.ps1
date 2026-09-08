[CmdletBinding()]
param(
  [int]$Port = 9335,
  [switch]$RestartExisting,
  [switch]$PromptRestart,
  [switch]$RepairWatcherOnly,
  [switch]$AutoRestartIdleOnly,
  [int]$ExpectedCodexPid = 0,
  [string]$ExpectedCodexStartedAt,
  [int]$ParentProcessId = 0,
  [string]$ParentStartedAt,
  [string]$ProfilePath,
  [switch]$ForegroundInjector,
  [ValidateRange(0, 300000)][int]$OperationLockTimeoutMilliseconds = 0,
  [switch]$RequireUnpaused,
  [ValidatePattern('^[a-f0-9]{32}$')][string]$ResultToken
)

$ErrorActionPreference = 'Stop'
$PortExplicit = $PSBoundParameters.ContainsKey('Port')
$Injector = Join-Path $PSScriptRoot 'injector.mjs'
. (Join-Path $PSScriptRoot 'common-windows.ps1')
. (Join-Path $PSScriptRoot 'theme-windows.ps1')
. (Join-Path $PSScriptRoot 'localization-windows.ps1')

function Invoke-DreamSkinStartupAppearanceRecovery {
  param(
    [AllowNull()][object]$Transaction,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$BackupPath
  )
  if ($null -eq $Transaction) { return 'not-needed' }
  try {
    $result = Restore-DreamSkinManagedAppearanceSnapshot `
      -ConfigPath $ConfigPath -BackupPath $BackupPath -Transaction $Transaction
    if ($result.ConflictedKeys.Count -gt 0 -or
      "$($result.MarkerStatus)" -ceq 'conflict-preserved') {
      Write-Warning 'Startup appearance recovery preserved newer user changes instead of overwriting them.'
      return 'conflict-preserved'
    }
    return 'restored'
  } catch {
    Write-Warning 'Startup appearance recovery could not commit safely; the current config and ownership marker were preserved.'
    return 'blocked'
  }
}

function Test-DreamSkinRenderedVerificationOutput {
  param([AllowEmptyCollection()][object[]]$Output)
  try {
    $payload = ($Output -join "`n") | ConvertFrom-Json -ErrorAction Stop
    foreach ($target in @($payload.targets)) {
      $result = $target.result
      $readiness = $result.readiness
      if ($result.installed -is [bool] -and [bool]$result.installed -and
        $result.stylePresent -is [bool] -and [bool]$result.stylePresent -and
        $readiness.documentPass -is [bool] -and [bool]$readiness.documentPass -and
        $readiness.viewportPass -is [bool] -and [bool]$readiness.viewportPass -and
        $readiness.structurePass -is [bool] -and [bool]$readiness.structurePass) {
        return $true
      }
    }
  } catch {
    return $false
  }
  return $false
}

function Start-DreamSkinCodexAfterRollback {
  param(
    [Parameter(Mandatory = $true)][object]$Codex,
    [string]$ProfilePath
  )
  if ($ProfilePath) {
    # Package activation has already proved that it can reinterpret arguments
    # as a codex:// navigation. Use only the validated Store executable here;
    # if Windows refuses it, fail closed instead of accidentally opening the
    # ordinary profile after an isolated-profile rollback.
    return Start-DreamSkinCodexDirect -Codex $Codex `
      -Arguments @("--user-data-dir=$ProfilePath")
  }
  return Start-DreamSkinCodex -Codex $Codex
}

function Assert-DreamSkinExpectedCodexProcess {
  param([object]$Codex, [int]$ExpectedProcessId, [string]$ExpectedStartedAt)
  if ($ExpectedProcessId -le 0 -or $ExpectedStartedAt -notmatch '(?:Z|[+-]\d{2}:\d{2})$') {
    throw 'Automatic restart requires an exact Codex PID and timezone-qualified start time.'
  }
  $expectedStart = [datetimeoffset]::Parse($ExpectedStartedAt)
  $matches = @(Get-DreamSkinCodexProcesses -Codex $Codex | Where-Object { [int]$_.ProcessId -eq $ExpectedProcessId })
  if ($matches.Count -ne 1) { throw 'The expected Codex process is no longer active; automatic restart was cancelled.' }
  $processHandle = $null
  try {
    $processHandle = Get-Process -Id $ExpectedProcessId -ErrorAction Stop
    [void]$processHandle.Handle
    if ($processHandle.HasExited -or
      -not (Test-DreamSkinPathEqual -Left "$($processHandle.Path)" -Right $Codex.Executable) -or
      $processHandle.StartTime.ToUniversalTime() -ne $expectedStart.UtcDateTime) {
      throw 'The expected Codex process identity changed; automatic restart was cancelled.'
    }
  } finally {
    if ($null -ne $processHandle) { $processHandle.Dispose() }
  }
}

function Assert-DreamSkinAutomaticStartupParent {
  param([int]$ProcessId, [string]$StartedAt)
  if ($ProcessId -le 0 -or $StartedAt -notmatch '(?:Z|[+-]\d{2}:\d{2})$') {
    throw 'Automatic startup requires an exact parent PID and timezone-qualified start time.'
  }
  $expectedStart = [datetimeoffset]::Parse($StartedAt)
  $parentHandle = $null
  try {
    $parentHandle = Get-Process -Id $ProcessId -ErrorAction Stop
    [void]$parentHandle.Handle
    if ($parentHandle.HasExited -or $parentHandle.StartTime.ToUniversalTime() -ne $expectedStart.UtcDateTime) {
      throw 'The automatic startup owner exited or changed; pending work was cancelled.'
    }
  } finally {
    if ($null -ne $parentHandle) { $parentHandle.Dispose() }
  }
}

function Assert-DreamSkinAutomaticRestartConsent {
  param([string]$StateRoot)
  if (-not (Test-Path -LiteralPath (Join-Path $StateRoot 'autostart-idle-restart.enabled') -PathType Leaf)) {
    throw 'Automatic restart consent was removed; Codex was preserved.'
  }
}

function Assert-DreamSkinAutomaticRestartIdle {
  param([object]$Codex, [int]$ExpectedProcessId, [string]$ExpectedStartedAt,
    [string]$NodePath, [string]$ActivityScript)
  Assert-DreamSkinExpectedCodexProcess -Codex $Codex -ExpectedProcessId $ExpectedProcessId -ExpectedStartedAt $ExpectedStartedAt
  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
  $startedAtMs = ([datetimeoffset]::Parse($ExpectedStartedAt)).ToUnixTimeMilliseconds()
  $probe = Invoke-DreamSkinNative -FilePath $NodePath -ArgumentList @(
    $ActivityScript, '--sessions-root', (Join-Path $codexHome 'sessions'),
    '--app-started-at-ms', "$startedAtMs") -DiscardStderr
  if ($probe.ExitCode -ne 0) { throw 'Session activity could not be confirmed; Codex was not restarted.' }
  $activity = ($probe.Output -join "`n") | ConvertFrom-Json -ErrorAction Stop
  if ($null -eq $activity -or $activity -is [array] -or $activity.status -cne 'idle' -or
    ($activity.activeCount -isnot [int] -and $activity.activeCount -isnot [long]) -or $activity.activeCount -ne 0) {
    throw 'Codex is busy or session activity is unknown; automatic restart was deferred.'
  }
  # Recheck after reading sessions. The stop helper also binds its final
  # kernel handles to this identity before sending any close request.
  Assert-DreamSkinExpectedCodexProcess -Codex $Codex -ExpectedProcessId $ExpectedProcessId -ExpectedStartedAt $ExpectedStartedAt
}

$StateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'
$ConfigPath = Join-Path $HOME '.codex\config.toml'
$BackupPath = Join-Path $StateRoot 'config.before-dream-skin.toml'
$operationLock = $null
$startFailureCategory = 'internal-start-failure'
$appearanceTransaction = $null
$appearanceRecovery = 'not-needed'
try {
  $operationLock = Enter-DreamSkinOperationLock `
    -TimeoutMilliseconds $OperationLockTimeoutMilliseconds
  if ($RepairWatcherOnly -and $AutoRestartIdleOnly) { throw 'Watcher-only repair and automatic restart are mutually exclusive.' }
  if (($RepairWatcherOnly -or $AutoRestartIdleOnly) -and ($RestartExisting -or $PromptRestart -or $ForegroundInjector)) {
    throw 'Automatic startup cannot be combined with interactive or forced startup options.'
  }
  if ($AutoRestartIdleOnly -and $ProfilePath) { throw 'Automatic restart is limited to the default Codex profile.' }
  if ($RepairWatcherOnly -or $AutoRestartIdleOnly) {
    $RequireUnpaused = $true
    # A queued worker loses authority when its observing tray exits. Bind the
    # process identity again after the lock, not only when work was enqueued.
    Assert-DreamSkinAutomaticStartupParent -ProcessId $ParentProcessId -StartedAt $ParentStartedAt
  }
  if ($AutoRestartIdleOnly) { Assert-DreamSkinAutomaticRestartConsent -StateRoot $StateRoot }
  Assert-DreamSkinPort -Port $Port
  if ($ProfilePath) { $ProfilePath = [System.IO.Path]::GetFullPath($ProfilePath) }
  $node = Get-DreamSkinNodeRuntime
  $currentCodex = Get-DreamSkinCodexInstall
  $codex = $currentCodex
  $language = Resolve-DreamSkinLanguage -StateRoot $StateRoot
  $themePaths = Get-DreamSkinThemePaths -StateRoot $StateRoot
  Ensure-DreamSkinManagedDirectory -Path $themePaths.Root -Root $themePaths.Root
  $StatePath = Join-Path $StateRoot 'state.json'
  $StdoutPath = Join-Path $StateRoot 'injector.log'
  $StderrPath = Join-Path $StateRoot 'injector-error.log'
  $VerifyPath = Join-Path $StateRoot 'verify.log'
  $themePaths = Initialize-DreamSkinThemeStore -SkillRoot (Split-Path -Parent $PSScriptRoot) -StateRoot $StateRoot
  $pauseWasSet = Test-DreamSkinPaused -StateRoot $StateRoot
  if ($RequireUnpaused -and $pauseWasSet) {
    $startFailureCategory = 'superseded'
    throw 'A newer pause request superseded this theme apply before renderer verification.'
  }

  $previousState = Read-DreamSkinState -Path $StatePath
  if (-not (Test-DreamSkinStateProfileMatch -State $previousState -ProfilePath $ProfilePath)) {
    throw 'Existing Dream Skin state belongs to a different Codex profile. Stop or restore that managed session before starting another profile.'
  }
  if (-not $PortExplicit -and $null -ne $previousState -and $previousState.port) {
    $savedPort = [int]$previousState.port
    Assert-DreamSkinPort -Port $savedPort
    $Port = $savedPort
  }
  $savedPathCandidate = Get-DreamSkinCodexStatePathCandidate -State $previousState
  $savedCodex = Get-DreamSkinCodexInstallFromState -State $previousState
  $candidateMatchesCurrent = [bool]($null -ne $savedPathCandidate -and
    (Test-DreamSkinPathEqual -Left $savedPathCandidate.PackageRoot -Right $currentCodex.PackageRoot) -and
    (Test-DreamSkinPathEqual -Left $savedPathCandidate.Executable -Right $currentCodex.Executable))
  if ($null -ne $savedPathCandidate -and $null -eq $savedCodex -and -not $candidateMatchesCurrent) {
    $unverifiedSavedRunning = @(Get-DreamSkinCodexProcesses -Codex $savedPathCandidate -ProfilePath $ProfilePath).Count -gt 0
    $unverifiedSavedOwnsPort = Test-DreamSkinCodexPortOwner -Port $Port -Codex $savedPathCandidate -ProfilePath $ProfilePath
    if ($unverifiedSavedRunning -or $unverifiedSavedOwnsPort) {
      throw 'The saved Codex path is still active but no longer matches a registered OpenAI.Codex package. Close it manually; state was preserved.'
    }
  }

  # Function output enumerates arrays; collect it again before using Count
  # (in particular, PS5.1 singleton PSCustomObject.Count can be null).
  $currentProcesses = @(Get-DreamSkinCodexProcesses -Codex $currentCodex -ProfilePath $ProfilePath)
  $codexToStop = $currentCodex
  $cdpIdentity = Get-DreamSkinVerifiedCdpIdentity -Port $Port -Codex $currentCodex -ProfilePath $ProfilePath
  if ($null -eq $cdpIdentity) {
    # After a Store auto-update the running (older) package still owns the
    # verified endpoint while Get-DreamSkinCodexInstall already resolves to
    # the new one.  Adopt the running install instead of restarting it.
    $runningRegistered = Get-DreamSkinVerifiedCdpIdentityForAnyRegistered -Port $Port -ProfilePath $ProfilePath
    if ($null -ne $runningRegistered) {
      $cdpIdentity = $runningRegistered.Identity
      $codex = $runningRegistered.Codex
      $codexToStop = $runningRegistered.Codex
    }
  }
  $savedIsDifferent = [bool]($null -ne $savedCodex -and
    -not (Test-DreamSkinPathEqual -Left $savedCodex.Executable -Right $currentCodex.Executable))
  if ($savedIsDifferent) {
    $savedProcesses = @(Get-DreamSkinCodexProcesses -Codex $savedCodex -ProfilePath $ProfilePath)
    $savedOwnsPort = Test-DreamSkinCodexPortOwner -Port $Port -Codex $savedCodex -ProfilePath $ProfilePath
    if ($currentProcesses.Count -gt 0 -and ($savedProcesses.Count -gt 0 -or $savedOwnsPort)) {
      throw 'Multiple registered Codex package versions are active. Close them manually before starting Dream Skin.'
    }
    if ($savedProcesses.Count -gt 0 -or $savedOwnsPort) {
      if ($savedOwnsPort -and $savedProcesses.Count -eq 0) {
        throw 'The saved Codex listener is active but its process cannot be managed safely; state was preserved.'
      }
      $savedIdentity = Get-DreamSkinVerifiedCdpIdentity -Port $Port -Codex $savedCodex -ProfilePath $ProfilePath
      if ($null -ne $savedIdentity) {
        $codex = $savedCodex
        $codexToStop = $savedCodex
        $cdpIdentity = $savedIdentity
        Write-Warning 'Reapplying Dream Skin to the still-running registered Codex version; the current Store version will be used after that app exits.'
      } else {
        $codexToStop = $savedCodex
        $currentProcesses = $savedProcesses
      }
    }
  }
  $pendingAppearanceTransaction = Test-DreamSkinPendingAppearanceTransaction `
    -BackupPath $BackupPath
  if ($ProfilePath -and $pendingAppearanceTransaction) {
    throw 'Pending global Codex appearance recovery belongs to the default profile. Recover it before starting an isolated profile.'
  }
  if ($pendingAppearanceTransaction) {
    # A previous process ended before it could commit or recover appearance.
    # Do not reuse its live session: the locked restart path closes Codex first,
    # then Install-DreamSkinBaseTheme performs the durable three-way recovery.
    $appearanceRecovery = 'blocked'
    $cdpIdentity = $null
  }
  $debugReady = $null -ne $cdpIdentity
  $codexProcesses = @(if (Test-DreamSkinPathEqual -Left $codexToStop.Executable -Right $currentCodex.Executable) {
    $currentProcesses
  } else {
    Get-DreamSkinCodexProcesses -Codex $codexToStop -ProfilePath $ProfilePath
  })
  $closedExistingCodex = $false
  if ($RepairWatcherOnly -and -not $debugReady) {
    throw 'Watcher-only repair requires an existing verified CDP endpoint; Codex was not launched or restarted.'
  }
  if ($AutoRestartIdleOnly) {
    Assert-DreamSkinExpectedCodexProcess -Codex $codexToStop -ExpectedProcessId $ExpectedCodexPid -ExpectedStartedAt $ExpectedCodexStartedAt
  }
  if ($ProfilePath -and -not $debugReady -and
      ($codexProcesses.Count -gt 0 -or -not (Test-DreamSkinPortAvailable -Port $Port))) {
    throw 'The requested profile has no verified endpoint. Existing processes were preserved; use an independently verified profile and port.'
  }
  if (-not $debugReady -and $codexProcesses.Count -gt 0) {
    $restartAuthorized = [bool]$RestartExisting
    if ($AutoRestartIdleOnly) {
      Assert-DreamSkinAutomaticRestartIdle -Codex $codexToStop -ExpectedProcessId $ExpectedCodexPid `
        -ExpectedStartedAt $ExpectedCodexStartedAt -NodePath $node.Path `
        -ActivityScript (Join-Path (Split-Path -Parent $Injector) 'session-activity.mjs')
      $restartAuthorized = $true
    }
    if (-not $restartAuthorized -and $PromptRestart) {
      $restartAuthorized = Confirm-DreamSkinRestart -Message `
        (Get-DreamSkinText -Key 'RestartPrompt' -Language $language)
      if (-not $restartAuthorized) {
        Write-Host (Get-DreamSkinText -Key 'LaunchCancelled' -Language $language)
        exit 0
      }
    }
    if (-not $restartAuthorized) {
      throw 'Codex is open without a verified Dream Skin CDP endpoint. Close it first or explicitly use -RestartExisting.'
    }
    if ($AutoRestartIdleOnly) {
      Assert-DreamSkinAutomaticStartupParent -ProcessId $ParentProcessId -StartedAt $ParentStartedAt
      Assert-DreamSkinAutomaticRestartConsent -StateRoot $StateRoot
      # We still hold the operation lock and have passed the final idle,
      # parent, consent, and process checks. Arm durably only at the actual
      # close boundary; no later failure is allowed to unlatch this attempt.
      $restartHistory = Get-DreamSkinAutostartRestartState -StateRoot $StateRoot
      if ($restartHistory.RestartLatched) {
        throw 'An automatic restart was already attempted or its history is uncertain; Codex was preserved.'
      }
      $restartHistory.RestartLatched = $true
      $restartHistory.LastAttemptAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      Write-DreamSkinAutostartRestartState -StateRoot $StateRoot -State $restartHistory
      Stop-DreamSkinCodex -Codex $codexToStop -ExpectedProcessId $ExpectedCodexPid -ExpectedStartedAt $ExpectedCodexStartedAt
    } else {
      Stop-DreamSkinCodex -Codex $codexToStop -ProfilePath $ProfilePath -AllowForce
    }
    $closedExistingCodex = $true
    $codex = $currentCodex
  }

  $launchedWithCdp = $false
  $debugLaunchAttempted = $false
  $debugLaunch = $null
  $debugLaunchBaselineProcessIds = @()
  # Set by the verify loop when the renderer reports a visible, structurally
  # complete skin even though verification did not pass overall.
  $skinLooksRendered = $false
  try {
    if ($pendingAppearanceTransaction) {
      $startFailureCategory = 'state-reconciliation-failed'
      try {
        $pendingRecovery = Resolve-DreamSkinPendingAppearanceTransaction `
          -ConfigPath $ConfigPath -BackupPath $BackupPath
        if ($null -ne $pendingRecovery -and
          ($pendingRecovery.ConflictedKeys.Count -gt 0 -or
            "$($pendingRecovery.MarkerStatus)" -ceq 'conflict-preserved')) {
          Write-Warning 'Interrupted appearance recovery preserved newer user changes.'
        }
        $pendingAppearanceTransaction = $false
      } catch {
        $appearanceRecovery = 'blocked'
        throw 'Interrupted startup appearance could not be recovered safely; config was preserved.'
      }
    }
    if ($null -eq (Get-DreamSkinVerifiedCdpIdentity -Port $Port -Codex $codex -ProfilePath $ProfilePath)) {
      if ($RepairWatcherOnly -or ($AutoRestartIdleOnly -and -not $closedExistingCodex)) {
        throw 'The existing endpoint disappeared; automatic watcher repair will not relaunch Codex.'
      }
      # Codex is closed on this path; sync the appearanceTheme pin to the
      # active theme before launching (config writes race the app while it runs).
      if (-not $ProfilePath) {
        try {
          $appearanceTransaction = Install-DreamSkinBaseTheme `
            -ConfigPath $ConfigPath -BackupPath $BackupPath `
            -AppearanceTheme (Get-DreamSkinActiveThemeAppearance -ThemeDirectory $themePaths.Active) `
            -PassThruTransaction
          if ($null -ne $appearanceTransaction) { $appearanceRecovery = 'retained' }
        } catch {
          $appearanceTransaction = $null
          $appearanceRecovery = 'not-needed'
          Write-Warning "Could not sync Codex appearanceTheme to the active theme: $($_.Exception.Message)"
        }
      }
      $startFailureCategory = 'port-unavailable'
      if (-not (Test-DreamSkinPortAvailable -Port $Port)) {
        if ($PortExplicit) { throw "Port $Port is already occupied by an unverified listener. Choose another port." }
        $Port = Select-DreamSkinPort -PreferredPort $Port
      }
      $arguments = @(
        '--remote-debugging-address=127.0.0.1',
        "--remote-debugging-port=$Port"
      )
      if (Test-DreamSkinBackgroundPlaybackEnabled -StateRoot $StateRoot) {
        $arguments += @(
          '--disable-background-media-suspend',
          '--disable-backgrounding-occluded-windows',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding'
        )
      }
      if ($ProfilePath) {
        New-Item -ItemType Directory -Force -Path $ProfilePath | Out-Null
        $arguments += "--user-data-dir=$ProfilePath"
      }
      $debugLaunchAttempted = $true
      $debugLaunchBaselineProcessIds = @(
        Get-DreamSkinCodexProcesses -Codex $codex -AllProfiles | ForEach-Object { [int]$_.ProcessId }
      )
      $startFailureCategory = 'cdp-launch-failed'
      $debugLaunch = Start-DreamSkinCodexForDebugging -Codex $codex -Arguments $arguments `
        -Port $Port -ProfilePath $ProfilePath -PreserveProcessIds $debugLaunchBaselineProcessIds
      $launchedWithCdp = $true
      if ($debugLaunch.Strategy -eq 'direct-store-executable') {
        Write-Warning 'Codex package activation did not preserve the CDP arguments; using the validated Store executable fallback for this session.'
      }
    }

    $startFailureCategory = 'cdp-endpoint-unavailable'
    $deadline = (Get-Date).AddSeconds(45)
    $cdpIdentity = Get-DreamSkinVerifiedCdpIdentity -Port $Port -Codex $codex -ProfilePath $ProfilePath
    while ($null -eq $cdpIdentity) {
      $argumentStatus = Get-DreamSkinCodexDebugArgumentStatus `
        -Processes @(Get-DreamSkinCodexProcesses -Codex $codex -ProfilePath $ProfilePath) -Port $Port
      if ($argumentStatus -eq 'protocol-redirected') {
        throw "Codex $($codex.Version) converted the CDP argument into a codex:// navigation path instead of opening a debugging endpoint."
      }
      if ((Get-Date) -ge $deadline) {
        if ($null -ne $debugLaunch -and $debugLaunch.Strategy -eq 'direct-store-executable') {
          throw "The validated direct Store executable fallback did not expose a verified loopback CDP endpoint on port $Port within 45 seconds. Codex $($codex.Version) may disable CDP in this production runtime; no protected app files or permissions were changed."
        }
        throw "Codex did not expose a verified loopback CDP endpoint on port $Port within 45 seconds."
      }
      Start-Sleep -Milliseconds 400
      $cdpIdentity = Get-DreamSkinVerifiedCdpIdentity -Port $Port -Codex $codex -ProfilePath $ProfilePath
    }
  } catch {
    $launchError = $_
    if ($debugLaunchAttempted -and -not $AutoRestartIdleOnly) {
      try {
        Stop-DreamSkinCodex -Codex $codex -ProfilePath $ProfilePath `
          -PreserveProcessIds $debugLaunchBaselineProcessIds -AllowForce
      } catch {
        Write-Warning 'Launch rollback could not fully close the failed CDP session.'
      }
    }
    $failedLaunchClosed = (Get-DreamSkinCodexProcesses -Codex $codex -ProfilePath $ProfilePath).Count -eq 0
    if ($null -ne $appearanceTransaction) {
      if ($failedLaunchClosed) {
        $appearanceRecovery = Invoke-DreamSkinStartupAppearanceRecovery `
          -Transaction $appearanceTransaction -ConfigPath $ConfigPath -BackupPath $BackupPath
      } else {
        $appearanceRecovery = 'blocked'
        Write-Warning 'Startup appearance recovery was blocked because the failed Codex process could not be confirmed closed.'
      }
    }
    if (-not $AutoRestartIdleOnly -and ($closedExistingCodex -or $debugLaunchAttempted) -and $failedLaunchClosed) {
      if ($debugLaunchAttempted) {
        Write-Warning 'Dream Skin launch failed; reopening Codex without a debugging port.'
      }
      try { $null = Start-DreamSkinCodexAfterRollback -Codex $codex -ProfilePath $ProfilePath } catch {
        Write-Warning 'Launch rollback could not reopen Codex automatically.'
      }
    }
    throw $launchError
  }

  $startFailureCategory = 'state-reconciliation-failed'
  $pauseCleared = $false
  try {
    if (($RepairWatcherOnly -or $AutoRestartIdleOnly) -and -not $closedExistingCodex) {
      Assert-DreamSkinAutomaticStartupParent -ProcessId $ParentProcessId -StartedAt $ParentStartedAt
    }
    # Once this operation has closed Codex, finish reopening and restoring the
    # watcher even if the owner exits: cancellation must not strand a closed app.
    $recordedInjectorStopped = Stop-DreamSkinRecordedInjector -State $previousState
    if (-not $recordedInjectorStopped) {
      $staleStatePath = Archive-DreamSkinStateFile -Path $StatePath
      Write-Warning "Archived stale Dream Skin state at $staleStatePath"
    }
    # Keep a paused, already-running watcher paused until all state checks and
    # restart consent have succeeded. A cancelled prompt stays side-effect free.
    Set-DreamSkinPaused -Paused $false -StateRoot $StateRoot | Out-Null
    $pauseCleared = $true
  } catch {
    if ($launchedWithCdp -and -not $AutoRestartIdleOnly) {
      $stateRollbackClosed = $false
      try {
        Stop-DreamSkinCodex -Codex $codex -ProfilePath $ProfilePath -AllowForce
        $stateRollbackClosed = (Get-DreamSkinCodexProcesses -Codex $codex -ProfilePath $ProfilePath).Count -eq 0
      } catch {
        $stateRollbackClosed = $false
      }
      if ($stateRollbackClosed) {
        $appearanceRecovery = Invoke-DreamSkinStartupAppearanceRecovery `
          -Transaction $appearanceTransaction -ConfigPath $ConfigPath -BackupPath $BackupPath
        try { $null = Start-DreamSkinCodexAfterRollback -Codex $codex -ProfilePath $ProfilePath } catch {
          Write-Warning 'State validation rollback could not reopen Codex automatically.'
        }
      } else {
        if ($null -ne $appearanceTransaction) { $appearanceRecovery = 'blocked' }
        Write-Warning 'State validation rollback could not fully close Codex; close Codex to ensure its CDP port is closed.'
      }
    }
    if ($pauseWasSet) {
      try { Set-DreamSkinPaused -Paused $true -StateRoot $StateRoot | Out-Null } catch {
        Write-Warning 'State validation rollback could not restore the existing paused state.'
      }
    }
    throw
  }

  $backgroundPlaybackCapable = Test-DreamSkinBackgroundPlaybackCapable `
    -Codex $codex -ProfilePath $ProfilePath

  if ($ForegroundInjector) {
    $startFailureCategory = 'injector-start-failed'
    $foregroundStopwatch = $null
    $foregroundSuperseded = $true
    $foregroundLockReleased = $false
    $foregroundBaselinePause = $null
    $foregroundBaselineFingerprint = $null
    try {
      Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
      $foregroundBaselinePause = [bool](Test-DreamSkinPaused -StateRoot $StateRoot)
      $foregroundBaselineFingerprint = Get-DreamSkinThemeRuntimeContentFingerprint `
        -ThemeDirectory $themePaths.Active
      if ($null -ne $appearanceTransaction) {
        Complete-DreamSkinAppearanceTransaction `
          -BackupPath $BackupPath -Transaction $appearanceTransaction
      }
      Exit-DreamSkinOperationLock -Mutex $operationLock
      $operationLock = $null
      $foregroundLockReleased = $true
      $foregroundStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
      $foregroundArgs = @($Injector, '--watch', '--port', "$Port", '--browser-id',
        $cdpIdentity.BrowserId, '--theme-dir', $themePaths.Active, '--pause-file',
        $themePaths.PauseFile, '--theme-library', $themePaths.Saved,
        '--settings', (Join-Path $themePaths.Root 'dynamic-settings.json'))
      if ($backgroundPlaybackCapable) { $foregroundArgs += '--background-playback-capable' }
      & $node.Path @foregroundArgs
      $foregroundExitCode = $LASTEXITCODE
      if ($foregroundExitCode -ne 0) {
        throw "The foreground injector exited during startup (exit code $foregroundExitCode)."
      }
      if ($ResultToken) {
        Write-DreamSkinStartResult -StateRoot $StateRoot -Token $ResultToken `
          -Outcome 'success' -Category 'none' -AppearanceRecovery $appearanceRecovery
      }
      exit 0
    } catch {
      $foregroundError = $_
      $foregroundImmediateFailure = $null -eq $foregroundStopwatch -or
        $foregroundStopwatch.Elapsed.TotalSeconds -lt 10
      if (-not $foregroundImmediateFailure) {
        Write-Warning 'The foreground injector ended after its startup window; current Codex and appearance state were preserved.'
        throw $foregroundError
      }
      if ($null -eq $operationLock) {
        try {
          $operationLock = Enter-DreamSkinOperationLock `
            -TimeoutMilliseconds $OperationLockTimeoutMilliseconds
        } catch {
          if ($null -ne $appearanceTransaction) { $appearanceRecovery = 'blocked' }
          Write-Warning 'Foreground startup recovery could not reacquire the operation lock.'
        }
      }
      if ($null -ne $operationLock) {
        if (-not $foregroundLockReleased) {
          $foregroundSuperseded = $false
        } else {
          try {
            $foregroundCurrentPause = [bool](Test-DreamSkinPaused -StateRoot $StateRoot)
            $foregroundCurrentFingerprint = Get-DreamSkinThemeRuntimeContentFingerprint `
              -ThemeDirectory $themePaths.Active
            $foregroundSuperseded = $null -ne (Read-DreamSkinState -Path $StatePath) -or
              $foregroundCurrentPause -ne $foregroundBaselinePause -or
              "$foregroundCurrentFingerprint" -cne "$foregroundBaselineFingerprint"
          } catch {
            $foregroundSuperseded = $true
          }
        }
      }
      if ($launchedWithCdp -and $null -ne $operationLock) {
        $foregroundClosed = $false
        try {
          if (-not $foregroundSuperseded) {
            $foregroundProcesses = @(Get-DreamSkinCodexProcesses -Codex $codex -ProfilePath $ProfilePath)
            if ($foregroundProcesses.Count -eq 0) {
              $foregroundClosed = $true
            } else {
              $foregroundIdentity = Get-DreamSkinVerifiedCdpIdentity -Port $Port -Codex $codex -ProfilePath $ProfilePath
              if ($null -ne $foregroundIdentity -and
                "$($foregroundIdentity.BrowserId)" -ceq "$($cdpIdentity.BrowserId)") {
                Stop-DreamSkinCodex -Codex $codex -ProfilePath $ProfilePath -AllowForce
                $foregroundClosed = (Get-DreamSkinCodexProcesses -Codex $codex -ProfilePath $ProfilePath).Count -eq 0
              }
            }
          }
        } catch {
          $foregroundClosed = $false
        }
        if ($foregroundClosed) {
          $appearanceRecovery = Invoke-DreamSkinStartupAppearanceRecovery `
            -Transaction $appearanceTransaction -ConfigPath $ConfigPath -BackupPath $BackupPath
          try { $null = Start-DreamSkinCodexAfterRollback -Codex $codex -ProfilePath $ProfilePath } catch {
            Write-Warning 'Foreground startup recovery could not reopen Codex automatically.'
          }
        } else {
          if ($null -ne $appearanceTransaction) { $appearanceRecovery = 'blocked' }
          if ($foregroundSuperseded) {
            Write-Warning 'Foreground startup recovery was superseded by a newer managed session.'
          } else {
            Write-Warning 'Foreground startup recovery could not confirm that its Codex session was closed.'
          }
        }
      }
      if ($pauseWasSet -and $null -ne $operationLock -and -not $foregroundSuperseded) {
        try { Set-DreamSkinPaused -Paused $true -StateRoot $StateRoot | Out-Null } catch {
          Write-Warning 'Foreground startup rollback could not restore the existing paused state.'
        }
      }
      throw $foregroundError
    }
  }

  $state = $null
  $daemon = $null
  $startFailureCategory = 'injector-start-failed'
  try {
    $injectorArgs = @((ConvertTo-DreamSkinProcessArgument -Value $Injector), '--watch', '--port', "$Port",
      '--browser-id', $cdpIdentity.BrowserId, '--theme-dir',
      (ConvertTo-DreamSkinProcessArgument -Value $themePaths.Active), '--pause-file',
      (ConvertTo-DreamSkinProcessArgument -Value $themePaths.PauseFile), '--theme-library',
      (ConvertTo-DreamSkinProcessArgument -Value $themePaths.Saved), '--settings',
      (ConvertTo-DreamSkinProcessArgument -Value (Join-Path $themePaths.Root 'dynamic-settings.json')))
    if ($backgroundPlaybackCapable) { $injectorArgs += '--background-playback-capable' }
    $daemon = Start-Process -FilePath $node.Path -ArgumentList $injectorArgs -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath
    Start-Sleep -Milliseconds 500
    if ($daemon.HasExited) { throw "The injector exited during startup. See $StderrPath" }

    $injectorStartedAt = Get-DreamSkinProcessStartedAt -ProcessId $daemon.Id
    if (-not $injectorStartedAt) { throw 'The injector process identity could not be recorded safely.' }
    $state = [pscustomobject]@{
      schemaVersion = 3
      platform = 'windows'
      port = $Port
      injectorPid = $daemon.Id
      injectorStartedAt = $injectorStartedAt
      injectorPath = $Injector
      nodePath = $node.Path
      nodeVersion = $node.Version
      codexExe = $codex.Executable
      codexPackageRoot = $codex.PackageRoot
      codexPackageFullName = $codex.PackageFullName
      codexPackageFamilyName = $codex.PackageFamilyName
      codexVersion = $codex.Version
      browserId = $cdpIdentity.BrowserId
      profilePath = $cdpIdentity.ProfilePath
      themeDir = $themePaths.Active
      pauseFile = $themePaths.PauseFile
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-DreamSkinState -Path $StatePath -State $state

    $startFailureCategory = 'renderer-verification-failed'
    # The one-shot verify races Codex's first paint: on a slow machine the
    # shell markers are not rendered yet when the daemon has barely started,
    # and a single early miss used to tear the whole startup down.  The
    # watcher keeps applying in the background, so retry until a deadline.
    $verifyDeadline = (Get-Date).AddSeconds(90)
    $activatedAfterFirstVerifyFailure = $false
    while ($true) {
      $verify = Invoke-DreamSkinNative -FilePath $node.Path -ArgumentList @(
        $Injector, '--verify', '--port', "$Port",
        '--browser-id', $cdpIdentity.BrowserId, '--theme-dir', $themePaths.Active,
        '--theme-library', $themePaths.Saved, '--settings', (Join-Path $themePaths.Root 'dynamic-settings.json'),
        '--timeout-ms', '30000')
      Write-DreamSkinUtf8FileAtomically -Path $VerifyPath -Content (($verify.Output -join "`r`n") + "`r`n")
      if ($verify.ExitCode -eq 0) { break }
      # A verify can fail while the theme is demonstrably on screen: the
      # renderer reports the document visible, the viewport sized and the shell
      # structure present, and only the native-window probe -- which some Codex
      # builds never resolve -- comes back false.  Killing Codex in that state
      # destroys a working skin the user is looking at, so remember it and let
      # the rollback below leave the app alone (#267).
      if (Test-DreamSkinRenderedVerificationOutput -Output $verify.Output) {
        # Latch positive evidence. A later transient or malformed probe must not
        # erase proof that a complete skin was already visible on screen.
        $skinLooksRendered = $true
      }
      if (-not $activatedAfterFirstVerifyFailure) {
        $activatedAfterFirstVerifyFailure = $true
        try { [void](Invoke-DreamSkinCodexWindowActivation -Codex $codex -ProfilePath $ProfilePath) } catch {}
      }
      if ($daemon.HasExited) { throw "The injector exited during startup. See $StderrPath" }
      if ((Get-Date) -ge $verifyDeadline) { throw "Dream Skin verification failed. See $VerifyPath" }
      Start-Sleep -Seconds 3
    }
    if ($null -ne $appearanceTransaction) {
      Complete-DreamSkinAppearanceTransaction `
        -BackupPath $BackupPath -Transaction $appearanceTransaction
    }
  } catch {
    $startupError = $_
    # We own the daemon Process object, so stop it directly: the object is
    # immune to PID reuse, and identity re-validation cannot spuriously
    # refuse.  Slow machines also need more than a moment for teardown; a
    # premature "did not stop" here is what used to leave duelling watchers.
    $injectorStopped = $true
    if ($null -ne $daemon) {
      if (-not $daemon.HasExited) {
        try {
          Stop-Process -InputObject $daemon -Force -ErrorAction Stop
        } catch {
          Write-Warning 'The newly created injector could not be signalled during startup rollback.'
        }
      }
      [void]$daemon.WaitForExit(15000)
      $injectorStopped = $daemon.HasExited
      if (-not $injectorStopped) {
        Write-Warning "The rollback injector has not exited yet: PID $($daemon.Id). State was preserved so the next start can reconcile it."
      }
    }
    if ($injectorStopped -and -not $launchedWithCdp -and -not $skinLooksRendered) {
      try {
        $rollbackIdentity = Get-DreamSkinVerifiedCdpIdentity -Port $Port -Codex $codex -ProfilePath $ProfilePath
        if ($null -ne $rollbackIdentity -and $rollbackIdentity.BrowserId -ceq $cdpIdentity.BrowserId) {
          $removal = Invoke-DreamSkinNative -FilePath $node.Path -ArgumentList @(
            $Injector, '--remove', '--port', "$Port",
            '--browser-id', $cdpIdentity.BrowserId, '--timeout-ms', '5000') -DiscardStderr
          if ($removal.ExitCode -ne 0) { throw 'Injector removal returned a failure status.' }
        }
      } catch {
        Write-Warning 'Startup rollback could not remove the partially applied live skin; reload or close Codex to clear it.'
      }
    }
    if ($injectorStopped) { Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue }
    if ($launchedWithCdp -and -not $skinLooksRendered -and -not $AutoRestartIdleOnly) {
      $rendererRollbackClosed = $false
      try {
        Stop-DreamSkinCodex -Codex $codex -ProfilePath $ProfilePath -AllowForce
        $rendererRollbackClosed = (Get-DreamSkinCodexProcesses -Codex $codex -ProfilePath $ProfilePath).Count -eq 0
      } catch {
        $rendererRollbackClosed = $false
      }
      if ($rendererRollbackClosed) {
        $appearanceRecovery = Invoke-DreamSkinStartupAppearanceRecovery `
          -Transaction $appearanceTransaction -ConfigPath $ConfigPath -BackupPath $BackupPath
        try { $null = Start-DreamSkinCodexAfterRollback -Codex $codex -ProfilePath $ProfilePath } catch {
          Write-Warning 'Startup rollback could not reopen Codex automatically.'
        }
      } else {
        if ($null -ne $appearanceTransaction) { $appearanceRecovery = 'blocked' }
        Write-Warning 'Startup rollback could not fully close Codex; close Codex to ensure its CDP port is closed.'
      }
    } elseif (-not $AutoRestartIdleOnly -and $skinLooksRendered -and $ResultToken -and $launchedWithCdp -and
      $null -ne $appearanceTransaction) {
      # One-click apply has a parent theme-file transaction. Leaving the new
      # appearance/session alive would make any parent file rollback produce a
      # mixed theme. Close only the still-matching CDP session, recover this
      # appearance transaction, and reopen ordinary Codex before reporting.
      $renderedRollbackClosed = $false
      try {
        $renderedProcesses = @(Get-DreamSkinCodexProcesses -Codex $codex -ProfilePath $ProfilePath)
        if ($renderedProcesses.Count -eq 0) {
          $renderedRollbackClosed = $true
        } else {
          $renderedIdentity = Get-DreamSkinVerifiedCdpIdentity -Port $Port -Codex $codex -ProfilePath $ProfilePath
          if ($null -ne $renderedIdentity -and
            "$($renderedIdentity.BrowserId)" -ceq "$($cdpIdentity.BrowserId)") {
            Stop-DreamSkinCodex -Codex $codex -ProfilePath $ProfilePath -AllowForce
            $renderedRollbackClosed = (Get-DreamSkinCodexProcesses -Codex $codex -ProfilePath $ProfilePath).Count -eq 0
          }
        }
      } catch {
        $renderedRollbackClosed = $false
      }
      if ($renderedRollbackClosed) {
        $appearanceRecovery = Invoke-DreamSkinStartupAppearanceRecovery `
          -Transaction $appearanceTransaction -ConfigPath $ConfigPath -BackupPath $BackupPath
        try { $null = Start-DreamSkinCodexAfterRollback -Codex $codex -ProfilePath $ProfilePath } catch {
          Write-Warning 'Rendered-session rollback could not reopen Codex automatically.'
        }
      } else {
        $appearanceRecovery = 'blocked'
        Write-Warning 'Rendered-session rollback could not confirm the exact Codex session was closed.'
      }
    } elseif ($skinLooksRendered) {
      # The skin is on screen and only an inconclusive probe failed. Force-
      # restarting Codex here would take a working window away from the user
      # and leave them with the stock appearance, which is worse than the
      # unverified state we are in. The injector is already stopped and the
      # state file removed, so nothing claims this session is verified; Codex
      # keeps running with its debug port until the user closes it (#267).
      if ($null -ne $appearanceTransaction) {
        try {
          Complete-DreamSkinAppearanceTransaction `
            -BackupPath $BackupPath -Transaction $appearanceTransaction
          $appearanceRecovery = 'preserved-rendered'
        } catch {
          $appearanceRecovery = 'blocked'
          Write-Warning 'Rendered appearance ownership could not be committed; the pending recovery record was retained.'
        }
      }
      Write-Warning 'Dream Skin could not verify this session, but the theme is rendered. Codex was left running; close and reopen it to return to the stock appearance.'
    }
    if ($pauseWasSet -and $pauseCleared) {
      try {
        Set-DreamSkinPaused -Paused $true -StateRoot $StateRoot | Out-Null
      } catch {
        Write-Warning 'Startup rollback could not restore the existing paused state.'
      }
    }
    throw $startupError
  }

  Write-Host "Codex Dream Skin is active on verified loopback port $Port."
  if ($ResultToken) {
    Write-DreamSkinStartResult -StateRoot $StateRoot -Token $ResultToken `
      -Outcome 'success' -Category 'none' -AppearanceRecovery $appearanceRecovery
  }
} catch {
  $startError = $_
  if ($ResultToken) {
    try {
      $reportedCategory = Get-DreamSkinStartFailureCategory `
        -Exception $startError.Exception -FallbackCategory $startFailureCategory
      Write-DreamSkinStartResult -StateRoot $StateRoot -Token $ResultToken `
        -Outcome 'failure' -Category $reportedCategory -AppearanceRecovery $appearanceRecovery
    } catch {
      Write-Warning 'Dream Skin could not write its bounded child-start result.'
    }
  }
  throw $startError
} finally {
  if ($null -ne $operationLock) { Exit-DreamSkinOperationLock -Mutex $operationLock }
}
