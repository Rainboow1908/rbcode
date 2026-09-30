use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::state::{AppState, ShellSession};

/// Windows 下不创建控制台窗口的标志位
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 遍历时跳过的目录
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".nuxt",
    ".venv",
    "__pycache__",
    ".idea",
    ".vscode",
    ".cache",
];

/// 单个输出流最多回传多少字节，超出的部分丢掉（但继续读，避免管道写满把子进程卡住）
const MAX_STREAM_BYTES: usize = 1_000_000;

type Body = Cursor<Vec<u8>>;

pub fn start(state: Arc<AppState>) {
    let port = state.port;
    std::thread::spawn(move || {
        let server = match Server::http(("127.0.0.1", port)) {
            Ok(server) => server,
            Err(err) => {
                eprintln!("无法监听 127.0.0.1:{port}：{err}");
                return;
            }
        };
        println!("RB Code 本机执行器已监听 http://127.0.0.1:{port}");
        for request in server.incoming_requests() {
            // 每个请求单独起线程：否则一条耗时的 shell.exec 会把
            // shell.list / shell.kill（以及网页轮询）全部堵在队列里。
            let shared = Arc::clone(&state);
            std::thread::spawn(move || handle(request, &shared));
        }
    });
}

fn handle(mut request: Request, state: &Arc<AppState>) {
    let origin = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Origin"))
        .map(|h| h.value.as_str().to_string());

    let method = request.method().clone();
    let url = request.url().to_string();

    if method == Method::Options {
        let _ = request.respond(with_cors(Response::empty(StatusCode(204)), &origin));
        return;
    }

    if method == Method::Get && url.starts_with("/ping") {
        let body = json!({
            "name": "rbcode-companion",
            "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "root": state.root_path().to_string_lossy(),
            "tokenRequired": true,
        });
        let _ = request.respond(with_cors(json_response(body), &origin));
        return;
    }

    if method == Method::Post && url.starts_with("/rpc") {
        let token = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("X-RB-Token"))
            .map(|h| h.value.as_str().to_string())
            .unwrap_or_default();

        if token != state.token() {
            let _ = request.respond(with_cors(
                error_response("配对令牌不正确", StatusCode(401)),
                &origin,
            ));
            return;
        }

        let mut raw = String::new();
        if request.as_reader().read_to_string(&mut raw).is_err() {
            let _ = request.respond(with_cors(error_response("无法读取请求体", StatusCode(400)), &origin));
            return;
        }

        let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let op = parsed.get("op").and_then(|v| v.as_str()).unwrap_or("");
        let params = parsed.get("params").cloned().unwrap_or_else(|| json!({}));
        state.requests.fetch_add(1, Ordering::Relaxed);

        let payload = match dispatch(state, op, &params) {
            Ok(result) => json!({ "ok": true, "result": result }),
            Err(message) => json!({ "ok": false, "error": message }),
        };
        let _ = request.respond(with_cors(json_response(payload), &origin));
        return;
    }

    let _ = request.respond(with_cors(error_response("未找到该接口", StatusCode(404)), &origin));
}

/* ------------------------------------ 路由分发 ------------------------------------ */

fn dispatch(state: &AppState, op: &str, params: &Value) -> Result<Value, String> {
    match op {
        "fs.read" => fs_read(state, params),
        "fs.write" => fs_write(state, params),
        "fs.list" => fs_list(state, params),
        "fs.exists" => fs_exists(state, params),
        "fs.mkdir" => fs_mkdir(state, params),
        "fs.remove" => fs_remove(state, params),
        "fs.glob" => fs_glob(state, params),
        "fs.grep" => fs_grep(state, params),
        "fs.readBase64" => fs_read_base64(state, params),
        "fs.writeBase64" => fs_write_base64(state, params),
        "env.paths" => env_paths(state, params),
        "shell.exec" => shell_exec(state, params),
        "shell.spawn" => shell_spawn(state, params),
        "shell.console" => shell_console(state, params),
        "shell.write" => shell_write(state, params),
        "shell.output" => shell_output(state, params),
        "shell.wait" => shell_wait(state, params),
        "shell.list" => shell_list(state),
        "shell.kill" => shell_kill(state, params),
        "env.listDir" => env_list_dir(params),
        "env.drives" => env_drives(),
        "env.setRoot" => env_set_root(state, params),
        "env.reveal" => env_reveal(state, params),
        // 联网访问：都从用户本机发请求，可走用户配置的代理（避免数据中心 IP 被反爬封掉）
        "web.search" => crate::web::web_search(params),
        "web.fetch" => crate::web::web_fetch(params),
        // MCP 服务器：每个项目一份独立进程 + 独立缓存目录
        "mcp.list" => crate::mcp::mcp_list(&state.mcp, params),
        "mcp.call" => crate::mcp::mcp_call(&state.mcp, params),
        "mcp.stop" => crate::mcp::mcp_stop(&state.mcp, params),
        // 音乐面板：代理第三方音乐 API + 下载（都从本机发出）
        "music.api" => crate::music::music_api(params),
        "music.download" => crate::music::music_download(params),
        // computer use：截屏 + 键鼠注入（都在这台机器上执行）
        "computer.screen" => crate::computer::screen_capture(params),
        "music.cover" => crate::music::music_cover(params),
        "computer.actions" => crate::computer::computer_actions(params),
        other => Err(format!("未知操作: {other}")),
    }
}

