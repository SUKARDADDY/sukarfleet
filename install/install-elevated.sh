#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The one step that needs root. Stage 2 of two.
#
#   sudo install/install-elevated.sh --adopt-pending-secret --pending=<path>
#
# It does exactly four things, all narrow enough to read in full before you run
# them:
#
#   1. reads the mesh details the console staged for it, refusing the file unless
#      it is a regular file, owned by you, at mode 0600
#   2. writes /etc/easytier/fleet.toml (0600 root) from those details and shreds
#      the staged copy
#   3. fetches EasyTier, checks it against a SHA256 pinned in
#      install/easytier-pins.txt, installs it to /opt/easytier
#   4. installs and starts easytier-fleet.service, opens the mesh listener ports
#      if a firewall is already running, and grants the daemon's user permission
#      to restart that ONE service with no password
#
# What it deliberately does NOT do: write anything into your home directory,
# create a user, touch your SSH configuration, install a privileged helper, or
# enable a firewall that was not already running. The daemon itself runs
# unprivileged and never needs root to sync; the sudoers grant exists only so the
# transport watchdog can restart a wedged mesh without waking a human.
#
# The admin lane does NOT use that grant. That lane authenticates with a stored
# password of your own and is off by default -- see SECURITY.md.
#
# Everything here is machine-agnostic: identity comes from the invoking user, the
# staged file and the arguments. Re-running is safe and is the intended upgrade
# path: it rewrites the TOML from whatever is staged, revalidates the sudoers
# rule, and leaves an already-installed EasyTier alone.
#
# Exit codes (docs/INSTALL-FLOW.md section 6):
#   0  installed, or skipped something and said so
#   2  a precondition is missing (not root, no systemctl, unsupported arch)
#   3  something is present and wrong (nothing staged, staged file refused)
#   5  a download, a checksum or the service failed
#
# Requires bash, not sh.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

SUDOERS_FILE="/etc/sudoers.d/sukarfleet-transport"
DEFAULT_SERVICE="easytier-fleet.service"
PINS_FILE="$SCRIPT_DIR/easytier-pins.txt"
EASYTIER_DIR="${SUKARFLEET_EASYTIER_DIR:-/opt/easytier}"
EASYTIER_CONF_DIR="${SUKARFLEET_EASYTIER_CONF_DIR:-/etc/easytier}"
EASYTIER_TOML="$EASYTIER_CONF_DIR/fleet.toml"
UNIT_SRC="$REPO_ROOT/systemd/easytier-fleet.service"
UNIT_DST="${SUKARFLEET_SYSTEM_UNIT_DIR:-/etc/systemd/system}/easytier-fleet.service"
EASYTIER_URL_BASE="${SUKARFLEET_EASYTIER_URL_BASE:-https://github.com/EasyTier/EasyTier/releases/download}"
RPC_ADDR="127.0.0.1:15888"

SERVICE="$DEFAULT_SERVICE"
TARGET_USER="${SUDO_USER:-}"
PENDING=""
BUN_BIN="${SUKARFLEET_BUN:-}"
DO_REMOVE=0
DO_ADOPT=0
NO_EASYTIER=0
FORCE_MESH_REINSTALL=0
EXTRA_PEERS=()

# Test seam: 1 turns every write, download, systemctl, install and rm into a
# printed line and changes nothing on disk. The control flow is walked in full.
DRY_RUN="${SUKARFLEET_DRY_RUN:-0}"

START_TS="$(date +%s)"
elapsed() { echo "$(( $(date +%s) - START_TS ))"; }

log()  { printf '[install-elevated] %s\n' "$*"; }
# "a, b and c", because "a b c" reads as one thing with spaces in it.
join_list() {
  local n=$#
  case "$n" in
    0) printf 'nothing' ;;
    1) printf '%s' "$1" ;;
    *) local last="${!n}"; printf '%s and %s' "$(printf '%s, ' "${@:1:n-1}" | sed 's/, $//')" "$last" ;;
  esac
}
warn() { printf '[install-elevated] WARNING: %s\n' "$*" >&2; }
dry()  { printf '[install-elevated] [dry-run] %s\n' "$*"; }
die()  { printf '[install-elevated] ERROR: %s\n' "$1" >&2; exit "${2:-2}"; }

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
usage: sudo ./install/install-elevated.sh --adopt-pending-secret --pending=PATH

  --adopt-pending-secret  Adopt the mesh details the console staged, install the
                          mesh transport, and grant the restart rule. This is the
                          flag the console and the installer banner print.
  --pending=PATH          The staged file. Refused unless it is a regular file,
                          owned by the invoking user, at mode 0600.
  --no-easytier           Do not fetch or configure EasyTier. Writes the sudoers
                          grant only, leaves the staged secret alone, and prints
                          the manual install line.
  --service=NAME          Mesh transport service. Default: ${DEFAULT_SERVICE}
  --user=NAME             User the daemon runs as. Default: the user invoking sudo.
  --bun=PATH              The invoking user's bun. Root's PATH does not contain
                          ~/.bun/bin, so this is passed explicitly.
  --peer=URI              Add a [[peer]] to the generated TOML. Repeatable.
  --force-mesh-reinstall  Re-download and replace an EasyTier already at
                          ${EASYTIER_DIR}.
  --remove                Remove everything this script installs (the root half
                          of install/uninstall.sh) and exit.
  -h, --help              This text.

