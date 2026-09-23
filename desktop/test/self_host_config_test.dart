import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/self_host_config.dart';

void main() {
  test('an empty environment is the upstream relay', () {
    final config = SelfHostConfig.load(environment: {'HOME': '/no/such/home'});
    expect(config.selfHosted, isFalse);
    expect(config.backendUrl, isNull);
    expect(config.cliEnvironment({'PATH': '/usr/bin'}), {'PATH': '/usr/bin'});
  });

  test('the config file sets the CLI environment the daemon inherits', () {
    final home = Directory.systemTemp.createTempSync('harness-self-host-');
    addTearDown(() => home.deleteSync(recursive: true));
    final file = File('${home.path}/self-host.json')
      ..writeAsStringSync(
        '{"selfHosted":true,"backendUrl":"http://10.0.0.8:8085","enrollmentToken":"root-secret"}',
      );
    final config = SelfHostConfig.load(
      environment: {'HARNESS_CONFIG': file.path, 'HOME': home.path},
    );
    expect(config.selfHosted, isTrue);
    expect(
      config.cliEnvironment({'PATH': '/bin', 'DISABLE_GRID_INSTALL': 'false'}),
      {
        'PATH': '/bin',
        'DISABLE_GRID_INSTALL': 'false',
        'HARNESS_BACKEND_URL': 'http://10.0.0.8:8085',
        'HARNESS_SELF_HOSTED': 'true',
        'HARNESS_ANALYTICS_DISABLED': 'true',
        'ADAPTER_UPDATE_DISABLE': 'true',
        'HARNESS_STORE_OFFLINE': 'true',
        'HARNESS_ENROLLMENT_TOKEN': 'root-secret',
      },
    );
  });
}