fn resolve(state: &AppState, raw: &str) -> PathBuf {
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        state.root_path().join(path)
    }
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

fn fs_read(state: &AppState, params: &Value) -> Result<Value, String> {
    let raw = param_str(params, "path")?;
    let full = resolve(state, &raw);
    let content = std::fs::read_to_string(&full)
        .map_err(|err| format!("读取 {} 失败：{err}", full.display()))?;
    Ok(json!({ "content": content }))
}

fn fs_write(state: &AppState, params: &Value) -> Result<Value, String> {
    let raw = param_str(params, "path")?;
    let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let full = resolve(state, &raw);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败：{err}"))?;
    }
    std::fs::write(&full, content).map_err(|err| format!("写入 {} 失败：{err}", full.display()))?;
    Ok(json!({ "written": content.len() }))
}

fn fs_list(state: &AppState, params: &Value) -> Result<Value, String> {
    let raw = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let full = if raw.is_empty() {
        state.root_path()
    } else {
        resolve(state, raw)
    };
    let root = state.root_path();

    let mut entries = Vec::new();
    let reader = std::fs::read_dir(&full)
        .map_err(|err| format!("读取目录 {} 失败：{err}", full.display()))?;
    for entry in reader.flatten() {
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push(json!({
            "path": relative(&root, &entry.path()),
            "name": name,
            "kind": if meta.is_dir() { "dir" } else { "file" },
            "size": meta.len(),
            // 修改时间（毫秒时间戳）：前端按系统文件管理器那样列「修改日期」
            "modified": meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64),
        }));
    }
    Ok(json!({ "entries": entries }))
}

fn fs_exists(state: &AppState, params: &Value) -> Result<Value, String> {
    let raw = param_str(params, "path")?;
    Ok(json!({ "exists": resolve(state, &raw).exists() }))
}

fn fs_mkdir(state: &AppState, params: &Value) -> Result<Value, String> {
    let raw = param_str(params, "path")?;
    let full = resolve(state, &raw);
    std::fs::create_dir_all(&full).map_err(|err| format!("创建目录失败：{err}"))?;
    Ok(json!({ "created": full.to_string_lossy() }))
}

fn fs_remove(state: &AppState, params: &Value) -> Result<Value, String> {
    let raw = param_str(params, "path")?;
    let recursive = params
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let full = resolve(state, &raw);
    let result = if full.is_dir() {
        if recursive {
            std::fs::remove_dir_all(&full)
        } else {
            std::fs::remove_dir(&full)
        }
    } else {
        std::fs::remove_file(&full)
    };
    result.map_err(|err| format!("删除 {} 失败：{err}", full.display()))?;
    Ok(json!({ "removed": true }))
}

fn build_matcher(pattern: &str) -> Result<globset::GlobMatcher, String> {
    let normalized = if pattern.contains('/') {
        pattern.to_string()
    } else {
        format!("**/{pattern}")
    };
    globset::Glob::new(&normalized)
        .map(|glob| glob.compile_matcher())
        .map_err(|err| format!("无效的模式 {pattern}：{err}"))
}

fn walk(root: &Path) -> impl Iterator<Item = walkdir::DirEntry> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            !SKIP_DIRS.contains(&name.as_str())
        })
        .filter_map(|entry| entry.ok())
}

