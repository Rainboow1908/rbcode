//! MCP（Model Context Protocol）客户端。
//!
//! 由本机执行器拉起 MCP 服务器子进程，走 stdio + 一行一个 JSON 的 JSON-RPC
//! （协议版本 `2024-11-05`，与实测的 `@playwright/mcp` 一致）。
//!
//! 隔离策略：实例按「项目根目录 + 服务器 id」缓存 —— 不同项目各起一份进程，
//! 子进程的工作目录就是项目根；内置浏览器还会把 profile / 输出目录放进
//! `<项目>/.rbcode/mcp/playwright/`。所以两个项目互不影响（同一个文件夹 = 同一份）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 启动 + initialize 的超时（`npx` 首次可能要下载包，给足时间）
const START_TIMEOUT: Duration = Duration::from_secs(120);
/// 单次 tools/list、tools/call 的超时
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const PROTOCOL_VERSION: &str = "2024-11-05";
/// 报错时带上 stderr 尾部这么多字符，方便定位
const STDERR_TAIL: usize = 400;

/* ------------------------------------ 描述 ------------------------------------ */

/// 一个 MCP 服务器的启动描述
#[derive(Clone, Debug, PartialEq)]
pub struct McpSpec {
    /// 稳定 id（内置的是 `browser`）；也用来命名缓存目录
    pub id: String,
    /// 展示名
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    /// 额外环境变量
    pub env: Vec<(String, String)>,
    /// 工作目录（不填 = 项目根）
    pub cwd: Option<String>,
    /// 声明给服务器的 workspace roots。
    /// 它同时决定两件事：**第一个**是「带显式文件名的产出」的落点，整体是文件访问的边界。
    pub roots: Vec<String>,
}

impl McpSpec {
    /// 这个项目下、这个服务器的缓存目录
    pub fn cache_dir(&self, root: &str) -> PathBuf {
        PathBuf::from(root)
            .join(".rbcode")
            .join("mcp")
            .join(sanitize(&self.id))
    }

    fn work_dir(&self, root: &str) -> PathBuf {
        match &self.cwd {
            Some(value) if !value.trim().is_empty() => PathBuf::from(value),
            _ => PathBuf::from(root),
        }
    }
}

/// 产出目录（**对模型开放**）：`<项目>/.mcp_output/<id>`
///
/// 内部缓存（profile、浏览器内核、工具清单）仍在 `<项目>/.rbcode/mcp/<id>`，不对模型开放。
fn model_output_dir(root: &str, id: &str) -> PathBuf {
    PathBuf::from(root).join(".mcp_output").join(sanitize(id))
}

/// npm / npx 的包缓存目录（项目内，长期复用，不走用户全局缓存）
fn npm_cache_dir(root: &str) -> PathBuf {
    PathBuf::from(root).join(".rbcode").join("mcp").join("npm-cache")
}

/// 把 id 变成安全的目录名（只留字母数字和 `-` `_` `.`）
fn sanitize(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "server".to_string()
    } else {
        cleaned
    }
}

