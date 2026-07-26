// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _authMessageForRepo, handleGitRequest } from '../src/gitserve';
import { defaultConfig } from '../src/config';
import { b64encode, run } from '../src/util';
import type { FleetConfig } from '../src/types';

const SELF_MACHINE = 'alpha';
const PEER_MACHINE = 'beta';
const REPO_NAME = 'testrepo';

interface PeerIdentity {
  name: string;
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}

async function generatePeerIdentity(name: string): Promise<PeerIdentity> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  return { name, privateKey: kp.privateKey, publicKeyJwk };
}

async function signHeaderValue(
  repoName: string,
  identity: PeerIdentity,
  tsMs: number = Date.now(),
): Promise<string> {
  const tsMsRaw = String(tsMs);
  const message = _authMessageForRepo(repoName, tsMsRaw, identity.name);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.privateKey,
    new TextEncoder().encode(message),
  );
  const sigB64 = b64encode(new Uint8Array(sig));
  return `${identity.name};${tsMsRaw};${sigB64}`;
}

function extraHeaderArg(headerValue: string): string {
  return `http.extraHeader=x-fleet-auth: ${headerValue}`;
}

let workDir: string;
let repoPath: string;
let peer: PeerIdentity;
let cfg: FleetConfig;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sukarfleet-gitserve-'));
  repoPath = join(workDir, 'repo');

  const initRes = await run(['git', 'init', '--quiet', repoPath]);
  expect(initRes.code).toBe(0);
  await run(['git', 'config', 'user.email', 'test@example.com'], { cwd: repoPath });
  await run(['git', 'config', 'user.name', 'Test'], { cwd: repoPath });
  await Bun.write(join(repoPath, 'file.txt'), 'hello sukarfleet\n');
  await run(['git', 'add', '.'], { cwd: repoPath });
  const commitRes = await run(['git', 'commit', '--quiet', '-m', 'init'], { cwd: repoPath });
  expect(commitRes.code).toBe(0);

  peer = await generatePeerIdentity(PEER_MACHINE);

  cfg = {
    ...defaultConfig(SELF_MACHINE),
    peers: [{ name: peer.name, meshIp: '203.0.113.2', nodePort: 7710, publicKeyJwk: peer.publicKeyJwk }],
    repos: [{ name: REPO_NAME, path: repoPath }],
  };

  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => handleGitRequest(req, cfg, new URL(req.url).pathname),
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  server.stop(true);
  await rm(workDir, { recursive: true, force: true });
});

