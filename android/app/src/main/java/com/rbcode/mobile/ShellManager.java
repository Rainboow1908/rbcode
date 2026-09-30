package com.rbcode.mobile;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 后台命令管理：和电脑端 companion 的 shell.* 语义一致 ——
 * spawn 立刻返回 id，output 按 offset 读增量，wait 等结束，kill 结束进程。
 * 输出缓冲每个会话上限 512KB，超出丢最旧的并记 dropped。
 * 带 sessionId 时只允许操作该会话起的命令（和电脑端一致）。
 */
public final class ShellManager {
  private static final int MAX_CHARS = 512 * 1024;

  public static final class Session {
    final String id;
    final String command;
    final String sessionId;
    final long pid;
    final long startedAt = System.currentTimeMillis();
    final Process process;
    final StringBuilder out = new StringBuilder();
    volatile boolean done;
    volatile Integer exitCode;
    volatile int dropped;
    /** 用户从前端「终端」面板手动结束的 */
    volatile boolean killed = false;
    /** 超过 timeout 被强制结束的 */
    volatile boolean timedOut = false;
    /** 常驻会话终端：一直开着，手动关才没 */
    volatile boolean console = false;
    /** 常驻终端对应的根目录（切项目时按它复用/重建） */
    String consoleRoot = "";
    /** 是不是真伪终端（PTY）：是的话回显/提示符由 shell 自己负责，前端不再本地回显 */
    volatile boolean pty = false;
    /** 常驻终端的 stdin（命令写这里） */
    java.io.OutputStream stdin;

    Session(String id, String command, String sessionId, Process process) {
      this.id = id;
      this.command = command;
      this.sessionId = sessionId;
      this.process = process;
      long p = 0;
      try { p = ((Number) Process.class.getMethod("pid").invoke(process)).longValue(); } catch (Throwable ignored) {}
      this.pid = p;
    }

    synchronized void append(String s) {
      if (s == null || s.isEmpty()) return;
      out.append(s);
      if (out.length() > MAX_CHARS) {
        int cut = out.length() - MAX_CHARS;
        out.delete(0, cut);
        dropped += cut;
      }
    }

    synchronized String slice(int from) {
      if (from <= 0) return out.toString();
      if (from >= out.length()) return "";
      return out.substring(from);
    }

    synchronized int size() { return out.length(); }
  }

  private final Map<String, Session> sessions = new ConcurrentHashMap<>();
  private final LinuxEnv linux;
  private File root;

  public ShellManager(Context ctx, File root) {
    this.root = root;
    this.linux = LinuxEnv.get(ctx);
  }

  public void setRoot(File root) { this.root = root; }

  /** 会话归属校验：传了 sessionId 就必须一致。 */
  public Session require(String id, String sessionId) {
    Session s = sessions.get(id);
    if (s == null) throw new IllegalStateException("找不到该终端会话：" + id);
    if (sessionId != null && s.sessionId != null && !sessionId.equals(s.sessionId)) {
      throw new IllegalStateException("这个终端不属于当前会话，拒绝访问。");
    }
    return s;
  }

  private void drain(InputStream in, Session session) {
    byte[] buf = new byte[8192];
    int n;
    try {
      while ((n = in.read(buf)) > 0) {
        session.append(new String(buf, 0, n, StandardCharsets.UTF_8));
      }
    } catch (IOException ignored) {}
  }

  private Process start(String command) throws IOException {
    ProcessBuilder pb;
    if (linux != null && linux.isReady()) {
      // 内置 Linux 就绪：命令跑在 proot 的 Ubuntu guest 里（有 apt / python3 / node / git）
      pb = new ProcessBuilder(linux.command(command, root));
      pb.environment().clear();
      pb.environment().putAll(linux.environment());
      pb.directory(linux.workDir());
    } else {
      // 回退：Android 系统自带的 sh（只有 toybox 命令）
      pb = new ProcessBuilder("sh", "-c", command);
      pb.directory(root);
    }
    pb.redirectErrorStream(true);
    return pb.start();
  }

  public Map<String, Object> exec(String command, long timeoutMs, String sessionId)
      throws IOException, InterruptedException {
    // 前台也走 spawn：这样它会出现在终端栏里、能看到实时输出，也能被「结束」。
    // 跑完从 sessions 里移除 —— 前端是「结束即移除」。
    Session s = spawn(command, sessionId);
    final java.util.concurrent.atomic.AtomicBoolean timedOut = new java.util.concurrent.atomic.AtomicBoolean(false);
    if (timeoutMs > 0) {
      Thread watchdog = new Thread(() -> {
        try {
          Thread.sleep(timeoutMs);
        } catch (InterruptedException e) {
          return;
        }
        if (!s.done) {
          timedOut.set(true);
          s.timedOut = true;
          try { s.process.destroy(); } catch (Throwable ignored) {}
          try { s.process.destroyForcibly(); } catch (Throwable ignored) {}
          try { s.process.getInputStream().close(); } catch (Throwable ignored) {}
        }
      }, "shell-timeout");
      watchdog.setDaemon(true);
      watchdog.start();
    }
    // 被 kill / 超时 / 正常退出都会把 done 置上
    while (!s.done) {
      Thread.sleep(50);
    }
    // kill() 是「先置 done、再关流」，给读取线程一点时间收完最后一段输出
    Thread.sleep(120);
    String output;
    synchronized (s) {
      output = s.out.toString();
    }
    sessions.remove(s.id);
    Map<String, Object> out = new java.util.HashMap<>();
    out.put("stdout", output);
    out.put("stderr", "");
    out.put("exitCode", s.exitCode == null ? -1 : s.exitCode);
    out.put("timedOut", timedOut.get());
    out.put("killed", s.killed);
    return out;
  }

