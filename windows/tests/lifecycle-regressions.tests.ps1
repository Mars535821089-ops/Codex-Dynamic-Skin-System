[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)

# App/process/signature boundaries are mocked; Node trust file checks use only
# temporary fake files. Native argv decoding is additionally exercised on
# Windows; no installed app or real process is modified.
$ErrorActionPreference = 'Stop'
. (Join-Path $Root 'scripts/common-windows.ps1')
$script:checks = 0
function Assert-Fixture {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
  $script:checks += 1
}

& {
  # Keep the real file checks, Authenticode gate, version parsing, and UTF-8
  # identity decoder. Only signature discovery and native execution are faked;
  # the temporary .exe contains text and must never be executed by any test.
  $nodeTrustRoot = Join-Path ([IO.Path]::GetTempPath()) ('dream-skin-node-trust-' + [guid]::NewGuid().ToString('N'))
  # Construct non-ASCII text without depending on PS5.1's script-file encoding.
  $unicodeName = [string][char]0x4E2D + [char]0x6587 + ' runtime with spaces'
  $null = [IO.Directory]::CreateDirectory((Join-Path $nodeTrustRoot $unicodeName))
  $fixtureCandidate = Join-Path (Join-Path $nodeTrustRoot $unicodeName) 'node.exe'
  $fixtureMissingPath = Join-Path $nodeTrustRoot 'missing-node.exe'
  [IO.File]::WriteAllText($fixtureCandidate, 'Not an executable. Native execution is mocked.')
  function Invoke-NodeTrustFixture {
    param([string]$Status = 'Valid', [string]$Subject = 'CN=OpenJS Foundation, O=OpenJS Foundation, C=US',
      [string]$Version = '22.23.1', [int]$VersionExit = 0, [switch]$MissingFile,
      [ValidateSet('valid','invalid-base64','missing-path')][string]$Identity = 'valid')
    $script:nodeTrustEvents = @()
    function Get-Command {
      param($Name,$CommandType)
      if ($Name -ne 'Get-AuthenticodeSignature' -or $CommandType -ne 'Cmdlet') { throw 'Unexpected command discovery.' }
      return [pscustomobject]@{Name=$Name;CommandType='Cmdlet'}
    }
    function Get-AuthenticodeSignature {
      param($LiteralPath)
      if ($LiteralPath -cne $fixtureCandidate) { throw 'Signature inspection lost the candidate path.' }
      $script:nodeTrustEvents += 'signature'
      return [pscustomobject]@{Status=$Status;SignerCertificate=[pscustomobject]@{Subject=$Subject}}
    }
    function Invoke-DreamSkinNative {
      param($FilePath,$ArgumentList,[switch]$DiscardStderr)
      if ($FilePath -cne $fixtureCandidate) { throw 'Native probe lost the candidate path.' }
      if ($ArgumentList.Count -eq 2 -and $ArgumentList[0] -eq '-p' -and $ArgumentList[1] -eq 'process.versions.node') {
        $script:nodeTrustEvents += 'version-probe'
        return [pscustomobject]@{ExitCode=$VersionExit;Output=@($Version)}
      }
      if ($ArgumentList.Count -eq 2 -and $ArgumentList[0] -eq '-e' -and
        $ArgumentList[1] -eq "process.stdout.write(Buffer.from(process.execPath, 'utf8').toString('base64'))") {
        $script:nodeTrustEvents += 'identity-probe'
        $encoded = if ($Identity -eq 'invalid-base64') { '%%%invalid%%%' } else {
          $path = if ($Identity -eq 'missing-path') { $fixtureMissingPath } else { $fixtureCandidate }
          [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path))
        }
        return [pscustomobject]@{ExitCode=0;Output=@($encoded)}
      }
      throw 'Unexpected native execution request.'
    }
    $runtime = $null; $failure = ''
    $inputPath = if ($MissingFile) { $fixtureMissingPath } else { $fixtureCandidate }
    try { $runtime = Get-DreamSkinValidatedNodeRuntime -Path $inputPath } catch { $failure = $_.Exception.Message }
    return [pscustomobject]@{Runtime=$runtime;Failure=$failure;Events=($script:nodeTrustEvents -join ',')}
  }
  try {
    # Removing/reordering the signature gate must allow a native call and fail
    # these assertions; an incidental downstream exception is not sufficient.
    foreach ($case in @(
      @{Name='invalid signature';Options=@{Status='NotSigned'};Error='*not validly signed*';Events='signature'},
      @{Name='unknown publisher';Options=@{Subject='CN=Unknown Publisher, O=Unknown Publisher, C=US'};Error='*unexpected publisher*';Events='signature'},
      @{Name='missing file';Options=@{MissingFile=$true};Error='*does not exist*';Events=''},
      @{Name='old version';Options=@{Version='21.9.0'};Error='*22 or newer is required*';Events='signature,version-probe,identity-probe'},
      @{Name='invalid version';Options=@{Version='not-a-version'};Error='*22 or newer is required*';Events='signature,version-probe,identity-probe'},
      @{Name='failed version probe';Options=@{VersionExit=1};Error='*could not be validated*';Events='signature,version-probe'},
      @{Name='invalid base64 identity';Options=@{Identity='invalid-base64'};Error='*executable path could not be validated*';Events='signature,version-probe,identity-probe'},
      @{Name='missing identity path';Options=@{Identity='missing-path'};Error='*executable path could not be validated*';Events='signature,version-probe,identity-probe'}
    )) {
      $options = $case.Options
      $result = Invoke-NodeTrustFixture @options
      Assert-Fixture ($null -eq $result.Runtime -and $result.Failure -like $case.Error -and $result.Events -ceq $case.Events) `
        "Node trust rejected incorrectly or executed past the $($case.Name) boundary: $($result.Failure); events=$($result.Events)"
    }
    foreach ($version in @('22.23.1','24.1.0')) {
      $result = Invoke-NodeTrustFixture -Version $version
      Assert-Fixture (-not $result.Failure -and $result.Runtime.Path -ceq $fixtureCandidate -and
        $result.Runtime.Version -ceq $version -and $result.Runtime.Major -ge 22 -and
        $result.Events -ceq 'signature,version-probe,identity-probe') `
        "Signed Node $version did not preserve the verified Unicode/space path: $($result.Failure)"
    }
  } finally { [IO.Directory]::Delete($nodeTrustRoot, $true) }
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'dream-skin-lifecycle-fixture'
$trayPath = Join-Path $fixtureRoot 'engine/scripts/tray-dream-skin.ps1'
$codexPath = Join-Path $fixtureRoot 'ChatGPT.exe'
$profileA = Join-Path $fixtureRoot 'profile A'
$profileB = Join-Path $fixtureRoot 'profile B'

$nativeWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
if ($nativeWindows) {
  $line = 'powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "' + $trayPath + '"'
  Assert-Fixture (Test-DreamSkinPowerShellFileCommand -CommandLine $line -ScriptPath $trayPath) `
    'Native argv decoding did not retain the exact quoted tray script.'
  Assert-Fixture (-not (Test-DreamSkinPowerShellFileCommand `
    -CommandLine ('powershell.exe -Command "Write-Output ''-File ' + $trayPath + '''"') `
    -ScriptPath $trayPath)) 'A command payload was mistaken for a script invocation.'
}

# Feed decoded tokens at the OS boundary to run profile/tree matching on every
# host without pretending a POSIX tokenizer implements Windows quoting.
$script:argvFixtures = @{}
function ConvertFrom-DreamSkinProcessCommandLine {
  param([string]$CommandLine)
  if (-not $script:argvFixtures.ContainsKey($CommandLine)) { throw 'Unknown argv fixture.' }
  return ,$script:argvFixtures[$CommandLine]
}
$script:argvFixtures.exact = @('powershell.exe', '-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', $trayPath)
$script:argvFixtures.prefix = @('powershell.exe', '-File', ($trayPath + '.backup.ps1'))
$script:argvFixtures.payload = @('powershell.exe', '-Command', 'Write-Output', '-File', $trayPath)
$script:argvFixtures.encoded = @('powershell.exe', '-EncodedCommand', 'Zg==', '-File', $trayPath)
$script:argvFixtures.argument = @('powershell.exe', '-File', 'other.ps1', $trayPath)
$script:argvFixtures.unknown = @('powershell.exe', '-c', '-File', $trayPath)
Assert-Fixture (Test-DreamSkinPowerShellFileCommand -CommandLine exact -ScriptPath $trayPath) 'Exact tray invocation was rejected.'
foreach ($key in @('prefix', 'payload', 'encoded', 'argument', 'unknown')) {
  Assert-Fixture (-not (Test-DreamSkinPowerShellFileCommand -CommandLine $key -ScriptPath $trayPath)) `
    "Non-tray invocation was selected: $key"
}

$script:argvFixtures.default = @($codexPath)
$script:argvFixtures.profileA = @($codexPath, "--user-data-dir=$profileA")
$script:argvFixtures.profileB = @($codexPath, '--user-data-dir', $profileB)
$script:argvFixtures.child = @($codexPath, '--type=renderer')
$script:argvFixtures.duplicate = @($codexPath, "--user-data-dir=$profileA", "--user-data-dir=$profileB")
$script:argvFixtures.missing = @($codexPath, '--user-data-dir')
$script:argvFixtures.delimiter = @($codexPath, '--', "--user-data-dir=$profileA")
Assert-Fixture (Test-DreamSkinProcessProfile -ProcessInfo ([pscustomobject]@{CommandLine='default'})) 'Default profile was not selected.'
Assert-Fixture (-not (Test-DreamSkinProcessProfile -ProcessInfo ([pscustomobject]@{CommandLine='profileA'}))) 'Default profile selected an explicit profile.'
Assert-Fixture (-not (Test-DreamSkinProcessProfile -ProcessInfo ([pscustomobject]@{CommandLine=''}))) 'Unreadable command line was treated as default profile.'
if ($nativeWindows) {
  Assert-Fixture (Test-DreamSkinProcessProfile -ProcessInfo ([pscustomobject]@{CommandLine='profileA'}) -ProfilePath $profileA) 'Explicit profile was not selected.'
}
foreach ($key in @('duplicate', 'missing', 'delimiter')) {
  Assert-Fixture (-not (Test-DreamSkinProcessProfile -ProcessInfo ([pscustomobject]@{CommandLine=$key}) -ProfilePath $profileA)) `
    "Ambiguous profile was selected: $key"
}

function New-ProcessFixture {
  param([int]$Id, [int]$Parent, [string]$Line)
  return [pscustomobject]@{ ProcessId=$Id; ParentProcessId=$Parent; CommandLine=$Line; ExecutablePath=$codexPath }
}
$script:processFixtures = @(
  (New-ProcessFixture 10 1 default), (New-ProcessFixture 11 10 child),
  (New-ProcessFixture 20 1 profileA), (New-ProcessFixture 21 20 child),
  (New-ProcessFixture 22 21 child), (New-ProcessFixture 30 10 profileB),
  (New-ProcessFixture 31 30 child), (New-ProcessFixture 40 99 child)
)
function Get-CimInstance { param($ClassName, $Filter); return $script:processFixtures }
$codex = [pscustomobject]@{Executable=$codexPath}
Assert-Fixture ((@(Get-DreamSkinCodexProcesses -Codex $codex | ForEach-Object ProcessId) -join ',') -eq '10,11') `
  'Default selection crossed a profile boundary or selected an orphan renderer.'
if ($nativeWindows) {
  Assert-Fixture ((@(Get-DreamSkinCodexProcesses -Codex $codex -ProfilePath $profileA | ForEach-Object ProcessId) -join ',') -eq '20,21,22') `
    'Explicit profile did not inherit its renderer descendants.'
}
Assert-Fixture (@(Get-DreamSkinCodexProcesses -Codex $codex -AllProfiles).Count -eq 8) `
  'Install-time all-profile discovery omitted a process.'

$script:stoppedHandles = @()
$startedAt = [datetime]'2026-01-01T00:00:00Z'
$script:processFixtures = @(
  [pscustomobject]@{ProcessId=8101; CommandLine='exact'; ExecutablePath='powershell.exe'; CreationDate=$startedAt},
  [pscustomobject]@{ProcessId=8102; CommandLine='prefix'; ExecutablePath='powershell.exe'; CreationDate=$startedAt},
  [pscustomobject]@{ProcessId=8103; CommandLine='payload'; ExecutablePath='powershell.exe'; CreationDate=$startedAt}
)
$script:boundProcess = [pscustomobject]@{Id=8101; Handle=123; HasExited=$false; Path='powershell.exe'; StartTime=$startedAt; Disposed=$false}
$script:boundProcess | Add-Member ScriptMethod WaitForExit { param($Milliseconds); return $this.HasExited }
$script:boundProcess | Add-Member ScriptMethod Dispose { $this.Disposed=$true }
function Get-Process { param($Id); if ($Id -ne 8101) { throw 'An unrelated process handle was requested.' }; return $script:boundProcess }
function Stop-Process { param($InputObject, [switch]$Force); $script:stoppedHandles += $InputObject; $InputObject.HasExited=$true }
function Test-DreamSkinTrayActive { return $false }
Stop-DreamSkinTrayProcess -ScriptPaths @($trayPath) -RequireStopped
Assert-Fixture ($script:stoppedHandles.Count -eq 1 -and [object]::ReferenceEquals($script:stoppedHandles[0], $script:boundProcess)) `
  'Tray stop did not use the bound exact process object.'
Assert-Fixture $script:boundProcess.Disposed 'Tray stop leaked its process handle.'
$script:stoppedHandles = @()
$script:boundProcess.HasExited = $false
$script:boundProcess.StartTime = $startedAt.AddSeconds(5)
$rejected = $false
try { Stop-DreamSkinTrayProcess -ScriptPaths @($trayPath) -RequireStopped } catch { $rejected = $true }
Assert-Fixture ($rejected -and $script:stoppedHandles.Count -eq 0) 'Tray stop did not reject a recycled process identity.'

$nodePath = Join-Path $fixtureRoot 'node.exe'
$injectorPath = Join-Path $fixtureRoot 'injector.mjs'
$script:processFixtures = @([pscustomobject]@{
  ProcessId=8101; ExecutablePath=$nodePath
  CommandLine=('"' + $nodePath + '" "' + $injectorPath + '" --watch --port 9336 --browser-id fixture-browser')
})
$script:boundProcess.Path=$nodePath
$script:boundProcess.StartTime=$startedAt
$script:boundProcess.Disposed=$false
$watcherState=[pscustomobject]@{injectorPid=8101; injectorPath=$injectorPath; nodePath=$nodePath; port=9336;
  browserId='fixture-browser'; injectorStartedAt=$startedAt.ToUniversalTime().ToString('o')}
Assert-Fixture (Test-DreamSkinRecordedInjectorAlive -State $watcherState) 'A matching watcher was not healthy.'
Assert-Fixture ($script:stoppedHandles.Count -eq 0 -and $script:boundProcess.Disposed) 'Read-only watcher health stopped a process or leaked its handle.'
$script:boundProcess.StartTime=$startedAt.AddSeconds(5)
Assert-Fixture (-not (Test-DreamSkinRecordedInjectorAlive -State $watcherState)) 'Watcher health accepted a recycled PID.'
Assert-Fixture (-not (Test-DreamSkinRecordedInjectorAlive -State ([pscustomobject]@{injectorPid=8101}))) 'Watcher health trusted an unbound legacy process.'
Assert-Fixture ($script:stoppedHandles.Count -eq 0) 'An unhealthy watcher check stopped a process.'

& {
  # Exercise the final, bound-handle restart guard, not just startup's earlier
  # process snapshot. Reuse within CIM's rounding tolerance must still reject.
  function Get-DreamSkinCodexProcessesExcept {
    param($Codex,$ProfilePath,$PreserveProcessIds)
    return @([pscustomobject]@{ProcessId=8101;CreationDate=$startedAt})
  }
  $script:boundProcess.Path = $codexPath
  $script:boundProcess.HasExited = $false
  $script:boundProcess.Disposed = $false
  $script:boundProcess.StartTime = $startedAt.AddMilliseconds(500)
  $script:boundProcess | Add-Member NoteProperty CloseRequests 0 -Force
  $script:boundProcess | Add-Member ScriptMethod CloseMainWindow {
    $this.CloseRequests++; $this.HasExited=$true; return $true
  } -Force
  $rejected = $false
  try {
    Stop-DreamSkinCodex -Codex $codex -ExpectedProcessId 8101 -ExpectedStartedAt $startedAt.ToUniversalTime().ToString('o')
  } catch { $rejected=$true }
  Assert-Fixture ($rejected -and $script:boundProcess.CloseRequests -eq 0 -and $script:boundProcess.Disposed) `
    'Final stop guard accepted sub-second PID reuse or leaked its bound process.'
  $rejected = $false
  try {
    Stop-DreamSkinCodex -Codex $codex -ExpectedProcessId 9999 -ExpectedStartedAt $startedAt.ToUniversalTime().ToString('o')
  } catch { $rejected=$true }
  Assert-Fixture ($rejected -and $script:boundProcess.CloseRequests -eq 0) 'Final stop guard accepted a missing expected PID.'
  $script:boundProcess.StartTime = $startedAt
  $script:boundProcess.Disposed = $false
  Stop-DreamSkinCodex -Codex $codex -ExpectedProcessId 8101 -ExpectedStartedAt $startedAt.ToUniversalTime().ToString('o')
  Assert-Fixture ($script:boundProcess.CloseRequests -eq 1 -and $script:boundProcess.Disposed -and $script:stoppedHandles.Count -eq 0) `
    'Expected process did not receive one graceful close without force.'
}

# Execute the actual uninstall branch with mocked deletion and synthetic shell
# folders. This verifies the Startup entry without changing the host filesystem.
$restoreSource = [System.IO.File]::ReadAllText((Join-Path $Root 'scripts/restore-dream-skin.ps1'))
$tokens = $null; $errors = $null
$restoreAst = [System.Management.Automation.Language.Parser]::ParseInput($restoreSource, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
$uninstallIf = $restoreAst.Find({ param($ast)
  $ast -is [System.Management.Automation.Language.IfStatementAst] -and $ast.Clauses[0].Item1.Extent.Text -eq '$Uninstall'
}, $true)
if (-not $uninstallIf) { throw 'Could not find the uninstall branch.' }
$uninstallSource = $uninstallIf.Clauses[0].Item2.Extent.Text.Trim().TrimStart('{').TrimEnd('}')
$uninstallSource = $uninstallSource.Replace("[Environment]::GetFolderPath('Desktop')", '$fixtureDesktop')
$uninstallSource = $uninstallSource.Replace("[Environment]::GetFolderPath('Startup')", '$fixtureStartup')
& {
  $fixtureDesktop = Join-Path $fixtureRoot 'Desktop'
  $fixtureStartup = Join-Path $fixtureRoot 'Startup'
  $StateRoot = $fixtureRoot
  $engine = [pscustomobject]@{Root=(Join-Path $fixtureRoot 'engine')}
  $script:deleted = @()
  $originalAppData = $env:APPDATA
  $env:APPDATA = Join-Path $fixtureRoot 'AppData'
  function Remove-Item { param($LiteralPath, [switch]$Force); $script:deleted += $LiteralPath }
  function Test-Path { param($LiteralPath); return $false }
  try { & ([scriptblock]::Create($uninstallSource)) } finally { $env:APPDATA = $originalAppData }
  Assert-Fixture ($script:deleted -contains (Join-Path $fixtureStartup 'Codex Dream Skin.lnk')) `
    'Uninstall left the login Startup shortcut behind.'
}

# Run the verifier's real identity-selection path, stopping before its native
# renderer command. Every candidate must remain bound to the saved profile.
$verifySource = [IO.File]::ReadAllText((Join-Path $Root 'scripts/verify-dream-skin.ps1'))
$verifySource = $verifySource.Substring(0, $verifySource.IndexOf('  # Without an explicit --theme-dir')) +
  "`n} finally { Exit-DreamSkinOperationLock -Mutex `$operationLock }"
$verifySource = [regex]::Replace($verifySource, '(?m)^\.\s+\(Join-Path \$PSScriptRoot ''(?:common-windows|theme-windows)\.ps1''\)\r?\n', '')
$verifySource = $verifySource.Replace('$injector = Join-Path $PSScriptRoot ''injector.mjs''', '$injector = ''mock-injector.mjs''')
& {
  $savedLocalAppData=$env:LOCALAPPDATA
  $env:LOCALAPPDATA=$fixtureRoot
  function Enter-DreamSkinOperationLock { return 'fixture-lock' }
  function Exit-DreamSkinOperationLock { param($Mutex) }
  function Read-DreamSkinState { param($Path); return [pscustomobject]@{profilePath=$profileA;port=9336;browserId='fixture-browser'} }
  function Get-DreamSkinNodeRuntime { return [pscustomobject]@{Path='mock-node.exe'} }
  function Get-DreamSkinCodexInstall { return [pscustomobject]@{Executable='current.exe'} }
  function Get-DreamSkinCodexInstallFromState { param($State); return [pscustomobject]@{Executable='saved.exe'} }
  function Get-DreamSkinVerifiedCdpIdentity {
    param($Port,$Codex,$ProfilePath)
    $script:verifyCalls += [pscustomobject]@{Port=$Port;Profile=$ProfilePath}
    if ($Codex.Executable -eq $script:verifyTarget) { return [pscustomobject]@{BrowserId='fixture-browser'} }
    return $null
  }
  function Get-DreamSkinVerifiedCdpIdentityForAnyRegistered {
    param($Port,$ProfilePath)
    $script:verifyCalls += [pscustomobject]@{Port=$Port;Profile=$ProfilePath}
    return [pscustomobject]@{Codex=[pscustomobject]@{Executable='registered.exe'};Identity=[pscustomobject]@{BrowserId='fixture-browser'}}
  }
  try {
    foreach ($target in @('current.exe','saved.exe','registered.exe')) {
      $script:verifyTarget=$target; $script:verifyCalls=@()
      & ([scriptblock]::Create($verifySource))
      Assert-Fixture ($script:verifyCalls.Count -gt 0 -and @($script:verifyCalls | Where-Object {
        $_.Port -ne 9336 -or $_.Profile -ne $profileA
      }).Count -eq 0) "Verifier lost profile/port binding for $target."
    }
    $script:verifyCalls=@(); $wrongProfileRejected=$false
    try { & ([scriptblock]::Create($verifySource)) -ProfilePath $profileB } catch { $wrongProfileRejected=$true }
    Assert-Fixture ($wrongProfileRejected -and $script:verifyCalls.Count -eq 0) 'Verifier contacted an endpoint despite an explicit profile mismatch.'
  } finally { $env:LOCALAPPDATA=$savedLocalAppData }
}

$builderSource=[IO.File]::ReadAllText((Join-Path $Root 'installer/build-release.ps1'))
$builderAst=[System.Management.Automation.Language.Parser]::ParseInput($builderSource,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw $errors[0] }
$copyFunction=$builderAst.Find({param($ast)
  $ast -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $ast.Name -eq 'Copy-ReleaseManifestFiles'
},$true)
& {
  . ([scriptblock]::Create($copyFunction.Extent.Text))
  $script:releaseCopies=@()
  function Test-Path { param($LiteralPath,$PathType); return $true }
  function Get-Item { param($LiteralPath,[switch]$Force); return [pscustomobject]@{Attributes=[IO.FileAttributes]::Normal} }
  function New-Item { param($ItemType,$Path,[switch]$Force) }
  function Copy-Item { param($LiteralPath,$Destination,[switch]$Force); $script:releaseCopies += $LiteralPath }
  Copy-ReleaseManifestFiles -SourceRoot $fixtureRoot -DestinationRoot (Join-Path $fixtureRoot 'output') `
    -RelativePaths @('repository.json','VERSION','scripts\check-update.ps1')
  Assert-Fixture ($script:releaseCopies -contains (Join-Path $fixtureRoot 'repository.json')) 'Release builder omitted the update repository configuration.'
  Assert-Fixture ($script:releaseCopies.Count -eq 2) 'Release builder copied unexpected root files.'
}

Write-Output "PASS: $script:checks lifecycle regression assertions (app/process actions mocked; temporary files only)."
