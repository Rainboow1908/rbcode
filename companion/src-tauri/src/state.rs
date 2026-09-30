use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// 单条命令保留的输出上限（超出后只留最新的部分）
pub const MAX_SHELL_BYTES: usize = 512 * 1024;

/// 已经结束的命令最多留几条，供 shell.output 再读一次结果
const KEEP_FINISHED: usize = 20;

/// 子进程输出按「OEM 代码页」解码：Windows 控制台默认是 GBK（CP936）之类，不是 UTF-8，
/// 直接 from_utf8_lossy 就是乱码。其它平台本来就是 UTF-8。
pub fn decode_output(bytes: &[u8]) -> String {
    #[cfg(windows)]
    {
        use windows::Win32::Globalization::{
            GetOEMCP, MultiByteToWideChar, MULTI_BYTE_TO_WIDE_CHAR_FLAGS,
        };
        unsafe {
            let cp = GetOEMCP();
            if cp == 65001 {
                return String::from_utf8_lossy(bytes).to_string();
            }
            let len = MultiByteToWideChar(cp, MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0), bytes, None);
            if len <= 0 {
                return String::from_utf8_lossy(bytes).to_string();
            }
            let mut buf = vec![0u16; len as usize];
            let written =
                MultiByteToWideChar(cp, MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0), bytes, Some(&mut buf));
            if written <= 0 {
                return String::from_utf8_lossy(bytes).to_string();
            }
            String::from_utf16_lossy(&buf[..written as usize])
        }
    }
    #[cfg(not(windows))]
    {
        String::from_utf8_lossy(bytes).to_string()
    }
}

/// 一条命令累积的输出：超出上限后丢掉最旧的部分，保留最新的
#[derive(Default)]
pub struct OutputBuffer {
    data: Vec<u8>,
    /// 因为超上限被丢掉的字节数
    dropped: usize,
}

impl OutputBuffer {
    pub fn append(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        self.data.extend_from_slice(chunk);
        if self.data.len() > MAX_SHELL_BYTES {
            let overflow = self.data.len() - MAX_SHELL_BYTES;
            self.data.drain(..overflow);
            self.dropped += overflow;
        }
    }

    /// 从 offset 开始读；offset 落在已被丢弃的区间里时从头给。
    /// `utf8`：PTY 的输出本身就是 UTF-8；普通管道是按 OEM 代码页来的。
    pub fn read_from(&self, offset: usize, utf8: bool) -> (String, usize) {
        let start = if offset >= self.dropped {
            (offset - self.dropped).min(self.data.len())
        } else {
            0
        };
        let text = if utf8 {
            String::from_utf8_lossy(&self.data[start..]).to_string()
        } else {
            decode_output(&self.data[start..])
        };
        (text, self.total())
    }

    pub fn dropped(&self) -> usize {
        self.dropped
    }

    /// 历史累计写入量（含被丢掉的）
    pub fn total(&self) -> usize {
        self.dropped + self.data.len()
    }
}

/// 正在执行（或刚跑完）的一条命令。
/// 输出由后台线程持续写入，所以命令跑着的时候也能读到进度。
pub struct ShellSession {
    pub id: String,
    pub command: String,
    pub pid: u32,
    pub started_at: u64,
    /// 发起这条命令的网页会话 id：界面按会话分组，互不干扰
    pub session_id: String,
    /// 那个会话的标题，直接回给界面显示，省得前端再查一遍
    pub session_label: String,
    /// stdout 与 stderr 按到达顺序合并
    pub output: Mutex<OutputBuffer>,
    /// 退出码；None 表示还在跑
    pub exit_code: Mutex<Option<i32>>,
    /// 用户在前端「终端」面板手动结束的
    pub killed: Mutex<bool>,
    /// 超过 timeout 被强制结束的
    pub timed_out: Mutex<bool>,
    /// 常驻「会话终端」的 stdin（普通命令为 None）；PTY 时是伪终端的输入管道
    pub stdin: Mutex<Option<Box<dyn std::io::Write + Send>>>,
    /// 是不是常驻会话终端（一直开着，手动关才没）
    pub console: bool,
    /// 会话终端对应的根目录（换根要重建）
    pub console_root: String,
    /// 这个终端是不是真伪终端（PTY）。是的话：输出按 UTF-8 解、按键不再规范化
    pub pty: bool,
}

impl ShellSession {
    pub fn new(
        id: String,
        command: String,
        pid: u32,
        session_id: String,
        session_label: String,
    ) -> Self {
        Self {
            id,
            command,
            pid,
            started_at: now_millis(),
            session_id,
            session_label,
            output: Mutex::new(OutputBuffer::default()),
            exit_code: Mutex::new(None),
            killed: Mutex::new(false),
            timed_out: Mutex::new(false),
            stdin: Mutex::new(None),
            console: false,
            console_root: String::new(),
            pty: false,
        }
    }

