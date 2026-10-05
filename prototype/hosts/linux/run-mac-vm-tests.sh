#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Tico Hannan
# SPDX-License-Identifier: MIT
# prototype/hosts/linux/run-mac-vm-tests.sh — INVESTIGATION CODE, NOT RUN YET (the authoring sandbox
# has no /dev/kvm). Read MACVM-LNX first (steps LNX-S01...LNX-S12). One disposable test run:
#
#   1. make a throw-away overlay disk on top of the prepared macOS base image (base stays clean)
#   2. boot the guest headless (VNC on 127.0.0.1:5901 only, for watching/debugging)
#   3. wait for SSH, open ONE ssh connection with two tunnels:
#        -L 4444 -> guest's safaridriver (started at login by the LaunchAgent from prepare-guest.sh)
#        -R 8090 -> host's probe-server, so the guest's Safari opens http://127.0.0.1:8090/...
#   4. run run-suite.mjs on the host; results land in prototype/results/<run name>/
#   5. power the guest off and delete the overlay
#
# Usage:  ./run-mac-vm-tests.sh /path/to/mathematica-web-ports-checkout [run-name]
set -euo pipefail

REPO_CHECKOUT="$(realpath "${1:?give the path of a mathematica-web-ports checkout}")"
RUN_NAME="${2:-macvm-$(date +%Y%m%d-%H%M)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROTO="$(realpath "$HERE/../..")"

# ---- settings (edit) ---------------------------------------------------------------------------
OSXKVM="${OSXKVM:-$HOME/OSX-KVM}"                 # clone of https://github.com/kholia/OSX-KVM
BASE="${BASE:-$HOME/macvm/mac_base.qcow2}"        # installed + prepared guest (LNX-S08..S10)
RUNDIR="${RUNDIR:-$HOME/macvm/runs/$RUN_NAME}"
RAM_MB="${RAM_MB:-6144}"                          # 4096 boots (OSX-KVM default); 6144 leaves room for Safari
CPUS="${CPUS:-4}"                                 # threads; keep it a power of two (OSX-KVM notes)
GUEST_USER="${GUEST_USER:-tester}"                # the auto-login account created in the guest
SSH_KEY="${SSH_KEY:-$HOME/.ssh/macvm_ed25519}"
SSH_PORT=2222; WD_PORT=4444; SITE_PORT=8090
# -------------------------------------------------------------------------------------------------

