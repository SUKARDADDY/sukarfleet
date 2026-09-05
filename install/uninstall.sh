#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Removes sukarfleet from this machine.
#
#   ./install/uninstall.sh              the user half, no password
#   sudo ./install/uninstall.sh --elevated   the root half, a second password
#
# Two halves for the same reason the install has two: a root-owned service and a
# sudoers drop-in cannot come out without root. The install promises one password
# moment going in; taking it back out is a second one, and that is stated rather
# than smuggled.
#
# What it deliberately LEAVES:
#   - every synced repository, untouched
#   - ~/.config/sukarfleet/config.json, so a reinstall recovers identity and peers
#   - ~/.ssh/id_sukarfleet_ed25519 and its public half
#   - ~/.ssh/authorized_keys, including marked peer lines
#   - the fleet known_hosts
# The last three stay because deleting them silently breaks the fleet's OTHER
# machines, which is not this script's call to make.
#
# Safe on a machine that was never installed: it says so and removes nothing.
#
# Requires bash, not sh.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"

CONFIG_DIR="$HOME/.config/sukarfleet"
CONFIG_FILE="$CONFIG_DIR/config.json"
SECRETS_DIR="$CONFIG_DIR/secrets"
STATE_DIR="${SUKARFLEET_STATE:-$HOME/.local/state/sukarfleet}"
PENDING_SECRET="$STATE_DIR/pending-easytier-secret"
USER_UNIT="$HOME/.config/systemd/user/sukarfleet.service"
DESKTOP_ENTRY="$HOME/.local/share/applications/org.sukarfleet.node.desktop"
USER_NOTIF_SVC="$HOME/.local/share/dbus-1/services/org.gnome.Shell.Notifications.service"
CLI_WRAPPER="$HOME/.local/bin/sukarfleet"
TRAY_BIN="$HOME/.local/bin/sukarfleet-tray"
AUTOSTART_FILE="$HOME/.config/autostart/sukarfleet-tray.desktop"
ELEVATED="$SCRIPT_DIR/install-elevated.sh"

DRY_RUN="${SUKARFLEET_DRY_RUN:-0}"
DO_ELEVATED=0

log()  { printf '[uninstall] %s\n' "$*"; }
# "a, b and c", because "a b c" reads as one thing with spaces in it.
join_list() {
  local n=$#
  case "$n" in
    0) printf 'nothing' ;;
    1) printf '%s' "$1" ;;
    *) local last="${!n}"; printf '%s and %s' "$(printf '%s, ' "${@:1:n-1}" | sed 's/, $//')" "$last" ;;
  esac
}
warn() { printf '[uninstall] WARNING: %s\n' "$*" >&2; }
dry()  { printf '[uninstall] [dry-run] %s\n' "$*"; }
die()  { printf '[uninstall] ERROR: %s\n' "$1" >&2; exit "${2:-2}"; }

act() {
  if [ "$DRY_RUN" = "1" ]; then dry "$*"; return 0; fi
  "$@"
}
sctl() {
  if [ "$DRY_RUN" = "1" ]; then dry "systemctl $*"; return 1; fi
  # stdout only: systemctl's chatter is noise, its stderr is the reason a step
  # failed. Redirecting here rather than at the call sites is what keeps a dry
  # run's printed line from being swallowed by the same redirect.
  systemctl "$@" >/dev/null
}

usage() {
  cat <<EOF
usage: ./install/uninstall.sh [--elevated] [--yes]

  (no flags)   The user half. Stops and removes the systemd user unit, the tray,
               its autostart entry, the CLI wrapper and the notification entry;
               shreds the stored credential and the staged mesh secret. Prints
               the root line at the end.
  --elevated   The root half, run with sudo. Removes easytier-fleet.service,
               /opt/easytier, /etc/easytier, the sudoers drop-in and the firewall
               rules this installer added.
  --yes        Do not ask for confirmation.

Environment:
  SUKARFLEET_DRY_RUN=1  print every removal instead of making it
  SUKARFLEET_STATE=DIR  state directory (also read by the daemon)
EOF
}

ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --elevated) DO_ELEVATED=1 ;;
    --yes|-y)   ASSUME_YES=1 ;;
    -h|--help)  usage; exit 0 ;;
    *) printf '[uninstall] ERROR: unknown argument: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

