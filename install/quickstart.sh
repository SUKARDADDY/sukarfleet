#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# sukarfleet quickstart: everything a machine needs that does NOT require root.
#
# Stage 1 of two. get.sh cloned this checkout at a release tag and handed over;
# this stage installs the daemon, starts it, opens the console, and prints the
# ONE command in the whole install that asks for a password. It never calls sudo
# and never writes anything under /etc.
#
# Idempotent by construction -- safe to re-run on every update, and that is the
# intended upgrade path. A second run on an installed machine writes nothing it
# did not already own and says so.
#
# Deliberately machine-agnostic: identity comes from `hostname` and `$USER`, and
# anything it cannot know (mesh address, role, repos, peers) is left at a safe
# default for the setup console to fill in. Nothing here is allowed to hardcode a
# machine name: a fleet you cannot add a third machine to is not a fleet.
#
# Exit codes (docs/INSTALL-FLOW.md section 6):
#   0  installed, or installed with something warned about and continued past
#   2  a precondition is missing or unsupported (no git, no systemd, wrong distro)
#   3  something is present and wrong (the port is held by someone else)
#   5  a fetch this stage could not do without (Bun) failed
#
# Requires bash, not sh: arrays, [[ ]] and local are all used below. get.sh is
# the one file that has to survive /bin/sh.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

CONFIG_DIR="$HOME/.config/sukarfleet"
CONFIG_FILE="$CONFIG_DIR/config.json"
SECRETS_DIR="$CONFIG_DIR/secrets"
STATE_DIR="${SUKARFLEET_STATE:-$HOME/.local/state/sukarfleet}"
KNOWN_HOSTS="$STATE_DIR/known_hosts"
PENDING_SECRET="$STATE_DIR/pending-easytier-secret"
SSH_DIR="$HOME/.ssh"
SSH_KEY="$SSH_DIR/id_sukarfleet_ed25519"
AUTHORIZED_KEYS="$SSH_DIR/authorized_keys"
USER_UNIT_DIR="$HOME/.config/systemd/user"
UNIT_SRC="$REPO_ROOT/systemd/sukarfleet.service"
UNIT_DST="$USER_UNIT_DIR/sukarfleet.service"
ELEVATED="$REPO_ROOT/install/install-elevated.sh"
PINS_FILE="${SUKARFLEET_PINS_FILE:-$REPO_ROOT/install/easytier-pins.txt}"
BIN_DIR="$HOME/.local/bin"
TRAY_BIN="$BIN_DIR/sukarfleet-tray"
AUTOSTART_DIR="$HOME/.config/autostart"
AUTOSTART_FILE="$AUTOSTART_DIR/sukarfleet-tray.desktop"

# Pinned so a fresh machine gets the Bun this tree's bun.lock was resolved
# against, not whatever bun.sh is shipping today. Section 8 of the spec is honest
# that the install script itself is not checksum-verified; pinning the version is
# what is on offer until it is.
BUN_VERSION="${SUKARFLEET_BUN_VERSION:-1.3.14}"

# Test seam, inherited from get.sh. Where the tray binary is fetched from.
RELEASE_BASE="${SUKARFLEET_RELEASE_BASE:-}"
# Test seam: 1 turns every write, download, systemctl, sudo and rm into a printed
# line and changes nothing on disk. The control flow is walked in full either way.
DRY_RUN="${SUKARFLEET_DRY_RUN:-0}"

DO_RESTART=0
DO_OPEN=1
OPT_MACHINE=""
OPT_ROLE=""
OPT_MESH_IP=""
OPT_NODE_PORT=""

START_TS="$(date +%s)"
elapsed() { echo "$(( $(date +%s) - START_TS ))"; }

log()  { printf '[quickstart] %-6s %s\n' "t+$(elapsed)s" "$*"; }
warn() { printf '[quickstart] WARNING: %s\n' "$*" >&2; }
note() { printf '[quickstart] %s\n' "$*"; }
dry()  { printf '[quickstart] [dry-run] %s\n' "$*"; }
# 2 = missing/unsupported precondition, 3 = present and wrong, 5 = failed fetch.
die()  { printf '[quickstart] ERROR: %s\n' "$1" >&2; exit "${2:-2}"; }

# Every state-changing command goes through act(), so a dry run walks the same
# branches and touches nothing.
act() {
  if [ "$DRY_RUN" = "1" ]; then dry "$*"; return 0; fi
  "$@"
}

# put_file <mode> <path>, content on stdin. One place that knows how to not write
# a file, and one place that knows a config file is 0600 the moment it exists.
#
# Temp file, then chmod, then content, then rename. Writing first and chmod'ing
# after leaves the file readable by every process on the machine for as long as
# the write takes, and config.json is where the mesh identity lives; the rename
# also means a daemon reading the file concurrently sees the old one or the new
# one, never half of one.
put_file() {
  local mode="$1" path="$2" content tmp
  content="$(cat)"
  if [ "$DRY_RUN" = "1" ]; then
    dry "write $path (mode $mode, $(printf '%s' "$content" | wc -c) bytes)"
    return 0
  fi
  tmp="$(mktemp "$path.XXXXXX")" || die "could not create a temporary file beside $path" 3
  chmod "$mode" "$tmp"
  printf '%s\n' "$content" > "$tmp"
  mv -f "$tmp" "$path"
}

# Shapes for anything that reaches config.json or a command line. The name
# charset is the daemon's own MACHINE_NAME_RE (src/uiserve.ts): a machine name
# carrying a quote is a config.json this scaffold would write broken, and the
# daemon would then refuse to start on a file the installer wrote.
valid_name() {
  [ -n "$1" ] || return 1
  [ "${#1}" -le 64 ] || return 1
  case "$1" in *[!A-Za-z0-9._-]*) return 1 ;; esac
}
valid_ipv4() {
  local o
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do [ "$o" -le 255 ] || return 1; done
}