/// 内置的浏览器 MCP（Playwright）：profile 与输出目录都落在项目下，天然按项目隔离
pub fn builtin_spec(
    root: &str,
    browser: Option<&str>,
    proxy: Option<&str>,
    headless: bool,
) -> McpSpec {
    let mut spec = McpSpec {
        id: "browser".to_string(),
        name: "Browser".to_string(),
        command: "npx".to_string(),
        args: Vec::new(),
        env: Vec::new(),
        cwd: None,
        roots: Vec::new(),
    };

    // 内部缓存（profile / 浏览器内核 / 工具清单）放 .rbcode，**不对模型开放**
    let cache = spec.cache_dir(root);
    // 产出（截图等）放工作目录下的 .mcp_output/<id>，这个目录**对模型开放**
    let output = model_output_dir(root, &spec.id);

    let mut args = vec![
        "-y".to_string(),
        "@playwright/mcp@latest".to_string(),
    ];
    if headless {
        args.push("--headless".to_string());
    }
    args.extend([
        "--browser".to_string(),
        browser.unwrap_or("msedge").to_string(),
        "--user-data-dir".to_string(),
        cache.join("profile").to_string_lossy().into_owned(),
        "--output-dir".to_string(),
        output.to_string_lossy().into_owned(),
    ]);
    if let Some(raw) = proxy {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            args.push("--proxy-server".to_string());
            args.push(trimmed.to_string());
        }
    }
    spec.args = args;
    // cwd 跟 roots 一致，免得相对路径的文件操作落到边界外被拒
    spec.cwd = Some(output.to_string_lossy().into_owned());
    // 声明 roots：唯一的 root 就是 .mcp_output/<id>。它同时决定两件事 ——
    // 「带显式文件名的产出」按**第一个 root** 解析（实测），以及文件访问边界：
    // 边界内只有这个目录，所以 `.rbcode` 对模型不可见。
    spec.roots = vec![output.to_string_lossy().into_owned()];
    // 浏览器本体也留在项目里：默认 chromium，首次会下到 <项目>/.rbcode/mcp/browser/browsers
    spec.env = vec![(
        "PLAYWRIGHT_BROWSERS_PATH".to_string(),
        cache.join("browsers").to_string_lossy().into_owned(),
    )];
    spec
}

/* ------------------------------------ 客户端 ------------------------------------ */

struct McpEntry {
    spec: McpSpec,
    client: McpClient,
}

struct McpClient {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    stderr: Arc<Mutex<String>>,
    next_id: u64,
    /// `initialize` 之后 tools/list 拿到的工具（原样保存，供前端转成 schema）
    tools: Vec<Value>,
    /// 声明给服务器的 workspace roots（服务器会反过来问 roots/list）
    roots: Vec<String>,
}

impl McpClient {
    fn start(spec: &McpSpec, root: &str) -> Result<Self, String> {
        let work_dir = spec.work_dir(root);
        std::fs::create_dir_all(&work_dir)
            .map_err(|err| format!("创建 MCP 工作目录失败：{err}"))?;
        let cache = spec.cache_dir(root);
        std::fs::create_dir_all(&cache).map_err(|err| format!("创建 MCP 缓存目录失败：{err}"))?;
        // MCP 会往项目里写两个目录，都别让用户提交进 git：
        //   .rbcode/mcp/    内部缓存（profile、浏览器内核、工具清单）
        //   .mcp_output/    产出（截图等，对模型开放）
        for dir in [".rbcode/mcp", ".mcp_output"] {
            let ignore = PathBuf::from(root).join(dir).join(".gitignore");
            if !ignore.exists() {
                if let Some(parent) = ignore.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&ignore, "*\n");
            }
        }

        let mut command = spawn_command(spec);
        command
            .current_dir(&work_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 让子进程也知道自己的项目根与缓存目录（自定义服务器可以用）
            .env("RBCODE_MCP_ROOT", root)
            .env("RBCODE_MCP_CACHE", cache.to_string_lossy().to_string())
            // npx / npm 的包缓存也收进项目：默认会落到用户全局 %LOCALAPPDATA%\npm-cache
            // （不随项目走，还吃 C: 盘）。放 <项目>/.rbcode/mcp/npm-cache，长期复用。
            .env("npm_config_cache", npm_cache_dir(root));
        for (key, value) in &spec.env {
            command.env(key, value);
        }

        let mut child = command
            .spawn()
            .map_err(|err| format!("启动 MCP 服务器 `{}` 失败：{err}", spec.command))?;

        let stdin = child.stdin.take().ok_or("拿不到 MCP 服务器的 stdin")?;
        let stdout = child.stdout.take().ok_or("拿不到 MCP 服务器的 stdout")?;
        let stderr_pipe = child.stderr.take();

        let (tx, rx) = mpsc::channel::<Value>();
        std::thread::spawn(move || read_loop(stdout, tx));

        let stderr = Arc::new(Mutex::new(String::new()));
        if let Some(pipe) = stderr_pipe {
            let sink = Arc::clone(&stderr);
            std::thread::spawn(move || drain_stderr(pipe, sink));
        }

        let mut client = McpClient {
            child,
            stdin,
            rx,
            stderr,
            next_id: 0,
            tools: Vec::new(),
            roots: spec.roots.clone(),
        };
        client.handshake()?;
        // 把工具清单缓存下来：下次就能在「不启动进程」的情况下把工具交给模型
        write_tools_cache(spec, root, &client.tools);
        Ok(client)
    }

