#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Builds the Linux release binary the way it is published: --locked, from the crate directory,
# and with every absolute build path rewritten. A plain `cargo build` embeds the builder's home
# directory and checkout path in panic and debug strings, hundreds of times, and those would
# ship in a public release asset. --remap-path-prefix rewrites them; it goes through `--config`
# rather than RUSTFLAGS because RUSTFLAGS would replace the rustflags in .cargo/config.toml
# instead of adding to them, while --config arrays are joined.
set -eu
# -P: the physical directory. Cargo and Tauri embed the real path, so a symlink from a neutral
# place to a checkout under $HOME must not get past the check below.
here=$(CDPATH='' cd -P -- "$(dirname -- "$0")/../src-tauri" && pwd -P)
home=$(CDPATH='' cd -P -- "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")
# RUSTFLAGS and CARGO_ENCODED_RUSTFLAGS outrank every config file and every --config value, so
# either one, however harmless it looks, would silently drop the remap below. Set counts, not
# just non-empty: cargo takes an empty value as an override too.
if [ "${RUSTFLAGS+set}" = set ] || [ "${CARGO_ENCODED_RUSTFLAGS+set}" = set ]; then
  echo "build-release: unset RUSTFLAGS and CARGO_ENCODED_RUSTFLAGS; they replace the path remap this build needs" >&2
  exit 2
fi
# Tauri's code generation embeds the crate's absolute directory as a plain string, which no path
# remap reaches. Building from a checkout under a home directory would publish that home
# directory, so a release build is refused there. Clone to a neutral place such as
# /tmp/sukarfleet-release and build from that.
case "$here/" in
  "$home"/*|"$HOME"/*) echo "build-release: $here is inside \$HOME; clone the release tag to a neutral path such as /tmp/sukarfleet-release and build there" >&2; exit 2 ;;
esac
cargo_home=${CARGO_HOME:-$HOME/.cargo}
triple=$(rustc -vV | sed -n 's/^host: //p')
# A TOML basic string: backslash and double quote escaped, so any path, apostrophes included,
# arrives as itself.
toml_str() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
remap_home=$(toml_str "--remap-path-prefix=$cargo_home=/cargo")
remap_here=$(toml_str "--remap-path-prefix=$here=/build")
cd "$here"
exec cargo build --release --locked \
  --config "target.$triple.rustflags=[$remap_home, $remap_here]" \
  "$@"
