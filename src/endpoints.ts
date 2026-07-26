// SPDX-License-Identifier: AGPL-3.0-or-later
// Endpoint file publish/consume + UPnP probe (lane: endpoints).
// Owns src/endpoints.ts only. Depends solely on the shared layer (types/config/util).

import { join } from 'node:path';
import type { EndpointFile, FleetConfig, MachineKey } from './types';
import { atomicWrite, b64decode, b64encode, canonicalJson, log, nowMs, readJsonFile, run } from './util';
import type { RunOptions, RunResult } from './util';

// ---------------------------------------------------------------------------
// contract-amendment: the brief references "keys.signCanonical" but no keys.ts
// exists in the shared layer and it is not part of the pinned contract (only
// types.ts/config.ts/util.ts are). Per lane rules, gaps in the shared contract
// get a private local helper rather than a dependency on an unpinned, possibly
// concurrently-written sibling file. signCanonical/verifyCanonical below are
// that local helper: plain WebCrypto ECDSA-P256/SHA-256 over canonicalJson,
// matching contract item 6 ("gossip envelopes are ECDSA-P256 signed over
// canonical JSON"). If a shared keys.ts later exists with the same-named
// exports, node.ts/gitserve.ts can reconcile; this module does not import it.
// ---------------------------------------------------------------------------

const ECDSA_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ECDSA_ALG, false, ['sign']);
}

async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ECDSA_ALG, false, ['verify']);
}

async function signCanonical(obj: unknown, privateKeyJwk: JsonWebKey): Promise<string> {
  const key = await importPrivateKey(privateKeyJwk);
  const data = new TextEncoder().encode(canonicalJson(obj));
  const sig = await crypto.subtle.sign(ECDSA_SIGN_ALG, key, data);
  return b64encode(new Uint8Array(sig));
}

async function verifyCanonical(obj: unknown, sigB64: string, publicKeyJwk: JsonWebKey): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyJwk);
    const data = new TextEncoder().encode(canonicalJson(obj));
    const sig = b64decode(sigB64);
    // b64decode's Uint8Array wraps a Node Buffer, typed Uint8Array<ArrayBufferLike>;
    // lib.dom's BufferSource wants Uint8Array<ArrayBuffer>. WebCrypto accepts any
    // ArrayBufferView at runtime regardless of the underlying buffer subtype.
    return await crypto.subtle.verify(ECDSA_SIGN_ALG, key, sig as BufferSource, data);
  } catch (err) {
    log('warn', 'endpoints: signature verification threw', { error: String(err) });
    return false;
  }
}

// --- WAN IP probe -----------------------------------------------------------

const WAN_IP_SOURCES = ['https://api.ipify.org', 'https://icanhazip.com'] as const;
const WAN_PROBE_TIMEOUT_MS = 3000;

function isValidIPv4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function fetchTrimmed(fetcher: Fetcher, url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { signal: controller.signal });
    if (!res.ok) {
      log('warn', 'probeWanIp: non-ok response', { url, status: res.status });
      return null;
    }
    return (await res.text()).trim();
  } catch (err) {
    log('warn', 'probeWanIp: request failed', { url, error: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeWanIp(fetcher: Fetcher = fetch): Promise<string | null> {
  for (const url of WAN_IP_SOURCES) {
    const text = await fetchTrimmed(fetcher, url, WAN_PROBE_TIMEOUT_MS);
    if (text === null) continue;
    if (isValidIPv4(text)) return text;
    log('warn', 'probeWanIp: response failed IPv4 shape validation', { url, text });
  }
  log('warn', 'probeWanIp: all WAN IP sources failed');
  return null;
}

// --- LAN IP detection ---------------------------------------------------------

interface IpAddrInfoEntry {
  family?: string;
  local?: string;
  scope?: string;
}

interface IpAddrInterfaceEntry {
  ifname?: string;
  operstate?: string;
  addr_info?: IpAddrInfoEntry[];
}

// Exported for direct unit testing against a captured `ip -json addr` fixture string.
export function parseLanIpFromIpAddrJson(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed as IpAddrInterfaceEntry[]) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.ifname === 'lo') continue;
    if (entry.operstate !== undefined && entry.operstate !== 'UP') continue;
    const addrs = Array.isArray(entry.addr_info) ? entry.addr_info : [];
    for (const a of addrs) {
      if (a && a.family === 'inet' && a.scope === 'global' && typeof a.local === 'string') {
        return a.local;
      }
    }
  }
  return null;
}