fn fs_glob(state: &AppState, params: &Value) -> Result<Value, String> {
    let pattern = param_str(params, "pattern")?;
    let matcher = build_matcher(&pattern)?;
    let root = state.root_path();
    let mut matches = Vec::new();

    for entry in walk(&root) {
        if matches.len() >= 5000 {
            break;
        }
        let rel = relative(&root, entry.path());
        if rel.is_empty() {
            continue;
        }
        if matcher.is_match(&rel) {
            matches.push(if entry.file_type().is_dir() {
                format!("{rel}/")
            } else {
                rel
            });
        }
    }
    Ok(json!({ "matches": matches }))
}

fn fs_grep(state: &AppState, params: &Value) -> Result<Value, String> {
    let pattern = param_str(params, "pattern")?;
    let include = params.get("include").and_then(|v| v.as_str());
    let max = params
        .get("maxResults")
        .and_then(|v| v.as_u64())
        .unwrap_or(200) as usize;

    let regex = regex::RegexBuilder::new(&pattern)
        .case_insensitive(true)
        .build()
        .map_err(|err| format!("无效的正则表达式：{err}"))?;
    let include_matcher = match include {
        Some(value) if !value.is_empty() => Some(build_matcher(value)?),
        _ => None,
    };

    let root = state.root_path();
    let mut hits: Vec<String> = Vec::new();

    for entry in walk(&root) {
        if hits.len() >= max {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if entry
            .metadata()
            .map(|meta| meta.len() > 1_500_000)
            .unwrap_or(false)
        {
            continue;
        }
        let rel = relative(&root, entry.path());
        if let Some(matcher) = &include_matcher {
            if !matcher.is_match(&rel) {
                continue;
            }
        }
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        for (index, line) in content.lines().enumerate() {
            if hits.len() >= max {
                break;
            }
            if regex.is_match(line) {
                let snippet: String = line.trim().chars().take(200).collect();
                hits.push(format!("{}:{}: {}", rel, index + 1, snippet));
            }
        }
    }
    Ok(json!({ "output": hits.join("\n") }))
}

/// 二进制文件（图片等）的上限，超过就别往对话里塞了
const MAX_BINARY_BYTES: u64 = 4 * 1024 * 1024;

/// 读二进制文件并返回 base64（图片工具用；fs.read 是 UTF-8 文本，读二进制会坏）
fn fs_read_base64(state: &AppState, params: &Value) -> Result<Value, String> {
    let raw = param_str(params, "path")?;
    let full = resolve(state, &raw);
    let bytes =
        std::fs::read(&full).map_err(|err| format!("Failed to read {}: {err}", full.display()))?;
    if bytes.len() as u64 > MAX_BINARY_BYTES {
        return Err(format!(
            "File is too large: {} bytes (limit {} bytes)",
            bytes.len(),
            MAX_BINARY_BYTES
        ));
    }
    Ok(json!({ "base64": base64_encode(&bytes), "size": bytes.len() }))
}

/// 用户环境里的几个常用目录（前端拿不到 %APPDATA% 之类，要扫别的工具的数据时得问本机）
fn env_paths(_state: &AppState, _params: &Value) -> Result<Value, String> {
    let read = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Ok(json!({
        "home": read("USERPROFILE").or_else(|| read("HOME")),
        "appData": read("APPDATA"),
        "localAppData": read("LOCALAPPDATA"),
        "temp": read("TEMP").or_else(|| read("TMP")),
    }))
}

/// 写二进制文件（入参 base64）—— 图片要按字节落盘，不能走 fs.write（那是 UTF-8 文本）
fn fs_write_base64(state: &AppState, params: &Value) -> Result<Value, String> {
    let raw = param_str(params, "path")?;
    let encoded = param_str(params, "base64")?;
    let full = resolve(state, &raw);
    let bytes = base64_decode(&encoded)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败：{err}"))?;
    }
    std::fs::write(&full, &bytes).map_err(|err| format!("写入 {} 失败：{err}", full.display()))?;
    Ok(json!({ "bytes": bytes.len() }))
}

