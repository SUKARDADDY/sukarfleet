// SPDX-License-Identifier: MIT
//! Startup discovery, from flags and environment only.
//!
//! Endpoint: `--endpoint` > `SUKARFLEET_CONFIG` config.json nodePort > 7710.
//! Console token file: `--token-file` > `SUKARFLEET_TOKEN_FILE` > none.
//! Reads ONLY nodePort out of the daemon config: no secrets, no peers.

use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 7710;

/// What this process was told at startup: where the daemon is, and which file
/// holds the console token to present to it. A machine-wide install passes the
/// token file; a per-user install passes nothing and the field stays None.
pub struct Resolved {
    pub endpoint: String,
    pub token_file: Option<PathBuf>,
}

pub fn resolve() -> Resolved {
    let args: Vec<String> = std::env::args().collect();
    Resolved {
        endpoint: endpoint_from(&args),
        token_file: token_file_from(&args, std::env::var("SUKARFLEET_TOKEN_FILE").ok()),
    }
}

/// `--name value` and `--name=value`, the two forms a Run registry value or a
/// shell may carry. First occurrence wins.
fn flag_value(args: &[String], name: &str) -> Option<String> {
    let eq = format!("{name}=");
    let mut i = 0;
    while i < args.len() {
        if args[i] == name {
            return args.get(i + 1).cloned();
        }
        if let Some(rest) = args[i].strip_prefix(&eq) {
            return Some(rest.to_string());
        }
        i += 1;
    }
    None
}

fn endpoint_from(args: &[String]) -> String {
    if let Some(ep) = flag_value(args, "--endpoint") {
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

fn token_file_from(args: &[String], env: Option<String>) -> Option<PathBuf> {
    let raw = flag_value(args, "--token-file").or(env)?;
    if raw.is_empty() {
        // An empty value is how a launcher passes "no token", not a path to "".
        return None;
    }
    Some(PathBuf::from(raw))
}

fn daemon_config_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SUKARFLEET_CONFIG") {
        return Some(config_path_from_env(&p));
    }
    dirs::home_dir().map(|h| h.join(".config").join("sukarfleet").join("config.json"))
}

/// The daemon reads SUKARFLEET_CONFIG as a FILE; this app has always read it as
/// the DIRECTORY holding config.json. The machine-wide service sets it to a
/// file, so accept both: a value ending in .json is the file itself, anything
/// else is the directory it lives in.
fn config_path_from_env(value: &str) -> PathBuf {
    if value.to_ascii_lowercase().ends_with(".json") {
        PathBuf::from(value)
    } else {
        PathBuf::from(value).join("config.json")
    }
}

/// Read the console token fresh per request: it is a few dozen bytes, and a
/// token rotated under a running tray should take effect without a restart.
/// Every failure comes back as a sentence, never a panic.
pub fn read_token(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            let token = raw.trim();
            if token.is_empty() {
                Err(format!("console token file is empty: {}", path.display()))
            } else {
                Ok(token.to_string())
            }
        }
        Err(e) => Err(format!("cannot read console token file {}: {e}", path.display())),
    }
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

    fn argv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn endpoint_flag_forms() {
        assert_eq!(endpoint_from(&argv(&["app", "--endpoint", "http://x:1"])), "http://x:1");
        assert_eq!(endpoint_from(&argv(&["app", "--endpoint=http://x:2"])), "http://x:2");
    }

    #[test]
    fn token_file_flag_forms() {
        let t = |v: &[&str]| token_file_from(&argv(v), None);
        assert_eq!(t(&["app", "--token-file", "/a/console-token"]), Some(PathBuf::from("/a/console-token")));
        assert_eq!(t(&["app", "--token-file=/a/console-token"]), Some(PathBuf::from("/a/console-token")));
        assert_eq!(t(&["app", "--endpoint", "http://x:1"]), None);
        assert_eq!(t(&["app", "--token-file"]), None);
    }

    #[test]
    fn token_file_env_fallback_and_precedence() {
        assert_eq!(
            token_file_from(&argv(&["app"]), Some("/b/console-token".into())),
            Some(PathBuf::from("/b/console-token"))
        );
        assert_eq!(
            token_file_from(&argv(&["app", "--token-file=/a/t"]), Some("/b/t".into())),
            Some(PathBuf::from("/a/t"))
        );
        assert_eq!(token_file_from(&argv(&["app"]), Some(String::new())), None);
        assert_eq!(token_file_from(&argv(&["app"]), None), None);
    }

    #[test]
    fn config_env_is_file_or_directory() {
        assert_eq!(
            config_path_from_env("/etc/sukarfleet/config.json"),
            PathBuf::from("/etc/sukarfleet/config.json")
        );
        assert_eq!(
            config_path_from_env("/etc/sukarfleet/Config.JSON"),
            PathBuf::from("/etc/sukarfleet/Config.JSON")
        );
        assert_eq!(
            config_path_from_env("/etc/sukarfleet"),
            PathBuf::from("/etc/sukarfleet").join("config.json")
        );
    }

    #[test]
    fn token_is_trimmed_and_failures_are_sentences() {
        let dir = std::env::temp_dir().join(format!("sukarfleet-tray-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let ok = dir.join("console-token");
        std::fs::write(&ok, "  a-token-value\n").expect("write token");
        assert_eq!(read_token(&ok), Ok("a-token-value".to_string()));

        let empty = dir.join("empty-token");
        std::fs::write(&empty, "\n\n").expect("write empty token");
        assert!(read_token(&empty).unwrap_err().contains("is empty"));

        assert!(read_token(&dir.join("absent")).unwrap_err().contains("cannot read"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
