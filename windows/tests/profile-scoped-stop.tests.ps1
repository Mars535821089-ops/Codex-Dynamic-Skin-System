[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)

# This native Windows regression test compiles and runs only a disposable
# fixture named ChatGPT.exe. It never discovers, launches or stops real Codex.
$ErrorActionPreference = 'Stop'
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw 'Windows is required for native process-handle and command-line semantics.'
}
. (Join-Path $Root 'scripts\common-windows.ps1')

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
  ("dream-skin-stop-" + [guid]::NewGuid().ToString('N'))
$fixtureExecutable = Join-Path $fixtureRoot 'ChatGPT.exe'
$profileA = Join-Path $fixtureRoot 'profile A'
$profileB = Join-Path $fixtureRoot 'profile B'
$processA = $null
$processB = $null
$processDefault = $null
try {
  New-Item -ItemType Directory -Force -Path $fixtureRoot, $profileA, $profileB | Out-Null
  $stateA = [pscustomobject]@{ profilePath = $profileA }
  if (-not (Test-DreamSkinStateProfileMatch -State $null -ProfilePath $profileA)) {
    throw 'Empty saved state should be compatible with a new explicit profile.'
  }
  if (-not (Test-DreamSkinStateProfileMatch -State $stateA -ProfilePath $profileA)) {
    throw 'Saved state did not match its exact explicit profile.'
  }
  if (Test-DreamSkinStateProfileMatch -State $stateA -ProfilePath $profileB) {
    throw 'Saved state incorrectly matched another explicit profile.'
  }
  if (Test-DreamSkinStateProfileMatch -State $stateA -ProfilePath $null) {
    throw 'Explicit-profile state incorrectly matched the default profile.'
  }
  if (Test-DreamSkinStateProfileMatch -State ([pscustomobject]@{}) -ProfilePath $profileA) {
    throw 'Legacy default-profile state incorrectly matched an explicit profile.'
  }
  $fixtureSource = Join-Path $fixtureRoot 'Program.cs'
  [System.IO.File]::WriteAllText($fixtureSource, @'
using System;
using System.Threading;
public static class Program {
  public static void Main(string[] args) { Thread.Sleep(TimeSpan.FromMinutes(2)); }
}
'@, [System.Text.UTF8Encoding]::new($false))
  $compiler = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $compiler) { throw 'The disposable fixture C# compiler is unavailable.' }
  & $compiler '/nologo' '/target:exe' "/out:$fixtureExecutable" $fixtureSource
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $fixtureExecutable)) {
    throw "The disposable fixture failed to compile (exit code $LASTEXITCODE)."
  }

  $processA = Start-Process -FilePath $fixtureExecutable `
    -ArgumentList ('"--user-data-dir=' + $profileA + '"') -PassThru
  $processB = Start-Process -FilePath $fixtureExecutable `
    -ArgumentList ('"--user-data-dir=' + $profileB + '"') -PassThru
  $processDefault = Start-Process -FilePath $fixtureExecutable -PassThru
  $codex = [pscustomobject]@{ Executable = $fixtureExecutable }

  $deadline = (Get-Date).AddSeconds(10)
  do {
    $matchingA = @(Get-DreamSkinCodexProcesses -Codex $codex -ProfilePath $profileA)
    $matchingB = @(Get-DreamSkinCodexProcesses -Codex $codex -ProfilePath $profileB)
    $matchingDefault = @(Get-DreamSkinCodexProcesses -Codex $codex)
    if ($matchingA.Count -eq 1 -and $matchingB.Count -eq 1 -and $matchingDefault.Count -eq 1) { break }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  if ($matchingA.Count -ne 1 -or $matchingB.Count -ne 1 -or
    $matchingDefault.Count -ne 1 -or $matchingDefault[0].ProcessId -ne $processDefault.Id) {
    throw 'The disposable fixture processes were not discovered with distinct profiles.'
  }

  Stop-DreamSkinCodex -Codex $codex -ProfilePath $profileA -AllowForce
  $processA.Refresh()
  $processB.Refresh()
  if (-not $processA.HasExited) { throw 'The selected fixture profile was not stopped.' }
  if ($processB.HasExited) { throw 'The unselected fixture profile was stopped.' }
  $processDefault.Refresh()
  if ($processDefault.HasExited) { throw 'Explicit-profile stop closed the default fixture.' }
  Stop-DreamSkinCodex -Codex $codex -AllowForce
  $processDefault.Refresh()
  $processB.Refresh()
  if (-not $processDefault.HasExited) { throw 'Default-profile stop did not close its fixture.' }
  if ($processB.HasExited) { throw 'Default-profile stop closed an explicit fixture.' }
  Write-Output 'PASS: explicit and default profile stops preserved the other disposable profiles.'
} finally {
  foreach ($fixtureProcess in @($processA, $processB, $processDefault)) {
    if ($null -eq $fixtureProcess) { continue }
    try {
      if (-not $fixtureProcess.HasExited) { $fixtureProcess.Kill() }
      [void]$fixtureProcess.WaitForExit(5000)
    } catch {}
    $fixtureProcess.Dispose()
  }
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