/// base64 解码（标准字母表；忽略空白与 `=`，非法字符直接拒绝）
pub(crate) fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    fn six(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some((byte - b'A') as u32),
            b'a'..=b'z' => Some((byte - b'a') as u32 + 26),
            b'0'..=b'9' => Some((byte - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in text.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let Some(value) = six(byte) else {
            return Err(format!("base64 内容非法（出现字符 {:?}）", byte as char));
        };
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/// 极简 base64 编码，省一个依赖（music.rs 下载也复用它）
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{base64_decode, base64_encode};

    /// 用 RFC 4648 的标准向量盯着这个手写编码器
    #[test]
    fn base64_encode_matches_rfc4648() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0u8]), "AA==");
        assert_eq!(base64_encode(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64_encode(&[0x00, 0x10, 0x83]), "ABCD");
    }

    #[test]
    fn base64_decode_round_trips() {
        let cases: [&[u8]; 10] = [
            b"",
            b"f",
            b"fo",
            b"foo",
            b"foob",
            b"fooba",
            b"foobar",
            &[0x00],
            &[0xff, 0xff, 0xff],
            &[0x00, 0x10, 0x83],
        ];
        for raw in cases {
            assert_eq!(base64_decode(&base64_encode(raw)).unwrap(), raw.to_vec());
        }
        // 空白与填充可以带，非法字符必须拒绝
        assert_eq!(base64_decode("Zm9v\nYmFy").unwrap(), b"foobar".to_vec());
        assert!(base64_decode("!!!!").is_err());
    }
}

/// 按平台构造执行一条命令的进程（Windows 走 powershell 并强制 UTF-8）
fn build_shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        // PowerShell 默认按系统 ANSI 编码输出，这里强制 UTF-8 以免中文乱码
        let wrapped = format!(
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; \
             $OutputEncoding=[System.Text.Encoding]::UTF8; {command}"
        );
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &wrapped,
        ]);
        // Python 默认按系统 ANSI 编码写 stdout，中文会变成乱码；这两个变量让子进程里的
        // Python 也走 UTF-8，用户就不必自己写 chcp / PYTHONUTF8 了。
        cmd.env("PYTHONUTF8", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
        // 关键：不让每条命令都弹出一个黑色控制台窗口
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", command]);
        cmd
    }
}

/// 前台执行：等命令结束，stdout / stderr 分开返回。
/// timeoutMs 到点还没结束就杀掉（标 timedOut）；用户从终端面板点「结束」则标 killed。
fn shell_exec(state: &AppState, params: &Value) -> Result<Value, String> {
    let command = param_str(params, "command")?;
    let cwd = state.root_path();
    let timeout_ms = param_u64(params, "timeoutMs").filter(|value| *value > 0);

    let mut child = build_shell_command(&command)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("执行失败：{err}"))?;

    let pid = child.id();
    let id = format!("sh-{pid}");
    let owner = param_str(params, "sessionId").unwrap_or_else(|_| "unknown".to_string());
    let owner_label = param_str(params, "sessionLabel").unwrap_or_default();
    let session = Arc::new(ShellSession::new(
        id.clone(),
        command.clone(),
        pid,
        owner,
        owner_label,
    ));
    state.register_shell(session.clone());

    // 超时看门狗：给了 timeoutMs（>0）才起；不填就是不限时（模型自己决定）
    if let Some(timeout_ms) = timeout_ms {
        let target = session.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(timeout_ms));
            if !target.is_done() {
                target.mark_timed_out();
                let _ = kill_process_tree(pid);
            }
        });
    }

    // 两个流必须同时读：只读其中一个时，另一个写满管道会把子进程卡住。
    // 每个流最多保留 MAX_STREAM_BYTES，多出来的直接丢掉并记账。
    // 边读边写进会话缓冲：这样前台命令也能在网页终端栏里看到实时输出。
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_session = session.clone();
    let stderr_session = session.clone();
    let stdout_thread = std::thread::spawn(move || match stdout_pipe.as_mut() {
        Some(pipe) => read_capped(pipe, MAX_STREAM_BYTES, Some(&stdout_session)),
        None => (Vec::new(), 0),
    });
    let stderr_thread = std::thread::spawn(move || match stderr_pipe.as_mut() {
        Some(pipe) => read_capped(pipe, MAX_STREAM_BYTES, Some(&stderr_session)),
        None => (Vec::new(), 0),
    });

    let status = child.wait();
    let (stdout, stdout_dropped) = stdout_thread.join().unwrap_or_default();
    let (stderr, stderr_dropped) = stderr_thread.join().unwrap_or_default();
    state.unregister_shell(&id);
    let status = status.map_err(|err| format!("执行失败：{err}"))?;

    Ok(json!({
        "stdout": crate::state::decode_output(&stdout),
        "stderr": crate::state::decode_output(&stderr),
        "exitCode": status.code().unwrap_or(-1),
        "stdoutDropped": stdout_dropped,
        "stderrDropped": stderr_dropped,
        "killed": session.is_killed(),
        "timedOut": session.is_timed_out(),
    }))
}

