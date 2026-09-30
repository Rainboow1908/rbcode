package com.rbcode.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * 手机端主界面（Material 3 深色）。它本身就是「后端」：
 * 显示运行状态 / 配对令牌 / 权限，并在首次进入或缺少权限时弹框引导授权。
 */
public class MainActivity extends Activity {
  // Material 3 深色
  private static final int BG = 0xFF101014;
  private static final int SURFACE = 0xFF1D1B20;
  private static final int SURFACE_VARIANT = 0xFF2B2930;
  private static final int PRIMARY = 0xFFD0BCFF;
  private static final int ON_PRIMARY = 0xFF381E72;
  private static final int ON_SURFACE = 0xFFE6E0E9;
  private static final int ON_SURFACE_VARIANT = 0xFFCAC4D0;
  private static final int OUTLINE = 0xFF938F99;
  private static final int SECONDARY_CONTAINER = 0xFF4A4458;
  private static final int ON_SECONDARY_CONTAINER = 0xFFE8DEF8;
  private static final int OK = 0xFF7EE787;
  private static final int ERR = 0xFFF2B8B5;

  private TextView statusText;
  private TextView tokenText;
  private TextView permText;
  private TextView rootText;
  private TextView logText;
  private TextView linuxText;
  private LinearLayout permCard;
  private FrameLayout rootContainer;
  private View permissionOverlay;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setStatusBarColor(BG);
    getWindow().setNavigationBarColor(BG);
    rootContainer = new FrameLayout(this);
    rootContainer.setBackgroundColor(BG);
    rootContainer.addView(buildUi());
    setContentView(rootContainer);
    ServerService.start(this);
    maybeShowPermissionDialog();
    prepareLinux();
  }

  @Override
  protected void onResume() {
    super.onResume();
    refresh();
    maybeShowPermissionDialog();
  }

  /* ---------------------------------- 界面 ---------------------------------- */

  private View buildUi() {
    ScrollView scroll = new ScrollView(this);
    scroll.setBackgroundColor(BG);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(dp(18), dp(30), dp(18), dp(36));
    scroll.addView(root);

    TextView title = new TextView(this);
    title.setText("RB Code");
    title.setTextColor(ON_SURFACE);
    title.setTextSize(30);
    title.setTypeface(Typeface.DEFAULT_BOLD);
    root.addView(title);

    TextView sub = new TextView(this);
    sub.setText("手机版本机后端 · v1.0.0 · 网页界面连 127.0.0.1:" + AppState.PORT);
    sub.setTextColor(ON_SURFACE_VARIANT);
    sub.setTextSize(13);
    sub.setPadding(0, dp(6), 0, dp(20));
    root.addView(sub);

    /* 运行状态 */
    LinearLayout statusCard = card(root);
    statusText = new TextView(this);
    statusText.setTextSize(15);
    statusCard.addView(statusText);
    TextView statusHint = new TextView(this);
    statusHint.setText("网页前端部署在别处时，打开它会自动连到这台手机的后端。");
    statusHint.setTextColor(ON_SURFACE_VARIANT);
    statusHint.setTextSize(12);
    statusHint.setPadding(0, dp(8), 0, 0);
    statusCard.addView(statusHint);

    /* 配对令牌 */
    LinearLayout tokenCard = card(root);
    tokenCard.addView(label("配对令牌"));
    tokenText = new TextView(this);
    tokenText.setTextColor(PRIMARY);
    tokenText.setTextSize(16);
    tokenText.setTypeface(Typeface.MONOSPACE);
    tokenText.setTextIsSelectable(true);
    tokenText.setPadding(0, dp(8), 0, dp(12));
    tokenCard.addView(tokenText);
    LinearLayout tokenRow = new LinearLayout(this);
    tokenRow.setOrientation(LinearLayout.HORIZONTAL);
    LinearLayout.LayoutParams copyLp = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    copyLp.rightMargin = dp(8);
    tokenRow.addView(filledButton("复制", v -> copyToken()), copyLp);
    Button regen = textButton("重新生成", v -> {
      AppState.get(this).regenerateToken();
      refresh();
    });
    tokenRow.addView(regen);
    tokenCard.addView(tokenRow);

    /* 权限 */
    permCard = card(root);
    permCard.addView(label("权限"));
    permText = new TextView(this);
    permText.setTextColor(ON_SURFACE_VARIANT);
    permText.setTextSize(13);
    permText.setPadding(0, dp(6), 0, dp(8));
    permCard.addView(permText);
    rebuildPermRows();

    /* 工作目录 */
    LinearLayout rootCard = card(root);
    rootCard.addView(label("工作目录"));
    rootText = new TextView(this);
    rootText.setTextColor(ON_SURFACE);
    rootText.setTextSize(13);
    rootText.setTypeface(Typeface.MONOSPACE);
    rootText.setPadding(0, dp(6), 0, 0);
    rootCard.addView(rootText);

    /* Linux 环境（proot + Ubuntu）：让终端能跑 python/node/git */
    LinearLayout linuxCard = card(root);
    linuxCard.addView(label("Linux 环境"));
    linuxText = new TextView(this);
    linuxText.setTextColor(ON_SURFACE_VARIANT);
    linuxText.setTextSize(13);
    linuxText.setPadding(0, dp(6), 0, dp(8));
    linuxCard.addView(linuxText);
    stack(linuxCard, tonalButton("准备 / 重新准备", v -> prepareLinux()));

    /* 其他 */
    LinearLayout toolsCard = card(root);
    toolsCard.addView(label("其他"));
    stack(toolsCard, tonalButton("打开后端说明页", v -> openUrl("http://127.0.0.1:" + AppState.PORT)));
    stack(toolsCard, tonalButton("自检：连接本机后端", v -> runSelfTest()));
    stack(toolsCard, tonalButton("查看最近请求日志", v -> logText.setText(RbcLog.dump())));
    Button stop = outlinedButton("停止后端服务", v -> {
      ServerService.stop(this);
      Toast.makeText(this, "已停止", Toast.LENGTH_SHORT).show();
      refresh();
    });
    stack(toolsCard, stop);
    logText = new TextView(this);
    logText.setTextColor(ON_SURFACE_VARIANT);
    logText.setTextSize(11);
    logText.setTypeface(Typeface.MONOSPACE);
    LinearLayout.LayoutParams logLp = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    logLp.topMargin = dp(10);
    toolsCard.addView(logText, logLp);

    return scroll;
  }

  private TextView label(String value) {
    TextView tv = new TextView(this);
    tv.setText(value);
    tv.setTextColor(ON_SURFACE_VARIANT);
    tv.setTextSize(12);
    return tv;
  }

  private LinearLayout card(LinearLayout parent) {
    LinearLayout c = new LinearLayout(this);
    c.setOrientation(LinearLayout.VERTICAL);
    c.setBackground(rounded(SURFACE, 24, 0));
    c.setPadding(dp(18), dp(18), dp(18), dp(18));
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    lp.bottomMargin = dp(14);
    parent.addView(c, lp);
    return c;
  }

  private View permRow(Perm perm) {
    LinearLayout row = new LinearLayout(this);
    row.setOrientation(LinearLayout.HORIZONTAL);
    row.setGravity(Gravity.CENTER_VERTICAL);
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    lp.topMargin = dp(8);
    row.setLayoutParams(lp);

    TextView name = new TextView(this);
    name.setText(perm.label);
    name.setTextColor(ON_SURFACE);
    name.setTextSize(14);
    name.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
    row.addView(name);

    TextView mark = new TextView(this);
    mark.setText(perm.granted.getAsBoolean() ? "√" : "×");
    mark.setTextColor(perm.granted.getAsBoolean() ? OK : ERR);
    mark.setTextSize(15);
    mark.setPadding(0, 0, dp(8), 0);
    row.addView(mark);

    if (!perm.granted.getAsBoolean()) {
      // 主界面里不用药丸底，纯文字就行（弹窗里那个保持药丸）
      Button go = textButton("去开启", v -> perm.request.run());
      row.addView(go);
    }
    return row;
  }

  /** 竖排卡片里的按钮：统一加一点上边距 */
  private void stack(LinearLayout parent, View child) {
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    lp.topMargin = dp(8);
    parent.addView(child, lp);
  }

  private Button baseButton(String text, int bg, int fg, int stroke) {
    Button b = new Button(this);
    b.setText(text);
    b.setAllCaps(false);
    b.setTextSize(14);
    b.setTextColor(fg);
    b.setBackground(rounded(bg, 22, stroke));
    b.setPadding(dp(20), dp(8), dp(20), dp(8));
    b.setMinimumHeight(0);
    b.setMinimumWidth(0);
    b.setStateListAnimator(null);
    return b;
  }

  private Button filledButton(String text, View.OnClickListener onClick) {
    Button b = baseButton(text, PRIMARY, ON_PRIMARY, 0);
    b.setOnClickListener(onClick);
    return b;
  }

  private Button tonalButton(String text, View.OnClickListener onClick) {
    Button b = baseButton(text, SECONDARY_CONTAINER, ON_SECONDARY_CONTAINER, 0);
    b.setOnClickListener(onClick);
    return b;
  }

  private Button outlinedButton(String text, View.OnClickListener onClick) {
    Button b = baseButton(text, 0x00000000, PRIMARY, OUTLINE);
    b.setOnClickListener(onClick);
    return b;
  }

  private Button textButton(String text, View.OnClickListener onClick) {
    Button b = baseButton(text, 0x00000000, PRIMARY, 0);
    b.setOnClickListener(onClick);
    return b;
  }

  private GradientDrawable rounded(int color, int radiusDp, int strokeColor) {
    GradientDrawable d = new GradientDrawable();
    d.setShape(GradientDrawable.RECTANGLE);
    d.setColor(color);
    d.setCornerRadius(dp(radiusDp));
    if (strokeColor != 0) d.setStroke(dp(1), strokeColor);
    return d;
  }

  private int dp(int value) {
    return Math.round(getResources().getDisplayMetrics().density * value);
  }

  /* --------------------------------- 权限 --------------------------------- */

  private final class Perm {
    final String label;
    final BooleanSupplier granted;
    final Runnable request;

    Perm(String label, BooleanSupplier granted, Runnable request) {
      this.label = label;
      this.granted = granted;
      this.request = request;
    }
  }

  private List<Perm> permissions() {
    List<Perm> list = new ArrayList<>();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      list.add(new Perm("通知权限",
          () -> checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED,
          () -> requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1)));
    }
    list.add(new Perm("所有文件访问",
        () -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager(),
        () -> {
          try {
            startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:" + getPackageName())));
          } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
          }
        }));
    list.add(new Perm("无障碍（computer use）",
        AgentAccessibilityService::isReady,
        () -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))));
    list.add(new Perm("关闭电池优化",
        () -> {
          PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
          return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
        },
        () -> {
          try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + getPackageName())));
          } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
          }
        }));
    return list;
  }

  private List<Perm> missing() {
    List<Perm> out = new ArrayList<>();
    for (Perm perm : permissions()) if (!perm.granted.getAsBoolean()) out.add(perm);
    return out;
  }

  /** 权限行按当前状态重建（授权后 ✓/按钮要跟着变） */
  private void rebuildPermRows() {
    if (permCard == null) return;
    while (permCard.getChildCount() > 2) permCard.removeViewAt(permCard.getChildCount() - 1);
    for (Perm perm : permissions()) permCard.addView(permRow(perm));
  }

  /** 首次进入、或检测到缺权限：盖一层浮层逐项引导；全部满足后自动撤掉。 */
  private void maybeShowPermissionDialog() {
    List<Perm> missing = missing();
    if (missing.isEmpty()) {
      hidePermissionOverlay();
      return;
    }
    showPermissionOverlay(missing);
  }

  private void hidePermissionOverlay() {
    if (permissionOverlay != null) {
      rootContainer.removeView(permissionOverlay);
      permissionOverlay = null;
    }
  }

  /** 在 Activity 里盖一层（不用 Dialog 窗口，尺寸完全可控，不会被裁）。 */
  private void showPermissionOverlay(List<Perm> missing) {
    if (permissionOverlay != null) rootContainer.removeView(permissionOverlay);

    FrameLayout overlay = new FrameLayout(this);
    overlay.setBackgroundColor(0x99000000);
    overlay.setClickable(true); // 吞掉背后的点击

    LinearLayout card = new LinearLayout(this);
    card.setOrientation(LinearLayout.VERTICAL);
    card.setBackground(rounded(SURFACE, 28, 0));
    card.setPadding(dp(24), dp(24), dp(24), dp(20));

    TextView title = new TextView(this);
    title.setText("还差几项权限");
    title.setTextColor(ON_SURFACE);
    title.setTextSize(20);
    title.setTypeface(Typeface.DEFAULT_BOLD);
    card.addView(title);

    TextView desc = new TextView(this);
    desc.setText("为了能读写手机文件、截图操作屏幕并在后台稳定运行，需要开启以下权限。");
    desc.setTextColor(ON_SURFACE_VARIANT);
    desc.setTextSize(13);
    desc.setPadding(0, dp(8), 0, dp(4));
    card.addView(desc);

    for (Perm perm : missing) {
      LinearLayout row = new LinearLayout(this);
      row.setOrientation(LinearLayout.HORIZONTAL);
      row.setGravity(Gravity.CENTER_VERTICAL);
      LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
      rowLp.topMargin = dp(10);
      row.setLayoutParams(rowLp);

      TextView name = new TextView(this);
      name.setText(perm.label);
      name.setTextColor(ON_SURFACE);
      name.setTextSize(14);
      name.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
      row.addView(name);

      Button go = filledButton("去开启", v -> {
        perm.request.run();
        hidePermissionOverlay();
      });
      row.addView(go);
      card.addView(row);
    }

    Button later = textButton("稍后再说", v -> hidePermissionOverlay());
    later.setLayoutParams(new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    card.addView(later);

    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
    lp.leftMargin = dp(20);
    lp.rightMargin = dp(20);
    lp.topMargin = dp(24);
    lp.bottomMargin = dp(24);
    overlay.addView(card, lp);

    rootContainer.addView(overlay, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    permissionOverlay = overlay;
  }

  /* --------------------------------- 运行 --------------------------------- */

  private void copyToken() {
    ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
    cm.setPrimaryClip(ClipData.newPlainText("RB Code token", AppState.get(this).token()));
    Toast.makeText(this, "已复制", Toast.LENGTH_SHORT).show();
  }

  private void openUrl(String url) {
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    } catch (ActivityNotFoundException e) {
      Toast.makeText(this, "没有可用的浏览器", Toast.LENGTH_SHORT).show();
    }
  }

  /** 解压内置 Linux（幂等，30MB 左右；后台跑） */
  private void prepareLinux() {
    LinuxEnv linux = LinuxEnv.get(this);
    if (linux.isReady() || linux.isPreparing()) return;
    linuxText.setText("准备中…");
    new Thread(() -> {
      linux.prepare();
      runOnUiThread(this::refresh);
    }, "linux-prepare").start();
  }

  private void runSelfTest() {
    logText.setText("自检中…");
    new Thread(() -> {
      String result;
      try {
        HttpURLConnection conn = (HttpURLConnection) new URL(
            "http://127.0.0.1:" + AppState.PORT + "/ping").openConnection();
        conn.setConnectTimeout(3000);
        conn.setReadTimeout(3000);
        int code = conn.getResponseCode();
        InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        if (in != null) {
          byte[] buf = new byte[4096];
          int n;
          while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        }
        result = "自检 OK · HTTP " + code + " · " + bos.toString(StandardCharsets.UTF_8.name());
      } catch (Exception e) {
        result = "自检失败：" + e;
      }
      final String text = result;
      runOnUiThread(() -> logText.setText(text));
    }, "selftest").start();
  }

  private void refresh() {
    AppState state = AppState.get(this);
    boolean running = ServerService.running;
    statusText.setText(running
        ? "● 运行中 · http://127.0.0.1:" + AppState.PORT
        : "○ 未运行" + (ServerService.lastError != null ? "（" + ServerService.lastError + "）" : ""));
    statusText.setTextColor(running ? OK : ERR);
    tokenText.setText(state.token());
    rootText.setText(state.root());

    List<Perm> missing = missing();
    permText.setText(missing.isEmpty() ? "全部已开启 √" : "还有 " + missing.size() + " 项没开");
    permText.setTextColor(missing.isEmpty() ? OK : ON_SURFACE_VARIANT);
    rebuildPermRows();

    LinuxEnv linux = LinuxEnv.get(this);
    if (linux.isReady()) {
      linuxText.setText("就绪 · 命令跑在 Ubuntu 里（可 apt install python3 nodejs git）");
      linuxText.setTextColor(OK);
    } else if (linux.isPreparing()) {
      linuxText.setText("准备中：" + linux.stage());
      linuxText.setTextColor(ON_SURFACE_VARIANT);
    } else if (linux.error() != null) {
      linuxText.setText("未就绪：" + linux.error());
      linuxText.setTextColor(ERR);
    } else {
      linuxText.setText("未就绪 · 点下面准备（会解压约 30MB 到 App 目录）");
      linuxText.setTextColor(ON_SURFACE_VARIANT);
    }
  }
}
