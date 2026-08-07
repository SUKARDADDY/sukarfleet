// SPDX-License-Identifier: AGPL-3.0-or-later
// Presence gossip. Owned by the gossip lane. Do not duplicate types.ts/util.ts/config.ts.

import { join } from 'node:path';
import type { FleetConfig, GossipEnvelope, MachineKey, PeerConfig, PeerView, PresencePayload } from './types';
import { atomicWrite, b64decode, b64encode, canonicalJson, log, nowMs, readJsonFile, TransitionGate } from './util';
import { stateDir } from './config';

type UnsignedEnvelope = Omit<GossipEnvelope, 'sigB64'>;

// src/keys.ts is owned by a concurrently-written lane. It is imported dynamically
// (never statically) so this module loads and runs even before keys.ts exists.
// When present, its signGossip/verifyGossip are used; otherwise this module falls
// back to a local ECDSA-P256-over-canonicalJson implementation per contract clause 6.
// See final report contract-amendment.
interface KeysModule {
  signGossip?: (envelope: UnsignedEnvelope, key: MachineKey) => Promise<GossipEnvelope>;
  verifyGossip?: (envelope: GossipEnvelope, publicKeyJwk: JsonWebKey) => Promise<boolean>;
}

let keysModuleAttempted = false;
let keysModule: KeysModule | null = null;

async function loadKeysModule(): Promise<KeysModule | null> {
  if (keysModuleAttempted) return keysModule;
  keysModuleAttempted = true;
  try {
    keysModule = (await import('./keys')) as unknown as KeysModule;
  } catch (err) {
    log('warn', 'gossip: src/keys.ts unavailable, using local sign/verify fallback', { error: String(err) });
    keysModule = null;
  }
  return keysModule;
}

const ECDSA_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ECDSA_PARAMS, false, ['sign']);
}

async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ECDSA_PARAMS, false, ['verify']);
}

async function localSignCanonical(privateKeyJwk: JsonWebKey, data: unknown): Promise<string> {
  const key = await importPrivateKey(privateKeyJwk);
  const bytes = new TextEncoder().encode(canonicalJson(data));
  const sig = await crypto.subtle.sign(SIGN_ALG, key, bytes);
  return b64encode(new Uint8Array(sig));
}

async function localVerifyCanonical(publicKeyJwk: JsonWebKey, data: unknown, sigB64: string): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyJwk);
    const bytes = new TextEncoder().encode(canonicalJson(data));
    const sig = new Uint8Array(b64decode(sigB64));
    return await crypto.subtle.verify(SIGN_ALG, key, sig, bytes);
  } catch {
    return false;
  }
}

interface LastSeenEntry {
  atMs: number;
  envelope: GossipEnvelope;
}

export class Gossip {
  private lastSeen = new Map<string, LastSeenEntry>();
  private seqLoaded = false;
  private seqValue = 0;
  private lastPersistMs = 0;
  // Keyed by peer name. broadcastOnce logs loud (info) only on the entered/recovered transitions;
  // a peer stuck down repeats at debug instead of a warn every gossip tick. The durable signal for
  // an operator stays the peer-offline health fault -- this only quiets the journal.
  private readonly broadcastGate = new TransitionGate();

  constructor(
    private readonly cfg: FleetConfig,
    private readonly key: MachineKey,
    private readonly getPayload: () => PresencePayload,
  ) {}

  private seqPath(): string {
    return join(stateDir(), 'gossip-seq.json');
  }

  private lastSeenPath(): string {
    return join(stateDir(), 'last-seen.json');
  }

  private async loadSeq(): Promise<void> {
    if (this.seqLoaded) return;
    const data = await readJsonFile<{ seq: number }>(this.seqPath());
    this.seqValue = data && Number.isInteger(data.seq) && data.seq >= 0 ? data.seq : 0;
    this.seqLoaded = true;
  }

  private async nextSeq(): Promise<number> {
    await this.loadSeq();
    this.seqValue += 1;
    await atomicWrite(this.seqPath(), canonicalJson({ seq: this.seqValue }));
    return this.seqValue;
  }

  async buildEnvelope(): Promise<GossipEnvelope> {
    const seq = await this.nextSeq();
    const unsigned: UnsignedEnvelope = {
      v: 1,
      machine: this.cfg.machine,
      tsMs: nowMs(),
      seq,
      payload: this.getPayload(),
    };
    const km = await loadKeysModule();
    if (km?.signGossip) return km.signGossip(unsigned, this.key);
    const sigB64 = await localSignCanonical(this.key.privateKeyJwk, unsigned);
    return { ...unsigned, sigB64 };
  }

