// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the production lease probe and the production holder check against a lock, over and over, for
// `durationMs`, while lease-race-writer.ts hammers the same lock. Run as its own process by the test,
// so that if a lease break ever reaches it, what dies is this process -- and the test sees the
// signal in its exit status instead of losing the whole test run. Prints the verdict counts as JSON.
import { defaultLockHolderCheck, kernelLeaseProbe } from '../../src/gitlocks';

const [lock, durationMs] = [process.argv[2]!, Number(process.argv[3])];
const counts: Record<string, number> = {};
const until = Date.now() + durationMs;
let i = 0;
while (Date.now() < until) {
  const v = i % 2 === 0 ? await kernelLeaseProbe(lock) : await defaultLockHolderCheck(lock);
  counts[v] = (counts[v] ?? 0) + 1;
  i++;
}
console.log(JSON.stringify(counts));
