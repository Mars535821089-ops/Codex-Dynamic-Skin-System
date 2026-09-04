[CmdletBinding()]
param(
  [string]$CandidateSha,
  [string]$OutputPath,
  [switch]$BuildInstaller,
  [switch]$LaunchIsolated,
  [string]$ProfilePath,
  [string]$AcceptanceThemeDirectory,
  [int]$Port = 19442,
  [string]$IsccPath,
  [string]$NodeArchivePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$windowsRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Split-Path -Parent $windowsRoot
$workRoot = Join-Path $projectRoot 'work\windows-native-acceptance'

function Invoke-AcceptanceCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )
  Write-Host "=== $Name ==="
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE."
  }
}

function Assert-NoCodexProcess {
  $codex = @(
    Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.Name -match '^Codex(\.exe)?$' -or
      ($_.ExecutablePath -and $_.ExecutablePath -match 'OpenAI\.Codex')
    }
  )
  if ($codex.Count -ne 0) {
    throw 'Refusing isolated launch because a Codex process is already running.'
  }
}

function Test-AcceptancePathWithin {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $prefix = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  return $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-WithAcceptanceEnvironment {
  param(
    [Parameter(Mandatory = $true)][string]$LocalAppData,
    [Parameter(Mandatory = $true)][string]$HomeDirectory,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )
  $originalLocalAppData = $env:LOCALAPPDATA
  $originalHome = $env:HOME
  try {
    $env:LOCALAPPDATA = $LocalAppData
    $env:HOME = $HomeDirectory
    & $Command
  } finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:HOME = $originalHome
  }
}

function Get-IsolatedProfileProcesses {
  param(
    [Parameter(Mandatory = $true)][string]$IsolatedProfilePath,
    [Parameter(Mandatory = $true)][string]$SandboxPath
  )
  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $owned = @{}
  $fullProfilePath = [System.IO.Path]::GetFullPath($IsolatedProfilePath)
  $fullSandboxPath = [System.IO.Path]::GetFullPath($SandboxPath)
  $profilePattern = [Regex]::Escape('--user-data-dir=' + $fullProfilePath) + '(?:"|\s|$)'
  $sandboxPattern = '(?:^|["\s=])' + [Regex]::Escape($fullSandboxPath) + '(?:"|\s|[\\/]|$)'
  foreach ($process in $processes) {
    if ([int]$process.ProcessId -eq $PID -or -not $process.CommandLine) { continue }
    if ($process.CommandLine -match $profilePattern -or $process.CommandLine -match $sandboxPattern) {
      $owned[[int]$process.ProcessId] = $process
    }
  }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $processes) {
      $processId = [int]$process.ProcessId
      if ($processId -eq $PID -or $owned.ContainsKey($processId)) { continue }
      if ($owned.ContainsKey([int]$process.ParentProcessId)) {
        $owned[$processId] = $process
        $changed = $true
      }
    }
  }
  return @($owned.Values)
}