  async broadcastOnce(): Promise<void> {
    const envelope = await this.buildEnvelope();
    const body = JSON.stringify(envelope);
    await Promise.all(
      this.cfg.peers.map(async (peer) => {
        const url = `http://${peer.meshIp}:${peer.nodePort}/gossip`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: controller.signal,
          });
          if (!res.ok) {
            // The peer ANSWERED -- it is up, just rejecting (auth/version skew, most likely).
            // That is a different failure than "can't reach it at all" (the catch block below,
            // which IS the offline signal), so it deliberately never touches broadcastGate: an
            // unpaired/rejecting peer would otherwise sit silently debounced as if it were merely
            // offline. Unconditional warn every tick -- this is the only visibility the sending
            // side has at all on a one-way trust break, since the rejecting peer's own operator
            // sees nothing wrong from where they sit.
            log('warn', 'gossip: broadcast rejected by peer', { peer: peer.name, status: res.status });
          } else {
            this.logBroadcastTransition(peer.name, false, { peer: peer.name });
          }
        } catch (err) {
          this.logBroadcastTransition(peer.name, true, { peer: peer.name, error: String(err) });
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }

  // Transition-only logging for one peer's broadcast outcome this tick. isBad=true here means
  // "unreachable" (a thrown/aborted fetch) ONLY -- a non-OK response is a peer that answered and
  // is handled separately, unconditionally, in broadcastOnce, because "up but rejecting" and "not
  // reachable at all" are different failures an operator needs to tell apart. Only the flip logs
  // loud: the first unreachable tick is worth an operator's attention (info), a peer still down an
  // hour later is not (debug); the first success after failures gets its own "recovered" line, a
  // peer that was already fine stays silent.
  private logBroadcastTransition(peerName: string, isBad: boolean, extra: Record<string, unknown>): void {
    const transition = this.broadcastGate.observe(peerName, isBad);
    if (isBad) {
      log(transition === 'entered' ? 'info' : 'debug', 'gossip: peer went offline', extra);
    } else if (transition === 'recovered') {
      log('info', 'gossip: peer recovered', extra);
    }
  }

  async receive(envelope: GossipEnvelope, peers: PeerConfig[]): Promise<boolean> {
    const peer = peers.find((p) => p.name === envelope.machine);
    if (!peer) {
      log('warn', 'gossip: envelope from unconfigured machine dropped', { machine: envelope.machine });
      return false;
    }
    if (!peer.publicKeyJwk) {
      log('warn', 'gossip: no public key configured for peer, dropped', { machine: envelope.machine });
      return false;
    }

    const unsigned: UnsignedEnvelope = {
      v: envelope.v,
      machine: envelope.machine,
      tsMs: envelope.tsMs,
      seq: envelope.seq,
      payload: envelope.payload,
    };
    const km = await loadKeysModule();
    const verified = km?.verifyGossip
      ? await km.verifyGossip(envelope, peer.publicKeyJwk)
      : await localVerifyCanonical(peer.publicKeyJwk, unsigned, envelope.sigB64);
    if (!verified) {
      log('warn', 'gossip: signature verification failed, dropped', { machine: envelope.machine });
      return false;
    }

    const skewMs = Math.abs(nowMs() - envelope.tsMs);
    if (skewMs > this.cfg.thresholds.clockSkewMaxMs * 4) {
      log('warn', 'gossip: envelope clock skew too large, dropped', { machine: envelope.machine, skewMs });
      return false;
    }

    const last = this.lastSeen.get(envelope.machine);
    if (last && envelope.seq <= last.envelope.seq) {
      log('warn', 'gossip: stale/replayed seq dropped', {
        machine: envelope.machine,
        seq: envelope.seq,
        lastSeq: last.envelope.seq,
      });
      return false;
    }

    this.lastSeen.set(envelope.machine, { atMs: nowMs(), envelope });
    return true;
  }

  getPeerViews(nowMsArg: number): PeerView[] {
    const onlineWindowMs = this.cfg.intervals.gossipSec * 1000 * this.cfg.thresholds.peerOfflineFactor;
    const staleWindowMs = this.cfg.thresholds.syncStaleMin * 60 * 1000;
    return this.cfg.peers.map((peer) => {
      const entry = this.lastSeen.get(peer.name) ?? null;
      const lastSeenMs = entry ? entry.atMs : null;
      const online = lastSeenMs !== null && nowMsArg - lastSeenMs <= onlineWindowMs;

      let syncStale = true;
      if (entry) {
        const repoStats = Object.values(entry.envelope.payload.repos);
        syncStale =
          repoStats.length > 0
            ? repoStats.some((r) => r.lastSyncOkMs === null || nowMsArg - r.lastSyncOkMs > staleWindowMs)
            : false;
      }

      return { name: peer.name, lastSeenMs, lastEnvelope: entry ? entry.envelope : null, online, syncStale };
    });
  }

  async snapshot(): Promise<void> {
    const obj: Record<string, LastSeenEntry> = {};
    for (const [machine, entry] of this.lastSeen) obj[machine] = entry;
    await atomicWrite(this.lastSeenPath(), canonicalJson(obj));
  }

  async restore(): Promise<void> {
    const data = await readJsonFile<Record<string, LastSeenEntry>>(this.lastSeenPath());
    if (!data) return;
    this.lastSeen = new Map(Object.entries(data));
  }

  // Called by the owning loop every cycle; persists at most once per gossip interval
  // (floor 5s) so disk writes track presence traffic without happening every tick.
  async persistEvery(nowMsArg: number): Promise<void> {
    const cadenceMs = Math.max(this.cfg.intervals.gossipSec * 1000, 5000);
    if (nowMsArg - this.lastPersistMs < cadenceMs) return;
    this.lastPersistMs = nowMsArg;
    await this.snapshot();
  }
}
