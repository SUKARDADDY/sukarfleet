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

// Never scanned: the live capture is real fleet data by design and is gitignored, and target/
// and gen/ are build output -- cargo's and Tauri's codegen -- which is regenerated rather than
// committed, and can be gigabytes of it.
// These match on the BARE DIRECTORY NAME at any depth, not on a path: a future source directory
// named target/ or gen/ anywhere in the tree would go unscanned, so name one something else.
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'target', 'gen']);
const EXCLUDED_FILES = new Set(['live-capture.json', 'no-personal-data.test.ts']);
// .svg because the brand marks and the tray's inline icons are text. .txt and .lock because
// licence texts and dependency lockfiles are text too, and a lockfile is exactly the sort of
// generated thing that quietly records a registry URL or a local path.
const SCANNED_EXTENSIONS = ['.ts', '.js', '.json', '.md', '.sh', '.toml', '.service', '.html', '.css', '.ps1', '.cmd', '.rs', '.py', '.svg', '.txt', '.lock'];

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
  // The one exception is the project's own repository address. `SUKARDADDY` is
  // the GitHub organisation this repo is published under, so it appears in the
  // one install command, in `get.sh`'s default clone URL, and in the docs that
  // quote them. That is the project's address, not a person's -- the same
  // reasoning that puts ipify.org and icanhazip.com in the hostname allowlist
  // below. Anywhere else, including a home directory or a config value, it is
  // still a username and still caught.
  // The exception is spelled as a WHOLE host, not as a suffix. `\b` before
  // `github` spared anything ending in it, so `not-github.com/sukardaddy` and
  // `x-github.com/sukardaddy` -- a host somebody else can register, which is
  // exactly where the username still has to be caught -- went through the hole
  // the exception opened. The inner lookbehind refuses a leading word
  // character, dot or dash, and the two hosts this project actually uses,
  // `github.com` and `raw.githubusercontent.com`, are named in full.
  {
    pattern: /(?<!(?<![\w.-])(?:raw\.)?github(?:usercontent)?\.com\/)\bsukardaddy\b/i,
    what: 'a real username',
  },
  // .local and the reserved example domains are synthetic by definition; anything else that looks
  // like an address is assumed to belong to a person. The second lookahead spares exactly one
  // shape and no more: Tauri's bundler mandates icons named `128x128@2x.png`, which reads as an
  // address and is not one. It fires only when the part before the @ is a size token and the part
  // after it is a scale token plus an image suffix, so an address parked in a filename stem --
  // `someone@their-host.png`, `/avatars/someone@their-host.jpeg` -- is still caught. The trailing
  // lookahead keeps `128x128@2x.png.somebody.com` from hiding behind the prefix.
  {
    pattern:
      /[a-zA-Z0-9._%+-]+@(?![a-zA-Z0-9.-]*\b(?:example\.(?:com|org|net)|\.?(?:test|invalid|localhost|local))\b)(?!(?<=\b\d+x\d+@)\d+x\.(?:png|jpe?g|gif|svg|webp|ico|icns|bmp|tiff?)(?![a-zA-Z0-9.-]))[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
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

// The scan above proves the tree is clean today. This block proves the patterns still bite: a rule
// narrowed to spare one false positive is exactly the kind of edit that quietly stops catching the
// real thing, and nothing in the scan would notice, because a pattern that matches nothing passes.
// Every address, host and username below is invented. This file is in EXCLUDED_FILES, so the
// examples cannot trip the scan itself.
const PATTERN_CASES: { what: string; caught: string[]; spared: string[] }[] = [
  { what: 'a real mesh address', caught: ['peer 10.44.12.7 is up'], spared: ['10.44.12', '10.8.0.1'] },
  { what: 'a private 10.x address', caught: ['10.8.0.1'], spared: ['10.44.12.7'] },
  { what: 'a private 192.168.x address', caught: ['192.168.1.5'], spared: ['192.0.2.5'] },
  { what: "a real user's home directory", caught: ['/home/jdoe/notes'], spared: ['/home/', '$HOME/.config'] },
  { what: "a real macOS user's home directory", caught: ['/Users/jdoe/Library'], spared: ['/usr/share/doc'] },
  { what: "a real machine's mount point", caught: ['/Dev_Drive/repos'], spared: ['/Dev_Drive_backup', '/dev/null'] },
  { what: 'a real hostname', caught: ['host=pop-os'], spared: ['pop-oscillator'] },
  { what: 'a real machine name', caught: ['built on sukarlaptop'], spared: ['built on a laptop'] },
  { what: 'a real machine name', caught: ['GODFATHER', 'godfather'], spared: ['godmother'] },
  {
    what: 'a real username',
    caught: [
      'sukardaddy',
      '/home/sukardaddy/notes',
      'user=SUKARDADDY',
      'gitlab.com/SUKARDADDY/x',
      // A host that merely ENDS in github.com belongs to whoever registered it.
      'https://not-github.com/sukardaddy',
      'https://x-github.com/sukardaddy',
      'https://evil.github.com.example.org/sukardaddy',
    ],
    spared: [
      'sukarfleet',
      'https://github.com/SUKARDADDY/sukarfleet.git',
      'https://raw.githubusercontent.com/SUKARDADDY/sukarfleet/v0.1.0/install/get.sh',
    ],
  },
  {
    what: 'a real email address',
    // The icon-filename exception is the reason this row exists. An address hidden as a filename
    // stem is still an address, and the suffix must not be a place to hide one.
    caught: [
      'jane.doe@fictional-mail.com',
      'jane.doe@fictional-mail.com.png',
      '/avatars/someone@fictional-host.jpeg',
      'someone@fictional-host.png.evil-domain.com',
      'a@b.svg',
    ],
    spared: ['icons/128x128@2x.png', '32x32@2x.png', 'someone@example.com', 'nobody@fixture.local'],
  },
  {
    what: 'a real tunnel hostname',
    caught: ['https://red-fox-1.trycloudflare.com'],
    spared: ['https://cloudflare.com'],
  },
  {
    what: 'a real hostname on a registrable domain',
    caught: ["'https://console.some-host.dev'"],
    spared: ["'https://api.ipify.org'", "'https://fleet.example.com'", 'https://console.some-host.dev'],
  },
];

describe('the forbidden patterns catch what they claim to', () => {
  test('every pattern brings its own examples, in order', () => {
    expect(PATTERN_CASES.map((c) => c.what)).toEqual(FORBIDDEN.map((f) => f.what));
  });

  for (const [i, { what, caught, spared }] of PATTERN_CASES.entries()) {
    test(`#${i + 1}, ${what}`, () => {
      const { pattern } = FORBIDDEN[i];
      expect(caught.filter((s) => !pattern.test(s))).toEqual([]);
      expect(spared.filter((s) => pattern.test(s))).toEqual([]);
    });
  }
});
