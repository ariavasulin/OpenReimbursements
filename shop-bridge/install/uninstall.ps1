<#
.SYNOPSIS
  Remove the DWS shop bridge Windows service. Keeps C:\dws-bridge unless -RemoveFiles is passed.

.DESCRIPTION
  Run from an elevated PowerShell:

    powershell -ExecutionPolicy Bypass -File .\shop-bridge\install\uninstall.ps1
    powershell -ExecutionPolicy Bypass -File .\shop-bridge\install\uninstall.ps1 -RemoveFiles

  Safe to re-run: missing pieces are skipped. The folder holds .env with secrets, so
  -RemoveFiles deletes it too; rotate those secrets if the box is being retired.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\dws-bridge',
  [string]$ServiceName = 'dws-bridge',
  [switch]$RemoveFiles
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error 'Run this script from an elevated PowerShell (Run as administrator).'
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
  if ($service.Status -ne 'Stopped') {
    Write-Host "Stopping $ServiceName"
    Stop-Service -Name $ServiceName -Force
  }
  $nssm = Get-Command nssm -ErrorAction SilentlyContinue
  if ($nssm) {
    & $nssm.Source remove $ServiceName confirm | Out-Null
  } else {
    & sc.exe delete $ServiceName | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { throw "Could not remove service $ServiceName (exit code $LASTEXITCODE)" }
  Write-Host "Removed service $ServiceName"
} else {
  Write-Host "Service $ServiceName is not installed; nothing to remove."
}

if ($RemoveFiles) {
  if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
    Write-Host "Deleted $InstallDir (including .env)"
  } else {
    Write-Host "$InstallDir does not exist."
  }
} elseif (Test-Path -LiteralPath $InstallDir) {
  Write-Host "Kept $InstallDir (it holds .env with secrets and the logs). Re-run with -RemoveFiles to delete it."
}
