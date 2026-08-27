# XCaster

**XCaster** is a standalone Windows desktop app for [x.com](https://x.com) built for X Spaces streamers who need professional, isolated audio — no BlueStacks, no browser limitations, no audio leaking where it shouldn't.

It ships its own Chromium (via Electron), disables WebRTC AGC at the engine level, and injects a full DSP mixer into the app itself — turning XCaster into a global audio surface where every tab is an independent, isolated input channel.

---

## Download

**Windows (x64)**
[XCaster v1.4.2 — XCaster-win32-x64.zip](https://github.com/awizardxch/xCaster/releases/download/v1.4.2/XCaster-win32-x64.zip)

**macOS (Apple Silicon / arm64)**
[XCaster v1.4.2 — XCaster-darwin-arm64.zip](https://github.com/awizardxch/xCaster/releases/download/v1.4.2/XCaster-darwin-arm64.zip)

**macOS (Intel / x64)**
[XCaster v1.4.2 — XCaster-darwin-x64.zip](https://github.com/awizardxch/xCaster/releases/download/v1.4.2/XCaster-darwin-x64.zip)

Extract the zip and run `XCaster.exe` (Windows) or `XCaster.app` (macOS) — no installer required.

> **macOS note:** First launch requires right-click → Open to bypass Gatekeeper (app is not notarized).

---

## What's new in v1.4.2

### Incoming Space audio no longer freezes
- Fixed incoming Space audio stopping mid-Space and staying dead until you left and rejoined. Every other channel kept working, which is why it looked like X's problem rather than the mixer's.
- Cause: the capture side (mic, Aux 1/2, the outgoing sender) has had automatic recovery for a while, but the **playback** side had none — the only check was "resume the output context if it is suspended". If the output device stalled, most often a USB interface re-enumerating mid-Space, the context kept reporting itself as running while no audio flowed, and nothing noticed.
- XCaster now watches the output context for a stalled render clock or a non-running state, and restores it in place — resuming it, re-applying the output device, and restarting any stalled playback element. Recovery is paced so a genuinely dead device can't thrash your output.
- If it ever does freeze again, the console now names the condition that fired.

---

## What's new in v1.4.1

### Security: mic and location scoped to X
- The built-in browser granted **microphone/camera** and **geolocation** to *every* site it loaded, not just x.com. Because XCaster ships a general browser (YouTube, TibetSwap, your own bookmarks), any page you opened — including a malicious link — could capture the mic or your location with no prompt.
- Both are now restricted to **x.com / twitter.com**. Low-risk permissions (notifications, clipboard, pointer lock, Web MIDI) stay available everywhere so the app-wide mixer and hardware MIDI controllers keep working; anything else is denied by default.
- X Spaces, the xCaster tab-capture channel and MIDI are unaffected. The one visible change: opening the gear on a **non-X** tab can no longer acquire the microphone — that is the hole being closed, and the X tab's mixer (the one feeding your Space) is untouched.

---

## What's new in v1.4.0

This is the first **stable** build of the Soundboard + MIDI instrument + Loop Station line — it ships everything from the v1.3.0 beta series plus a full General MIDI instrument catalog and two mixer mute fixes.

### Mixer mute fixes
- **"Mute mic" no longer silences everything.** The panel toggle zeroed the mic channel gain but also disabled the WebRTC sender track — and that track carries the whole mix (Mic + Aux 1 + Aux 2 + xCaster + Sounds), so muting the mic cut the entire broadcast. It is now a channel mute only; Aux, xCaster and Sounds keep sending.
- **X's own mic button inside a Space now works.** XCaster hands X a clone of the processed mix and swaps in fresh clones on device changes, so the track object X held drifted away from the one actually being sent — X's mute button flipped `enabled` on a stale clone and had no effect on the audio. That toggle is now intercepted and translated into a real broadcast mute: nothing reaches the Space, while your headset monitor and the broadcast-out device (virtual cable) keep running.
- The Mic pane shows a live **X Space mic: live / MUTED** status line so you can tell which of the two mutes is engaged.

### General MIDI instrument catalog
- Full GM instrument catalog via **WebAudioFont**, loaded through a safe parser (no `eval`), with **10 instrument tabs** and a per-tab instrument selector — clicking a kit tab auto-loads its instrument
- **Full chromatic keyboard** for melodic WebAudioFont/SFZ kits, and direct SFZ region lookup replacing the old 16-pad nearest-neighbour stretch, so sampled instruments play correctly across the whole keyboard instead of one octave
- Grouped kit selector (Drums / Keys / Guitar / FX) with real sampled **Acoustic** (FreePats muldjordkit, CC-BY) and **Electric Guitar Clean** (FreePats FSBS, CC0) kits

### Loop Station & piano roll
- Proper DAW-style **1-2-3-4 count-in** on first record, skipped automatically when quantize is off
- **Piano roll** opens from the Loop Station — resizable on both axes, with a quantize button
- Metronome click track, and the pad grid now reads bottom-to-top like a hardware controller
- Wider panel with wrapping tabs

---

## What's new in v1.3.0

Released as a beta series (`v1.3.0-beta.1` … `.3`); these features first shipped in a stable build as part of v1.4.0 above.

This release adds a full **Soundboard + MIDI instrument + Loop Station** rig to the mixer, on top of X Spaces reliability fixes.

### MIDI instrument integration
- Full Web MIDI support — pick your input device and channel in the new **Sounds → MIDI** pane, with a live raw-message monitor so you can confirm hardware is being seen even before anything is mapped
- Learn mode for mapping any pad, and for mapping a hardware Record/Play transport button (e.g. Launchkey-style controllers), with unlearn buttons and auto-cancel so a bad mapping can't get stuck
- Built-in **synth layer** — "Enable synth" routes MIDI notes to an oscillator + filter voice (waveform, attack/decay/sustain/release, filter cutoff/resonance, octave shift, velocity sensitivity) that plays *on top of* whatever pad is mapped to that key, not instead of it
- Fixed piano/guitar/synth-keys pads being silent outside their fixed 16-key range (e.g. using a controller's Octave +/- button) — melodic kits now pitch-shift across the full keyboard instead of only responding to one octave
- Fixed a mis-learn race where a stray pad hit while clicking "Learn" could get captured as the transport mapping, and fixed MIDI keys/pads going silent after a mapping change (MIDI init is now idempotent)

### Soundboard & preset kits
- New 16-pad soundboard with drag-and-drop custom samples per pad, right-click pad editor (name, volume, MIDI note, loop toggle), and a separate movable Pads window
- 7 built-in preset kits, one click to fill all 16 pads: 🥁 Drums, 🔊 808, 📻 Lo-Fi (real recorded drum-machine samples with automatic offline fallback), 🎹 Piano, 🎸 Guitar, 🎛 Synth keys, 🎉 Sound FX (crowd cheer/boo, applause, airhorn, laugh, and more)
- Fixed pads and the synth not being captured in stream/loop recordings — they were previously audible live but silent in anything recorded

### Loop Station (5-track RC-505-style looper)
- Redesigned the transport from one ambiguous multi-function pad into 4 explicit buttons — ● Record, ▶ Play, ❚❚ Stop/Pause, ✕ Clear — so it's always clear what a press will do, per track
- Added quantized recording start: Record/Overdub now snap to the beat grid instead of starting the instant you press the button, with a default of 1/4-bar (one beat) and a per-track dial to pick Off / Auto / 1/4 / 1/8 / 1/16 / 1/32
- Fixed silent/incomplete loop recordings — recording now taps a dedicated bus that bypasses Cue muting so it always captures exactly what's audible, regardless of a channel's monitor-only state
- Fixed a MIDI hardware transport bug where a single Record/Play button press was firing twice (start-then-stop) because CC messages fire on both button-down and button-up
- Per-track bar length + quantize dials, per-track level fader, tap-tempo, and a live fill-ring on the Record button showing progress toward auto-stop

### Autotune / pitch FX
- Real-time pitch shifter and autotune on the mic signal (Sounds → FX pane) — manual semitone shift or auto snap-to-scale/key correction with adjustable correction strength, so your voice (not just pads/synth) can be tuned before it reaches listeners

### X Spaces reliability
- Fixed background X tabs staying pinned at full, unthrottled CPU/GPU forever, which caused the whole app to slow down the longer you had multiple tabs open — only the currently visible tab is now kept unthrottled
- Added crash/hang recovery for X tabs: an unresponsive-page banner with a one-click Reload, and automatic tab recreation if X's renderer crashes, instead of a permanently frozen tab
- Granted MIDI/MIDI-Sysex permissions so hardware controllers work inside X tabs as well as the mixer

### Interface cleanup
- Removed the redundant ✕ close buttons from the Pads and Loop Station popup windows — they already hide automatically when you switch away from the Sounds tab

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
