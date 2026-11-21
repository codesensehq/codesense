// SPDX-License-Identifier: MIT
//! The production MCP call log: one JSONL row per production `tools/call`
//! (allowed, refused or errored) and per refused method, appended by the host to
//! `<codesense_home>/mcp-calls/<YYYY-MM-DD>.jsonl` (UTC date, mode 0600, outside
//! every scope dir). A row never carries argument or result values.
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

/// How one call ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    Ok,
    Refused,
    Error,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Refused => "refused",
            Self::Error => "error",
        }
    }
}

/// Reads a session's story binding at call time; `None` when unbound.
pub(crate) type StoryOf = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Who is calling which production server, from what the launch captured and
/// the kernel-proven caller, and where the rows go.
#[derive(Clone)]
pub(crate) struct CallContext {
    pub(crate) agent: String,
    pub(crate) session: String,
    pub(crate) server: String,
    pub(crate) dir: PathBuf,
    pub(crate) story: StoryOf,
}

/// The session's story as `list_sessions` reports it, from its session record.
pub(crate) fn recorded_story(session: &str) -> Option<String> {
    let path = crate::session_usage::store_path().ok()?;
    let store = crate::session_usage::UsageStore::open(&path).ok()?;
    store
        .read_session_record(session)
        .ok()
        .flatten()?
        .story_id
        .filter(|story| !story.trim().is_empty())
}

/// The call log directory under the CodeSense home.
pub(crate) fn default_dir() -> Option<PathBuf> {
    crate::commands::paths::codesense_home_dir().map(|home| home.join("mcp-calls"))
}

impl CallContext {
    /// Appends one row. A row that cannot be written is logged, never fatal: the
    /// call itself was already decided.
    pub(crate) fn record(&self, method: &str, tool: Option<&str>, outcome: Outcome) {
        if let Err(error) = self.append(method, tool, outcome) {
            log::warn!(target: "mcp_scope", "cannot append the production MCP call log: {error}");
        }
    }

    fn append(&self, method: &str, tool: Option<&str>, outcome: Outcome) -> Result<(), String> {
        let now = chrono::Utc::now();
        let story = (self.story)(&self.session).unwrap_or_else(|| "none".into());
        let row = serde_json::json!({
            "ts": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "agent": self.agent,
            "session": self.session,
            "server": self.server,
            "method": method,
            "tool": tool.unwrap_or("-"),
            "story": story,
            "outcome": outcome.as_str(),
        });
        let mut line = serde_json::to_vec(&row).map_err(|e| e.to_string())?;
        line.push(b'\n');
        crate::commands::paths::ensure_private_dir(&self.dir)?;
        let path = self.dir.join(format!("{}.jsonl", now.format("%Y-%m-%d")));
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = codesense_platform::fs::open_nofollow_nonblocking(&mut options, &path)
            .map_err(|e| e.to_string())?;
        // One write per row on an O_APPEND descriptor, so rows never interleave.
        file.write_all(&line).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_log_rows_are_private_dated_and_carry_no_values() {
        let home = tempfile::tempdir().unwrap();
        let context = CallContext {
            agent: "acme/api/backend/triage".into(),
            session: "s-1".into(),
            server: "logs".into(),
            dir: home.path().join("mcp-calls"),
            story: Arc::new(|session| (session == "s-1").then(|| "checkout-bug".to_string())),
        };
        context.record("tools/call", Some("search_logs"), Outcome::Ok);
        let unbound = CallContext {
            session: "s-2".into(),
            ..context.clone()
        };
        unbound.record("resources/read", None, Outcome::Refused);
        let files: Vec<_> = std::fs::read_dir(home.path().join("mcp-calls"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1);
        let name = files[0].file_name().unwrap().to_str().unwrap().to_string();
        assert_eq!(
            name,
            format!("{}.jsonl", chrono::Utc::now().format("%Y-%m-%d"))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&files[0]).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let rows: Vec<serde_json::Value> = std::fs::read_to_string(&files[0])
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["tool"], "search_logs");
        assert_eq!(rows[0]["story"], "checkout-bug");
        assert_eq!(rows[0]["outcome"], "ok");
        assert_eq!(rows[1]["method"], "resources/read");
        assert_eq!(rows[1]["tool"], "-");
        assert_eq!(rows[1]["story"], "none");
        assert_eq!(rows[1]["outcome"], "refused");
        for row in &rows {
            let keys: Vec<_> = row.as_object().unwrap().keys().cloned().collect();
            assert_eq!(
                keys,
                ["agent", "method", "outcome", "server", "session", "story", "tool", "ts"]
            );
        }
    }
}