    /// initialize + notifications/initialized + tools/list
    fn handshake(&mut self) -> Result<(), String> {
        // 有 roots 就声明 roots 能力 —— 服务器会反过来问 roots/list（见 answer_server_request）
        let capabilities = if self.roots.is_empty() {
            json!({})
        } else {
            json!({ "roots": { "listChanged": false } })
        };
        self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": capabilities,
                "clientInfo": {
                    "name": "rbcode-companion",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }),
            START_TIMEOUT,
        )?;
        self.notify("notifications/initialized", json!({}))?;

        let result = self.request("tools/list", json!({}), CALL_TIMEOUT)?;
        self.tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(())
    }

    fn call(&mut self, tool: &str, args: Value) -> Result<Value, String> {
        self.request(
            "tools/call",
            json!({ "name": tool, "arguments": args }),
            CALL_TIMEOUT,
        )
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_line(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;

        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("{method} 超时（{}s）", timeout.as_secs()));
            }
            match self.rx.recv_timeout(remaining) {
                Ok(message) => {
                    // 服务器的反向请求（roots/list 等）：当场应答，否则它会一直等我们
                    if let Some(method) = message.get("method").and_then(Value::as_str) {
                        if let Some(request_id) = message.get("id").cloned() {
                            let method = method.to_string();
                            self.answer_server_request(&method, &request_id)?;
                        }
                        continue; // 通知（没有 id）也走这里，跳过
                    }
                    // 通知、别人的响应：跳过
                    if message.get("id").and_then(Value::as_u64) != Some(id) {
                        continue;
                    }
                    if let Some(error) = message.get("error") {
                        let text = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown error");
                        return Err(format!("{method} 失败：{text}"));
                    }
                    return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!("{method} 超时（{}s）", timeout.as_secs()))
                }
                Err(RecvTimeoutError::Disconnected) => {
                    let detail = self.stderr.lock().map(|text| text.clone()).unwrap_or_default();
                    return Err(format!(
                        "{method} 失败：MCP 服务器已退出。{}",
                        tail(&detail, STDERR_TAIL)
                    ));
                }
            }
        }
    }

    fn write_line(&mut self, value: &Value) -> Result<(), String> {
        let mut line = value.to_string();
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .map_err(|err| format!("写入 MCP 请求失败：{err}"))?;
        self.stdin
            .flush()
            .map_err(|err| format!("发送 MCP 请求失败：{err}"))
    }

    /// 应答服务器发过来的反向请求（JSON-RPC 是双向的）
    fn answer_server_request(&mut self, method: &str, id: &Value) -> Result<(), String> {
        let payload = match method {
            "roots/list" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": self.roots_payload(),
            }),
            "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            other => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {other}") },
            }),
        };
        self.write_line(&payload)
    }

    /// roots/list 的应答：把声明的目录转成 file:// URI
    fn roots_payload(&self) -> Value {
        let roots: Vec<Value> = self
            .roots
            .iter()
            .map(|path| {
                json!({
                    "uri": file_uri(path),
                    "name": Path::new(path)
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_else(|| path.clone()),
                })
            })
            .collect();
        json!({ "roots": roots })
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        // 进程随实例一起回收（配置变了、停止、或 companion 退出时）
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 逐行读 stdout（MCP stdio 的帧格式：一行一个 JSON）
fn read_loop(source: impl Read, tx: Sender<Value>) {
    let reader = BufReader::new(source);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(value) => {
                if tx.send(value).is_err() {
                    break;
                }
            }
            // 非 JSON 的行（有的服务器会先打日志）直接忽略
            Err(_) => continue,
        }
    }
}