/// 后台执行：立刻返回 id，输出由后台线程持续写进会话缓冲
fn shell_spawn(state: &AppState, params: &Value) -> Result<Value, String> {
    let command = param_str(params, "command")?;
    let cwd = state.root_path();

    let mut child = build_shell_command(&command)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("启动失败：{err}"))?;

    let id = format!("sh-{}", child.id());
    // 命令归属于发起它的网页会话，界面据此把终端分成「当前会话」与「后台」两组
    let owner = param_str(params, "sessionId").unwrap_or_else(|_| "unknown".to_string());
    let owner_label = param_str(params, "sessionLabel").unwrap_or_default();
    let session = Arc::new(ShellSession::new(
        id.clone(),
        command.clone(),
        child.id(),
        owner,
        owner_label,
    ));

    // 两个流各一个线程，读到的内容按到达顺序追加进同一个缓冲
    if let Some(mut pipe) = child.stdout.take() {
        let target = session.clone();
        std::thread::spawn(move || pump(&mut pipe, target));
    }
    if let Some(mut pipe) = child.stderr.take() {
        let target = session.clone();
        std::thread::spawn(move || pump(&mut pipe, target));
    }
    // 单独一个线程等进程结束，好让 shell.list / shell.wait 看到退出码
    {
        let target = session.clone();
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
            target.mark_done(code);
        });
    }

    state.register_shell(session.clone());
    Ok(json!({
        "id": id,
        "pid": session.pid,
        "command": command,
    }))
}

/// 常驻「会话终端」用的 shell（**没有 ConPTY 的平台**才用）。
/// Windows 上常驻终端走 ConPTY，不再用这个。
#[cfg(not(windows))]
fn build_console_command() -> Command {
    Command::new("/bin/sh")
}

/// 打开（或复用）常驻会话终端：同一个工作目录只开一个，一直开着，手动关才没。
fn shell_console(state: &AppState, _params: &Value) -> Result<Value, String> {
    let cwd = state.root_path();
    let root_key = cwd.to_string_lossy().to_string();
    if let Some(existing) = state.find_console(&root_key) {
        return Ok(json!({
            "id": existing.id,
            "pid": existing.pid,
            "command": existing.command,
        }));
    }

    // 常驻终端最多留 3 个（切项目来回切不会攒一堆）
    state.trim_consoles(2);

    #[cfg(windows)]
    {
        // Windows：ConPTY，给 PowerShell 一个**真终端**
        let pty = crate::conpty::spawn("powershell.exe -NoLogo -NoProfile", &cwd, 120, 30)?;
        let crate::conpty::ConPty {
            pid,
            hpcon,
            process,
            reader,
            writer,
        } = pty;

        let id = format!("sh-{pid}");
        let mut session = ShellSession::new(
            id.clone(),
            "(会话终端)".to_string(),
            pid,
            "console".to_string(),
            "会话终端".to_string(),
        );
        session.set_console(root_key);
        session.set_pty(true);
        session.set_stdin(Some(Box::new(writer)));
        let session = Arc::new(session);

        // 让 PowerShell 的输出走 UTF-8（PTY 的输出按 UTF-8 解），中文才不乱码。
        // 有真控制台时这个赋值才会生效（以前管道方式会直接抛异常）。
        let _ = session.write_stdin(b"[Console]::OutputEncoding=[Text.Encoding]::UTF8\r\n");

        {
            let target = session.clone();
            let mut reader = reader;
            std::thread::spawn(move || pump(&mut reader, target));
        }
        {
            // 句柄在闭包外面包好（HANDLE 本身不是 Send，Handles 是）
            let handles = crate::conpty::Handles(process, hpcon);
            let target = session.clone();
            std::thread::spawn(move || {
                let code = crate::conpty::wait_and_close(handles);
                target.mark_done(code);
            });
        }

        state.register_shell(session.clone());
        return Ok(json!({
            "id": id,
            "pid": session.pid,
            "command": session.command,
        }));
    }

    #[cfg(not(windows))]
    {
        let mut child = build_console_command()
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("启动会话终端失败：{err}"))?;

        let id = format!("sh-{}", child.id());
        let mut session = ShellSession::new(
            id.clone(),
            "(会话终端)".to_string(),
            child.id(),
            "console".to_string(),
            "会话终端".to_string(),
        );
        session.set_console(root_key);
        session.set_stdin(child.stdin.take());
        let session = Arc::new(session);

        if let Some(mut pipe) = child.stdout.take() {
            let target = session.clone();
            std::thread::spawn(move || pump(&mut pipe, target));
        }
        if let Some(mut pipe) = child.stderr.take() {
            let target = session.clone();
            std::thread::spawn(move || pump(&mut pipe, target));
        }
        {
            let target = session.clone();
            std::thread::spawn(move || {
                let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                target.mark_done(code);
            });
        }

        state.register_shell(session.clone());
        return Ok(json!({
            "id": id,
            "pid": session.pid,
            "command": session.command,
        }));
    }
}

