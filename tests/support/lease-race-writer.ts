// SPDX-License-Identifier: AGPL-3.0-or-later
// The other side of the lease race (see the lease race test in gitlocks.test.ts): opens the lock for
// writing over and over, non-blocking, for `durationMs`. Every such open while somebody holds a lease
// on the file is a lease break, and the kernel sends that somebody SIGIO.
import { closeSync, constants, openSync } from 'node:fs';

const [lock, durationMs] = [process.argv[2]!, Number(process.argv[3])];
const until = Date.now() + durationMs;
console.log('ready');
while (Date.now() < until) {
  try {
    closeSync(openSync(lock, constants.O_RDWR | constants.O_NONBLOCK));
  } catch {
    // EWOULDBLOCK while a lease is held: the break was still delivered
  }
}
