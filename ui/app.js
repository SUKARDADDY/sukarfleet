// SPDX-License-Identifier: AGPL-3.0-or-later
// sukarfleet console. Vanilla ES module, no build step, no dependency, no network asset.
//
// Two rules carry the whole file:
//   1. Every request path is root-relative. This page is routinely opened through
//      `ssh -N -L 7711:127.0.0.1:7710 <machine>`, and an absolute origin would make a
//      forwarded tab silently drive the local machine instead of the remote one. That is
//      the worst failure this design can have, so there is not one absolute URL below.
//   2. Server data reaches the DOM only through textContent. No innerHTML anywhere.

// ── copy ──────────────────────────────────────────────────────────────────
// Every string the operator can read from JS lives here, so the wording can be reviewed
// without reading the logic. Refusals name the machine that is blocking, the fix, and how
// to reach that machine's own console.

const FORWARD = (m) => `ssh -N -L 7711:127.0.0.1:7710 ${m}`;
const REMOTE_CONSOLE = (m) => `Forward it with \`${FORWARD(m)}\` and open 127.0.0.1:7711/ui/.`;

const COPY = {
  connecting: 'Connecting…',
  live: 'Live',
  offline: 'Cannot reach this daemon. The page keeps retrying.',
  scopeNote: (m) => `Every action on this page runs on ${m}.`,
  unknownMachine: 'unknown machine',
  never: 'never',
  none: 'none',

  laneReady: 'Admin lane ready.',
  laneOff: 'Admin lane is switched off on this machine.',
  laneUnconfigured: 'Admin lane is not configured: the fleet SSH key or known_hosts is missing. Re-run install/quickstart.sh.',
  laneNoCredential: 'Admin lane is on, but no sudo password is stored here. Other machines cannot run privileged commands on this one.',
  laneStale: 'The stored sudo password was rejected. Re-enter it under Credentials.',
  noFaults: 'No alarms.',
  noPeers: 'No peers configured yet. Pair with another machine.',
  noRepos: 'No repositories configured.',
  noRuns: 'No admin runs since the daemon started.',
  noAudit: 'No audit entries yet.',
  noTargets: 'No paired machine to target yet.',

  setupBannerHidden: '',
  identitySaved: 'Saved.',
  // Identity is read once at boot -- the servers bind cfg.nodePort, gossip signs
  // as cfg.machine -- so a save is a config.json write and nothing else until
  // the daemon comes back. POST /api/ui/setup/identity says so with
  // restartRequired, and the restart button sits next to this line.
  identitySavedRestart: 'Saved. Restart the daemon to apply.',
  identityUnchanged: 'Nothing changed.',
  meshStateNone: 'No mesh secret staged on this machine.',
  meshStatePending: 'A secret is staged and waiting for the one root step below.',
  meshStateInstalled: 'The mesh secret is installed. Nothing to do here.',
  // setup.meshBindFallback: the mesh address is saved on the Identity card but is not on any
  // interface yet, so the daemon is listening on all of them until the sudo step below brings
  // the mesh up. Says which step closes it rather than leaving a warning with no exit.
  meshAddressNotUp: 'The mesh address is set but not up on this machine yet, so the node is listening on all interfaces. The root step below is what brings it up.',
  meshGenerated: 'Generated. Copy it to the other machines, then run the command below.',
  meshStaged: 'Staged. Run the command below to install it.',

  credAbsent: 'No sudo password stored on this machine.',
  credSealed: (whenText, scope) =>
    `Stored and sealed · bound to this user on this host${scope === 'tpm2' ? ' (TPM)' : ''} · set ${whenText}`,
  credPlaintext: 'Stored WITHOUT sealing. Sealing was unavailable when it was saved — remove it and save again once sealing works.',
  credStale: 'The stored password was rejected by sudo. It was probably changed. Save the current one.',
  credSealUnavailable: (why) => `Credential sealing is not available for this user${why ? `: ${why}` : ''}. Saving a password is refused until it is.`,
  credSaving: 'Verifying with sudo…',
  credSaved: 'Saved and sealed.',
  credVerifyFailed: 'sudo rejected that password. Nothing was stored.',
  credSealFailed: 'The password verified, but sealing failed. Nothing was stored.',
  credNotPrivate: 'The secrets directory is not private (0700 on a real filesystem). Nothing was stored.',
  credRemoved: 'Removed.',
  credRemoveConfirm: (m) => `Remove the stored sudo password on ${m}? Other machines will not be able to run privileged commands here until a new one is saved.`,
  credPasswordLabel: (user, machine) => `Sudo password for ${user || 'this user'} on ${machine || 'this machine'}`,

  laneEnabledOn: 'This machine can now send privileged commands to the fleet and to itself.',
  laneEnabledOff: 'This machine can no longer send privileged commands anywhere, including to itself.',
  laneAcceptOn: 'This machine now runs privileged commands sent to it by paired machines.',
  laneAcceptOff: 'This machine now refuses privileged commands sent to it, even by paired machines.',

  revokeConfirm: (peer, self) =>
    `Revoke ${peer}? Its SSH access to ${self} is removed and ${self} stops trusting it. Pair again to restore it.`,
  revoked: (peer) => `${peer} revoked. It can no longer run privileged commands here.`,
  revokeUnsupported: 'This daemon has no revoke control. Remove the peer by hand: delete its entry from config.json, its marked line from ~/.ssh/authorized_keys, and its keys from known_hosts, then restart the daemon.',

  pairInactive: 'No code is active.',
  pairActive: (left, attempts) => `Active · expires in ${left} · ${attempts} attempt${attempts === 1 ? '' : 's'} left`,
  pairExpired: 'That code expired. Show a new one.',
  pairPairedWith: (m) => `Last paired with ${m}.`,
  pairing: 'Pairing…',
  pairOk: (m) => `Paired with ${m}. Verified in both directions.`,
  pairReason: {
    'bad-code': 'That code was not accepted. Codes are single use and last five minutes — show a fresh one and try again.',
    unreachable: 'Could not reach that address. Check the mesh IP and port, and that the other daemon is running.',
    'bad-response': 'The other machine answered with something unexpected. Nothing was paired.',
    'half-paired': 'Pairing completed in one direction only. Run it again from the other machine before using the admin lane.',
  },
  pairBadCodeFormat: 'A pairing code is twelve characters, optionally grouped with dashes.',

  runNeedsCommand: 'Enter a command.',
  runNeedsReason: 'Enter a reason. It is the only thing that makes the audit log readable months from now.',
  runNeedsTarget: 'Choose a target machine.',
  runConfirmPrompt: (m, why) => `This looks destructive (${why}). It will run as root on ${m}.`,
  runConfirmMismatch: (m) => `Type ${m} exactly to confirm.`,
  runStarting: 'Starting…',
  runRunning: (left) => `Running · ${left} left before the timeout`,
  runDoneOk: (code, transport, ms) => `Finished · exit ${code} · via ${transport} · ${ms} ms`,
  runDoneBad: (code, transport, ms) => `Failed · exit ${code} · via ${transport} · ${ms} ms`,
  runTruncated: 'Output was longer than the capture limit and has been truncated. The exit code is still the real one.',
  runLost: 'That run is no longer in the daemon\'s registry (it keeps the last 20, and clears them on restart).',

  refusal: {
    'lane-disabled-local': (t, l) => `The admin lane is switched off on ${l}, this machine. Turn it on under Credentials, then run the command again.`,
    'lane-disabled-target': (t) => `${t} is not accepting admin commands from the fleet. Switch it on in ${t}'s own console under Credentials. ${REMOTE_CONSOLE(t)}`,
    'not-paired': (t, l) => `${l} is not paired with ${t}. Open Pair on one machine, show the code, and enter it on the other.`,
    unreachable: (t) => `${t} did not answer. Check that it is awake and that easytier-fleet.service is running there.`,
    'no-credential': (t) => `${t} has no sudo password stored, so it cannot run anything as root. Save one in ${t}'s own console — the password never leaves that machine. ${REMOTE_CONSOLE(t)}`,
    'credential-stale': (t) => `${t} rejected its own stored sudo password, so the command was not run. It was probably changed. Save the current one on ${t}. ${REMOTE_CONSOLE(t)}`,
    'missing-reason': () => `Every admin run needs a reason. It is the only thing that makes the audit log readable months from now.`,
    'bad-argv': () => `That command could not be turned into arguments. Check the quoting.`,
    'rate-limited': (t) => `Too many admin runs against ${t} in the last minute. Wait, then try again.`,
    'refused-argv': (t) => `${t} refused this command: it touches the credential store or the sealing tool. The refusal is recorded in the audit log.`,
    timeout: (t) => `The command was still running when the timeout expired on ${t}. Nothing was rolled back.`,
    'hostkey-mismatch': (t) => `The SSH host key ${t} presented does not match the pinned one. Nothing was sent. Investigate before retrying, then re-pair the machines.`,
    'not-configured': (t, l) => `The admin lane is not configured on ${l}: the fleet SSH key or known_hosts is missing. Re-run install/quickstart.sh here.`,
  },

  restartConfirm: (m) => `Restart the sukarfleet daemon on ${m}?`,
  restarting: 'Restarting. This page reconnects on its own.',
  requestFailed: (status) => `The daemon answered ${status}.`,
  networkFailed: 'The daemon did not answer.',
};

