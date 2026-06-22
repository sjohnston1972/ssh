# Reconfigures the AccessCmdTerminal service to log on as a specific user.
# Run elevated:  powershell -ExecutionPolicy Bypass -File scripts\run-as-steven.ps1 -Password '<pw>'
param(
  [Parameter(Mandatory = $true)][string]$Password,
  [string]$Account = 'SJLAP\steven',
  [string]$Service = 'accesscmdterminal.exe'
)
$log = Join-Path $PSScriptRoot '..\.superpowers\sdd\run-as-steven.log'
function W($m) { $m | Tee-Object -FilePath $log -Append }
"--- run-as-steven $(Get-Date -Format o) ---" | Set-Content $log

try {
  # 1. Grant SeServiceLogonRight (Log on as a service) to the account.
  $sid = (New-Object System.Security.Principal.NTAccount($Account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  $inf = Join-Path $env:TEMP 'secpol.inf'; $sdb = Join-Path $env:TEMP 'secpol.sdb'
  secedit /export /cfg $inf /areas USER_RIGHTS | Out-Null
  $lines = Get-Content $inf
  $has = $false
  $lines = $lines | ForEach-Object {
    if ($_ -match '^SeServiceLogonRight\s*=') {
      $has = $true
      if ($_ -notmatch [regex]::Escape($sid)) { "$_,*$sid" } else { $_ }
    } else { $_ }
  }
  if (-not $has) {
    $lines = $lines | ForEach-Object {
      $_
      if ($_ -match '^\[Privilege Rights\]') { "SeServiceLogonRight = *$sid" }
    }
  }
  Set-Content $inf $lines
  secedit /configure /db $sdb /cfg $inf /areas USER_RIGHTS | Out-Null
  W "Granted SeServiceLogonRight to $Account ($sid)"

  # 2. Set the service logon account + password.
  $out = & sc.exe config $Service obj= $Account password= $Password 2>&1
  W "sc.exe config: $out"

  # 3. Restart and report.
  Restart-Service $Service -Force
  Start-Sleep -Seconds 2
  $s = Get-CimInstance Win32_Service -Filter "Name='$Service'"
  W ("RESULT StartName=" + $s.StartName + " State=" + $s.State)
} catch {
  W ("ERROR: " + $_.Exception.Message)
  exit 1
}
