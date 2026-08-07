// Popover renderer. No build step, no dependency, no network asset — same
// discipline as the daemon's ui/app.js. State is pushed from Rust ("state"
// events, shape = tray.rs MenuModel); initial paint via the snapshot command.
const T = window.__TAURI__;

const el = (id) => document.getElementById(id);

function section(node, heading, lines, emptyText) {
  node.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = heading;
  node.appendChild(h);
  if (!lines.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = emptyText;
    node.appendChild(p);
    return;
  }
  for (const line of lines) {
    const p = document.createElement("p");
    p.className = "line";
    p.textContent = line;
    node.appendChild(p);
  }
}

function render(m) {
  if (!m) return;
  el("dot").className = `dot ${m.state_key}`;
  el("title").textContent = m.header;
  if (m.unreachable) {
    section(el("faults"), "Daemon", ["daemon not responding"], "");
    section(el("peers"), "Peers", [], "—");
    section(el("repos"), "Repos", [], "—");
  } else {
    section(el("faults"), "Faults", m.faults, "all green");
    section(el("peers"), "Peers", m.peers, "no peers configured");
    section(el("repos"), "Repos", m.repos, "no repos adopted");
  }
  el("footer").textContent = m.console_url.replace(/^http:\/\//, "");
}

if (T) {
  T.core.invoke("snapshot").then(render).catch(() => {});
  T.event.listen("state", (e) => render(e.payload));
}
