import 'package:flutter/material.dart';
import 'package:logging/logging.dart';
import "package:photos/generated/l10n.dart";
import 'package:photos/ui/common/gradient_button.dart';
import 'package:photos/ui/tools/app_lock.dart';
import 'package:photos/utils/auth_util.dart';

class LockScreen extends StatefulWidget {
  const LockScreen({Key? key}) : super(key: key);

  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> with WidgetsBindingObserver {
  final _logger = Logger("LockScreen");
  bool _isShowingLockScreen = false;
  bool _hasPlacedAppInBackground = false;
  bool _hasAuthenticationFailed = false;
  int? lastAuthenticatingTime;

  @override
  void initState() {
    _logger.info("initState");
    super.initState();
    _showLockScreen(source: "initState");
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.center,
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            Stack(
              alignment: Alignment.center,
              children: [
                Opacity(
                  opacity: 0.2,
                  child: Image.asset('assets/loading_photos_background.png'),
                ),
                SizedBox(
                  width: 180,
                  child: GradientButton(
                    text: S.of(context).unlock,
                    iconData: Icons.lock_open_outlined,
                    onTap: () async {
                      _showLockScreen(source: "tapUnlock");
                    },
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _logger.info(state.toString());
    if (state == AppLifecycleState.resumed && !_isShowingLockScreen) {
      // This is triggered either when the lock screen is dismissed or when
      // the app is brought to foreground
      _hasPlacedAppInBackground = false;
      final bool didAuthInLast5Seconds = lastAuthenticatingTime != null &&
          DateTime.now().millisecondsSinceEpoch - lastAuthenticatingTime! <
              5000;
      if (!_hasAuthenticationFailed && !didAuthInLast5Seconds) {
        // Show the lock screen again only if the app is resuming from the
        // background, and not when the lock screen was explicitly dismissed
        _showLockScreen(source: "lifeCycle");
      } else {
        _hasAuthenticationFailed = false; // Reset failure state
      }
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      // This is triggered either when the lock screen pops up or when
      // the app is pushed to background
      if (!_isShowingLockScreen) {
        _hasPlacedAppInBackground = true;
        _hasAuthenticationFailed = false; // reset failure state
      }
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _showLockScreen({String source = ''}) async {
    final int id = DateTime.now().millisecondsSinceEpoch;
    _logger.info("Showing lock screen $source $id");
    try {
      _isShowingLockScreen = true;
      final result = await requestAuthentication(
        context,
        S.of(context).authToViewYourMemories,
      );
      _logger.finest("LockScreen Result $result $id");
      _isShowingLockScreen = false;
      if (result) {
        lastAuthenticatingTime = DateTime.now().millisecondsSinceEpoch;
        AppLock.of(context)!.didUnlock();
      } else {
        if (!_hasPlacedAppInBackground) {
          // Treat this as a failure only if user did not explicitly
          // put the app in background
          _hasAuthenticationFailed = true;
          _logger.info("Authentication failed");
        }
      }
    } catch (e, s) {
      _logger.severe(e, s);
    }
  }
}
