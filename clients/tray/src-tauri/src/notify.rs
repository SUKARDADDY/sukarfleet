//! App-side fault notifications: diff the fault-key set per tick, coalesce
//! into ONE notification, persist seen keys so a tray restart never
//! re-announces a latched week-old fault. No repeat cadence — the icon
//! staying red IS the nag.

use crate::model::UiFault;
use std::collections::HashSet;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

pub struct Notifier {
    seen: HashSet<String>,
    seeded: bool,
    path: PathBuf,
}

impl Notifier {
    pub fn load(state_dir: PathBuf) -> Self {
        let path = state_dir.join("seen.json");
        let seen = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .map(|v| v.into_iter().collect())
            .unwrap_or_default();
        // A persisted set counts as seeded: restarts must not re-announce.
        let seeded = path.exists();
        Self { seen, seeded, path }
    }

    pub fn tick(&mut self, app: &AppHandle, faults: &[UiFault], suppress: bool) {
        let current: HashSet<String> = faults.iter().map(|f| f.key.clone()).collect();

        if !self.seeded {
            // First successful poll after first-ever launch: seed, don't fire.
            self.seen = current;
            self.seeded = true;
            self.persist();
            return;
        }
        if suppress {
            // Grace/unreachable: hold the diff. A fault that appears AND clears
            // inside the window is never announced; one that persists is
            // announced once when suppression lifts.
            return;
        }

        let added: Vec<&UiFault> = faults.iter().filter(|f| !self.seen.contains(&f.key)).collect();
        let cleared = self.seen.iter().any(|k| !current.contains(k));

        if !added.is_empty() {
            let (title, body) = coalesce(&added);
            self.send(app, &title, &body);
        } else if cleared && current.is_empty() {
            self.send(app, "sukarfleet: fleet recovered", "all faults cleared");
        }

        if current != self.seen {
            self.seen = current;
            self.persist();
        }
    }

    fn send(&self, app: &AppHandle, title: &str, body: &str) {
        if let Err(e) = app.notification().builder().title(title).body(body).show() {
            // Dead session bus etc. — log once per attempt, never retry/queue.
            eprintln!("sukarfleet-tray: notification not delivered: {e}");
        }
    }

    fn persist(&self) {
        let Ok(json) = serde_json::to_string(&self.seen.iter().collect::<Vec<_>>()) else { return };
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, &json).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            }
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }
}

fn coalesce(added: &[&UiFault]) -> (String, String) {
    if added.len() == 1 {
        let f = added[0];
        return (format!("sukarfleet: {}", f.fault_class), f.message.clone());
    }
    let title = format!("sukarfleet: {} faults", added.len());
    let mut lines: Vec<String> =
        added.iter().take(3).map(|f| format!("{}: {}", f.fault_class, f.message)).collect();
    if added.len() > 3 {
        lines.push(format!("+{} more", added.len() - 3));
    }
    (title, lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fault(key: &str) -> UiFault {
        UiFault {
            key: key.into(),
            fault_class: key.split(':').next().unwrap_or(key).into(),
            message: format!("{key} message"),
            urgency: "critical".into(),
            first_seen_ms: 0,
        }
    }

    #[test]
    fn coalesce_shapes() {
        let a = fault("peer-offline:beta");
        let (t, b) = coalesce(&[&a]);
        assert_eq!(t, "sukarfleet: peer-offline");
        assert_eq!(b, "peer-offline:beta message");

        let faults: Vec<UiFault> = (0..5).map(|i| fault(&format!("f{i}"))).collect();
        let refs: Vec<&UiFault> = faults.iter().collect();
        let (t, b) = coalesce(&refs);
        assert_eq!(t, "sukarfleet: 5 faults");
        assert!(b.ends_with("+2 more"));
        assert_eq!(b.lines().count(), 4);
    }
}
