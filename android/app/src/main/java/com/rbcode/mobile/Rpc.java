package com.rbcode.mobile;

import android.content.Context;
import android.content.Intent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * /rpc 的方法分发。方法名与电脑端 companion 完全一致，
 * 这样前端一行不改就能连它。
 */
public final class Rpc {
  private final Context ctx;
  private final AppState state;
  private final ShellManager shells;

  public Rpc(Context ctx) {
    this.ctx = ctx.getApplicationContext();
    this.state = AppState.get(this.ctx);
    this.shells = new ShellManager(this.ctx, new File(state.root()));
  }

  public AppState state() { return state; }

  /** 用系统文件 App 打开某个路径：目录按「文件夹」MIME，文件按扩展名判断 MIME */
  private void reveal(String path) {
    File target = new File(path);
    if (!target.exists()) throw new IllegalStateException("路径不存在：" + path);
    // 通过自带的最小 FileProvider 换成 content://（Android 7+ 不允许暴露 file://）
    android.net.Uri uri = FileProviderLite.uriFor(ctx, target);
    Intent intent;
    if (target.isDirectory()) {
      intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "resource/folder");
    } else {
      String ext = android.webkit.MimeTypeMap.getFileExtensionFromUrl(path);
      String type = ext == null
          ? null
          : android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
      intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, type == null ? "*/*" : type);
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
    try {
      ctx.startActivity(intent);
    } catch (Exception first) {
      // 有些系统没有认得 resource/folder 的文件管理器：退回用通用方式再试一次
      try {
        ctx.startActivity(new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "*/*")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION));
      } catch (Exception second) {
        throw new IllegalStateException("没有能打开这个路径的文件 App");
      }
    }
  }

  public JSONObject dispatch(String op, JSONObject p) throws Exception {
    switch (op) {
      /* -------------------------------- 环境 -------------------------------- */
      case "env.setRoot": {
        state.setRoot(p.optString("root", state.root()));
        shells.setRoot(new File(state.root()));
        // 注意：这里不关会话终端 —— 切走再切回来还要接着用（每个根目录一份）
        JSONObject r = new JSONObject();
        r.put("root", state.root());
        return r;
      }
      case "env.listDir":
        return listDir(p.optString("path", state.root()));
      case "env.drives": {
        JSONArray arr = new JSONArray();
        for (String d : new String[]{"/sdcard", "/storage/emulated/0", "/storage", "/"}) {
          if (new File(d).exists()) arr.put(d);
        }
        JSONObject r = new JSONObject();
        r.put("drives", arr);
        return r;
      }
      case "env.paths": {
        JSONObject r = new JSONObject();
        r.put("home", "/sdcard");
        r.put("appData", ctx.getFilesDir().getAbsolutePath());
        r.put("localAppData", ctx.getCacheDir().getAbsolutePath());
        return r;
      }
      case "env.reveal":
        reveal(p.optString("path", state.root()));
        {
          JSONObject r = new JSONObject();
          r.put("ok", true);
          return r;
        }

      /* --------------------------------- 文件 -------------------------------- */
      case "fs.read":
        return jsonPut("content", readText(resolve(p.getString("path"))));
      case "fs.write": {
        File f = resolve(p.getString("path"));
        mkparents(f);
        try (FileOutputStream out = new FileOutputStream(f)) {
          out.write(p.optString("content", "").getBytes(StandardCharsets.UTF_8));
        }
        return new JSONObject();
      }
      case "fs.list":
        return listDir(p.optString("path", state.root()));
      case "fs.exists": {
        JSONObject r = new JSONObject();
        r.put("exists", resolve(p.getString("path")).exists());
        return r;
      }
      case "fs.mkdir": {
        resolve(p.getString("path")).mkdirs();
        return new JSONObject();
      }
      case "fs.remove": {
        File f = resolve(p.getString("path"));
        deleteRecursive(f, p.optBoolean("recursive", false));
        return new JSONObject();
      }
      case "fs.glob": {
        JSONArray matches = new JSONArray();
        glob(new File(state.root()), "", p.getString("pattern"), matches, 2000);
        JSONObject r = new JSONObject();
        r.put("matches", matches);
        return r;
      }
      case "fs.grep": {
        JSONObject r = new JSONObject();
        r.put("output", grep(p));
        return r;
      }
      case "fs.readBase64": {
        File f = resolve(p.getString("path"));
        byte[] bytes = readBytes(f);
        JSONObject r = new JSONObject();
        r.put("base64", Base64.getEncoder().encodeToString(bytes));
        r.put("size", bytes.length);
        return r;
      }
      case "fs.writeBase64": {
        File f = resolve(p.getString("path"));
        mkparents(f);
        byte[] bytes = Base64.getDecoder().decode(p.getString("base64"));
        try (FileOutputStream out = new FileOutputStream(f)) { out.write(bytes); }
        JSONObject r = new JSONObject();
        r.put("bytes", bytes.length);
        return r;
      }

      /* --------------------------------- 命令 -------------------------------- */
      case "shell.exec": {
        String sessionId = p.optString("sessionId", null);
        int timeoutMs = p.optInt("timeoutMs", 0);
        JSONObject r = new JSONObject(shells.exec(p.getString("command"), timeoutMs, sessionId));
        if (sessionId != null) r.put("sessionId", sessionId);
        return r;
      }
      case "shell.console": {
        ShellManager.Session s = shells.console(p.optString("sessionId", null));
        JSONObject r = new JSONObject();
        r.put("id", s.id);
        r.put("pid", s.pid);
        r.put("command", s.command);
        return r;
      }
      case "shell.write": {
        shells.write(p.getString("id"), p.getString("data"), p.optString("sessionId", null));
        JSONObject r = new JSONObject();
        r.put("ok", true);
        return r;
      }
      case "shell.spawn": {
        ShellManager.Session s = shells.spawn(p.getString("command"), p.optString("sessionId", null));
        JSONObject r = new JSONObject();
        r.put("id", s.id);
        r.put("pid", s.pid);
        return r;
      }
      case "shell.output":
        return shellOutput(p);
      case "shell.wait":
        return shellWait(p);
      case "shell.list": {
        JSONArray arr = new JSONArray();
        for (ShellManager.Session s : shells.list()) {
          JSONObject o = new JSONObject();
          o.put("id", s.id);
          o.put("command", s.command);
          o.put("pid", s.pid);
          o.put("startedAt", s.startedAt);
          if (s.sessionId != null) o.put("sessionId", s.sessionId);
          o.put("done", s.done);
          if (s.exitCode != null) o.put("exitCode", s.exitCode);
          o.put("killed", s.killed);
          o.put("console", s.console);
          o.put("pty", s.pty);
          arr.put(o);
        }
        JSONObject r = new JSONObject();
        r.put("commands", arr);
        return r;
      }
      case "shell.kill": {
        shells.kill(p.getString("id"), p.optString("sessionId", null));
        return new JSONObject();
      }

      /* --------------------------------- 联网 -------------------------------- */
      case "web.fetch":
        return webFetch(p.getString("url"), p.optString("proxy", null));
      case "web.search":
        return webSearch(p.getString("query"), p.optString("engine", "auto"), p.optString("proxy", null),
            p.optInt("max_results", 8));

      /* ------------------------------ computer use ---------------------------- */
      case "computer.screen":
        return AgentAccessibilityService.screen(p.optInt("maxWidth", 1280));
      case "computer.actions": {
        JSONArray actions = p.optJSONArray("actions");
        int applied = AgentAccessibilityService.actions(actions == null ? new JSONArray() : actions);
        JSONObject r = new JSONObject();
        r.put("applied", applied);
        return r;
      }

      /* ------------------------------ music / mcp ----------------------------- */
      case "music.api": {
        JSONObject r = new JSONObject();
        r.put("data", musicApi(p));
        return r;
      }
      case "music.cover":
        return musicCover(p);
      case "music.download":
        return musicDownload(p);
      case "mcp.list":
      case "mcp.call":
      case "mcp.stop":
        throw new IllegalStateException(
            "手机版暂不支持 MCP（浏览器 MCP 默认关闭；自定义 MCP 需要 node/npx，手机版不带）。");

      default:
        throw new IllegalStateException("unknown op: " + op);
    }
  }

  /* ------------------------------------ 文件实现 ------------------------------------ */

  private File resolve(String path) {
    if (path == null || path.trim().isEmpty()) return new File(state.root());
    File f = new File(path);
    return f.isAbsolute() ? f : new File(state.root(), path);
  }

  private static void mkparents(File f) {
    File parent = f.getParentFile();
    if (parent != null && !parent.exists()) parent.mkdirs();
  }

  private static String readText(File f) throws Exception {
    return new String(readBytes(f), StandardCharsets.UTF_8);
  }

  private static byte[] readBytes(File f) throws Exception {
    try (InputStream in = new FileInputStream(f)) {
      ByteArrayOutputStream bos = new ByteArrayOutputStream();
      byte[] buf = new byte[8192];
      int n;
      while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
      return bos.toByteArray();
    }
  }

  private static void deleteRecursive(File f, boolean recursive) throws Exception {
    if (f.isDirectory()) {
      File[] kids = f.listFiles();
      if (kids != null && kids.length > 0 && !recursive)
        throw new IllegalStateException("目录非空：" + f.getAbsolutePath());
      if (kids != null) for (File k : kids) deleteRecursive(k, true);
    }
    if (!f.delete() && f.exists()) throw new IllegalStateException("删除失败：" + f.getAbsolutePath());
  }

  private JSONObject listDir(String path) throws Exception {
    File dir = resolve(path);
    JSONArray arr = new JSONArray();
    File[] kids = dir.listFiles();
    if (kids != null) {
      java.util.Arrays.sort(kids, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
      for (File c : kids) {
        JSONObject o = new JSONObject();
        o.put("path", c.getAbsolutePath());
        o.put("name", c.getName());
        o.put("kind", c.isDirectory() ? "dir" : "file");
        o.put("size", c.length());
        o.put("modified", c.lastModified());
        arr.put(o);
      }
    }
    JSONObject r = new JSONObject();
    r.put("entries", arr);
    return r;
  }

  private void glob(File dir, String rel, String pattern, JSONArray out, int limit) throws Exception {
    if (out.length() >= limit) return;
    File[] kids = dir.listFiles();
    if (kids == null) return;
    java.util.regex.Pattern rx = globToRegex(pattern);
    for (File c : kids) {
      String childRel = rel.isEmpty() ? c.getName() : rel + "/" + c.getName();
      if (c.isDirectory()) {
        if (c.getName().equals(".git") || c.getName().equals("node_modules")) continue;
        glob(c, childRel, pattern, out, limit);
      } else if (rx.matcher(childRel).matches()) {
        out.put(childRel);
      }
    }
  }

  private static java.util.regex.Pattern globToRegex(String glob) {
    StringBuilder sb = new StringBuilder("^");
    for (int i = 0; i < glob.length(); i++) {
      char c = glob.charAt(i);
      if (c == '*') {
        if (i + 1 < glob.length() && glob.charAt(i + 1) == '*') { sb.append(".*"); i++; }
        else sb.append("[^/]*");
      } else if (c == '?') sb.append('.');
      else if ("\\.[]{}()+-^$|".indexOf(c) >= 0) sb.append('\\').append(c);
      else sb.append(c);
    }
    sb.append('$');
    return java.util.regex.Pattern.compile(sb.toString());
  }

  private String grep(JSONObject p) throws Exception {
    String pattern = p.getString("pattern");
    String include = p.optString("include", null);
    int max = p.optInt("maxResults", 200);
    java.util.regex.Pattern rx = java.util.regex.Pattern.compile(pattern, p.optBoolean("ignoreCase", false) ? java.util.regex.Pattern.CASE_INSENSITIVE : 0);
    java.util.regex.Pattern incRx = include == null || include.isEmpty() ? null : globToRegex(include);
    StringBuilder sb = new StringBuilder();
    int[] count = {0};
    grepWalk(new File(state.root()), "", rx, incRx, sb, count, max);
    return sb.toString();
  }

  private void grepWalk(File dir, String rel, java.util.regex.Pattern rx, java.util.regex.Pattern incRx,
                        StringBuilder sb, int[] count, int max) {
    if (count[0] >= max) return;
    File[] kids = dir.listFiles();
    if (kids == null) return;
    for (File c : kids) {
      if (count[0] >= max) return;
      String childRel = rel.isEmpty() ? c.getName() : rel + "/" + c.getName();
      if (c.isDirectory()) {
        if (c.getName().equals(".git") || c.getName().equals("node_modules")) continue;
        grepWalk(c, childRel, rx, incRx, sb, count, max);
      } else {
        if (incRx != null && !incRx.matcher(childRel).matches()) continue;
        if (c.length() > 2 * 1024 * 1024) continue;
        try {
          String[] lines = readText(c).split("\n", -1);
          for (int i = 0; i < lines.length && count[0] < max; i++) {
            if (rx.matcher(lines[i]).find()) {
              sb.append(childRel).append(':').append(i + 1).append(':').append(lines[i]).append('\n');
              count[0]++;
            }
          }
        } catch (Exception ignored) {}
      }
    }
  }

  /* ------------------------------------ 命令实现 ------------------------------------ */

  private JSONObject shellOutput(JSONObject p) throws Exception {
    ShellManager.Session s = requireSession(p);
    int offset = p.optInt("offset", 0);
    int size = s.size();
    JSONObject r = new JSONObject();
    r.put("id", s.id);
    r.put("output", s.slice(offset));
    r.put("nextOffset", size);
    r.put("dropped", s.dropped);
    r.put("done", s.done);
    r.put("exitCode", s.exitCode == null ? JSONObject.NULL : s.exitCode);
    r.put("killed", s.killed);
    return r;
  }

  private JSONObject shellWait(JSONObject p) throws Exception {
    ShellManager.Session s = requireSession(p);
    long deadline = System.currentTimeMillis() + Math.min(p.optInt("timeoutMs", 30000), 180000);
    while (!s.done && System.currentTimeMillis() < deadline) Thread.sleep(100);
    JSONObject r = shellOutput(p);
    r.put("timedOut", !s.done);
    return r;
  }

  private ShellManager.Session requireSession(JSONObject p) throws Exception {
    return shells.require(p.getString("id"), p.optString("sessionId", null));
  }

  /* ------------------------------------ 联网实现 ------------------------------------ */

  private static HttpURLConnection open(String url, String proxy) throws Exception {
    URL u = new URL(url);
    HttpURLConnection conn;
    if (proxy != null && !proxy.isEmpty()) {
      URL pu = new URL(proxy);
      conn = (HttpURLConnection) u.openConnection(
          new Proxy(Proxy.Type.HTTP, new InetSocketAddress(pu.getHost(), pu.getPort())));
    } else {
      conn = (HttpURLConnection) u.openConnection();
    }
    conn.setConnectTimeout(8000);
    conn.setReadTimeout(15000);
    return conn;
  }

  private JSONObject webFetch(String url, String proxy) throws Exception {
    HttpURLConnection conn = open(url, proxy);
    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) RBCode");
    int status = conn.getResponseCode();
    String contentType = String.valueOf(conn.getContentType());
    InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
    String body = in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
    JSONObject r = new JSONObject();
    r.put("url", url);
    r.put("status", status);
    r.put("contentType", contentType);
    r.put("title", extractTitle(body));
    r.put("text", htmlToText(body));
    return r;
  }

  private JSONObject webSearch(String query, String engine, String proxy, int maxResults) throws Exception {
    String q = java.net.URLEncoder.encode(query, "UTF-8");
    JSONArray results = new JSONArray();
    String note = null;
    String used = "bing";
    try {
      String rss = "https://www.bing.com/search?format=rss&q=" + q;
      HttpURLConnection conn = open(rss, proxy);
      conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) RBCode");
      String body = new String(readAll(conn.getInputStream()), StandardCharsets.UTF_8);
      java.util.regex.Matcher m = java.util.regex.Pattern
          .compile("<item>(.*?)</item>", java.util.regex.Pattern.DOTALL).matcher(body);
      while (m.find() && results.length() < maxResults) {
        String item = m.group(1);
        String title = tag(item, "title");
        String link = tag(item, "link");
        String desc = tag(item, "description");
        JSONObject o = new JSONObject();
        o.put("title", title);
        o.put("url", link);
        o.put("snippet", desc);
        results.put(o);
      }
    } catch (Exception e) {
      note = "Bing 搜索失败：" + e.getMessage();
    }
    if (results.length() == 0 && note == null) note = "没有找到结果";
    JSONObject r = new JSONObject();
    r.put("engine", used);
    r.put("results", results);
    if (note != null) r.put("note", note);
    return r;
  }

  private static String tag(String xml, String name) {
    java.util.regex.Matcher m = java.util.regex.Pattern
        .compile("<" + name + ">(.*?)</" + name + ">", java.util.regex.Pattern.DOTALL).matcher(xml);
    if (!m.find()) return "";
    String s = m.group(1);
    s = s.replace("<![CDATA[", "").replace("]]>", "");
    return decodeEntities(s).trim();
  }

  private static String extractTitle(String html) {
    java.util.regex.Matcher m = java.util.regex.Pattern
        .compile("<title[^>]*>(.*?)</title>", java.util.regex.Pattern.DOTALL | java.util.regex.Pattern.CASE_INSENSITIVE)
        .matcher(html);
    return m.find() ? decodeEntities(m.group(1)).trim() : "";
  }

  private static String htmlToText(String html) {
    String s = html.replaceAll("(?is)<script.*?</script>", " ")
        .replaceAll("(?is)<style.*?</style>", " ")
        .replaceAll("(?s)<[^>]+>", " ");
    return decodeEntities(s).replaceAll("\\s+", " ").trim();
  }

  private static String decodeEntities(String s) {
    return s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        .replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ");
  }

  private static byte[] readAll(InputStream in) throws Exception {
    if (in == null) return new byte[0];
    ByteArrayOutputStream bos = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
    return bos.toByteArray();
  }

  /* ------------------------------------ 音乐实现 ------------------------------------ */

  private static final java.util.Set<String> MUSIC_TYPES =
      java.util.Set.of("search", "url", "pic", "lyric");
  private static final java.util.Set<String> MUSIC_SOURCES = java.util.Set.of(
      "netease", "tencent", "kuwo", "tidal", "qobuz", "joox", "bilibili", "apple", "ytmusic", "spotify");

  /** 按桌面端 companion 的规则拼上游 URL（别让它变成任意 URL 代理）。 */
  private String musicUrl(JSONObject p, String forceTypes) throws Exception {
    String base = p.optString("base", "");
    if (base.isEmpty()) base = "https://music-api.gdstudio.xyz/api.php";
    if (!base.startsWith("http://") && !base.startsWith("https://"))
      throw new IllegalStateException("音乐 API 地址必须是 http/https");
    String types = forceTypes != null ? forceTypes : p.optString("types", "");
    if (!MUSIC_TYPES.contains(types)) throw new IllegalStateException("不支持的 types：" + types);
    String source = p.optString("source", "netease");
    String bare = source.contains("_") ? source.substring(0, source.indexOf('_')) : source;
    if (!MUSIC_SOURCES.contains(bare)) throw new IllegalStateException("不支持的音乐源：" + source);

    StringBuilder url = new StringBuilder(base).append("?types=").append(enc(types))
        .append("&source=").append(enc(source));
    String id = p.optString("id", "");
    if (!id.isEmpty()) url.append("&id=").append(enc(id));
    String name = p.optString("name", "");
    if (!name.isEmpty()) url.append("&name=").append(enc(name));
    if (p.has("count")) url.append("&count=").append(Math.max(1, Math.min(50, p.optInt("count"))));
    if (p.has("pages")) url.append("&pages=").append(Math.max(1, Math.min(100, p.optInt("pages"))));
    if (p.has("br")) url.append("&br=").append(p.optInt("br"));
    if (p.has("size")) url.append("&size=").append(p.optInt("size") == 500 ? 500 : 300);
    return url.toString();
  }

  private Object musicApi(JSONObject p) throws Exception {
    String url = musicUrl(p, null);
    HttpURLConnection conn = open(url, p.optString("proxy", null));
    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) RBCode");
    int status = conn.getResponseCode();
    InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
    String body = new String(readAll(in), StandardCharsets.UTF_8);
    Object data;
    try {
      data = new org.json.JSONTokener(body).nextValue();
    } catch (Exception e) {
      data = body.length() > 400 ? body.substring(0, 400) : body;
    }
    if (status < 200 || status >= 300) {
      String detail = data instanceof JSONObject
          ? ((JSONObject) data).optString("detail", "上游返回了错误") : "上游返回了错误";
      throw new IllegalStateException(detail + "（HTTP " + status + "）");
    }
    return data;
  }

  private JSONObject musicCover(JSONObject p) throws Exception {
    String proxy = p.optString("proxy", null);
    // 先按 types=pic 拿封面直链，再把图片取回来（和桌面端一致）
    HttpURLConnection apiConn = open(musicUrl(p, "pic"), proxy);
    apiConn.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) RBCode");
    String body = new String(readAll(apiConn.getInputStream()), StandardCharsets.UTF_8);
    Object data = new org.json.JSONTokener(body).nextValue();
    String pic = data instanceof JSONObject ? ((JSONObject) data).optString("url", "") : "";
    if (pic.isEmpty()) throw new IllegalStateException("这首歌没有封面");
    if (!pic.startsWith("http://") && !pic.startsWith("https://"))
      throw new IllegalStateException("封面地址不是 http/https");
    HttpURLConnection conn = open(pic, proxy);
    byte[] bytes = readAll(conn.getInputStream());
    JSONObject r = new JSONObject();
    r.put("mime", String.valueOf(conn.getContentType()));
    r.put("size", bytes.length);
    r.put("base64", Base64.getEncoder().encodeToString(bytes));
    return r;
  }

  private JSONObject musicDownload(JSONObject p) throws Exception {
    String proxy = p.optString("proxy", null);
    HttpURLConnection apiConn = open(musicUrl(p, "url"), proxy);
    apiConn.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) RBCode");
    String body = new String(readAll(apiConn.getInputStream()), StandardCharsets.UTF_8);
    Object data = new org.json.JSONTokener(body).nextValue();
    String direct = data instanceof JSONObject ? ((JSONObject) data).optString("url", "") : "";
    if (direct.isEmpty()) throw new IllegalStateException("这首歌拿不到直链（可能没版权 / 需要会员）");
    HttpURLConnection conn = open(direct, proxy);
    byte[] bytes = readAll(conn.getInputStream());
    String mime = String.valueOf(conn.getContentType());
    String ext = mime.contains("flac") ? ".flac"
        : mime.contains("mp4") || mime.contains("m4a") ? ".m4a"
        : mime.contains("ogg") ? ".ogg"
        : mime.contains("wav") ? ".wav" : ".mp3";
    String stem = p.optString("name", "track-" + p.optString("id", "song"))
        .replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_");
    JSONObject r = new JSONObject();
    r.put("name", stem + ext);
    r.put("mime", mime);
    r.put("size", bytes.length);
    r.put("base64", Base64.getEncoder().encodeToString(bytes));
    return r;
  }

  private static String enc(String value) throws Exception {
    return java.net.URLEncoder.encode(value, "UTF-8");
  }

  private static JSONObject jsonPut(String key, Object value) throws Exception {
    JSONObject o = new JSONObject();
    o.put(key, value);
    return o;
  }
}
