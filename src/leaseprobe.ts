// SPDX-License-Identifier: AGPL-3.0-or-later
// The kernel lease probe, run as its own process: `bun leaseprobe.ts <lock>`. gitlocks.ts spawns it
// and reads the answer from the exit code. It must never run inside the daemon: while this process
// holds the lease, a writer opening the file makes the kernel send SIGIO, whose default action
// terminates whoever holds the lease (see makeLeaseProbe in gitlocks.ts).

import { join } from 'node:path';
import { dlopen, FFIType, read } from 'bun:ffi';

export type LeaseVerdict = 'no-writer' | 'writer' | 'unsupported';

// Deliberately not 0 or 1: an unexpected clean exit or an uncaught exception must not read as an
// answer. The parent treats every other status, and every signal, as 'writer'.
export const LEASE_EXIT = { noWriter: 40, writer: 41, unsupported: 42 } as const;

export const LEASE_PROBE_SCRIPT = join(import.meta.dir, 'leaseprobe.ts');

// Linux's fcntl constants, from <asm-generic/fcntl.h> and <asm-generic/errno-base.h>, which x86_64,
// arm64 and riscv64 all use unchanged (checked against the x86_64 headers, which include the
// generic file verbatim). Other architectures redefine some of them, so there the probe reports
// 'unsupported' rather than pass a flag that means something else.
const LINUX_GENERIC_ARCHES = new Set(['x64', 'arm64', 'riscv64']);
const O_RDONLY = 0;
const O_NONBLOCK = 0o4000;
const O_CLOEXEC = 0o2000000;
const F_SETLEASE = 1024; // F_LINUX_SPECIFIC_BASE + 0
const F_RDLCK = 0;
const F_UNLCK = 2;
const EAGAIN = 11;
const ENOENT = 2;

interface LibcLease {
  open: (path: Uint8Array, flags: number, mode: number) => number;
  fcntl: (fd: number, cmd: number, arg: number) => number;
  close: (fd: number) => number;
  errno: () => number;
}

let libcLease: LibcLease | null | undefined;

// bun:ffi straight into libc: no compiler, no native module, no new dependency. Loaded on first use
// and never again; a libc that cannot be opened leaves the probe permanently 'unsupported'.
function loadLibcLease(): LibcLease | null {
  if (libcLease !== undefined) return libcLease;
  libcLease = null;
  if (process.platform !== 'linux' || !LINUX_GENERIC_ARCHES.has(process.arch)) return null;
  {
    for (const name of ['libc.so.6', 'libc.so']) {
      try {
        const lib = dlopen(name, {
          open: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
          fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
          close: { args: [FFIType.i32], returns: FFIType.i32 },
          __errno_location: { args: [], returns: FFIType.ptr },
        });
        libcLease = {
          open: (path, flags, mode) => lib.symbols.open(path, flags, mode),
          fcntl: (fd, cmd, arg) => lib.symbols.fcntl(fd, cmd, arg),
          close: (fd) => lib.symbols.close(fd),
          errno: () => {
            const p = lib.symbols.__errno_location();
            return p === null ? -1 : read.i32(p, 0);
          },
        };
        return libcLease;
      } catch {
        // try the next name
      }
    }
  }
  return null;
}

// Every answer it can get wrong lands on the safe side: a misread EAGAIN is 'unsupported' (the
// fail-closed fallback), and any other misread errno is 'unsupported' too. Only a granted lease is
// 'no-writer'.
export function probeLeaseInThisProcess(lockPath: string): LeaseVerdict {
  const libc = loadLibcLease();
  if (libc === null) return 'unsupported';
  const fd = libc.open(Buffer.from(`${lockPath}\0`), O_RDONLY | O_NONBLOCK | O_CLOEXEC, 0);
  if (fd < 0) {
    const e = libc.errno();
    // EAGAIN on open: somebody holds a lease of their own on it. ENOENT: released meanwhile, and
    // there is nothing left to reap. Neither is a licence to remove anything.
    return e === EAGAIN || e === ENOENT ? 'writer' : 'unsupported';
  }
  try {
    if (libc.fcntl(fd, F_SETLEASE, F_RDLCK) === 0) {
      libc.fcntl(fd, F_SETLEASE, F_UNLCK);
      return 'no-writer';
    }
    return libc.errno() === EAGAIN ? 'writer' : 'unsupported';
  } finally {
    libc.close(fd);
  }
}

if (import.meta.main) {
  const verdict = probeLeaseInThisProcess(process.argv[2] ?? '');
  process.exit(verdict === 'no-writer' ? LEASE_EXIT.noWriter : verdict === 'unsupported' ? LEASE_EXIT.unsupported : LEASE_EXIT.writer);
}
