import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:background_fetch/background_fetch.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:logging/logging.dart';
import 'package:path_provider/path_provider.dart';
import 'package:photos/app.dart';
import 'package:photos/core/configuration.dart';
import 'package:photos/core/constants.dart';
import 'package:photos/core/network.dart';
import 'package:photos/db/upload_locks_db.dart';
import 'package:photos/services/app_lifecycle_service.dart';
import 'package:photos/services/billing_service.dart';
import 'package:photos/services/collections_service.dart';
import 'package:photos/services/feature_flag_service.dart';
import 'package:photos/services/local_sync_service.dart';
import 'package:photos/services/memories_service.dart';
import 'package:photos/services/notification_service.dart';
import 'package:photos/services/push_service.dart';
import 'package:photos/services/remote_sync_service.dart';
import 'package:photos/services/sync_service.dart';
import 'package:photos/services/trash_sync_service.dart';
import 'package:photos/services/update_service.dart';
import 'package:photos/ui/app_lock.dart';
import 'package:photos/ui/lock_screen.dart';
import 'package:photos/utils/crypto_util.dart';
import 'package:photos/utils/file_uploader.dart';
import 'package:photos/utils/local_settings.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:super_logging/super_logging.dart';

final _logger = Logger("main");

Completer<void> _initializationStatus;
const kLastBGTaskHeartBeatTime = "bg_task_hb_time";
const kLastFGTaskHeartBeatTime = "fg_task_hb_time";
const kHeartBeatFrequency = Duration(seconds: 1);
const kFGSyncFrequency = Duration(minutes: 5);
const kBGTaskTimeout = Duration(seconds: 25);
const kBGPushTimeout = Duration(seconds: 28);
const kFGTaskDeathTimeoutInMicroseconds = 5000000;

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await _runInForeground();
  BackgroundFetch.registerHeadlessTask(_headlessTaskHandler);
}

Future<void> _runInForeground() async {
  return await _runWithLogs(() async {
    _logger.info("Starting app in foreground");
    await _init(false);
    _scheduleFGSync();
    runApp(AppLock(
      builder: (args) => EnteApp(_runBackgroundTask, _killBGTask),
      lockScreen: LockScreen(),
      enabled: Configuration.instance.shouldShowLockScreen(),
      themeData: themeData,
    ));
  });
}

Future _runBackgroundTask(String taskId) async {
  if (_initializationStatus == null) {
    _runWithLogs(() async {
      _runInBackground(taskId);
    }, prefix: "[bg]");
  } else {
    _runInBackground(taskId);
  }
}

Future<void> _runInBackground(String taskId) async {
  await Future.delayed(Duration(seconds: 3));
  if (await _isRunningInForeground()) {
    _logger.info("FG task running, skipping BG task");
    BackgroundFetch.finish(taskId);
    return;
  } else {
    _logger.info("FG task is not running");
  }
  _logger.info("[BackgroundFetch] Event received: $taskId");
  _scheduleBGTaskKill(taskId);
  if (Platform.isIOS) {
    _scheduleSuicide(kBGTaskTimeout); // To prevent OS from punishing us
  }
  await _init(true);
  UpdateService.instance.showUpdateNotification();
  await _sync();
  BackgroundFetch.finish(taskId);
}

void _headlessTaskHandler(HeadlessTask task) {
  if (task.timeout) {
    BackgroundFetch.finish(task.taskId);
  } else {
    _runInBackground(task.taskId);
  }
}

