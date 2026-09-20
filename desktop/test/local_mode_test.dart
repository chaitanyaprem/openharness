import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/harness_cli_runner.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/local_mode.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

/// Local mode: this computer runs without an account.
///
/// The choice is remembered by [LocalModeStore], carried to every `harness`
/// command as `HARNESS_LOCAL_ONLY=true` by [HarnessCliRunner], echoed back by
/// the CLI as `localOnly` in `auth status`, and routed by [AppNotifier] to the
/// same home screen a sign-in reaches — with no profile, because there is no
/// account to fetch one for.

class _MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

/// The CLI's answer to `auth status --json`, scripted; never a real process.
class _ScriptedCli extends CliLogin {
  _ScriptedCli(this.answer);

  final CliAuthStatus answer;
  int logouts = 0;

  @override
  Future<CliAuthStatus> checkStatus() async => answer;

  @override
  Future<void> logout() async {
    logouts++;
  }
}

class _ReadyProvisioner extends EnvironmentProvisioner {
  _ReadyProvisioner() : super(isMacOS: true);

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    final ready = EnvironmentReadiness(
      phase: EnvironmentSetupPhase.ready,
      steps: {
        for (final step in EnvironmentStep.values)
          step: EnvironmentStepStatus.ready,
      },
    );
    onProgress(ready);
    return ready;
  }
}

/// A daemon that is up at once, with the supervisor stubbed out.
class _ReadyDiscovery extends LocalCliDiscovery {
  _ReadyDiscovery() : super(config: AppConfig.dev);

  int ensureCalls = 0;
  Future<bool> Function()? stillSignedIn;
  Timer? supervision;

  @override
  Future<LocalCliProbe> ensureRunning({
    Duration timeout = const Duration(seconds: 15),
    Duration readyTimeout = LocalCliDiscovery.defaultReadyTimeout,
  }) async {
    ensureCalls++;
    return LocalCliProbe.ready(_endpoint);
  }

  @override
  Timer startSupervising({
    Duration checkInterval = const Duration(seconds: 5),
    Duration graceStep = const Duration(milliseconds: 500),
    Duration graceWindow = const Duration(seconds: 5),
    Duration initialBackoff = const Duration(seconds: 2),
    Duration maxBackoff = const Duration(seconds: 30),
    int spawnAfter = 2,
    bool Function(DateTime now)? spawnAllowedAt,
    Future<bool> Function()? stillSignedIn,
    void Function()? onSignedOut,
    void Function(LocalCliEndpoint endpoint)? onReady,
    void Function(LocalCliEndpoint endpoint)? onSnapshot,
    void Function(bool online)? onBackendOnline,
  }) {
    this.stillSignedIn = stillSignedIn;
    return supervision = Timer(const Duration(days: 1), () {});
  }
}

/// A socket that answers nothing: the load a connect triggers must not reach for a real pool.
class _QuietConnection extends WsConn {
  _QuietConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm-local',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => const {'agents': []};
}

/// Counts the profile reads instead of making them.
class _CountingApi extends ApiClient {
  _CountingApi() : super(config: AppConfig.dev, session: AuthSession());

  int meCalls = 0;

  @override
  Future<Map<String, dynamic>?> me() async {
    meCalls++;
    return null;
  }
}

class _Notifier extends AppNotifier {
  _Notifier({
    required LocalCliDiscovery discovery,
    required CliLogin cli,
    required LocalModeStore localMode,
  }) : super(
         config: AppConfig.dev,
         authSession: AuthSession(),
         configStore: null,
         localCliDiscovery: discovery,
         cliLogin: cli,
         localMode: localMode,
         environmentProvisioner: _ReadyProvisioner(),
         connectionForTest: (_) => _QuietConnection(),
       ) {
    api = profileReads;
  }

  final profileReads = _CountingApi();
  int refreshes = 0;

  @override
  Future<void> refreshMachines() async {
    refreshes++;
  }
}

final _endpoint = LocalCliEndpoint(
  computerId: '0123456789abcdef0123456789abcdef',
  wsUri: Uri.parse('ws://127.0.0.1:18473/api/local-ws'),
  protocolVersion: 1,
  terminalProtocolVersion: 3,
  machineId: '0123456789abcdef0123456789abcdef',
  backendOnline: false,
);