Installs ${SUDOERS_FILE} granting exactly:
  <user> ALL=(root) NOPASSWD: <systemctl> restart <service>
EOF
}

for arg in "$@"; do
  case "$arg" in
    --adopt-pending-secret) DO_ADOPT=1 ;;
    --pending=*)   PENDING="${arg#*=}" ;;
    --no-easytier) NO_EASYTIER=1 ;;
    --service=*)   SERVICE="${arg#*=}" ;;
    --user=*)      TARGET_USER="${arg#*=}" ;;
    --bun=*)       BUN_BIN="${arg#*=}" ;;
    --peer=*)      EXTRA_PEERS+=("${arg#*=}") ;;
    --force-mesh-reinstall) FORCE_MESH_REINSTALL=1 ;;
    --enable)      : ;; # accepted and ignored: enabling is what this script does now
    --remove)      DO_REMOVE=1 ;;
    -h|--help)     usage; exit 0 ;;
    *) printf '[install-elevated] ERROR: unknown argument: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

# =============================================================================
# Preconditions
# =============================================================================
if [ "$(id -u)" -ne 0 ] && [ "$DRY_RUN" != "1" ]; then
  die "must be run as root (sudo $(basename -- "$0"))." 2
fi
for c in systemctl visudo install; do
  command -v "$c" >/dev/null 2>&1 || die "required command not found: $c" 2
done

# =============================================================================
# --remove: the root half of the uninstall
# =============================================================================
if [ "$DO_REMOVE" -eq 1 ]; then
  REMOVED=()
  LEFT=()
  if sctl list-unit-files "$SERVICE" 2>/dev/null || [ -f "$UNIT_DST" ]; then
    sctl disable --now "$SERVICE" 2>/dev/null || true
    if [ -f "$UNIT_DST" ] || [ "$DRY_RUN" = "1" ]; then
      act rm -f "$UNIT_DST"
      REMOVED+=("$UNIT_DST")
    fi
    sctl daemon-reload 2>/dev/null || true
  else
    LEFT+=("$SERVICE (not installed)")
  fi
  for d in "$EASYTIER_CONF_DIR" "$EASYTIER_DIR"; do
    if [ -d "$d" ]; then act rm -rf "$d"; REMOVED+=("$d"); else LEFT+=("$d (not present)"); fi
  done
  if [ -f "$SUDOERS_FILE" ]; then act rm -f "$SUDOERS_FILE"; REMOVED+=("$SUDOERS_FILE"); else LEFT+=("$SUDOERS_FILE (not present)"); fi
  # Only the rules this installer created, matched by their comment.
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -n1 | grep -q 'Status: active'; then
    while read -r rulenum; do
      [ -n "$rulenum" ] || continue
      act ufw --force delete "$rulenum"
      REMOVED+=("ufw rule $rulenum")
    done < <(ufw status numbered 2>/dev/null | grep -i 'sukarfleet' | grep -o '^\[[ 0-9]*\]' | tr -d '[] ' | sort -rn)
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    log "firewalld is running: any ports this installer opened are listed by 'firewall-cmd --list-ports'. Remove them with --permanent --remove-port=<port>/<proto>, then --reload."
  fi
  if [ "${#REMOVED[@]}" -gt 0 ]; then
    log "removed: $(join_list "${REMOVED[@]}")"
  else
    log "nothing to remove: no ${SERVICE}, no ${EASYTIER_CONF_DIR}, no ${SUDOERS_FILE}. Left everything alone."
  fi
  [ "${#LEFT[@]}" -gt 0 ] && log "not present: $(join_list "${LEFT[@]}")"
  log "done in $(elapsed)s"
  exit 0
fi

if [ -z "$TARGET_USER" ]; then
  die "could not determine the daemon user. Pass --user=NAME." 2
fi
if ! id -u "$TARGET_USER" >/dev/null 2>&1; then
  die "user does not exist: $TARGET_USER" 2