type RunFn = (argv: string[], opts?: RunOptions) => Promise<RunResult>;

export async function lanIp(runFn: RunFn = run): Promise<string | null> {
  const res = await runFn(['ip', '-json', 'addr'], { timeoutMs: 5000 });
  if (res.code !== 0) {
    log('warn', 'lanIp: ip -json addr failed', { code: res.code, stderr: res.stderr });
    return null;
  }
  const ip = parseLanIpFromIpAddrJson(res.stdout);
  if (ip === null) log('warn', 'lanIp: no primary LAN IPv4 address found');
  return ip;
}

// --- Endpoint file build / publish / read ------------------------------------

export interface EndpointPorts {
  udp: number | null;
  tcp: number | null;
}

export async function buildEndpointFile(
  cfg: FleetConfig,
  key: MachineKey,
  wanIp: string | null,
  lanIpAddr: string,
  tsMs: number,
  // Rendezvous data: the site's forwarded transport ports for this machine
  // (cfg.wan), never the node's HTTP port.
  ports: EndpointPorts = { udp: cfg.wan.udpPort, tcp: cfg.wan.tcpPort },
): Promise<EndpointFile> {
  const unsigned = {
    v: 1 as const,
    machine: cfg.machine,
    wanIp,
    lanIp: lanIpAddr,
    meshIp: cfg.meshIp,
    ports,
    tsMs,
  };
  const sigB64 = await signCanonical(unsigned, key.privateKeyJwk);
  return { ...unsigned, sigB64 };
}

function stableEndpointContent(file: EndpointFile): unknown {
  return {
    v: file.v,
    machine: file.machine,
    wanIp: file.wanIp,
    lanIp: file.lanIp,
    meshIp: file.meshIp,
    ports: file.ports,
  };
}

function endpointFilePath(cfg: FleetConfig, machine: string): { rel: string; abs: string } {
  const rel = join('endpoints', `${machine}.json`);
  return { rel, abs: join(cfg.fleetRepoPath, rel) };
}

export interface PublishEndpointDeps {
  wanIp: string | null;
  lanIp: string;
  nowMs?: number;
  ports?: EndpointPorts;
  runFn?: RunFn;
}

export interface PublishEndpointResult {
  published: boolean;
  file: EndpointFile;
}

async function hasOriginRemote(fleetRepoPath: string, runFn: RunFn): Promise<boolean> {
  const res = await runFn(['git', 'remote'], { cwd: fleetRepoPath, timeoutMs: 10000 }).catch((err) => {
    log('warn', 'publishEndpointFile: git remote check failed', { error: String(err) });
    return { code: 1, stdout: '', stderr: String(err) };
  });
  if (res.code !== 0) return false;
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .includes('origin');
}

export async function publishEndpointFile(
  cfg: FleetConfig,
  key: MachineKey,
  deps: PublishEndpointDeps,
): Promise<PublishEndpointResult> {
  const runFn = deps.runFn ?? run;
  const tsMs = deps.nowMs ?? nowMs();
  const ports = deps.ports ?? { udp: cfg.wan.udpPort, tcp: cfg.wan.tcpPort };
  const newFile = await buildEndpointFile(cfg, key, deps.wanIp, deps.lanIp, tsMs, ports);

  const { rel, abs } = endpointFilePath(cfg, cfg.machine);
  const existing = await readJsonFile<EndpointFile>(abs);

  const changed = existing === null || canonicalJson(stableEndpointContent(existing)) !== canonicalJson(stableEndpointContent(newFile));

  if (!changed) {
    return { published: false, file: existing as EndpointFile };
  }

  await atomicWrite(abs, canonicalJson(newFile) + '\n');
  log('info', 'publishEndpointFile: wrote endpoint file', { machine: cfg.machine, path: abs });

  if (await hasOriginRemote(cfg.fleetRepoPath, runFn)) {
    const addRes = await runFn(['git', 'add', rel], { cwd: cfg.fleetRepoPath, timeoutMs: 10000 });
    if (addRes.code !== 0) {
      log('warn', 'publishEndpointFile: git add failed', { code: addRes.code, stderr: addRes.stderr });
    } else {
      const iso = new Date(tsMs).toISOString();
      const commitRes = await runFn(['git', 'commit', '-m', `endpoints: ${cfg.machine} ${iso}`], {
        cwd: cfg.fleetRepoPath,
        timeoutMs: 10000,
      });
      if (commitRes.code !== 0) {
        log('warn', 'publishEndpointFile: git commit failed', { code: commitRes.code, stderr: commitRes.stderr });
      } else {
        const pushRes = await runFn(['git', 'push'], { cwd: cfg.fleetRepoPath, timeoutMs: 30000 });
        if (pushRes.code !== 0) {
          log('warn', 'publishEndpointFile: git push failed', { code: pushRes.code, stderr: pushRes.stderr });
        }
      }
    }
  }

  return { published: true, file: newFile };
}