Future<void> _init(bool isBackground) async {
  if (_initializationStatus != null) {
    return _initializationStatus.future;
  }
  _initializationStatus = Completer<void>();
  _logger.info("Initializing...");
  _scheduleHeartBeat(isBackground);
  if (isBackground) {
    AppLifecycleService.instance.onAppInBackground();
  } else {
    AppLifecycleService.instance.onAppInForeground();
  }
  InAppPurchaseConnection.enablePendingPurchases();
  CryptoUtil.init();
  await NotificationService.instance.init();
  await Network.instance.init();
  await Configuration.instance.init();
  await UpdateService.instance.init();
  await BillingService.instance.init();
  await CollectionsService.instance.init();
  await FileUploader.instance.init(isBackground);
  await LocalSyncService.instance.init();
  await TrashSyncService.instance.init();
  await RemoteSyncService.instance.init();
  await SyncService.instance.init();
  await MemoriesService.instance.init();
  await LocalSettings.instance.init();
  if (Platform.isIOS) {
    PushService.instance.init().then((_) {
      FirebaseMessaging.onBackgroundMessage(
          _firebaseMessagingBackgroundHandler);
    });
  }
  FeatureFlagService.instance.init();
  _logger.info("Initialization done");
  _initializationStatus.complete();
}

Future<void> _sync() async {
  if (!AppLifecycleService.instance.isForeground) {
    _logger.info("Syncing in background");
  }
  try {
    await SyncService.instance.sync();
  } catch (e, s) {
    _logger.severe("Sync error", e, s);
  }
}

Future _runWithLogs(Function() function, {String prefix = ""}) async {
  await SuperLogging.main(LogConfig(
    body: function,
    logDirPath: (await getTemporaryDirectory()).path + "/logs",
    maxLogFiles: 5,
    sentryDsn: kDebugMode ? kSentryDebugDSN : kSentryDSN,
    enableInDebugMode: true,
    prefix: prefix,
  ));
}

Future<void> _scheduleHeartBeat(bool isBackground) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setInt(
      isBackground ? kLastBGTaskHeartBeatTime : kLastFGTaskHeartBeatTime,
      DateTime.now().microsecondsSinceEpoch);
  Future.delayed(kHeartBeatFrequency, () async {
    _scheduleHeartBeat(isBackground);
  });
}

Future<void> _scheduleFGSync() async {
  await _sync();
  Future.delayed(kFGSyncFrequency, () async {
    _scheduleFGSync();
  });
}

void _scheduleBGTaskKill(String taskId) async {
  if (await _isRunningInForeground()) {
    _logger.info("Found app in FG, committing seppuku.");
    await _killBGTask(taskId);
    return;
  }
  Future.delayed(kHeartBeatFrequency, () async {
    _scheduleBGTaskKill(taskId);
  });
}

Future<bool> _isRunningInForeground() async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.reload();
  final currentTime = DateTime.now().microsecondsSinceEpoch;
  return (prefs.getInt(kLastFGTaskHeartBeatTime) ?? 0) >
      (currentTime - kFGTaskDeathTimeoutInMicroseconds);
}

Future<void> _killBGTask([String taskId]) async {
  await UploadLocksDB.instance.releaseLocksAcquiredByOwnerBefore(
      ProcessType.background.toString(), DateTime.now().microsecondsSinceEpoch);
  final prefs = await SharedPreferences.getInstance();
  prefs.remove(kLastBGTaskHeartBeatTime);
  if (taskId != null) {
    BackgroundFetch.finish(taskId);
  }
  Isolate.current.kill(priority: Isolate.immediate);
}

Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  if (_initializationStatus == null) {
    // App is dead
    _runWithLogs(() async {
      _logger.info("Background push received");
      if (Platform.isIOS) {
        _scheduleSuicide(kBGPushTimeout); // To prevent OS from punishing us
      }
      await _init(true);
      if (PushService.shouldSync(message)) {
        await _sync();
      }
    }, prefix: "[bg]");
  } else {
    _logger.info("Background push received when app is alive");
    if (PushService.shouldSync(message)) {
      await _sync();
    }
  }
}

void _scheduleSuicide(Duration duration, [String taskID]) {
  Future.delayed(duration, () {
    _logger.warning("TLE, committing seppuku");
    _killBGTask(taskID);
  });
}
