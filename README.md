# XCaster

**XCaster** is a standalone Windows desktop app for [x.com](https://x.com) built for X Spaces streamers who need professional, isolated audio — no BlueStacks, no browser limitations, no audio leaking where it shouldn't.

It ships its own Chromium (via Electron), disables WebRTC AGC at the engine level, and injects a full DSP mixer into the app itself — turning XCaster into a global audio surface where every tab is an independent, isolated input channel.

---

## Download

**Windows (x64)**
[XCaster v1.2.0 — XCaster-win32-x64.zip](https://github.com/awizardxch/xCaster/releases/download/v1.2.0/XCaster-win32-x64.zip)

**macOS (Apple Silicon / arm64)**
[XCaster v1.2.0 — XCaster-darwin-arm64.zip](https://github.com/awizardxch/xCaster/releases/download/v1.2.0/XCaster-darwin-arm64.zip)

**macOS (Intel / x64)**
[XCaster v1.2.0 — XCaster-darwin-x64.zip](https://github.com/awizardxch/xCaster/releases/download/v1.2.0/XCaster-darwin-x64.zip)

Extract the zip and run `XCaster.exe` (Windows) or `XCaster.app` (macOS) — no installer required.

> **macOS note:** First launch requires right-click → Open to bypass Gatekeeper (app is not notarized).

---

## What's new in v1.2.0

### X audio stability and gear behavior refinements
- Kept x.com on the proven BrowserView path with no background throttling on active X views
- Removed non-x.com broadcast relay path (legacy Suno-era integration) to reduce audio-side side effects
- Gear open/close now behaves as a UI visibility/editor flow and no longer forces automatic graph reapply
- Added sender-track self-heal safeguards for stale ended tracks without requiring a full manual rebuild
- Improved default app behavior so X remains the primary tab experience

---

## What's new in v1.1.2

### X Spaces speakers and connection fully restored
- Restored stripping of `Cross-Origin-Embedder-Policy`, `Cross-Origin-Opener-Policy`, and `Cross-Origin-Resource-Policy` headers for x.com — scoped to x.com/twitter.com only (other sites keep their headers). `COEP: require-corp` was blocking X Spaces' cross-origin CDN audio/avatar resources, causing the speaker list to be empty and the Space connection to fail
- Matches v0.5.0's proven header-stripping behaviour exactly

---

## What's new in v1.1.1

### macOS builds added
- GitHub Actions CI now produces three release artifacts on every tag: `XCaster-win32-x64.zip`, `XCaster-darwin-arm64.zip` (Apple Silicon), `XCaster-darwin-x64.zip` (Intel)

---

## What's new in v1.1.0

### Audio routing fixed — host audible to listeners in X Spaces
- x.com now loads in a **BrowserView** with `preload.js` — identical to v0.5.0's architecture. `getUserMedia` is patched before any X scripts run, so the DSP graph and X's `RTCPeerConnection` share the same renderer context
- Removed SDP patching (`patchOpusSdp`) from X's own `RTCPeerConnection` — forcing stereo/510kbps/CBR/no-DTX on X's outbound connection caused X's media servers to reject the SDP, showing the host as muted and disconnected to listeners
- Fullscreen and maximise now resize the BrowserView correctly — listening to `maximize`, `unmaximize`, `enter-full-screen`, `leave-full-screen`, `enter-html-full-screen`, `leave-html-full-screen` in addition to `resize`
- Removed `setAutoResize` which conflicted with manual `setBounds` calls and caused misalignment
- Fixed `BrowserView is not defined` crash — `BrowserView` was missing from the Electron import destructure

---

## What's new in v1.0.1

### Audio quality restored to v0.5.0 standard
- DSP graph is now built directly inside X's webview context (same as v0.5.0) — single Opus encode, no relay
- Chrome WebRTC AGC disabled at capture time via `applyConstraints` (autoGainControl / noiseSuppression / echoCancellation all off)
- Loopback bleed from Cable Output fixed — raw mic fallback no longer occurs

---

## What's new in v1.0.0

### Global audio surface
The mixer gear now lives in the **app itself**, not inside a specific tab. It opens instantly with no tabs loaded and stays accessible regardless of what page you're on.

### xCaster channel — isolated per-tab audio
Every browser tab in XCaster is **automatically muted from your system output** (virtual cable, speakers, everything) the moment it loads. Their audio is captured directly via the Electron frame API and fed exclusively into the **xCaster channel** in the mixer — completely bypassing your PC's audio devices.

- No tab audio leaks to your virtual cable or Aux inputs
- No feedback loop when Aux 1 and xCaster are both monitored
- New tabs are captured automatically as you open them
- Multiple tabs mix together in the xCaster channel pre-gain
- `suppressLocalAudioPlayback` is honoured at the frame level — the OS never sees the audio

### Mixer is app-wide
- **Gear opens on any tab** — or even with no tabs open
- Monitor, Cue, Mute, and level controls all work independently of which page is active
- xCaster channel plays to your **selected speaker output only** — not to PC default

---

## Features

- **WebRTC AGC disabled** — X Spaces cannot auto-level, duck, or re-process your microphone
- **4-channel mixer** — Mic + Aux 1 + Aux 2 + xCaster (in-app tab audio), all summed pre-DSP
- **xCaster channel** — captures all open tabs simultaneously, isolated from system audio
- **Per-channel controls** — Level, Mute, Monitor in headset, Cue (PFL) per channel
- **Cue (PFL)** — audition a channel in your headset without sending it to X
- **Output routing** — monitor bus and X Spaces playback routed to your chosen output device via `AudioContext.setSinkId`
- **Full DSP chain** — High-pass filter → 3-band EQ → Compressor → Limiter → Makeup gain
- **Live meters** — Mic / Aux 1 / Aux 2 / xCaster / Mix / Out / Gain Reduction
- **Background audio stability** — Chromium background throttling disabled; Web Worker keepalive prevents choppy audio when minimized
- **Built-in browser** — tabs for X, YouTube, TibetSwap, MintGarden, and your custom bookmarks
- **Background skin** — `background.mp4` plays behind a semi-transparent content window
- **Draggable UI** — drag the gear anywhere on screen
- **Presets** — Spaces loud+steady / Podcast / Music / Off (raw bypass)
- **Persists settings** — all knobs saved in localStorage between sessions

---

## Run from source

```powershell
cd XForWindows
npm install
npm start
```

## Build standalone exe

```powershell
cd XForWindows
npm install
npm run package
```

Output: `XForWindows/dist/XCaster-win32-x64/XCaster.exe`

---

## Usage

1. Launch **XCaster.exe**
2. Click the **⚙ gear** button (bottom-right, or wherever you dragged it) — works with or without tabs open
3. **Mic tab** — pick your microphone, set level
4. **Aux 1 / Aux 2 tabs** — optionally pick desktop audio or an external source
5. **xCaster tab** — shows how many tabs are captured; use Mute / Monitor / Cue / Level to control them
6. **Speakers tab** — pick where the monitor bus plays (headphones, to avoid feedback)
7. **Processing tab** — tune HPF, EQ, compressor, limiter
8. **Skin tab** — background video, content opacity, drag positions
9. **Presets tab** — one-click starting points

Press `Ctrl+,` to toggle the panel at any time.

---

## Audio routing architecture

```
[Mic]  ──────────────────┐
[Aux 1 (virtual cable)]  ├──► per-channel Gain ──► mixBus ──► DSP ──► X Spaces (getUserMedia)
[Aux 2 (ext. mixer)]  ───┤
[xCaster (all tabs)]  ───┘

               monitorBus ──► AudioContext.setSinkId ──► selected headset
```

Tab audio **never touches the system audio device**. The virtual cable on Aux 1 only captures what you explicitly route there — not xCaster tab audio.

---

## Why it exists

Desktop X in Chrome/Edge forces WebRTC AGC onto every mic with no UI toggle. XCaster launches with Chromium flags that disable the audio service APM, patches `getUserMedia` so X receives a flat signal, and adds a full DSP chain with metering so you control your sound — not X's algorithm.

---

## Requirements

- Windows 10/11 x64
- No virtual cable required (optional for routing from external apps into Aux 1/2)