function Remove-AcceptanceSandbox {
  param(
    [Parameter(Mandatory = $true)][string]$SandboxPath,
    [Parameter(Mandatory = $true)][string]$AcceptanceWorkRoot,
    [Parameter(Mandatory = $true)][string]$IsolatedProfilePath
  )
  $fullSandbox = [System.IO.Path]::GetFullPath($SandboxPath)
  if (-not (Test-AcceptancePathWithin -Path $fullSandbox -Root $AcceptanceWorkRoot)) {
    throw "Refusing to remove an acceptance sandbox outside the project work root: $fullSandbox"
  }
  if (-not (Test-Path -LiteralPath $fullSandbox)) { return }
  $reparseItems = @(Get-Item -LiteralPath $fullSandbox -Force) + @(
    Get-ChildItem -LiteralPath $fullSandbox -Recurse -Force -ErrorAction Stop
  ) | Where-Object {
    ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  }
  if ($reparseItems.Count -ne 0) {
    throw 'Refusing to remove an acceptance sandbox containing a junction or symbolic link.'
  }
  $remaining = @(Get-IsolatedProfileProcesses `
    -IsolatedProfilePath $IsolatedProfilePath -SandboxPath $fullSandbox)
  if ($remaining.Count -ne 0) {
    throw 'Refusing to remove the acceptance sandbox while owned processes are still running.'
  }
  Remove-Item -LiteralPath $fullSandbox -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $fullSandbox) {
    throw 'The project-owned acceptance sandbox could not be removed.'
  }
}

function Write-AcceptanceReportAtomically {
  param(
    [Parameter(Mandatory = $true)][object]$Report,
    [Parameter(Mandatory = $true)][string]$Path
  )
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporary = Join-Path $parent ('.acceptance-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  [System.IO.File]::WriteAllText(
    $temporary,
    (($Report | ConvertTo-Json -Depth 8) + "`r`n"),
    [System.Text.UTF8Encoding]::new($false)
  )
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Invoke-IsolatedRendererAcceptance {
  param(
    [Parameter(Mandatory = $true)][int]$DebugPort,
    [Parameter(Mandatory = $true)][int]$ExpectedPid,
    [Parameter(Mandatory = $true)][string]$IsolatedProfilePath,
    [Parameter(Mandatory = $true)][string]$RendererOutputRoot,
    [Parameter(Mandatory = $true)][ValidateSet('on', 'off')][string]$BackgroundPlayback
  )
  $rendererArguments = @(
    '.\tools\isolated-codex-acceptance.mjs',
    '--attach-port', "$DebugPort",
    '--expected-pid', "$ExpectedPid",
    '--profile', ([System.IO.Path]::GetFullPath($IsolatedProfilePath)),
    '--output', $RendererOutputRoot,
    '--samples', '50',
    '--interval-ms', '100',
    '--background-playback', $BackgroundPlayback
  )
  $rendererOutput = @(& node @rendererArguments)
  if ($LASTEXITCODE -ne 0) {
    throw "The isolated renderer $BackgroundPlayback acceptance audit failed."
  }
  try {
    $rendererResult = ($rendererOutput -join "`n") | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "The isolated renderer $BackgroundPlayback acceptance audit did not return valid JSON."
  }
  $rendererReportPath = [System.IO.Path]::GetFullPath([string]$rendererResult.reportPath)
  if (-not (Test-Path -LiteralPath $rendererReportPath -PathType Leaf)) {
    throw "The isolated renderer $BackgroundPlayback acceptance report was not created."
  }
  $rendererRootFull = [System.IO.Path]::GetFullPath($RendererOutputRoot).TrimEnd('\') + '\'
  if (-not $rendererReportPath.StartsWith($rendererRootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The isolated renderer $BackgroundPlayback acceptance report escaped its project-owned output directory."
  }
  if (-not [bool]$rendererResult.summary.loopEnabled) {
    throw "The isolated renderer $BackgroundPlayback audit did not prove that every sampled video frame had looping enabled."
  }
  if (-not [bool]$rendererResult.summary.stable -or
    [int]$rendererResult.summary.unfocusedSamples -ne [int]$rendererResult.summary.sampleCount) {
    throw "The isolated renderer $BackgroundPlayback audit was not stable and fully unfocused."
  }
  if (-not [bool]$rendererResult.dynamicRuntimeExpectation.pass -or
    [int]$rendererResult.dynamicRuntimeSummary.completeSamples -ne [int]$rendererResult.dynamicRuntimeSummary.sampleCount -or
    [int]$rendererResult.dynamicRuntimeSummary.connectedSamples -ne [int]$rendererResult.dynamicRuntimeSummary.sampleCount -or
    [int]$rendererResult.dynamicRuntimeSummary.audio.samples -ne [int]$rendererResult.dynamicRuntimeSummary.sampleCount) {
    throw "The isolated renderer $BackgroundPlayback audit did not expose complete, connected runtime diagnostics."
  }
  if ($BackgroundPlayback -eq 'on' -and
    (-not [bool]$rendererResult.summary.playbackAdvanced -or [int]$rendererResult.summary.pausedSamples -ne 0)) {
    throw 'Background-enabled playback did not continuously advance while unfocused.'
  }
  if ($BackgroundPlayback -eq 'off' -and
    ([bool]$rendererResult.summary.playbackAdvanced -or
      [int]$rendererResult.summary.pausedSamples -ne [int]$rendererResult.summary.sampleCount)) {
    throw 'Background-disabled playback did not remain frozen while unfocused.'
  }
  return [pscustomobject]@{
    reportPath = $rendererReportPath
    reportSha256 = (Get-FileHash -LiteralPath $rendererReportPath -Algorithm SHA256).Hash.ToLowerInvariant()
    summary = $rendererResult.summary
    dynamicRuntimeSummary = $rendererResult.dynamicRuntimeSummary
  }
}

function Invoke-NativeDefaultRoundTripAcceptance {
  param(
    [Parameter(Mandatory = $true)][int]$DebugPort,
    [Parameter(Mandatory = $true)][int]$ExpectedPid,
    [Parameter(Mandatory = $true)][string]$IsolatedProfilePath,
    [Parameter(Mandatory = $true)][string]$ThemeDirectory,
    [Parameter(Mandatory = $true)][string]$SelectionFile,
    [Parameter(Mandatory = $true)][string]$ReportPath
  )
  $roundTripOutput = @(& node '.\tools\native-default-acceptance.mjs' `
    '--theme' $ThemeDirectory `
    '--attach-port' "$DebugPort" `
    '--expected-pid' "$ExpectedPid" `
    '--profile' ([System.IO.Path]::GetFullPath($IsolatedProfilePath)) `
    '--selection-file' ([System.IO.Path]::GetFullPath($SelectionFile)) `
    '--output' ([System.IO.Path]::GetFullPath($ReportPath)))
  if ($LASTEXITCODE -ne 0) {
    throw 'The native-default round-trip acceptance audit failed.'
  }
  try {
    $result = ($roundTripOutput -join "`n") | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'The native-default round-trip acceptance audit did not return valid JSON.'
  }
  $resolvedReport = [System.IO.Path]::GetFullPath([string]$result.reportPath)
  if (-not [bool]$result.pass -or -not (Test-Path -LiteralPath $resolvedReport -PathType Leaf)) {
    throw 'The native-default round-trip acceptance audit did not create a PASS report.'
  }
  if (-not (Test-AcceptancePathWithin -Path $resolvedReport -Root $workRoot)) {
    throw 'The native-default round-trip report escaped the project-owned Windows acceptance work root.'
  }
  $report = Get-Content -LiteralPath $resolvedReport -Raw | ConvertFrom-Json -ErrorAction Stop
  if (-not [bool]$report.pass -or -not [bool]$report.native.pass -or
    -not [bool]$report.nativeAfterReload.pass -or -not [bool]$report.reapplied.pass -or
    -not [bool]$report.reappliedAfterReload.pass -or -not [bool]$report.playbackAdvanced) {
    throw 'The native-default round-trip report does not prove the complete native and reapplied lifecycle.'
  }
  return [pscustomobject]@{
    reportPath = $resolvedReport
    reportSha256 = (Get-FileHash -LiteralPath $resolvedReport -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

Push-Location $projectRoot
try {
  if (-not $CandidateSha) {
    $CandidateSha = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the candidate Git SHA.' }
  }
  if ($CandidateSha -cnotmatch '^[0-9a-f]{40}$') {
    throw 'CandidateSha must be a lowercase 40-character Git SHA.'
  }
  & node '.\tools\verify-candidate-worktree.mjs' $CandidateSha
  if ($LASTEXITCODE -ne 0) {
    throw 'Candidate worktree verification failed.'
  }

  if (-not $OutputPath) {
    $OutputPath = Join-Path $workRoot ("acceptance-$CandidateSha.json")
  } elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $projectRoot $OutputPath
  }
  $OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
  if (-not (Test-AcceptancePathWithin -Path $OutputPath -Root $workRoot)) {
    throw "OutputPath must remain inside the project-owned Windows acceptance work root: $workRoot"
  }

  $manualChecks = [ordered]@{
    imageVideoImport = 'PENDING'
    responsiveLayout = 'PENDING'
    videoLoopAndStability = 'PENDING'
    backgroundPlayback = 'PENDING'
    audioControls = 'PENDING'
    semanticSounds = 'PENDING'
    voxelAndFallback = 'PENDING'
    cleanupAndRestore = 'PENDING'
  }
  $report = [ordered]@{
    schema = 'codex-dynamic-skin-windows-native-acceptance/1'
    candidateSha = $CandidateSha
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    host = [ordered]@{
      os = [Environment]::OSVersion.VersionString
      architecture = $env:PROCESSOR_ARCHITECTURE
      powershell = $PSVersionTable.PSVersion.ToString()
    }
    automated = [ordered]@{
      runtimeSync = 'PENDING'
      portableTests = 'PENDING'
      nativePowerShell = 'PENDING'
      installerStatic = 'PENDING'
      installerBuild = 'NOT_REQUESTED'
      installerSha256 = $null
      isolatedProcessFlags = 'NOT_REQUESTED'
      rendererAcceptance = 'NOT_REQUESTED'
      rendererReport = $null
      rendererReportSha256 = $null
      nativeDefaultRoundTrip = 'NOT_REQUESTED'
      nativeDefaultReport = $null
      nativeDefaultReportSha256 = $null
      isolatedCleanup = 'NOT_REQUESTED'
    }
    manualChecks = $manualChecks
    final = 'FAIL'
    failure = $null
  }

  try {
    Invoke-AcceptanceCommand -Name 'runtime sync' -Command {
      & node '.\tools\sync-runtime-assets.mjs' '--check'
    }
    $report.automated.runtimeSync = 'PASS'

    $portable = @(
      Get-ChildItem '.\macos\tests\*.test.mjs', '.\windows\tests\*.test.mjs',
        '.\tools\*.test.mjs', '.\tools\tests\*.test.mjs' -File |
        ForEach-Object FullName
    )
    Invoke-AcceptanceCommand -Name 'portable Node tests' -Command {
      & node '--test' @portable
    }
    $report.automated.portableTests = 'PASS'

    Invoke-AcceptanceCommand -Name 'Windows PowerShell tests' -Command {
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned `
        -File '.\windows\tests\run-tests.ps1'
    }
    $report.automated.nativePowerShell = 'PASS'

    Invoke-AcceptanceCommand -Name 'installer static tests' -Command {
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned `
        -File '.\windows\tests\installer-static.tests.ps1'
    }
    $report.automated.installerStatic = 'PASS'

    if ($BuildInstaller) {
      $releaseRoot = Join-Path $workRoot $CandidateSha
      $builderArguments = @('-OutputDirectory', $releaseRoot)
      if ($IsccPath) { $builderArguments += @('-IsccPath', $IsccPath) }
      if ($NodeArchivePath) { $builderArguments += @('-NodeArchivePath', $NodeArchivePath) }
      & '.\windows\installer\build-release.ps1' @builderArguments
      $artifact = Join-Path $releaseRoot ("CodexDreamSkin-Setup-v$((Get-Content '.\windows\VERSION' -Raw).Trim()).exe")
      if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
        throw 'The reviewed installer builder did not create its expected artifact.'
      }
      $report.automated.installerBuild = 'PASS'
      $report.automated.installerSha256 = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    if ($LaunchIsolated) {
      if (-not $ProfilePath -or -not [System.IO.Path]::IsPathRooted($ProfilePath)) {
        throw 'LaunchIsolated requires a fresh absolute ProfilePath.'
      }
      if (-not $AcceptanceThemeDirectory -or
        -not [System.IO.Path]::IsPathRooted($AcceptanceThemeDirectory)) {
        throw 'LaunchIsolated requires an absolute AcceptanceThemeDirectory.'
      }
      if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
      $acceptanceSandbox = Join-Path $workRoot ('sandbox-' + $CandidateSha)
      $acceptanceInputRoot = Join-Path $workRoot 'acceptance-inputs'
      $acceptanceProfiles = Join-Path $acceptanceSandbox 'profiles'
      $acceptanceLocalAppData = Join-Path $acceptanceSandbox 'local-app-data'
      $acceptanceHome = Join-Path $acceptanceSandbox 'home'
      $ProfilePath = [System.IO.Path]::GetFullPath($ProfilePath)
      $AcceptanceThemeDirectory = [System.IO.Path]::GetFullPath($AcceptanceThemeDirectory)
      if (-not (Test-AcceptancePathWithin -Path $ProfilePath -Root $acceptanceProfiles)) {
        throw "The isolated ProfilePath must be inside the project-owned acceptance profile root: $acceptanceProfiles"
      }
      if (-not (Test-AcceptancePathWithin -Path $AcceptanceThemeDirectory -Root $acceptanceInputRoot)) {
        throw "AcceptanceThemeDirectory must be inside the project-owned acceptance input root: $acceptanceInputRoot"
      }
      if (-not (Test-Path -LiteralPath $AcceptanceThemeDirectory -PathType Container)) {
        throw 'AcceptanceThemeDirectory does not exist.'
      }
      if (Test-Path -LiteralPath $acceptanceSandbox) {
        throw 'The candidate acceptance sandbox already exists; inspect it before retrying.'
      }
      if (Test-Path -LiteralPath $ProfilePath) { throw 'The isolated ProfilePath already exists.' }
      Assert-NoCodexProcess

      $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
      if ($listener) { throw 'The requested isolated debugging port is already listening.' }
      New-Item -ItemType Directory -Path $acceptanceProfiles, $acceptanceLocalAppData, $acceptanceHome `
        -Force | Out-Null
      $launchFailure = $null
      $cleanupFailure = $null
      try {
        Invoke-WithAcceptanceEnvironment -LocalAppData $acceptanceLocalAppData `
          -HomeDirectory $acceptanceHome -Command {
            . '.\windows\scripts\theme-windows.ps1'
            $acceptanceStateRoot = Join-Path $acceptanceLocalAppData 'CodexDreamSkin'
            $null = Initialize-DreamSkinThemeStore -SkillRoot $windowsRoot `
              -StateRoot $acceptanceStateRoot
            $acceptanceTheme = Read-DreamSkinTheme `
              -ThemeDirectory $AcceptanceThemeDirectory
            $acceptanceCss = Join-Path $AcceptanceThemeDirectory 'theme.css'
            if (-not (Test-Path -LiteralPath $acceptanceCss -PathType Leaf)) {
              $acceptanceCss = $null
            }
            $null = Set-DreamSkinActiveTheme -ImagePath $acceptanceTheme.ImagePath `
              -Theme $acceptanceTheme.Theme -SafeCssPath $acceptanceCss `
              -StateRoot $acceptanceStateRoot
            & '.\windows\scripts\start-dream-skin.ps1' -Port $Port -ProfilePath $ProfilePath
            if ($LASTEXITCODE -ne 0) { throw 'The isolated Dream Skin launcher failed.' }
          }

        $argumentBoundary = '(?:"|\s|$)'
        $portPattern = [Regex]::Escape("--remote-debugging-port=$Port") + $argumentBoundary
        $profilePattern = [Regex]::Escape("--user-data-dir=$ProfilePath") + $argumentBoundary
        $isolated = $null
        $isolationDeadline = (Get-Date).AddSeconds(45)
        while ($null -eq $isolated -and (Get-Date) -lt $isolationDeadline) {
          $owners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique)
          foreach ($owner in $owners) {
            $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $owner" -ErrorAction SilentlyContinue
            if ($null -ne $candidate -and $candidate.CommandLine -and
              $candidate.CommandLine -match $portPattern -and
              $candidate.CommandLine -match $profilePattern) {
              $isolated = $candidate
              break
            }
          }
          if ($null -eq $isolated) { Start-Sleep -Milliseconds 250 }
        }
        if ($null -eq $isolated) { throw 'No Codex listener owner exposed both exact isolated launch flags.' }
        $report.automated.isolatedProcessFlags = 'PASS'

        $rendererOn = Invoke-IsolatedRendererAcceptance -DebugPort $Port `
          -ExpectedPid $isolated.ProcessId -IsolatedProfilePath $ProfilePath `
          -RendererOutputRoot (Join-Path $workRoot ("renderer-$CandidateSha-on")) `
          -BackgroundPlayback 'on'
        $acceptanceStateRoot = Join-Path $acceptanceLocalAppData 'CodexDreamSkin'
        $nativeDefault = Invoke-NativeDefaultRoundTripAcceptance -DebugPort $Port `
          -ExpectedPid $isolated.ProcessId -IsolatedProfilePath $ProfilePath `
          -ThemeDirectory $AcceptanceThemeDirectory `
          -SelectionFile (Join-Path $acceptanceStateRoot 'selected-theme.json') `
          -ReportPath (Join-Path $workRoot ("native-default-$CandidateSha.json"))
        $rendererOff = Invoke-IsolatedRendererAcceptance -DebugPort $Port `
          -ExpectedPid $isolated.ProcessId -IsolatedProfilePath $ProfilePath `
          -RendererOutputRoot (Join-Path $workRoot ("renderer-$CandidateSha-off")) `
          -BackgroundPlayback 'off'
        $report.automated.rendererAcceptance = [ordered]@{ enabled = 'PASS'; disabled = 'PASS' }
        $report.automated.rendererReport = [ordered]@{
          enabled = $rendererOn.reportPath.Substring($workRoot.Length).TrimStart('\')
          disabled = $rendererOff.reportPath.Substring($workRoot.Length).TrimStart('\')
        }
        $report.automated.rendererReportSha256 = [ordered]@{
          enabled = $rendererOn.reportSha256
          disabled = $rendererOff.reportSha256
        }
        $report.automated.nativeDefaultRoundTrip = 'PASS'
        $report.automated.nativeDefaultReport = $nativeDefault.reportPath.Substring($workRoot.Length).TrimStart('\')
        $report.automated.nativeDefaultReportSha256 = $nativeDefault.reportSha256
        $report.manualChecks.videoLoopAndStability = 'PASS'
        $report.manualChecks.backgroundPlayback = 'PASS'
      } catch {
        $launchFailure = $_
      } finally {
        $cleanupMessages = @()
        $ownedProcessesStopped = $false
        try {
          $statePath = Join-Path $acceptanceLocalAppData 'CodexDreamSkin\state.json'
          if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            Invoke-WithAcceptanceEnvironment -LocalAppData $acceptanceLocalAppData `
              -HomeDirectory $acceptanceHome -Command {
                & '.\windows\scripts\restore-dream-skin.ps1' -Port $Port -ForceRestart -NoRelaunch
                if ($LASTEXITCODE -ne 0) { throw 'The isolated Dream Skin restore failed.' }
              }
          }
        } catch {
          $cleanupMessages += "Restore failed: $($_.Exception.Message)"
        }
        try {
          $remaining = @(Get-IsolatedProfileProcesses `
            -IsolatedProfilePath $ProfilePath -SandboxPath $acceptanceSandbox)
          foreach ($process in $remaining) {
            Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
          }
          foreach ($process in $remaining) {
            Wait-Process -Id ([int]$process.ProcessId) -Timeout 15 -ErrorAction SilentlyContinue
          }
          $remainingAfterStop = @(Get-IsolatedProfileProcesses `
            -IsolatedProfilePath $ProfilePath -SandboxPath $acceptanceSandbox)
          if ($remainingAfterStop.Count -ne 0) {
            throw 'Project-owned isolated acceptance processes did not stop.'
          }
          $ownedProcessesStopped = $true
        } catch {
          $cleanupMessages += "Owned process cleanup failed: $($_.Exception.Message)"
        }
        if ($ownedProcessesStopped) {
          try {
            Remove-AcceptanceSandbox -SandboxPath $acceptanceSandbox `
              -AcceptanceWorkRoot $workRoot -IsolatedProfilePath $ProfilePath
          } catch {
            $cleanupMessages += "Sandbox removal failed: $($_.Exception.Message)"
          }
        }
        if ($cleanupMessages.Count -eq 0) {
          $report.automated.isolatedCleanup = 'PASS'
        } else {
          $report.automated.isolatedCleanup = 'FAIL'
          $cleanupFailure = $cleanupMessages -join ' '
        }
      }
      if ($null -ne $launchFailure -and $null -ne $cleanupFailure) {
        throw "$($launchFailure.Exception.Message) Cleanup also failed: $cleanupFailure"
      }
      if ($null -ne $launchFailure) { throw $launchFailure }
      if ($null -ne $cleanupFailure) { throw $cleanupFailure }
    }
  } catch {
    $report.failure = $_.Exception.Message
    Write-AcceptanceReportAtomically -Report $report -Path $OutputPath
    throw
  }

  Write-AcceptanceReportAtomically -Report $report -Path $OutputPath
  Write-Host "Automated Windows evidence recorded at: $OutputPath"
  Write-Host 'FINAL remains FAIL until every manual real-product check is recorded as PASS.'
  Write-Host 'After recording hashed manual evidence, use tools\finalize-windows-native-acceptance.mjs to publish the immutable final report.'
} finally {
  Pop-Location
}