# =============================================================================
# The root half. Delegated to install-elevated.sh --remove, which is the script
# that knows what it installed -- two implementations of "what did we put under
# /etc" is how one of them goes stale.
# =============================================================================
if [ "$DO_ELEVATED" = "1" ]; then
  if [ "$(id -u)" -ne 0 ] && [ "$DRY_RUN" != "1" ]; then
    die "--elevated must be run as root: sudo $0 --elevated" 2
  fi
  [ -f "$ELEVATED" ] || die "$ELEVATED is missing, so the root half cannot run. Remove /etc/systemd/system/easytier-fleet.service, /etc/easytier, /opt/easytier and /etc/sudoers.d/sukarfleet-transport by hand." 2
  log "removing the root half through install-elevated.sh --remove"
  SUKARFLEET_DRY_RUN="$DRY_RUN" bash "$ELEVATED" --remove
  cat <<'TAIL'

  The other machines still list this one as a peer. Remove it from their Fleet
  screen, or they will keep calling a number that no longer answers.
TAIL
  exit 0
fi

# =============================================================================
# The user half
# =============================================================================
if [ "$(id -u)" -eq 0 ] && [ -z "${SUDO_USER:-}" ]; then
  warn "running the user half as root will remove root's sukarfleet, not yours. Run it without sudo."
fi

# Nothing to do is a real answer, not an error: someone running this on a machine
# that never had sukarfleet should be told so and left alone.
ANY=0
for probe in "$USER_UNIT" "$CLI_WRAPPER" "$TRAY_BIN" "$AUTOSTART_FILE" "$DESKTOP_ENTRY" "$PENDING_SECRET" "$CONFIG_FILE"; do
  [ -e "$probe" ] && ANY=1
done
if [ -d "$SECRETS_DIR" ] && [ -n "$(ls -A "$SECRETS_DIR" 2>/dev/null)" ]; then ANY=1; fi
if [ "$ANY" = "0" ]; then
  log "nothing to remove: no sukarfleet.service, no /etc/sudoers.d/sukarfleet-transport, no easytier-fleet.service. Left everything alone."
  exit 0
fi

if [ "$ASSUME_YES" != "1" ] && [ "$DRY_RUN" != "1" ] && [ -t 0 ]; then
  printf '[uninstall] This removes the daemon, the tray and the stored credential from this machine.\n'
  printf '[uninstall] Your repositories, config.json, SSH key, authorized_keys and known_hosts stay.\n'
  printf '[uninstall] Continue? [y/N] '
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) log "cancelled. Nothing was removed."; exit 0 ;;
  esac
fi

REMOVED=()

# --- the daemon ---------------------------------------------------------------
if [ -f "$USER_UNIT" ] || [ "$DRY_RUN" = "1" ]; then
  sctl --user disable --now sukarfleet.service 2>/dev/null || true
  act rm -f "$USER_UNIT"
  sctl --user daemon-reload 2>/dev/null || true
  REMOVED+=("sukarfleet.service")
fi

# --- the tray -----------------------------------------------------------------
if [ -e "$TRAY_BIN" ] || [ "$DRY_RUN" = "1" ]; then
  sctl --user stop sukarfleet-tray.service 2>/dev/null || true
  act rm -f "$TRAY_BIN"
  REMOVED+=("the tray")
fi
if [ -e "$AUTOSTART_FILE" ] || [ "$DRY_RUN" = "1" ]; then
  act rm -f "$AUTOSTART_FILE"
  REMOVED+=("its autostart entry")
fi

# --- the CLI wrapper and the desktop entries -----------------------------------
if [ -e "$CLI_WRAPPER" ] || [ "$DRY_RUN" = "1" ]; then
  act rm -f "$CLI_WRAPPER"
  REMOVED+=("the CLI wrapper")
