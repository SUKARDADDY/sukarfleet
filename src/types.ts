// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared type contract. Source of truth for every module.

export interface PeerConfig {
  name: string;
  meshIp: string;
  nodePort: number;
  publicKeyJwk: JsonWebKey | null;
  // SSH admin-lane overrides. All optional and null-by-default: absent means "derive from the mesh
  // identity", i.e. sshHost falls back to meshIp and sshPort to FleetConfig.admin.sshPort.
  // sshFallbackHost is a public hostname used ONLY when a direct mesh connect fails; it is
  // asymmetric by nature (a roamer may have one for the anchor and the anchor none for the roamer)
  // and null on the side that cannot reach the other that way.
  sshHost?: string | null;
  sshPort?: number | null;
  sshFallbackHost?: string | null;
  // The peer's SSH PUBLIC key, as exchanged at pairing. Persisted because the authorized_keys
  // grant is installed and removed as admin.acceptIncoming is toggled, and the grant line was
  // previously the only copy of this key -- so closing the lane would have destroyed the pairing
  // and forced a re-pair to reopen it. Public key material only; safe in a 0600 config.
  sshPublicKey?: string | null;
}

export interface RepoConfig {
  name: string;
  path: string;
  postMerge?: string[][]; // argv arrays run after successful merge
}

export interface FleetConfig {
  machine: string;
  role: 'anchor' | 'roamer';
  meshIp: string;
  nodePort: number;
  networkName: string;
  peers: PeerConfig[];
  repos: RepoConfig[];
  unionPaths: string[];
  easytier: {
    rpcAddr: string;
    serviceName: string;
    cliPath: string;
  };
  // The router-forwarded WAN ports pointing at THIS machine's mesh transport (machine-local facts
  // about the local site; null = no forward).
  wan: {
    udpPort: number | null;
    tcpPort: number | null;
  };
  // Desktop notification duty. Default true (today's behaviour: the daemon notifies directly).
  // Set os:false to hand notification duty to a client that polls the daemon's fault state itself
  // (e.g. the tray app), so the two never double-fire. Flat, one field -- same shape as wan/easytier.
  notifications: {
    os: boolean;
  };
  fleetRepoPath: string;
  // Loopback MCP port. Top-level rather than nested: the MCP surface is how an agent reaches the
  // fleet, which is the product's whole point, and it is not part of the admin lane. It previously
  // lived inside the exec block; anything reading it from there breaks when that block is absent.
  mcpPort: number;
  intervals: {
    gossipSec: number;
    syncSec: number;
    watchdogSec: number;
    transportPollSec: number;
  };
  thresholds: {
    syncStaleMin: number;
    alarmRepeatMin: number;
    peerOfflineFactor: number;
    clockSkewMaxMs: number;
    wedgePolls: number;
  };
  // SSH admin lane. Deliberately FLAT -- no nested `thresholds` object -- so mergeDefaults stays
  // one line and the top-level `thresholds` shape is untouched. See AdminConfig below.
  admin: AdminConfig;
}

export interface PresenceRepoStat {
  lastSyncOkMs: number | null;
  lastCommit: string | null;
  syncError: string | null;
}

export interface PresencePayload {
  repos: Record<string, PresenceRepoStat>;
  githubPushOkMs: Record<string, number | null>;
  clockMs: number;
  flags: string[];
}

export interface GossipEnvelope {
  v: 1;
  machine: string;
  tsMs: number;
  seq: number;
  payload: PresencePayload;
  sigB64: string; // sig over canonicalJson({v,machine,tsMs,seq,payload})
}

export interface PeerView {
  name: string;
  lastSeenMs: number | null;
  lastEnvelope: GossipEnvelope | null;
  online: boolean;
  syncStale: boolean;
}

export interface EndpointFile {
  v: 1;
  machine: string;
  wanIp: string | null;
  lanIp: string;
  meshIp: string;
  // The site's forwarded WAN ports for this machine's mesh transport (router-configured).
  ports: { udp: number | null; tcp: number | null };
  tsMs: number;
  sigB64: string;
}

