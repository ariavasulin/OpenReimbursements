<#
.SYNOPSIS
  Install or update the DWS shop bridge as a Windows service on the bridge box.

.DESCRIPTION
  Run from an elevated PowerShell, from inside the repo copy on the bridge box:

    powershell -ExecutionPolicy Bypass -File .\shop-bridge\install\setup.ps1

  What it does, in order:
    1. Checks Node.js 22+ and nssm are on PATH (prints download links if not).
    2. Stops the service if it is already installed.
    3. Copies the service files to C:\dws-bridge (not node_modules, tests, or install\),
       including queries.json, the only SQL the service runs. Removes files from older
       versions that are no longer used.
    4. Runs `npm ci --omit=dev` there.
    5. Asks for each setting and writes C:\dws-bridge\.env. Secrets are typed hidden and
       never printed. On a re-run, pressing Enter keeps the current value, and optional
       settings added by hand (SHOP_MIRROR_MAX_ROWS, SHOP_QUERIES_FILE) are kept.
    6. Restricts the folder to Administrators, SYSTEM, and the service account.
    7. Installs (or updates) the NSSM service "dws-bridge": node --env-file=.env server.mjs,
       starts at boot, restarts on crash, logs to C:\dws-bridge\logs\ with rotation.
    8. Starts the service and prints http://127.0.0.1:<port>/health.

  Safe to re-run: it updates the files and settings and restarts the service.

.PARAMETER ServiceAccount
  Windows account the service runs as. Default NT AUTHORITY\NetworkService (it needs
  network access to reach SQL Server and Supabase; LocalService cannot authenticate on
  the network). Pass a domain or local account to override; you will be asked for its password.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\dws-bridge',
  [string]$ServiceName = 'dws-bridge',
  [string]$ServiceAccount = 'NT AUTHORITY\NetworkService'
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

# --- 0. Admin and prerequisites -------------------------------------------------------

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error 'Run this script from an elevated PowerShell (Run as administrator).'
}

Write-Step 'Checking Node.js and nssm'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host 'Node.js is not on PATH. Install Node.js 22 LTS (Windows Installer .msi) from:' -ForegroundColor Yellow
  Write-Host '  https://nodejs.org/en/download'
  exit 1
}
$nodeVersion = (& $nodeCmd.Source -v).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) {
  Write-Host "Node.js $nodeVersion is too old; version 22 or newer is required. Download:" -ForegroundColor Yellow
  Write-Host '  https://nodejs.org/en/download'
  exit 1
}
$nssmCmd = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssmCmd) {
  Write-Host 'nssm is not on PATH. Download it, unzip, and copy win64\nssm.exe to C:\Windows\System32:' -ForegroundColor Yellow
  Write-Host '  https://nssm.cc/download'
  exit 1
}
$node = $nodeCmd.Source
$nssm = $nssmCmd.Source
Write-Host "  node $nodeVersion at $node"
Write-Host "  nssm at $nssm"

# --- 1. Stop the service if it exists -------------------------------------------------

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne 'Stopped') {
  Write-Step "Stopping $ServiceName"
  Stop-Service -Name $ServiceName -Force
}

# --- 2. Copy the service files --------------------------------------------------------

