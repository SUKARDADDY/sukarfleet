#!/usr/bin/env bash
# fleet-guard: prove both machines are synced and working, and repair them when they are not.
#
# Run after EVERY extraction phase. The extraction touches the daemon that keeps this fleet's
# memory, dotfiles and workspace in sync, so "the tests pass" is not evidence that the fleet is
# still healthy -- that has to be measured on both machines, live.
#
#   fleet-guard.sh            check both machines, exit 0 = healthy
#   fleet-guard.sh --repair   check, and fix what is fixable, then re-check
#   fleet-guard.sh --quick    skip the sync-propagation probe (~2 min faster)
#
# Repair covers the one failure mode this fleet has actually suffered: a daemon killed mid-git
# leaves zero-byte objects and refs pointing at them, which makes every later sync abort with
# "fatal: bad object HEAD". Working trees are never touched.
set -uo pipefail

PEER_IP="${FLEET_PEER_IP:-}"
PEER_NAME="${FLEET_PEER_NAME:-}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8)
REPO="${FLEET_REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)}"
MARKER="${FLEET_MARKER:-}"

# Peer identity and the propagation marker come from the LIVE config, not from a hardcoded
# default: this script has to work on a fleet whose machines the author has never heard of.
if [ -z "$PEER_IP" ] || [ -z "$PEER_NAME" ]; then
  _cfg="$HOME/.config/sukarfleet/config.json"
  if command -v jq >/dev/null 2>&1 && [ -f "$_cfg" ]; then
    [ -z "$PEER_NAME" ] && PEER_NAME="$(jq -r '.peers[0].name // empty' "$_cfg" 2>/dev/null || true)"
    [ -z "$PEER_IP" ]   && PEER_IP="$(jq -r '.peers[0].meshIp // empty' "$_cfg" 2>/dev/null || true)"
  fi
fi
if [ -z "$PEER_IP" ] || [ -z "$PEER_NAME" ]; then
  echo "fleet-guard: no peer configured. Pair a machine first, or set FLEET_PEER_IP/FLEET_PEER_NAME." >&2
  exit 2
fi
if [ -z "$MARKER" ]; then
  _first_repo="$(jq -r '.repos[0].path // empty' "$HOME/.config/sukarfleet/config.json" 2>/dev/null || true)"
  MARKER="${_first_repo:-$HOME}/.fleet-guard-probe"
fi

# The peer's checkout path: machines may lay out their checkouts differently, so ask the peer's
# own service manager where its daemon runs from rather than assuming our layout mirrors theirs.
# FLEET_PEER_REPO overrides; the local path is only a last resort for peers with no unit installed.
PEER_REPO="${FLEET_PEER_REPO:-}"
if [ -z "$PEER_REPO" ]; then
  PEER_REPO="$(ssh "${SSH_OPTS[@]}" "$PEER_IP" \
    'systemctl --user show sukarfleet.service -p WorkingDirectory --value' 2>/dev/null | tr -d '[:space:]')"
fi
[ -n "$PEER_REPO" ] || PEER_REPO="$REPO"

DO_REPAIR=0; QUICK=0
for a in "$@"; do
  case "$a" in
    --repair) DO_REPAIR=1 ;;
    --quick)  QUICK=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL+1)); }
