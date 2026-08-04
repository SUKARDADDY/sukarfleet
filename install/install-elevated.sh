#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The one step that needs root.
#
# It does exactly two things, both narrow enough to read in full before you run them:
#
#   1. Grants the daemon's user permission to restart ONE service -- the mesh transport -- with no
#      password. Nothing else. No wildcard, no shell, no other binary.
#   2. Optionally enables that service.
#
# What it deliberately does NOT do: download anything, write anything into your home directory,
# create a user, touch your SSH configuration, or install a privileged helper. The daemon itself
# runs unprivileged and never needs root to sync; this grant exists only so the transport watchdog
# can restart a wedged mesh without waking a human.
#
# The admin lane does NOT use this grant. That lane authenticates with a stored password of your
# own and is off by default -- see SECURITY.md.
#
# Everything here is machine-agnostic: identity comes from the invoking user and the arguments.
# Re-running is safe and is the intended upgrade path.
set -euo pipefail

SUDOERS_FILE="/etc/sudoers.d/sukarfleet-transport"
DEFAULT_SERVICE="easytier-fleet.service"

SERVICE="$DEFAULT_SERVICE"
TARGET_USER="${SUDO_USER:-}"
DO_ENABLE=0
DO_REMOVE=0

log()     { printf '[install-elevated] %s\n' "$*"; }
log_err() { printf '[install-elevated] ERROR: %s\n' "$*" >&2; }

usage() {
  cat <<EOF
usage: sudo ./install/install-elevated.sh [options]

  --service=NAME  Mesh transport service to grant a restart for.
                  Default: ${DEFAULT_SERVICE}
  --user=NAME     User the daemon runs as. Default: the user invoking sudo.
  --enable        Also 'systemctl enable --now' the transport service.
  --remove        Remove the sudoers grant and exit.
  -h, --help      This text.

Installs ${SUDOERS_FILE} granting exactly:
  <user> ALL=(root) NOPASSWD: <systemctl> restart <service>
EOF
}

for arg in "$@"; do
  case "$arg" in
    --service=*) SERVICE="${arg#*=}" ;;
    --user=*)    TARGET_USER="${arg#*=}" ;;
    --enable)    DO_ENABLE=1 ;;
    --remove)    DO_REMOVE=1 ;;
    -h|--help)   usage; exit 0 ;;
    *) log_err "unknown argument: $arg"; usage; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  log_err "must be run as root (sudo $(basename -- "$0"))."
  exit 1
fi

for c in systemctl visudo install; do
  command -v "$c" >/dev/null 2>&1 || { log_err "required command not found: $c"; exit 1; }
done

if [ "$DO_REMOVE" -eq 1 ]; then
  if [ -f "$SUDOERS_FILE" ]; then
    rm -f "$SUDOERS_FILE"
    log "removed $SUDOERS_FILE"
  else
    log "$SUDOERS_FILE is not present; nothing to remove"
  fi
  exit 0
fi

if [ -z "$TARGET_USER" ]; then
  log_err "could not determine the daemon user. Pass --user=NAME."
  exit 1
fi
if ! id -u "$TARGET_USER" >/dev/null 2>&1; then
  log_err "user does not exist: $TARGET_USER"
  exit 1
fi

# Both values are interpolated into a sudoers command spec, so each is constrained to a charset that
# cannot introduce a second command, an extra argument, or a comment.
case "$SERVICE" in
  *[!A-Za-z0-9._@-]*) log_err "refusing a service name with unexpected characters: $SERVICE"; exit 1 ;;
esac
case "$TARGET_USER" in
  *[!A-Za-z0-9._-]*) log_err "refusing a user name with unexpected characters: $TARGET_USER"; exit 1 ;;
esac

SYSTEMCTL_PATH="$(command -v systemctl)"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<EOF
# sukarfleet mesh-transport restart grant.
#
# Installed by install/install-elevated.sh. Grants exactly one command, by absolute path, with a
# fixed argument list: restarting the mesh transport service. The daemon's transport watchdog uses
# it to recover a wedged mesh without waking a human.
#
# This is the ONLY passwordless grant this project installs.
${TARGET_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} restart ${SERVICE}
EOF

# Validated before it is ever put in place: a malformed drop-in can lock every user out of sudo.
if ! visudo -cf "$TMP" >/dev/null; then
  log_err "generated sudoers rule failed validation; nothing was installed"
  exit 1
fi

install -m 0440 -o root -g root "$TMP" "$SUDOERS_FILE"
log "installed $SUDOERS_FILE"
log "  ${TARGET_USER} may now run: ${SYSTEMCTL_PATH} restart ${SERVICE}"

if [ "$DO_ENABLE" -eq 1 ]; then
  if systemctl list-unit-files "$SERVICE" >/dev/null 2>&1; then
    systemctl enable --now "$SERVICE"
    log "enabled and started $SERVICE"
  else
    log_err "$SERVICE is not a known unit -- install your mesh transport first, then re-run with --enable"
    exit 1
  fi
fi

log ""
log "Done. Nothing else on this machine needs root."
log "Next: run ./install/quickstart.sh as ${TARGET_USER} (no sudo) and pair from the GUI."