$Source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$LogDir = Join-Path $InstallDir 'logs'
$EnvPath = Join-Path $InstallDir '.env'
Write-Step "Copying service files from $Source to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$skipDirs = @('node_modules', 'install', 'logs', '.git')
$skipFiles = @('.env', '.gitignore')
$files = Get-ChildItem -LiteralPath $Source -Force | Where-Object {
  -not ($_.PSIsContainer -and ($skipDirs -contains $_.Name))
} | ForEach-Object {
  if ($_.PSIsContainer) { Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force } else { $_ }
} | Where-Object {
  ($skipFiles -notcontains $_.Name) -and ($_.Name -notlike '*.test.mjs') -and ($_.Name -notlike 'testing-*.mjs')
}
foreach ($file in $files) {
  $relative = $file.FullName.Substring($Source.Length).TrimStart('\')
  $target = Join-Path $InstallDir $relative
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  Write-Host "  $relative"
}

# Older versions shipped these; the service no longer uses them.
foreach ($stale in @('mirror.config.json', 'ddl.mjs', 'scripts\ddl.mjs')) {
  $stalePath = Join-Path $InstallDir $stale
  if (Test-Path -LiteralPath $stalePath) {
    Remove-Item -LiteralPath $stalePath -Force
    Write-Host "  removed old $stale"
  }
}
$staleScripts = Join-Path $InstallDir 'scripts'
if ((Test-Path -LiteralPath $staleScripts) -and -not (Get-ChildItem -LiteralPath $staleScripts -Force)) {
  Remove-Item -LiteralPath $staleScripts -Force
}

# --- 3. Dependencies ------------------------------------------------------------------

Write-Step 'Installing dependencies (npm ci --omit=dev)'
Push-Location $InstallDir
try {
  & npm ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

# --- 4. Settings -> .env --------------------------------------------------------------

function Read-EnvFile([string]$Path) {
  $values = @{}
  if (Test-Path -LiteralPath $Path) {
    foreach ($line in Get-Content -LiteralPath $Path) {
      if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') {
        $value = $Matches[2].Trim()
        if ($value.Length -ge 2 -and ("'", '"', '`' -contains $value[0]) -and $value[-1] -eq $value[0]) {
          $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$Matches[1]] = $value
      }
    }
  }
  return $values
}

function ConvertTo-PlainText([Security.SecureString]$Secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# Quote a value for Node's --env-file parser. Single quotes keep everything literal.
function Format-EnvValue([string]$Name, [string]$Value) {
  if ($Value -notmatch "'") { return "'" + $Value + "'" }
  if ($Value -notmatch '`') { return '`' + $Value + '`' }
  if ($Value -notmatch '"') { return '"' + $Value + '"' }
  throw "$Name contains single quotes, double quotes and backticks; choose a different value."
}

function New-Token {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

# Name, prompt, default, secret?, optional?
$settings = @(
  @{ Name = 'SHOP_DB_SERVER'; Prompt = 'SQL Server (HOST\INSTANCE or host,port)'; Default = 'SQL2016\SQLEXPRESS' },
  @{ Name = 'SHOP_DB_NAME'; Prompt = 'Database name'; Default = 'DWS' },
  @{ Name = 'SHOP_DB_USER'; Prompt = 'Read-only login (SQL login, or Windows user name without the domain)'; Default = 'dws_bridge_ro' },
  @{ Name = 'SHOP_DB_PASSWORD'; Prompt = 'Password for that login'; Secret = $true },
  @{ Name = 'SHOP_DB_DOMAIN'; Prompt = 'Windows domain (leave blank for a SQL login)'; Optional = $true },
  @{ Name = 'SHOP_DB_TRUST_CERT'; Prompt = 'Trust the SQL Server certificate (true/false)'; Default = 'true' },
  @{ Name = 'SHOP_BRIDGE_TOKEN'; Prompt = 'Bridge bearer token (blank = generate a new one)'; Secret = $true; Generate = $true },
  @{ Name = 'SHOP_BRIDGE_PORT'; Prompt = 'Local port for the bridge'; Default = '8787' },
  @{ Name = 'SHOP_MIRROR_DATABASE_URL'; Prompt = 'Supabase session pooler URL for role shop_mirror (blank = mirror off)'; Secret = $true; Optional = $true },
  @{ Name = 'SHOP_MIRROR_INTERVAL_MINUTES'; Prompt = 'Mirror interval in minutes'; Default = '15' }
)

Write-Step "Writing $EnvPath (press Enter to keep the value shown in brackets)"
$current = Read-EnvFile $EnvPath
$values = [ordered]@{}
foreach ($s in $settings) {
  $name = $s.Name
  $have = $current[$name]
  if ($s.Secret) {
    $hint = if ($have) { 'set; Enter keeps it' } elseif ($s.Generate) { 'Enter generates one' } elseif ($s.Optional) { 'optional' } else { 'required' }
    $plain = ConvertTo-PlainText (Read-Host -AsSecureString "  $($s.Prompt) [$hint]")
  } else {
    $shown = if ($have) { $have } elseif ($s.Default) { $s.Default } else { '' }
    $plain = Read-Host "  $($s.Prompt) [$shown]"
  }
  if ([string]::IsNullOrEmpty($plain)) {
    if ($have) { $plain = $have }
    elseif ($s.Generate) { $plain = New-Token; Write-Host '    generated a new token' }
    elseif ($s.Default) { $plain = $s.Default }
  }
  if ([string]::IsNullOrEmpty($plain) -and -not $s.Optional) { throw "$name is required." }
  $values[$name] = $plain
}
if ($values['SHOP_BRIDGE_TOKEN'].Length -lt 32) { throw 'SHOP_BRIDGE_TOKEN must be at least 32 characters.' }
# Keep settings this script does not ask about (e.g. SHOP_MIRROR_MAX_ROWS, SHOP_QUERIES_FILE).
foreach ($name in ($current.Keys | Sort-Object)) {
  if (-not $values.Contains($name)) { $values[$name] = $current[$name] }
}

$lines = @('# Written by install/setup.ps1. Holds secrets: readable only by Administrators, SYSTEM, and the service account.')
foreach ($name in $values.Keys) {
  if (-not [string]::IsNullOrEmpty($values[$name])) { $lines += "$name=$(Format-EnvValue $name $values[$name])" }
}
# UTF-8 without a byte-order mark, so Node reads the first key correctly.
[IO.File]::WriteAllText($EnvPath, (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding $false))
$values = $null; $current = $null

# --- 5. Folder permissions ------------------------------------------------------------

Write-Step "Restricting $InstallDir to Administrators, SYSTEM, and $ServiceAccount"
# Well-known SIDs avoid problems on non-English Windows.
$serviceAccountId = switch ($ServiceAccount) {
  'NT AUTHORITY\NetworkService' { '*S-1-5-20' }
  'NT AUTHORITY\LocalService' { '*S-1-5-19' }
  'LocalSystem' { '*S-1-5-18' }
  default { $ServiceAccount }
}
& icacls $InstallDir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "${serviceAccountId}:(OI)(CI)RX" /C /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed on $InstallDir" }
& icacls $LogDir /grant "${serviceAccountId}:(OI)(CI)M" /C /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed on $LogDir" }

# --- 6. The service -------------------------------------------------------------------

function Invoke-Nssm {
  & $nssm @args | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm $($args -join ' ') failed with exit code $LASTEXITCODE" }
}

Write-Step "Configuring service $ServiceName"
if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
  Invoke-Nssm install $ServiceName $node
}
Invoke-Nssm set $ServiceName Application $node
Invoke-Nssm set $ServiceName AppDirectory $InstallDir
# Node 22 reads the .env file itself, so no secrets live in the service registry entry.
Invoke-Nssm set $ServiceName AppParameters '--env-file=.env server.mjs'
Invoke-Nssm set $ServiceName DisplayName 'DWS shop bridge'
Invoke-Nssm set $ServiceName Description 'Read-only HTTP bridge to the shop SQL Server and 15-minute mirror to Supabase. See shop-bridge/README.md.'
Invoke-Nssm set $ServiceName Start SERVICE_AUTO_START
Invoke-Nssm set $ServiceName AppStdout (Join-Path $LogDir 'bridge.log')
Invoke-Nssm set $ServiceName AppStderr (Join-Path $LogDir 'bridge.log')
Invoke-Nssm set $ServiceName AppRotateFiles 1
Invoke-Nssm set $ServiceName AppRotateOnline 1
Invoke-Nssm set $ServiceName AppRotateBytes 10485760
Invoke-Nssm set $ServiceName AppExit Default Restart
Invoke-Nssm set $ServiceName AppRestartDelay 5000
Invoke-Nssm set $ServiceName AppStopMethodConsole 5000

$builtIn = @('NT AUTHORITY\NetworkService', 'NT AUTHORITY\LocalService', 'LocalSystem')
if ($builtIn -contains $ServiceAccount) {
  Invoke-Nssm set $ServiceName ObjectName $ServiceAccount
} else {
  $accountPassword = ConvertTo-PlainText (Read-Host -AsSecureString "  Windows password for service account $ServiceAccount")
  Invoke-Nssm set $ServiceName ObjectName $ServiceAccount $accountPassword
  $accountPassword = $null
}

Write-Step "Starting $ServiceName"
Start-Service -Name $ServiceName

# --- 7. Health check ------------------------------------------------------------------

$port = (Read-EnvFile $EnvPath)['SHOP_BRIDGE_PORT']
if (-not $port) { $port = '8787' }
$url = "http://127.0.0.1:$port/health"
Write-Step "Checking $url"
$body = $null
for ($i = 0; $i -lt 10 -and -not $body; $i++) {
  Start-Sleep -Seconds 2
  try {
    $body = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30).Content
  } catch {
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $body = $_.ErrorDetails.Message
    } elseif ($_.Exception.Response) {
      $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
      $body = $reader.ReadToEnd()
    }
  }
}
if ($body) {
  Write-Host $body
  if ($body -match '"ok"\s*:\s*true') {
    Write-Host 'The bridge is up and can reach SQL Server.' -ForegroundColor Green
  } else {
    Write-Host "The bridge is up but cannot reach SQL Server. Check $LogDir\bridge.log and the SHOP_DB_* values." -ForegroundColor Yellow
  }
} else {
  Write-Host "No answer from $url. Check $LogDir\bridge.log and: Get-Service $ServiceName" -ForegroundColor Red
  exit 1
}
Write-Host ''
Write-Host "The bearer token is SHOP_BRIDGE_TOKEN in $EnvPath (open it as Administrator to copy it into Vercel)."
