package com.rbcode.mobile;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.hardware.HardwareBuffer;
import android.os.Bundle;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.Base64;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * computer use 的执行端：靠无障碍服务截图、派发手势、输入文字。
 * 前端发来的是**屏幕像素坐标**（前端已按 截图/屏幕 比例还原过），这里直接用。
 */
public final class AgentAccessibilityService extends AccessibilityService {
  private static volatile AgentAccessibilityService instance;

  public static boolean isReady() { return instance != null; }

  @Override
  protected void onServiceConnected() {
    super.onServiceConnected();
    instance = this;
  }

  @Override
  public void onDestroy() {
    if (instance == this) instance = null;
    super.onDestroy();
  }

  @Override
  public void onAccessibilityEvent(AccessibilityEvent event) {}

  @Override
  public void onInterrupt() {}

  /** 截屏：返回 PNG base64 + 尺寸信息。 */
  public static JSONObject screen(int maxWidth) throws Exception {
    AgentAccessibilityService svc = instance;
    if (svc == null) {
      throw new IllegalStateException("无障碍服务未开启：请在系统设置 → 无障碍 里打开「RB Code」。");
    }
    final CountDownLatch latch = new CountDownLatch(1);
    final Object[] holder = new Object[2];
    svc.takeScreenshot(Display.DEFAULT_DISPLAY, svc.getMainExecutor(),
        new TakeScreenshotCallback() {
          @Override
          public void onSuccess(ScreenshotResult result) {
            holder[0] = result;
            latch.countDown();
          }

          @Override
          public void onFailure(int errorCode) {
            holder[1] = errorCode;
            latch.countDown();
          }
        });
    if (!latch.await(6000, TimeUnit.MILLISECONDS)) throw new IllegalStateException("截图超时");
    if (holder[0] == null) throw new IllegalStateException("截图失败（code=" + holder[1] + "）");

    ScreenshotResult result = (ScreenshotResult) holder[0];
    HardwareBuffer buffer = result.getHardwareBuffer();
    Bitmap hardware = Bitmap.wrapHardwareBuffer(buffer, result.getColorSpace());
    Bitmap full = hardware == null ? null : hardware.copy(Bitmap.Config.ARGB_8888, false);
    buffer.close();
    if (full == null) throw new IllegalStateException("无法读取截图像素");

    int screenW = full.getWidth();
    int screenH = full.getHeight();
    Bitmap out = full;
    int limit = maxWidth > 0 ? maxWidth : 1280;
    if (screenW > limit) {
      int th = Math.max(1, Math.round(screenH * (limit / (float) screenW)));
      out = Bitmap.createScaledBitmap(full, limit, th, true);
      full.recycle();
    }
    ByteArrayOutputStream bos = new ByteArrayOutputStream();
    out.compress(Bitmap.CompressFormat.PNG, 100, bos);

    JSONObject r = new JSONObject();
    r.put("width", out.getWidth());
    r.put("height", out.getHeight());
    r.put("screenWidth", screenW);
    r.put("screenHeight", screenH);
    r.put("originX", 0);
    r.put("originY", 0);
    r.put("base64", Base64.getEncoder().encodeToString(bos.toByteArray()));
    out.recycle();
    return r;
  }

  /** 依次执行一批动作，遇到失败就抛。返回执行了几条。 */
  public static int actions(JSONArray actions) throws Exception {
    AgentAccessibilityService svc = instance;
    if (svc == null) {
      throw new IllegalStateException("无障碍服务未开启：请在系统设置 → 无障碍 里打开「RB Code」。");
    }
    int applied = 0;
    for (int i = 0; i < actions.length(); i++) {
      JSONObject a = actions.getJSONObject(i);
      String action = a.optString("action", "");
      switch (action) {
        case "wait":
          // duration 是**毫秒**（工具 schema 写的就是 ms，默认 500）；别当成秒，否则会一直等到超时
          Thread.sleep(Math.max(0, Math.min(5000, (long) a.optDouble("duration", 500))));
          break;
        case "screenshot":
        case "mouse_move":
          // 安卓没有悬停；截图由前端/工具层另行触发
          break;
        case "left_click":
        case "right_click":
        case "middle_click":
          tap(svc, coord(a, "coordinate"));
          break;
        case "double_click":
          tap(svc, coord(a, "coordinate"));
          Thread.sleep(80);
          tap(svc, coord(a, "coordinate"));
          break;
        case "left_click_drag":
          swipe(svc, coord(a, "start_coordinate"), coord(a, "coordinate"), 400);
          break;
        case "scroll":
          scroll(svc, a);
          break;
        case "type":
          typeText(a.optString("text", ""));
          break;
        case "key":
          key(a.optString("text", ""));
          break;
        default:
          throw new IllegalStateException("不支持的动作：" + action);
      }
      applied++;
    }
    return applied;
  }

