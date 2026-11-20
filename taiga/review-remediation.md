# Review fixes

Target: `fab2268`. Requested on 20 November 2026: fix every finding from the app review.

The goal is to create Japanese and English store images, keep edits recoverable,
send projects only with permission, and produce the right pack on repeated runs.
The original evidence is in `/workspace/review-artifacts/review.md`.

## Design review and implementation scope

The independent reviewer `/root/fix_design_review` reviewed the requirements,
source and proposed changes without the author's assessment or other reviewers'
verdicts. The revised design passed. The director authorizes implementation of
R1 through R7 and the verification failures found in the original review.

- R1: retain the latest failed save per project, report failures, support retry
  and a portable export from memory. Refuse close, update and transfer completion
  when required saves fail.
- R2: default cloud auto save to off. Store explicit permission separately from
  a cloud link. An old link without provenance grants no permission.
- R3: fit the existing Japanese copy in both Taiga styles. Prepare actual English
  text, and verify both languages in the canvas, previews and exported images.
- R4 and R5: use the fork's CLI and catalog, isolate each render, honor store and
  device arguments, copy only manifest files, and preserve existing output when a
  run fails. Verify repeat runs, later versions and name collisions.
- R6: validate counts and required sizes per language. Six Japanese and six
  English images form two sets, with failures attributed to the affected one.
- R7: keep history, zoom, save recovery and timeline controls reachable at narrow
  widths and with touch input.

Acceptance also includes the normal typecheck, unit tests, a build without a
Google Fonts download, and the language workflows that stalled in the review.
Native platform checks and human experience evaluation are recorded separately
from browser tests. No publishing or real account transmission is authorized by
this implementation record.

## Implemented changes

| Finding | Result |
| --- | --- |
| R1 | Failed writes retain the latest document and show a persistent recovery banner. Retry drains new edits too. Recovery export captures memory and bundles image/video assets and imported fonts. Awaited history failures reach tab close and transfer; those operations retain the source tab and lock on failure. Native close refuses failed saves. The updater requires a matching successful answer from every editor and blocks edits while installing. |
| R2 | Automatic cloud updates default off. Only a manual cloud save or opening the owner's cloud copy grants permission for that project. Automatic document and asset writes check the account, project, record and expected revision in server transactions. Conflicts pause without adopting another device's revision. |
| R3 | Both Taiga templates keep their Japanese copy in fitted boxes and provide actual en-US overrides. Their preview strips were regenerated from the Japanese exports. |
| R4 | The pack script builds and snapshots this fork's CLI, reads its catalog, normalizes template aliases and records the selected template and CLI hashes. |
| R5 | Each render runs in isolation. Only manifest files enter staged output. Names, containment, sizes, language counts and hashes are checked before locked replacement with rollback. Store and device mappings are explicit. |
| R6 | Verification groups images by language, checks counts and required formats in each group, and identifies the language with a failure. |
| R7 | Canvas tools and zoom share a wrapping footer. Save/cloud status remains available below desktop widths; the timeline follows the measured footer height. Informational notifications let pointer events through while keeping their Close button usable. |

The normal typecheck also excludes the independent promo packages, and production
builds enforce editor types. Geist fonts ship with the package instead of being
downloaded during a build. The Website fallback language now describes its
English default sentences as en-US even when the editor's base locale is Japanese.

The browser run then reproduced two more workflow failures: language settings
could disappear on an immediate reload during the save debounce, and a closed
start dialog could remain visible while its exit animation waited. The language
manager now waits for the commit and local queue before closing, disables changes
while applying, and remains open on failure. Dialogs and menus close without an
exit-animation wait; their opening animation remains. Normal laptop widths retain
the project name and direct rename action, with long names constrained to their
pill. These changes were independently reviewed and accepted.

## Independent review

The implementation review found four further problems: edits could arrive during
another close writer's wait, an updater timeout could authorize installation,
asset uploads could adopt another device's revision, and save status disappeared
below 2xl width. These were fixed. A second pass found that undo save errors were
still swallowed; they now reach awaited callers, with a catch only at the idle
fire-and-forget caller. The final code review by `/root/remediation_patch_review`
reported no additional mandatory findings. Its targeted unit run passed 105/105.

## Verification

- `npm run test:unit`: 779 passed, no failures or skips.
- `npm run typecheck`: passed with the root configuration.
- `npm run build`: passed, including type validation and static export. It also
  regenerated the AI catalog. No build-time Google Fonts fetch is needed.