fi
TARGET_UID="$(id -u "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6)"
TARGET_HOME="${TARGET_HOME:-/home/$TARGET_USER}"

# Both values are interpolated into a sudoers command spec, so each is constrained
# to a charset that cannot introduce a second command, an extra argument, or a
# comment.
case "$SERVICE" in
  *[!A-Za-z0-9._@-]*) die "refusing a service name with unexpected characters: $SERVICE" 3 ;;
esac
case "$TARGET_USER" in
  *[!A-Za-z0-9._-]*) die "refusing a user name with unexpected characters: $TARGET_USER" 3 ;;
esac

# =============================================================================
# Reading the staged file safely
# =============================================================================
# `--pending=<path>` is treated as hostile until proven otherwise: a root process
# reading a path under an unprivileged user's home is the classic symlink-swap
# target. The `[ -L ]` test below is the cheap first answer; the authoritative one
# is the open(O_NOFOLLOW) + fstat inside the reader, so the check and the open
# cannot be raced apart.
#
# A refusal exits 3, writes nothing, and LEAVES THE FILE ALONE: this does not
# delete a file it has just decided it does not trust.
read_staged() {
  local path="$1" secret_out="$2"
  python3 - "$path" "$secret_out" "$TARGET_UID" <<'PY'
import json, os, stat, sys, shlex

path, secret_out, want_uid = sys.argv[1], sys.argv[2], int(sys.argv[3])

def refuse(msg):
    sys.stderr.write(msg + "\n")
    raise SystemExit(3)

try:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
except OSError as e:
    if e.errno in (40, 62):  # ELOOP on Linux is 40; 62 is ELOOP on some arches
        refuse("it is a symbolic link (expected a regular file owned by you at mode 0600)")
    if e.errno == 2:
        refuse("__MISSING__")
    refuse("it could not be opened (%s)" % e.strerror)

try:
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        refuse("it is not a regular file (expected a regular file owned by you at mode 0600)")
    if st.st_uid != want_uid:
        refuse("it is owned by uid %d, not by you (uid %d)" % (st.st_uid, want_uid))
    if stat.S_IMODE(st.st_mode) != 0o600:
        refuse("its mode is %04o, not 0600" % stat.S_IMODE(st.st_mode))
    raw = os.read(fd, 1 << 20).decode("utf-8", "replace")
finally:
    os.close(fd)

text = raw.strip()
if not text:
    refuse("it is empty")

# The console stages JSON. A machine set up before that change staged a bare
# secret and a newline, and both have to keep working: the bare form takes its
# mesh IP, network name and hostname from the invoking user's config.json below.
fields = {}
secret = text
if text.startswith("{"):
    try:
        obj = json.loads(text)
    except ValueError:
        refuse("it is not valid JSON and does not look like a bare secret")
    if not isinstance(obj, dict):
        refuse("it is JSON but not an object")
    secret = obj.get("networkSecret") or ""
    if not isinstance(secret, str) or not secret.strip():
        refuse("its JSON carries no networkSecret")
    secret = secret.strip()
    for key in ("networkName", "meshIp", "hostname"):
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            fields[key] = val.strip()
    listeners = obj.get("listeners")
    if isinstance(listeners, list):
        clean = [str(x).strip() for x in listeners if isinstance(x, str) and x.strip()]
        if clean:
            fields["listeners"] = " ".join(clean)
    peers = obj.get("peers")
    if isinstance(peers, list):
        clean = [str(x).strip() for x in peers if isinstance(x, str) and x.strip()]
        if clean:
            fields["peers"] = " ".join(clean)

# The secret never travels on argv, in an environment variable, or through this
# script's stdout: it goes straight from the staged file into a 0600 root-owned
# file inside the already-0700 /etc/easytier, and the TOML generator reads THAT.
out = os.open(secret_out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.write(out, (secret + "\n").encode("utf-8"))
finally:
    os.close(out)

print("STAGED_SECRET_LEN=%d" % len(secret))
for key, val in fields.items():
    print("STAGED_%s=%s" % (key.upper(), shlex.quote(val)))
PY
}

# Reads identity out of the invoking user's config.json for the fields a bare
# staged secret does not carry. Not a secret, so a plain read is fine; still
# O_NOFOLLOW, because it is still a path under somebody else's home.
read_user_config() {
  local path="$1"
  python3 - "$path" <<'PY'
import json, os, sys, shlex
path = sys.argv[1]
try:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
except OSError:
    raise SystemExit(0)
try:
    raw = os.read(fd, 1 << 20).decode("utf-8", "replace")
finally:
    os.close(fd)
try:
    cfg = json.loads(raw)
except ValueError:
    raise SystemExit(0)
if not isinstance(cfg, dict):
    raise SystemExit(0)
for key, var in (("machine", "CFG_MACHINE"), ("meshIp", "CFG_MESH_IP"),
                 ("networkName", "CFG_NETWORK_NAME"), ("nodePort", "CFG_NODE_PORT")):
    val = cfg.get(key)
    if isinstance(val, (str, int)) and str(val).strip():
        print("%s=%s" % (var, shlex.quote(str(val).strip())))
PY
}

# =============================================================================
# fetch_easytier -- ONE function, so the licence question about fetching versus
# bundling has exactly one place to change if the answer flips (decision 7).
# =============================================================================
pin_lookup() {
  local prefix="$1" arch="$2"
  [ -f "$PINS_FILE" ] || return 1
  awk -v p="$prefix" -v a="$arch" '
    /^[[:space:]]*#/ { next }
    NF < 4 { next }
    $2 == a && index($4, p) == 1 { print $1 " " $3 " " $4; found = 1; exit }
    END { if (!found) exit 1 }
  ' "$PINS_FILE"
}

easytier_arch() {
  case "$(uname -m)" in
    x86_64) printf 'x86_64' ;;
    aarch64|arm64) printf 'aarch64' ;;
    *) return 1 ;;
  esac
}