  private static float[] coord(JSONObject a, String key) {
    JSONArray arr = a.optJSONArray(key);
    if (arr == null || arr.length() < 2) throw new IllegalStateException("缺少坐标：" + key);
    return new float[]{(float) arr.optDouble(0), (float) arr.optDouble(1)};
  }

  private static void tap(AgentAccessibilityService svc, float[] p) throws Exception {
    Path path = new Path();
    path.moveTo(p[0], p[1]);
    dispatch(svc, path, 60);
  }

  private static void swipe(AgentAccessibilityService svc, float[] from, float[] to, long ms) throws Exception {
    Path path = new Path();
    path.moveTo(from[0], from[1]);
    path.lineTo(to[0], to[1]);
    dispatch(svc, path, ms);
  }

  private static void scroll(AgentAccessibilityService svc, JSONObject a) throws Exception {
    Display display = svc.getSystemService(android.view.WindowManager.class).getDefaultDisplay();
    android.graphics.Point size = new android.graphics.Point();
    display.getRealSize(size);
    float cx = size.x / 2f;
    float cy = size.y / 2f;
    float distance = size.y * 0.35f;
    String dir = a.optString("direction", "down");
    switch (dir) {
      case "up":
        swipe(svc, new float[]{cx, cy + distance / 2}, new float[]{cx, cy - distance / 2}, 250);
        break;
      case "down":
        swipe(svc, new float[]{cx, cy - distance / 2}, new float[]{cx, cy + distance / 2}, 250);
        break;
      case "left":
        swipe(svc, new float[]{cx + size.x * 0.3f, cy}, new float[]{cx - size.x * 0.3f, cy}, 250);
        break;
      default:
        swipe(svc, new float[]{cx - size.x * 0.3f, cy}, new float[]{cx + size.x * 0.3f, cy}, 250);
        break;
    }
  }

  private static void dispatch(AgentAccessibilityService svc, Path path, long ms) throws Exception {
    final CountDownLatch latch = new CountDownLatch(1);
    GestureDescription.StrokeDescription stroke =
        new GestureDescription.StrokeDescription(path, 0, Math.max(1, ms));
    GestureDescription gesture = new GestureDescription.Builder().addStroke(stroke).build();
    boolean ok = svc.dispatchGesture(gesture, new AccessibilityService.GestureResultCallback() {
      @Override
      public void onCompleted(GestureDescription gestureDescription) { latch.countDown(); }

      @Override
      public void onCancelled(GestureDescription gestureDescription) { latch.countDown(); }
    }, null);
    if (!ok) throw new IllegalStateException("手势派发失败");
    // 回调有时不来；手势已经受理就够了，别为它卡住
    latch.await(1200, TimeUnit.MILLISECONDS);
  }

  private static void typeText(String text) {
    AgentAccessibilityService svc = instance;
    AccessibilityNodeInfo root = svc == null ? null : svc.getRootInActiveWindow();
    AccessibilityNodeInfo node = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
    if (node == null) throw new IllegalStateException("没有检测到可输入的输入框");
    CharSequence existing = node.getText();
    String next = (existing == null ? "" : existing.toString()) + text;
    Bundle args = new Bundle();
    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next);
    node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
  }

  private static void key(String name) {
    AgentAccessibilityService svc = instance;
    switch (name.toLowerCase()) {
      case "back":
      case "escape":
      case "esc":
        svc.performGlobalAction(GLOBAL_ACTION_BACK);
        break;
      case "home":
        svc.performGlobalAction(GLOBAL_ACTION_HOME);
        break;
      case "recents":
      case "app_switch":
        svc.performGlobalAction(GLOBAL_ACTION_RECENTS);
        break;
      default:
        // Enter 等按键：在输入框里补一个换行，够用
        typeText("\n");
        break;
    }
  }
}
