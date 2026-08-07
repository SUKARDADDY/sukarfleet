// Popover frontend (M5). No build step, no dependency, no network asset —
// same discipline as the daemon's ui/app.js. State arrives via Tauri events.
const { event } = window.__TAURI__ ?? {};
if (event) {
  event.listen("state", (e) => {
    // M5: render peers/repos/faults from e.payload
    console.debug("state", e.payload);
  });
}
