# SPDX-FileCopyrightText: 2026 Tico Hannan
# SPDX-License-Identifier: MIT
# prototype\hosts\windows\run-mac-vm-tests.ps1 - INVESTIGATION CODE, NOT RUN YET (no Windows,
# VMware or PowerShell in the sandbox; not even syntax-checked). Read MACVM-WIN first (WIN-S01..S12).
# One disposable run:
#   1. revert the VM to its powered-off snapshot "clean" (taken after prepare-guest.sh)
#   2. start it without a window
#   3. wait for SSH; one ssh process with two tunnels:
#        -L 4444 -> guest's safaridriver;  -R 8090 -> this PC's probe-server
#   4. run run-suite.mjs; results in prototype\results\<RunName>\
#   5. power the VM off and stop the helper processes
# From Command Prompt:
#   powershell -ExecutionPolicy Bypass -File run-mac-vm-tests.ps1 -Repo C:\path\to\mathematica-web-ports
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$RunName = ("macvm-win-" + (Get-Date -Format "yyyyMMdd-HHmm")),
  # ---- settings (edit or pass on the command line) ----
  [string]$Vmx = "$env:USERPROFILE\Documents\Virtual Machines\macos-test\macos.vmx",
  [string]$Snapshot = "clean",
  [string]$GuestUser = "tester",
  [string]$GuestIp = "",   # empty = ask VMware Tools in the guest (vmrun getGuestIPAddress)
  [string]$SshKey = "$env:USERPROFILE\.ssh\macvm_ed25519"
)
# "Continue": in Windows PowerShell 5.1, stderr from native programs (ssh) would otherwise abort the
# script under "Stop"; failures are checked through $LASTEXITCODE and explicit throws instead.
$ErrorActionPreference = "Continue"
$Proto = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Vmrun = @("C:\Program Files\VMware\VMware Workstation\vmrun.exe",
           "C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Vmrun) { throw "vmrun.exe not found - is VMware Workstation installed?" }
$SshArgs = @("-i", $SshKey, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL",
             "-o", "ConnectTimeout=5", "-o", "LogLevel=ERROR")
$RunDir = Join-Path $Proto "results\$RunName"
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$helpers = @()
$Target = $null

try {
  Write-Host "[1/5] revert to snapshot $Snapshot"
  & $Vmrun -T ws revertToSnapshot $Vmx $Snapshot
  if ($LASTEXITCODE -ne 0) { throw "revertToSnapshot failed" }
  Write-Host "[2/5] start VM without a window"
  & $Vmrun -T ws start $Vmx nogui
  if ($LASTEXITCODE -ne 0) { throw "start failed" }

  if (-not $GuestIp) {
    Write-Host "    asking VMware Tools for the guest's IP address (waits until the guest is up)"
    $GuestIp = ("" + ((& $Vmrun -T ws getGuestIPAddress $Vmx -wait) | Select-Object -Last 1)).Trim()
    if ($GuestIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
      throw "vmrun did not return an IPv4 address ('$GuestIp'). Are VMware Tools installed in the guest? Or pass -GuestIp."
    }
  }
  $Target = "$GuestUser@$GuestIp"
  Write-Host "[3/5] waiting for SSH on $GuestIp (several minutes without GPU acceleration)"
  $t0 = Get-Date
  while ($true) {
    & ssh @SshArgs $Target true 2>$null
    if ($LASTEXITCODE -eq 0) { break }
    if (((Get-Date) - $t0).TotalSeconds -gt 900) { throw "guest did not come up in 15 min" }
    Start-Sleep -Seconds 5
  }
  Write-Host ("    SSH up after {0:N0} s" -f ((Get-Date) - $t0).TotalSeconds)
  & ssh @SshArgs $Target "sw_vers -productVersion; sysctl -n hw.memsize"

  & node (Join-Path $Proto "node-reference.mjs") --repo $Repo --out (Join-Path $RunDir "reference-node.json")
  $helpers += Start-Process -PassThru -WindowStyle Hidden node -ArgumentList @(
    "`"$(Join-Path $Proto 'probe-server.mjs')`"", "--repo", "`"$Repo`"", "--port", "8090", "--reports", "`"$(Join-Path $RunDir 'posted')`"")
  $helpers += Start-Process -PassThru -WindowStyle Hidden ssh -ArgumentList ($SshArgs + @("-N", "-L", "4444:127.0.0.1:4444", "-R", "8090:127.0.0.1:8090", $Target))
  # sshd is up before automatic login has started safaridriver: poll for up to 2 minutes.
  $wdUp = $false
  for ($i = 0; $i -lt 40 -and -not $wdUp; $i++) {
    Start-Sleep -Seconds 3
    try { Invoke-RestMethod -ErrorAction Stop http://127.0.0.1:4444/status | Out-Null; $wdUp = $true } catch { }
  }
  if (-not $wdUp) { throw "safaridriver not reachable through the tunnel - see prepare-guest.sh step 7" }

  Write-Host "[4/5] run the suite in Safari"
  & node (Join-Path $Proto "run-suite.mjs") --browser safari --webdriver http://127.0.0.1:4444 `
    --site http://127.0.0.1:8090 --reference (Join-Path $RunDir "reference-node.json") --out $RunDir `
    --label "macOS VM on VMware Workstation (Windows host)"
  Write-Host "results: $RunDir\summary.md"
}
finally {
  Write-Host "[5/5] power off, stop helpers"
  if ($Target) { & ssh @SshArgs $Target "sudo -n shutdown -h now" 2>$null; Start-Sleep -Seconds 20 }
  & $Vmrun -T ws stop $Vmx hard 2>$null
  foreach ($p in $helpers) { if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force } }
}