fn drain_stderr(mut pipe: impl Read, sink: Arc<Mutex<String>>) {
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if let Ok(mut guard) = sink.lock() {
                    guard.push_str(&String::from_utf8_lossy(&chunk[..read]));
                    // 只留尾部，别无限涨
                    if guard.chars().count() > 4000 {
                        let keep: String = tail(&guard, 2000);
                        *guard = keep;
                    }
                }
            }
        }
    }
}

/// 工具清单缓存的路径：`<项目>/.rbcode/mcp/<id>/tools.json`
fn tools_cache_path(spec: &McpSpec, root: &str) -> PathBuf {
    spec.cache_dir(root).join("tools.json")
}

/// 把 tools/list 的结果缓存下来 —— 让「服务器还没启动」时也能把工具交给模型
fn write_tools_cache(spec: &McpSpec, root: &str, tools: &[Value]) {
    let path = tools_cache_path(spec, root);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, json!({ "tools": tools }).to_string());
}

/// 读缓存；没有或为空就返回 None
fn read_tools_cache(spec: &McpSpec, root: &str) -> Option<Vec<Value>> {
    let raw = std::fs::read_to_string(tools_cache_path(spec, root)).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let list = value.get("tools")?.as_array()?;
    if list.is_empty() {
        return None;
    }
    Some(list.clone())
}

/// 本地路径 → `file://` URI（MCP roots 要 URI；Windows 盘符写成 `file:///D:/x`）
fn file_uri(path: &str) -> String {
    let normalized = percent_encode_path(&path.replace('\\', "/"));
    if normalized.starts_with('/') {
        format!("file://{normalized}")
    } else {
        format!("file:///{normalized}")
    }
}

/// 路径用的百分号编码：保留 unreserved 与 `/` `:`
fn percent_encode_path(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b'/'
            | b':'
            | b'!'
            | b'$'
            | b'&'
            | b'\''
            | b'('
            | b')'
            | b'*'
            | b'+'
            | b','
            | b';'
            | b'='
            | b'@' => out.push(*byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// 取字符串尾部 n 个字符
fn tail(text: &str, n: usize) -> String {
    let mut chars: Vec<char> = text.chars().rev().take(n).collect();
    chars.reverse();
    chars.into_iter().collect::<String>().trim().to_string()
}

/// 构造启动命令。Windows 上 `npx` 与多数用户命令是 `.cmd` 批处理，
/// CreateProcess 起不来，统一借 `cmd.exe /C` 执行（它自己按 PATH / PATHEXT 找）。
fn spawn_command(spec: &McpSpec) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(&spec.command).args(&spec.args);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(&spec.command);
        cmd.args(&spec.args);
        cmd
    }
}

/* ------------------------------------ 注册表 ------------------------------------ */

/// 按「项目根 + 服务器 id」缓存运行中的 MCP 实例
#[derive(Default)]
pub struct McpRegistry {
    entries: Mutex<HashMap<String, Arc<Mutex<McpEntry>>>>,
    /// 只用来串行化「启动」，避免同一个服务器被并发起两份
    starts: Mutex<()>,
}

