# LearnHarness on Android

An Android host for the existing LearnHarness application. The APK embeds the
Next standalone server and Node.js Mobile; it does not connect to a desktop PC or
require a hosted LearnHarness server. Learning data and ChatGPT credentials stay
in Android's private app storage. Model requests still require internet.

The ARM64 APK runs on phones including Pixel 10 and tablets including Samsung
Galaxy Tab S9+ and Tab S10 FE. Minimum Android: 8.
The x86_64 APK is for emulator validation. Both use the same application payload.

## Install and connect a provider

1. Download the signed ARM64 APK from this repository's GitHub Releases and open it.
2. Allow installation from that app when Android asks, then install LearnHarness.
3. On first launch, wait for the local application to unpack.
4. Open Settings → Providers → ChatGPT and sign in. Chrome or Samsung Internet
   opens the OpenAI authorization page. Approve use of your ChatGPT plan, then
   return to LearnHarness. No API key is required.
5. Select available ChatGPT models in the app's model settings.

Usage is subject to the limits and eligibility of the connected ChatGPT plan.
The app never falls back to a developer's API key. No account is shipped in it.

Local sessions can be read without internet. Generating new answers and signing
in require internet. Version `0.4.1-android.6` keeps responses, research, and
other active jobs running when you leave the app, lock the phone, or swipe it
from recent apps. Allow notifications when prompted. Tap a ready/needs-attention
alert to open its session; alerts are quiet while the app is foregrounded.
Settings → General → Background work links to Android notification settings.
For long screen-off tasks, allow background battery usage in Android app settings
(linked beside notification settings). Doze can suspend networking and ignore
wake locks unless the user exempts the app; the app does not change that setting.

The native foreground service watches authenticated server state independently
of the WebView, reconnects without repeating model calls, and holds a bounded
CPU wake lock only during startup/active work. It stops its foreground service
after 30 idle background seconds. Imported/old sessions do not generate alerts;
progress updates and research delivery do not generate duplicates.
Force stop, restart, OS memory pressure, and Android's dataSync time budget can
still interrupt work. Android 15+ allows up to six background hours before the
service must stop (returning to the foreground resets the budget). On that
timeout the app posts a paused notice; it never automatically resubmits model
requests. Stored sessions remain available after restarting.

Install updates signed with the same key over the existing app to preserve data.
Uninstalling or clearing app data removes local sessions and credentials. Backups
are disabled so device-bound credentials are not copied to another device.

## Startup and dictation in v9

Version `0.4.1-android.9` replaces the native spinner with the reviewed animated
knowledge graph and English startup text. The first-launch note is hidden on
reopens and upgrades, including upgrades from versions before v9. Animation
respects Android's disabled-animations setting and stops off-screen.

Scrolling back to the lesson and reopening a question now restores the question's
dictation destination. Submitting while recording includes the final spoken
words. Browser regression coverage exercises both typing and dictation-only modes.

The demo card offers Full screen instead of Download. Its Close control remains
outside the scrolling demo; Android Back and keyboard Escape also exit. The
iframe stays mounted, preserving the demo's current controls and state. Browser
coverage: `scripts/mobile-demo-smoke.mjs` with the layout fixtures. Native checks:
`scripts/android/DemoUiChecks.java`.

## Build

### Mobile layout checks

Version `0.4.1-android.8` bounds the graph toolbar, chains search and selection
bar, settings controls, setup/confirmation dialogs, and floating popovers to
the available screen. Nested folders use smaller, capped indentation on phones.
Long prose wraps; wide code, tables, and math keep their own scroll areas.
Reading thoughts return with their draft when the exercise folds as you scroll
back to the lesson. A downward swipe at the exercise's top continues into the
lesson. Dictation follows the visible reading or exercise field.

`scripts/mobile-layout-fixtures.mjs <new-directory>` creates isolated sample
data and an empty auth store. With a local server using that directory, run
`scripts/mobile-layout-smoke.mjs` and its `--content` variant. Set
`LH_LAYOUT_URL`, `LH_LAYOUT_ARTIFACTS`, and `CHROME_PATH` as needed. The sweep
covers six sizes from 320px phones through landscape and desktop, reduced
keyboard viewports, large text, long content, touch scrolling, and preserved
reading drafts. It blocks outgoing chat POSTs and must use fixture data.