export interface MachineKey {
  machine: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

// Append-only, per-machine-sequenced signed audit log entry (audit.ts). `kind` is left as a plain
// string (not a closed union) so audit.ts and every producer can record new event kinds without
// requiring an edit to this shared file.
export interface AuditEntry {
  v: 1;
  machine: string;
  seq: number; // monotonic per-machine sequence number
  tsMs: number;
  kind: string;
  detail: Record<string, unknown>;
  sigB64: string; // sig over canonicalJson of every field above
}

// ---------------------------------------------------------------------------
// SSH admin lane. Cross-machine `sudo` over OpenSSH on the mesh.
//
// The invariant every type below is shaped around: A SUDO PASSWORD NEVER CROSSES THE NETWORK.
// Each machine stores only its own, sealed at rest, and unseals it only inside the SSH
// forced-command leg running on that machine. Nothing here -- no request, no response, no status,
// no view -- has a field that can carry a password, its hash, or its length, and none may be added.
// ---------------------------------------------------------------------------

// The slice of a Bun server the route modules actually need. Declared here (rather than
// per-module) so node.ts, uiserve.ts and their tests all gate on the same contract.
export interface MinimalServer {
  requestIP(req: Request): { address: string } | null;
}

export interface AdminConfig {
  // Fail-closed: both flags default such that a machine that never ran the setup GUI cannot
  // originate an admin call. `enabled` gates the origin leg, `acceptIncoming` the target leg, so a
  // machine can serve the lane without being able to drive it, and vice versa.
  enabled: boolean;
  acceptIncoming: boolean;
  sshUser: string;
  sshPort: number;
  // Paths may be '~'-prefixed; every consumer resolves them through config.ts's expandHome.
  keyPath: string;
  knownHostsPath: string;
  authorizedKeysPath: string;
  secretsDir: string;
  // Name of the ONE repo the shared audit union file is flushed into. Must be an adopted repo
  // whose postMerge regenerates that file (see node.ts's resolveAuditRepo). Null/absent means "do
  // not flush at all": the audit log still accumulates locally, it is simply not shared over git.
  // There is deliberately no silent default -- flushing a per-machine, divergent-by-construction
  // file into a repo with no regenerator wedges that repo's sync loop permanently on the first
  // add/add conflict.
  //
  // This lives on the admin lane because the entries it carries are admin-run records. It was
  // previously nested in the exec block; config.ts migrates the old location on load.
  auditRepo?: string | null;
  // Who may DRIVE the lane, as opposed to whether the lane exists at all (`enabled`). These are
  // two different risks and conflating them is what makes the security story hard to tell:
  // turning the lane on grants the OPERATOR remote admin; letting the AGENT drive it is this
  // second, explicit switch.
  //
  //   'refuse'  agent-origin runs are refused. Status stays readable, so an agent can still see
  //             and explain the lane's state. The human drives the GUI.   [product default]
  //   'allow'   any origin may drive the lane.
  //
  // A third mode, 'confirm' -- park the run and require an operator click in the GUI within N
  // seconds -- is the intended upgrade. It is deliberately NOT in this union yet: an enum value
  // that silently behaves like something else is worse than an absent feature. See SECURITY.md.
  agentOrigin: 'refuse' | 'allow';
  // 'nopasswd' is offered as the structural alternative (a hand-written narrow sudoers rule, no
  // reusable human credential) but is NEVER auto-installed by any installer in this repo.
  credentialMode: 'stored-password' | 'nopasswd';
  // Storing the sudo password unsealed. False in every shipped config; exists only so a machine
  // with no working credential store fails loudly at the credential screen instead of silently
  // downgrading.
  allowPlaintextFallback: boolean;
  connectTimeoutSec: number;
  runTimeoutSec: number;
  maxRunTimeoutSec: number;
  // Per-stream capture cap handed to util.run's maxCaptureBytes, so a runaway command truncates
  // instead of growing the daemon's heap without bound.
  maxOutputBytes: number;
  ratePerMin: number;
  uiEnabled: boolean;
}

// Every way an admin call can be turned down without executing. Kept as a closed union (unlike
// AuditEntry.kind) because the GUI and the MCP surface both render fixed copy per reason: an
// unhandled reason there would degrade into an unexplained failure.
export type AdminRefusalReason =
  | 'lane-disabled-local'
  | 'lane-disabled-target'
  | 'not-paired'
  | 'unreachable'
  | 'no-credential'
  | 'credential-stale'
  | 'missing-reason'
  | 'bad-argv'
  | 'rate-limited'
  | 'refused-argv'
  | 'timeout'
  | 'hostkey-mismatch'
  | 'agent-origin-refused'
  | 'not-configured';

export interface AdminRunRequest {
  machine: string;
  argv: string[];
  // Mandatory free text. It is the only thing that makes the audit log readable months later, so
  // an empty reason is a refusal ('missing-reason'), not a default.
  reason: string;
  timeoutSec?: number;
  // Recorded on every call and, as of the admin-lane policy knob, ENFORCED: an agent-origin call
  // is refused unless the operator separately opted in. Turning the lane on grants the operator
  // remote admin; letting the agent drive it is a second, explicit switch.
  requestedBy: { kind: 'agent' | 'operator'; client?: string };
}

export interface AdminRunResult {
  runId: string;
  machine: string;
  ok: boolean;
  exitCode: number | null; // null when the command never ran (refusal, unreachable, timeout)
  stdout: string;
  stderr: string;
  transport: 'local' | 'mesh' | 'cf' | null;
  durationMs: number;
  truncated: boolean;
  refusal?: AdminRefusalReason;
  message?: string;
  auditSeq?: number;
}

// A run as the GUI polls it: the result fields plus the request context and liveness, so a
// reloaded page can render an in-flight run it did not start.
export interface AdminRunView extends AdminRunResult {
  startedMs: number;
  finishedMs: number | null;
  running: boolean;
  argv: string[];
  reason: string;
}

export interface AdminStatusEntry {
  machine: string;
  self: boolean;
  paired: boolean;
  reachable: boolean | null; // null = not probed this cycle
  credentialReady: boolean;
  credentialStale: boolean;
  laneEnabled: boolean;
  sshKeyFingerprint: string | null;
  hostKeyFingerprints: string[];
  lastAdminRunMs: number | null;
}

// Everything one machine publishes about itself during pairing, in one round trip: the mesh
// identity (publicKeyJwk/meshIp/nodePort) plus the SSH identity (client pubkey + host keys).
// `sshPublicKey` is a BARE key line -- the receiving daemon always builds the authorized_keys
// option prefix (from=/restrict/command=) itself and never accepts one from the peer.
export interface PairBundle {
  v: 1;
  machine: string;
  role: 'anchor' | 'roamer';
  meshIp: string;
  nodePort: number;
  publicKeyJwk: JsonWebKey;
  sshUser: string;
  sshPublicKey: string;
  sshHostKeys: string[];
}

export interface PairHelloRequest {
  payload: { v: 1; from: PairBundle; tsMs: number };
  mac: string; // HMAC over 'req|' + canonicalJson(payload), key derived from the pairing code
}

export interface PairHelloResponse {
  // reqSha256 binds this response to the exact request it answers, closing the transcript-splice
  // gap a bare "both sides MAC their own payload" exchange leaves open.
  payload: { v: 1; from: PairBundle; tsMs: number; reqSha256: string };
  mac: string; // HMAC over 'res|' + canonicalJson(payload)
}

// The SSH forced-command payload, base64(canonicalJson(...)) in SSH_ORIGINAL_COMMAND. Note what is
// absent and must stay absent: any credential field. The target unseals its OWN password.
export interface ExecLocalRequest {
  v: 1;
  runId: string;
  originMachine: string;
  argv: string[];
  reason: string;
  timeoutSec: number;
}

export interface ExecLocalResponse {
  v: 1;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  refusal?: AdminRefusalReason;
  message?: string;
}

// ---------------------------------------------------------------------------
// Local GUI state. Shared between the route layer that emits it (uiserve.ts), the daemon that
// assembles it (node.ts) and ui/app.js, which is untyped and therefore reads these field names
// literally. Additive changes only once the GUI ships.
// ---------------------------------------------------------------------------

export interface UiSelfView {
  machine: string;
  role: 'anchor' | 'roamer';
  meshIp: string;
  nodePort: number;
  uptimeSec: number;
}

export interface UiPeerView {
  name: string;
  meshIp: string;
  nodePort: number;
  online: boolean;
  lastSeenMs: number | null;
  syncStale: boolean;
  paired: boolean; // a peer with no enrolled publicKeyJwk is configured but not yet paired
  sshHost: string | null;
  sshFallbackHost: string | null;
}

export interface UiRepoView {
  name: string;
  path: string;
  lastSyncOkMs: number | null;
  lastCommit: string | null;
  syncError: string | null;
}

// Flattened FaultSnapshot (health.ts). Restated with plain strings so types.ts stays free of
// imports and the GUI never has to know the FaultClass union.
export interface UiFaultView {
  key: string;
  faultClass: string;
  message: string;
  urgency: string;
  firstSeenMs: number;
}

export interface UiAdminLaneView {
  enabled: boolean;
  acceptIncoming: boolean;
  uiEnabled: boolean;
  configured: boolean; // ssh key + known_hosts present
  credentialPresent: boolean;
  credentialStale: boolean;
  credentialSealed: 'tpm2' | 'user' | 'plaintext' | null;
  credentialSetAtMs: number | null;
  sshUser: string;
  sshKeyFingerprint: string | null;
  runTimeoutSec: number;
  maxRunTimeoutSec: number;
  ratePerMin: number;
}

export type MeshSecretState = 'none' | 'pending' | 'installed';

// Drives the setup takeover: the GUI renders it whenever `complete` is false.
export interface UiSetupState {
  complete: boolean;
  identity: boolean;
  meshSecret: MeshSecretState;
  credential: boolean;
  paired: boolean;
}

export interface UiPairingState {
  active: boolean;
  display?: string;
  expiresMs?: number;
  attemptsLeft?: number;
  pairedWith?: string;
}

export interface UiState {
  v: 1;
  nowMs: number;
  self: UiSelfView;
  peers: UiPeerView[];
  repos: UiRepoView[];
  faults: UiFaultView[];
  admin: UiAdminLaneView;
  setup: UiSetupState;
  pairing: UiPairingState;
}

// Setup-screen identity edit. Every field optional: the GUI submits only what the operator
// changed, and the handler patches config.json field by field.
export interface IdentityPatch {
  machine?: string;
  role?: 'anchor' | 'roamer';
  meshIp?: string;
  nodePort?: number;
  networkName?: string;
}
