import 'dart:convert';
import 'dart:io';

/// The same file the CLI reads: `HARNESS_CONFIG`, or `~/.harness/self-host.json`.
///
/// Absent file and no env flag means the upstream relay and SSO. A test passes
/// [environment] so it does not read the developer's real home.
class SelfHostConfig {
  final bool selfHosted;
  final String? backendUrl;
  final String? enrollmentToken;

  const SelfHostConfig({
    required this.selfHosted,
    this.backendUrl,
    this.enrollmentToken,
  });

  static const off = SelfHostConfig(selfHosted: false);

  static SelfHostConfig load({Map<String, String>? environment}) {
    final env = environment ?? Platform.environment;
    final file = _readFile(env);
    final selfHosted =
        _truthy(env['HARNESS_SELF_HOSTED']) || file?['selfHosted'] == true;
    final backendUrl = _nonEmpty(env['HARNESS_BACKEND_URL']) ??
        _nonEmpty(file?['backendUrl'] as String?);
    final enrollmentToken = _nonEmpty(env['HARNESS_ENROLLMENT_TOKEN']) ??
        _nonEmpty(file?['enrollmentToken'] as String?);
    return SelfHostConfig(
      selfHosted: selfHosted,
      backendUrl: backendUrl,
      enrollmentToken: enrollmentToken,
    );
  }

  /// Environment entries the desktop adds when it launches the CLI.
  /// Existing entries win, so a test can pin a value.
  Map<String, String> cliEnvironment(Map<String, String> base) {
    final out = Map<String, String>.from(base);
    if (backendUrl != null) {
      out.putIfAbsent('HARNESS_BACKEND_URL', () => backendUrl!);
    }
    if (!selfHosted) return out;
    out.putIfAbsent('HARNESS_SELF_HOSTED', () => 'true');
    out.putIfAbsent('HARNESS_ANALYTICS_DISABLED', () => 'true');
    out.putIfAbsent('DISABLE_GRID_INSTALL', () => 'true');
    out.putIfAbsent('ADAPTER_UPDATE_DISABLE', () => 'true');
    out.putIfAbsent('HARNESS_STORE_OFFLINE', () => 'true');
    if (enrollmentToken != null) {
      out.putIfAbsent('HARNESS_ENROLLMENT_TOKEN', () => enrollmentToken!);
    }
    return out;
  }

  static Map<String, dynamic>? _readFile(Map<String, String> env) {
    final explicit = env['HARNESS_CONFIG']?.trim();
    final home = env['HOME']?.trim();
    final path = (explicit != null && explicit.isNotEmpty)
        ? explicit
        : (home != null && home.isNotEmpty ? '$home/.harness/self-host.json' : null);
    if (path == null) return null;
    final file = File(path);
    if (!file.existsSync()) return null;
    try {
      final raw = jsonDecode(file.readAsStringSync());
      if (raw is Map<String, dynamic>) return raw;
      if (raw is Map) return Map<String, dynamic>.from(raw);
    } catch (_) {}
    return null;
  }

  static bool _truthy(String? value) {
    final v = value?.toLowerCase().trim();
    return v == '1' || v == 'true' || v == 'yes';
  }

  static String? _nonEmpty(String? value) {
    final trimmed = value?.trim();
    if (trimmed == null || trimmed.isEmpty) return null;
    return trimmed;
  }
}