// A client-side tripwire, honestly labelled: it makes a destructive command a deliberate act,
// it does not make anything safe. The target-side refusal set is the enforced one.
const DESTRUCTIVE_PATTERNS = [
  [/\brm\s+(-\S+\s+)*-\S*[rR]\S*f|\brm\s+(-\S+\s+)*-\S*f\S*[rR]/, 'recursive forced delete'],
  [/\bmkfs(\.\w+)?\b/, 'filesystem creation'],
  [/\bdd\b[^\n]*\bof=/, 'raw device write'],
  [/>\s*\/dev\/sd/, 'write to a block device'],
  [/\bshutdown\b/, 'shutdown'],
  [/\breboot\b/, 'reboot'],
  [/\buserdel\b/, 'user deletion'],
  [/\bchown\s+-R\b[^\n]*\s\/(\s|$)/, 'recursive chown of /'],
];

// ── tiny DOM helpers ──────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function setText(id, text) {
  const node = $(id);
  if (node) node.textContent = text === undefined || text === null ? '' : String(text);
}

function show(node, visible) {
  if (node) node.hidden = !visible;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function result(id, text, kind) {
  const node = $(id);
  if (!node) return;
  node.textContent = text || '';
  node.className = 'result' + (kind ? ` result-${kind}` : '');
}

function statusLine(id, text, dotClass) {
  const node = $(id);
  if (!node) return;
  clear(node);
  if (dotClass) {
    const dot = el('span', `dot ${dotClass}`);
    dot.setAttribute('aria-hidden', 'true');
    node.appendChild(dot);
    node.appendChild(document.createTextNode(' '));
  }
  node.appendChild(document.createTextNode(text));
}

function row(cells) {
  const tr = document.createElement('tr');
  for (const cell of cells) {
    const td = document.createElement('td');
    if (cell && typeof cell === 'object' && cell.node) {
      if (cell.className) td.className = cell.className;
      td.appendChild(cell.node);
    } else {
      td.textContent = cell === undefined || cell === null ? '' : String(cell);
    }
    tr.appendChild(td);
  }
  return tr;
}

function fillTable(table, rows, emptyText, colspan) {
  const body = table.tBodies[0];
  clear(body);
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'empty', emptyText);
    td.colSpan = colspan;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const r of rows) body.appendChild(r);
}