- CLI typecheck/build and pack regressions: passed; the pack tests include seven
  Python cases covering preservation on failure and device/version isolation.
- Two real Apple packs (MD3 and Glass) produced five Japanese and five English
  images each at 1206 x 2622, with no warnings or failures. A Google Play pack
  produced ten 1080 x 1920 images. Manifest hashes matched every output. Repeating
  a run removed a planted stale file and preserved another device's directory.
  Six images in each language passed; an eleven-image English set failed only
  English. Evidence: `/workspace/review-artifacts/fix-pack/acceptance-results.json`.
- Template validation: 120 canvas and 120 preview text frames, no overflow, in
  both styles and languages with Noto Sans JP loaded and unavailable. Forty real
  PNG exports were checked for dimensions and alpha; decoded Japanese/English
  images differed. Evidence: `/workspace/remediation-artifacts/templates/`.
- Rust updater handshake: nine tests passed, compiled with rustc from the actual
  changed helper functions and their tests. Evidence and source hashes:
  `/workspace/remediation-artifacts/native/`. This is not a full Tauri build.
- Static browser matrix plus targeted follow-up: 100 distinct cases passed,
  12 platform-specific cases skipped, no unresolved failures or global errors.
  Both web and desktop-IPC configurations passed language addition followed by
  immediate reload, manual translation, export/import, failed-save retry, all
  seven viewport widths, long names with a motion timeline, and finger taps on
  history and zoom controls. Desktop IPC also passed AI translation, refused
  update/close and installing-state edit blocking. A fresh web profile reopened
  the recovery file with its image and imported font.
  An inactive failed project remained recoverable while another tab was active.
  Evidence: `/workspace/remediation-artifacts/browser-validation-summary.json`.
- Targeted tab regressions also verified that failed undo storage keeps the tab,
  live undo history and lock, and that a hand-over retains the source tab until
  storage is durable. The earlier transfer run passed 17 cases; its one old
  expectation that a tab vanished before storage completed was updated to the
  intended safer behavior, and the corrected case passed in the follow-up.

The first touch attempts left the mobile palette open and tapped its About item
at the canvas Undo coordinates. The test now dismisses the palette with a real
finger tap, then taps the visible canvas controls. Both configurations passed
that corrected procedure. The earlier reports are retained rather than erased.
The result summary uses the latest result of each case and never counts a skip
as a pass. `/workspace/remediation-artifacts/validated-source.json` records the
tested source hashes and static build ID; a final check found no source drift.

Logs live in `/tmp/osg-fix-final-unit.log`, `/tmp/osg-fix-final-types.log`,
`/tmp/osg-fix-final-build.log`, `/tmp/osg-fix-final-e2e.log` and
`/tmp/osg-fix-followup-e2e.log`. Earlier failing runs are retained in
`/tmp/osg-fix-static-e2e.log` and `/tmp/osg-fix-tabs-e2e.log`.
Screenshots and JSON reports are under
`/workspace/remediation-artifacts/`. The original review remains unchanged.

## Remaining verification limits

Chromium runs the static app and a second configuration injects the desktop IPC
runtime. These do not substitute for macOS WKWebView, Windows WebView2 or a real
native installer. A full Tauri compile was not run: this Linux workspace lacks
WebKitGTK. No real account, cloud deployment, store upload or external pack
validator was used. The new cloud conditional endpoints must be deployed before
new clients can automatically update projects against an old server; a missing
endpoint pauses saving without a fallback write.

The recovery guarantee here covers screenshot projects. The separate Website
draft and agent chat writers log some storage errors internally; their close and
update durability was outside this review's R1 scope. They need a separate
persistence review before applying the same guarantee to those workflows.

The templates still contain example copy and example screens. Replace those with
the app's own content before release. No human usability session was performed;
readability, timing and comfort remain unverified by a person. This record marks
code and the stated automated checks complete, not a production release or a
human experience evaluation. Work and waiting times were not measured separately.

## Try the repaired workflow

Run `npm ci`, `npm run build`, then
`node tests/e2e/tools/static-server.mjs --port 9003`. Open
`http://localhost:9003`, choose either Taiga Custom template, switch Japanese and
English, edit the copy and export both languages. At 320, 390 and 1080 pixels wide,
try Undo, Redo and zoom. The failure-injection spec
`tests/e2e/specs/local-save-recovery.spec.ts` demonstrates a failed local save,
retry, portable recovery with an image and font in a fresh profile, update refusal
and cancelled native close. No real cloud account is needed for these checks.
