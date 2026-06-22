# Run as Administrator. Adjust $allowed to the subnet(s) found in Step 1.
$allowed = @('127.0.0.1', '172.16.0.0/12', '192.168.65.0/24')  # loopback + Docker Desktop ranges
Remove-NetFirewallRule -DisplayName 'access-cmd 7900' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'access-cmd 7900' -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 7900 -RemoteAddress $allowed -Profile Any
# Explicit block for everything else on 7900
Remove-NetFirewallRule -DisplayName 'access-cmd 7900 deny' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'access-cmd 7900 deny' -Direction Inbound -Action Block `
  -Protocol TCP -LocalPort 7900 -Profile Any
Write-Output 'Firewall rules applied (allow takes precedence for listed subnets).'