# Every systemctl call, read or write, so a dry run cannot touch a live daemon.
# A dry run answers "not active" to is-active, which is the branch that prints
# the root step -- the longer of the two and the one worth walking.
sctl() {
  if [ "$DRY_RUN" = "1" ]; then dry "systemctl $*"; return 1; fi
  # stdout only: systemctl's chatter is noise, its stderr is the reason a step
  # failed. Redirecting here rather than at the call sites is what keeps a dry
  # run's printed line from being swallowed by the same redirect.
  systemctl "$@" >/dev/null
}

usage() {
  cat <<EOF
Usage: install/quickstart.sh [--restart] [--no-open] [--no-tray]
                             [--machine=NAME] [--role=anchor|roamer] [--mesh-ip=A.B.C.D]
                             [--node-port=N]

  --restart      Upgrade path: daemon-reload + restart the running service.
  --no-open      Do not open the console at the end (prints the URL either way).
  --no-tray      Skip the native tray console; use the browser console instead.
  --machine=     Override the machine name (default: \`hostname\`).
  --role=        anchor (always-on) or roamer. Default: anchor for the first
                 machine in a fleet; change it later in the console.
  --mesh-ip=     This machine's mesh TUN address (e.g. 192.0.2.3).
  --node-port=   Port the daemon listens on. Default: 7710, or whatever an
                 existing config.json already says.

  The identity flags only apply when scaffolding a NEW config.json. An existing
  config keeps its identity, its peers and every lane switch; the only thing this
  script writes into one is the admin lane's non-privileged fields when they are
  missing. Everything else is edited from the console.

Environment (test seams, see docs/INSTALL-FLOW.md):
  SUKARFLEET_DRY_RUN=1            print every change instead of making it
  SUKARFLEET_SKIP_DISTRO_CHECK=1  the non-apt escape hatch (section 9)
  SUKARFLEET_RELEASE_BASE=URL     where the tray binary is fetched from
  SUKARFLEET_STATE=DIR            state directory (also read by the daemon)
  SUKARFLEET_PINS_FILE=PATH       the pin file to read (tests use a copy)
EOF
}

DO_TRAY=1
for arg in "$@"; do
  case "$arg" in
    --restart) DO_RESTART=1 ;;
    --no-open) DO_OPEN=0 ;;
    --no-tray) DO_TRAY=0 ;;
    --machine=*) OPT_MACHINE="${arg#*=}" ;;
    --role=*) OPT_ROLE="${arg#*=}" ;;
    --mesh-ip=*) OPT_MESH_IP="${arg#*=}" ;;
    --node-port=*) OPT_NODE_PORT="${arg#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $arg" ;;
  esac
done

case "${OPT_ROLE:-anchor}" in
  anchor|roamer) ;;
  *) die "--role must be 'anchor' or 'roamer', got '$OPT_ROLE'" ;;
esac
# Both of these are interpolated into the scaffolded config.json below, so they
# are checked here rather than trusted there.
if [ -n "$OPT_MACHINE" ] && ! valid_name "$OPT_MACHINE"; then
  die "--machine must be 1-64 characters of letters, digits, dot, dash or underscore, got '$OPT_MACHINE'"
fi
if [ -n "$OPT_MESH_IP" ] && ! valid_ipv4 "$OPT_MESH_IP"; then
  die "--mesh-ip must be an IPv4 address like 192.0.2.3, got '$OPT_MESH_IP'"
fi
if [ -n "$OPT_NODE_PORT" ]; then
  case "$OPT_NODE_PORT" in
    ''|*[!0-9]*) die "--node-port must be a number, got '$OPT_NODE_PORT'" ;;
  esac
  if [ "$OPT_NODE_PORT" -lt 1 ] || [ "$OPT_NODE_PORT" -gt 65535 ]; then
    die "--node-port must be between 1 and 65535, got '$OPT_NODE_PORT'"
  fi
fi

# =============================================================================
# 1. Preflight. Everything checked BEFORE anything is written, so a refusal here
#    leaves a machine exactly as it was found.
# =============================================================================

# --- distro ------------------------------------------------------------------
# The daemon has no distro dependency; this installer's dependency handling does.
# Refusing by name beats an untested best-effort path -- section 9 is the manual
# route, and the escape hatch below is how someone takes it.
DISTRO_ID="unknown"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  DISTRO_ID="$( . /etc/os-release 2>/dev/null; printf '%s' "${ID:-unknown}" )"
  # shellcheck disable=SC1091
  DISTRO_LIKE="$( . /etc/os-release 2>/dev/null; printf '%s' "${ID_LIKE:-}" )"
else
  DISTRO_LIKE=""
fi
APT_FAMILY=0
case " $DISTRO_ID $DISTRO_LIKE " in
  *" debian "*|*" ubuntu "*) APT_FAMILY=1 ;;
esac
if [ "${SUKARFLEET_SKIP_DISTRO_CHECK:-0}" = "1" ]; then
  warn "SUKARFLEET_SKIP_DISTRO_CHECK=1 -- the distro check is off. Nothing below is apt-specific, but nothing below has been tested on ID=$DISTRO_ID either."
elif [ "$APT_FAMILY" != "1" ]; then
  die "this installer supports Debian and Ubuntu family distros only. Found ID=$DISTRO_ID. The manual steps are in docs/INSTALL-FLOW.md section 9; the daemon itself has no distro dependency." 2
fi

# --- tools -------------------------------------------------------------------
for c in curl git; do
  command -v "$c" >/dev/null 2>&1 || \
    die "$c is not installed. Run: sudo apt-get install -y git curl" 2
done
command -v systemctl >/dev/null 2>&1 || \
  die "no systemd user session. This daemon runs as a systemd user unit. On a container or a chroot, start one with: loginctl enable-linger ${USER:-\$USER}" 2
# `is-system-running` answering AT ALL is the question, not what it answers:
# 'degraded' and 'running' are both a live session, and a machine with no user
# manager errors out instead.
if [ "$DRY_RUN" = "1" ]; then
  dry "systemctl --user is-system-running"
elif ! systemctl --user is-system-running >/dev/null 2>&1; then
  case "$(systemctl --user is-system-running 2>/dev/null || true)" in
    running|degraded|starting|maintenance|stopping|initializing) ;;
    *) die "no systemd user session. This daemon runs as a systemd user unit. On a container or a chroot, start one with: loginctl enable-linger ${USER:-\$USER}" 2 ;;
  esac
fi

# --- the port ----------------------------------------------------------------
# Read from an existing config before anything is written, so a machine already
# installed on 7711 is preflighted on 7711.
config_node_port() {
  [ -f "$CONFIG_FILE" ] || return 1
  grep -o '"nodePort"[[:space:]]*:[[:space:]]*[0-9]\+' "$CONFIG_FILE" 2>/dev/null | head -n1 | grep -o '[0-9]\+$'
}
NODE_PORT="${OPT_NODE_PORT:-$(config_node_port || true)}"
NODE_PORT="${NODE_PORT:-7710}"
UI_URL="http://127.0.0.1:${NODE_PORT}/ui/"

# The daemon runs TWO listeners on this port: one bound to the mesh IP for peers
# and one bound to 127.0.0.1 for the CLI and the console. So "is anything
# listening" is not the question -- "is what is listening ours" is, and only
# /health can answer it.
port_has_listener() {
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -Hltn "sport = :$NODE_PORT" 2>/dev/null)" ]
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$NODE_PORT" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 2
  fi
}
health_answers() {
  if [ "$DRY_RUN" = "1" ]; then dry "GET http://127.0.0.1:${NODE_PORT}/health"; return 1; fi
  curl -fsS --max-time 2 "http://127.0.0.1:${NODE_PORT}/health" 2>/dev/null | grep -q '"ok":true'
}

RERUN=0
set +e
port_has_listener
PORT_STATE=$?
set -e
case "$PORT_STATE" in
  0)
    if health_answers; then
      RERUN=1
      note "sukarfleet is already running on 127.0.0.1:${NODE_PORT}. Treating this as a re-run."
    else
      die "port ${NODE_PORT} is already in use by another process. Free it, or install with --node-port=$(( NODE_PORT + 1 ))." 3
    fi
    ;;
  2) warn "neither ss nor lsof is installed, so port ${NODE_PORT} was not checked. If something else holds it, the daemon will fail to start and journalctl will say so." ;;
  *) : ;;
esac

# --- console runtime (a probe, not a precondition) ---------------------------
DESKTOP=0
[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && DESKTOP=1
ARCH="$(uname -m)"
TRAY_REASON=""
if [ "$DO_TRAY" != "1" ]; then
  TRAY_REASON="--no-tray was passed"
elif [ "$DESKTOP" != "1" ]; then
  TRAY_REASON="headless (no DISPLAY and no WAYLAND_DISPLAY)"
elif [ "$ARCH" != "x86_64" ]; then
  TRAY_REASON="no tray build for $ARCH yet"
elif ! command -v ldconfig >/dev/null 2>&1; then
  TRAY_REASON="ldconfig is not installed, so the tray's two shared libraries could not be probed"
else
  MISSING_LIBS=()
  for lib in libwebkit2gtk-4.1.so.0 libayatana-appindicator3.so.1; do
    ldconfig -p 2>/dev/null | grep -q "$lib" || MISSING_LIBS+=("$lib")
  done
  if [ "${#MISSING_LIBS[@]}" -gt 0 ]; then
    # Wording matched to the failure table in docs/INSTALL-FLOW.md section 6:
    # "A and B, neither of which ldconfig can find" when both are missing, and
    # the singular when only one is. "${MISSING_LIBS[*]}" reads as one library
    # with a space in its name.
    MISSING_JOINED="$(printf '%s and ' "${MISSING_LIBS[@]}")"
    MISSING_JOINED="${MISSING_JOINED% and }"
    if [ "${#MISSING_LIBS[@]}" -gt 1 ]; then
      TRAY_REASON="the console window needs ${MISSING_JOINED}, neither of which ldconfig can find"
    else
      TRAY_REASON="the console window needs ${MISSING_JOINED}, which ldconfig cannot find"
    fi
  fi
fi

PREFLIGHT_SUMMARY="preflight: ${DISTRO_ID} ($( [ "$APT_FAMILY" = 1 ] && echo 'apt family' || echo 'distro check skipped' )), systemd user session live, port ${NODE_PORT} $( [ "$RERUN" = 1 ] && echo 'held by this machine'"'"'s daemon' || echo free )"
log "$PREFLIGHT_SUMMARY"

# =============================================================================
# 2. Bun. A one-command install cannot end at "install Bun yourself".
# =============================================================================
resolve_bun() {
  if [ -x "$HOME/.bun/bin/bun" ]; then printf '%s' "$HOME/.bun/bin/bun"; return 0; fi
  command -v bun 2>/dev/null || return 1
}
BUN_BIN="$(resolve_bun || true)"
if [ -z "$BUN_BIN" ]; then
  log "installing bun ${BUN_VERSION} (not found on PATH or at ~/.bun/bin/bun)"
  if [ "$DRY_RUN" = "1" ]; then
    dry "curl -fsSL https://bun.sh/install | bash -s bun-v${BUN_VERSION}"
    BUN_BIN="$HOME/.bun/bin/bun"
  else
    # Pinned by version. The fetched script itself is not checksum-verified -- see
    # docs/INSTALL-FLOW.md section 8, which names that rather than papering over it.
    curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" >/dev/null 2>&1 || \
      die "could not install Bun from bun.sh. Install it by hand (https://bun.sh), then re-run. Nothing else was written." 5
    BUN_BIN="$(resolve_bun || true)"
    [ -n "$BUN_BIN" ] || die "Bun still not on PATH after installing it. Install it by hand (https://bun.sh), then re-run." 5
  fi
fi
if [ "$DRY_RUN" = "1" ] && [ ! -x "$BUN_BIN" ]; then
  log "bun (dry run) at $BUN_BIN"
else
  log "bun $("$BUN_BIN" --version) at $BUN_BIN"
fi

# bun.lock is committed, so --frozen-lockfile turns lockfile drift into a refusal
# rather than a silent resolve. --production is deliberately NOT passed: it would
# install nothing, and those two packages are what make `bun run typecheck` work.
if [ "$DRY_RUN" = "1" ]; then
  dry "cd $REPO_ROOT && bun install --frozen-lockfile"
else
  ( cd "$REPO_ROOT" && "$BUN_BIN" install --frozen-lockfile >/dev/null 2>&1 ) || \
    die "bun install --frozen-lockfile failed in $REPO_ROOT. If you are on a modified checkout, run it by hand to see why." 5
  log "bun install --frozen-lockfile"
fi

# =============================================================================
# 3. Private directories
# =============================================================================
# 0700 must actually stick. On a mode-blind mount (fuseblk, exFAT, NTFS) chmod is
# inert and every mode reads back 0777, which would silently make the credential
# store world-readable; secrets.ts refuses to operate there, so catch it at
# install time rather than at the first credential save.
ensure_private_dir() {
  local dir="$1" label="$2" mode
  if [ "$DRY_RUN" = "1" ]; then dry "mkdir -p $dir && chmod 700 $dir"; return 0; fi
  mkdir -p "$dir"
  chmod 700 "$dir"
  mode="$(stat -c '%a' "$dir" 2>/dev/null || echo '?')"
  if [ "$mode" != "700" ]; then
    warn "$label ($dir) reads back mode $mode after chmod 700 -- this is not a real POSIX filesystem (fuseblk?). The credential store will refuse to operate there. Move \$HOME or SUKARFLEET_STATE onto ext4."
  fi
}

ensure_private_dir "$CONFIG_DIR" "config dir"
ensure_private_dir "$SECRETS_DIR" "credential store"
ensure_private_dir "$STATE_DIR" "state dir"
act mkdir -p "$SSH_DIR"
act chmod 700 "$SSH_DIR"
act mkdir -p "$BIN_DIR"

# =============================================================================
# 4. config.json (never overwritten; the admin lane's plumbing is backfilled)
# =============================================================================
# An existing config owns the machine name; the banner has to agree with what the
# daemon will actually gossip as, not with whatever `hostname` says today.
CONFIG_MACHINE=""
if [ -f "$CONFIG_FILE" ]; then
  CONFIG_MACHINE="$(grep -o '"machine"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" 2>/dev/null | head -n1 | sed 's/.*"machine"[[:space:]]*:[[:space:]]*"//; s/"$//' || true)"
fi
MACHINE="${OPT_MACHINE:-${CONFIG_MACHINE:-$(hostname)}}"
[ -n "$MACHINE" ] || die "hostname is empty and --machine= was not given"
# Not only the flag: this value can also come from `hostname` or from an existing
# config.json, and it is written into config.json, into the SSH key comment and
# into the banner from all three.
valid_name "$MACHINE" || \
  die "this machine's name is '$MACHINE', which is not 1-64 characters of letters, digits, dot, dash or underscore. Pass --machine=NAME to choose one." 3
SSH_USER="${USER:-$(id -un)}"
valid_name "$SSH_USER" || die "the user name '$SSH_USER' is not a shape this installer can write into config.json." 3

ADMIN_ENABLED=false

# Backfill for a machine installed before the admin lane existed: its config has
# no `admin` block at all, so mergeDefaults() hands the daemon sshUser:'' and the
# origin leg refuses every run -- including a self-targeted one -- with nothing on
# any screen saying why. Only the non-privileged fields are written: `enabled`
# and `acceptIncoming` are left exactly as found, because switching a root-capable
# lane on during an upgrade is the operator's call and false is the correct
# fail-closed default. Written through a temp file + rename so a daemon reading
# the config concurrently never sees a half-written one.
backfill_admin_fields() {
  # The single-quoted body is a JS program handed to bun; nothing in it may be
  # expanded by this shell, which is the point of the quoting.
  # shellcheck disable=SC2016
  SUKARFLEET_CONFIG_FILE="$CONFIG_FILE" SUKARFLEET_SSH_USER="$SSH_USER" "$BUN_BIN" -e '
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

CONFIG_EXISTED=0
if [ -f "$CONFIG_FILE" ]; then
  CONFIG_EXISTED=1
  ADMIN_CHANGED="-"
  if [ "$DRY_RUN" = "1" ]; then
    dry "backfill admin.sshUser / admin.uiEnabled in $CONFIG_FILE if missing"
  else
    BACKFILL="$(backfill_admin_fields)" || die "could not read $CONFIG_FILE as JSON -- fix it by hand, then re-run." 3
    ADMIN_ENABLED="${BACKFILL%% *}"
    ADMIN_CHANGED="${BACKFILL#* }"
  fi
  if [ "$ADMIN_CHANGED" != "-" ]; then
    log "config exists at $CONFIG_FILE -- backfilled admin.${ADMIN_CHANGED//,/, admin.} (lane switches untouched)."
  elif [ ! -f "$UNIT_DST" ]; then
    # A half-installed machine: somebody ctrl-C'd, or the unit was removed by
    # hand. Naming what is missing beats a line that reads like a fresh install.
    log "resuming: config present, unit missing. Writing the unit and starting the daemon."
  else
    log "config exists at $CONFIG_FILE -- left untouched."
  fi
else
  ROLE="${OPT_ROLE:-anchor}"
  MESH_IP="${OPT_MESH_IP:-}"
  log "scaffolding $CONFIG_FILE (machine=$MACHINE role=$ROLE meshIp=${MESH_IP:-<unset>})"
  # peers[] is empty on purpose: peers arrive through console pairing, which
  # exchanges the mesh public key, the SSH public key and the SSH host keys in
  # both directions. There is no JWK left to hand-paste.
  # repos[] is empty on purpose too: repo paths are machine-local and a wrong
  # path here syncs the wrong tree. Add them in config.json once the machine is
  # paired; every other key not written here comes from defaultConfig().
  #
  # The admin lane ships OFF, matching defaultConfig() in src/config.ts and
  # SECURITY.md. A root-capable lane that is on before anybody asked for it is
  # not a convenience. Turning it on is one switch on the Credentials screen.
  put_file 600 "$CONFIG_FILE" <<EOF
{
  "machine": "$MACHINE",
  "role": "$ROLE",
  "meshIp": "$MESH_IP",
  "nodePort": $NODE_PORT,
  "networkName": "sukarfleet",
  "peers": [],
  "repos": [],
  "unionPaths": ["workspace-manifest.json", "workspace-removals.json"],
  "admin": {
    "enabled": false,
    "acceptIncoming": true,
    "sshUser": "$SSH_USER",
    "uiEnabled": true
  }
}
EOF
  ADMIN_ENABLED=false
  log "wrote $CONFIG_FILE (admin lane OFF, peers[] empty -- pair from the console)"
fi

# =============================================================================
# 5. fleet SSH identity
# =============================================================================
# One dedicated key per machine, never copied anywhere: pairing publishes only
# the public half, and the peer builds the restricted authorized_keys line
# locally. A personal id_ed25519 is deliberately not reused.
if [ -f "$SSH_KEY" ]; then
  log "fleet ssh key present: $SSH_KEY"
else
  command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen not found -- install openssh-client, then re-run." 2
  act ssh-keygen -q -t ed25519 -N '' -C "sukarfleet:$MACHINE" -f "$SSH_KEY"
  log "generated $SSH_KEY"
fi
if [ "$DRY_RUN" != "1" ]; then
  [ -f "$SSH_KEY" ] && chmod 600 "$SSH_KEY"
  [ -f "$SSH_KEY.pub" ] && chmod 644 "$SSH_KEY.pub"
fi

# authorized_keys and known_hosts must exist with the right mode before the
# daemon rewrites a marked line into either of them; sshd ignores an
# authorized_keys file that is group- or world-writable.
ensure_empty_0600() {
  local f="$1"
  if [ "$DRY_RUN" = "1" ]; then dry "touch $f && chmod 600 $f"; return 0; fi
  [ -f "$f" ] || : > "$f"
  chmod 600 "$f"
}
ensure_empty_0600 "$AUTHORIZED_KEYS"
ensure_empty_0600 "$KNOWN_HOSTS"

if command -v sshd >/dev/null 2>&1 || [ -f /etc/ssh/sshd_config ]; then
  :
else
  warn "no sshd found on this machine -- it can originate admin calls but cannot be the target of one until an SSH server is installed."
fi

# =============================================================================
# 6. Credential sealing probe (informational)
# =============================================================================
# Not a gate: the credential store degrades to 'no credential' rather than
# failing the install, and the console reports the same thing in plain words.
#
# The probe is a real encrypt->decrypt round trip, not `systemd-analyze has-tpm2`.
# A present TPM says nothing about whether THIS uid can seal with it: system-scope
# sealing needs /var/lib/systemd/credential.secret (0400 root), so on both current
# fleet machines it is refused for an unprivileged user while `--user` scope round
# trips fine. Asking the question the code actually asks is the only way this line
# stays true.
if command -v systemd-creds >/dev/null 2>&1; then
  if [ "$DRY_RUN" = "1" ]; then
    dry "systemd-creds encrypt|decrypt --user round trip"
  elif printf 'probe' | timeout 5 systemd-creds encrypt --user --name=sukarfleet-install-probe - - 2>/dev/null | \
       timeout 5 systemd-creds decrypt --user --name=sukarfleet-install-probe - - 2>/dev/null | grep -q '^probe$'; then
    log "credential sealing works (user scope); a stored sudo password is sealed at rest"
    note "  it is bound to this user on this host: a copy that leaks via a synced repo or backup is"
    note "  inert elsewhere. It does NOT defend against another process running as you, or a stolen"
    note "  unencrypted disk. See SECURITY.md."
  else
    warn "credential sealing does not work for this user -- the Credentials screen will refuse to store a sudo password (fail-closed). The admin lane stays read-only on this machine."
  fi
else
  warn "systemd-creds not found -- credential sealing unavailable on this machine."
fi

# =============================================================================
# 7. systemd user unit
# =============================================================================
act mkdir -p "$USER_UNIT_DIR"
[ -f "$UNIT_SRC" ] || die "missing $UNIT_SRC" 2
# Two substitutions, not one. __SUKARFLEET_BUN__ is the second and it is why this
# is templated rather than copied: a machine with bun at /usr/local/bin/bun passes
# preflight and would otherwise get a unit whose ExecStart names a path that does
# not exist on it.
UNIT_BODY="$(sed -e "s|__SUKARFLEET_REPO__|$REPO_ROOT|g" -e "s|__SUKARFLEET_BUN__|$BUN_BIN|g" "$UNIT_SRC")"
printf '%s\n' "$UNIT_BODY" | put_file 644 "$UNIT_DST"
log "installed $UNIT_DST (bun=$BUN_BIN)"

# WatchdogSec coupling: the node derives its ping cadence and loop-freshness
# windows from cfg.intervals.watchdogSec, but the unit hardcodes WatchdogSec=120
# and has no placeholder to template from config. Flag the drift instead of
# installing a unit that hard-kills the node inside its own freshness window.
CFG_WATCHDOG_SEC="$(grep -o '"watchdogSec"[[:space:]]*:[[:space:]]*[0-9]\+' "$CONFIG_FILE" 2>/dev/null | grep -o '[0-9]\+$' || true)"
CFG_WATCHDOG_SEC="${CFG_WATCHDOG_SEC:-120}"
UNIT_WATCHDOG_SEC="$(printf '%s\n' "$UNIT_BODY" | grep -o '^WatchdogSec=[0-9]\+' | grep -o '[0-9]\+$' || true)"
if [ -n "$UNIT_WATCHDOG_SEC" ] && [ "$UNIT_WATCHDOG_SEC" != "$CFG_WATCHDOG_SEC" ]; then
  warn "WatchdogSec=$UNIT_WATCHDOG_SEC in $UNIT_DST does not match intervals.watchdogSec=$CFG_WATCHDOG_SEC in $CONFIG_FILE. Edit WatchdogSec= to match, then: systemctl --user daemon-reload"
fi

# =============================================================================
# 8. desktop notification channel
# =============================================================================
# src/notify.ts prefers org.freedesktop.Notifications and falls back to
# org.gtk.Notifications; the GTK protocol only delivers for a registered .desktop
# app id, so install a hidden entry for the daemon.
APPS_DIR="$HOME/.local/share/applications"
DESKTOP_DST="$APPS_DIR/org.sukarfleet.node.desktop"
act mkdir -p "$APPS_DIR"
if [ ! -f "$DESKTOP_DST" ]; then
  put_file 644 "$DESKTOP_DST" <<'DESKTOP'
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
# service override at it. uninstall.sh removes it, and only if it wrote it.
SYS_NOTIF_SVC="/usr/share/dbus-1/services/org.gnome.Shell.Notifications.service"
USER_DBUS_DIR="$HOME/.local/share/dbus-1/services"
USER_NOTIF_SVC="$USER_DBUS_DIR/org.gnome.Shell.Notifications.service"
if [ -f "$SYS_NOTIF_SVC" ] && [ ! -x /usr/bin/gjs ] && [ -x "$HOME/.local/bin/gjs" ] && [ ! -f "$USER_NOTIF_SVC" ]; then
  act mkdir -p "$USER_DBUS_DIR"
  sed "s|^Exec=/usr/bin/gjs|Exec=$HOME/.local/bin/gjs|" "$SYS_NOTIF_SVC" | put_file 644 "$USER_NOTIF_SVC"
  log "installed user D-Bus override for GNOME notifications: $USER_NOTIF_SVC"
fi

# =============================================================================
# 9. CLI wrapper
# =============================================================================
CLI_WRAPPER="$BIN_DIR/sukarfleet"
put_file 755 "$CLI_WRAPPER" <<EOF
#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Written by install/quickstart.sh. Removed by install/uninstall.sh.
exec "$BUN_BIN" run "$REPO_ROOT/src/cli.ts" "\$@"
EOF
log "installed $CLI_WRAPPER"

# =============================================================================
# 10. enable + start
# =============================================================================
# Without linger the node dies at logout, which is exactly when an always-on
# anchor is needed most. A probe, not a precondition.
if command -v loginctl >/dev/null 2>&1; then
  if [ "$DRY_RUN" = "1" ]; then
    dry "loginctl enable-linger ${USER:-\$USER}"
  else
    loginctl enable-linger "${USER:-$(id -un)}" >/dev/null 2>&1 || \
      warn "could not enable linger for ${USER:-$(id -un)} -- the node will stop when you log out. Fix with: sudo loginctl enable-linger ${USER:-$(id -un)}"
  fi
fi

sctl --user daemon-reload || true
sctl --user enable sukarfleet.service 2>/dev/null || \
  { [ "$DRY_RUN" = "1" ] || warn "systemctl --user enable failed -- starting anyway; the node will not come back after a reboot."; }
# Restart discipline is not this script's to invent. docs/CUTOVER.md requires a
# graceful stop and a `git fsck` on every synced repo, because restarting mid-sync
# is what corrupted repositories on this fleet before. So an upgrade run that
# finds a live daemon WITH repos configured refuses to bounce it and asks for
# --restart; a daemon with no repos has nothing to corrupt.
# Asked of the JSON, not of a line: `"repos": [` and its first entry are on
# different lines in anything json-formatted, and a grep that misses them would
# silently restart a syncing daemon.
REPOS_CONFIGURED=0
if [ "$DRY_RUN" != "1" ] && [ -x "$BUN_BIN" ]; then
  # shellcheck disable=SC2016
  if SUKARFLEET_CONFIG_FILE="$CONFIG_FILE" "$BUN_BIN" -e '
      const fs = require("node:fs");
      try {
        const cfg = JSON.parse(fs.readFileSync(process.env.SUKARFLEET_CONFIG_FILE, "utf8"));
        process.exit(Array.isArray(cfg.repos) && cfg.repos.length > 0 ? 0 : 1);
      } catch { process.exit(1); }
    ' 2>/dev/null; then
    REPOS_CONFIGURED=1
  fi
fi
DAEMON_LIVE=0
if sctl --user is-active --quiet sukarfleet.service; then DAEMON_LIVE=1; fi

if [ "$DO_RESTART" = "1" ]; then
  sctl --user restart sukarfleet.service || true
  log "restarted sukarfleet.service"
elif [ "$DAEMON_LIVE" = "1" ] && [ "$REPOS_CONFIGURED" = "1" ]; then
  log "sukarfleet.service is already running and this machine has repos configured -- not restarting it."
  note "  Restarting mid-sync is how repositories get corrupted (docs/CUTOVER.md). The unit on disk"
  note "  is up to date; when you are ready, re-run with --restart, or:"
  note "      systemctl --user restart sukarfleet.service"
elif [ "$DAEMON_LIVE" = "1" ]; then
  sctl --user restart sukarfleet.service || true
  log "restarted sukarfleet.service"
else
  sctl --user start sukarfleet.service || true
  log "started sukarfleet.service"
fi

# =============================================================================
# 11. wait for /health
# =============================================================================
HEALTH_OK=0
if [ "$DRY_RUN" = "1" ]; then
  dry "poll http://127.0.0.1:${NODE_PORT}/health for 20s"
  HEALTH_OK=1
else
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${NODE_PORT}/health" >/dev/null 2>&1; then
      HEALTH_OK=1
      break
    fi
    sleep 0.5
  done
fi
if [ "$HEALTH_OK" = "1" ]; then
  log "daemon healthy on 127.0.0.1:${NODE_PORT}"
else
  warn "daemon did not answer /health within 20s. Check: systemctl --user status sukarfleet.service ; journalctl --user -u sukarfleet.service -n 50"
fi

# =============================================================================
# 12. the native tray console
# =============================================================================
# Decision 6: a desktop gets the tray by default, headless gets the printed URL.
# The tray is a prebuilt, SHA256-pinned, user-local binary and never a .deb,
# because a .deb needs root and this install has exactly one root moment.
#
# Nothing here can fail the install. Every failure below warns, prints the web
# console URL and continues at exit 0 -- a machine with a daemon and a browser is
# installed; a machine with a half-written binary in ~/.local/bin is not.

# Reads one pin line: pin_lookup <asset-prefix> <arch> -> "sha256 asset".
# Exit 0 with the line, 1 for no pin, 2 for a pin file that contradicts itself.
# Two lines for the same (version, arch, asset-prefix) mean nobody knows which
# SHA256 this machine should trust, and taking the first is how a stale pin
# outlives the line meant to replace it. A TODO-S9 line never shadows a real
# one either: the first VALID pin wins, whatever order they sit in.
pin_lookup() {
  local prefix="$1" arch="$2"
  [ -f "$PINS_FILE" ] || return 1
  awk -v p="$prefix" -v a="$arch" '
    /^[[:space:]]*#/ { next }
    NF < 4 { next }
    $2 != a { next }
    index($4, p) != 1 { next }
    {
      key = $1 SUBSEP $2
      if (key in seen) { dupver = $1; duparch = $2; exit }
      seen[key] = 1
      if ($3 != "TODO-S9") { if (!haveval) { haveval = 1; valline = $3 " " $4 } }
      else if (!havetodo) { havetodo = 1; todoline = $3 " " $4 }
    }
    END {
      if (dupver != "") { printf("duplicate pin for %s %s\n", dupver, duparch) > "/dev/stderr"; exit 2 }
      if (haveval) { print valline; exit 0 }
      if (havetodo) { print todoline; exit 0 }
      exit 1
    }
  ' "$PINS_FILE"
}

TRAY_INSTALLED=0
# A fetch or a checksum that failed is a different sentence from "this machine
# was never going to get a tray", and section 6 gives it its own row.
TRAY_FETCH_FAILED=0
TRAY_DETAIL=""
if [ -n "$TRAY_REASON" ]; then
  : # decided in preflight; reported in the banner
else
  set +e
  PIN_LINE="$(pin_lookup 'sukarfleet-tray-' "$ARCH" 2>/dev/null)"
  PIN_RC=$?
  set -e
  TRAY_SHA="${PIN_LINE%% *}"
  TRAY_ASSET="${PIN_LINE##* }"
  if [ "$PIN_RC" = "2" ]; then
    TRAY_REASON="install/easytier-pins.txt has more than one tray pin for $ARCH at the same version, so there is no single SHA256 to trust"
  elif [ -z "$PIN_LINE" ]; then
    TRAY_REASON="no tray pin for $ARCH in install/easytier-pins.txt"
  elif [ "$TRAY_SHA" = "TODO-S9" ]; then
    # The honest state before the first release: a pin nobody has computed is not
    # a pin, and an unverified download is worse than no download.
    TRAY_REASON="no tray binary has been released yet (its pin in install/easytier-pins.txt is still TODO-S9)"
  elif [ -z "$RELEASE_BASE" ]; then
    TRAY_REASON="no release base to fetch the tray from (set SUKARFLEET_RELEASE_BASE, or install via install/get.sh which sets it)"
  elif [ -x "$TRAY_BIN" ] && [ "$DRY_RUN" != "1" ] && \
       [ "$(sha256sum "$TRAY_BIN" 2>/dev/null | cut -d' ' -f1)" = "$TRAY_SHA" ]; then
    TRAY_INSTALLED=1
    log "tray already at $TRAY_BIN and on its pin -- left untouched"
  else
    TRAY_TMP=""
    if [ "$DRY_RUN" = "1" ]; then
      dry "curl -fsSL $RELEASE_BASE/$TRAY_ASSET -o <tmp>"
      dry "verify sha256 == $TRAY_SHA"
      dry "install -m 0755 <tmp> $TRAY_BIN"
      TRAY_INSTALLED=1
    else
      TRAY_TMP="$(mktemp -t sukarfleet-tray.XXXXXX)"
      if ! curl -fsSL --max-time 120 -o "$TRAY_TMP" "$RELEASE_BASE/$TRAY_ASSET" 2>/dev/null; then
        rm -f "$TRAY_TMP"
        TRAY_FETCH_FAILED=1
        TRAY_REASON="could not download $TRAY_ASSET from $RELEASE_BASE"
      else
        GOT="$(sha256sum "$TRAY_TMP" | cut -d' ' -f1)"
        if [ "$GOT" != "$TRAY_SHA" ]; then
          rm -f "$TRAY_TMP"
          TRAY_FETCH_FAILED=1
          TRAY_REASON="SHA256 mismatch against install/easytier-pins.txt"
          TRAY_DETAIL="expected $TRAY_SHA, got $GOT for $TRAY_ASSET. Report a checksum mismatch rather than retrying it."
        else
          install -m 0755 "$TRAY_TMP" "$TRAY_BIN"
          rm -f "$TRAY_TMP"
          TRAY_INSTALLED=1
          log "installed $TRAY_BIN (SHA256 pinned)"
        fi
      fi
    fi
  fi
fi

if [ "$TRAY_INSTALLED" = "1" ]; then
  act mkdir -p "$AUTOSTART_DIR"
  put_file 644 "$AUTOSTART_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=sukarfleet console
Comment=Fleet status in the system tray
Exec=$TRAY_BIN
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
  # Started now rather than at the next login, so the console is open when this
  # script finishes rather than tomorrow morning.
  if [ "$DRY_RUN" = "1" ]; then
    dry "systemd-run --user --unit=sukarfleet-tray $TRAY_BIN"
  elif command -v systemd-run >/dev/null 2>&1; then
    systemd-run --user --unit=sukarfleet-tray "$TRAY_BIN" >/dev/null 2>&1 || \
      warn "the tray is installed but would not start now. It will start at your next login; until then the console is at ${UI_URL}"
  fi
  log "installed $AUTOSTART_FILE, autostart on"
  # GNOME does not render a StatusNotifier icon without the AppIndicator
  # extension, and the failure is silent: the tray process runs and nothing
  # appears. There is no --console flag to offer instead (the tray parses only
  # --endpoint), so the browser console is the fallback worth naming.
  case "${XDG_CURRENT_DESKTOP:-}" in
    *GNOME*|*gnome*)
      note "the tray is running but GNOME needs the AppIndicator extension (gnome-shell-extension-appindicator) to show it. Until it is installed, open the console at ${UI_URL}" ;;
  esac
elif [ "$TRAY_FETCH_FAILED" = "1" ]; then
  warn "could not install sukarfleet-tray (${TRAY_REASON}). Nothing was installed to ${BIN_DIR}. The daemon and the web console are unaffected: ${UI_URL}"
  [ -n "$TRAY_DETAIL" ] && note "  $TRAY_DETAIL"
elif [ -n "$TRAY_REASON" ] && [ "$DESKTOP" = "1" ] && [ "$ARCH" != "x86_64" ]; then
  note "no tray build for $ARCH yet. The daemon is installed and running; use the web console at ${UI_URL}"
elif [ -n "$TRAY_REASON" ] && [ "$DESKTOP" = "1" ] && [ "$DO_TRAY" = "1" ]; then
  warn "$TRAY_REASON. Skipping the tray. Open ${UI_URL} in a browser instead."
fi

# =============================================================================
# 13. the one root step -- printed, never run
# =============================================================================
# quickstart.sh never calls sudo and never writes a sudoers file. This string is
# the SAME one the console's Mesh card shows (src/uiserve.ts's
# elevatedInstallCommand); if the two ever drift, the one a stranger copies is
# whichever they read first, so they are built the same way from the same two
# paths.
ROOT_STEP="sudo $ELEVATED --adopt-pending-secret --pending=$PENDING_SECRET"

MESH_UP=0
if sctl is-active --quiet easytier-fleet.service 2>/dev/null; then
  MESH_UP=1
fi

# Never print /ui/ as the answer on a machine whose console is the tray, or one
# where an operator turned the assets off: admin.uiAssets:false 404s the HTML.
UI_ASSETS_ON=1
if grep -q '"uiAssets"[[:space:]]*:[[:space:]]*false' "$CONFIG_FILE" 2>/dev/null; then
  UI_ASSETS_ON=0
fi

# =============================================================================
# 14. banner
# =============================================================================
cat <<BANNER

────────────────────────────────────────────────────────────────────────
  sukarfleet is installed on ${MACHINE}.
BANNER
if [ "$TRAY_INSTALLED" = "1" ]; then
  cat <<BANNER
  The console window is open (tray icon > Open fleet console).
BANNER
elif [ "$UI_ASSETS_ON" = "1" ]; then
  cat <<BANNER

  Open the console:  ${UI_URL}
  Drive this machine's console from another machine:
      ssh -N -L 7711:127.0.0.1:${NODE_PORT} ${USER:-you}@${MACHINE}
      then open http://127.0.0.1:7711/ui/ over there
BANNER
else
  cat <<BANNER

  The browser console is switched off on this machine (admin.uiAssets is false).
  Its console is the tray: start ${TRAY_BIN}, or turn the assets back on in
  ${CONFIG_FILE}.
BANNER
fi
if [ "$ADMIN_ENABLED" != "true" ]; then
  cat <<BANNER

  Admin lane: OFF, which is the default. Turn on the "Admin lane" switch on the
  console's Credentials screen -- until you do, every admin run from this
  machine, including a self-targeted one, refuses with lane-disabled.
BANNER
fi
if [ "$MESH_UP" = "1" ]; then
  cat <<BANNER

  Mesh: easytier-fleet.service is already running -- no root step needed.
  Next: pair (Pair screen) with a machine that is already in the fleet.
────────────────────────────────────────────────────────────────────────
BANNER
else
  cat <<BANNER

  Mesh: not running yet. ONE root step, the only one in this install:

      ${ROOT_STEP}

  It will do exactly five things, and nothing else:
    1. read the staged mesh details, refusing the file unless it is a
       regular file you own at mode 0600
    2. write /etc/easytier/fleet.toml (0600 root), shred the staged copy
    3. fetch EasyTier, check it against a SHA256 pinned here, install it
    4. if a firewall is running, open the mesh listener ports, and ${NODE_PORT}
       from the mesh subnet only
    5. restart your own sukarfleet daemon, so it listens on the mesh address
       instead of on every interface

  Do the console's "Mesh network" card first. Until you do, this command
  refuses and writes nothing: it has no secret to adopt.
────────────────────────────────────────────────────────────────────────
BANNER
fi

# =============================================================================
# 15. done
# =============================================================================
# A re-run that found everything in place says so in one line, so a second run is
# legibly a no-op rather than a wall of output that looks like a reinstall.
# "Already installed" is the user stage's verdict on itself: a config it did not
# have to write and a daemon that was already answering /health. Whether the mesh
# is up is the banner's line above, not this one's.
# The elapsed time here is THIS stage. install/get.sh clones or fetches the
# checkout before this script starts and prints its own duration, so a re-run
# that took twenty seconds of wall clock and reports four here is not a lie --
# the other sixteen were the checkout, and that line says so.
if [ "$CONFIG_EXISTED" = "1" ] && [ "$RERUN" = "1" ]; then
  note "done in $(elapsed)s in this stage (install/get.sh timed the checkout separately). This machine is already installed."
else
  note "done in $(elapsed)s"
fi

if [ "$DO_OPEN" = "1" ] && [ "$TRAY_INSTALLED" != "1" ] && [ "$UI_ASSETS_ON" = "1" ] && \
   [ "$DESKTOP" = "1" ] && command -v xdg-open >/dev/null 2>&1; then
  act xdg-open "$UI_URL" >/dev/null 2>&1 || true
fi
