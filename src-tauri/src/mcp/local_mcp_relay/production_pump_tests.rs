// SPDX-License-Identifier: MIT
//! The production policy in the relay pump, against a scripted downstream that
//! counts every method and tool call it receives.
use super::*;
use serde_json::json;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex as StdMutex;
use tokio::io::{ReadHalf, WriteHalf};

/// What the scripted server received.
#[derive(Default)]
struct Seen {
    methods: BTreeMap<String, usize>,
    calls: BTreeMap<String, usize>,
    /// Errors the relay sent back for the server's own requests.
    refused_requests: Vec<Value>,
}

/// How the scripted server behaves; shared across reconnects.
#[derive(Default)]
struct Script {
    seen: StdMutex<Seen>,
    /// After a change, the first page lists `annotate_logs` as read-only and
    /// no longer lists `read_logs`.
    changed: AtomicBool,
    fail_list: AtomicBool,
    connects: AtomicUsize,
}

enum Control {
    Send(Value),
    Close,
}

struct Fake {
    sent: mpsc::UnboundedSender<Value>,
    replies: mpsc::UnboundedReceiver<rmcp::model::ServerJsonRpcMessage>,
}

impl Transport<RoleClient> for Fake {
    type Error = std::io::Error;
    fn send(
        &mut self,
        message: ClientJsonRpcMessage,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send + 'static {
        let result = self.sent.send(serde_json::to_value(message).unwrap());
        async move { result.map_err(std::io::Error::other) }
    }
    async fn receive(&mut self) -> Option<rmcp::model::ServerJsonRpcMessage> {
        self.replies.recv().await
    }
    async fn close(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

fn tool(name: &str, annotations: Value) -> Value {
    json!({"name": name, "inputSchema": {"type": "object"}, "annotations": annotations})
}

fn page(script: &Script, cursor: Option<&str>) -> Value {
    let changed = script.changed.load(Ordering::SeqCst);
    match (cursor, changed) {
        (None, false) => json!({"tools": [
            tool("read_logs", json!({"readOnlyHint": true})),
            json!({"name": "annotate_logs", "inputSchema": {"type": "object"}}),
            tool("broken", json!({})),
        ], "nextCursor": "p2"}),
        (None, true) => json!({"tools": [
            tool("annotate_logs", json!({"readOnlyHint": true})),
        ], "nextCursor": "p2"}),
        (Some(_), _) => json!({"tools": [
            tool("delete_monitor", json!({"readOnlyHint": true, "destructiveHint": true})),
            tool("count_errors", json!({"readOnlyHint": true})),
        ]}),
    }
}

/// One downstream connection: answers what the relay sends, as `script` says.
fn connect_script(
    script: Arc<Script>,
    control: Arc<StdMutex<Option<mpsc::UnboundedSender<Control>>>>,
) -> Fake {
    script.connects.fetch_add(1, Ordering::SeqCst);
    let (sent, mut requests) = mpsc::unbounded_channel::<Value>();
    let (replies, rx) = mpsc::unbounded_channel();
    let (tx, mut controls) = mpsc::unbounded_channel();
    *control.lock().unwrap() = Some(tx);
    tokio::spawn(async move {
        let reply = |value: Value| replies.send(serde_json::from_value(value).unwrap()).is_ok();
        loop {
            tokio::select! {
                control = controls.recv() => match control {
                    Some(Control::Send(value)) => { reply(value); }
                    Some(Control::Close) | None => return,
                },
                request = requests.recv() => {
                    let Some(request) = request else { return };
                    let id = request.get("id").cloned();
                    let Some(method) = request.get("method").and_then(Value::as_str) else {
                        script.seen.lock().unwrap().refused_requests.push(request);
                        continue;
                    };
                    *script.seen.lock().unwrap().methods.entry(method.into()).or_default() += 1;
                    let Some(id) = id else { continue };
                    let result = match method {
                        "initialize" => json!({"protocolVersion": "2024-11-05",
                            "capabilities": {"tools": {"listChanged": true}},
                            "serverInfo": {"name": "stub", "version": "1"}}),
                        "tools/list" if script.fail_list.load(Ordering::SeqCst) => {
                            reply(json!({"jsonrpc": "2.0", "id": id,
                                "error": {"code": -32603, "message": "listing failed"}}));
                            continue;
                        }
                        "tools/list" => page(&script, request.pointer("/params/cursor").and_then(Value::as_str)),
                        "tools/call" => {
                            let name = request.pointer("/params/name").and_then(Value::as_str).unwrap_or("").to_string();
                            *script.seen.lock().unwrap().calls.entry(name.clone()).or_default() += 1;
                            json!({"content": [{"type": "text", "text": "done"}], "isError": name == "broken"})
                        }
                        _ => json!({}),
                    };
                    if !reply(json!({"jsonrpc": "2.0", "id": id, "result": result})) { return; }
                }
            }
        }
    });
    Fake { sent, replies: rx }
}

struct Harness {
    write: WriteHalf<tokio::io::DuplexStream>,
    read: BufReader<ReadHalf<tokio::io::DuplexStream>>,
    script: Arc<Script>,
    control: Arc<StdMutex<Option<mpsc::UnboundedSender<Control>>>>,
    /// Notifications the relay forwarded to the CLI.
    notifications: Vec<Value>,
    logs: tempfile::TempDir,
    task: tokio::task::JoinHandle<Result<(), String>>,
}

fn context(dir: &std::path::Path, session: &str) -> super::super::call_log::CallContext {
    super::super::call_log::CallContext {
        agent: "acme/api/backend/triage".into(),
        session: session.into(),
        server: "logs".into(),
        dir: dir.to_path_buf(),
        story: Arc::new(|session| (session == "bound").then(|| "checkout-bug".to_string())),
    }
}

impl Harness {
    fn start(write_tools: &[&str], session: &str) -> Self {
        let script = Arc::new(Script::default());
        let control = Arc::new(StdMutex::new(None));
        let logs = tempfile::tempdir().unwrap();
        let policy = ProductionPolicy {
            write: write_tools
                .iter()
                .map(|t| t.to_string())
                .collect::<BTreeSet<_>>(),
            log: context(&logs.path().join("mcp-calls"), session),
        };
        let server = Server {
            endpoint: Endpoint::Http {
                url: "https://mcp.example.com/mcp".into(),
                headers: Default::default(),
            },
            enabled_tools: None,
            disabled_tools: Default::default(),
        };
        let (client, relay) = tokio::io::duplex(1 << 20);
        let (connect_script_state, connect_control) = (script.clone(), control.clone());
        let task = tokio::spawn(async move {
            pump(
                &server,
                relay,
                Arc::new(|| Box::pin(async { Ok(()) })),
                move |_| {
                    std::future::ready(Ok(connect_script(
                        connect_script_state.clone(),
                        connect_control.clone(),
                    )))
                },
                Failures::default(),
                None,
                false,
                Some(policy),
            )
            .await
        });
        let (read, write) = tokio::io::split(client);
        Self {
            write,
            read: BufReader::new(read),
            script,
            control,
            notifications: Vec::new(),
            logs,
            task,
        }
    }

    async fn send(&mut self, message: Value) {
        write_message(&mut self.write, &message).await.unwrap();
    }

    /// Sends a request and returns its answer, keeping forwarded notifications.
    async fn request(&mut self, id: i64, method: &str, params: Value) -> Value {
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await;
        loop {
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(5), self.read.read_line(&mut line))
                .await
                .expect("the relay answers")
                .unwrap();
            let value: Value = serde_json::from_str(&line).unwrap();
            if value.get("id") == Some(&json!(id)) {
                return value;
            }
            self.notifications.push(value);
        }
    }

    async fn call(&mut self, id: i64, tool: &str) -> Value {
        self.request(
            id,
            "tools/call",
            json!({"name": tool, "arguments": {"query": "arg-value-9c1d"}}),
        )
        .await
    }

    async fn initialize(&mut self) -> Value {
        let reply = self
            .request(
                0,
                "initialize",
                json!({"protocolVersion": "2024-11-05",
                "capabilities": {}, "clientInfo": {"name": "cli", "version": "1"}}),
            )
            .await;
        self.send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .await;
        reply
    }

    fn method_count(&self, method: &str) -> usize {
        self.script
            .seen
            .lock()
            .unwrap()
            .methods
            .get(method)
            .copied()
            .unwrap_or(0)
    }

    fn calls(&self, tool: &str) -> usize {
        self.script
            .seen
            .lock()
            .unwrap()
            .calls
            .get(tool)
            .copied()
            .unwrap_or(0)
    }

    /// Waits until the server has answered `lists` tools/list requests in all
    /// and the relay has had a moment to take the last page.
    async fn wait_lists(&self, lists: usize) {
        for _ in 0..200 {
            if self.method_count("tools/list") >= lists {
                tokio::time::sleep(Duration::from_millis(50)).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the relay never listed the tools {lists} times");
    }

    fn inject(&self, value: Value) {
        if let Some(control) = self.control.lock().unwrap().as_ref() {
            control.send(Control::Send(value)).unwrap();
        }
    }

    fn rows(&self) -> Vec<Value> {
        let dir = self.logs.path().join("mcp-calls");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        entries
            .flat_map(|entry| {
                std::fs::read_to_string(entry.unwrap().path())
                    .unwrap()
                    .lines()
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect::<Vec<Value>>()
            })
            .collect()
    }

    fn raw_log(&self) -> String {
        std::fs::read_dir(self.logs.path().join("mcp-calls"))
            .map(|entries| {
                entries
                    .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
                    .collect()
            })
            .unwrap_or_default()
    }

    async fn finish(self) {
        drop(self.write);
        drop(self.read);
        let _ = tokio::time::timeout(Duration::from_secs(5), self.task).await;
    }
}

fn error_code(reply: &Value) -> Option<i64> {
    reply.pointer("/error/code").and_then(Value::as_i64)
}

#[tokio::test]
async fn read_only_default_lists_and_calls_only_annotated_read_tools() {
    let mut h = Harness::start(&[], "bound");
    h.initialize().await;
    h.wait_lists(2).await;
    let listed = h.request(1, "tools/list", json!({})).await;
    let names: Vec<_> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["read_logs"]);
    assert!(h.call(2, "read_logs").await.get("result").is_some());
    assert!(
        h.call(3, "count_errors").await.get("result").is_some(),
        "page 2 was read"
    );
    for (id, refused) in [(4, "annotate_logs"), (5, "delete_monitor")] {
        let reply = h.call(id, refused).await;
        assert_eq!(error_code(&reply), Some(-32602), "{reply}");
        assert!(reply["error"]["message"]
            .as_str()
            .unwrap()
            .contains(refused));
        assert_eq!(h.calls(refused), 0, "{refused} never reaches the server");
    }
    assert_eq!(h.calls("read_logs"), 1);
    h.finish().await;
}

#[tokio::test]
async fn write_opt_in_enables_only_the_named_tool() {
    let mut h = Harness::start(&["annotate_logs"], "bound");
    h.initialize().await;
    h.wait_lists(2).await;
    let listed = h.request(1, "tools/list", json!({})).await;
    assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 2);
    assert!(h.call(2, "annotate_logs").await.get("result").is_some());
    assert_eq!(error_code(&h.call(3, "delete_monitor").await), Some(-32602));
    assert_eq!(
        (h.calls("annotate_logs"), h.calls("delete_monitor")),
        (1, 0)
    );
    h.finish().await;
}

#[tokio::test]
async fn call_before_relay_list_is_refused() {
    let mut h = Harness::start(&[], "bound");
    h.request(
        0,
        "initialize",
        json!({"protocolVersion": "2024-11-05",
        "capabilities": {}, "clientInfo": {"name": "cli", "version": "1"}}),
    )
    .await;
    // Before the CLI's initialized notification the relay has listed nothing.
    let reply = h.call(1, "read_logs").await;
    assert_eq!(
        error_code(&reply),
        Some(-32002),
        "refused, not held: {reply}"
    );
    assert_eq!(h.calls("read_logs"), 0);
    assert_eq!(h.method_count("tools/list"), 0);
    h.finish().await;
}

#[tokio::test]
async fn paginated_list_and_list_changed_reset_the_permitted_set() {
    let mut h = Harness::start(&[], "bound");
    h.initialize().await;
    h.wait_lists(2).await;
    assert!(h.call(1, "read_logs").await.get("result").is_some());
    assert!(h.call(2, "count_errors").await.get("result").is_some());
    h.script.changed.store(true, Ordering::SeqCst);
    h.inject(json!({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}));
    h.wait_lists(4).await;
    let reply = h.call(3, "read_logs").await;
    assert_eq!(error_code(&reply), Some(-32602), "{reply}");
    assert!(h.call(4, "annotate_logs").await.get("result").is_some());
    assert!(
        h.notifications
            .iter()
            .any(|n| n["method"] == "notifications/tools/list_changed"),
        "list_changed reaches the CLI"
    );
    assert_eq!(h.calls("read_logs"), 1);
    h.finish().await;
}

#[tokio::test]
async fn reconnect_rebuilds_the_permitted_set_without_the_cli() {
    let mut h = Harness::start(&[], "bound");
    h.initialize().await;
    h.wait_lists(2).await;
    assert!(h.call(1, "read_logs").await.get("result").is_some());
    if let Some(control) = h.control.lock().unwrap().take() {
        control.send(Control::Close).unwrap();
    }
    // The relay replays initialize, then lists both pages itself.
    h.wait_lists(4).await;
    assert_eq!(h.script.connects.load(Ordering::SeqCst), 2);
    assert_eq!(h.method_count("initialize"), 2);
    assert!(h.call(2, "read_logs").await.get("result").is_some());
    assert_eq!(error_code(&h.call(3, "annotate_logs").await), Some(-32602));
    h.finish().await;
}

#[tokio::test]
async fn failed_rebuild_refuses_calls() {
    let mut h = Harness::start(&[], "bound");
    h.initialize().await;
    h.wait_lists(2).await;
    h.script.fail_list.store(true, Ordering::SeqCst);
    h.inject(json!({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}));
    h.wait_lists(3).await;
    let reply = h.call(1, "read_logs").await;
    assert_eq!(error_code(&reply), Some(-32002), "{reply}");
    assert_eq!(h.calls("read_logs"), 0);
    h.finish().await;
}

#[tokio::test]
async fn startup_list_probes_answered_locally() {
    let mut h = Harness::start(&[], "bound");
    h.initialize().await;
    for (id, method, field) in [
        (1, "resources/list", "resources"),
        (2, "resources/templates/list", "resourceTemplates"),
        (3, "prompts/list", "prompts"),
    ] {
        let reply = h.request(id, method, json!({})).await;
        assert_eq!(reply["result"][field], json!([]), "{method}");
        assert_eq!(
            h.method_count(method),
            0,
            "{method} never reaches the server"
        );
    }
    assert!(h.rows().is_empty(), "local answers are not logged");
    h.finish().await;
}

#[tokio::test]
async fn non_tool_methods_refused_and_logged() {
    let mut h = Harness::start(&[], "bound");
    h.initialize().await;
    h.wait_lists(2).await;
    for (id, method) in [
        (1, "resources/read"),
        (2, "prompts/get"),
        (3, "completion/complete"),
    ] {
        let reply = h.request(id, method, json!({"uri": "x"})).await;
        assert_eq!(error_code(&reply), Some(-32601), "{method}");
        assert_eq!(
            h.method_count(method),
            0,
            "{method} never reaches the server"
        );
    }
    // The server's own request gets an error and never reaches the CLI.
    h.inject(json!({"jsonrpc": "2.0", "id": "server-1", "method": "sampling/createMessage", "params": {}}));
    assert!(h.call(4, "read_logs").await.get("result").is_some());
    tokio::time::sleep(Duration::from_millis(50)).await;
    let refused = h.script.seen.lock().unwrap().refused_requests.clone();
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0]["id"], "server-1");
    assert!(refused[0].get("error").is_some());
    assert!(!h
        .notifications
        .iter()
        .any(|n| n["method"] == "sampling/createMessage"));
    let rows = h.rows();
    let refused_rows: Vec<_> = rows.iter().filter(|r| r["outcome"] == "refused").collect();
    assert_eq!(refused_rows.len(), 3);
    for row in refused_rows {
        assert_eq!(row["tool"], "-");
    }
    h.finish().await;
}