// ── formatting ────────────────────────────────────────────────────────────

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.floor(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtAgo(ms, nowMs) {
  if (!ms) return COPY.never;
  const delta = Math.max(0, (nowMs || Date.now()) - ms) / 1000;
  if (delta < 2) return 'just now';
  return `${fmtDuration(delta)} ago`;
}

function fmtClock(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function yesNo(v) {
  if (v === null || v === undefined) return '—';
  return v ? 'yes' : 'no';
}

// ── transport ─────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Every path passed here starts with '/api/ui/'. Nothing builds an origin.
async function api(path, opts) {
  const o = opts || {};
  const init = {
    method: o.method || 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
  };
  if (o.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(o.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, COPY.networkFailed);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const msg = data && typeof data.message === 'string' ? data.message : COPY.requestFailed(res.status);
    throw new ApiError(res.status, msg);
  }
  return data;
}

// One switch sends one key, so flipping either never rewrites the other.
function postLane(patch) {
  return api('/api/ui/lane', { method: 'POST', body: patch });
}

// An open console tab outlives a daemon upgrade -- this page polls, it never reloads -- so this
// route can disappear underneath a rendered button. A 404 here means "this build has no revoke
// control", which is a sentence the operator can act on, not a dead click.
async function postRevoke(machine) {
  try {
    return await api('/api/ui/pair/revoke', { method: 'POST', body: { machine } });
  } catch (err) {
    if (err.status === 404) throw new ApiError(404, COPY.revokeUnsupported);
    throw err;
  }
}

// ── module state ──────────────────────────────────────────────────────────

const store = {
  state: null,
  credentials: null,
  adminStatus: [],
  runs: [],
  audit: [],
  pair: null,
  mesh: null,
  activeRunId: null,
  activeRun: null,
  online: false,
  setupDismissed: false,
  // Latched off the first time a revoke attempt 404s, so the row control stops offering an
  // action this daemon cannot perform.
  revokeSupported: true,
};

const SCREENS = ['setup', 'fleet', 'pair', 'credentials', 'admin'];

function selfMachine() {
  return (store.state && store.state.self && store.state.self.machine) || COPY.unknownMachine;
}

function routeFromHash() {
  const raw = location.hash.replace(/^#\/?/, '').trim();
  return SCREENS.includes(raw) ? raw : '';
}

function setupIncomplete() {
  const setup = store.state && store.state.setup;
  return Boolean(setup && setup.complete === false);
}

// The setup takeover is where an unconfigured machine lands, and a banner keeps pointing back
// at it. It is not a trap: an explicit hash always wins, because setup step 3 and step 4 hand
// the operator to the Credentials and Pair screens, and a single-machine fleet is never
// "paired" at all.
function activeScreen() {
  const explicit = routeFromHash();
  if (explicit) return explicit;
  return setupIncomplete() && !store.setupDismissed ? 'setup' : 'fleet';
}

// ── rendering ─────────────────────────────────────────────────────────────

let lastScreen = null;

function render() {
  const screen = activeScreen();
  for (const name of SCREENS) show($(`screen-${name}`), name === screen);
  for (const link of document.querySelectorAll('#tabs a')) {
    if (link.dataset.screen === screen) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  renderHeader();
  if (store.state) {
    renderSetupCards();
    if (screen === 'fleet') renderFleet();
    if (screen === 'credentials') renderCredentials();
    if (screen === 'admin') renderAdminForm();
  }
  renderPairCode();
  renderRun();
  if (screen !== lastScreen) {
    lastScreen = screen;
    onScreenEnter(screen);
  }
}

function renderHeader() {
  const self = (store.state && store.state.self) || null;
  const machine = self ? self.machine : COPY.unknownMachine;
  setText('self-machine', machine);
  document.title = self ? `${machine} · sukarfleet` : 'sukarfleet console';
  setText('self-role', self ? self.role : '—');
  setText('self-endpoint', self ? `${self.meshIp}:${self.nodePort}` : '—');
  setText('self-uptime', self ? fmtDuration(self.uptimeSec) : '—');
  setText('scope-note', COPY.scopeNote(machine));
  const dot = $('conn-dot');
  dot.className = `dot ${store.online ? 'dot-ok' : 'dot-bad'}`;
  setText('conn-text', store.online ? COPY.live : COPY.offline);

  show($('setup-banner'), setupIncomplete() && activeScreen() !== 'setup');
}

function renderSetupCards() {
  const setup = store.state.setup;
  const admin = store.state.admin;
  markStep('setup-step-identity', setup.identity);
  markStep('setup-step-mesh', setup.meshSecret === 'installed');
  markStep('setup-step-credential', setup.credential);
  // Admin-lane pairing, NOT mesh membership. state.peers[].paired means only "this peer's mesh
  // publicKeyJwk is enrolled" (P1), which is true for every machine carried over from the old
  // enrollment and says nothing about the SSH trust this lane runs on. adminStatus[].paired is the
  // one that requires pinned host keys, so it is the only honest signal for this step -- reading
  // the other one told a fully-unpaired fleet it was already paired and invited the operator to
  // skip the single step that makes the lane work.
  const adminPaired = store.adminStatus.filter((s) => !s.self && s.paired).map((s) => s.machine);
  markStep('setup-step-pair', adminPaired.length > 0);

  if (!identityDirty) {
    const self = store.state.self;
    $('id-machine').value = self.machine || '';
    $('id-role').value = self.role || 'anchor';
    $('id-meship').value = self.meshIp || '';
    $('id-port').value = self.nodePort ? String(self.nodePort) : '';
  }

  statusLine(
    'setup-credential-state',
    admin.credentialStale
      ? COPY.credStale
      : admin.credentialPresent
        ? COPY.credSealed(fmtAgo(admin.credentialSetAtMs, store.state.nowMs), admin.credentialSealed)
        : COPY.credAbsent,
    admin.credentialStale ? 'dot-bad' : admin.credentialPresent ? 'dot-ok' : 'dot-warn',
  );
  // Same source as the step marker above, and it distinguishes the confusing middle state: a peer
  // that is on the mesh but has no admin-lane trust yet reads as "not paired for admin", not as
  // "no peers".
  const meshOnly = store.state.peers.filter((p) => p.paired && !adminPaired.includes(p.name)).map((p) => p.name);
  statusLine(
    'setup-pair-state',
    adminPaired.length
      ? `Paired with ${adminPaired.join(', ')}.`
      : meshOnly.length
        ? `${meshOnly.join(', ')} ${meshOnly.length === 1 ? 'is' : 'are'} on the mesh but not paired for admin yet.`
        : 'Not paired with any machine yet.',
    adminPaired.length ? 'dot-ok' : 'dot-warn',
  );

  // The one root step, as this daemon resolves it. Sent by the daemon rather than
  // composed here: the console does not know where get.sh put the checkout, and a
  // printed command naming a directory nobody has is worse than no command.
  // setText writes textContent, so nothing in it can be markup.
  if (typeof setup.elevatedCommand === 'string' && setup.elevatedCommand) {
    setText('mesh-command', setup.elevatedCommand);
  }

  const meshState = setup.meshSecret;
  const meshText =
    meshState === 'installed' ? COPY.meshStateInstalled : meshState === 'pending' ? COPY.meshStatePending : COPY.meshStateNone;
  const meshDot = meshState === 'installed' ? 'dot-ok' : meshState === 'pending' ? 'dot-warn' : 'dot-idle';
  statusLine(
    'mesh-state',
    setup.meshBindFallback ? `${meshText} ${COPY.meshAddressNotUp}` : meshText,
    setup.meshBindFallback ? 'dot-warn' : meshDot,
  );
}

function markStep(id, done) {
  const node = $(id);
  if (!node) return;
  if (!node.dataset.n) node.dataset.n = node.textContent;
  node.className = done ? 'step step-done' : 'step';
  node.textContent = done ? '✓' : node.dataset.n;
}

function renderFleet() {
  const st = store.state;
  const a = st.admin;

  let line = COPY.laneReady;
  let dot = 'dot-ok';
  if (!a.enabled) { line = COPY.laneOff; dot = 'dot-idle'; }
  else if (!a.configured) { line = COPY.laneUnconfigured; dot = 'dot-bad'; }
  else if (a.credentialStale) { line = COPY.laneStale; dot = 'dot-bad'; }
  else if (!a.credentialPresent) { line = COPY.laneNoCredential; dot = 'dot-warn'; }
  statusLine('lane-state', line, dot);

  const facts = $('lane-facts');
  clear(facts);
  addFact(facts, 'Enabled', yesNo(a.enabled));
  addFact(facts, 'Accepts admin commands', yesNo(a.acceptIncoming));
  addFact(facts, 'SSH user', a.sshUser || '—');
  addFact(facts, 'Fleet key fingerprint', a.sshKeyFingerprint || COPY.none);
  addFact(facts, 'Credential', a.credentialPresent ? `${a.credentialSealed || 'stored'} · set ${fmtAgo(a.credentialSetAtMs, st.nowMs)}` : COPY.none);
  addFact(facts, 'Run timeout', `${a.runTimeoutSec}s (max ${a.maxRunTimeoutSec}s)`);
  addFact(facts, 'Rate limit', `${a.ratePerMin}/min per machine`);

  const faults = $('faults');
  clear(faults);
  if (!st.faults.length) {
    faults.appendChild(el('p', 'empty', COPY.noFaults));
  } else {
    for (const f of st.faults) {
      const p = el('p', 'statusline');
      const dotNode = el('span', `dot ${f.urgency === 'critical' ? 'dot-bad' : 'dot-warn'}`);
      dotNode.setAttribute('aria-hidden', 'true');
      p.appendChild(dotNode);
      p.appendChild(document.createTextNode(` ${f.message}`));
      faults.appendChild(p);
      faults.appendChild(el('p', 'hint', `${f.faultClass} · ${f.urgency} · first seen ${fmtAgo(f.firstSeenMs, st.nowMs)}`));
    }
  }

  fillTable($('peers-table'), st.peers.map((p) => row([
    p.name,
    { node: el('span', 'mono', `${p.meshIp}:${p.nodePort}`) },
    p.online ? (p.syncStale ? 'online · sync stale' : 'online') : 'offline',
    fmtAgo(p.lastSeenMs, st.nowMs),
    yesNo(p.paired),
    { node: el('span', 'mono', p.sshHost || p.meshIp) },
    { node: revokeButton(p.name) },
  ])), COPY.noPeers, 7);

  fillTable($('repos-table'), st.repos.map((r) => row([
    r.name,
    { node: el('span', 'mono', r.path) },
    fmtAgo(r.lastSyncOkMs, st.nowMs),
    { node: el('span', 'mono', r.lastCommit ? r.lastCommit.slice(0, 12) : '—') },
    r.syncError || '',
  ])), COPY.noRepos, 5);
}

// Revoking is what an operator reaches for when the roamer is stolen, so it lives on the row
// rather than behind a screen. It is destructive, so the confirm names both machines first.
function revokeButton(machine) {
  const button = el('button', 'quiet danger', 'revoke');
  button.type = 'button';
  button.disabled = !store.revokeSupported;
  button.addEventListener('click', async () => {
    if (!confirm(COPY.revokeConfirm(machine, selfMachine()))) return;
    button.disabled = true;
    try {
      await postRevoke(machine);
      flash(COPY.revoked(machine), 'ok');
    } catch (err) {
      if (err.status === 404) store.revokeSupported = false;
      flash(err.message, 'bad');
    }
    await pollState();
  });
  return button;
}

function addFact(dl, key, value) {
  dl.appendChild(el('dt', null, key));
  dl.appendChild(el('dd', null, value));
}

function renderCredentials() {
  const a = store.state.admin;
  const machine = selfMachine();
  const cred = store.credentials || {};
  const seal = cred.seal || {};

  $('sudo-password-label').textContent = COPY.credPasswordLabel(a.sshUser, machine);
  $('cred-path').textContent = `${cred.path || '~/.config/sukarfleet/secrets/sudo.cred'}`;

  let line = COPY.credAbsent;
  let dot = 'dot-warn';
  if (a.credentialStale) { line = COPY.credStale; dot = 'dot-bad'; }
  else if (a.credentialPresent && a.credentialSealed === 'plaintext') { line = COPY.credPlaintext; dot = 'dot-bad'; }
  else if (a.credentialPresent) { line = COPY.credSealed(fmtAgo(a.credentialSetAtMs, store.state.nowMs), a.credentialSealed); dot = 'dot-ok'; }
  statusLine('cred-state', line, dot);

  setText('cred-seal-note', seal.ok === false ? COPY.credSealUnavailable(seal.reason) : '');
  $('sudo-remove').disabled = !a.credentialPresent;

  syncSwitch('lane-enabled', a.enabled);
  syncSwitch('lane-accept', a.acceptIncoming);

  const trust = $('trust-facts');
  clear(trust);
  addFact(trust, 'Fleet SSH key', cred.sshPublicKey || a.sshKeyFingerprint || COPY.none);
  addFact(trust, 'Key fingerprint', cred.sshKeyFingerprint || a.sshKeyFingerprint || COPY.none);
  const hostFps = cred.hostKeyFingerprints || [];
  addFact(trust, 'This machine\'s host keys', hostFps.length ? hostFps.join('\n') : COPY.none);
}

function renderAdminForm() {
  const select = $('run-machine');
  const entries = store.adminStatus.length
    ? store.adminStatus
    : store.state.peers.map((p) => ({ machine: p.name, self: false, paired: p.paired }));
  const wanted = select.value;
  const signature = entries.map((e) => `${e.machine}:${e.self ? 1 : 0}`).join('|');
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    clear(select);
    for (const e of entries) {
      const opt = el('option', null, e.self ? `${e.machine} (this machine)` : e.machine);
      opt.value = e.machine;
      select.appendChild(opt);
    }
    if (!entries.length) {
      const opt = el('option', null, COPY.noTargets);
      opt.value = '';
      select.appendChild(opt);
    }
    if (wanted && entries.some((e) => e.machine === wanted)) select.value = wanted;
  }

  const timeout = $('run-timeout');
  if (!timeout.value) timeout.value = String(store.state.admin.runTimeoutSec);
  timeout.max = String(store.state.admin.maxRunTimeoutSec);

  fillTable($('status-table'), store.adminStatus.map((s) => row([
    s.self ? `${s.machine} (this machine)` : s.machine,
    yesNo(s.paired),
    s.reachable === null ? 'not probed' : yesNo(s.reachable),
    s.credentialStale ? 'stale' : s.credentialReady ? 'ready' : 'missing',
    yesNo(s.laneEnabled),
    fmtAgo(s.lastAdminRunMs, store.state.nowMs),
  ])), COPY.noTargets, 6);

  fillTable($('runs-table'), store.runs.map((r) => {
    const open = el('button', 'quiet', 'view');
    open.type = 'button';
    open.addEventListener('click', () => { watchRun(r.runId); });
    return row([
      fmtClock(r.startedMs),
      r.machine,
      { className: 'mono', node: el('span', null, (r.argv || []).join(' ')) },
      r.running ? 'running' : r.refusal ? `refused: ${r.refusal}` : `exit ${r.exitCode}`,
      { node: open },
    ]);
  }), COPY.noRuns, 5);

  fillTable($('audit-table'), store.audit.map((e) => row([
    fmtClock(e.tsMs),
    e.seq,
    e.machine,
    e.kind,
    { className: 'mono', node: el('span', null, summarizeDetail(e.detail)) },
  ])), COPY.noAudit, 5);
}

function summarizeDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  let text;
  try { text = JSON.stringify(detail); } catch { text = ''; }
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

// ── polling ───────────────────────────────────────────────────────────────

const STATE_POLL_MS = 3000;
const RUN_POLL_MS = 400;

async function pollState() {
  try {
    const state = await api('/api/ui/state');
    if (!state || state.v !== 1) throw new ApiError(0, COPY.networkFailed);
    store.state = state;
    store.online = true;
  } catch {
    store.online = false;
  }
  render();
}

async function refreshScreen(screen) {
  try {
    if (screen === 'credentials') {
      store.credentials = normalizeCredentials(await api('/api/ui/credentials'));
    } else if (screen === 'pair') {
      store.pair = await api('/api/ui/pair/code');
    } else if (screen === 'admin') {
      const [status, runs, audit] = await Promise.all([
        api('/api/ui/admin/status').catch(() => []),
        api('/api/ui/admin/runs?limit=20').catch(() => []),
        api('/api/ui/audit?limit=40').catch(() => null),
      ]);
      store.adminStatus = Array.isArray(status) ? status : [];
      store.runs = Array.isArray(runs) ? runs : [];
      store.audit = audit && Array.isArray(audit.entries) ? audit.entries : [];
    } else if (screen === 'setup') {
      await loadMeshSecret();
    }
  } catch (err) {
    flash(err.message, 'bad');
  }
  render();
}

function onScreenEnter(screen) {
  refreshScreen(screen);
}

// The credentials endpoint composes three sources (credential status, ssh trust, seal
// availability). Read it tolerantly -- flat or nested -- so a shape tweak on the server side
// degrades to a missing field rather than a blank screen.
function normalizeCredentials(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const cred = raw.credential && typeof raw.credential === 'object' ? raw.credential : raw;
  const trust = raw.trust && typeof raw.trust === 'object' ? raw.trust : raw;
  const seal = raw.seal && typeof raw.seal === 'object' ? raw.seal
    : raw.sealAvailable && typeof raw.sealAvailable === 'object' ? raw.sealAvailable
      : {};
  return {
    present: Boolean(cred.present),
    stale: Boolean(cred.stale),
    sealed: cred.sealed || null,
    user: cred.user || '',
    setAtMs: cred.setAtMs || null,
    path: raw.path || cred.path || '',
    sshPublicKey: trust.sshPublicKey || '',
    sshKeyFingerprint: trust.sshKeyFingerprint || '',
    hostKeyFingerprints: Array.isArray(trust.hostKeyFingerprints) ? trust.hostKeyFingerprints : [],
    seal,
  };
}

// ── flash ─────────────────────────────────────────────────────────────────

let flashTimer = null;

function flash(text, kind) {
  const node = $('flash');
  node.textContent = text;
  node.className = `flash${kind ? ` flash-${kind}` : ''}`;
  node.hidden = !text;
  if (flashTimer) clearTimeout(flashTimer);
  if (text) flashTimer = setTimeout(() => { node.hidden = true; }, 12000);
}

// ── setup: identity ───────────────────────────────────────────────────────

let identityDirty = false;

function wireSetup() {
  const form = $('identity-form');
  for (const input of form.querySelectorAll('input, select')) {
    input.addEventListener('input', () => { identityDirty = true; });
  }
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const self = store.state ? store.state.self : {};
    const patch = {};
    const machine = $('id-machine').value.trim();
    const role = $('id-role').value;
    const meshIp = $('id-meship').value.trim();
    const nodePort = Number($('id-port').value);
    const networkName = $('id-network').value.trim();
    if (machine && machine !== self.machine) patch.machine = machine;
    if (role && role !== self.role) patch.role = role;
    if (meshIp && meshIp !== self.meshIp) patch.meshIp = meshIp;
    if (Number.isFinite(nodePort) && nodePort > 0 && nodePort !== self.nodePort) patch.nodePort = nodePort;
    if (networkName) patch.networkName = networkName;
    if (!Object.keys(patch).length) { result('identity-result', COPY.identityUnchanged); return; }
    try {
      const saved = await api('/api/ui/setup/identity', { method: 'POST', body: patch });
      identityDirty = false;
      result('identity-result', saved && saved.restartRequired ? COPY.identitySavedRestart : COPY.identitySaved, 'ok');
      await pollState();
    } catch (err) {
      result('identity-result', err.message, 'bad');
    }
  });

  $('mesh-generate').addEventListener('click', async () => {
    try {
      await api('/api/ui/setup/network-secret', { method: 'POST', body: { action: 'generate' } });
      result('mesh-result', COPY.meshGenerated, 'ok');
      await loadMeshSecret();
      await pollState();
    } catch (err) {
      result('mesh-result', err.message, 'bad');
    }
  });

  $('mesh-toggle-existing').addEventListener('click', () => {
    const form2 = $('mesh-form');
    form2.hidden = !form2.hidden;
    if (!form2.hidden) $('mesh-secret').focus();
  });

  $('mesh-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('mesh-secret');
    const secret = input.value.trim();
    input.value = '';
    if (!secret) return;
    try {
      await api('/api/ui/setup/network-secret', { method: 'POST', body: { action: 'stage', secret } });
      result('mesh-result', COPY.meshStaged, 'ok');
      $('mesh-form').hidden = true;
      await loadMeshSecret();
      await pollState();
    } catch (err) {
      result('mesh-result', err.message, 'bad');
    }
  });

  wireRestartButton('identity-restart', 'identity-restart-result');

  $('setup-skip').addEventListener('click', () => {
    store.setupDismissed = true;
    location.hash = '#/fleet';
    render();
  });
}

