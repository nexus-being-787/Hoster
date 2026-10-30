package com.hosterapp;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

/** JS bridge: NativeModules.HosterService */
public class HosterServiceModule extends ReactContextBaseJavaModule {

  HosterServiceModule(ReactApplicationContext context) {
    super(context);
  }

  @Override
  public String getName() {
    return "HosterService";
  }

  /** Start (or update the notification text of) the foreground service. Resolves false if Android refused. */
  @ReactMethod
  public void start(String title, String text, Promise promise) {
    try {
      Context ctx = getReactApplicationContext();
      Intent i = new Intent(ctx, HosterForegroundService.class);
      i.putExtra(HosterForegroundService.EXTRA_TITLE, title);
      i.putExtra(HosterForegroundService.EXTRA_TEXT, text);
      if (Build.VERSION.SDK_INT >= 26) {
        ctx.startForegroundService(i);
      } else {
        ctx.startService(i);
      }
      promise.resolve(true);
    } catch (Exception e) {
      promise.resolve(false);
    }
  }

  @ReactMethod
  public void stop(Promise promise) {
    try {
      Context ctx = getReactApplicationContext();
      ctx.stopService(new Intent(ctx, HosterForegroundService.class));
      promise.resolve(true);
    } catch (Exception e) {
      promise.resolve(false);
    }
  }

  /** Android 11+ "All files access". Older versions use the runtime storage permissions. */
  @ReactMethod
  public void hasAllFilesAccess(Promise promise) {
    if (Build.VERSION.SDK_INT >= 30) {
      promise.resolve(Environment.isExternalStorageManager());
    } else {
      promise.resolve(true);
    }
  }

  @ReactMethod
  public void openAllFilesSettings(Promise promise) {
    Context ctx = getReactApplicationContext();
    if (Build.VERSION.SDK_INT < 30) {
      promise.resolve(false);
      return;
    }
    try {
      Intent i =
          new Intent(
              Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
              Uri.parse("package:" + ctx.getPackageName()));
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      ctx.startActivity(i);
      promise.resolve(true);
    } catch (Exception e) {
      try {
        Intent i = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
        promise.resolve(true);
      } catch (Exception e2) {
        promise.resolve(false);
      }
    }
  }

  @ReactMethod
  public void isIgnoringBatteryOptimizations(Promise promise) {
    if (Build.VERSION.SDK_INT < 23) {
      promise.resolve(true);
      return;
    }
    Context ctx = getReactApplicationContext();
    PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
    promise.resolve(pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName()));
  }

  @ReactMethod
  public void requestIgnoreBatteryOptimizations(Promise promise) {
    if (Build.VERSION.SDK_INT < 23) {
      promise.resolve(false);
      return;
    }
    Context ctx = getReactApplicationContext();
    try {
      Intent i =
          new Intent(
              Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
              Uri.parse("package:" + ctx.getPackageName()));
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      ctx.startActivity(i);
      promise.resolve(true);
    } catch (Exception e) {
      try {
        Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
        promise.resolve(true);
      } catch (Exception e2) {
        promise.resolve(false);
      }
    }
  }

  // Required by NativeEventEmitter-style callers; unused here but harmless.
  @ReactMethod
  public void addListener(String eventName) {}

  @ReactMethod
  public void removeListeners(Integer count) {}
}