fetch_easytier() {
  local arch pin version sha asset url tmpdir got srcdir
  arch="$(easytier_arch)" || die "unsupported architecture '$(uname -m)'. EasyTier ships x86_64 and aarch64 builds for Linux; the manual route is docs/INSTALL-FLOW.md section 9." 2
  pin="$(pin_lookup 'easytier-linux-' "$arch" || true)"
  [ -n "$pin" ] || die "no EasyTier pin for $arch in $PINS_FILE. Nothing was installed." 3
  read -r version sha asset <<<"$pin"
  if [ "$sha" = "TODO-S9" ]; then
    die "the EasyTier pin for $arch is still TODO-S9, so this download cannot be verified. Nothing was installed. Install EasyTier yourself at ${EASYTIER_DIR}, then re-run with --no-easytier." 3
  fi
  url="$EASYTIER_URL_BASE/v$version/$asset"

  if [ -x "$EASYTIER_DIR/easytier-core" ] && [ "$FORCE_MESH_REINSTALL" != "1" ]; then
    log "EasyTier already at $EASYTIER_DIR (pass --force-mesh-reinstall to replace it)"
    return 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    dry "curl -fsSL $url -o <tmp>/$asset"
    dry "verify sha256 == $sha"
    dry "unzip <tmp>/$asset and install -m 0755 easytier-core easytier-cli into $EASYTIER_DIR"
    return 0
  fi

  command -v unzip >/dev/null 2>&1 || die "unzip is not installed. Run: sudo apt-get install -y unzip" 2
  tmpdir="$(mktemp -d -t sukarfleet-easytier.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmpdir'" RETURN
  log "downloading $asset"
  # curl's own line distinguishes a 404 from a DNS failure from a TLS failure and
  # is the only place that distinction appears, so it is kept -- prefixed, so it
  # reads as part of this script's output rather than as debris.
  if ! curl -fsSL --max-time 300 -o "$tmpdir/$asset" "$url" 2>"$tmpdir/curl.err"; then
    [ -s "$tmpdir/curl.err" ] && sed 's/^/[install-elevated]   /' "$tmpdir/curl.err" >&2
    die "could not download $asset. Nothing was installed. Check the network, or re-run with --no-easytier and install EasyTier yourself." 5
  fi
  got="$(sha256sum "$tmpdir/$asset" | cut -d' ' -f1)"
  if [ "$got" != "$sha" ]; then
    rm -f "$tmpdir/$asset"
    die "SHA256 mismatch for $asset. expected $sha, got $got. Nothing was installed." 5
  fi
  log "SHA256 verified against the pin for EasyTier $version/$arch"
  unzip -q -o "$tmpdir/$asset" -d "$tmpdir/unpack" || die "$asset unpacked to nothing recognisable. Nothing was installed." 5
  srcdir="$tmpdir/unpack/easytier-linux-$arch"
  if [ ! -d "$srcdir" ]; then
    srcdir="$(find "$tmpdir/unpack" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  fi
  [ -n "$srcdir" ] && [ -f "$srcdir/easytier-core" ] || \
    die "$asset does not contain easytier-core where expected. Nothing was installed." 5
  # A running easytier-core holds its own image open; stop it before replacing.
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  install -d -m 0755 -o root -g root "$EASYTIER_DIR"
  install -m 0755 -o root -g root "$srcdir/easytier-core" "$EASYTIER_DIR/easytier-core"
  install -m 0755 -o root -g root "$srcdir/easytier-cli" "$EASYTIER_DIR/easytier-cli"
  log "installed EasyTier $version ($arch) to $EASYTIER_DIR"
}

