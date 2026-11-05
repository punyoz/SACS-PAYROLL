<#
  Scheduled off-site backup of the LIVE database (docs/hosting-and-operations.md
  section 2). Run by the Windows Scheduled Task "SACS Payroll backup" that
  scripts/backup/install-scheduled-backup.ps1 registers.

  The task starts every day at 16:30; this script backs up only on
    - Fridays (the week's attendance),
    - the 14th (before the 15th payslip), and
    - the day before the last day of the month (before the month-end payslip),
  unless -Force is given. It writes backups/<date_time>/ in the repository
  (git-ignored) through scripts/backup/backup-db.mjs, which only reads the
  database.

  The live connection string is read from .env.live.local and passed in the
  environment, never printed. The log has no secrets.
#>
param(
  [string]$RepoPath = "C:\Users\EHD\SACS-PAYROLL",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$logDir = Join-Path $env:LOCALAPPDATA "SACS-Payroll"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "backup.log"
function Write-Log([string]$message) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $message" | Add-Content -Path $log -Encoding utf8
}

$today = Get-Date
$lastDay = [DateTime]::DaysInMonth($today.Year, $today.Month)
$isBackupDay = $today.DayOfWeek -eq [DayOfWeek]::Friday -or $today.Day -eq 14 -or $today.Day -eq ($lastDay - 1)
if (-not $isBackupDay -and -not $Force) { exit 0 }

try {
  $envFile = Join-Path $RepoPath ".env.live.local"
  if (-not (Test-Path $envFile)) { throw "Missing $envFile (the live project settings)." }
  $line = Get-Content $envFile | Where-Object { $_ -match '^SUPABASE_DB_URL=' } | Select-Object -First 1
  $dbUrl = if ($line) { $line.Substring('SUPABASE_DB_URL='.Length).Trim().Trim('"') } else { "" }
  if ($dbUrl -notmatch '^postgres(ql)?://' -or $dbUrl -notmatch 'pooler\.supabase\.com') {
    throw "SUPABASE_DB_URL in .env.live.local is not a Supabase pooler connection string."
  }

  # The Supabase CLI runs pg_dump in Docker: start Docker Desktop if needed.
  docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    $dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerExe) { Start-Process $dockerExe | Out-Null }
    $deadline = (Get-Date).AddMinutes(4)
    do { Start-Sleep -Seconds 10; docker info *> $null } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $deadline)
    if ($LASTEXITCODE -ne 0) { throw "Docker Desktop did not start." }
  }

  Set-Location $RepoPath
  $env:SUPABASE_DB_URL = $dbUrl
  # Windows PowerShell turns a native program's stderr (e.g. Node warnings)
  # into errors; judge the run by its exit code only.
  $ErrorActionPreference = "Continue"
  $output = & node --no-deprecation scripts/backup/backup-db.mjs 2>&1 | Out-String
  $code = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  Remove-Item Env:SUPABASE_DB_URL
  # backup-db.mjs already hides the password in its errors; mask again anyway.
  $output = $output -replace '(postgres(ql)?://[^:\s]+:)[^@\s]+@', '$1***@'
  if ($code -ne 0) { throw "backup-db.mjs failed (exit $code): $output" }
  $done = ($output -split "`n" | Where-Object { $_ -match '^Done:' } | Select-Object -First 1)
  Write-Log "OK  $($done.Trim())  (copy it to the encrypted off-site location)"
} catch {
  Write-Log "FAILED  $($_.Exception.Message)"
  exit 1
}
