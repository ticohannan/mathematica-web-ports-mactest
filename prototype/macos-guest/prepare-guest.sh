#!/bin/bash
# SPDX-FileCopyrightText: 2026 Tico Hannan
# SPDX-License-Identifier: MIT
# prototype/macos-guest/prepare-guest.sh — INVESTIGATION CODE, NOT RUN YET (no macOS was
# available). Run ONCE inside a freshly installed macOS guest, logged in as the test account, from
# Terminal or over SSH, BEFORE the base image is frozen (MACVM-LNX LNX-S10 / MACVM-WIN WIN-S09).
# Each step prints what it did; if one fails, the rest still run. Check the printout.
#
# What it sets up is everything the host needs (MACVM-OVR OVR-R03): Safari's WebDriver enabled,
# safaridriver running at login inside the GUI session on 127.0.0.1:4444, and a guest that does not
# sleep, lock, index or update itself. No Node.js, no agent software: the host drives the tests.
set -u
step() { echo; echo "== $*"; }

step "1. Enable Safari's WebDriver (asks for your password once)"
sudo safaridriver --enable || echo "!! failed: run 'safaridriver --enable' in Terminal in the GUI session"
# The same preference GitHub's macOS runner images set (actions/runner-images, install-safari.sh):
mkdir -p "$HOME/Library/WebDriver"
/usr/libexec/PlistBuddy -c 'delete AllowRemoteAutomation' "$HOME/Library/WebDriver/com.apple.Safari.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'add AllowRemoteAutomation bool true' "$HOME/Library/WebDriver/com.apple.Safari.plist"

step "2. Keep the machine awake (no system, display or disk sleep)"
sudo pmset -a sleep 0 displaysleep 0 disksleep 0 || echo "!! pmset failed"

step "3. No screen saver"
defaults -currentHost write com.apple.screensaver idleTime -int 0

step "4. Stop Spotlight indexing (saves CPU and disk I/O in the VM)"
sudo mdutil -a -i off || echo "!! mdutil failed"

step "5. No automatic macOS/App Store updates (an update can break the OpenCore boot)"
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled -bool false
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool false
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
sudo defaults write /Library/Preferences/com.apple.commerce AutoUpdate -bool false

step "6. Less animation and transparency (less work for the software renderer)"
defaults write com.apple.universalaccess reduceMotion -bool true 2>/dev/null || echo "   (set it in System Settings > Accessibility > Display instead)"
defaults write com.apple.universalaccess reduceTransparency -bool true 2>/dev/null || true

step "7. safaridriver as a LaunchAgent: starts at login in the GUI session, port 4444, localhost only"
mkdir -p "$HOME/Library/LaunchAgents"
PLIST="$HOME/Library/LaunchAgents/local.safaridriver.plist"
cat > "$PLIST" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.safaridriver</string>
  <key>ProgramArguments</key><array><string>/usr/bin/safaridriver</string><string>-p</string><string>4444</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/safaridriver.log</string>
  <key>StandardErrorPath</key><string>/tmp/safaridriver.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "   loaded" || echo "!! not loaded now; it will load at the next login"
sleep 2
curl -s http://127.0.0.1:4444/status && echo || echo "!! safaridriver not answering on 4444 yet"

step "7b. Let the test account shut the guest down without a password (used at the end of each run)"
echo "$(whoami) ALL=(root) NOPASSWD: /sbin/shutdown" | sudo tee /etc/sudoers.d/macvm-shutdown >/dev/null && sudo chmod 440 /etc/sudoers.d/macvm-shutdown && echo "   ok"

step "8. What this guest is (paste into MACVM test log)"
sw_vers
echo "Safari: $(defaults read /Applications/Safari.app/Contents/Info CFBundleShortVersionString 2>/dev/null)"
sysctl -n machdep.cpu.brand_string hw.ncpu hw.memsize
df -h / | tail -1
system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Chipset|Metal|VRAM" || true

echo
echo "Still to do BY HAND (GUI, once): System Settings > Users & Groups > Automatically log in as: this user"
echo "(not possible with FileVault on), and System Settings > General > Sharing > Remote Login: on."
