function Test-DreamSkinWindowsHost {
  [CmdletBinding()]
  param(
    [System.PlatformID]$Platform = [System.Environment]::OSVersion.Platform
  )

  return $Platform -eq [System.PlatformID]::Win32NT
}
