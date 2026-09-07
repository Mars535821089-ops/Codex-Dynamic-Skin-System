[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$LaunchTray,
  [switch]$Uninstall,
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$payloadRoot = Join-Path $PSScriptRoot 'payload'
$payloadScripts = Join-Path $payloadRoot 'scripts'
$commonPath = Join-Path $payloadScripts 'common-windows.ps1'
$themePath = Join-Path $payloadScripts 'theme-windows.ps1'
$stateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Dream Skin.lnk'

function Show-DreamSkinBootstrapMessage {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [ValidateSet('Info', 'Error')][string]$Kind = 'Info'
  )
  if ($Silent) { return }
  Add-Type -AssemblyName System.Windows.Forms
  $icon = if ($Kind -eq 'Error') {
    [System.Windows.Forms.MessageBoxIcon]::Error
  } else {
    [System.Windows.Forms.MessageBoxIcon]::Information
  }
  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    'Codex Dream Skin',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    $icon
  )
}

function Wait-DreamSkinCodexClosedForSetup {
  while ($true) {
    $registered = @(Get-DreamSkinRegisteredCodexInstalls)
    $running = @($registered | Where-Object { (Get-DreamSkinCodexProcesses -Codex $_).Count -gt 0 })
    if ($running.Count -eq 0) { return }
    if ($Silent) { throw 'Close Codex before installing or updating Codex Dream Skin.' }
    Add-Type -AssemblyName System.Windows.Forms
    $choice = [System.Windows.Forms.MessageBox]::Show(
      'Codex is currently running. Close it, then click Retry to continue setup.',
      'Codex Dream Skin Setup',
      [System.Windows.Forms.MessageBoxButtons]::RetryCancel,
      [System.Windows.Forms.MessageBoxIcon]::Information
    )
    if ($choice -ne [System.Windows.Forms.DialogResult]::Retry) {
      throw 'Setup was cancelled because Codex is still running.'
    }
  }
}

function Compare-DreamSkinBootstrapVersionComponent {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )
  if ($Left.Length -gt $Right.Length) { return 1 }
  if ($Left.Length -lt $Right.Length) { return -1 }
  return [string]::Compare($Left, $Right, [System.StringComparison]::Ordinal)
}