async function loadMeshSecret() {
  try {
    store.mesh = await api('/api/ui/setup/network-secret');
  } catch {
    store.mesh = null;
  }
  const secret = store.mesh && typeof store.mesh.secret === 'string' ? store.mesh.secret : '';
  $('mesh-value').value = secret;
  show($('mesh-reveal'), Boolean(secret));
}

// ── pair ──────────────────────────────────────────────────────────────────

function wirePair() {
  $('pair-mint').addEventListener('click', async () => {
    try {
      store.pair = await api('/api/ui/pair/code', { method: 'POST', body: {} });
      renderPairCode();
    } catch (err) {
      flash(err.message, 'bad');
    }
  });

  $('pair-cancel').addEventListener('click', async () => {
    try {
      store.pair = await api('/api/ui/pair/code', { method: 'DELETE' });
      renderPairCode();
    } catch (err) {
      flash(err.message, 'bad');
    }
  });

  $('redeem-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const code = $('redeem-code').value.trim().toUpperCase();
    const host = $('redeem-host').value.trim();
    const port = Number($('redeem-port').value);
    if (code.replace(/[-\s]/g, '').length !== 12) { result('redeem-result', COPY.pairBadCodeFormat, 'bad'); return; }
    result('redeem-result', COPY.pairing);
    try {
      const res = await api('/api/ui/pair/redeem', { method: 'POST', body: { code, host, port } });
      if (res && res.ok) {
        $('redeem-code').value = '';
        result('redeem-result', COPY.pairOk(res.peer || host), 'ok');
      } else {
        const reason = res && res.reason;
        const text = (reason && COPY.pairReason[reason]) || (res && res.message) || COPY.pairReason['bad-response'];
        result('redeem-result', text, 'bad');
      }
      await pollState();
    } catch (err) {
      result('redeem-result', err.message, 'bad');
    }
  });
}

