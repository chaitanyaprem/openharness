import 'package:flutter/material.dart';

import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/setting_row.dart';
import '../../state/app_state.dart';

class AccountSection extends StatelessWidget {
  const AccountSection({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notifier,
    builder: (context, _) {
      final local = notifier.localManualFixture != null;
      final localMode = notifier.localOnly;
      final profile = notifier.currentUser;
      return SectionScaffold(
        title: 'Account',
        subtitle: local
            ? 'Connected to a local development session.'
            : localMode
            ? 'This computer runs without an account. Sign in to reach other machines.'
            : 'Your Harness sign-in on this computer.',
        child: SingleChildScrollView(
          child: SettingRow(
            title:
                profile?.displayName ??
                (local
                    ? 'Local session'
                    : localMode
                    ? 'Local mode'
                    : 'Signed in'),
            detail:
                profile?.email ??
                (local
                    ? 'Loopback backend'
                    : localMode
                    ? 'This computer, no account'
                    : 'Profile unavailable'),
            control: OutlinedButton(
              key: const Key('settings-sign-out-button'),
              onPressed: () {
                Navigator.of(context).pop();
                notifier.logout();
              },
              child: Text(
                local
                    ? 'Disconnect local session'
                    : localMode
                    ? 'Leave local mode'
                    : 'Sign out',
              ),
            ),
          ),
        ),
      );
    },
  );
}