# =============================================================================
# The sudoers grant. Written on every path, including --no-easytier: it is the
# one thing this script has always done and the reason the daemon can recover a
# wedged mesh without waking a human.
# =============================================================================
install_sudoers() {
  local systemctl_path tmp
  systemctl_path="$(command -v systemctl)"
  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
# sukarfleet mesh-transport restart grant.
#
# Installed by install/install-elevated.sh. Grants exactly one command, by absolute path, with a
# fixed argument list: restarting the mesh transport service. The daemon's transport watchdog uses
# it to recover a wedged mesh without waking a human.
#
# This is the ONLY passwordless grant this project installs.
${TARGET_USER} ALL=(root) NOPASSWD: ${systemctl_path} restart ${SERVICE}
EOF
  # Validated before it is ever put in place: a malformed drop-in can lock every
  # user out of sudo.
  if ! visudo -cf "$tmp" >/dev/null; then
    rm -f "$tmp"
    die "generated sudoers rule failed validation; nothing was installed" 3
  fi
  if [ "$DRY_RUN" = "1" ]; then
    dry "install -m 0440 -o root -g root <validated rule> $SUDOERS_FILE"
    rm -f "$tmp"
  else
    install -m 0440 -o root -g root "$tmp" "$SUDOERS_FILE"
    rm -f "$tmp"
  fi
  log "installed $SUDOERS_FILE"
  log "  ${TARGET_USER} may now run: ${systemctl_path} restart ${SERVICE}"
}

# =============================================================================
# Firewall. Port-scoped, not binary-scoped: Linux firewall front ends have no
# equivalent of the -Program scoping the Windows installer uses, so the narrowing
# comes from the ports and a source restriction. NEVER enables a firewall that is
# not already running.
# =============================================================================
open_firewall() {
  local mesh_ip="$1" node_port="$2"
  shift 2
  local listeners=("$@")
  local subnet="" rules=()
  # The /24 containing the staged mesh IP. Narrower than "anywhere" and wider
  # than one host, which is what a mesh subnet is.
  if [[ "$mesh_ip" =~ ^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\.[0-9]{1,3}$ ]]; then
    subnet="${BASH_REMATCH[1]}.0/24"
  fi

  local ports=()
  for l in "${listeners[@]}"; do
    # tcp://0.0.0.0:11010 -> "11010 tcp"
    local proto="${l%%:*}" port="${l##*:}"
    case "$proto" in tcp|udp) ;; *) continue ;; esac
    case "$port" in ''|*[!0-9]*) continue ;; esac
    ports+=("$port/$proto")
  done

  if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | head -n1 | grep -q 'Status: active'; then
      for p in "${ports[@]}"; do
        rules+=("ufw allow ${p} comment 'sukarfleet mesh listener'")
      done
      if [ -n "$subnet" ]; then
        rules+=("ufw allow from ${subnet} to any port ${node_port} proto tcp comment 'sukarfleet node (mesh subnet only)'")
      else
        warn "the staged mesh IP is not an IPv4 address, so no source-scoped rule was added for ${node_port}/tcp. Add one by hand once the mesh subnet is known."
      fi
      for r in "${rules[@]}"; do
        log "firewall: $r"
        if [ "$DRY_RUN" = "1" ]; then dry "$r"; else eval "$r" >/dev/null 2>&1 || warn "that ufw rule was refused; add it by hand"; fi
      done
      return 0
    fi
    log "ufw is installed but inactive, so no rule was needed: no firewall is running."
    return 0
  fi

  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    for p in "${ports[@]}"; do
      rules+=("firewall-cmd --permanent --add-port=${p}")
    done
    if [ -n "$subnet" ]; then
      rules+=("firewall-cmd --permanent --add-rich-rule=rule family=\"ipv4\" source address=\"${subnet}\" port port=\"${node_port}\" protocol=\"tcp\" accept")
    fi
    rules+=("firewall-cmd --reload")
    for r in "${rules[@]}"; do
      log "firewall: $r"
      if [ "$DRY_RUN" = "1" ]; then dry "$r"; else eval "$r" >/dev/null 2>&1 || warn "that firewall-cmd was refused; add the rule by hand"; fi
    done
    return 0
  fi

  log "no firewall is running (neither an active ufw nor firewalld), so no rule was added."
  log "  If you turn one on later, open ${ports[*]} and ${node_port}/tcp from ${subnet:-the mesh subnet}."
}