    pub fn is_done(&self) -> bool {
        self.exit_code
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    pub fn code(&self) -> Option<i32> {
        self.exit_code.lock().ok().and_then(|guard| *guard)
    }

    pub fn mark_killed(&self) {
        if let Ok(mut guard) = self.killed.lock() {
            *guard = true;
        }
    }

    pub fn is_killed(&self) -> bool {
        self.killed.lock().map(|guard| *guard).unwrap_or(false)
    }

    pub fn mark_timed_out(&self) {
        if let Ok(mut guard) = self.timed_out.lock() {
            *guard = true;
        }
    }

    pub fn is_timed_out(&self) -> bool {
        self.timed_out.lock().map(|guard| *guard).unwrap_or(false)
    }

    pub fn append_output(&self, chunk: &[u8]) {
        if let Ok(mut guard) = self.output.lock() {
            guard.append(chunk);
        }
    }

    pub fn mark_done(&self, code: i32) {
        if let Ok(mut guard) = self.exit_code.lock() {
            *guard = Some(code);
        }
    }

    /// 标记成常驻会话终端（并记住它属于哪个根目录）
    pub fn set_console(&mut self, root: String) {
        self.console = true;
        self.console_root = root;
    }

    pub fn set_pty(&mut self, pty: bool) {
        self.pty = pty;
    }

    /// 装上 stdin（常驻终端的命令从这里写进去）
    pub fn set_stdin(&mut self, stdin: Option<Box<dyn std::io::Write + Send>>) {
        self.stdin = Mutex::new(stdin);
    }

    /// 往常驻会话终端的 stdin 写一段（命令 + 换行）
    pub fn write_stdin(&self, bytes: &[u8]) -> Result<(), String> {
        use std::io::Write;
        let mut guard = self.stdin.lock().map_err(|_| "stdin 锁失败".to_string())?;
        match guard.as_mut() {
            Some(stdin) => {
                stdin.write_all(bytes).map_err(|e| e.to_string())?;
                stdin.flush().map_err(|e| e.to_string())
            }
            None => Err("这个会话没有 stdin（不是常驻终端）".to_string()),
        }
    }
}

/// 全局共享状态：配对令牌、工作目录、监听端口、调用计数、运行中的命令。
pub struct AppState {
    token: Mutex<String>,
    root: Mutex<PathBuf>,
    running: Mutex<Vec<Arc<ShellSession>>>,
    /// 运行中的 MCP 服务器（按「项目根 + 服务器 id」缓存，每个项目一份）
    pub mcp: crate::mcp::McpRegistry,
    pub port: u16,
    pub requests: AtomicU64,
}

impl AppState {
    pub fn new(port: u16) -> Self {
        Self {
            token: Mutex::new(generate_token()),
            root: Mutex::new(default_root()),
            running: Mutex::new(Vec::new()),
            mcp: crate::mcp::McpRegistry::default(),
            port,
            requests: AtomicU64::new(0),
        }
    }

    pub fn token(&self) -> String {
        self.token.lock().map(|t| t.clone()).unwrap_or_default()
    }

    pub fn set_token(&self, value: String) {
        if let Ok(mut guard) = self.token.lock() {
            *guard = value;
        }
    }

    pub fn regenerate_token(&self) -> String {
        let next = generate_token();
        self.set_token(next.clone());
        next
    }

    pub fn root_path(&self) -> PathBuf {
        self.root
            .lock()
            .map(|p| p.clone())
            .unwrap_or_else(|_| PathBuf::from("."))
    }

    /// 切换工作目录并持久化，下次启动自动恢复
    pub fn set_root(&self, path: PathBuf) {
        if let Ok(mut guard) = self.root.lock() {
            *guard = path.clone();
        }
        save_root(&path);
    }

    pub fn register_shell(&self, session: Arc<ShellSession>) {
        if let Ok(mut guard) = self.running.lock() {
            guard.push(session);
            // 已结束的会话只保留最近 KEEP_FINISHED 条，免得越攒越多
            let finished: Vec<String> = guard
                .iter()
                .filter(|item| item.is_done())
                .map(|item| item.id.clone())
                .collect();
            if finished.len() > KEEP_FINISHED {
                let cut = finished.len() - KEEP_FINISHED;
                let stale: Vec<String> = finished[..cut].to_vec();
                guard.retain(|item| !stale.contains(&item.id));
            }
        }
    }

    pub fn unregister_shell(&self, id: &str) {
        if let Ok(mut guard) = self.running.lock() {
            guard.retain(|item| item.id != id);
        }
    }

    pub fn get_shell(&self, id: &str) -> Option<Arc<ShellSession>> {
        self.running
            .lock()
            .ok()
            .and_then(|guard| guard.iter().find(|item| item.id == id).cloned())
    }

