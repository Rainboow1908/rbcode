package com.rbcode.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/** 常驻前台服务：把 HTTP 后端跑起来，切后台也不被杀。 */
public final class ServerService extends Service {
  private static final String CHANNEL = "rbcode";
  public static volatile boolean running = false;
  public static volatile String lastError = null;

  private HttpServer server;

  public static void start(Context ctx) {
    Intent intent = new Intent(ctx, ServerService.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent);
    else ctx.startService(intent);
  }

  public static void stop(Context ctx) {
    ctx.stopService(new Intent(ctx, ServerService.class));
  }

  @Override
  public void onCreate() {
    super.onCreate();
    createChannel();
    Notification notification = new Notification.Builder(this, CHANNEL)
        .setContentTitle("RB Code 正在运行")
        .setContentText("本机后端监听 127.0.0.1:" + AppState.PORT)
        .setSmallIcon(android.R.drawable.stat_sys_download_done)
        .setOngoing(true)
        .build();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    } else {
      startForeground(1, notification);
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (server == null) {
      server = new HttpServer(this);
      try {
        server.start();
        running = true;
        lastError = null;
      } catch (Exception e) {
        running = false;
        lastError = e.getMessage() == null ? e.toString() : e.getMessage();
      }
    }
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    running = false;
    if (server != null) {
      server.stop();
      server = null;
    }
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) { return null; }

  private void createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null) return;
    NotificationChannel channel = new NotificationChannel(CHANNEL, "RB Code", NotificationManager.IMPORTANCE_LOW);
    nm.createNotificationChannel(channel);
  }
}
