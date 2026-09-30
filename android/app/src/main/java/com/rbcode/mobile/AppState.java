package com.rbcode.mobile;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.UUID;

/** 全局状态：配对令牌、工作目录、端口。和电脑端 companion 的语义保持一致。 */
public final class AppState {
  public static final int PORT = 7717;

  private static AppState instance;

  private final SharedPreferences prefs;
  private String token;
  private String root;

  private AppState(Context ctx) {
    prefs = ctx.getApplicationContext().getSharedPreferences("rbcode", Context.MODE_PRIVATE);
    token = prefs.getString("token", null);
    // 旧版是 24 位十六进制；这里按电脑端的格式校验，不符就重新生成
    if (token == null || !token.matches("[A-Z2-9]{4}(-[A-Z2-9]{4}){7}")) {
      token = newToken();
      prefs.edit().putString("token", token).apply();
    }
    root = prefs.getString("root", "/sdcard");
  }

  public static synchronized AppState get(Context ctx) {
    if (instance == null) instance = new AppState(ctx);
    return instance;
  }

  public String token() { return token; }

  public String regenerateToken() {
    token = newToken();
    prefs.edit().putString("token", token).apply();
    return token;
  }

  public String root() { return root; }

  public void setRoot(String r) {
    root = (r == null || r.trim().isEmpty()) ? "/" : r.trim();
    prefs.edit().putString("root", root).apply();
  }

  /** 和电脑端一致的配对令牌：ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567 */
  private static String newToken() {
    final String chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    java.util.Random random = new java.security.SecureRandom();
    StringBuilder out = new StringBuilder();
    for (int group = 0; group < 8; group++) {
      if (group > 0) out.append('-');
      for (int i = 0; i < 4; i++) out.append(chars.charAt(random.nextInt(chars.length())));
    }
    return out.toString();
  }
}
