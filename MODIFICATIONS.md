# LearnHarness Android modifications

This is an independently maintained Android distribution of LearnHarness,
originally by Amos Blomqvist and contributors, based on the Android port at
https://github.com/Matias-Sanmiguel/learnharness (base revision
`3a827763629347b949faa9c97b286f3bb92f50ff`). It is not an official upstream release.

Modified by swagercode, November 8–12, 2026. The whole application remains licensed
under GNU AGPL version 3 only; see LICENSE. This software is provided without
warranty, as described in that license. Existing copyright and third-party
license notices are retained.

The Android distribution adds or changes:

- Native microphone permission handling, API-key entry/import, and compact
  dictation controls. Speech follows the visible reading or question field.
- Mobile layouts, keyboard-aware menus, scrollable dialogs and exercise docks,
  and an optional dictation-only input mode.
- Session ZIP export/import, update preservation, and stream reconnection.
- Background task monitoring, ready notifications, and Android WebView demo
  verification in a separate process.
- Research finalization when a tool-only research pass returns no brief.
- An English native startup animation, with the first-launch note shown only
  when there is no successfully installed application payload.
- Full-screen interactive demos with a persistent Close control, Android Back
  support, and preserved demo state when entering or leaving fullscreen.
- Self-contained task instructions across teaching, probing, and practice, plus
  a show_again tool to bring verified demos and figures to the current position.
- A dark WebView fallback during app switching, with startup held until a
  page frame is ready to draw.
- Automatic, cancellable ChatGPT connection/service retries in the local
  runtime, preserving consent, account selection, and completed tool work.
- Answer continuation after silent tutor completions, with a bounded recovery
  and corrected ordering of the client completion/ready handoff.
- Lesson follow-through beyond feedback to a new question, with explicit
  pause/completion and bounded, retryable recovery.
- Android build, signing, validation, and release documentation.

Corresponding source and build instructions:
https://github.com/swagercode/learnharness-android

Each published APK is accompanied by a matching source tag and source archive
on the same GitHub release. Dependencies and their sources are recorded in
package-lock.json and android/runtime.json. See android/THIRD_PARTY_NOTICES.md.
