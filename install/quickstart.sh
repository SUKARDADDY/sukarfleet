#!/usr/bin/env bash
# sukarfleet quickstart: everything a machine needs that does NOT require root.
# Idempotent by construction — safe to re-run on every update, and that is the
# intended upgrade path (`quickstart.sh --restart`).
#
# Deliberately machine-agnostic: identity comes from `hostname` and `$USER`, and
# anything it cannot know (mesh address, role, repos, peers) is left at a safe
# default for the setup GUI to fill in. Nothing here is allowed to hardcode a
# machine name: a fleet you cannot add a third machine to is not a fleet.
#
# What it does NOT do: install EasyTier, write anything under /etc, create a
# sudoers rule, or ask for a password. There is exactly one root step in the
# whole install and it lives in install-elevated.sh.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

CONFIG_DIR="$HOME/.config/sukarfleet"
CONFIG_FILE="$CONFIG_DIR/config.json"
SECRETS_DIR="$CONFIG_DIR/secrets"
STATE_DIR="${SUKARFLEET_STATE:-$HOME/.local/state/sukarfleet}"
KNOWN_HOSTS="$STATE_DIR/known_hosts"
SSH_DIR="$HOME/.ssh"
SSH_KEY="$SSH_DIR/id_sukarfleet_ed25519"
AUTHORIZED_KEYS="$SSH_DIR/authorized_keys"
USER_UNIT_DIR="$HOME/.config/systemd/user"
UNIT_SRC="$REPO_ROOT/systemd/sukarfleet.service"
UNIT_DST="$USER_UNIT_DIR/sukarfleet.service"
ELEVATED="$REPO_ROOT/install/install-elevated.sh"

DO_RESTART=0
DO_OPEN=1
OPT_MACHINE=""
OPT_ROLE=""
OPT_MESH_IP=""