note() { printf '        %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Repos the daemon syncs, read from the live config rather than hardcoded -- a repo added later
# must be covered without editing this script.
repo_paths() {
  jq -r '.repos[].path' ~/.config/sukarfleet/config.json 2>/dev/null
}

# --- 1. daemons -------------------------------------------------------------
head_ "Daemons"
if systemctl --user is-active --quiet sukarfleet; then ok "local daemon active"; else bad "local daemon is not active"; fi
if ssh "${SSH_OPTS[@]}" "$PEER_IP" 'systemctl --user is-active --quiet sukarfleet' 2>/dev/null; then
  ok "$PEER_NAME daemon active"
else
  bad "$PEER_NAME daemon is not active (or unreachable over the mesh)"
fi

# --- 2. git integrity -------------------------------------------------------
# Checked BEFORE alarms: a corrupt object store is the root cause that produces the alarms, and it
# is the only failure here that silently eats data if it is left alone.
head_ "Repository integrity"
check_repo() {
  local path="$1" label="$2"
  local empties
  empties=$(find "$path/.git/objects" -type f -size 0 2>/dev/null | wc -l)
  if [ "$empties" -gt 0 ]; then
    bad "$label: $empties zero-byte object(s) -- corrupt"
    return 1
  fi
  if git -C "$path" fsck --no-dangling --no-progress >/dev/null 2>&1; then
    ok "$label: fsck clean"
    return 0
  fi
  bad "$label: fsck reports problems"
  return 1
}

repair_repo() {
  local path="$1" label="$2"
  note "repairing $label ..."
  cp -a "$path/.git" "/tmp/fleet-guard-backup-$(basename "$path")-$(date +%H%M%S)" 2>/dev/null
  find "$path/.git/objects" -type f -size 0 -delete 2>/dev/null
  # Refs pointing at the now-deleted objects block every fetch; drop the derived/remote ones (all
  # recoverable from the remote) and never a local branch tip.
  for r in refs/remotes/origin/HEAD refs/remotes/origin/main refs/sukarfleet/derived-main; do
    rm -f "$path/.git/$r" 2>/dev/null
  done
  git -C "$path" fetch origin '+refs/heads/*:refs/remotes/origin/*' >/dev/null 2>&1
  if git -C "$path" fsck --no-dangling --no-progress >/dev/null 2>&1; then
    note "$label repaired (backup in /tmp)"
    return 0
  fi
  note "$label STILL BROKEN after repair -- needs a human"
  return 1
}

LOCAL_BROKEN=()
while IFS= read -r p; do
  [ -d "$p/.git" ] || continue
  check_repo "$p" "local $(basename "$p")" || LOCAL_BROKEN+=("$p")
done < <(repo_paths)

if [ "$DO_REPAIR" = 1 ] && [ "${#LOCAL_BROKEN[@]}" -gt 0 ]; then
  head_ "Repairing local repositories"
  # The daemon must be stopped or it races the repair and can re-corrupt what was just fixed.
  systemctl --user stop sukarfleet
  for p in "${LOCAL_BROKEN[@]}"; do repair_repo "$p" "$(basename "$p")"; done
  systemctl --user start sukarfleet
  sleep 10
  FAIL=0; PASS=0
  head_ "Re-checking after repair"
  while IFS= read -r p; do
    [ -d "$p/.git" ] || continue
    check_repo "$p" "local $(basename "$p")"
  done < <(repo_paths)
fi

ssh "${SSH_OPTS[@]}" "$PEER_IP" '
  for p in $(jq -r ".repos[].path" ~/.config/sukarfleet/config.json 2>/dev/null); do
    [ -d "$p/.git" ] || continue
    n=$(find "$p/.git/objects" -type f -size 0 2>/dev/null | wc -l)
    if [ "$n" -gt 0 ]; then echo "BROKEN $(basename $p) $n";
    elif git -C "$p" fsck --no-dangling --no-progress >/dev/null 2>&1; then echo "OK $(basename $p)";
    else echo "BROKEN $(basename $p) fsck"; fi
  done' 2>/dev/null | while read -r state name extra; do
    if [ "$state" = "OK" ]; then ok "$PEER_NAME $name: fsck clean"; else bad "$PEER_NAME $name: corrupt ($extra)"; fi
  done

# --- 3. fleet health --------------------------------------------------------
head_ "Fleet health"
local_status=$(cd "$REPO" && timeout 30 bun run src/cli.ts status 2>/dev/null)
if grep -q "No active alarms" <<<"$local_status"; then
  ok "local: no alarms"
else
  bad "local: alarms raised"
  grep -A6 "^Alarms:" <<<"$local_status" | sed 's/^/        /'
fi

peer_status=$(ssh "${SSH_OPTS[@]}" "$PEER_IP" "cd '$PEER_REPO' && timeout 30 ~/.bun/bin/bun run src/cli.ts status" 2>/dev/null)
if grep -q "No active alarms" <<<"$peer_status"; then
  ok "$PEER_NAME: no alarms"
else
  bad "$PEER_NAME: alarms raised"
  grep -A6 "^Alarms:" <<<"$peer_status" | sed 's/^/        /'
fi

# --- 4. admin lane ----------------------------------------------------------
head_ "Admin lane"
if (cd "$REPO" && timeout 60 bun run src/cli.ts admin run "$PEER_NAME" --reason "fleet-guard" -- true >/dev/null 2>&1); then
  ok "local -> $PEER_NAME root command"
else
  bad "local -> $PEER_NAME admin run failed"
fi
# The reverse leg, driven from the peer. Both the peer's checkout path and this machine's name
# are derived rather than hardcoded: SELF_NAME from the live config, PEER_REPO from the peer's
# own systemd unit (resolved at the top of this script).
SELF_NAME="${FLEET_SELF_NAME:-$(jq -r '.machine // empty' "$HOME/.config/sukarfleet/config.json" 2>/dev/null || true)}"
if [ -n "$SELF_NAME" ] && ssh "${SSH_OPTS[@]}" "$PEER_IP" \
     "cd '$PEER_REPO' && timeout 60 ~/.bun/bin/bun run src/cli.ts admin run '$SELF_NAME' --reason 'fleet-guard' -- true" \
     >/dev/null 2>&1; then
  ok "$PEER_NAME -> local root command"
else
  bad "$PEER_NAME -> local admin run failed"
fi

# --- 5. the thing that actually matters: does data still move? --------------
if [ "$QUICK" = 0 ]; then
  head_ "Sync propagation"
  stamp="fleet-guard-$(date +%s)"
  echo "$stamp" > "$MARKER"
  note "marker written locally, waiting for it to reach $PEER_NAME (up to 4 min)"
  landed=0
  for _ in $(seq 1 24); do
    if ssh "${SSH_OPTS[@]}" "$PEER_IP" "grep -qs '$stamp' ~/AI_Agent/$(basename "$MARKER")" 2>/dev/null; then landed=1; break; fi
    sleep 10
  done
  rm -f "$MARKER"
  if [ "$landed" = 1 ]; then ok "a file written here appeared on $PEER_NAME"; else bad "marker never reached $PEER_NAME -- sync is not moving data"; fi
fi

# --- verdict ----------------------------------------------------------------
head_ "Verdict"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  printf '  \033[32mFLEET HEALTHY\033[0m -- safe to start the next phase\n\n'
  exit 0
fi
printf '  \033[31mFLEET DEGRADED\033[0m -- do not start the next phase\n'
[ "$DO_REPAIR" = 0 ] && printf '  try: %s --repair\n' "$0"
printf '\n'
exit 1