    /// 找某个根目录下还活着的常驻会话终端
    pub fn find_console(&self, root: &str) -> Option<Arc<ShellSession>> {
        self.running
            .lock()
            .ok()?
            .iter()
            .find(|item| item.console && !item.is_done() && item.console_root == root)
            .cloned()
    }

    /// 常驻会话终端最多留 keep 个：超了就把最老的关掉（切来切去不至于攒一堆进程）
    pub fn trim_consoles(&self, keep: usize) {
        let mut consoles: Vec<Arc<ShellSession>> = self
            .running
            .lock()
            .map(|guard| {
                guard
                    .iter()
                    .filter(|item| item.console && !item.is_done())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if consoles.len() <= keep {
            return;
        }
        consoles.sort_by_key(|item| item.started_at);
        let remove = consoles.len() - keep;
        for item in consoles.into_iter().take(remove) {
            item.mark_killed();
            item.mark_done(-1);
            if let Ok(mut guard) = item.stdin.lock() {
                *guard = None;
            }
        }
    }

    /// 关掉所有常驻会话终端（换工作目录时用）
    pub fn close_consoles(&self) {
        let items: Vec<Arc<ShellSession>> = self
            .running
            .lock()
            .map(|guard| guard.iter().filter(|item| item.console).cloned().collect())
            .unwrap_or_default();
        for item in items {
            item.mark_killed();
            item.mark_done(-1);
            // 关掉 stdin：shell 读到 EOF 会自己退出
            if let Ok(mut guard) = item.stdin.lock() {
                *guard = None;
            }
        }
    }

    pub fn list_shells(&self) -> Vec<Arc<ShellSession>> {
        self.running
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 形如 ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567 的配对令牌
fn generate_token() -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| {
            (0..4)
                .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("-")
}

fn config_path() -> Option<PathBuf> {
    let base = std::env::var("APPDATA")
        .ok()
        .or_else(|| std::env::var("XDG_CONFIG_HOME").ok())?;
    Some(
        PathBuf::from(base)
            .join("rbcode-companion")
            .join("config.json"),
    )
}

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 读取上次使用的工作目录（不存在则返回 None）
fn load_saved_root() -> Option<PathBuf> {
    let raw = std::fs::read_to_string(config_path()?).ok()?;
    // 容忍带 BOM 的配置文件（例如被编辑器改过）
    let clean = raw.trim_start_matches('\u{feff}').trim();
    let value: serde_json::Value = serde_json::from_str(clean).ok()?;
    let path = PathBuf::from(value.get("root")?.as_str()?);
    path.is_dir().then_some(path)
}

fn save_root(root: &Path) {
    let Some(path) = config_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let value = serde_json::json!({ "root": root.to_string_lossy() });
    let _ = std::fs::write(path, value.to_string());
}

/// 首次启动不指向用户主目录（避免 AI 误改已有文件），
/// 而是在家目录下建一个专用的空工作区；之后记住用户的选择。
fn default_root() -> PathBuf {
    if let Some(saved) = load_saved_root() {
        return saved;
    }
    let workspace = home_dir().join("RBCode");
    let _ = std::fs::create_dir_all(&workspace);
    workspace
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_buffer_reads_from_offset() {
        let mut buffer = OutputBuffer::default();
        buffer.append(b"hello ");
        buffer.append(b"world");

        let (text, next) = buffer.read_from(0, false);
        assert_eq!(text, "hello world");
        assert_eq!(next, 11);

        // 从上次的位置继续读：没有新内容
        let (text, next) = buffer.read_from(next, false);
        assert_eq!(text, "");
        assert_eq!(next, 11);

        buffer.append(b"!");
        let (text, _) = buffer.read_from(11, false);
        assert_eq!(text, "!");
    }

    #[test]
    fn output_buffer_keeps_the_tail_when_too_big() {
        let mut buffer = OutputBuffer::default();
        buffer.append(&vec![b'a'; MAX_SHELL_BYTES + 100]);

        assert_eq!(buffer.total(), MAX_SHELL_BYTES + 100);
        assert_eq!(buffer.dropped(), 100);

        // 从头读拿到的是保留下来的尾部，长度正好是上限
        let (text, next) = buffer.read_from(0, false);
        assert_eq!(text.len(), MAX_SHELL_BYTES);
        assert_eq!(next, MAX_SHELL_BYTES + 100);

        // offset 落在已经被丢掉的区间里时，也从保留区开头给
        let (text, _) = buffer.read_from(50, false);
        assert_eq!(text.len(), MAX_SHELL_BYTES);
    }

    #[test]
    fn session_reports_done_only_after_exit_code() {
        let session = ShellSession::new(
            "sh-1".to_string(),
            "echo hi".to_string(),
            1,
            "s-1".to_string(),
            "会话".to_string(),
        );
        assert!(!session.is_done());
        assert_eq!(session.code(), None);

        session.append_output(b"hi\n");
        session.mark_done(0);

        assert!(session.is_done());
        assert_eq!(session.code(), Some(0));
    }
}
