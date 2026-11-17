#!/usr/bin/env bash
# WGO kiosk: turns a Raspberry Pi into a wall display for a WGO project.
#
# Get the command from the dashboard (Kiosks → Set up). It looks like this:
#
#   curl -fsSL https://wgo.example.com/downloads/wgo-kiosk.sh | sudo bash -s -- 'https://wgo.example.com/#/kiosk/ks_…'
#
# Works on Raspberry Pi OS Bookworm or newer, Lite or Desktop, 32- or 64-bit (and other Debian-based systems
# with a screen). It:
#   1. installs Chromium and cage, a minimal compositor that runs one app full screen,
#   2. adds an unprivileged user, wgo-kiosk, that runs them on the screen (tty1) from boot,
#   3. shows "Connecting to WGO…" until the network is up, then opens the kiosk,
#   4. restarts the browser if it ever exits, and once a night at 04:00 to stay fresh.
# The screen stays on and the pointer hides itself. What the screen shows is chosen in the dashboard, so you
# don't need to touch the Pi again. Run the same command again to change the link; it is safe to repeat.
#
# On Raspberry Pi OS Desktop the desktop no longer starts at boot (the kiosk takes the screen); --uninstall
# brings it back.
#
# Options:
#   --no-reboot    don't reboot at the end (only needed when a desktop was running)
#   --status       show whether the kiosk is running
#   --uninstall    remove the kiosk and restore the previous boot target (installed packages stay)
#
# Once installed, this script is also on the Pi as `wgo-kiosk`: sudo wgo-kiosk --status | --uninstall | '<new link>'
set -euo pipefail

NAME=wgo-kiosk
KIOSK_USER=wgo-kiosk
HOME_DIR=/var/lib/wgo-kiosk
CONF_DIR=/etc/wgo-kiosk
LIB_DIR=/usr/local/lib/wgo-kiosk
UNIT=/etc/systemd/system/$NAME.service
RESTART_UNIT=/etc/systemd/system/$NAME-restart.service
RESTART_TIMER=/etc/systemd/system/$NAME-restart.timer
PAM_FILE=/etc/pam.d/$NAME
CLI=/usr/local/sbin/wgo-kiosk

say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
Usage: sudo wgo-kiosk '<kiosk URL>' [--no-reboot]
       sudo wgo-kiosk --status | --uninstall

Copy the full command from the WGO dashboard: Kiosks → Set up.
EOF
  exit 2
}

URL=""
ACTION=install
REBOOT=true
for arg in "$@"; do
  case "$arg" in
    --no-reboot) REBOOT=false ;;
    --uninstall) ACTION=uninstall ;;
    --status) ACTION=status ;;
    -h | --help) usage ;;
    -*) warn "Unknown option: $arg"; usage ;;
    *) [ -z "$URL" ] || usage; URL="$arg" ;;
  esac
done

# ---------------------------------------------------------------- status / uninstall

if [ "$ACTION" = status ]; then
  if [ -r "$CONF_DIR/kiosk.conf" ]; then
    # shellcheck disable=SC1091
    . "$CONF_DIR/kiosk.conf"
    echo "Kiosk:   ${KIOSK_URL%%#*}#/kiosk/ks_…${KIOSK_URL: -4}"
  elif [ -e "$CONF_DIR/kiosk.conf" ]; then
    echo "Kiosk:   installed (run with sudo to see the link)"
  else
    echo "Kiosk:   not installed"
  fi
  systemctl --no-pager status "$NAME.service" 2>/dev/null | sed -n '1,5p' || true
  echo "Logs:    journalctl -u $NAME -e"
  exit 0
fi

need_root() { [ "$(id -u)" -eq 0 ] || die "Run this as root: put sudo in front (… | sudo bash -s -- '<kiosk URL>', or sudo wgo-kiosk …)."; }

if [ "$ACTION" = uninstall ]; then
  need_root
  say "Removing the WGO kiosk"
  systemctl disable --now "$NAME-restart.timer" "$NAME.service" 2>/dev/null || true
  if [ -f "$CONF_DIR/previous-target" ]; then
    target="$(cat "$CONF_DIR/previous-target")"
    systemctl set-default "$target" >/dev/null && ok "Boot target restored to $target (the desktop starts at the next boot)"
  fi
  rm -f "$UNIT" "$RESTART_UNIT" "$RESTART_TIMER" "$PAM_FILE" "$CLI"
  rm -rf "$LIB_DIR" "$CONF_DIR"
  systemctl daemon-reload
  if id "$KIOSK_USER" >/dev/null 2>&1; then userdel -r "$KIOSK_USER" 2>/dev/null || userdel "$KIOSK_USER" || true; fi
  rm -rf "$HOME_DIR"
  ok "WGO kiosk removed. Chromium and cage are still installed (apt remove cage chromium to remove them)."
  exit 0