function Compare-DreamSkinBootstrapVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )
  $leftParts = $Left.Split('.')
  $rightParts = $Right.Split('.')
  for ($index = 0; $index -lt 3; $index += 1) {
    $comparison = Compare-DreamSkinBootstrapVersionComponent `
      -Left $leftParts[$index] -Right $rightParts[$index]
    if ($comparison -ne 0) { return $comparison }
  }
  return 0
}

try {
  $actionCount = @($Install, $LaunchTray, $Uninstall).Where({ [bool]$_ }).Count
  if ($actionCount -ne 1) {
    throw 'Choose exactly one installer bootstrap action.'
  }
  if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $themePath -PathType Leaf)) {
    throw 'The installer payload is incomplete.'
  }
  . $commonPath
  . $themePath

  $engine = Get-DreamSkinRuntimeEnginePaths -StateRoot $stateRoot
  if ($Uninstall) {
    Stop-DreamSkinTrayProcess -ScriptPaths @($engine.Tray) -RequireStopped
    $restoreRequired = (Test-Path -LiteralPath $engine.Root -PathType Container) -or
      (Test-Path -LiteralPath (Join-Path $stateRoot 'config.before-dream-skin.toml') -PathType Leaf)
    if ($restoreRequired -and -not (Test-Path -LiteralPath $engine.Restore -PathType Leaf)) {
      throw 'The installed restore engine is missing. Reinstall Codex Dream Skin, then uninstall again so Codex can be restored safely.'
    }
    if ($restoreRequired) {
      $restoreParameters = @{
        Uninstall = $true
        ForceRestart = $true
        NoRelaunch = $true
      }
      if (Test-Path -LiteralPath (Join-Path $stateRoot 'config.before-dream-skin.toml') -PathType Leaf) {
        $restoreParameters.RestoreBaseTheme = $true
      }
      & $engine.Restore @restoreParameters
    }
    if (Test-Path -LiteralPath $engine.Root -PathType Container) {
      Remove-DreamSkinRuntimeTree -Path $engine.Root -StateRoot $stateRoot
    }
    Remove-Item -LiteralPath $startupShortcut -Force -ErrorAction SilentlyContinue
    exit 0
  }

  $payloadNode = Join-Path $payloadRoot 'runtime\node\node.exe'
  $payloadNodeLicense = Join-Path $payloadRoot 'runtime\node\LICENSE'
  if (-not (Test-Path -LiteralPath $payloadNode -PathType Leaf) -or
    -not (Test-Path -LiteralPath $payloadNodeLicense -PathType Leaf)) {
    throw 'The installer payload is missing its bundled Node.js runtime. Re-download Setup.exe.'
  }
  $payloadVersion = ([System.IO.File]::ReadAllText((Join-Path $payloadRoot 'VERSION'))).Trim()
  if ($payloadVersion -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw "The installer payload version is invalid: $payloadVersion"
  }
  $installedVersion = if (Test-Path -LiteralPath $engine.Version -PathType Leaf) {
    ([System.IO.File]::ReadAllText($engine.Version)).Trim()
  } else { '' }
  if ($installedVersion -cmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -and
    (Compare-DreamSkinBootstrapVersion -Left $installedVersion -Right $payloadVersion) -gt 0) {
    throw "A newer Codex Dream Skin v$installedVersion is already installed. Download that version or newer instead of downgrading to v$payloadVersion."
  }
  $backupExists = Test-Path -LiteralPath (Join-Path $stateRoot 'config.before-dream-skin.toml') -PathType Leaf
  $runtimeFileManifest = Read-DreamSkinRuntimeFileManifest `
    -Path (Join-Path $payloadRoot 'assets\runtime-required-files.json')
  $requiredEngineFiles = @($runtimeFileManifest.required) +
    @($runtimeFileManifest.packagedAdditions)
  $missingEngineFiles = @($requiredEngineFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $engine.Root $_) -PathType Leaf)
  })
  $engineComplete = $missingEngineFiles.Count -eq 0
  $needsInstall = $Install -or $payloadVersion -cne $installedVersion -or
    -not $backupExists -or -not $engineComplete

  if ($needsInstall) {
    Wait-DreamSkinCodexClosedForSetup
    Stop-DreamSkinTrayProcess -ScriptPaths @($engine.Tray) -RequireStopped
    & (Join-Path $payloadScripts 'install-dream-skin.ps1') -NoShortcuts
    $engine = Get-DreamSkinRuntimeEnginePaths -StateRoot $stateRoot
    $committedVersion = if (Test-Path -LiteralPath $engine.Version -PathType Leaf) {
      ([System.IO.File]::ReadAllText($engine.Version)).Trim()
    } else { '' }
    $missingEngineFiles = @($requiredEngineFiles | Where-Object {
      -not (Test-Path -LiteralPath (Join-Path $engine.Root $_) -PathType Leaf)
    })
    if ($committedVersion -cne $payloadVersion -or $missingEngineFiles.Count -gt 0 -or
      -not (Test-Path -LiteralPath (Join-Path $stateRoot 'config.before-dream-skin.toml') -PathType Leaf)) {
      throw 'Runtime installation did not commit a complete managed engine.'
    }
  }

  if ($LaunchTray -and -not (Test-DreamSkinTrayActive)) {
    $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $argumentLine = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File ' +
      (ConvertTo-DreamSkinProcessArgument -Value $engine.Tray)
    Start-Process -FilePath $powershell -ArgumentList $argumentLine -WindowStyle Hidden | Out-Null
  }
} catch {
  Show-DreamSkinBootstrapMessage -Message $_.Exception.Message -Kind Error
  Write-Error $_
  exit 1
}