function isEndpointFileShape(v: unknown): v is EndpointFile {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  if (f.v !== 1) return false;
  if (typeof f.machine !== 'string') return false;
  if (f.wanIp !== null && typeof f.wanIp !== 'string') return false;
  if (typeof f.lanIp !== 'string') return false;
  if (typeof f.meshIp !== 'string') return false;
  if (typeof f.tsMs !== 'number') return false;
  if (typeof f.sigB64 !== 'string') return false;
  if (typeof f.ports !== 'object' || f.ports === null) return false;
  const ports = f.ports as Record<string, unknown>;
  if (ports.udp !== null && typeof ports.udp !== 'number') return false;
  if (ports.tcp !== null && typeof ports.tcp !== 'number') return false;
  return true;
}

export async function readPeerEndpoint(cfg: FleetConfig, machine: string): Promise<EndpointFile | null> {
  const peer = cfg.peers.find((p) => p.name === machine);
  if (!peer) {
    log('warn', 'readPeerEndpoint: unknown peer', { machine });
    return null;
  }
  if (!peer.publicKeyJwk) {
    log('warn', 'readPeerEndpoint: peer has no publicKeyJwk configured', { machine });
    return null;
  }

  const { abs } = endpointFilePath(cfg, machine);
  const file = await readJsonFile<unknown>(abs);
  if (file === null) {
    log('warn', 'readPeerEndpoint: could not read or parse endpoint file', { machine, path: abs });
    return null;
  }
  if (!isEndpointFileShape(file)) {
    log('warn', 'readPeerEndpoint: malformed endpoint file', { machine, path: abs });
    return null;
  }
  if (file.machine !== machine) {
    log('warn', 'readPeerEndpoint: machine field mismatch', { expected: machine, got: file.machine });
    return null;
  }

  const { sigB64, ...rest } = file;
  const ok = await verifyCanonical(rest, sigB64, peer.publicKeyJwk);
  if (!ok) {
    log('warn', 'readPeerEndpoint: signature verification failed', { machine });
    return null;
  }
  return file;
}

// --- UPnP IGD presence probe (anchor-only standing warning, plan section 07) -

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_MSEARCH =
  'M-SEARCH * HTTP/1.1\r\n' +
  `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
  'MAN: "ssdp:discover"\r\n' +
  'MX: 2\r\n' +
  'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n';

export async function probeUpnpIgd(timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let socketRef: { close: () => void } | null = null;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socketRef?.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    const udpSocket = (Bun as unknown as { udpSocket?: (opts: unknown) => Promise<unknown> }).udpSocket;
    if (typeof udpSocket !== 'function') {
      log('warn', 'probeUpnpIgd: Bun.udpSocket unavailable in this runtime');
      finish(false);
      return;
    }

    udpSocket({
      socket: {
        data(): void {
          finish(true);
        },
        error(_socket: unknown, err: unknown): void {
          log('warn', 'probeUpnpIgd: socket error', { error: String(err) });
          finish(false);
        },
      },
    })
      .then((socket) => {
        socketRef = socket as { close: () => void };
        try {
          (socket as { send: (data: string, port: number, addr: string) => void }).send(
            SSDP_MSEARCH,
            SSDP_PORT,
            SSDP_ADDR,
          );
        } catch (err) {
          log('warn', 'probeUpnpIgd: send failed', { error: String(err) });
          finish(false);
        }
      })
      .catch((err: unknown) => {
        log('warn', 'probeUpnpIgd: udpSocket() failed', { error: String(err) });
        finish(false);
      });
  });
}