describe('gitserve auth', () => {
  test('unauthenticated info/refs request is rejected', async () => {
    const res = await fetch(`${baseUrl}/git/${REPO_NAME}/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(401);
  });

  test('bad signature is rejected', async () => {
    const headerValue = await signHeaderValue(REPO_NAME, peer);
    const tampered = headerValue.slice(0, -4) + 'XXXX';
    const res = await fetch(`${baseUrl}/git/${REPO_NAME}/info/refs?service=git-upload-pack`, {
      headers: { 'x-fleet-auth': tampered },
    });
    expect(res.status).toBe(401);
  });

  test('malformed header is rejected', async () => {
    const res = await fetch(`${baseUrl}/git/${REPO_NAME}/info/refs?service=git-upload-pack`, {
      headers: { 'x-fleet-auth': 'not-a-valid-header' },
    });
    expect(res.status).toBe(401);
  });

  test('expired timestamp is rejected', async () => {
    const headerValue = await signHeaderValue(REPO_NAME, peer, Date.now() - 10 * 60 * 1000);
    const res = await fetch(`${baseUrl}/git/${REPO_NAME}/info/refs?service=git-upload-pack`, {
      headers: { 'x-fleet-auth': headerValue },
    });
    expect(res.status).toBe(401);
  });

  test('unknown machine is rejected', async () => {
    const stranger = await generatePeerIdentity('unknown-machine');
    const headerValue = await signHeaderValue(REPO_NAME, stranger);
    const res = await fetch(`${baseUrl}/git/${REPO_NAME}/info/refs?service=git-upload-pack`, {
      headers: { 'x-fleet-auth': headerValue },
    });
    expect(res.status).toBe(401);
  });

  test('authenticated info/refs request succeeds and advertises upload-pack', async () => {
    const headerValue = await signHeaderValue(REPO_NAME, peer);
    const res = await fetch(`${baseUrl}/git/${REPO_NAME}/info/refs?service=git-upload-pack`, {
      headers: { 'x-fleet-auth': headerValue },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-git-upload-pack-advertisement');
    const text = await res.text();
    expect(text).toContain('# service=git-upload-pack');
  });

  test('repo name not in config is 404 even with a validly signed header', async () => {
    const headerValue = await signHeaderValue('not-configured', peer);
    const res = await fetch(`${baseUrl}/git/not-configured/info/refs?service=git-upload-pack`, {
      headers: { 'x-fleet-auth': headerValue },
    });
    expect(res.status).toBe(404);
  });
});

describe('gitserve receive-pack refusal', () => {
  test('info/refs with service=git-receive-pack is refused', async () => {
    const headerValue = await signHeaderValue(REPO_NAME, peer);
    const res = await fetch(`${baseUrl}/git/${REPO_NAME}/info/refs?service=git-receive-pack`, {
      headers: { 'x-fleet-auth': headerValue },
    });
    expect(res.status).toBe(403);
  });

  test('POST to git-receive-pack path is refused regardless of auth', async () => {
    const res = await fetch(`${baseUrl}/git/${REPO_NAME}/git-receive-pack`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  test('a real git push is refused', async () => {
    const headerValue = await signHeaderValue(REPO_NAME, peer);
    const clientDir = join(workDir, 'pusher');
    const cloneRes = await run([
      'git',
      '-c',
      extraHeaderArg(headerValue),
      'clone',
      '--quiet',
      `${baseUrl}/git/${REPO_NAME}`,
      clientDir,
    ]);
    expect(cloneRes.code).toBe(0);
    await Bun.write(join(clientDir, 'new-file.txt'), 'pushed content\n');
    await run(['git', 'add', '.'], { cwd: clientDir });
    await run(['git', 'config', 'user.email', 'pusher@example.com'], { cwd: clientDir });
    await run(['git', 'config', 'user.name', 'Pusher'], { cwd: clientDir });
    await run(['git', 'commit', '--quiet', '-m', 'push attempt'], { cwd: clientDir });

    const pushRes = await run([
      'git',
      '-c',
      extraHeaderArg(headerValue),
      'push',
      `${baseUrl}/git/${REPO_NAME}`,
      'HEAD:refs/heads/pushed',
    ], { cwd: clientDir });
    expect(pushRes.code).not.toBe(0);
  });
});

describe('gitserve path traversal', () => {
  test('.. path segment is not routed to the git handler', async () => {
    const res = await fetch(`${baseUrl}/git/../info/refs?service=git-upload-pack`);
    expect(res.status).toBe(404);
  });

  test('percent-encoded .. path segment is not routed to the git handler', async () => {
    const res = await fetch(`${baseUrl}/git/%2e%2e/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(404);
  });

  test('percent-encoded slash inside repo name segment does not match a configured repo', async () => {
    // The raw path segment (with a literal, undecoded "%2f") is what gitserve treats as
    // the repo name. Sign for that exact segment so the auth check passes and the test
    // isolates repo-resolution's exact-match defense, not the auth layer.
    const weirdRepoName = `${REPO_NAME}%2f..%2fescape`;
    const headerValue = await signHeaderValue(weirdRepoName, peer);
    const res = await fetch(`${baseUrl}/git/${weirdRepoName}/info/refs?service=git-upload-pack`, {
      headers: { 'x-fleet-auth': headerValue },
    });
    expect(res.status).toBe(404);
  });
});

describe('gitserve end-to-end clone', () => {
  test('unauthenticated git clone fails', async () => {
    const destDir = join(workDir, 'clone-unauth');
    const res = await run(['git', 'clone', '--quiet', `${baseUrl}/git/${REPO_NAME}`, destDir]);
    expect(res.code).not.toBe(0);
  });

  test('authenticated git clone succeeds and content matches', async () => {
    const headerValue = await signHeaderValue(REPO_NAME, peer);
    const destDir = join(workDir, 'clone-auth');
    const res = await run([
      'git',
      '-c',
      extraHeaderArg(headerValue),
      'clone',
      '--quiet',
      `${baseUrl}/git/${REPO_NAME}`,
      destDir,
    ]);
    expect(res.code).toBe(0);

    const cloned = Bun.file(join(destDir, 'file.txt'));
    expect(await cloned.exists()).toBe(true);
    expect(await cloned.text()).toBe('hello sukarfleet\n');

    const logRes = await run(['git', 'log', '--oneline'], { cwd: destDir });
    expect(logRes.stdout).toContain('init');
  });
});