# =============================================================================
# Stage 2 proper
# =============================================================================
if [ "$DO_ADOPT" != "1" ] && [ "$NO_EASYTIER" != "1" ]; then
  die "nothing to do. This is the one root step of the install and it needs --adopt-pending-secret --pending=<path>, which the console's Mesh card and the installer banner both print. Nothing was written." 2
fi

USER_CONFIG="$TARGET_HOME/.config/sukarfleet/config.json"
CFG_MACHINE=""; CFG_MESH_IP=""; CFG_NETWORK_NAME=""; CFG_NODE_PORT=""
if [ -f "$USER_CONFIG" ]; then
  eval "$(read_user_config "$USER_CONFIG" || true)"
fi

if [ "$NO_EASYTIER" = "1" ]; then
  install_sudoers
  log "skipping the mesh transport. Nothing was written to ${EASYTIER_CONF_DIR} and the staged secret was left alone."
  log "Install EasyTier yourself at ${EASYTIER_DIR}, then re-run this command without the flag:"
  log "  curl -fsSL $EASYTIER_URL_BASE/v2.6.4/easytier-linux-\$(uname -m)-v2.6.4.zip -o /tmp/easytier.zip"
  log "  sudo unzip -j /tmp/easytier.zip '*/easytier-core' '*/easytier-cli' -d ${EASYTIER_DIR}"
  log "done in $(elapsed)s"
  exit 0
fi

[ -n "$PENDING" ] || PENDING="$TARGET_HOME/.local/state/sukarfleet/pending-easytier-secret"

# The [ -L ] test comes BEFORE [ -f ], because -f follows symlinks and would
# answer "yes, a regular file" about the link's target.
if [ -L "$PENDING" ]; then
  die "refusing $PENDING: it is a symbolic link (expected a regular file owned by you at mode 0600). Nothing was written and the file was left alone." 3
fi
if [ ! -e "$PENDING" ]; then
  die "nothing is staged at $PENDING. Do the console's \"Mesh network\" card first, then run this command again. Nothing was written." 3
fi

# A refusal must write NOTHING, so the guard runs before /etc/easytier exists.
# The secret lands in a root-owned 0700 scratch directory (mktemp -d's default
# mode), never in /tmp world-visible, and is shredded on the way out.
WORK="$(mktemp -d -t sukarfleet-elevated.XXXXXX)"
SECRET_TMP="$WORK/staged-secret"
STAGED_LISTENERS=""
STAGED_PEERS=""
STAGED_MESHIP=""
STAGED_NETWORKNAME=""
STAGED_HOSTNAME=""
STAGED_SECRET_LEN=0

cleanup_work() {
  [ -n "${WORK:-}" ] || return 0
  # The scratch copy of the secret is overwritten, not just unlinked, on every
  # exit path including a refusal and a dry run. Inlined rather than calling
  # shred_file: this trap can fire before that function is defined, and a dry run
  # must still really overwrite a real secret it really wrote.
  if [ -f "${SECRET_TMP:-}" ]; then
    local sz
    sz="$(stat -c '%s' "$SECRET_TMP" 2>/dev/null || echo 0)"
    dd if=/dev/zero of="$SECRET_TMP" bs=1 count="$sz" conv=notrunc >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup_work EXIT

if [ "$DRY_RUN" = "1" ]; then
  dry "read $PENDING under O_NOFOLLOW; refuse unless regular file, uid $TARGET_UID, mode 0600"
  dry "write the secret to a 0600 file inside $WORK, then into $EASYTIER_CONF_DIR"
  # A dry run walks the guard for REAL -- it is the whole reason the refusal paths
  # are testable without root and without a live fleet. The only thing it writes
  # is the scratch copy inside $WORK, which is shredded on the way out.
  if [ -e "$PENDING" ] && command -v python3 >/dev/null 2>&1; then
    GUARD_ERR="$(mktemp)"
    if ! STAGED_VARS="$(read_staged "$PENDING" "$SECRET_TMP" 2>"$GUARD_ERR")"; then
      REASON="$(cat "$GUARD_ERR")"; rm -f "$GUARD_ERR"
      case "$REASON" in
        *__MISSING__*) die "nothing is staged at $PENDING. Do the console's \"Mesh network\" card first, then run this command again. Nothing was written." 3 ;;
        *) die "refusing $PENDING: ${REASON}. Nothing was written and the file was left alone." 3 ;;
      esac
    fi
    rm -f "$GUARD_ERR"
    eval "$STAGED_VARS"
    STAGED_VARS=""
    dry "the staged file passed the guard"
  fi