### Interactive demos (Android 9+)

Version `0.4.1-android.7` verifies generated demos using Android System WebView,
instead of trying to launch desktop Chrome. A bound service runs in a separate
process and WebView profile, including while the phone app window is closed.
Its private render surface runs Canvas, SVG, controls, and animation frames;
console errors, exceptions, rejected promises, failed resources, and optional
interaction probes feed the existing mandatory verification gate.

Android demos are dependency-free: inline JavaScript/CSS, Canvas, and SVG.
The verifier has no network, file/content access, native JavaScript interface,
or app cookies. The document runs in an opaque sandboxed iframe. Bounded queues
and timeouts reject stuck demos; they never mark an unexecuted demo as tested.
Older failed demo cards keep their saved error; ask the tutor to rebuild the
demo after installing the update. Android 8 retains other app features, but
demo verification requires Android 9 or newer for separate WebView profiles.

`scripts/android/DemoRendererChecks.java` exercises the actual Android browser
with controls, canvas, animation, failure, isolation, and service-restart cases.

### More room for questions

Opening a teaching question hides the reading-thoughts field and keeps its
draft for submission. Phone answer/thinking fields start at one compact line.
Settings → Appearance → Dictation only removes learner text boxes entirely;
Dictate, Review/Clear, and Submit stay available. Spoken drafts survive switching
back to typing. The preference persists across app launches and backup/export.
`scripts/android/MobileLayoutChecks.java` checks actual phone geometry and the
saved setting using a disposable unanswered question, then restores preferences.

### Build prerequisites

Requirements: Node 24+ (CI uses 26), JDK 21, Python 3, curl, unzip, tar, Android SDK
platform 35, build-tools 35, NDK 28.0.13004108 and CMake 3.22.1.

```sh
npm ci
npm run android:prepare
cd android
./gradlew testDebugUnitTest assembleDebug assembleRelease
```

Set `JAVA_HOME` to your JDK and `ANDROID_HOME` to your SDK. Build products are in
`android/app/build/outputs/apk/`. The release APK is unsigned until signed with
the owner's private key using Android `apksigner`. Never commit a signing key.
Debug APKs are for testing, not interchangeable with a release-signed install.

## Import saved Mac sessions

Android version `0.4.1-android.2` accepts `.lhbackup.zip` session backups through
**Import notes → Files**. Select one backup, confirm **Import & close**, then
reopen LearnHarness. The app validates the archive before staging it and applies
the import before starting its local server. Existing sessions with different
content are never overwritten; a conflict refuses the import. Phone model
preferences take precedence over imported preferences. Sign-in credentials are
not transferred.

Backup format 1 is a ZIP containing `learnharness-backup.json` and `data/` files.
The manifest has `format: "learnharness-backup"`, `version: 1`, and a `files` array
with each relative `path`, byte count (`bytes`), and SHA-256 (`sha256`). Supported
files are `chats/chat_*.json`, terminal `jobs/job_*.json` belonging to those chats,
and optional `settings.json`. This is a session transfer, not a knowledge-graph
or full-profile restore. Files retain their original contents and session IDs.

`scripts/android/rebuild-host.py` can rebuild the Java host using a previously
built ARM64 APK's unchanged server payload and native libraries. It requires
`JAVA_HOME` and `ANDROID_HOME`; its unsigned output must be signed with the same
key as the installed APK. `scripts/android/BackupImportChecks.java` exercises the
archive and restore logic with synthetic data under Android's `app_process`.

To sign a personal ARM64 install, run `node scripts/android/sign.mjs` from the
repository root (or pass a downloaded unsigned APK path). This creates a private
key under `~/.cache/learnharness-android/signing/` and reuses it on subsequent
builds. Back up that directory privately: losing it prevents in-place updates.
The signed APK and SHA-256 are written to `dist/`.

The Android APK GitHub Actions workflow builds both ABIs and runs the x86_64 app
on an API 35 emulator. `node scripts/android/smoke.mjs` checks startup, WebView,
HTTP access controls, portrait/landscape layout, OAuth request construction and
session persistence after an offline restart. It does not log into a real account
or spend ChatGPT quota.

## Runtime and limits

