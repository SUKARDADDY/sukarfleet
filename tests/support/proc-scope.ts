// SPDX-License-Identifier: AGPL-3.0-or-later
// The lock holder check looks at every process on the machine, on purpose (see gitlocks.ts). A test
// that wants a deterministic verdict cannot have a git some unrelated program happens to run on the
// same machine decide it, so it scopes the check to its own process tree -- the processes the test
// spawned, and theirs -- and the logic under test is otherwise the production one.

import { readFile } from 'node:fs/promises';
import { makeLockHolderCheck, type LockHolderCheck } from '../../src/gitlocks';

async function parentOf(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // The command name is parenthesised and may itself contain spaces or parentheses.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[1]);
  } catch {
    return null;
  }
}

export async function isInTestTree(pid: number): Promise<boolean> {
  let cur: number | null = pid;
  for (let i = 0; i < 64 && cur !== null && cur > 1; i++) {
    if (cur === process.pid) return true;
    cur = await parentOf(cur);
  }
  return false;
}

export const testScopedLockHolderCheck: LockHolderCheck = makeLockHolderCheck({ includePid: isInTestTree });
