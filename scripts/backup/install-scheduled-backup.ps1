<#
  Registers (or replaces) the Windows Scheduled Task "SACS Payroll backup"
  for the signed-in Windows user. Run once from the repository root:

    powershell -ExecutionPolicy Bypass -File scripts\backup\install-scheduled-backup.ps1

  The task runs scripts\backup\scheduled-backup.ps1 every day at 16:30 (and
  as soon as possible after a missed start, e.g. the PC was off); that script
  decides whether today is a backup day. It runs only while the user is
  signed in, because Docker Desktop needs the session. No password is stored.

  The script is copied to %LOCALAPPDATA%\SACS-Payroll so the task keeps
  working whichever branch the repository has checked out.

  Remove:  Unregister-ScheduledTask -TaskName "SACS Payroll backup" -Confirm:$false
#>
param([string]$RepoPath = (Resolve-Path "$PSScriptRoot\..\..").Path)

$ErrorActionPreference = "Stop"
$target = Join-Path $env:LOCALAPPDATA "SACS-Payroll"
New-Item -ItemType Directory -Force -Path $target | Out-Null
$script = Join-Path $target "scheduled-backup.ps1"
Copy-Item -Path (Join-Path $PSScriptRoot "scheduled-backup.ps1") -Destination $script -Force

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -RepoPath `"$RepoPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At "16:30"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName "SACS Payroll backup" -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Off-site backup of the SACS Payroll live database on Fridays, the 14th and the day before month end (docs/hosting-and-operations.md)." -Force | Out-Null

Write-Output "Registered 'SACS Payroll backup' (daily 16:30 check). Log: $target\backup.log"