const _localCli = CliAuthStatus(
  loggedIn: false,
  localOnly: true,
  computerId: '0123456789abcdef0123456789abcdef',
);

LocalModeStore _store({bool remembered = false}) {
  final storage = _MemoryStore();
  if (remembered) storage.values[LocalModeStore.key] = 'true';
  return LocalModeStore(storage: storage);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('LocalModeStore', () {
    test(
      'remembers the choice across a reload, and forgets it on the way out',
      () async {
        final storage = _MemoryStore();
        final store = LocalModeStore(storage: storage);
        await store.load();
        expect(store.value, isFalse);

        await store.set(true);
        expect(storage.values[LocalModeStore.key], 'true');
        final reloaded = LocalModeStore(storage: storage);
        await reloaded.load();
        expect(reloaded.value, isTrue);

        await reloaded.set(false);
        expect(storage.values.containsKey(LocalModeStore.key), isFalse);
      },
    );

    test(
      'an unreadable store lands on the login screen, not on an exception',
      () async {
        final store = LocalModeStore(storage: _ThrowingStore());
        await store.load();
        expect(store.value, isFalse);
        await store.set(
          true,
        ); // the run keeps the choice even when the write failed
        expect(store.value, isTrue);
      },
    );
  });

  test(
    'CliAuthStatus reads the CLI\'s local-mode answer, and defaults it off',
    () {
      final local = CliAuthStatus.fromJson({
        'loggedIn': false,
        'localOnly': true,
        'computerId': 'abc',
      });
      expect(local.loggedIn, isFalse);
      expect(local.localOnly, isTrue);
      expect(local.computerId, 'abc');
      expect(CliAuthStatus.fromJson({'loggedIn': false}).localOnly, isFalse);
    },
  );

  group('boot', () {
    test(
      'a remembered local mode boots to the home screen with no profile read',
      () async {
        final store = _store(remembered: true);
        await store.load();
        final discovery = _ReadyDiscovery();
        final app = _Notifier(
          discovery: discovery,
          cli: _ScriptedCli(_localCli),
          localMode: store,
        );
        addTearDown(app.dispose);

        await app.bootstrap();

        expect(app.status, AppStatus.authenticated);
        expect(app.localOnly, isTrue);
        expect(app.currentUser, isNull);
        expect(app.profileReads.meCalls, 0);
        expect(app.refreshes, 1);
        expect(discovery.ensureCalls, 1);
        // The supervisor never treats "no session" as a sign-out here.
        expect(await discovery.stillSignedIn!(), isTrue);
      },
    );

    test('a CLI that predates local mode sends the person back to sign in, with the reason', () async {
      final store = _store(remembered: true);
      await store.load();
      final app = _Notifier(
        discovery: _ReadyDiscovery(),
        cli: _ScriptedCli(const CliAuthStatus(loggedIn: false)),
        localMode: store,
      );
      addTearDown(app.dispose);

      await app.bootstrap();

      expect(app.status, AppStatus.unauthenticated);
      expect(app.localOnly, isFalse);
      expect(app.lastError, AppNotifier.localModeUnsupportedMessage);
      expect(app.refreshes, 0);
    });

    test('a saved sign-in outranks a remembered local mode', () async {
      final store = _store(remembered: true);
      await store.load();
      final app = _Notifier(
        discovery: _ReadyDiscovery(),
        cli: _ScriptedCli(
          const CliAuthStatus(loggedIn: true, machineId: 'm-1'),
        ),
        localMode: store,
      );
      addTearDown(app.dispose);

      await app.bootstrap();

      expect(app.status, AppStatus.authenticated);
      expect(app.localOnly, isFalse);
      expect(app.profileReads.meCalls, 1);
    });
  });

  group('the login screen\'s other door', () {
    test('continueWithoutAccount remembers the choice and boots', () async {
      final store = _store();
      final app = _Notifier(
        discovery: _ReadyDiscovery(),
        cli: _ScriptedCli(_localCli),
        localMode: store,
      );
      addTearDown(app.dispose);
      app.status = AppStatus.unauthenticated;

      await app.continueWithoutAccount();

      expect(app.status, AppStatus.authenticated);
      expect(app.localOnly, isTrue);
      expect(app.currentUser, isNull);
      expect(app.profileReads.meCalls, 0);
      expect(app.refreshes, 1);
    });

    test(
      'a CLI without local mode refuses with the reason and forgets the choice',
      () async {
        final store = _store();
        final app = _Notifier(
          discovery: _ReadyDiscovery(),
          cli: _ScriptedCli(const CliAuthStatus(loggedIn: false)),
          localMode: store,
        );
        addTearDown(app.dispose);
        app.status = AppStatus.unauthenticated;

        await app.continueWithoutAccount();

        expect(app.status, AppStatus.unauthenticated);
        expect(app.localOnly, isFalse);
        expect(app.lastError, AppNotifier.localModeUnsupportedMessage);
      },
    );

    test('leaving local mode is a sign-out: the choice is forgotten and the daemon is stopped', () async {
      final store = _store();
      final cli = _ScriptedCli(_localCli);
      final app = _Notifier(
        discovery: _ReadyDiscovery(),
        cli: cli,
        localMode: store,
      );
      addTearDown(app.dispose);
      app.status = AppStatus.unauthenticated;
      await app.continueWithoutAccount();
      expect(app.localOnly, isTrue);

      await app.logout();

      expect(app.status, AppStatus.unauthenticated);
      expect(app.localOnly, isFalse);
      expect(cli.logouts, 1);
    });

    testWidgets(
      'the login screen offers it, and the tap boots without an account',
      (tester) async {
        grid.AppTheme.brightness.value = Brightness.light;
        final store = _store();
        final discovery = _ReadyDiscovery();
        final app = _Notifier(
          discovery: discovery,
          cli: _ScriptedCli(_localCli),
          localMode: store,
        );
        addTearDown(app.dispose);
        app.status = AppStatus.unauthenticated;

        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.light),
            home: MediaQuery(
              data: const MediaQueryData(size: Size(880, 560)),
              child: grid.BrightnessScope(
                child: ListenableBuilder(
                  listenable: app,
                  builder: (_, _) => LoginScreen(notifier: app),
                ),
              ),
            ),
          ),
        );

        final door = find.byKey(const Key('use-without-account-button'));
        expect(door, findsOneWidget);
        expect(
          find.text('Use this computer without an account'),
          findsOneWidget,
        );
        await tester.tap(door);
        // Not pumpAndSettle: the fleet diagram on this screen animates for as
        // long as it is shown, so the frame never settles. Pump until the boot
        // lands, bounded.
        for (var i = 0; i < 40 && app.status != AppStatus.authenticated; i++) {
          await tester.pump(const Duration(milliseconds: 50));
        }

        expect(app.status, AppStatus.authenticated);
        expect(app.localOnly, isTrue);
        // The stub supervisor's timer would otherwise still be pending when the
        // fake clock is checked at the end of this test.
        discovery.supervision?.cancel();
      },
    );
  });

  group('HarnessCliRunner', () {
    late Directory scratch;

    setUp(() async {
      scratch = await Directory.systemTemp.createTemp('harness-local-mode-');
    });

    tearDown(() async {
      if (await scratch.exists()) await scratch.delete(recursive: true);
    });

    test('carries the flag to the CLI only while local mode is on', () async {
      final home = Directory('${scratch.path}/home')..createSync();
      final harnessHome = Directory('${home.path}/.harness')..createSync();
      var local = false;
      final runner = HarnessCliRunner(
        harnessHome: harnessHome,
        environment: {'HOME': home.path, 'PATH': '/usr/bin'},
        localMode: () => local,
      );

      expect(
        (await runner.resolve(['start'])).environment['HARNESS_LOCAL_ONLY'],
        isNull,
      );
      local = true; // read per command, never captured at construction
      expect(
        (await runner.resolve(['start'])).environment['HARNESS_LOCAL_ONLY'],
        'true',
      );
    });

  });
}

class _ThrowingStore implements LocalKeyValueStore {
  @override
  Future<String?> read(String key) async =>
      throw const FileSystemException('unreadable');

  @override
  Future<void> write(String key, String value) async =>
      throw const FileSystemException('unwritable');

  @override
  Future<void> delete(String key) async =>
      throw const FileSystemException('unwritable');
}