mkdir -p "$RUNDIR"
# The Apple SMC string is read from OSX-KVM's own boot script (not copied into this file).
OSK_KEY="$(sed -n 's/.*isa-applesmc,osk="\([^"]*\)".*/\1/p' "$OSXKVM/OpenCore-Boot.sh" | head -1)"
[ "${#OSK_KEY}" -gt 20 ] || { echo "Could not read the isa-applesmc osk value from $OSXKVM/OpenCore-Boot.sh"; exit 2; }

echo "[1/5] overlay disk on top of $BASE"
qemu-img create -q -f qcow2 -b "$BASE" -F qcow2 "$RUNDIR/run.qcow2"
cp "$OSXKVM/OVMF_VARS-1920x1080.fd" "$RUNDIR/OVMF_VARS.fd"

echo "[2/5] boot guest (VNC 127.0.0.1:5901, monitor $RUNDIR/monitor.sock)"
qemu-system-x86_64 \
  -enable-kvm -m "$RAM_MB" \
  -cpu Skylake-Client,-hle,-rtm,kvm=on,vendor=GenuineIntel,+invtsc,vmware-cpuid-freq=on,+ssse3,+sse4.2,+popcnt,+avx,+aes,+xsave,+xsaveopt,check \
  -machine q35 \
  -smp "$CPUS",cores="$((CPUS / 2))",sockets=1 \
  -device qemu-xhci,id=xhci -device usb-kbd,bus=xhci.0 -device usb-tablet,bus=xhci.0 \
  -device "isa-applesmc,osk=$OSK_KEY" \
  -drive if=pflash,format=raw,readonly=on,file="$OSXKVM/OVMF_CODE_4M.fd" \
  -drive if=pflash,format=raw,file="$RUNDIR/OVMF_VARS.fd" \
  -smbios type=2 \
  -device ich9-ahci,id=sata \
  -drive id=OpenCoreBoot,if=none,snapshot=on,format=qcow2,file="$OSXKVM/OpenCore/OpenCore.qcow2" \
  -device ide-hd,bus=sata.2,drive=OpenCoreBoot \
  -drive id=MacHDD,if=none,file="$RUNDIR/run.qcow2",format=qcow2 \
  -device ide-hd,bus=sata.4,drive=MacHDD \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22 \
  -device virtio-net-pci,netdev=net0,id=net0,mac=52:54:00:c9:18:27 \
  -device vmware-svga \
  -display none -vnc 127.0.0.1:1 \
  -monitor unix:"$RUNDIR/monitor.sock",server,nowait \
  -daemonize -pidfile "$RUNDIR/qemu.pid"

SSHO=(ssh -i "$SSH_KEY" -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR)
TARGET="$GUEST_USER@127.0.0.1"
SSH=("${SSHO[@]}" "$TARGET")   # options first, destination last; anything after it is the remote command
TUNNEL_PID=""; SERVER_PID=""
cleanup() {
  set +e   # best effort from here on
  if [ -n "$TUNNEL_PID" ]; then kill "$TUNNEL_PID" 2>/dev/null; fi
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; fi
  echo "[5/5] power off guest, delete overlay"
  "${SSH[@]}" 'sudo -n shutdown -h now' 2>/dev/null || true
  for _ in $(seq 1 12); do
    [ -f "$RUNDIR/qemu.pid" ] && kill -0 "$(cat "$RUNDIR/qemu.pid")" 2>/dev/null || break
    sleep 5
  done
  if [ -f "$RUNDIR/qemu.pid" ] && kill -0 "$(cat "$RUNDIR/qemu.pid")" 2>/dev/null; then
    echo quit | socat - UNIX-CONNECT:"$RUNDIR/monitor.sock" 2>/dev/null || kill "$(cat "$RUNDIR/qemu.pid")"
  fi
  rm -f "$RUNDIR/run.qcow2"
}
trap cleanup EXIT
echo "[3/5] waiting for SSH (boot takes a few minutes without GPU acceleration)"
T0=$(date +%s)
until "${SSH[@]}" true 2>/dev/null; do
  sleep 5
  if [ $(( $(date +%s) - T0 )) -gt 900 ]; then echo "guest did not come up in 15 min"; exit 3; fi
done
echo "    SSH up after $(( $(date +%s) - T0 )) s; guest: $("${SSH[@]}" 'sw_vers -productVersion; sysctl -n hw.memsize' | tr '\n' ' ')"

node "$PROTO/node-reference.mjs" --repo "$REPO_CHECKOUT" --out "$RUNDIR/reference-node.json"
node "$PROTO/probe-server.mjs" --repo "$REPO_CHECKOUT" --port "$SITE_PORT" --reports "$RUNDIR/posted" > "$RUNDIR/probe-server.log" 2>&1 &
SERVER_PID=$!
"${SSHO[@]}" -N -L "${WD_PORT}:127.0.0.1:${WD_PORT}" -R "${SITE_PORT}:127.0.0.1:${SITE_PORT}" "$TARGET" &
TUNNEL_PID=$!
# sshd is up before automatic login has started safaridriver: poll for up to 2 minutes.
for i in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:${WD_PORT}/status" >/dev/null 2>&1 && break
  [ "$i" -eq 40 ] && { echo "safaridriver not reachable through the tunnel (is the LaunchAgent loaded? see prepare-guest.sh step 7)"; exit 4; }
  sleep 3
done

echo "[4/5] run the suite in Safari"
node "$PROTO/run-suite.mjs" --browser safari --webdriver "http://127.0.0.1:${WD_PORT}" \
  --site "http://127.0.0.1:${SITE_PORT}" --reference "$RUNDIR/reference-node.json" \
  --out "$PROTO/results/$RUN_NAME" --label "macOS VM on Linux/KVM, ${RAM_MB} MiB, ${CPUS} vCPU" || true
echo "results: $PROTO/results/$RUN_NAME/summary.md"