log()  { printf '[quickstart] %s\n' "$*"; }
warn() { printf '[quickstart] WARNING: %s\n' "$*" >&2; }
die()  { printf '[quickstart] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: install/quickstart.sh [--restart] [--no-open]
                             [--machine=NAME] [--role=anchor|roamer] [--mesh-ip=A.B.C.D]

  --restart      Upgrade path: daemon-reload + restart the running service.
  --no-open      Do not xdg-open the GUI at the end (prints the URL either way).
  --machine=     Override the machine name (default: \`hostname\`).
  --role=        anchor (always-on) or roamer. Default: anchor for the first
                 machine in a fleet; change it later in the GUI.
  --mesh-ip=     This machine's mesh TUN address (e.g. 192.0.2.3).

  The identity flags only apply when scaffolding a NEW config.json. An existing
  config keeps its identity, its peers and every lane switch; the only thing this
  script writes into one is the admin lane's non-privileged fields when they are
  missing (see §3). Everything else is edited from the GUI.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --restart) DO_RESTART=1 ;;
    --no-open) DO_OPEN=0 ;;
    --machine=*) OPT_MACHINE="${arg#*=}" ;;
    --role=*) OPT_ROLE="${arg#*=}" ;;
    --mesh-ip=*) OPT_MESH_IP="${arg#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $arg" ;;
  esac
done

case "${OPT_ROLE:-anchor}" in
  anchor|roamer) ;;
  *) die "--role must be 'anchor' or 'roamer', got '$OPT_ROLE'" ;;
esac

# --- 1. bun -----------------------------------------------------------------
BUN_BIN="$HOME/.bun/bin/bun"
if [ ! -x "$BUN_BIN" ]; then
  BUN_BIN="$(command -v bun || true)"
fi
[ -n "$BUN_BIN" ] && [ -x "$BUN_BIN" ] || \
  die "bun not found at ~/.bun/bin/bun or on PATH — install Bun (https://bun.sh), then re-run."
log "bun $("$BUN_BIN" --version) at $BUN_BIN"

# --- 2. private directories -------------------------------------------------
# 0700 must actually stick. On a mode-blind mount (fuseblk, exFAT, NTFS) chmod is inert
# and every mode reads back 0777, which would silently make the credential store
# world-readable; secrets.ts refuses to operate there, so catch it at install
# time rather than at the first credential save.
ensure_private_dir() {
  local dir="$1" label="$2" mode
  mkdir -p "$dir"
  chmod 700 "$dir"
  mode="$(stat -c '%a' "$dir" 2>/dev/null || echo '?')"
  if [ "$mode" != "700" ]; then
    warn "$label ($dir) reads back mode $mode after chmod 700 — this is not a real POSIX filesystem (fuseblk?). The credential store will refuse to operate here. Move \$HOME or SUKARFLEET_STATE onto ext4."
  fi
}

ensure_private_dir "$CONFIG_DIR" "config dir"
ensure_private_dir "$SECRETS_DIR" "credential store"
ensure_private_dir "$STATE_DIR" "state dir"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

# --- 3. config.json (never overwrite; backfill the admin lane's plumbing) ----
MACHINE="${OPT_MACHINE:-$(hostname)}"
[ -n "$MACHINE" ] || die "hostname is empty and --machine= was not given"

# Is the admin lane switched on in the config we end up with? Drives the banner.
ADMIN_ENABLED=false

# Backfill for a machine installed before the admin lane existed: its config has
# no `admin` block at all, so mergeDefaults() hands the daemon sshUser:'' and the
# origin leg refuses every run — including a self-targeted one — with nothing on
# any screen saying why. Only the non-privileged fields are written: `enabled`
# and `acceptIncoming` are left exactly as found, because switching a root-capable
# lane on during an upgrade is the operator's call and false is the correct
# fail-closed default. Written through a temp file + rename so a daemon reading
# the config concurrently never sees a half-written one.
backfill_admin_fields() {
  SUKARFLEET_CONFIG_FILE="$CONFIG_FILE" SUKARFLEET_SSH_USER="${USER:-$(id -un)}" "$BUN_BIN" -e '
    const fs = require("node:fs");
    const path = process.env.SUKARFLEET_CONFIG_FILE;
    const user = process.env.SUKARFLEET_SSH_USER || "";
    const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) {
      console.error(String(e && e.message ? e.message : e));
      process.exit(1);
    }
    if (!isObj(cfg)) { console.error("config.json is not a JSON object"); process.exit(1); }
    // `admin: null` and a missing `admin` are the same case here, and both are what a
    // pre-lane machine actually has.
    const admin = isObj(cfg.admin) ? cfg.admin : {};
    const changed = [];
    if (typeof admin.sshUser !== "string" || admin.sshUser === "") {
      if (user) { admin.sshUser = user; changed.push("sshUser"); }
    }
    if (typeof admin.uiEnabled !== "boolean") { admin.uiEnabled = true; changed.push("uiEnabled"); }
    if (changed.length) {
      cfg.admin = admin;
      const tmp = path + ".quickstart.tmp";
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, path);
    }
    console.log((admin.enabled === true ? "true" : "false") + " " + (changed.join(",") || "-"));
  '
}

if [ -f "$CONFIG_FILE" ]; then
  BACKFILL="$(backfill_admin_fields)" || die "could not read $CONFIG_FILE as JSON — fix it by hand, then re-run."
  ADMIN_ENABLED="${BACKFILL%% *}"
  ADMIN_CHANGED="${BACKFILL#* }"
  if [ "$ADMIN_CHANGED" = "-" ]; then
    log "config exists at $CONFIG_FILE — left untouched."
  else
    log "config exists at $CONFIG_FILE — backfilled admin.${ADMIN_CHANGED//,/, admin.} (lane switches untouched)."
  fi
else
  ROLE="${OPT_ROLE:-anchor}"
  MESH_IP="${OPT_MESH_IP:-}"
  log "scaffolding $CONFIG_FILE (machine=$MACHINE role=$ROLE meshIp=${MESH_IP:-<unset>})"
  # peers[] is empty on purpose: peers arrive through GUI pairing, which
  # exchanges the mesh public key, the SSH public key and the SSH host keys in
  # both directions. There is no JWK left to hand-paste (RUNBOOK-P1 §1.4).
  # repos[] is empty on purpose too: repo paths are machine-local and a wrong
  # path here syncs the wrong tree. Add them in config.json once the machine is
  # paired; every other key not written here comes from defaultConfig().
  cat > "$CONFIG_FILE" <<EOF
{
  "machine": "$MACHINE",
  "role": "$ROLE",
  "meshIp": "$MESH_IP",
  "nodePort": 7710,
  "networkName": "sukarfleet",
  "peers": [],
  "repos": [],
  "unionPaths": ["workspace-manifest.json", "workspace-removals.json"],
  "admin": {
    "enabled": true,
    "acceptIncoming": true,
    "sshUser": "$USER",
    "uiEnabled": true
  }
}
EOF
  chmod 600 "$CONFIG_FILE"
  ADMIN_ENABLED=true
  log "wrote $CONFIG_FILE (peers[] empty -- pair from the GUI)"
fi

NODE_PORT="$(grep -o '"nodePort"[[:space:]]*:[[:space:]]*[0-9]\+' "$CONFIG_FILE" | head -n1 | grep -o '[0-9]\+$' || true)"
NODE_PORT="${NODE_PORT:-7710}"
UI_URL="http://127.0.0.1:${NODE_PORT}/ui/"

# --- 4. fleet SSH identity ---------------------------------------------------
# One dedicated key per machine, never copied anywhere: pairing publishes only
# the public half, and the peer builds the restricted authorized_keys line
# locally. A personal id_ed25519 is deliberately not reused.
if [ -f "$SSH_KEY" ]; then
  log "fleet ssh key present: $SSH_KEY"
else
  command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen not found — install openssh-client, then re-run."
  ssh-keygen -q -t ed25519 -N '' -C "sukarfleet:$MACHINE" -f "$SSH_KEY"
  log "generated $SSH_KEY"
fi
chmod 600 "$SSH_KEY"
if [ -f "$SSH_KEY.pub" ]; then chmod 644 "$SSH_KEY.pub"; fi

# authorized_keys and known_hosts must exist with the right mode before the
# daemon rewrites a marked line into either of them; sshd ignores an
# authorized_keys file that is group- or world-writable.
[ -f "$AUTHORIZED_KEYS" ] || : > "$AUTHORIZED_KEYS"
chmod 600 "$AUTHORIZED_KEYS"
[ -f "$KNOWN_HOSTS" ] || : > "$KNOWN_HOSTS"
chmod 600 "$KNOWN_HOSTS"

if command -v sshd >/dev/null 2>&1 || [ -f /etc/ssh/sshd_config ]; then
  :
else
  warn "no sshd found on this machine — it can originate admin calls but cannot be the target of one until an SSH server is installed."
fi

# --- 5. Credential sealing probe (informational) -----------------------------
# Not a gate: the credential store degrades to 'no credential' rather than
# failing the install, and the GUI reports the same thing in plain words.
#
# The probe is a real encrypt->decrypt round trip, not `systemd-analyze
# has-tpm2`. A present TPM says nothing about whether THIS uid can seal with it:
# system-scope sealing needs /var/lib/systemd/credential.secret (0400 root), so
# on both current fleet machines it is refused for an unprivileged user while
# `--user` scope round-trips fine. Asking the question the code actually asks is
# the only way this line stays true.
if command -v systemd-creds >/dev/null 2>&1; then
  if printf 'probe' | timeout 5 systemd-creds encrypt --user --name=sukarfleet-install-probe - - 2>/dev/null | \
       timeout 5 systemd-creds decrypt --user --name=sukarfleet-install-probe - - 2>/dev/null | grep -q '^probe$'; then
    log "credential sealing works (user scope) — a stored sudo password is sealed at rest."
    log "  it is bound to this user on this host: a copy that leaks via a synced repo or backup is"
    log "  inert elsewhere. It does NOT defend against another process running as you, or a stolen"
    log "  unencrypted disk. See docs/RUNBOOK-P3.md."
  else
    warn "credential sealing does not work for this user — the Credentials screen will refuse to store a sudo password (fail-closed). The admin lane stays read-only on this machine."
  fi
else
  warn "systemd-creds not found — credential sealing unavailable on this machine."
fi

# --- 6. systemd user unit ----------------------------------------------------
mkdir -p "$USER_UNIT_DIR"
[ -f "$UNIT_SRC" ] || die "missing $UNIT_SRC"
sed "s|__SUKARFLEET_REPO__|$REPO_ROOT|g" "$UNIT_SRC" > "$UNIT_DST"
log "installed $UNIT_DST (WorkingDirectory=$REPO_ROOT)"

# WatchdogSec coupling (inherited from setup-user.sh, unchanged): the node
# derives its ping cadence and loop-freshness windows from
# cfg.intervals.watchdogSec, but the unit hardcodes WatchdogSec=120 and has no
# placeholder to template from config. Flag the drift instead of installing a
# unit that hard-kills the node inside its own freshness window.
CFG_WATCHDOG_SEC="$(grep -o '"watchdogSec"[[:space:]]*:[[:space:]]*[0-9]\+' "$CONFIG_FILE" 2>/dev/null | grep -o '[0-9]\+$' || true)"
CFG_WATCHDOG_SEC="${CFG_WATCHDOG_SEC:-120}"
UNIT_WATCHDOG_SEC="$(grep -o '^WatchdogSec=[0-9]\+' "$UNIT_DST" | grep -o '[0-9]\+$' || true)"
if [ -n "$UNIT_WATCHDOG_SEC" ] && [ "$UNIT_WATCHDOG_SEC" != "$CFG_WATCHDOG_SEC" ]; then
  warn "WatchdogSec=$UNIT_WATCHDOG_SEC in $UNIT_DST does not match intervals.watchdogSec=$CFG_WATCHDOG_SEC in $CONFIG_FILE. Edit WatchdogSec= to match, then: systemctl --user daemon-reload"
fi

# --- 7. desktop notification channel -----------------------------------------
# src/notify.ts prefers org.freedesktop.Notifications and falls back to
# org.gtk.Notifications; the GTK protocol only delivers for a registered
# .desktop app id, so install a hidden entry for the daemon.
APPS_DIR="$HOME/.local/share/applications"
DESKTOP_DST="$APPS_DIR/org.sukarfleet.node.desktop"
mkdir -p "$APPS_DIR"
if [ ! -f "$DESKTOP_DST" ]; then
  cat > "$DESKTOP_DST" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=sukarfleet
Comment=Fleet mesh node alerts
Exec=true
NoDisplay=true
DESKTOP
  log "installed notification app entry: $DESKTOP_DST"
fi

# Some GNOME installs ship without /usr/bin/gjs, so org.gnome.Shell.Notifications
# cannot activate. Where a user-level gjs already exists, point a user D-Bus
# service override at it. Remove the override to revert.
SYS_NOTIF_SVC="/usr/share/dbus-1/services/org.gnome.Shell.Notifications.service"
USER_DBUS_DIR="$HOME/.local/share/dbus-1/services"
USER_NOTIF_SVC="$USER_DBUS_DIR/org.gnome.Shell.Notifications.service"
if [ -f "$SYS_NOTIF_SVC" ] && [ ! -x /usr/bin/gjs ] && [ -x "$HOME/.local/bin/gjs" ] && [ ! -f "$USER_NOTIF_SVC" ]; then
  mkdir -p "$USER_DBUS_DIR"
  sed "s|^Exec=/usr/bin/gjs|Exec=$HOME/.local/bin/gjs|" "$SYS_NOTIF_SVC" > "$USER_NOTIF_SVC"
  log "installed user D-Bus override for GNOME notifications: $USER_NOTIF_SVC"
fi

# --- 8. enable + start -------------------------------------------------------
command -v systemctl >/dev/null 2>&1 || die "systemctl not found — this daemon runs as a systemd user unit."

# Without linger the node dies at logout, which is exactly when an always-on
# anchor is needed most.
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" >/dev/null 2>&1 || \
    warn "could not enable linger for $USER — the node will stop when you log out. Fix with: sudo loginctl enable-linger $USER"
fi

systemctl --user daemon-reload
systemctl --user enable sukarfleet.service >/dev/null 2>&1 || \
  warn "systemctl --user enable failed — starting anyway; the node will not come back after a reboot."
if [ "$DO_RESTART" = "1" ] || systemctl --user is-active --quiet sukarfleet.service; then
  systemctl --user restart sukarfleet.service
  log "restarted sukarfleet.service"
else
  systemctl --user start sukarfleet.service
  log "started sukarfleet.service"
fi

# --- 9. wait for /health ------------------------------------------------------
HEALTH_OK=0
for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${NODE_PORT}/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 0.5
done
if [ "$HEALTH_OK" = "1" ]; then
  log "daemon healthy on 127.0.0.1:${NODE_PORT}"
else
  warn "daemon did not answer /health within 20s. Check: systemctl --user status sukarfleet.service ; journalctl --user -u sukarfleet.service -n 50"
fi

# --- 10. the one root step ----------------------------------------------------
# Printed, never run. quickstart.sh never calls sudo, and it never writes a
# sudoers file: the admin lane authenticates with a stored password over SSH,
# not with a NOPASSWD grant to a helper binary.
ROOT_STEP="sudo $ELEVATED"
if grep -q -- '--adopt-pending-secret' "$ELEVATED" 2>/dev/null; then
  ROOT_STEP="sudo $ELEVATED --adopt-pending-secret"
fi
MESH_UP=0
if systemctl is-active --quiet easytier-fleet.service 2>/dev/null; then
  MESH_UP=1
fi

# --- 11. banner ---------------------------------------------------------------
cat <<BANNER

────────────────────────────────────────────────────────────────────────
  sukarfleet is installed on ${MACHINE}.

  Open the GUI:      ${UI_URL}
  Drive this machine's GUI from another machine:
      ssh -N -L 7711:127.0.0.1:${NODE_PORT} ${USER}@${MACHINE}
      then open http://127.0.0.1:7711/ui/ over there

BANNER
if [ "$ADMIN_ENABLED" != "true" ]; then
  cat <<BANNER
  Admin lane: OFF. Turn on the "Admin lane" switch on the GUI's Credentials
  screen (${UI_URL}) — until you do, every admin run from this machine, including
  a self-targeted one, refuses with lane-disabled.

BANNER
fi
if [ "$MESH_UP" = "1" ]; then
  cat <<BANNER
  Mesh: easytier-fleet.service is already running — no root step needed.
  Next: open the GUI, save this machine's sudo password on the Credentials
  screen, then pair (Pair screen) with a machine that is already in the fleet.
BANNER
else
  cat <<BANNER
  Mesh: not running yet. ONE root step, the only one in this install:

      ${ROOT_STEP}

  Do the GUI's "Mesh network" setup card first if this machine is joining an
  existing fleet — it stages the shared secret at
  ~/.local/state/sukarfleet/pending-easytier-secret (0600) so the secret never
  reaches a command line, your shell history, or ps.
BANNER
fi
cat <<BANNER
────────────────────────────────────────────────────────────────────────
BANNER

if [ "$DO_OPEN" = "1" ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$UI_URL" >/dev/null 2>&1 || true
fi