impl McpRegistry {
    /// 列出这些服务器在当前项目下的工具。
    ///
    /// `start = true`：必要时把服务器拉起来（会启动进程）。
    /// `start = false`：**只读缓存、绝不启动进程** —— 模型真正调用工具时才启动。
    /// 启动失败不抛错，而是把原因放进该服务器的 `error`。
    pub fn list(&self, root: &str, specs: &[McpSpec], start: bool) -> Vec<Value> {
        specs
            .iter()
            .map(|spec| {
                if !start {
                    return json!({
                        "id": spec.id,
                        "name": spec.name,
                        "tools": read_tools_cache(spec, root).unwrap_or_default(),
                        "cached": true,
                    });
                }
                match self.ensure(root, spec) {
                    Ok(entry) => {
                        let tools = entry
                            .lock()
                            .map(|guard| guard.client.tools.clone())
                            .unwrap_or_default();
                        json!({ "id": spec.id, "name": spec.name, "tools": tools })
                    }
                    Err(err) => json!({
                        "id": spec.id,
                        "name": spec.name,
                        "tools": [],
                        "error": err,
                    }),
                }
            })
            .collect()
    }

    /// 调一个工具。服务器没起来会先按需拉起。
    pub fn call(
        &self,
        root: &str,
        spec: &McpSpec,
        tool: &str,
        args: &Value,
    ) -> Result<Value, String> {
        let entry = self.ensure(root, spec)?;
        let mut guard = entry.lock().map_err(|_| "MCP 实例被锁死了".to_string())?;
        guard.client.call(tool, args.clone())
    }

    /// 停掉某个项目（或全部）的 MCP 实例，返回停掉的数量
    pub fn stop(&self, root: Option<&str>) -> usize {
        let Ok(mut map) = self.entries.lock() else {
            return 0;
        };
        match root {
            None => {
                let count = map.len();
                map.clear();
                count
            }
            Some(target) => {
                let prefix = format!("{target}\u{1}");
                let keys: Vec<String> = map
                    .keys()
                    .filter(|key| key.starts_with(&prefix))
                    .cloned()
                    .collect();
                for key in &keys {
                    map.remove(key);
                }
                keys.len()
            }
        }
    }

    fn ensure(&self, root: &str, spec: &McpSpec) -> Result<Arc<Mutex<McpEntry>>, String> {
        let key = format!("{root}\u{1}{}", spec.id);
        if let Some(existing) = self.lookup(&key, spec) {
            return Ok(existing);
        }

        // 只串行化启动这一段；已有实例的调用不受影响
        let _guard = self.starts.lock().map_err(|_| "MCP 启动锁被锁死")?;
        if let Some(existing) = self.lookup(&key, spec) {
            return Ok(existing);
        }

        // 配置变了：先停掉旧的那份
        if let Ok(mut map) = self.entries.lock() {
            map.remove(&key);
        }

        let client = McpClient::start(spec, root)?;
        let entry = Arc::new(Mutex::new(McpEntry {
            spec: spec.clone(),
            client,
        }));
        if let Ok(mut map) = self.entries.lock() {
            map.insert(key, Arc::clone(&entry));
        }
        Ok(entry)
    }

    fn lookup(&self, key: &str, spec: &McpSpec) -> Option<Arc<Mutex<McpEntry>>> {
        let map = self.entries.lock().ok()?;
        let entry = map.get(key)?;
        let matches = entry
            .lock()
            .map(|guard| guard.spec == *spec)
            .unwrap_or(false);
        if matches {
            Some(Arc::clone(entry))
        } else {
            None
        }
    }
}

/* ---------------------------------- RPC 入口 ---------------------------------- */

/// `mcp.list`：`{ root, start?, builtin?: { enabled?, browser?, proxy?, headless? }, servers?: [spec] }`
///
/// `start = false` 时不启动任何进程，只读工具清单缓存。
pub fn mcp_list(registry: &McpRegistry, params: &Value) -> Result<Value, String> {
    let root = string_param(params, "root").ok_or("缺少 root 参数（当前项目目录）")?;
    let specs = resolve_specs(params, &root)?;
    let start = params.get("start").and_then(Value::as_bool).unwrap_or(true);
    Ok(json!({ "servers": registry.list(&root, &specs, start) }))
}