/// 往常驻会话终端写一段（一条命令 + 换行）
fn shell_write(state: &AppState, params: &Value) -> Result<Value, String> {
    let id = param_str(params, "id")?;
    let data = param_str(params, "data")?;
    let session = state
        .get_shell(&id)
        .ok_or_else(|| format!("没有找到会话终端：{id}"))?;
    // 真 PTY：按键原样写进去（回车就是 \r，终端驱动自己会处理）。
    // 普通管道（没有 PTY 的兜底路径）才需要把单个 CR 补成 CRLF，否则 cmd 会当续行。
    #[cfg(windows)]
    let data = if session.pty {
        data
    } else {
        data.replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace('\n', "\r\n")
    };
    session.write_stdin(data.as_bytes())?;
    Ok(json!({ "ok": true }))
}

/// 把管道里的内容搬进会话缓冲，直到进程关掉这个流
fn pump<R: Read>(reader: &mut R, session: Arc<ShellSession>) {
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => session.append_output(&chunk[..read]),
            Err(_) => break,
        }
    }
}

/// 会话隔离：调用方带了 sessionId 时，只允许操作属于该会话的命令。
/// 网页上的「结束」按钮不带这个参数（用户才是主人，可以管所有终端）；
/// agent 的工具调用（bash_output / bash_wait / bash_kill）一律带上，于是碰不到别的会话。
fn ensure_owner(session: &ShellSession, params: &Value) -> Result<(), String> {
    let claimed = match param_str(params, "sessionId") {
        Ok(value) => value,
        // 没带这个参数 = 来自界面操作，放行
        Err(_) => return Ok(()),
    };
    if claimed.is_empty() || session.session_id == claimed {
        return Ok(());
    }
    let owner = if session.session_label.is_empty() {
        session.session_id.clone()
    } else {
        session.session_label.clone()
    };
    Err(format!(
        "命令 {} 属于另一个会话（{}），不能从这里操作",
        session.id, owner
    ))
}

/// 从会话缓冲里取新输出（shell.output / shell.wait 共用）
    fn read_session_output(session: &ShellSession, offset: usize) -> (String, usize, usize) {
    match session.output.lock() {
        Ok(guard) => {
            let (text, next) = guard.read_from(offset, session.pty);
            (text, next, guard.dropped())
        }
        Err(_) => (String::new(), offset, 0),
    }
}

/// 读出某条命令从 offset 开始的新输出
fn shell_output(state: &AppState, params: &Value) -> Result<Value, String> {
    let id = param_str(params, "id")?;
    let offset = param_usize(params, "offset").unwrap_or(0);
    let session = state
        .get_shell(&id)
        .ok_or_else(|| format!("没有找到命令：{id}"))?;
    ensure_owner(&session, params)?;

    let (output, next_offset, dropped) = read_session_output(&session, offset);
    let code = session.code();
    Ok(json!({
        "id": id,
        "output": output,
        "nextOffset": next_offset,
        "dropped": dropped,
        "done": code.is_some(),
        "exitCode": code,
        "killed": session.is_killed(),
    }))
}