fi
if [ -e "$DESKTOP_ENTRY" ] || [ "$DRY_RUN" = "1" ]; then
  act rm -f "$DESKTOP_ENTRY"
  REMOVED+=("the notification app entry")
fi
# Only if this installer wrote it: quickstart writes the override solely to point
# at a user-level gjs, and a hand-written one there is somebody else's.
if [ -f "$USER_NOTIF_SVC" ] && grep -q "^Exec=$HOME/.local/bin/gjs" "$USER_NOTIF_SVC" 2>/dev/null; then
  act rm -f "$USER_NOTIF_SVC"
  REMOVED+=("the GNOME notification D-Bus override")
fi

# Only when something actually came off. "stopped and removed nothing" was
# printed on a machine whose daemon was already gone and whose credential and
# staged secret were about to be shredded two lines below -- a summary that
# contradicted the next line of its own output.
if [ "${#REMOVED[@]}" -gt 0 ]; then
  log "stopped and removed $(join_list "${REMOVED[@]}")"
fi

# --- secrets ------------------------------------------------------------------
# Overwrite before delete, with the same honesty about what it buys as the
# installer: no guarantee on a copy-on-write filesystem or a wear-levelling SSD,
# but it does keep a secret out of a trivially undeleted file.
shred_file() {
  local f="$1" size
  if [ "$DRY_RUN" = "1" ]; then dry "shred and unlink $f"; return 0; fi
  [ -f "$f" ] || return 0
  if command -v shred >/dev/null 2>&1 && shred -u -z -n 1 "$f" 2>/dev/null; then return 0; fi
  size="$(stat -c '%s' "$f" 2>/dev/null || echo 0)"
  dd if=/dev/zero of="$f" bs=1 count="$size" conv=notrunc >/dev/null 2>&1 || true
  rm -f "$f"
}

SHREDDED=()
if [ -f "$PENDING_SECRET" ] || [ "$DRY_RUN" = "1" ]; then
  shred_file "$PENDING_SECRET"
  SHREDDED+=("the staged mesh secret")
fi
CRED_COUNT=0
if [ -d "$SECRETS_DIR" ]; then
  while IFS= read -r -d '' f; do
    shred_file "$f"
    CRED_COUNT=$((CRED_COUNT + 1))
  done < <(find "$SECRETS_DIR" -maxdepth 1 -type f -print0 2>/dev/null)
fi
# An empty secrets directory is not a stored credential, and saying it shredded
# one would be a lie in the one place a reader is checking what came off.
if [ "$CRED_COUNT" = "1" ]; then
  SHREDDED+=("the stored credential")
elif [ "$CRED_COUNT" -gt 1 ]; then
  SHREDDED+=("$CRED_COUNT stored credentials")
fi
if [ "${#SHREDDED[@]}" -gt 0 ]; then
  log "shredded $(join_list "${SHREDDED[@]}")"
elif [ "${#REMOVED[@]}" -eq 0 ]; then
  # Reached only when config.json is the single thing present, which this half
  # deliberately leaves. Saying so beats printing nothing at all.
  log "nothing to stop, remove or shred: only ${CONFIG_FILE} is present, and that is deliberately left in place."
fi

# =============================================================================
# Summary
# =============================================================================
cat <<TAIL

[uninstall] left in place: your repositories, ${CONFIG_FILE}, the fleet SSH key,
            authorized_keys, known_hosts

  The root half is a second password moment, and it is the only way a root-owned
  service and a sudoers drop-in come out:

      sudo ${SCRIPT_DIR}/uninstall.sh --elevated

  It removes easytier-fleet.service, /etc/easytier, /opt/easytier,
  /etc/sudoers.d/sukarfleet-transport and the firewall rules this installer
  added. Nothing else.

  The other machines still list this one as a peer. Remove it from their Fleet
  screen, or they will keep calling a number that no longer answers.
TAIL
