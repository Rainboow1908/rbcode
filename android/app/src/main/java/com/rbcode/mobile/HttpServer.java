package com.rbcode.mobile;

import android.content.Context;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * 极简 HTTP 服务：不引第三方库。
 * 路由：GET /ping、POST /rpc（配对令牌校验），其余当作静态资源（打包进去的网页前端），
 * 命中不到就回退 index.html（SPA）。
 */
public final class HttpServer {
  private final Context ctx;
  private final AppState state;
  private final Rpc rpc;
  private volatile boolean running;
  private ServerSocket socket;

  public HttpServer(Context ctx) {
    this.ctx = ctx.getApplicationContext();
    this.state = AppState.get(this.ctx);
    this.rpc = new Rpc(this.ctx);
  }

  public Rpc rpc() { return rpc; }

  public void start() throws IOException {
    running = true;
    socket = new ServerSocket(AppState.PORT, 32, InetAddress.getByName("127.0.0.1"));
    Thread accept = new Thread(() -> {
      while (running) {
        try {
          Socket client = socket.accept();
          Thread t = new Thread(() -> handle(client), "http");
          t.setDaemon(true);
          t.start();
        } catch (IOException e) {
          if (running) e.printStackTrace();
        }
      }
    }, "rbcode-http");
    accept.setDaemon(true);
    accept.start();
  }

  public void stop() {
    running = false;
    try { if (socket != null) socket.close(); } catch (IOException ignored) {}
  }

  private void handle(Socket client) {
    try (Socket c = client) {
      c.setSoTimeout(30000);
      BufferedInputStream in = new BufferedInputStream(c.getInputStream());
      OutputStream out = new BufferedOutputStream(c.getOutputStream());

      String requestLine = readLine(in);
      if (requestLine == null || requestLine.isEmpty()) return;
      String[] parts = requestLine.split(" ");
      String method = parts.length > 0 ? parts[0] : "GET";
      String path = parts.length > 1 ? parts[1] : "/";
      int q = path.indexOf('?');
      String rawQuery = q >= 0 ? path.substring(q + 1) : "";
      if (q >= 0) path = path.substring(0, q);

      Map<String, String> headers = new HashMap<>();
      String line;
      while ((line = readLine(in)) != null && !line.isEmpty()) {
        int idx = line.indexOf(':');
        if (idx > 0) headers.put(line.substring(0, idx).trim().toLowerCase(Locale.ROOT), line.substring(idx + 1).trim());
      }
      int length = 0;
      try { length = Integer.parseInt(headers.getOrDefault("content-length", "0")); } catch (Exception ignored) {}
      byte[] body = new byte[length];
      int read = 0;
      while (read < length) {
        int n = in.read(body, read, length - read);
        if (n < 0) break;
        read += n;
      }

      if (method.equals("OPTIONS")) {
        respond(out, 204, "text/plain", new byte[0]);
        return;
      }

      if (path.equals("/ping")) {
        JSONObject ping = new JSONObject();
        ping.put("name", "rbcode-mobile");
        ping.put("version", "0.1.0");
        ping.put("platform", "android");
        ping.put("root", state.root());
        ping.put("tokenRequired", true);
        respond(out, 200, "application/json", ping.toString().getBytes(StandardCharsets.UTF_8));
        return;
      }

      if (path.equals("/rpc") && method.equals("POST")) {
        String token = headers.getOrDefault("x-rb-token", "");
        if (!token.equals(state.token())) {
          JSONObject err = new JSONObject();
          err.put("ok", false);
          err.put("error", "配对令牌不正确");
          respond(out, 401, "application/json", err.toString().getBytes(StandardCharsets.UTF_8));
          return;
        }
        JSONObject payload = new JSONObject();
        long start = System.currentTimeMillis();
        String op = "";
        try {
          JSONObject req = new JSONObject(new String(body, StandardCharsets.UTF_8));
          op = req.optString("op", "");
          JSONObject params = req.optJSONObject("params");
          JSONObject result = runOp(op, params == null ? new JSONObject() : params);
          payload.put("ok", true);
          payload.put("result", result);
          RbcLog.add(op, System.currentTimeMillis() - start, true, null);
        } catch (Exception e) {
          String message = e.getMessage() == null ? e.toString() : e.getMessage();
          payload.put("ok", false);
          payload.put("error", message);
          RbcLog.add(op, System.currentTimeMillis() - start, false, message);
        }
        respond(out, 200, "application/json", payload.toString().getBytes(StandardCharsets.UTF_8));
        return;
      }

      // 其余路径：给「后端运行中」的说明页
      serveLanding(out);
    } catch (Exception e) {
      // 单连接失败不影响服务
    }
  }

