# Usage videos (desktop recorder)

Records the WebBlackbox usage videos on a real Windows desktop with real Chrome, driven from WSL:
a dedicated throwaway Chrome profile, real mouse and keyboard input at human speed, ffmpeg
capturing only the demo window, and captions burned into a bar under the picture.

| Scenario            | Shows                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install`           | Player guide → download the zip → "Show in folder" → "Extract all" → `chrome://extensions` → Developer mode → Load unpacked → pin → Options → Player URL |
| `record-and-export` | profile picker (Default → Full capture, visual "Both") → Start with the reload offer → bug on the demo shop → Marker → Stop → Export with a passphrase   |
| `open-in-player`    | Player → "Choose archive…" → the exported file → passphrase → the recording is open                                                                      |

The videos are Russian only (owner decision): Russian captions, Chrome with `--lang=ru`, and the
native Windows dialogs of a Russian Windows. Nothing here runs in CI except the caption unit test
(`lib/captions.test.mjs`) and `--dry-run`.

## Prerequisites

- Windows 11 + WSL2 with `networkingMode=mirrored` (Windows Chrome reaches WSL servers on
  `localhost`), one screen, 100 % scaling.
- Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- ffmpeg on Windows (`C:\ProgramData\chocolatey\bin\ffmpeg.exe`, used for `gdigrab` capture) and
  in WSL (`ffmpeg` with libass, used for the final encode).
- PowerShell 5.1 (`powershell.exe`): the helpers in `win/` are C# compiled on the fly.
- A fresh build and package of the extension, and a Player build:
  `pnpm build && pnpm --filter @webblackbox/extension package:chrome`.
- The Player the videos point at (`WBB_DEMO_PLAYER_URL`, default
  `https://webblackbox.box.sg4m.org/`) must serve a build with the extension guide (task 50).

## Running

```bash
node apps/extension/scripts/demo-video/run.mjs --list
node apps/extension/scripts/demo-video/run.mjs install --rehearsal   # same steps, nothing recorded
node apps/extension/scripts/demo-video/run.mjs install               # one take
node apps/extension/scripts/demo-video/run.mjs all                   # every scenario, in order
node apps/extension/scripts/demo-video/run.mjs all --dry-run         # captions only, no desktop
```

Wrap real takes in `timeout` (each take also has a 6-minute hard limit). Record
`record-and-export` before `open-in-player`: its exported archive is the one the Player video opens.

Before a take: turn on Windows "Do not disturb", keep the area `0,0–1600,1000` of the screen free,
and do not touch the mouse or keyboard.

**Abort:** press **Esc** or push the cursor into any screen corner. A low-level hook watches
physical input only (the recorder's own input is marked as injected), stops the cursor mid-move,
stops ffmpeg and closes the demo browser.

## Safety

- Only a throwaway profile under `C:\Users\Admin\wbb-demo` (`WBB_DEMO_WIN_DIR`) is used; it is wiped
  before every take. The owner's profile, windows and downloads folder are never touched.
- Before every click and every key the agent checks that the foreground window belongs to the
  demo Chrome (or the Explorer/dialog the current step opened); otherwise it refuses the input.
  Clicks and the wheel also check the window under the cursor, so a topmost window of another
  app (a notification, an always-on-top tool) over the target is refused rather than clicked.
  Typing into a page also requires the target field to have the focus.
- The agent never sends Escape (it is the abort key).
- The demo shop (`site/`, served from WSL) uses fake data, a fake account and the visibly fake
  passphrase `demo-passphrase-2026`.

## Outputs

- `apps/extension/demo-video-output/` (git-ignored): `<scenario>.ru.mp4` (1600×1110, H.264, CRF 23),
  the burned `<scenario>.ru.ass` captions and `<scenario>.ru.marks.json` (when each caption
  appeared in the take). `dry-run/` holds the `--dry-run` captions.
- A copy of each video in `C:\Users\Admin\webblackbox-test-build\videos\` (`WBB_DEMO_REVIEW_DIR`).
- The Player build bundles the videos from `demo-video-output/` into `build/extension/videos/`
  with `extension/videos.json` (see `apps/player/scripts/lib/bundle-videos.mjs`); the extension
  guide shows them. `WB_PLAYER_VIDEOS_DIR` points the build at another folder. No video is ever
  committed.

## How it works

- `run.mjs` — CLI. `lib/take.mjs` runs one take: helpers up, `prepare` off camera, capture, steps,
  encode, copy for review.
- `lib/windows.mjs` + `win/Agent.cs` — a long-running PowerShell/C# agent (JSON lines over stdio):
  UI Automation lookups by accessible name, eased cursor motion and clicks via `SendInput`,
  Unicode typing, window placement. `win/Watchdog.cs` is the abort hook.
- `lib/browser.mjs` — the demo Chrome (pre-seeded profile, CDP on port 9333) and `DemoPage`: CDP
  finds an element (shadow DOM included), the real cursor moves to it; the viewport's screen
  offset is corrected from the page's own `mousemove` events.
- `lib/recorder.mjs` — `gdigrab` of the window rectangle, then pad + `ass` burn-in.
- `lib/captions.mjs` — reading time, caption cues, ASS (pure, unit-tested).
- `scenarios/` — one file per video; `profiles.mjs` builds, off camera, the profile with the
  extension installed, pinned and pointed at the Player that the later videos start from.

## Adding a scenario

Write `scenarios/<id>.mjs` exporting `{ id, title: { ru }, prepare(ctx), steps, cleanup? }`; each
step is `{ id, say?: { ru }, run?(ctx) }` (the caption appears when the step starts and stays at
least its reading time). Register it in `scenarios/index.mjs`, run `--dry-run`, then `--rehearsal`.
For the guide to show it, add its id to `GUIDE_VIDEO_IDS` in `apps/player/scripts/lib/bundle-videos.mjs`
and `apps/player/src/next/features/extension-guide/videos.ts`, plus a title in the guide locales.