#[tokio::test]
async fn call_log_one_row_per_call_without_arguments() {
    let mut h = Harness::start(&["broken"], "bound");
    h.initialize().await;
    h.wait_lists(2).await;
    assert!(h.call(1, "read_logs").await.get("result").is_some());
    assert_eq!(error_code(&h.call(2, "annotate_logs").await), Some(-32602));
    let errored = h.call(3, "broken").await;
    assert_eq!(errored["result"]["isError"], true);
    assert_eq!(
        error_code(&h.request(4, "resources/read", json!({})).await),
        Some(-32601)
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    let rows = h.rows();
    assert_eq!(rows.len(), 4, "{rows:?}");
    let outcomes: Vec<_> = rows
        .iter()
        .map(|r| {
            (
                r["method"].as_str().unwrap(),
                r["tool"].as_str().unwrap(),
                r["outcome"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        outcomes,
        [
            ("tools/call", "read_logs", "ok"),
            ("tools/call", "annotate_logs", "refused"),
            ("tools/call", "broken", "error"),
            ("resources/read", "-", "refused"),
        ]
    );
    for row in &rows {
        assert_eq!(row["agent"], "acme/api/backend/triage");
        assert_eq!(row["session"], "bound");
        assert_eq!(row["server"], "logs");
        assert_eq!(row["story"], "checkout-bug");
        assert!(row.get("arguments").is_none() && row.get("result").is_none());
    }
    assert!(
        !h.raw_log().contains("arg-value-9c1d"),
        "no argument values"
    );
    h.finish().await;

    // A call from a session with no story binding logs `story: none`.
    let mut unbound = Harness::start(&[], "unbound");
    unbound.initialize().await;
    unbound.wait_lists(2).await;
    assert!(unbound.call(1, "read_logs").await.get("result").is_some());
    tokio::time::sleep(Duration::from_millis(50)).await;
    let rows = unbound.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["story"], "none");
    unbound.finish().await;
}
