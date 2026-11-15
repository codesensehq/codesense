// SPDX-License-Identifier: MIT
//! A session log line's assistant prose, for a page that streams a running session's reply
//! (`onSessionText`): the turn it starts, the assistant prose it holds, and whether it calls a
//! tool. Never thinking or reasoning, tool input or output, injected context or a subagent's
//! rows. Each transcript format has its own row parser; the caller picks it by the format the
//! adapter reports for its session log.

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::TranscriptFormat;

/// What one session-log line says for the stream, in the order it says it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProseEvent {
    /// The person's request: a new turn starts. `key` names the row.
    Turn { key: String },
    /// Assistant prose: the joined text of an assistant row. `key` names the row, the same on
    /// every read of it.
    Prose { key: String, text: String },
    /// An assistant row that calls a tool: prose before it is progress, not the turn's final.
    Tool,
}

/// Whether `format`'s session log can be streamed as prose.
pub fn streams(format: TranscriptFormat) -> bool {
    matches!(
        format,
        TranscriptFormat::AnthropicSessionJsonl | TranscriptFormat::CodexSessionJsonl
    )
}

/// The events of one (redacted) line of a session log in `format`. A line that isn't JSON, or
/// a format that has no prose parser, says nothing.
pub fn events(format: TranscriptFormat, line: &str) -> Vec<ProseEvent> {
    let Ok(row) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    match format {
        TranscriptFormat::AnthropicSessionJsonl => anthropic_session(&row),
        TranscriptFormat::CodexSessionJsonl => rollout(&row, line),
        _ => vec![],
    }
}

fn text_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

fn flag(row: &Value, key: &str) -> bool {
    row.get(key).and_then(Value::as_bool) == Some(true)
}

/// Anthropic session JSONL: a meta or sidechain (subagent) row, a tool result, a row a
/// non-human origin wrote, or a row with no prose says nothing. Rows are named by their uuid.
fn anthropic_session(row: &Value) -> Vec<ProseEvent> {
    if flag(row, "isMeta") || flag(row, "isSidechain") {
        return vec![];
    }
    let key = text_of(row.get("uuid")).unwrap_or_default().to_owned();
    let message = row.get("message").unwrap_or(row);
    let content: Option<&Value> = message.get("content");
    match text_of(row.get("type")) {
        Some("user") => {
            if row.get("toolUseResult").is_some_and(|v| !Value::is_null(v)) {
                return vec![];
            }
            if text_of(row.pointer("/origin/kind")).is_some_and(|kind| kind != "human") {
                return vec![];
            }
            let blocks: &[Value] = content.and_then(Value::as_array).map_or(&[], |a| &a[..]);
            let answers_a_tool = blocks
                .iter()
                .any(|b| text_of(b.get("type")) == Some("tool_result"));
            let said = content.and_then(Value::as_str).is_some()
                || blocks
                    .iter()
                    .any(|b| text_of(b.get("type")) == Some("text"));
            if answers_a_tool || !said {
                return vec![];
            }
            vec![ProseEvent::Turn { key }]
        }
        Some("assistant") => {
            let blocks: &[Value] = content.and_then(Value::as_array).map_or(&[], |a| &a[..]);
            let mut prose: Vec<&str> = vec![];
            let mut tool = false;
            for block in blocks {
                match text_of(block.get("type")) {
                    Some("text") => {
                        if let Some(text) = text_of(block.get("text")) {
                            if !text.trim().is_empty() {
                                prose.push(text);
                            }
                        }
                    }
                    Some("tool_use") => tool = true,
                    _ => {}
                }
            }
            let mut out = vec![];
            if !prose.is_empty() {
                out.push(ProseEvent::Prose {
                    key,
                    text: prose.join("\n\n"),
                });
            }
            if tool {
                out.push(ProseEvent::Tool);
            }
            out
        }
        _ => vec![],
    }
}

/// A rollout row carries no id of its own: it is named by its timestamp and the hash of its
/// line, which every read of the same row gives again.
fn rollout_key(row: &Value, line: &str) -> String {
    let digest = Sha256::digest(line.as_bytes());
    let short: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}:{short}",
        text_of(row.get("timestamp")).unwrap_or_default()
    )
}

