import 'package:flutter/foundation.dart';

import 'harness_file_store.dart';
import 'local_key_value_store.dart';

/// Whether this computer runs without an account.
///
/// Chosen on the login screen ("Use this computer without an account") and
/// remembered across launches, like the theme. While it is on, every `harness`
/// command the app runs carries `HARNESS_LOCAL_ONLY=true`: the daemon starts on
/// this computer's own id, never dials the backend, and lists this computer as
/// its one machine. A sign-in switches it off again, because the CLI lets a
/// saved session win over the flag and the app has to agree with it.
///
/// Same shape as [AppearancePrefsStore]: a [ValueNotifier] singleton over
/// [HarnessFileStore], loaded once by `loadPersistedSettings()` before the
/// first frame. The boot path reads it before it picks a screen, and a late
/// load would send a local-mode computer to the login screen on every launch.
class LocalModeStore extends ValueNotifier<bool> {
  LocalModeStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared,
      super(false);

  static const key = 'harness_local_mode';

  final LocalKeyValueStore _storage;

  /// Read the saved choice. Tolerant like the other stores: a missing or
  /// unreadable file lands on "not local", which is the login screen.
  Future<void> load() async {
    try {
      value = await _storage.read(key) == 'true';
    } catch (_) {
      value = false;
    }
  }

  /// Remember the choice. The value moves first, so the next CLI command the
  /// app runs already carries it; a storage failure leaves this run in the
  /// chosen mode and the next launch on the previous one. An unchanged value
  /// touches nothing: the sign-in and sign-out paths call this on every run,
  /// and a disk write there would be one more thing a widget test's fake clock
  /// can never complete (see `SnapshotStore` for the same hazard).
  Future<void> set(bool enabled) async {
    if (value == enabled) return;
    value = enabled;
    try {
      if (enabled) {
        await _storage.write(key, 'true');
      } else {
        await _storage.delete(key);
      }
    } catch (_) {
      // Best effort: the running app already reflects the choice.
    }
  }
}

final localModeStore = LocalModeStore();
