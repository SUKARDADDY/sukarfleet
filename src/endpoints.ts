// SPDX-License-Identifier: AGPL-3.0-or-later
// Endpoint file publish/consume + UPnP probe (lane: endpoints).
// Owns src/endpoints.ts only. Depends on the shared layer (types/config/util) and on the platform
// boundary (platform.ts) for "which OS is this", nothing else.

import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { currentPlatform } from './platform';
import type { PlatformId } from './platform';
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
//
// Two sources for one answer, and they must land on the same address on the same box.
//
// Linux asks `ip -json addr` first, because it carries per-address SCOPE: that is how a loopback
// or link-local address is excluded by what the kernel says it is rather than by pattern-matching
// the digits. Windows and macOS have no iproute2 -- the first real Windows boot died on
// `uv_spawn 'ip'` -- so they read node:os networkInterfaces() directly, and a Linux box whose
// spawn fails falls back to the same reader. The selection rule is re-expressed there against what
// that API exposes: enumeration order, non-internal, IPv4, not 169.254/16, and never this
// machine's own mesh address.
//
// The mesh address matters because publishing it as `lanIp` would hand every peer a LAN dial
// candidate pointing at the overlay it is trying to establish. `ip -json addr` does not exclude it
// either, so both paths take the same exclusion and stay in step.

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

// IPv4 addresses that are never somebody's LAN address: 169.254/16 is what a host assigns itself
// when DHCP fails, and 127/8 is the loopback. On the `ip` path scope already rules both out.
function isUsableLanIpv4(addr: string, meshIp?: string): boolean {
  if (addr.length === 0) return false;
  if (addr.startsWith('169.254.')) return false;
  if (addr.startsWith('127.')) return false;
  if (meshIp !== undefined && meshIp.length > 0 && addr === meshIp) return false;
  return true;
}

// Exported for direct unit testing against a captured `ip -json addr` fixture string.
export function parseLanIpFromIpAddrJson(json: string, meshIp?: string): string | null {
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
        if (!isUsableLanIpv4(a.local, meshIp)) continue;
        return a.local;
      }
    }
  }
  return null;
}

// The subset of node:os's NetworkInterfaceInfo this needs. Declared structurally so a test can
// fabricate one without importing node's types, and so `family` accepts both shapes node has
// shipped ('IPv4' as a string, 4 as a number).
export interface NetworkInterfaceView {
  address: string;
  family: string | number;
  internal: boolean;
}

export type InterfacesFn = () => Record<string, NetworkInterfaceView[] | undefined>;

function isIpv4Family(family: string | number): boolean {
  return family === 'IPv4' || family === 4 || family === 'inet';
}

// The `ip -json addr` rule, expressed against networkInterfaces(): first non-internal IPv4 that is
// neither link-local nor this machine's mesh address, in enumeration order.
export function selectLanIpFromInterfaces(
  ifaces: Record<string, NetworkInterfaceView[] | undefined>,
  meshIp?: string,
): string | null {
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!Array.isArray(addrs)) continue;
    if (name === 'lo') continue;
    for (const a of addrs) {
      if (!a || typeof a.address !== 'string') continue;
      if (a.internal) continue;
      if (!isIpv4Family(a.family)) continue;
      if (!isUsableLanIpv4(a.address, meshIp)) continue;
      return a.address;
    }
  }
  return null;
}

type RunFn = (argv: string[], opts?: RunOptions) => Promise<RunResult>;

export interface LanIpOptions {
  // Defaults to this machine's platform. Injected by tests to exercise the other path.
  platform?: PlatformId;
  interfaces?: InterfacesFn;
  // This machine's overlay address (cfg.meshIp), excluded from the candidates when known.
  meshIp?: string;
}

// One line the first time iproute2 turns out to be missing or broken, not one per republish: this
// runs at startup and again after every suspend/resume, and a repeated identical warning is how a
// real signal gets trained out of the log.
let lanIpFallbackWarned = false;

function warnFallbackOnce(reason: string, detail: Record<string, unknown>): void {
  if (lanIpFallbackWarned) return;
  lanIpFallbackWarned = true;
  log('warn', 'lanIp: falling back to node:os networkInterfaces()', { reason, ...detail });
}