function renderPairCode() {
  const pair = store.pair || (store.state ? store.state.pairing : null);
  const codeNode = $('pair-code');
  if (!pair || !pair.active) {
    show(codeNode, false);
    codeNode.textContent = '';
    show($('pair-cancel'), false);
    statusLine('pair-code-state', pair && pair.pairedWith ? COPY.pairPairedWith(pair.pairedWith) : COPY.pairInactive, 'dot-idle');
    return;
  }
  codeNode.textContent = pair.display || '';
  show(codeNode, true);
  show($('pair-cancel'), true);
  const left = pair.expiresMs ? Math.max(0, Math.round((pair.expiresMs - Date.now()) / 1000)) : 0;
  if (left <= 0) {
    statusLine('pair-code-state', COPY.pairExpired, 'dot-warn');
    return;
  }
  statusLine('pair-code-state', COPY.pairActive(fmtDuration(left), pair.attemptsLeft === undefined ? 5 : pair.attemptsLeft), 'dot-ok');
}

// ── credentials ───────────────────────────────────────────────────────────

function wireCredentials() {
  // The one place a password exists in this file. It is read into a local const, the input is
  // cleared in the same turn, and the value goes nowhere but the request body: not into
  // `store`, not into a closure that outlives the call, not into any log or message.
  $('sudo-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('sudo-password');
    const password = input.value;
    input.value = '';
    if (!password) return;
    result('sudo-result', COPY.credSaving);
    let res;
    try {
      res = await api('/api/ui/credentials/sudo', { method: 'POST', body: { password } });
    } catch (err) {
      result('sudo-result', err.message, 'bad');
      await refreshScreen('credentials');
      return;
    }
    if (res && res.ok) {
      result('sudo-result', COPY.credSaved, 'ok');
    } else {
      const reason = res && res.reason;
      const text = reason === 'verify-failed' ? COPY.credVerifyFailed
        : reason === 'seal-unavailable' ? COPY.credSealFailed
          : reason === 'not-private' ? COPY.credNotPrivate
            : (res && res.message) || COPY.credVerifyFailed;
      result('sudo-result', text, 'bad');
    }
    await refreshScreen('credentials');
    await pollState();
  });

  $('sudo-remove').addEventListener('click', async () => {
    if (!confirm(COPY.credRemoveConfirm(selfMachine()))) return;
    try {
      await api('/api/ui/credentials/sudo', { method: 'DELETE' });
      result('sudo-result', COPY.credRemoved, 'ok');
    } catch (err) {
      result('sudo-result', err.message, 'bad');
    }
    await refreshScreen('credentials');
    await pollState();
  });

  wireLaneSwitch('lane-enabled', 'enabled', COPY.laneEnabledOn, COPY.laneEnabledOff);
  wireLaneSwitch('lane-accept', 'acceptIncoming', COPY.laneAcceptOn, COPY.laneAcceptOff);
}