Dictation in `0.4.1-android.3` and later requests Android microphone permission
when you tap Dictate. Choose **While using the app** to record. The native host
permits audio capture only for the local LearnHarness page; external pages and
camera requests are denied. Dictation also requires a Deepgram key under
**Settings → Providers → Dictation**. ChatGPT sign-in does not supply this key,
and session backups do not transfer it. If microphone access was permanently
denied, enable it in Android's app permissions for LearnHarness.

`scripts/android/DictationChecks.java` is separate test instrumentation. It
checks native permission restrictions and exercises the real WebView microphone
and audio worklet with simulated transcription responses, without provider calls.

The Node Mobile binary is a **prerelease** from the fogtape fork. The original
nodejs-mobile release is Node 18 and cannot run this version of Next. See
`runtime.json` for pinned source and SHA-256. The build verifies that digest and
the package-lock integrity of Android native dependencies.

ARM64 includes Android-native canvas and SVG rendering libraries. The x86_64
emulator build does not have those optional native renderers. Desktop-only CLI
providers (including Cursor) and headless Chromium demo verification need their
desktop environment; they are not installed in the tablet. Desktop behavior is
preserved in the same branch.

This is an initial Android build. A successful emulator run is not a claim of
physical Samsung-device testing or a completed ChatGPT Pro login. Those require
the tablet and its owner's account.

## Phone settings and key files

Version `0.4.1-android.4` uses full-screen settings with horizontally scrollable
section tabs on phones. Key editors have full-width inputs, a visibility toggle,
character counts, and separate Save/Cancel buttons. Autocorrection and automatic
capitalization are disabled for credentials.

For Deepgram, open **Settings → Providers → Dictation → Deepgram**, then either
paste the 40-character secret or choose **Import key file** and select the `.txt`
file containing it. Import fills the field; **Save** stores it. A filename or URL
is not a credential. Whitespace introduced while copying a complete key is
removed before validation and storage. The key still needs the **Member** role
for temporary-token authentication.

To package web changes while reusing an existing ARM64 native runtime, run
`npm run android:prepare`, then pass `android/.generated/assets` as the optional
third argument to `scripts/android/rebuild-host.py`. The script verifies the
server payload hash before packaging. Sign the result with the same private key
as the existing install.

## Session export and APK updates

Install a new signed APK **over the existing app**. The application ID and signing
certificate must match; this keeps the app's private data. Do not uninstall or
clear storage to update. Version `0.4.1-android.5` was checked by hashing saved
sessions and jobs before and after an in-place upgrade.

In version 5 and later, **Settings → General → Export sessions…** creates a
`.lhbackup.zip` and opens Android's Save dialog. Wait for active responses and
background jobs to finish first. The backup includes complete session records,
saved job results (including embedded demos/visuals), and settings. It excludes
API keys, account sign-ins, the knowledge graph, and original external source
files such as PDFs. Store the file somewhere outside app storage.

Use **Settings → General → Import backup…** to restore it. Existing sessions are
kept; an older conflicting version is refused rather than overwriting newer
work. Importing identical records is safe. The per-session **Export as Markdown…**
action also opens Android's Save dialog; Markdown is for reading, not restoring.

`scripts/android/SessionBackupChecks.java` checks in-place update preservation
and export/import byte equality against an isolated restore directory.

Model menus now stay within the visual viewport as the keyboard opens. Research
gets one bounded synthesis request when its tool budget ends before a final
brief. Web searches still require a Tavily or Brave key under Providers; reading
supplied URLs works without a search key. ChatGPT sign-in does not supply a
search-service key.

If Android leaves a response stream open after it stops delivering updates, the
visible session now checks completion every 15 seconds while busy and reattaches
on foreground/online events. This only reads/replays the existing server turn;
it never repeats the user's POST or cancels ongoing model thinking.

Questions and practice tasks carry their own starting values, steps, and conditions.
Interactive models remain separate; the agent can use `show_again` to bring an
earlier verified demo or figure to the current position. A reused demo starts
fresh, so required trial setup is stated explicitly.

Version `0.4.1-android.10` gives the WebView the same dark fallback as the native
window so it cannot flash its default white surface while returning to the app.
Startup stays visible until Chromium reports the page is ready to draw. Normal
app switching keeps the existing WebView and page rather than reloading them.