  /** 可能卡住的操作加一个按操作区分的硬超时，避免无限等。 */
  private static final ExecutorService OPS = Executors.newCachedThreadPool();
  private static final java.util.Map<String, Integer> TIMEOUTS = java.util.Map.ofEntries(
      java.util.Map.entry("web.search", 25),
      java.util.Map.entry("web.fetch", 25),
      java.util.Map.entry("music.api", 25),
      java.util.Map.entry("music.cover", 25),
      java.util.Map.entry("music.download", 60),
      java.util.Map.entry("computer.screen", 20),
      java.util.Map.entry("computer.actions", 45));

  private JSONObject runOp(String op, JSONObject params) throws Exception {
    Integer seconds = TIMEOUTS.get(op);
    if (seconds == null) return rpc.dispatch(op, params);
    Future<JSONObject> future = OPS.submit(() -> rpc.dispatch(op, params));
    try {
      return future.get(seconds, TimeUnit.SECONDS);
    } catch (java.util.concurrent.TimeoutException e) {
      future.cancel(true);
      throw new IllegalStateException(op + " 超时（" + seconds + " 秒没有结果），已中止。");
    } catch (java.util.concurrent.ExecutionException e) {
      Throwable cause = e.getCause();
      if (cause instanceof Exception) throw (Exception) cause;
      throw new IllegalStateException(cause == null ? e.toString() : cause.toString());
    }
  }

  /** 不再内置网页前端：根路径就给一个「后端运行中」的说明页。 */
  private void serveLanding(OutputStream out) throws IOException {
    String html = "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\">"
        + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        + "<title>RB Code 后端运行中</title><style>"
        + ":root{color-scheme:dark}"
        + "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;"
        + "background:#101014;color:#E6E0E9;font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif}"
        + ".card{max-width:440px;width:calc(100% - 32px);padding:28px 24px;border-radius:28px;background:#1D1B20;"
        + "box-shadow:0 10px 34px rgba(0,0,0,.45)}"
        + "h1{margin:0 0 6px;font-size:20px}"
        + "p{margin:8px 0;color:#CAC4D0;font-size:14px;line-height:1.65}"
        + ".badge{display:inline-flex;align-items:center;gap:8px;margin-bottom:18px;padding:6px 12px;"
        + "border-radius:999px;background:#4A4458;color:#E8DEF8;font-size:13px}"
        + ".dot{width:8px;height:8px;border-radius:50%;background:#7EE787}"
        + "code{background:#2B2930;padding:2px 6px;border-radius:6px;font-size:13px}"
        + ".token{margin-top:14px;padding:12px 14px;border-radius:14px;background:#2B2930;color:#D0BCFF;"
        + "font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;letter-spacing:.5px;word-break:break-all}"
        + ".hint{margin-top:16px;color:#938F99;font-size:12px}</style></head><body><div class=\"card\">"
        + "<div class=\"badge\"><span class=\"dot\"></span>本机后端运行中</div>"
        + "<h1>RB Code 后端已就绪</h1>"
        + "<p>监听地址 <code>127.0.0.1:" + AppState.PORT + "</code>。"
        + "在你部署好的网页界面里打开 <b>设置 → 执行后端</b>，把这枚配对令牌填进去：</p>"
        + "<div class=\"token\">" + state.token() + "</div>"
        + "<p class=\"hint\">这个页面只是用来确认后端在跑；网页界面请用你部署的地址打开。</p>"
        + "</div></body></html>";
    respond(out, 200, "text/html; charset=utf-8", html.getBytes(StandardCharsets.UTF_8));
  }

  private static void respond(OutputStream out, int status, String contentType, byte[] body) throws IOException {
    String reason = status == 200 ? "OK" : status == 204 ? "No Content" : status == 401 ? "Unauthorized"
        : status == 404 ? "Not Found" : "OK";
    StringBuilder head = new StringBuilder();
    head.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
    head.append("Content-Type: ").append(contentType).append("\r\n");
    head.append("Content-Length: ").append(body.length).append("\r\n");
    head.append("Access-Control-Allow-Origin: *\r\n");
    head.append("Access-Control-Allow-Headers: *\r\n");
    head.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
    head.append("Access-Control-Allow-Private-Network: true\r\n");
    head.append("Connection: close\r\n\r\n");
    out.write(head.toString().getBytes(StandardCharsets.UTF_8));
    if (body.length > 0) out.write(body);
    out.flush();
  }

  private static String readLine(InputStream in) throws IOException {
    ByteArrayOutputStream bos = new ByteArrayOutputStream();
    int c;
    while ((c = in.read()) != -1) {
      if (c == '\n') break;
      if (c != '\r') bos.write(c);
    }
    if (c == -1 && bos.size() == 0) return null;
    return bos.toString(StandardCharsets.UTF_8.name());
  }
}