/// `mcp.call`：`{ root, server: spec, tool, args }`
pub fn mcp_call(registry: &McpRegistry, params: &Value) -> Result<Value, String> {
    let root = string_param(params, "root").ok_or("缺少 root 参数（当前项目目录）")?;
    let raw = params.get("server").ok_or("缺少 server 参数")?;
    let spec = spec_from_value(raw, &root)?.ok_or("server 描述不完整")?;
    let tool = string_param(params, "tool").ok_or("缺少 tool 参数")?;
    let args = params.get("args").cloned().unwrap_or_else(|| json!({}));
    registry.call(&root, &spec, &tool, &args)
}

/// `mcp.stop`：`{ root? }`（不传 root 就停掉全部）
pub fn mcp_stop(registry: &McpRegistry, params: &Value) -> Result<Value, String> {
    let root = string_param(params, "root");
    let stopped = registry.stop(root.as_deref());
    Ok(json!({ "stopped": stopped }))
}

/// 把请求里的 builtin + servers 展开成待启动的描述列表
fn resolve_specs(params: &Value, root: &str) -> Result<Vec<McpSpec>, String> {
    let mut specs = Vec::new();

    let builtin = params.get("builtin");
    let enabled = builtin
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if enabled {
        let browser = builtin
            .and_then(|value| value.get("browser"))
            .and_then(Value::as_str);
        let proxy = builtin
            .and_then(|value| value.get("proxy"))
            .and_then(Value::as_str);
        let headless = builtin
            .and_then(|value| value.get("headless"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        specs.push(builtin_spec(root, browser, proxy, headless));
    }

    if let Some(list) = params.get("servers").and_then(Value::as_array) {
        for raw in list {
            if let Some(spec) = spec_from_value(raw, root)? {
                specs.push(spec);
            }
        }
    }
    Ok(specs)
}

/// 解析一个服务器描述；`builtin: true` 时按内置浏览器展开
fn spec_from_value(raw: &Value, root: &str) -> Result<Option<McpSpec>, String> {
    if raw.get("builtin").and_then(Value::as_bool) == Some(true) {
        let browser = raw.get("browser").and_then(Value::as_str);
        let proxy = raw.get("proxy").and_then(Value::as_str);
        let headless = raw
            .get("headless")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        return Ok(Some(builtin_spec(root, browser, proxy, headless)));
    }

    let Some(command) = raw
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        // 没 command 又没标 builtin：跳过（前端列表里可能有空行）
        return Ok(None);
    };

    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(command)
        .to_string();
    let name = raw
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&id)
        .to_string();
    let args = raw
        .get("args")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let env = raw
        .get("env")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let cwd = raw
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    // 自定义服务器也只在 .mcp_output/<id>（模型可见）里活动；roots 是建议性的，
    // 遵循它的服务器会以此划文件边界。
    let roots = vec![model_output_dir(root, &id).to_string_lossy().into_owned()];

    Ok(Some(McpSpec {
        id,
        name,
        command: command.to_string(),
        args,
        env,
        cwd,
        roots,
    }))
}