fi

# ---------------------------------------------------------------- checks

[ -n "$URL" ] || usage
# <dashboard>/#/kiosk/ks_<40 letters and digits>, exactly as the dashboard prints it. The strict pattern also
# keeps the URL safe to embed in the files below.
if ! [[ "$URL" =~ ^(https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*)/#/kiosk/ks_[A-Za-z0-9]{40}$ ]]; then
  die "That doesn't look like a WGO kiosk link. Copy the whole command from the dashboard (Kiosks → Set up); the link ends in #/kiosk/ks_ and 40 letters and digits."
fi
BASE="${BASH_REMATCH[1]}"
case "$BASE" in
  http://localhost* | http://127.* | http://\[::1\]*) die "The link points at $BASE, which is this Pi itself. Use the link from a deployed WGO." ;;
  http://*) warn "The link isn't HTTPS. That's fine on a local network, but the kiosk token travels unencrypted." ;;
esac
need_root

command -v apt-get >/dev/null || die "This script needs a Debian-based system such as Raspberry Pi OS (apt-get not found)."
command -v systemctl >/dev/null || die "This script needs systemd."
[ -e /dev/tty1 ] || die "No console (/dev/tty1) found; the kiosk needs a screen attached to this machine."

MODEL=""
[ -r /proc/device-tree/model ] && MODEL="$(tr -d '\0' </proc/device-tree/model)"
[ -n "$MODEL" ] || MODEL="$(hostname)"
# in subshells: os-release defines NAME and friends, which would clobber ours
CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
PRETTY_NAME="$(. /etc/os-release && echo "${PRETTY_NAME:-Linux}")"
MEM_MB="$(awk '/^MemTotal/ { print int($2 / 1024) }' /proc/meminfo)"
say "Setting up a WGO kiosk on $MODEL ($PRETTY_NAME, ${MEM_MB} MB RAM)"
say "Kiosk at ${BASE}"
case "$CODENAME" in
  buster | bullseye) die "Raspberry Pi OS ${CODENAME^} is too old. Flash Raspberry Pi OS Bookworm or newer with Raspberry Pi Imager." ;;
esac
[ "$MEM_MB" -ge 900 ] || warn "This Pi has ${MEM_MB} MB of RAM. Chromium runs, but the visitor map is slow below 1 GB."

# ---------------------------------------------------------------- packages

# A fresh Pi may not have the time yet, and apt refuses package lists "from the future": wait for NTP briefly.
if command -v timedatectl >/dev/null; then
  for _ in $(seq 1 30); do
    [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo yes)" = yes ] && break
    [ "${waited:-}" ] || { say "Waiting for the clock to sync"; waited=1; }
    sleep 2
  done
fi

export DEBIAN_FRONTEND=noninteractive
say "Updating package lists"
apt-get update -qq || die "apt-get update failed. Check the network connection and try again."

# Raspberry Pi OS Bookworm ships its optimised Chromium as chromium-browser; Trixie and Debian call it chromium.
has_pkg() {
  local c
  c="$(apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/ { print $2 }')"
  [ -n "$c" ] && [ "$c" != "(none)" ]
}
CHROMIUM_PKG=""
if [ "$CODENAME" = bookworm ]; then order="chromium-browser chromium"; else order="chromium chromium-browser"; fi
for p in $order; do if has_pkg "$p"; then CHROMIUM_PKG="$p"; break; fi; done
[ -n "$CHROMIUM_PKG" ] || die "No Chromium package found for this system."
has_pkg cage || die "The cage package isn't available here. Raspberry Pi OS Bookworm or newer has it."

PKGS=(cage "$CHROMIUM_PKG" curl fonts-dejavu-core fonts-noto-color-emoji)
has_pkg fonts-inter && PKGS+=(fonts-inter)                  # the dashboard's typeface, if packaged
has_pkg rpi-chromium-mods && PKGS+=(rpi-chromium-mods)      # Raspberry Pi tuning for Chromium
say "Installing ${PKGS[*]} (a few minutes on the first run)"
apt-get install -y -qq --no-install-recommends "${PKGS[@]}" >/dev/null || apt-get install -y "${PKGS[@]}"
CHROMIUM="$(command -v chromium || command -v chromium-browser || true)"
CAGE="$(command -v cage || true)"
[ -n "$CHROMIUM" ] && [ -n "$CAGE" ] || die "Chromium or cage didn't install correctly."
ok "Installed $("$CHROMIUM" --version 2>/dev/null | head -n1 || echo Chromium) and cage"

# ---------------------------------------------------------------- user and files

if ! id "$KIOSK_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$HOME_DIR" --shell /usr/sbin/nologin --comment "WGO kiosk" "$KIOSK_USER"
fi
for g in video render input audio; do getent group "$g" >/dev/null && usermod -aG "$g" "$KIOSK_USER"; done
mkdir -p "$HOME_DIR" && chown "$KIOSK_USER:" "$HOME_DIR" && chmod 700 "$HOME_DIR"

install -d -m 755 "$CONF_DIR" "$LIB_DIR"
# The link is the kiosk's only credential: readable by root and the kiosk user only.
umask 027
printf "KIOSK_URL='%s'\nKIOSK_BASE='%s'\n" "$URL" "$BASE" >"$CONF_DIR/kiosk.conf"
chgrp "$KIOSK_USER" "$CONF_DIR/kiosk.conf"
chmod 640 "$CONF_DIR/kiosk.conf"
umask 022

# Shown until the dashboard answers (the Pi often boots before Wi-Fi is up). It probes with an image, which
# needs no CORS, then opens the kiosk. Readable only by the kiosk user, as it contains the link.
cat >"$LIB_DIR/splash.html" <<EOF
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>WGO kiosk</title>
<style>
  html, body { margin: 0; height: 100%; cursor: none; }
  body { display: grid; place-items: center; background: radial-gradient(120% 60% at 10% 0%, rgba(139,124,246,.22), transparent 60%), #0a0a0f;
    color: #f0efec; font: 22px/1.5 Inter, system-ui, sans-serif; text-align: center; }
  p { color: #a3a2b0; font-size: 17px; margin: 8px 0 0; }
  svg { animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .45; } }
</style></head>
<body><div>
  <svg width="72" height="72" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8b7cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#g)" opacity=".16"/><rect x=".5" y=".5" width="31" height="31" rx="8.5" fill="none" stroke="url(#g)" opacity=".6"/><path d="M7 21.5 12.5 14l5 4.2L25 9" fill="none" stroke="url(#g)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="25" cy="9" r="2.2" fill="#22d3ee"/></svg>
  <div style="margin-top:18px">Connecting to WGO…</div>
  <p id="sub">${BASE#*://}</p>
</div>
<script>
  var target = '${URL}', probe = '${BASE}/favicon.svg', started = Date.now();
  function attempt() {
    var img = new Image();
    img.onload = function () { location.replace(target); };
    img.onerror = function () {
      if (Date.now() - started > 60000) document.getElementById('sub').textContent = 'Still waiting for the network. Check the Wi-Fi or cable.';
      setTimeout(attempt, 3000);
    };
    img.src = probe + '?t=' + Date.now();
  }
  attempt();
</script>
</body></html>
EOF
chgrp "$KIOSK_USER" "$LIB_DIR/splash.html"
chmod 640 "$LIB_DIR/splash.html"

# Runs inside cage as the kiosk user.
cat >"$LIB_DIR/start" <<EOF
#!/bin/sh
set -eu
PROFILE="\$HOME/chromium"
mkdir -p "\$PROFILE/Default"
# After a power cut Chromium thinks it crashed and offers to restore pages: record a clean exit instead.
PREFS="\$PROFILE/Default/Preferences"
[ -f "\$PREFS" ] && sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "\$PREFS"
# Chromium's component updater downloads the Widevine DRM plugin on the first run, and on arm64 the zygote then
# crashes on every later start while preloading it ("Zygote process exited prematurely"). The kiosk needs no DRM:
# drop any downloaded copy and keep the updater off (Chromium itself is updated by apt).
rm -rf "\$PROFILE/WidevineCdm"
exec "$CHROMIUM" \\
  --kiosk --start-fullscreen --ozone-platform=wayland \\
  --user-data-dir="\$PROFILE" --disable-component-update \\
  --noerrdialogs --disable-infobars --no-first-run --no-default-browser-check \\
  --disable-session-crashed-bubble --disable-features=Translate,TranslateUI,MediaRouter \\
  --password-store=basic --disable-pinch --overscroll-history-navigation=0 \\
  --check-for-update-interval=31536000 --autoplay-policy=no-user-gesture-required \\
  "file://$LIB_DIR/splash.html"
EOF
chmod 755 "$LIB_DIR/start"

# ---------------------------------------------------------------- services

# A login session on tty1 for the kiosk user, so cage gets the screen and input devices from logind.
cat >"$PAM_FILE" <<'EOF'
auth     required pam_unix.so nullok
account  required pam_unix.so
session  required pam_unix.so
session  required pam_systemd.so type=wayland class=user
EOF

cat >"$UNIT" <<EOF
[Unit]
Description=WGO kiosk (Chromium full screen in cage on tty1)
After=systemd-user-sessions.service plymouth-quit-wait.service getty@tty1.service dbus.socket systemd-logind.service
Wants=dbus.socket systemd-logind.service
Conflicts=getty@tty1.service
ConditionPathExists=/dev/tty1

[Service]
Type=simple
User=$KIOSK_USER
PAMName=$NAME
WorkingDirectory=$HOME_DIR
Environment=XDG_SESSION_TYPE=wayland
ExecStart=$CAGE -d -s -- $LIB_DIR/start
Restart=always
RestartSec=3
UtmpIdentifier=tty1
UtmpMode=user
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
StandardInput=tty-fail
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# A fresh browser every night keeps a months-long run tidy. The kiosk page also reloads itself every 12 hours.
cat >"$RESTART_UNIT" <<EOF
[Unit]
Description=Restart the WGO kiosk browser

[Service]
Type=oneshot
ExecStart=/bin/systemctl try-restart $NAME.service
EOF
cat >"$RESTART_TIMER" <<EOF
[Unit]
Description=Restart the WGO kiosk browser nightly

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=false

[Install]
WantedBy=timers.target
EOF

# The kiosk takes the screen at boot: a desktop session would compete for it.
NEED_REBOOT=false
current_target="$(systemctl get-default)"
if [ "$current_target" = graphical.target ]; then
  [ -f "$CONF_DIR/previous-target" ] || echo "$current_target" >"$CONF_DIR/previous-target"
  systemctl set-default multi-user.target >/dev/null
  systemctl is-active --quiet display-manager.service 2>/dev/null && NEED_REBOOT=true
  say "The desktop no longer starts at boot; the kiosk takes the screen. Undo with --uninstall."
fi

systemctl daemon-reload
systemctl enable "$NAME.service" "$NAME-restart.timer" >/dev/null 2>&1 || die "Could not enable the kiosk services."
systemctl start "$NAME-restart.timer"

# Keep this script on the Pi for --status, --uninstall and changing the link later.
if curl -fsSL --max-time 20 "$BASE/downloads/wgo-kiosk.sh" -o "$CLI.tmp" 2>/dev/null && head -n1 "$CLI.tmp" | grep -q bash; then
  install -m 755 "$CLI.tmp" "$CLI"
fi
rm -f "$CLI.tmp"

# ---------------------------------------------------------------- go

if curl -fsS -o /dev/null --max-time 10 "$BASE/favicon.svg"; then
  ok "The dashboard at $BASE answers"
else
  warn "Can't reach $BASE right now. The kiosk keeps trying and opens as soon as it can."
fi

echo
if [ "$NEED_REBOOT" = true ]; then
  ok "WGO kiosk installed. It starts when the Pi reboots."
  if [ "$REBOOT" = true ]; then
    say "Rebooting in 10 seconds (Ctrl+C to cancel, then reboot later)"
    sleep 10
    systemctl reboot
  else
    echo "  Reboot to start it: sudo reboot"
  fi
else
  systemctl restart "$NAME.service"
  sleep 3
  if systemctl is-active --quiet "$NAME.service"; then
    ok "WGO kiosk is running on the screen, and starts at every boot."
  else
    warn "The kiosk didn't start. See: journalctl -u $NAME -e"
    exit 1
  fi
fi
cat <<EOF
  What it shows:  choose in the WGO dashboard, under Kiosks
  Status:         sudo wgo-kiosk --status
  Logs:           journalctl -u $NAME -e
  New link:       sudo wgo-kiosk '<link>'
  Remove:         sudo wgo-kiosk --uninstall
EOF