else
  GUARD_ERR="$(mktemp)"
  if ! STAGED_VARS="$(read_staged "$PENDING" "$SECRET_TMP" 2>"$GUARD_ERR")"; then
    REASON="$(cat "$GUARD_ERR")"; rm -f "$GUARD_ERR"
    case "$REASON" in
      *__MISSING__*) die "nothing is staged at $PENDING. Do the console's \"Mesh network\" card first, then run this command again. Nothing was written." 3 ;;
      *) die "refusing $PENDING: ${REASON}. Nothing was written and the file was left alone." 3 ;;
    esac
  fi
  rm -f "$GUARD_ERR"
  eval "$STAGED_VARS"
  STAGED_VARS=""
fi

# The staged file wins on every field it carries; an older bare-secret staging
# carries none of them, and the invoking user's config.json fills the gaps.
MESH_IP="${STAGED_MESHIP:-$CFG_MESH_IP}"
NETWORK_NAME="${STAGED_NETWORKNAME:-${CFG_NETWORK_NAME:-sukarfleet}}"
MACHINE="${STAGED_HOSTNAME:-${CFG_MACHINE:-$(hostname)}}"
NODE_PORT="${CFG_NODE_PORT:-7710}"
# The pair the Windows installer builds, and the pair the firewall rules are cut
# from. Not exposed in the console in v1.
if [ -n "$STAGED_LISTENERS" ]; then
  read -r -a LISTENERS <<<"$STAGED_LISTENERS"
else
  LISTENERS=("tcp://0.0.0.0:11010" "udp://0.0.0.0:11010")
fi
PEERS=()
[ -n "$STAGED_PEERS" ] && read -r -a PEERS <<<"$STAGED_PEERS"
[ "${#EXTRA_PEERS[@]}" -gt 0 ] && PEERS+=("${EXTRA_PEERS[@]}")

if [ -z "$MESH_IP" ]; then
  die "no mesh IP: the staged file does not carry one and $USER_CONFIG has meshIp empty. Set this machine's mesh address on the console's Identity card, then run this command again. Nothing was written." 3
fi
log "adopting the staged mesh details for $MACHINE ($MESH_IP, network '$NETWORK_NAME', ${STAGED_SECRET_LEN}-character secret)"

# --- EasyTier -----------------------------------------------------------------
fetch_easytier

# --- fleet.toml ---------------------------------------------------------------
# This stage does NOT re-implement the TOML layout. It calls the daemon's own
# generator, which is the single source of the key layout and of the two
# constraints that make hand-writing it dangerous: every top-level key must
# precede the first table header, and rpc_portal is a unit CLI flag, not a file
# key. $BUN is passed explicitly, because root's PATH does not contain the
# invoking user's ~/.bun/bin.
if [ -z "$BUN_BIN" ]; then
  for c in "$TARGET_HOME/.bun/bin/bun" "$(command -v bun 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && { BUN_BIN="$c"; break; }
  done
fi
[ -n "$BUN_BIN" ] && [ -x "$BUN_BIN" ] || [ "$DRY_RUN" = "1" ] || \
  die "could not find the invoking user's bun. Pass --bun=/path/to/bun. Nothing was written to $EASYTIER_CONF_DIR." 2

TOML_ARGS=(run "$REPO_ROOT/src/cli.ts" easytier-toml
  --secret-file "$SECRET_TMP"
  --mesh-ip "$MESH_IP"
  --network-name "$NETWORK_NAME"
  --hostname "$MACHINE"
  --rpc-addr "$RPC_ADDR")
for l in "${LISTENERS[@]}"; do TOML_ARGS+=(--listener "$l"); done
for p in "${PEERS[@]:-}"; do [ -n "$p" ] && TOML_ARGS+=(--peer "$p"); done

# 0700 root. That mode is load-bearing beyond privacy: the daemon reads mesh state
# from the service rather than from this file precisely because an unprivileged
# stat here must always answer "absent".
act install -d -m 0700 -o root -g root "$EASYTIER_CONF_DIR"

if [ "$DRY_RUN" = "1" ]; then
  dry "${BUN_BIN:-<bun>} ${TOML_ARGS[*]} > $WORK/fleet.toml"
  dry "install -m 0600 -o root -g root $WORK/fleet.toml $EASYTIER_TOML"
else
  TOML_TMP="$WORK/fleet.toml"
  rm -f "$TOML_TMP"
  ( umask 077 && "$BUN_BIN" "${TOML_ARGS[@]}" > "$TOML_TMP" ) || \
    { rm -f "$TOML_TMP"; die "the TOML generator failed. Nothing was written to $EASYTIER_TOML and the staged file was left alone." 5; }
  [ -s "$TOML_TMP" ] || { rm -f "$TOML_TMP"; die "the TOML generator produced nothing. Nothing was written to $EASYTIER_TOML." 5; }
  install -m 0600 -o root -g root "$TOML_TMP" "$EASYTIER_TOML"
  rm -f "$TOML_TMP"