/// The Codex rollout: a user message that says something once the injected project
/// instructions and environment context are left out starts a turn, an assistant message's
/// `output_text` is prose, and a function or custom tool call is a tool marker. Reasoning,
/// tool output, developer instructions and event rows say nothing.
fn rollout(row: &Value, line: &str) -> Vec<ProseEvent> {
    if text_of(row.get("type")) != Some("response_item") {
        return vec![];
    }
    let p = &row["payload"];
    match text_of(p.get("type")) {
        Some("message") => match text_of(p.get("role")) {
            Some("user") => {
                let said = super::codex::without_injected_context(&p["content"])
                    .as_array()
                    .is_some_and(|blocks| {
                        blocks.iter().any(|b| {
                            text_of(b.get("type")) == Some("input_text")
                                && text_of(b.get("text")).is_some_and(|t| !t.trim().is_empty())
                        })
                    });
                if said {
                    vec![ProseEvent::Turn {
                        key: rollout_key(row, line),
                    }]
                } else {
                    vec![]
                }
            }
            Some("assistant") => {
                let blocks: &[Value] = p["content"].as_array().map_or(&[], |a| &a[..]);
                let prose: Vec<&str> = blocks
                    .iter()
                    .filter(|b| text_of(b.get("type")) == Some("output_text"))
                    .filter_map(|b| text_of(b.get("text")))
                    .filter(|t| !t.trim().is_empty())
                    .collect();
                if prose.is_empty() {
                    vec![]
                } else {
                    vec![ProseEvent::Prose {
                        key: rollout_key(row, line),
                        text: prose.join("\n\n"),
                    }]
                }
            }
            _ => vec![],
        },
        Some("function_call" | "custom_tool_call") => vec![ProseEvent::Tool],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: &str = include_str!("../../tests/fixtures/claude/session-2.1.296.jsonl");
    const CODEX: &str = include_str!("../../tests/fixtures/codex/rollout-0.164.0.jsonl");

    fn all(format: TranscriptFormat, log: &str) -> Vec<ProseEvent> {
        log.lines().flat_map(|l| events(format, l)).collect()
    }

    fn prose_of(events: &[ProseEvent]) -> Vec<&str> {
        events
            .iter()
            .filter_map(|e| match e {
                ProseEvent::Prose { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    /// No hidden text (thinking, reasoning, tool input or output) reaches the prose.
    fn assert_hides(prose: &[&str], log: &str, hidden: &[&str]) {
        for row in log
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        {
            for pointer in hidden {
                let Some(value) = row.pointer(pointer) else {
                    continue;
                };
                let text = value.to_string();
                for piece in text.split(['"', '\\']).filter(|p| p.len() > 12) {
                    assert!(prose.iter().all(|p| !p.contains(piece)), "{piece}");
                }
            }
        }
    }

    #[test]
    fn a_claude_tool_using_turn_yields_its_prose_and_tool_markers_never_thinking_or_tool_text() {
        let all = all(TranscriptFormat::AnthropicSessionJsonl, CLAUDE);
        // The fixture: a request, prose with a tool call (and thinking), two tool calls, the
        // answer, then a new request.
        assert!(matches!(&all[0], ProseEvent::Turn { key } if key == "u1"));
        let prose = prose_of(&all);
        assert_eq!(prose.len(), 2, "{all:?}");
        assert_eq!(all.iter().filter(|e| **e == ProseEvent::Tool).count(), 2);
        assert!(matches!(all.last(), Some(ProseEvent::Turn { key }) if key == "u4"));
        assert_hides(
            &prose,
            CLAUDE,
            &["/message/content/0/thinking", "/toolUseResult"],
        );
    }

    #[test]
    fn claude_meta_sidechain_tool_result_and_non_human_rows_say_nothing() {
        for line in [
            r#"{"type":"user","isMeta":true,"uuid":"m","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","isSidechain":true,"uuid":"s","message":{"content":[{"type":"text","text":"sub"}]}}"#,
            r#"{"type":"user","uuid":"r","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]}}"#,
            r#"{"type":"user","uuid":"o","origin":{"kind":"system"},"message":{"content":"auto"}}"#,
            r#"{"type":"assistant","uuid":"t","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}"#,
            "not json",
        ] {
            assert_eq!(
                events(TranscriptFormat::AnthropicSessionJsonl, line),
                vec![],
                "{line}"
            );
        }
    }

    #[test]
    fn a_codex_turn_yields_its_preamble_and_answer_with_a_marker_per_tool_call() {
        let all = all(TranscriptFormat::CodexSessionJsonl, CODEX);
        // The fixture: injected context, the request, reasoning, a preamble, three tool calls
        // with their outputs, a token count, the answer, then the next request.
        let kinds: Vec<&str> = all
            .iter()
            .map(|e| match e {
                ProseEvent::Turn { .. } => "turn",
                ProseEvent::Prose { .. } => "prose",
                ProseEvent::Tool => "tool",
            })
            .collect();
        assert_eq!(
            kinds,
            ["turn", "prose", "tool", "tool", "tool", "prose", "turn"],
            "{all:?}"
        );
        let prose = prose_of(&all);
        assert_hides(
            &prose,
            CODEX,
            &[
                "/payload/encrypted_content",
                "/payload/summary",
                "/payload/arguments",
                "/payload/input",
                "/payload/output",
            ],
        );
    }

    #[test]
    fn a_codex_row_is_named_the_same_on_every_read_and_apart_from_its_neighbours() {
        let first = all(TranscriptFormat::CodexSessionJsonl, CODEX);
        let again = all(TranscriptFormat::CodexSessionJsonl, CODEX);
        assert_eq!(first, again);
        let keys: Vec<&str> = first
            .iter()
            .filter_map(|e| match e {
                ProseEvent::Turn { key } | ProseEvent::Prose { key, .. } => Some(key.as_str()),
                ProseEvent::Tool => None,
            })
            .collect();
        let unique: std::collections::HashSet<&&str> = keys.iter().collect();
        assert_eq!(unique.len(), keys.len(), "{keys:?}");
    }

    #[test]
    fn codex_injected_context_developer_reasoning_and_tool_output_rows_say_nothing() {
        for line in [
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>/w</cwd>\n</environment_context>"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"be terse"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"thinking"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":"ok"}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"hello"}}"#,
        ] {
            assert_eq!(
                events(TranscriptFormat::CodexSessionJsonl, line),
                vec![],
                "{line}"
            );
        }
    }

    #[test]
    fn only_the_anthropic_and_codex_session_logs_stream() {
        assert!(streams(TranscriptFormat::AnthropicSessionJsonl));
        assert!(streams(TranscriptFormat::CodexSessionJsonl));
        assert!(!streams(TranscriptFormat::AnthropicStreamJson));
        assert!(!streams(TranscriptFormat::OpenCodeRunJson));
        assert_eq!(
            events(
                TranscriptFormat::OpenCodeRunJson,
                r#"{"type":"text","text":"hi"}"#
            ),
            vec![]
        );
    }
}