// The box is set from the daemon's answer, not from the click: a refused or partially applied
// patch must leave the console showing what is actually configured.
function wireLaneSwitch(id, key, onText, offText) {
  $(id).addEventListener('change', async (ev) => {
    const wanted = ev.target.checked;
    try {
      const res = await postLane({ [key]: wanted });
      const now = res && typeof res[key] === 'boolean' ? res[key] : wanted;
      ev.target.checked = now;
      result('lane-result', now ? onText : offText, 'ok');
    } catch (err) {
      ev.target.checked = !wanted;
      result('lane-result', err.message, 'bad');
    }
    await pollState();
  });
}

// A 3 s state poll must never fight the box the operator is holding.
function syncSwitch(id, value) {
  const node = $(id);
  if (node && document.activeElement !== node) node.checked = Boolean(value);
}

// ── admin ─────────────────────────────────────────────────────────────────

// POSIX-ish tokenizer: quoting and backslash escapes only. No expansion, no globbing, no
// operators -- what is typed is what is sent, and the parsed argv is shown before submit so
// there is never a guess about what the target will receive.
function tokenize(line) {
  const argv = [];
  let cur = '';
  let has = false;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '\\') {
      if (i + 1 >= n) return { error: 'trailing backslash' };
      cur += line[i + 1];
      has = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return { error: 'unclosed single quote' };
      cur += line.slice(i + 1, end);
      has = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      let closed = false;
      while (i < n) {
        const d = line[i];
        if (d === '"') { closed = true; i += 1; break; }
        if (d === '\\' && i + 1 < n && '"\\$`'.indexOf(line[i + 1]) >= 0) { cur += line[i + 1]; i += 2; continue; }
        cur += d;
        i += 1;
      }
      if (!closed) return { error: 'unclosed double quote' };
      has = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      if (has) { argv.push(cur); cur = ''; has = false; }
      i += 1;
      continue;
    }
    cur += c;
    has = true;
    i += 1;
  }
  if (has) argv.push(cur);
  return { argv };
}

