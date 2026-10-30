package com.hosterapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Keeps Hoster alive while it is sharing: a foreground service (so Android doesn't kill the
 * process when the screen turns off) that also holds
 *  - a partial wake lock      (CPU keeps running while streaming to VLC),
 *  - a Wi-Fi lock             (Wi-Fi radio doesn't power-save mid-stream),
 *  - a multicast lock         (without it Android drops mDNS packets, so hoster.local never resolves).
 */
public class HosterForegroundService extends Service {
  static final String CHANNEL_ID = "hoster_sharing";
  static final int NOTIFICATION_ID = 7001;
  static final String EXTRA_TITLE = "title";
  static final String EXTRA_TEXT = "text";
  static final String ACTION_STOP = "com.hosterapp.action.STOP_SHARING";
  // The embedded Node server's Host UI port (same value App.tsx uses).
  private static final String STOP_URL = "http://127.0.0.1:9090/api/stop";

  private PowerManager.WakeLock wakeLock;
  private WifiManager.WifiLock wifiLock;
  private WifiManager.MulticastLock multicastLock;

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    // "Stop sharing" button in the notification
    if (intent != null && ACTION_STOP.equals(intent.getAction())) {
      stopSharing();
      return START_NOT_STICKY;
    }

    String title = "Hoster is sharing";
    String text = "";
    if (intent != null) {
      if (intent.getStringExtra(EXTRA_TITLE) != null) title = intent.getStringExtra(EXTRA_TITLE);
      if (intent.getStringExtra(EXTRA_TEXT) != null) text = intent.getStringExtra(EXTRA_TEXT);
    }

    try {
      createChannel();
      startForeground(NOTIFICATION_ID, buildNotification(title, text));
      acquireLocks();
    } catch (RuntimeException e) {
      // e.g. Android 12+ refuses to start a foreground service from the background.
      stopSelf();
      return START_NOT_STICKY;
    }
    return START_NOT_STICKY;
  }

  @Override
  public void onDestroy() {
    releaseLocks();
    super.onDestroy();
  }

  /** Tell the embedded server to stop (off the main thread), then drop the notification and locks. */
  private void stopSharing() {
    new Thread(
            new Runnable() {
              @Override
              public void run() {
                HttpURLConnection c = null;
                try {
                  c = (HttpURLConnection) new URL(STOP_URL).openConnection();
                  c.setRequestMethod("POST");
                  c.setConnectTimeout(2000);
                  c.setReadTimeout(4000);
                  c.setDoOutput(true);
                  c.setRequestProperty("Content-Type", "application/json");
                  OutputStream os = c.getOutputStream();
                  os.write("{}".getBytes("UTF-8"));
                  os.close();
                  c.getResponseCode();
                } catch (Exception ignored) {
                  // server already gone — still remove the notification
                } finally {
                  if (c != null) c.disconnect();
                }
                new Handler(Looper.getMainLooper())
                    .post(
                        new Runnable() {
                          @Override
                          public void run() {
                            stopForeground(true);
                            stopSelf();
                          }
                        });
              }
            })
        .start();
  }

  private void createChannel() {
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
      if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
        NotificationChannel ch =
            new NotificationChannel(CHANNEL_ID, "Sharing status", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shown while Hoster is sharing files on your network");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
      }
    }
  }

  private Notification buildNotification(String title, String text) {
    Notification.Builder b;
    if (Build.VERSION.SDK_INT >= 26) {
      b = new Notification.Builder(this, CHANNEL_ID);
    } else {
      b = new Notification.Builder(this);
    }

    Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
    int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent pi = launch != null ? PendingIntent.getActivity(this, 0, launch, piFlags) : null;

    b.setSmallIcon(android.R.drawable.stat_sys_upload)
        .setContentTitle(title)
        .setContentText(text.contains("\n") ? text.substring(0, text.indexOf('\n')) : text)
        .setStyle(new Notification.BigTextStyle().bigText(text))
        .setOngoing(true)
        .setOnlyAlertOnce(true);
    if (pi != null) b.setContentIntent(pi);

    // Stop sharing: routed back to this service, which asks the local server to stop.
    Intent stop = new Intent(this, HosterForegroundService.class);
    stop.setAction(ACTION_STOP);
    PendingIntent stopPi = PendingIntent.getService(this, 1, stop, piFlags);
    b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop sharing", stopPi);
    return b.build();
  }

  private void acquireLocks() {
    if (wakeLock == null) {
      PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
      if (pm != null) {
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Hoster:sharing");
        wakeLock.setReferenceCounted(false);
      }
    }
    if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();

    WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
    if (wm == null) return;

    if (wifiLock == null) {
      int mode =
          Build.VERSION.SDK_INT >= 29
              ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
              : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
      wifiLock = wm.createWifiLock(mode, "Hoster:wifi");
      wifiLock.setReferenceCounted(false);
    }
    if (!wifiLock.isHeld()) wifiLock.acquire();

    if (multicastLock == null) {
      multicastLock = wm.createMulticastLock("Hoster:mdns");
      multicastLock.setReferenceCounted(false);
    }
    if (!multicastLock.isHeld()) multicastLock.acquire();
  }

  private void releaseLocks() {
    try {
      if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
      if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
      if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
    } catch (RuntimeException ignored) {
      // lock already released
    }
  }
}
