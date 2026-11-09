# LearnHarness for Android

A standalone Android app for adaptive teaching, practice, research, and a
persistent graph of what you learn. The app runs its own local engine on your
phone; you do not need a Mac, PC, or hosted LearnHarness server.

**[Download the Android APK](https://github.com/swagercode/learnharness-android/releases/latest)** ·
[Build instructions](android/README.md) · [License](LICENSE) · [Changes and attribution](MODIFICATIONS.md)

## Install

- Android 8 or newer, ARM64. Tested on a Pixel 10 emulator; phone and tablet
  layouts are supported. Interactive demo verification requires Android 9+.
- Download the signed `arm64.apk` from Releases and open it on your device.
- Android may ask you to allow installation from your browser or file manager.
- Connect your own supported AI account or API key in Settings → Providers.
  No credentials are included. Model requests require internet.

**Updating an existing install:** install the APK over the current app. This
release uses the same application ID and signing certificate as the earlier
Android builds. Do not uninstall or clear app storage to update.

Before moving phones or reinstalling, use **Settings → General → Session
backups → Export**. Backups contain sessions, jobs, and settings; credentials
are excluded. A normal signed update preserves existing app data.

## Mobile features

- Teaching, practice, questions, research, and verified interactive demos.
- Compact phone layouts and menus that stay inside the available screen.
- Deepgram speech-to-text and a dictation-only mode for more reading space.
- Background tasks and notifications when a session needs your attention.
- Session ZIP export/import and local session storage.
- A native startup animation, with English status and a first-launch note that
  disappears on subsequent starts and upgrades.

For dictation, add your own Deepgram key under Settings → Providers → Dictation
and grant microphone access. Deepgram is separate from your chat provider.
Settings → Appearance → Dictation only hides the text editors while keeping
Dictate, Review, Clear, and Submit available.

Allow notifications when asked. Android can still interrupt background work
because of force-stop, restart, memory pressure, battery restrictions, or the
foreground-service time budget; see [background behavior](android/README.md).

## Version 0.4.1-android.9

- Adds the native animated startup screen and first-launch detection.
- Requires self-contained questions and practice tasks, including their starting
  values and operations. Models stay separate from the question.
- Adds `show_again` so the agent can bring an earlier verified demo or figure
  forward without rebuilding it or asking you to scroll back. Reused demos
  start fresh; required setup is stated explicitly.
- Replaces demo downloads with fullscreen, a persistent Close button, and
  Android Back support. Opening or closing fullscreen preserves demo state.
- Fixes speech going into the hidden message composer after scrolling back to
  the lesson and reopening a question. Both normal and dictation-only input
  modes are covered by the browser regression test.
- Preserves final spoken words when submitting a question during recording.

## Build from source

The repository includes the shared React/Next application, its Node runtime,
and the Android host. Shared desktop-origin helpers are retained where the
runtime needs them; releases and CI here target Android.

Install Node 24+ (CI uses 26), JDK 21, Python 3, and the Android SDK with platform
35, build-tools 35, NDK 28.0.13004108, and CMake 3.22.1. Then:

```sh
npm ci
npm run android:prepare
cd android
./gradlew testDebugUnitTest assembleDebug assembleRelease
```

Release output is unsigned. See [signing instructions](android/README.md) to
create your own key. Your own signed build cannot update a build signed by a
different key; use session export/import when changing signing identities.
Never commit private signing keys, passwords, provider keys, or session data.

The Android workflow runs type checking, focused regression tests, native unit
tests, APK assembly, and an emulator smoke check. It uploads unsigned build
artifacts; public releases are signed separately.

## License and upstream

This is an independent Android distribution of
[LearnHarness by Amos Blomqvist and contributors](https://github.com/amosblomqvist/learnharness),
based on [Matias Sanmiguel’s Android port](https://github.com/Matias-Sanmiguel/learnharness).
It is not an official upstream release.

The application remains **GNU AGPL-3.0-only**, with no warranty. You may fork,
modify, and redistribute it under that license. Original notices are preserved;
[MODIFICATIONS.md](MODIFICATIONS.md) identifies this distribution’s changes and
date. Each APK release includes its matching source tag and source archive,
with no additional charge. Dependency notices are in
[android/THIRD_PARTY_NOTICES.md](android/THIRD_PARTY_NOTICES.md).