export async function lanIp(runFn: RunFn = run, opts: LanIpOptions = {}): Promise<string | null> {
  const platform = opts.platform ?? currentPlatform();
  const readInterfaces: InterfacesFn = opts.interfaces ?? (networkInterfaces as unknown as InterfacesFn);

  const fromInterfaces = (): string | null => {
    const ip = selectLanIpFromInterfaces(readInterfaces(), opts.meshIp);
    if (ip === null) log('warn', 'lanIp: no primary LAN IPv4 address found', { source: 'networkInterfaces' });
    return ip;
  };

  // iproute2 is Linux-only. Spawning it anywhere else buys an ENOENT, not an address.
  if (platform !== 'linux') return fromInterfaces();

  let res: RunResult;
  try {
    res = await runFn(['ip', '-json', 'addr'], { timeoutMs: 5000 });
  } catch (err) {
    // Bun.spawn throws when the binary is absent -- the failure mode that kept the endpoint file
    // from ever being published rather than merely leaving it stale.
    warnFallbackOnce('ip -json addr could not be spawned', { error: String(err) });
    return fromInterfaces();
  }
  if (res.code !== 0) {
    log('warn', 'lanIp: ip -json addr failed', { code: res.code, stderr: res.stderr });
    warnFallbackOnce('ip -json addr exited non-zero', { code: res.code });
    return fromInterfaces();
  }
  const ip = parseLanIpFromIpAddrJson(res.stdout, opts.meshIp);
  if (ip === null) log('warn', 'lanIp: no primary LAN IPv4 address found', { source: 'ip -json addr' });
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
  // The caller discovers its LAN address before it has a reason to mention cfg, so lanIp() is
  // usually asked without a mesh address to exclude. On a platform that answers from
  // networkInterfaces() the overlay adapter is just another non-internal IPv4, so it can win.
  // Publishing it would hand every peer a LAN dial candidate pointing at the overlay they are
  // still trying to establish, so say so plainly rather than shipping it silently.
  if (cfg.meshIp.length > 0 && deps.lanIp === cfg.meshIp) {
    log('warn', 'publishEndpointFile: LAN address equals this machine mesh address', {
      machine: cfg.machine,
      lanIp: deps.lanIp,
    });
  }
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

// --- Peer dial-candidate planning -------------------------------------------
//
// A roamer that lands on a foreign network which happens to reuse the anchor's
// LAN range turns the anchor's LAN address into a PHANTOM candidate: it looks
// on-link, so the kernel ARPs for it on the wrong wire and the dial neither
// connects nor fails fast. easytier retries it forever, and because a stuck
// connector is not an error, nothing upstream ever says why the mesh is empty.
//
// Two hosts share a LAN only if they sit behind the same NAT, so the WAN IP the
// endpoint files already carry is the co-location proof. Same WAN IP: the LAN
// candidate is real and cheapest, so it goes first. Different WAN IPs: it is a
// phantom and is not offered at all. Unknown on either side (no internet, or a
// probe that failed) we can neither prove nor disprove it, so it is offered
// last -- never suppressed, because a LAN-only fleet with no WAN IP to publish
// has nothing else to dial.

export type DialVia = 'lan' | 'wan-udp' | 'wan-tcp';

export interface DialCandidate {
  uri: string;
  via: DialVia;
}

export type LanSuppressionReason = 'peer-behind-different-wan';

export interface PeerDialPlan {
  candidates: DialCandidate[];
  // Same candidates as bare URIs, in dial order, for generateEasytierToml.
  uris: string[];
  // Set only when a LAN candidate existed and was deliberately withheld.
  lanSuppressed: { uri: string; reason: LanSuppressionReason } | null;
  // True when co-location could be neither proven nor disproven.
  coLocationUnknown: boolean;
}

export interface SelfEndpointView {
  wanIp: string | null;
  lanIp: string;
}

export interface PeerDialOptions {
  // The peer's mesh transport listener port as reachable on its own LAN. This is
  // NOT the forwarded WAN port: a router commonly forwards an arbitrary external
  // port at the real listener, and the endpoint file publishes the former.
  peerLanPort: number;
}

export function planPeerDial(
  self: SelfEndpointView,
  peer: EndpointFile,
  opts: PeerDialOptions,
): PeerDialPlan {
  const wan: DialCandidate[] = [];
  if (peer.wanIp) {
    if (peer.ports.udp !== null) wan.push({ uri: `udp://${peer.wanIp}:${peer.ports.udp}`, via: 'wan-udp' });
    if (peer.ports.tcp !== null) wan.push({ uri: `tcp://${peer.wanIp}:${peer.ports.tcp}`, via: 'wan-tcp' });
  }

  const lan: DialCandidate | null = peer.lanIp
    ? { uri: `udp://${peer.lanIp}:${opts.peerLanPort}`, via: 'lan' }
    : null;

  const bothWanKnown = self.wanIp !== null && peer.wanIp !== null;
  const coLocated = bothWanKnown && self.wanIp === peer.wanIp;
  const coLocationUnknown = !bothWanKnown;

  let candidates: DialCandidate[];
  let lanSuppressed: PeerDialPlan['lanSuppressed'] = null;

  if (lan === null) {
    candidates = wan;
  } else if (coLocated) {
    candidates = [lan, ...wan];
  } else if (coLocationUnknown) {
    candidates = [...wan, lan];
  } else {
    candidates = wan;
    lanSuppressed = { uri: lan.uri, reason: 'peer-behind-different-wan' };
    log('warn', 'planPeerDial: withholding phantom LAN candidate', {
      peer: peer.machine,
      lanUri: lan.uri,
      selfWanIp: self.wanIp,
      peerWanIp: peer.wanIp,
    });
  }

  return { candidates, uris: candidates.map((c) => c.uri), lanSuppressed, coLocationUnknown };
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
