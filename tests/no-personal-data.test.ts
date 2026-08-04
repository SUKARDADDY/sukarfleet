// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Launch checklist: "The public repo contains no personal data -- no machine names, mesh
// addresses, hostnames or network layout. Checked by grep, not by memory."
//
// This is the grep. It runs in CI so it cannot be forgotten at the moment it matters most, which
// is the day the repo flips public.
//
// It has already earned its place: the first run caught a real machine name in eight test files,
// real mesh addresses in two, a hostname used as a fixture machine name throughout, and -- the one
// that would have survived any amount of eyeballing -- an absolute path naming the author's mount
// point inside a source comment in syncer.ts.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

// Never scanned: the live capture is real fleet data by design and is gitignored.
const EXCLUDED_DIRS = new Set(['node_modules', '.git']);
const EXCLUDED_FILES = new Set(['live-capture.json', 'no-personal-data.test.ts']);
const SCANNED_EXTENSIONS = ['.ts', '.js', '.json', '.md', '.sh', '.toml', '.service', '.html', '.css'];

// Patterns describing SHAPES of private data, not one person's specifics -- so this keeps working
// for the next contributor, whose machine is not named the same thing.
const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  { pattern: /\b10\.44\.\d{1,3}\.\d{1,3}\b/, what: 'a real mesh address' },
  // RFC1918 ranges outside the documentation examples. 192.0.2.x (TEST-NET-1), 198.51.100.x and
  // 203.0.113.x are reserved for documentation and are what fixtures should use.
  { pattern: /\b10\.(?!44\.)\d{1,3}\.\d{1,3}\.\d{1,3}\b/, what: 'a private 10.x address' },
  { pattern: /\b192\.168\.\d{1,3}\.\d{1,3}\b/, what: 'a private 192.168.x address' },
  { pattern: /\/home\/[a-z][a-z0-9_-]*\//, what: "a real user's home directory" },
  { pattern: /\/Users\/[A-Za-z][A-Za-z0-9_-]*\//, what: "a real macOS user's home directory" },
  { pattern: /\/Dev_Drive\b/, what: "a real machine's mount point" },
  { pattern: /\bpop-os\b/i, what: 'a real hostname' },
  { pattern: /\bsukarlaptop\b/i, what: 'a real machine name' },
  { pattern: /\bGODFATHER\b/i, what: 'a real machine name' },
  { pattern: /\bsukardaddy\b/i, what: 'a real username' },
  // .local and the reserved example domains are synthetic by definition; anything else that looks
  // like an address is assumed to belong to a person.
  {
    pattern:
      /[a-zA-Z0-9._%+-]+@(?![a-zA-Z0-9.-]*\b(?:example\.(?:com|org|net)|\.?(?:test|invalid|localhost|local))\b)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    what: 'a real email address',
  },
  { pattern: /\btrycloudflare\.com\b|\bcfargotunnel\.com\b/, what: 'a real tunnel hostname' },
  // A quoted hostname on a registrable domain. Fixtures belong on the reserved example domains;
  // anything else is somebody's real infrastructure, and a custom-domain tunnel host matches none
  // of the patterns above. The allowlist is the third-party services the daemon genuinely calls --
  // it is deliberately short, so a new real domain has to be argued for rather than absorbed.
  {
    pattern:
      /['"`](?:https?:\/\/)?(?![^'"`]*(?:example\.(?:com|org|net)|ipify\.org|icanhazip\.com)['"`])(?:[a-z0-9][a-z0-9-]*\.)+(?:com|org|net|io|dev|app|cloud|me|info|biz|il|uk|de|us)['"`]/i,
    what: 'a real hostname on a registrable domain',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (EXCLUDED_FILES.has(entry)) continue;
    if (!SCANNED_EXTENSIONS.some((e) => entry.endsWith(e))) continue;
    out.push(full);
  }
  return out;
}

const files = walk(REPO_ROOT);

describe('the repository carries no personal data', () => {
  test('there is something to scan (a silent empty scan would pass forever)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const { pattern, what } of FORBIDDEN) {
    test(`no ${what}`, () => {
      const hits: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const [i, line] of text.split('\n').entries()) {
          const m = pattern.exec(line);
          if (m) hits.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${m[0]}`);
        }
      }
      expect(hits).toEqual([]);
    });
  }
});