/// 等某条后台命令结束（或超时），返回这期间的新输出
fn shell_wait(state: &AppState, params: &Value) -> Result<Value, String> {
    let id = param_str(params, "id")?;
    let offset = param_usize(params, "offset").unwrap_or(0);
    let timeout = param_u64(params, "timeoutMs").unwrap_or(30_000).min(180_000);
    let session = state
        .get_shell(&id)
        .ok_or_else(|| format!("没有找到命令：{id}"))?;
    ensure_owner(&session, params)?;

    let deadline = Instant::now() + Duration::from_millis(timeout);
    while !session.is_done() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }

    let (output, next_offset, dropped) = read_session_output(&session, offset);
    let code = session.code();
    Ok(json!({
        "id": id,
        "output": output,
        "nextOffset": next_offset,
        "dropped": dropped,
        "done": code.is_some(),
        "exitCode": code,
        "timedOut": code.is_none(),
        "killed": session.is_killed(),
    }))
}

/// 读一个流，最多留下 cap 字节；多出来的照样读掉，只是不留。
/// 传了 live 就边读边追加进会话缓冲 —— 前台命令也能在网页终端栏里看到实时输出。
fn read_capped<R: Read>(
    reader: &mut R,
    cap: usize,
    live: Option<&Arc<ShellSession>>,
) -> (Vec<u8>, usize) {
    let mut kept: Vec<u8> = Vec::new();
    let mut dropped = 0usize;
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                if let Some(session) = live {
                    session.append_output(&chunk[..read]);
                }
                if kept.len() < cap {
                    let room = cap - kept.len();
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                    dropped += read.saturating_sub(room);
                } else {
                    dropped += read;
                }
            }
            Err(_) => break,
        }
    }
    (kept, dropped)
}

/// 列出正在执行（以及刚结束）的命令
fn shell_list(state: &AppState) -> Result<Value, String> {
    let items: Vec<Value> = state
        .list_shells()
        .into_iter()
        .map(|item| {
            json!({
                "id": item.id,
                "command": item.command,
                "pid": item.pid,
                "startedAt": item.started_at,
                "sessionId": item.session_id,
                "sessionLabel": item.session_label,
                "done": item.is_done(),
                "exitCode": item.code(),
                "killed": item.is_killed(),
                "console": item.console,
                "pty": item.pty,
            })
        })
        .collect();
    Ok(json!({ "commands": items }))
}

/// 在系统文件管理器里选中一个路径，方便用户直接去磁盘上看。
fn env_reveal(_state: &AppState, params: &Value) -> Result<Value, String> {
    let path = param_str(params, "path")?;
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("路径不存在：{path}"));
    }

    #[cfg(windows)]
    {
        // explorer 的 /select 不能带引号，这里用参数数组传，避免被 shell 解析；
        // explorer 即使成功也常返回非零码，所以不看退出状态。
        Command::new("explorer")
            .arg(format!("/select,{}", target.display()))
            .spawn()
            .map_err(|err| format!("无法打开文件管理器：{err}"))?;
    }
    #[cfg(not(windows))]
    {
        let dir = if target.is_dir() {
            target.clone()
        } else {
            target.parent().map(|p| p.to_path_buf()).unwrap_or(target.clone())
        };
        Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|err| format!("无法打开文件管理器：{err}"))?;
    }

    Ok(json!({ "revealed": path }))
}

/// 结束一条命令连同它的子进程。Windows 用 taskkill /T，其它平台 kill。
fn kill_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let status = cmd.status().map_err(|err| format!("结束失败：{err}"))?;
        if !status.success() {
            return Err("结束失败（进程可能已经退出）".to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
        Ok(())
    }
}

/// 结束一条命令（连同它的子进程）。会话先留着，让调用方能读走最后的输出。
/// 会打上 killed 标记 —— 模型据此知道是「用户手动停的」，而不是命令自己跑完且没有输出。
fn shell_kill(state: &AppState, params: &Value) -> Result<Value, String> {
    let id = param_str(params, "id")?;
    let session = state
        .get_shell(&id)
        .ok_or_else(|| format!("没有找到运行中的命令：{id}"))?;
    ensure_owner(&session, params)?;

    if session.is_done() {
        return Ok(json!({ "killed": false, "alreadyDone": true, "id": id }));
    }

    session.mark_killed();
    match kill_process_tree(session.pid) {
        Ok(()) => {}
        // 进程可能刚好自己退了：只要它已经结束，就不算失败
        Err(err) => {
            if !session.is_done() {
                return Err(err);
            }
        }
    }

    Ok(json!({ "killed": true, "id": id }))
}

/* ------------------------------------- 响应工具 ------------------------------------- */