fn string_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_spec_puts_profile_under_project() {
        let spec = builtin_spec("D:\\work\\proj", None, Some("http://127.0.0.1:7897"), false);
        assert_eq!(spec.id, "browser");
        assert_eq!(spec.command, "npx");
        let joined = spec.args.join(" ");
        assert!(joined.contains("@playwright/mcp@latest"));
        // headless=false 时不该带 --headless
        assert!(!joined.contains("--headless"));
        assert!(joined.contains("--browser msedge"));
        assert!(joined.contains("--proxy-server http://127.0.0.1:7897"));

        // 内部缓存（profile / 内核 / 清单）在 .rbcode/mcp/browser 下 —— 不对模型开放
        assert!(spec
            .args
            .iter()
            .any(|arg| arg.contains("proj\\.rbcode\\mcp\\browser\\profile")));
        assert_eq!(spec.env.len(), 1);
        assert_eq!(spec.env[0].0, "PLAYWRIGHT_BROWSERS_PATH");
        assert!(spec.env[0].1.contains("proj\\.rbcode\\mcp\\browser\\browsers"));
        assert!(spec.cache_dir("D:\\work\\proj").ends_with("browser"));

        // 产出（截图等）在 .mcp_output/browser —— 这个才是对模型开放的目录
        assert!(spec
            .args
            .iter()
            .any(|arg| arg.contains("proj\\.mcp_output\\browser")));
        assert!(spec
            .args
            .iter()
            .all(|arg| !arg.contains(".rbcode\\mcp\\browser\\output")));
        assert!(spec
            .cwd
            .as_deref()
            .unwrap()
            .ends_with("proj\\.mcp_output\\browser"));
        // roots 只声明那一个目录：截图按第一个 root 解析；.rbcode 因此不在边界内
        assert_eq!(spec.roots.len(), 1);
        assert!(spec.roots[0].ends_with("proj\\.mcp_output\\browser"));
        // 不再放开整机文件访问
        assert!(!joined.contains("--allow-unrestricted-file-access"));
    }

    #[test]
    fn builtin_spec_omits_empty_proxy() {
        let spec = builtin_spec("C:\\p", Some("chrome"), Some("   "), true);
        let joined = spec.args.join(" ");
        assert!(!joined.contains("--proxy-server"));
        assert!(joined.contains("--browser chrome"));
        assert!(joined.contains("--headless"));
    }

    #[test]
    fn sanitizes_ids() {
        assert_eq!(sanitize("my server/../x"), "my_server_.._x");
        assert_eq!(sanitize(""), "server");
    }

    #[test]
    fn parses_custom_server() {
        let spec = spec_from_value(
            &json!({
                "id": "fs",
                "name": "Files",
                "command": "npx",
                "args": ["-y", "some-mcp"],
                "env": { "TOKEN": "abc" },
                "cwd": "C:\\x",
            }),
            "C:\\proj",
        )
        .unwrap()
        .unwrap();
        assert_eq!(spec.id, "fs");
        assert_eq!(spec.name, "Files");
        assert_eq!(spec.args, vec!["-y", "some-mcp"]);
        assert_eq!(spec.env, vec![("TOKEN".to_string(), "abc".to_string())]);
        assert_eq!(spec.cwd.as_deref(), Some("C:\\x"));
        // 自定义服务器也只在 .mcp_output/<id> 里可见
        assert_eq!(spec.roots.len(), 1);
        assert!(spec.roots[0].ends_with("proj\\.mcp_output\\fs"));
    }

    #[test]
    fn builds_file_uris() {
        assert_eq!(file_uri("D:\\a b\\proj"), "file:///D:/a%20b/proj");
        assert_eq!(file_uri("/home/me/proj"), "file:///home/me/proj");
    }

    #[test]
    fn skips_server_without_command() {
        assert!(spec_from_value(&json!({ "id": "x" }), "C:\\proj")
            .unwrap()
            .is_none());
    }

    #[test]
    fn tail_keeps_the_end() {
        assert_eq!(tail("abcdefghij", 3), "hij");
    }

    /// 端到端：起一个真的子进程（node 写的假 MCP 服务器），验证
    /// initialize → tools/list → tools/call 的收发与时序。
    #[test]
    fn talks_to_a_stdio_server() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("跳过：本机没有 node");
            return;
        }

        let script = r#"
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
let clientRoots = -1
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  // 我们自己发出的请求（roots/list, id=99）的回执：没有 method
  if (msg.method === undefined) {
    if (msg.id === 99) clientRoots = ((msg.result || {}).roots || []).length
    return
  }
  if (msg.method === 'initialize') {
    reply(msg.id, { protocolVersion: '2024-11-05', serverInfo: { name: 'fake', version: '1' }, capabilities: {} })
    // 反向问客户端要 roots —— 客户端必须应答，否则这里会一直等
    send({ jsonrpc: '2.0', id: 99, method: 'roots/list' })
  } else if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] })
  } else if (msg.method === 'tools/call') {
    if (process.env.RBCODE_MCP_CACHE) process.stderr.write('cache=' + process.env.RBCODE_MCP_CACHE + '\n')
    reply(msg.id, {
      content: [{ type: 'text', text: 'echo:' + (msg.params.arguments.text || '') + '|roots=' + clientRoots + '|npmcache=' + (process.env.npm_config_cache || '(unset)') }],
    })
  } else {
    reply(msg.id, {})
  }
})
"#;

        let dir = std::env::temp_dir().join("rbcode-mcp-test");
        std::fs::create_dir_all(&dir).unwrap();
        let script_path = dir.join("fake-mcp.cjs");
        std::fs::write(&script_path, script).unwrap();

        let root = dir.to_string_lossy().to_string();
        let spec = McpSpec {
            id: "fake".to_string(),
            name: "Fake".to_string(),
            command: "node".to_string(),
            args: vec![script_path.to_string_lossy().to_string()],
            env: Vec::new(),
            cwd: None,
            roots: vec![dir.join("output").to_string_lossy().to_string()],
        };

        let registry = McpRegistry::default();
        let listed = registry.list(&root, std::slice::from_ref(&spec), true);
        assert!(listed[0]["error"].is_null(), "list 报错：{}", listed[0]);
        assert_eq!(listed[0]["tools"][0]["name"], "echo");

        let result = registry
            .call(&root, &spec, "echo", &json!({ "text": "hi" }))
            .unwrap();
        // 我们把 roots 声明给了服务器，服务器反过来问 roots/list 也拿到了答复
        let reply_text = result["content"][0]["text"].as_str().unwrap_or_default();
        assert!(reply_text.starts_with("echo:hi|roots=1"), "{reply_text}");
        // npx 的包缓存被收进项目里（不再用用户全局 %LOCALAPPDATA%\npm-cache）
        let npm_cache = reply_text.split("npmcache=").nth(1).unwrap_or_default();
        assert!(
            npm_cache.starts_with(&root) && npm_cache.contains(".rbcode") && npm_cache.contains("npm-cache"),
            "npm_config_cache 应指向项目内缓存，实际：{npm_cache}"
        );

        // 清单被缓存下来了：不启动进程也能拿到（模型不用先等服务器起来）
        let cached = registry.list(&root, std::slice::from_ref(&spec), false);
        assert_eq!(cached[0]["cached"], true);
        assert_eq!(cached[0]["tools"][0]["name"], "echo");

        // 缓存目录按项目走
        assert!(spec.cache_dir(&root).ends_with("fake"));

        assert_eq!(registry.stop(Some(&root)), 1);
        assert_eq!(registry.stop(None), 0);
    }

    /// start = false 时**绝不能**启动进程：起不来的命令也不该报错，只回空清单
    #[test]
    fn cached_list_never_starts_a_process() {
        let root = std::env::temp_dir().join("rbcode-mcp-nostart");
        let root = root.to_string_lossy().to_string();
        let spec = McpSpec {
            id: "never".to_string(),
            name: "Never".to_string(),
            command: "definitely-not-a-real-binary-9f3a".to_string(),
            args: Vec::new(),
            env: Vec::new(),
            cwd: None,
            roots: Vec::new(),
        };

        let registry = McpRegistry::default();
        let listed = registry.list(&root, std::slice::from_ref(&spec), false);
        assert_eq!(listed[0]["cached"], true);
        assert!(listed[0]["tools"].as_array().unwrap().is_empty());
        assert!(listed[0]["error"].is_null(), "不该报错：{}", listed[0]);
        // 没有进程被注册
        assert_eq!(registry.stop(None), 0);
    }
}