function destructiveReason(line) {
  for (const [pattern, why] of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(line)) return why;
  }
  return null;
}

function renderParsed() {
  const line = $('run-command').value;
  const node = $('run-parsed');
  clear(node);
  if (!line.trim()) return;
  const parsed = tokenize(line);
  node.appendChild(el('span', 'lbl', 'sends'));
  if (parsed.error) {
    node.appendChild(el('span', 'bad', `${COPY.refusal['bad-argv']()} (${parsed.error})`));
    return;
  }
  for (const token of parsed.argv) node.appendChild(el('span', 'tok', token));

  const why = destructiveReason(line);
  const box = $('run-confirm');
  if (why) {
    setText('run-confirm-text', COPY.runConfirmPrompt($('run-machine').value || selfMachine(), why));
    show(box, true);
  } else {
    show(box, false);
    $('run-confirm-input').value = '';
  }
}

function wireAdmin() {
  $('run-command').addEventListener('input', renderParsed);
  $('run-machine').addEventListener('change', renderParsed);

  $('run-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const machine = $('run-machine').value;
    const line = $('run-command').value;
    const reason = $('run-reason').value.trim();
    const timeoutSec = Number($('run-timeout').value);
    if (!machine) { result('run-result', COPY.runNeedsTarget, 'bad'); return; }
    const parsed = tokenize(line);
    if (parsed.error || !parsed.argv || !parsed.argv.length) {
      result('run-result', parsed.error ? `${COPY.refusal['bad-argv']()} (${parsed.error})` : COPY.runNeedsCommand, 'bad');
      return;
    }
    if (!reason) { result('run-result', COPY.runNeedsReason, 'bad'); $('run-reason').focus(); return; }
    if (destructiveReason(line) && $('run-confirm-input').value.trim() !== machine) {
      result('run-result', COPY.runConfirmMismatch(machine), 'bad');
      $('run-confirm-input').focus();
      return;
    }

    const body = { machine, argv: parsed.argv, reason };
    if (Number.isFinite(timeoutSec) && timeoutSec > 0) body.timeoutSec = timeoutSec;
    result('run-result', COPY.runStarting);
    $('run-submit').disabled = true;
    try {
      const res = await api('/api/ui/admin/run', { method: 'POST', body });
      if (res && res.runId) {
        result('run-result', '');
        $('run-confirm-input').value = '';
        watchRun(res.runId);
      } else if (res && res.refusal) {
        result('run-result', refusalText(res.refusal, machine), 'bad');
      } else {
        result('run-result', COPY.networkFailed, 'bad');
      }
    } catch (err) {
      result('run-result', err.message, 'bad');
    } finally {
      $('run-submit').disabled = false;
    }
  });

  wireRestartButton('restart-daemon', 'restart-result');
}

