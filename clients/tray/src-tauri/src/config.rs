//! Endpoint discovery: --endpoint flag > SUKARFLEET_CONFIG/config.json nodePort > 7710.
//! Reads ONLY nodePort out of the daemon config — no secrets, no peers.

use std::path::PathBuf;

pub const DEFAULT_PORT: u16 = 7710;

pub fn endpoint() -> String {
    if let Some(ep) = endpoint_from_args(std::env::args().collect()) {
        return ep;
    }
    let port = daemon_config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("nodePort").and_then(|p| p.as_u64()))
        .map(|p| p as u16)
        .unwrap_or(DEFAULT_PORT);
    format!("http://127.0.0.1:{port}")
}

fn endpoint_from_args(args: Vec<String>) -> Option<String> {
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if a == "--endpoint" {
            return it.next();
        }
        if let Some(rest) = a.strip_prefix("--endpoint=") {
            return Some(rest.to_string());
        }
    }
    None
}

fn daemon_config_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SUKARFLEET_CONFIG") {
        return Some(PathBuf::from(p).join("config.json"));
    }
    dirs::home_dir().map(|h| h.join(".config").join("sukarfleet").join("config.json"))
}

pub fn state_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local")
        .join("state")
        .join("sukarfleet-tray")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_forms() {
        let a = |v: &[&str]| endpoint_from_args(v.iter().map(|s| s.to_string()).collect());
        assert_eq!(a(&["app", "--endpoint", "http://x:1"]), Some("http://x:1".into()));
        assert_eq!(a(&["app", "--endpoint=http://x:2"]), Some("http://x:2".into()));
        assert_eq!(a(&["app"]), None);
    }
}