fi
log "wrote $EASYTIER_TOML (0600 root; it holds the network secret in plaintext)"

# --- shred the staged copy ----------------------------------------------------
# Overwrite before delete, with the same honesty about what it buys as the
# Windows path: no guarantee on a copy-on-write filesystem or a wear-levelling
# SSD, but it does keep the secret out of a trivially undeleted file.
shred_file() {
  local f="$1"
  if [ "$DRY_RUN" = "1" ]; then dry "overwrite $f with zeroes to its own length, then unlink it"; return 0; fi
  [ -f "$f" ] || return 0
  if command -v shred >/dev/null 2>&1; then
    shred -u -z -n 1 "$f" 2>/dev/null && return 0
  fi
  local size
  size="$(stat -c '%s' "$f" 2>/dev/null || echo 0)"
  dd if=/dev/zero of="$f" bs=1 count="$size" conv=notrunc >/dev/null 2>&1 || true
  rm -f "$f"
}
shred_file "$SECRET_TMP"
shred_file "$PENDING"
log "adopted and shredded the staged secret"


# --- the unit -----------------------------------------------------------------
if [ -f "$UNIT_SRC" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    dry "install -m 0644 -o root -g root $UNIT_SRC $UNIT_DST"
  else
    install -m 0644 -o root -g root "$UNIT_SRC" "$UNIT_DST"
  fi
else
  # The checkout has no systemd/ directory (someone copied one script out of it).
  # Writing the unit here keeps that case installable rather than half-installed.
  UNIT_BODY="$(cat <<UNIT
# SPDX-License-Identifier: AGPL-3.0-or-later
[Unit]
Description=EasyTier mesh transport (sukarfleet)
Documentation=https://github.com/EasyTier/EasyTier
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${EASYTIER_DIR}/easytier-core -c ${EASYTIER_TOML} -r ${RPC_ADDR}
Restart=always
RestartSec=2

# Hardening. Kept loose enough not to break TUN device creation / net admin.
ProtectHome=read-only
ProtectSystem=strict
ReadWritePaths=${EASYTIER_CONF_DIR} /var/log
NoNewPrivileges=no
DeviceAllow=/dev/net/tun rw

[Install]
WantedBy=multi-user.target
UNIT
)"
  if [ "$DRY_RUN" = "1" ]; then
    dry "write $UNIT_DST (0644 root, generated -- no systemd/ in this checkout)"
  else
    printf '%s\n' "$UNIT_BODY" > "$UNIT_DST"
    chmod 0644 "$UNIT_DST"
  fi
fi
log "installed $UNIT_DST"

sctl daemon-reload 2>/dev/null || true
sctl enable --now "$SERVICE" 2>/dev/null || true

# Exit 0 is not evidence. Ask the service manager whether the unit is actually
# running -- the lesson the Windows path already paid for.
MESH_RUNNING=0
if [ "$DRY_RUN" = "1" ]; then
  dry "systemctl is-active $SERVICE (a dry run answers 'not running')"
elif systemctl is-active --quiet "$SERVICE"; then
  MESH_RUNNING=1
fi

if [ "$MESH_RUNNING" = "1" ]; then
  log "$SERVICE is running"
elif [ "$DRY_RUN" != "1" ]; then
  JOURNAL="$(journalctl -u "$SERVICE" -n 5 --no-pager 2>/dev/null | tail -n 3 || true)"
  printf '[install-elevated] ERROR: %s failed to start.\n' "$SERVICE" >&2
  [ -n "$JOURNAL" ] && printf '[install-elevated]   journalctl says:\n%s\n' "$JOURNAL" >&2
  printf '[install-elevated]   If it names /dev/net/tun, this VM or container has no TUN device and the host has to pass it through.\n' >&2
  printf '[install-elevated]   The sukarfleet daemon is still running and the console still works. %s was written and is correct.\n' "$EASYTIER_TOML" >&2
  install_sudoers
  open_firewall "$MESH_IP" "$NODE_PORT" "${LISTENERS[@]}"
  log "done in $(elapsed)s"
  exit 5
fi

# --- sudoers + firewall -------------------------------------------------------
install_sudoers
open_firewall "$MESH_IP" "$NODE_PORT" "${LISTENERS[@]}"

log ""
log "Done. Nothing else on this machine needs root."
log "Next: pair from the console with a machine that is already in the fleet."
log "done in $(elapsed)s"
