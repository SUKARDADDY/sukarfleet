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
here=$(CDPATH= cd -- "$(dirname -- "$0")/../src-tauri" && pwd)
# Tauri's code generation embeds the crate's absolute directory as a plain string, which no path
# remap reaches. Building from a checkout under a home directory would publish that home
# directory, so a release build is refused there. Clone to a neutral place such as
# /tmp/sukarfleet-release and build from that.
case "$here/" in
  "$HOME"/*) echo "build-release: $here is inside \$HOME; clone the release tag to a neutral path such as /tmp/sukarfleet-release and build there" >&2; exit 2 ;;
esac
cargo_home=${CARGO_HOME:-$HOME/.cargo}
triple=$(rustc -vV | sed -n 's/^host: //p')
cd "$here"
exec cargo build --release --locked \
  --config "target.$triple.rustflags=['--remap-path-prefix=$cargo_home=/cargo', '--remap-path-prefix=$here=/build']" \
  "$@"
