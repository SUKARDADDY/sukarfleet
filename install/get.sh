#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# sukarfleet stage 0: the `curl | sh` entry point.
#
#   curl -fsSL https://raw.githubusercontent.com/SUKARDADDY/sukarfleet/v0.1.0/install/get.sh | sh
#
# This file has NO install logic, on purpose. It clones the repository at a
# release tag, prints the commit it checked out, and hands over to
# install/quickstart.sh from that checkout. The thing that installs you is a
# repository at a tag, which you can read first:
#
#   git clone --branch v0.1.0 <repo-url> && less sukarfleet/install/quickstart.sh
#
# Nothing here needs root, and neither does the stage it hands to. There is
# exactly one root step in the whole install and quickstart.sh prints it for you
# to read and run yourself. Never `sudo curl ... | sh`.
#
# POSIX sh, not bash: this is the one file that is piped into whatever /bin/sh
# is, so it uses `set -eu` (there is no `pipefail` in POSIX sh), no arrays, and
# no [[ ]].
set -eu

# --- test seams --------------------------------------------------------------
# These three overrides exist so S8 can drive the real flow against a private
# repository or a local mirror before the public tag is cut, and so a maintainer
# can test a branch without publishing one. They are NOT a supported way to
# install: a stranger runs the one command and gets the pinned tag.
#
#   SUKARFLEET_REF           git ref to check out. Baked in at release time.
#   SUKARFLEET_GIT_URL       repository to clone. Any git URL, including a local
#                            path or a file:// mirror.
#   SUKARFLEET_RELEASE_BASE  where quickstart.sh fetches release assets (the
#                            tray binary) from. Exported for the next stage.
#   SUKARFLEET_DRY_RUN=1     walk the whole control flow, print every write,
#                            download and exec as `[dry-run] ...`, change
#                            nothing on disk.
REF="${SUKARFLEET_REF:-v0.1.0}"
GIT_URL="${SUKARFLEET_GIT_URL:-https://github.com/SUKARDADDY/sukarfleet.git}"
RELEASE_BASE="${SUKARFLEET_RELEASE_BASE:-https://github.com/SUKARDADDY/sukarfleet/releases/download/$REF}"
DRY_RUN="${SUKARFLEET_DRY_RUN:-0}"

APP_DIR="${SUKARFLEET_APP_DIR:-$HOME/.local/share/sukarfleet/app}"

log()  { printf '[get] %s\n' "$*"; }
warn() { printf '[get] WARNING: %s\n' "$*" >&2; }
die()  { printf '[get] ERROR: %s\n' "$1" >&2; exit "${2:-2}"; }
dry()  { printf '[get] [dry-run] %s\n' "$*"; }

# --- 1. never as root ---------------------------------------------------------
# The install writes to one user's home and one user's systemd session. Run as
# root it would install a fleet node for root, which is not the machine anybody
# wants synced, and it would do it from a script fetched over the network.
if [ "$(id -u)" = "0" ]; then
  printf '[get] ERROR: %s\n' "do not run this as root -- never sudo curl | sh." >&2
  printf '[get]        %s\n' "Run it as the user whose machine this is. Nothing in this stage needs root," >&2
  printf '[get]        %s\n' "and the one root step is printed at the end for you to read before you run it." >&2
  exit 2
fi

# --- 2. preconditions ---------------------------------------------------------
for c in curl git; do
  command -v "$c" >/dev/null 2>&1 || \
    die "$c is not installed. Run: sudo apt-get install -y git curl"
done

# --- 3. the checkout ----------------------------------------------------------
# Three cases: no directory (clone), our repository (fetch + checkout, which is
# what makes an upgrade a re-run of this command with a newer tag), and somebody
# else's directory (refuse by name; never delete what we did not create).
if [ -e "$APP_DIR" ]; then
  if [ ! -d "$APP_DIR/.git" ]; then
    die "$APP_DIR exists and is not a git repository. Move it aside, then run this again. Nothing was written." 3
  fi
  if ! git -C "$APP_DIR" cat-file -e HEAD:install/quickstart.sh 2>/dev/null; then
    die "$APP_DIR is a git repository, but not a sukarfleet one (no install/quickstart.sh). Move it aside, then run this again. Nothing was written." 3
  fi
  log "updating the checkout at $APP_DIR to $REF"
  if [ "$DRY_RUN" = "1" ]; then
    dry "git -C $APP_DIR fetch --tags --force $GIT_URL $REF"
    dry "git -C $APP_DIR checkout --force FETCH_HEAD"
  else
    git -C "$APP_DIR" fetch --tags --force "$GIT_URL" "$REF" >/dev/null 2>&1 || \
      die "could not fetch $REF from $GIT_URL. Check the network and the tag name. The existing checkout was left alone." 5
    git -C "$APP_DIR" -c advice.detachedHead=false checkout --force FETCH_HEAD >/dev/null 2>&1 || \
      die "fetched $REF but could not check it out in $APP_DIR. Nothing else was written." 5
  fi
else
  log "cloning $REF into $APP_DIR"
  if [ "$DRY_RUN" = "1" ]; then
    dry "mkdir -p $(dirname "$APP_DIR")"
    dry "git clone --depth 1 --branch $REF $GIT_URL $APP_DIR"
  else
    mkdir -p "$(dirname "$APP_DIR")"
    # advice.detachedHead off: a tag checkout is detached by design and the
    # fifteen-line lecture about it is not what a `curl | sh` should print.
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$REF" "$GIT_URL" "$APP_DIR" || \
      die "could not clone $REF from $GIT_URL. Check the network and the tag name. Nothing was written." 5
  fi
fi

# --- 4. say what you are about to run -----------------------------------------
# The commit, not just the tag: a tag can be moved, a commit cannot. This is the
# line to quote in a bug report.
if [ "$DRY_RUN" = "1" ]; then
  log "[dry-run] would report the checked-out commit here"
else
  COMMIT="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  log "checked out $REF at $COMMIT"
fi

# --- 5. hand over -------------------------------------------------------------
QUICKSTART="$APP_DIR/install/quickstart.sh"
if [ "$DRY_RUN" = "1" ]; then
  dry "exec $QUICKSTART $*"
  log "[dry-run] nothing was installed."
  exit 0
fi
[ -f "$QUICKSTART" ] || die "$QUICKSTART is missing from the checkout. Nothing was installed." 3
chmod +x "$QUICKSTART" 2>/dev/null || true

# The next stage fetches the tray binary from the same release the checkout came
# from, so it inherits the seam rather than recomputing the default.
SUKARFLEET_RELEASE_BASE="$RELEASE_BASE"
export SUKARFLEET_RELEASE_BASE

log "handing over to install/quickstart.sh"
exec "$QUICKSTART" "$@"