/// 列出某个绝对路径下的子目录（供网页端的目录选择器使用）
fn env_list_dir(params: &Value) -> Result<Value, String> {
    let raw = param_str(params, "path")?;
    let full = PathBuf::from(&raw);
    let reader = std::fs::read_dir(&full)
        .map_err(|err| format!("读取目录 {} 失败：{err}", full.display()))?;

    let mut entries = Vec::new();
    for entry in reader.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('$') {
            continue;
        }
        entries.push(json!({
            "path": entry.path().to_string_lossy(),
            "name": name,
            "kind": "dir",
            "size": 0,
            // 修改时间（毫秒时间戳）：目录选择器按系统文件管理器那样列「修改日期」
            "modified": meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64),
        }));
    }
    entries.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });
    Ok(json!({ "entries": entries }))
}

/// 列出可用的盘符
fn env_drives() -> Result<Value, String> {
    let mut drives = Vec::new();
    for letter in b'A'..=b'Z' {
        let path = format!("{}:\\", letter as char);
        if Path::new(&path).exists() {
            drives.push(path);
        }
    }
    Ok(json!({ "drives": drives }))
}

/// 由网页端指定工作目录
fn env_set_root(state: &AppState, params: &Value) -> Result<Value, String> {
    let raw = param_str(params, "root")?;
    let path = PathBuf::from(&raw);
    if !path.is_dir() {
        return Err(format!("目录不存在：{raw}"));
    }
    state.set_root(path);
    // 注意：这里**不关**会话终端 —— 切走再切回来还要接着用（每个根目录一份）
    Ok(json!({ "root": raw }))
}

fn param_str(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("缺少参数 {key}"))
}

fn param_u64(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(|v| v.as_u64())
}

fn param_usize(params: &Value, key: &str) -> Option<usize> {
    params
        .get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
}

fn json_response(value: Value) -> Response<Body> {
    let body = value.to_string();
    Response::from_string(body).with_header(
        Header::from_bytes("Content-Type", "application/json; charset=utf-8")
            .expect("content-type header"),
    )
}

fn error_response(message: &str, status: StatusCode) -> Response<Body> {
    let body = json!({ "ok": false, "error": message }).to_string();
    Response::from_string(body)
        .with_status_code(status)
        .with_header(
            Header::from_bytes("Content-Type", "application/json; charset=utf-8")
                .expect("content-type header"),
        )
}

/// 加上跨域与私有网络访问所需的响应头。
/// 网页部署在 https 的公网域名上，访问 http://127.0.0.1 属于 Private Network Access，
/// 新版 Chromium 会要求 `Access-Control-Allow-Private-Network: true`。
fn with_cors<R: Read>(mut response: Response<R>, origin: &Option<String>) -> Response<R> {
    let allow_origin = origin.clone().unwrap_or_else(|| "*".to_string());
    let headers: [(&str, String); 6] = [
        ("Access-Control-Allow-Origin", allow_origin),
        (
            "Access-Control-Allow-Headers",
            "Content-Type, X-RB-Token".to_string(),
        ),
        (
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS".to_string(),
        ),
        (
            "Access-Control-Allow-Private-Network",
            "true".to_string(),
        ),
        ("Access-Control-Max-Age", "86400".to_string()),
        ("Vary", "Origin".to_string()),
    ];
    for (name, value) in headers {
        if let Ok(header) = Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            response.add_header(header);
        }
    }
    response
}

#[cfg(test)]
mod owner_tests {
    use super::*;
    use serde_json::json;

    fn session() -> ShellSession {
        ShellSession::new(
            "sh-1".to_string(),
            "echo hi".to_string(),
            1,
            "sess-mine".to_string(),
            "我的会话".to_string(),
        )
    }

    #[test]
    fn owner_check_allows_ui_and_same_session() {
        let s = session();
        // 不带 sessionId = 界面上的「结束」按钮，放行（用户是主人）
        assert!(ensure_owner(&s, &json!({})).is_ok());
        // 同一个会话，放行
        assert!(ensure_owner(&s, &json!({ "sessionId": "sess-mine" })).is_ok());
    }

    #[test]
    fn owner_check_rejects_other_session() {
        let s = session();
        let err = ensure_owner(&s, &json!({ "sessionId": "sess-other" })).unwrap_err();
        assert!(err.contains("sh-1"));
        assert!(err.contains("我的会话"));
    }
}