// The fleet screen and the setup identity card both need one, and they trigger
// exactly the same POST behind the same confirm; only the element they report
// into differs.
function wireRestartButton(buttonId, resultId) {
  const button = $(buttonId);
  if (!button) return;
  button.addEventListener('click', async () => {
    if (!confirm(COPY.restartConfirm(selfMachine()))) return;
    try {
      await api('/api/ui/restart', { method: 'POST', body: {} });
      result(resultId, COPY.restarting, 'ok');
      store.online = false;
      render();
    } catch (err) {
      result(resultId, err.message, 'bad');
    }
  });
}

function refusalText(refusal, machine) {
  const fn = COPY.refusal[refusal];
  return fn ? fn(machine, selfMachine()) : `Refused: ${refusal}`;
}

let runTimer = null;

function watchRun(runId) {
  store.activeRunId = runId;
  store.activeRun = null;
  show($('run-panel'), true);
  statusLine('run-status', COPY.runStarting, 'dot-warn');
  pollRun();
}

async function pollRun() {
  if (runTimer) { clearTimeout(runTimer); runTimer = null; }
  const runId = store.activeRunId;
  if (!runId) return;
  let view;
  try {
    view = await api(`/api/ui/admin/run/${encodeURIComponent(runId)}`);
  } catch (err) {
    if (err.status === 404) {
      store.activeRun = null;
      store.activeRunId = null;
      statusLine('run-status', COPY.runLost, 'dot-warn');
      return;
    }
    // A restarted or briefly wedged daemon must not orphan a run the operator is watching.
    runTimer = setTimeout(pollRun, RUN_POLL_MS * 4);
    return;
  }
  store.activeRun = view;
  renderRun();
  if (store.activeRun && store.activeRun.running) {
    runTimer = setTimeout(pollRun, RUN_POLL_MS);
  } else if (store.activeRun) {
    refreshScreen('admin');
  }
}

function renderRun() {
  const run = store.activeRun;
  if (!run) return;
  show($('run-panel'), true);

  if (run.running) {
    const timeoutMs = (run.timeoutSec || (store.state ? store.state.admin.runTimeoutSec : 0)) * 1000;
    const left = Math.max(0, Math.round((run.startedMs + timeoutMs - Date.now()) / 1000));
    statusLine('run-status', COPY.runRunning(fmtDuration(left)), 'dot-warn');
  } else if (run.refusal) {
    statusLine('run-status', refusalText(run.refusal, run.machine), 'dot-bad');
  } else {
    const transport = run.transport || 'unknown transport';
    const text = run.ok ? COPY.runDoneOk(run.exitCode, transport, run.durationMs) : COPY.runDoneBad(run.exitCode, transport, run.durationMs);
    statusLine('run-status', text, run.ok ? 'dot-ok' : 'dot-bad');
  }

  const facts = $('run-facts');
  clear(facts);
  addFact(facts, 'Machine', run.machine);
  addFact(facts, 'Command', (run.argv || []).join(' '));
  addFact(facts, 'Reason', run.reason || '');
  addFact(facts, 'Run id', run.runId);
  addFact(facts, 'Started', fmtClock(run.startedMs));
  if (run.auditSeq !== undefined && run.auditSeq !== null) addFact(facts, 'Audit seq', run.auditSeq);
  if (run.truncated) addFact(facts, 'Note', COPY.runTruncated);

  $('run-stdout').textContent = run.stdout || '';
  $('run-stderr').textContent = run.stderr || '';
}

// ── boot ──────────────────────────────────────────────────────────────────

function wireNav() {
  window.addEventListener('hashchange', () => {
    render();
    $('main').focus();
  });
}

let statePoller = null;

function startPolling() {
  if (statePoller) clearInterval(statePoller);
  statePoller = setInterval(() => {
    if (document.hidden) return;
    pollState();
  }, STATE_POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollState();
});

// A visible second hand on the pairing code and the run countdown, without a second poll.
setInterval(() => {
  if (document.hidden) return;
  if (activeScreen() === 'pair') renderPairCode();
  if (store.activeRun && store.activeRun.running) renderRun();
}, 1000);

wireNav();
wireSetup();
wirePair();
wireCredentials();
wireAdmin();
render();
pollState();
startPolling();