  public Session spawn(String command, String sessionId) throws IOException {
    Process p = start(command);
    Session s = new Session(UUID.randomUUID().toString().substring(0, 8), command, sessionId, p);
    s.stdin = p.getOutputStream();
    sessions.put(s.id, s);
    Thread reader = new Thread(() -> {
      drain(p.getInputStream(), s);
      try { s.exitCode = p.waitFor(); } catch (InterruptedException ignored) {}
      s.done = true;
    }, "shell-" + s.id);
    reader.setDaemon(true);
    reader.start();
    return s;
  }

  private Process startConsole() throws IOException {
    ProcessBuilder pb;
    if (linux != null && linux.isReady()) {
      // guest 里的常驻 sh：用 script 开一个真 PTY（提示符/回显/退格/Ctrl+C 都正常）
      pb = new ProcessBuilder(linux.ptyArgv(root));
      pb.environment().clear();
      pb.environment().putAll(linux.environment());
      pb.directory(linux.workDir());
    } else {
      pb = new ProcessBuilder("sh");
      pb.directory(root);
    }
    pb.redirectErrorStream(true);
    return pb.start();
  }

  /** 打开（或复用）常驻会话终端：同一个根目录复用，一直开着，手动关才没 */
  public Session console(String sessionId) throws IOException {
    String key = root == null ? "" : root.getAbsolutePath();
    for (Session s : sessions.values()) {
      if (s.console && !s.done && key.equals(s.consoleRoot)) return s;
    }
    // 最多留 3 个（切项目来回切不会攒一堆）
    trimConsoles(2);
    Process p = startConsole();
    Session s = new Session(UUID.randomUUID().toString().substring(0, 8), "(会话终端)", sessionId, p);
    s.console = true;
    s.consoleRoot = key;
    // guest 就绪时用的是 script（真 PTY）；否则是普通 sh（没有提示符/回显）
    s.pty = linux != null && linux.isReady();
    s.stdin = p.getOutputStream();
    sessions.put(s.id, s);
    Thread reader = new Thread(() -> {
      drain(p.getInputStream(), s);
      try { s.exitCode = p.waitFor(); } catch (InterruptedException ignored) {}
      s.done = true;
    }, "console-" + s.id);
    reader.setDaemon(true);
    reader.start();
    return s;
  }

  /** 常驻终端最多留 keep 个：超了就把最老的关掉 */
  private void trimConsoles(int keep) {
    List<Session> consoles = new ArrayList<>();
    for (Session s : sessions.values()) {
      if (s.console && !s.done) consoles.add(s);
    }
    if (consoles.size() <= keep) return;
    consoles.sort(Comparator.comparingLong((Session s) -> s.startedAt));
    int remove = consoles.size() - keep;
    for (int i = 0; i < remove; i++) {
      Session s = consoles.get(i);
      s.killed = true;
      s.done = true;
      try { if (s.stdin != null) s.stdin.close(); } catch (Throwable ignored) {}
      try { s.process.destroy(); } catch (Throwable ignored) {}
    }
  }

  /** 往常驻会话终端写一段（一条命令 + 换行） */
  public void write(String id, String data, String sessionId) throws IOException {
    Session s = require(id, sessionId);
    if (s.stdin == null) throw new IllegalStateException("这个会话没有 stdin（不是常驻终端）");
    s.stdin.write(data.getBytes(StandardCharsets.UTF_8));
    s.stdin.flush();
  }

  /** 关掉所有常驻会话终端（换工作目录时用） */
  public void closeConsoles() {
    for (Session s : sessions.values()) {
      if (!s.console) continue;
      s.killed = true;
      s.done = true;
      try { if (s.stdin != null) s.stdin.close(); } catch (Throwable ignored) {}
      try { s.process.destroy(); } catch (Throwable ignored) {}
    }
  }

  public List<Session> list() {
    List<Session> items = new ArrayList<>(sessions.values());
    items.sort(Comparator.comparingLong((Session s) -> s.startedAt).reversed());
    return items;
  }

  public void kill(String id, String sessionId) {
    Session s = require(id, sessionId);
    // 先标记结束：前端轮询只收「还在跑」的，标记后它就会从列表消失
    s.killed = true;
    s.done = true;
    try { s.process.destroy(); } catch (Throwable ignored) {}
    try { s.process.destroyForcibly(); } catch (Throwable ignored) {}
    // 关掉输出流，别让读取线程一直阻塞
    try { s.process.getInputStream().close(); } catch (Throwable ignored) {}
    try { s.process.getErrorStream(); } catch (Throwable ignored) {}
  }
}
