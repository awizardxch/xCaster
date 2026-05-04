# XCaster

**XCaster** is a standalone Windows desktop app for [x.com](https://x.com) built for X Spaces streamers who need professional, consistent audio — without BlueStacks, virtual cables, or browser limitations.

It ships its own Chromium (via Electron), disables WebRTC's automatic gain control at the engine level, and injects a full DSP mixer overlay directly into the X interface.

---

## Download

**[XCaster v0.5.0 — XCaster-win32-x64.zip](https://github.com/awizardxch/xCaster/releases/download/v0.5.0/XCaster-win32-x64.zip)**

Extract the zip and run `XCaster.exe` — no installer required.

---

## Features

- **WebRTC AGC disabled** — X Spaces cannot auto-level, duck, or re-process your microphone
- **3-channel mixer** — Mic + Aux 1 (desktop audio) + Aux 2 (external receiver/mixer) summed pre-DSP
- **Per-channel controls** — Level, Mute, Monitor in headset, Cue (PFL), AGC/NS/EC toggles per channel
- **Cue (PFL)** — Hear a channel in your headset without sending it to X. Preload audio before going live.
- **Output routing** — All X Spaces + page audio routed through a dedicated AudioContext to your chosen headset device
- **Full DSP chain** — High-pass filter → 3-band EQ → Compressor → Limiter → Makeup gain
- **Live meters** — Mic / Aux 1 / Aux 2 / Mix / Out / Gain Reduction (persistent bar above tabs)
- **Background priority** — Pinned to High process priority every 3 s via PowerShell; Web Worker keepalive prevents audio choppiness when minimized or covered by other apps
- **Background skin** — Your `background.mp4` plays behind a semi-transparent X content window
- **Draggable UI** — Drag the gear button anywhere on screen
- **Presets** — Spaces loud+steady / Podcast / Music / Off (raw bypass)
- **Persists settings** — All knobs saved in localStorage between sessions

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
2. Click the **⚙ gear** button (bottom-right, or wherever you dragged it)
3. **Mic tab** — pick your microphone, set level
4. **Aux tab** — optionally pick a second audio source to mix in
5. **Speakers tab** — pick where X's incoming audio plays (headphones, not your speakers, to avoid feedback)
6. **Processing tab** — tune HPF, EQ, compressor, limiter
7. **Skin tab** — enable background video, set content opacity, drag positions
8. **Presets tab** — one-click starting points

Press `Ctrl+,` to toggle the panel at any time.

---

## Why it exists

Desktop X in Chrome/Edge forces WebRTC's auto gain control onto every mic. There is no UI toggle. XCaster launches with Chromium flags that disable the audio service APM and patches `getUserMedia` in a preload so X receives a flat, unprocessed signal — then lets *you* apply dynamics and EQ with full visibility via meters.

---

## Requirements

- Windows 10/11 x64
- No virtual cable required (optional if you want to route from another app)
