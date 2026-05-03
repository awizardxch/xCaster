// XCaster in-page overlay.
// Injected by preload into the page's main world via a <script> tag at
// document_start, so this code runs BEFORE x.com's scripts cache a reference
// to navigator.mediaDevices.getUserMedia.
//
// Responsibilities:
//   1) Build a Web Audio processing graph for the mic:
//        source -> HPF -> EQ(low/mid/high) -> Compressor -> Limiter -> Gain
//      and expose the processed stream's track via getUserMedia so X uses it.
//   2) Force AGC/NS/EC OFF on the raw mic capture (browser-side processing).
//   3) Route X's playback (every <audio>/<video>) to a chosen output device
//      via HTMLMediaElement.setSinkId. This is the "speaker mixer" — playback
//      is direct, never mixed into the mic graph, so no feedback path exists.
//   4) Render a settings overlay with tabs: Mic / Speakers / Processing /
//      Presets, with live meters and per-parameter sliders.
//
// Settings persist in localStorage under 'xfw.settings'. Defaults aim at a
// loud, consistent voice signal that gives X's server-side leveler nothing
// to react to.

(function () {
    if (window.__xcInstalled) return;
    window.__xcInstalled = true;

    // ---------- defaults & persistence -------------------------------------
    const STORAGE_KEY = 'xfw.settings';
    const DEFAULTS = {
        // I/O — two independent input channels (mic + aux) summed pre-DSP.
        inputDeviceId: 'default',           // mic
        auxDeviceId: 'none',                // aux source ('none' = disabled)
        outputDeviceId: 'default',          // playback for X
        // Per-channel mixer
        micGainDb: 0,
        micMuted: false,
        auxGainDb: 0,
        auxMuted: false,
        // Browser-side capture toggles. Keep all OFF for a flat signal we
        // process ourselves; flipping them on lets the browser re-process.
        autoGainControl: false,
        noiseSuppression: false,
        echoCancellation: false,
        // Processing chain
        bypass: false,
        hpfHz: 90,
        eqLowDb: 0,
        eqMidDb: 0,
        eqHighDb: 0,
        compThresholdDb: -22,
        compRatio: 4,
        compAttackMs: 8,
        compReleaseMs: 140,
        compKneeDb: 8,
        limThresholdDb: -3,
        limReleaseMs: 60,
        outputGainDb: 6,
        // UI / skin
        bgEnabled: true,
        bgOpacity: 0.9,         // X content opacity (0.3 - 1.0)
        bgTint: 0,              // black tint between video and content (0 - 0.8)
        fabPos: null,           // {x, y} or null = default (bottom-right)
        panelPos: null,         // {x, y} or null = default (anchored to fab)
    };

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
        } catch { return { ...DEFAULTS }; }
    }
    function saveSettings(s) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
    }
    let settings = loadSettings();

    // ---------- audio graph ------------------------------------------------
    // Two input channels (mic, aux) -> per-channel Gain (with mute) -> summing
    // bus -> DSP chain -> MediaStreamDestination handed to X.
    let audioCtx = null;
    let micRawStream = null, auxRawStream = null;
    let micSrcNode = null, auxSrcNode = null;
    let micGainNode = null, auxGainNode = null;
    let mixBus = null;
    let hpf = null, eqLow = null, eqMid = null, eqHigh = null;
    let comp = null, limiter = null, makeup = null;
    let processedDest = null;
    let processedStream = null;
    let inputAnalyser = null;
    let outputAnalyser = null;
    let micAnalyser = null, auxAnalyser = null;

    // Track every AudioContext the page creates so we can rebind their sink
    // when the user changes the speaker selection.
    const __xfwContexts = new Set();

    function applySinkToAudioContext(ctx) {
        if (!ctx) return;
        const id = currentSinkId();
        // Prefer AudioContext.setSinkId (Chromium 110+); fall back silently.
        if (typeof ctx.setSinkId === 'function') {
            try {
                const arg = id === 'default' ? '' : id;
                Promise.resolve(ctx.setSinkId(arg)).catch(err => {
                    console.warn('[XCaster] AudioContext.setSinkId failed', err);
                });
            } catch (err) {
                console.warn('[XCaster] AudioContext.setSinkId threw', err);
            }
        }
    }

    function applySinkToAllContexts() {
        for (const ctx of __xfwContexts) applySinkToAudioContext(ctx);
    }

    // Patch AudioContext so any context the page or our overlay creates is
    // routed to the selected output device. Without this, WebRTC remote
    // audio paths that go through ctx.destination land on system default
    // regardless of any <audio> element's setSinkId — that's the leak that
    // lets your aux/mic pick up X's incoming Space audio.
    (function patchAudioContext() {
        const RealAC = window.AudioContext || window.webkitAudioContext;
        if (!RealAC) return;

        function wrap(Original) {
            function Patched(...args) {
                const c = new Original(...args);
                __xfwContexts.add(c);
                applySinkToAudioContext(c);
                if (typeof c.addEventListener === 'function') {
                    c.addEventListener('statechange', () => {
                        if (c.state === 'closed') __xfwContexts.delete(c);
                    });
                }
                return c;
            }
            Patched.prototype = Original.prototype;
            return Patched;
        }
        if (window.AudioContext) window.AudioContext = wrap(window.AudioContext);
        if (window.webkitAudioContext) window.webkitAudioContext = wrap(window.webkitAudioContext);
    })();

    function ensureAudioContext() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            // Auto-resume whenever Chromium suspends the context (focus loss,
            // device switch, OS audio session change, etc.)
            audioCtx.addEventListener('statechange', () => {
                if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
            });
            // Silent keepalive: a zero-gain ConstantSourceNode keeps the Chromium
            // audio rendering thread scheduled even when the window is minimized.
            // Without it, background CPU throttling starves the DSP callbacks.
            installAudioKeepalive(audioCtx);
        }
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        return audioCtx;
    }

    function installAudioKeepalive(ctx) {
        try {
            const src = ctx.createConstantSource();
            const silence = ctx.createGain();
            silence.gain.value = 0;
            src.connect(silence);
            silence.connect(ctx.destination);
            src.start();
        } catch { /* not critical */ }
    }

    async function acquireDevice(deviceId) {
        // Raw capture for any input. Browser-side AGC/NS/EC reflect toggles.
        const audioConstraints = {
            autoGainControl: !!settings.autoGainControl,
            noiseSuppression: !!settings.noiseSuppression,
            echoCancellation: !!settings.echoCancellation,
        };
        if (deviceId && deviceId !== 'default') {
            audioConstraints.deviceId = { exact: deviceId };
        }
        return __xfwOriginalGUM.call(navigator.mediaDevices, { audio: audioConstraints });
    }

    function buildGraph() {
        const ctx = ensureAudioContext();
        if (!micSrcNode && !auxSrcNode) return;

        // Tear down existing wiring on every node we touch.
        try { micSrcNode && micSrcNode.disconnect(); } catch {}
        try { auxSrcNode && auxSrcNode.disconnect(); } catch {}
        try { micGainNode && micGainNode.disconnect(); } catch {}
        try { auxGainNode && auxGainNode.disconnect(); } catch {}
        try { mixBus && mixBus.disconnect(); } catch {}

        // Per-channel input gains (with mute) and meters.
        micGainNode = ctx.createGain();
        micGainNode.gain.value = settings.micMuted ? 0 : dbToLin(settings.micGainDb);
        auxGainNode = ctx.createGain();
        auxGainNode.gain.value = settings.auxMuted ? 0 : dbToLin(settings.auxGainDb);
        micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 1024;
        auxAnalyser = ctx.createAnalyser(); auxAnalyser.fftSize = 1024;

        // Summing bus where mic + aux meet before the DSP chain.
        mixBus = ctx.createGain();
        mixBus.gain.value = 1;

        if (micSrcNode) {
            micSrcNode.connect(micGainNode);
            micSrcNode.connect(micAnalyser);
            micGainNode.connect(mixBus);
        }
        if (auxSrcNode) {
            auxSrcNode.connect(auxGainNode);
            auxSrcNode.connect(auxAnalyser);
            auxGainNode.connect(mixBus);
        }

        // High-pass filter — kills rumble, AC hum harmonics, breath thumps.
        hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = settings.hpfHz;
        hpf.Q.value = 0.707;

        // 3-band EQ. Low = shelf @120, Mid = peaking @1k, High = shelf @8k.
        eqLow = ctx.createBiquadFilter();
        eqLow.type = 'lowshelf';
        eqLow.frequency.value = 120;
        eqLow.gain.value = settings.eqLowDb;

        eqMid = ctx.createBiquadFilter();
        eqMid.type = 'peaking';
        eqMid.frequency.value = 1000;
        eqMid.Q.value = 0.9;
        eqMid.gain.value = settings.eqMidDb;

        eqHigh = ctx.createBiquadFilter();
        eqHigh.type = 'highshelf';
        eqHigh.frequency.value = 8000;
        eqHigh.gain.value = settings.eqHighDb;

        // Main compressor (musical, voice-friendly).
        comp = ctx.createDynamicsCompressor();
        comp.threshold.value = settings.compThresholdDb;
        comp.ratio.value = settings.compRatio;
        comp.attack.value = settings.compAttackMs / 1000;
        comp.release.value = settings.compReleaseMs / 1000;
        comp.knee.value = settings.compKneeDb;

        // Brick-wall limiter — ratio 20:1, fast attack, short release.
        limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = settings.limThresholdDb;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.001;
        limiter.release.value = settings.limReleaseMs / 1000;
        limiter.knee.value = 0;

        // Output makeup gain.
        makeup = ctx.createGain();
        makeup.gain.value = dbToLin(settings.outputGainDb);

        // Analysers for meters.
        inputAnalyser = ctx.createAnalyser(); inputAnalyser.fftSize = 1024;
        outputAnalyser = ctx.createAnalyser(); outputAnalyser.fftSize = 1024;

        // Destination producing the processed MediaStream we hand to X.
        processedDest = ctx.createMediaStreamDestination();

        if (settings.bypass) {
            mixBus.connect(inputAnalyser);
            mixBus.connect(outputAnalyser);
            mixBus.connect(processedDest);
        } else {
            mixBus.connect(inputAnalyser);
            mixBus
                .connect(hpf)
                .connect(eqLow)
                .connect(eqMid)
                .connect(eqHigh)
                .connect(comp)
                .connect(limiter)
                .connect(makeup);
            makeup.connect(outputAnalyser);
            makeup.connect(processedDest);
        }

        processedStream = processedDest.stream;
    }

    function applyMixerLive() {
        if (micGainNode) micGainNode.gain.value = settings.micMuted ? 0 : dbToLin(settings.micGainDb);
        if (auxGainNode) auxGainNode.gain.value = settings.auxMuted ? 0 : dbToLin(settings.auxGainDb);
    }

    function applySettingsLive() {
        if (!audioCtx) return;
        if (hpf) hpf.frequency.value = settings.hpfHz;
        if (eqLow) eqLow.gain.value = settings.eqLowDb;
        if (eqMid) eqMid.gain.value = settings.eqMidDb;
        if (eqHigh) eqHigh.gain.value = settings.eqHighDb;
        if (comp) {
            comp.threshold.value = settings.compThresholdDb;
            comp.ratio.value = settings.compRatio;
            comp.attack.value = settings.compAttackMs / 1000;
            comp.release.value = settings.compReleaseMs / 1000;
            comp.knee.value = settings.compKneeDb;
        }
        if (limiter) {
            limiter.threshold.value = settings.limThresholdDb;
            limiter.release.value = settings.limReleaseMs / 1000;
        }
        if (makeup) makeup.gain.value = dbToLin(settings.outputGainDb);
    }

    function dbToLin(db) { return Math.pow(10, db / 20); }

    // How long (ms) to wait after a track goes muted before triggering a
    // rebuild. A short silence is normal during device handoff; only rebuild
    // if it persists, which means the OS revoked access or the device vanished.
    const MUTE_GRACE_MS = 2000;

    // Attach mute/ended listeners to every audio track in a stream so that
    // when Windows grabs the device exclusively (another app, audio session
    // change, etc.) and the track goes muted, we auto-recover without the
    // user needing to toggle the device selector.
    function watchStream(stream, rebuildFn) {
        if (!stream) return;
        let pending = false;
        for (const track of stream.getAudioTracks()) {
            let muteTimer = null;
            track.addEventListener('mute', () => {
                if (pending) return;
                muteTimer = setTimeout(() => {
                    muteTimer = null;
                    if (!pending && (track.muted || track.readyState === 'ended')) {
                        pending = true;
                        Promise.resolve(rebuildFn()).finally(() => { pending = false; });
                    }
                }, MUTE_GRACE_MS);
            });
            track.addEventListener('unmute', () => {
                clearTimeout(muteTimer);
                muteTimer = null;
            });
            track.addEventListener('ended', () => {
                clearTimeout(muteTimer);
                muteTimer = null;
                if (!pending) {
                    pending = true;
                    Promise.resolve(rebuildFn()).finally(() => { pending = false; });
                }
            });
        }
    }

    async function ensureProcessedStream() {
        ensureAudioContext();
        if (!micRawStream) {
            try { micRawStream = await acquireDevice(settings.inputDeviceId); }
            catch (err) { console.warn('[XCaster] mic acquire failed', err); }
        }
        if (micRawStream && !micSrcNode) {
            micSrcNode = audioCtx.createMediaStreamSource(micRawStream);
            watchStream(micRawStream, () => rebuildMic());
        }
        if (settings.auxDeviceId && settings.auxDeviceId !== 'none' && !auxRawStream) {
            try { auxRawStream = await acquireDevice(settings.auxDeviceId); }
            catch (err) { console.warn('[XCaster] aux acquire failed', err); }
        }
        if (auxRawStream && !auxSrcNode) {
            auxSrcNode = audioCtx.createMediaStreamSource(auxRawStream);
            watchStream(auxRawStream, () => rebuildAux());
        }
        buildGraph();
        return processedStream;
    }

    async function rebuildMic() {
        try { if (micRawStream) micRawStream.getTracks().forEach(t => t.stop()); } catch {}
        micRawStream = null; micSrcNode = null;
        await ensureProcessedStream();
        replaceTracksOnActivePCs();
    }
    async function rebuildAux() {
        try { if (auxRawStream) auxRawStream.getTracks().forEach(t => t.stop()); } catch {}
        auxRawStream = null; auxSrcNode = null;
        if (!settings.auxDeviceId || settings.auxDeviceId === 'none') {
            // disabled: just rewire graph without aux.
            buildGraph();
            replaceTracksOnActivePCs();
            return;
        }
        await ensureProcessedStream();
        replaceTracksOnActivePCs();
    }
    async function rebuildAfterDeviceChange() {
        try { if (micRawStream) micRawStream.getTracks().forEach(t => t.stop()); } catch {}
        try { if (auxRawStream) auxRawStream.getTracks().forEach(t => t.stop()); } catch {}
        micRawStream = null; micSrcNode = null;
        auxRawStream = null; auxSrcNode = null;
        processedStream = null;
        await ensureProcessedStream();
        replaceTracksOnActivePCs();
    }

    // ---------- getUserMedia interception ----------------------------------
    // Save originals BEFORE anything else can capture references.
    const md = navigator.mediaDevices;
    const __xfwOriginalGUM = md.getUserMedia.bind(md);
    window.__xfwOriginalGUM = __xfwOriginalGUM;

    md.getUserMedia = async function (constraints) {
        try {
            // Only intercept when audio is requested.
            const wantsAudio = constraints && constraints.audio;
            const wantsVideo = constraints && constraints.video;

            if (!wantsAudio) {
                return __xfwOriginalGUM(constraints);
            }

            await ensureProcessedStream();
            const audioTrack = processedStream.getAudioTracks()[0];
            if (!audioTrack) return __xfwOriginalGUM(constraints);

            // If the page also asked for video, fetch just video from original.
            let videoTracks = [];
            if (wantsVideo) {
                const v = await __xfwOriginalGUM({ video: constraints.video });
                videoTracks = v.getVideoTracks();
            }

            const out = new MediaStream();
            out.addTrack(audioTrack.clone()); // clone so multiple gUM callers each get a fresh ref
            for (const t of videoTracks) out.addTrack(t);
            console.info('[XCaster] gUM returned processed stream');
            return out;
        } catch (err) {
            console.warn('[XCaster] gUM error, falling back to raw', err);
            return __xfwOriginalGUM(constraints);
        }
    };

    // Track active peer connections so device-change can swap the sender's track live.
    const __xfwPCs = new Set();
    const RealPC = window.RTCPeerConnection;
    if (RealPC) {
        window.RTCPeerConnection = function (...args) {
            const pc = new RealPC(...args);
            __xfwPCs.add(pc);
            pc.addEventListener('connectionstatechange', () => {
                if (['closed', 'failed'].includes(pc.connectionState)) __xfwPCs.delete(pc);
            });
            return pc;
        };
        window.RTCPeerConnection.prototype = RealPC.prototype;
    }

    function replaceTracksOnActivePCs() {
        if (!processedStream) return;
        const newTrack = processedStream.getAudioTracks()[0];
        if (!newTrack) return;
        for (const pc of __xfwPCs) {
            try {
                for (const sender of pc.getSenders()) {
                    if (sender.track && sender.track.kind === 'audio') {
                        sender.replaceTrack(newTrack.clone());
                    }
                }
            } catch (e) { /* ignore */ }
        }
    }

    // ---------- output (speaker) routing -----------------------------------
    // Apply settings.outputDeviceId to every <audio>/<video> on the page so
    // X's incoming Spaces audio plays out the device the user picks.
    //
    // setSinkId is async, so a naive "watch DOM for new <audio> and call
    // setSinkId" loses the race against autoplay: the element begins playing
    // on the system default for a few hundred ms before our redirect lands,
    // which the user hears as feedback through their speakers.
    //
    // We close that race by:
    //   1) Patching HTMLMediaElement.prototype.play to await setSinkId first.
    //   2) Patching the srcObject setter so attaching a remote MediaStream
    //      triggers setSinkId immediately, before the element transitions
    //      to HAVE_ENOUGH_DATA and starts pushing audio.
    //   3) Patching document.createElement('audio'/'video') and the global
    //      Audio() constructor to register the element the instant it exists.
    //   4) Pausing -> setSinkId -> resume on any element that's already
    //      playing when output device changes.

    const knownMedia = new WeakSet();

    function currentSinkId() { return settings.outputDeviceId || 'default'; }

    async function ensureSink(el) {
        if (!el || typeof el.setSinkId !== 'function') return;
        const id = currentSinkId();
        if (el.__xfwSink === id) return;
        try {
            // Mute briefly during the swap so any pre-redirect samples never
            // hit the system speakers. We restore on completion.
            const wasMuted = el.muted;
            el.muted = true;
            await el.setSinkId(id);
            el.__xfwSink = id;
            el.muted = wasMuted;
        } catch (err) {
            console.warn('[XCaster] setSinkId failed', err);
        }
    }

    function registerMedia(el) {
        if (!el || knownMedia.has(el)) return;
        knownMedia.add(el);
        // Apply sink immediately. If element isn't yet allowed to call
        // setSinkId (no source), this just no-ops; play() override handles it.
        ensureSink(el);
    }

    function applySinkToAll() {
        document.querySelectorAll('audio, video').forEach(el => {
            // Pause -> setSinkId -> resume so a running element doesn't keep
            // bleeding to the previous (or default) device during the swap.
            const wasPlaying = !el.paused && !el.ended;
            const swap = async () => {
                try { if (wasPlaying) el.pause(); } catch {}
                await ensureSink(el);
                try { if (wasPlaying) await el.play(); } catch {}
            };
            swap();
            registerMedia(el);
        });
    }

    // (1) Wrap play() so it awaits sink redirection before starting.
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        registerMedia(this);
        const id = currentSinkId();
        if (typeof this.setSinkId === 'function' && this.__xfwSink !== id) {
            return this.setSinkId(id)
                .then(() => { this.__xfwSink = id; })
                .catch(() => {})
                .then(() => origPlay.call(this));
        }
        return origPlay.call(this);
    };

    // (2) Trigger sink application the moment a stream is attached.
    const srcObjectDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    if (srcObjectDesc && srcObjectDesc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
            configurable: true,
            enumerable: srcObjectDesc.enumerable,
            get: srcObjectDesc.get,
            set: function (val) {
                srcObjectDesc.set.call(this, val);
                registerMedia(this);
                ensureSink(this);
            },
        });
    }

    // (3) Catch elements created via createElement and the Audio() constructor.
    const origCreate = Document.prototype.createElement;
    Document.prototype.createElement = function (name, ...rest) {
        const el = origCreate.call(this, name, ...rest);
        if (typeof name === 'string' && /^(audio|video)$/i.test(name)) {
            registerMedia(el);
        }
        return el;
    };
    if (typeof window.Audio === 'function') {
        const RealAudio = window.Audio;
        window.Audio = function (...args) {
            const el = new RealAudio(...args);
            registerMedia(el);
            return el;
        };
        window.Audio.prototype = RealAudio.prototype;
    }

    const mediaObserver = new MutationObserver(muts => {
        for (const m of muts) {
            for (const node of m.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO') registerMedia(node);
                node.querySelectorAll && node.querySelectorAll('audio, video').forEach(registerMedia);
            }
        }
    });

    function startMediaObserver() {
        if (!document.body) { requestAnimationFrame(startMediaObserver); return; }
        mediaObserver.observe(document.documentElement, { childList: true, subtree: true });
        document.querySelectorAll('audio, video').forEach(registerMedia);
    }
    startMediaObserver();

    // ---------- overlay UI -------------------------------------------------
    function el(html) {
        const t = document.createElement('template');
        t.innerHTML = html.trim();
        return t.content.firstElementChild;
    }

    function buildUI() {
        const root = document.createElement('div');
        root.id = 'xfw-root';
        root.innerHTML = `
        <button id="xfw-fab" title="XCaster audio (Ctrl+,)">⚙</button>
        <div id="xfw-panel" role="dialog" aria-label="XCaster audio">
            <div class="xfw-header">
                <div class="xfw-title">XCaster</div>
                <div class="xfw-version">v0.4.1</div>
            </div>

            <div class="xfw-tabs">
                <button class="xfw-tab xfw-active" data-pane="mic">Mic</button>
                <button class="xfw-tab" data-pane="aux">Aux</button>
                <button class="xfw-tab" data-pane="spk">Speakers</button>
                <button class="xfw-tab" data-pane="dsp">Processing</button>
                <button class="xfw-tab" data-pane="pre">Presets</button>
                <button class="xfw-tab" data-pane="skin">Skin</button>
            </div>

            <!-- MIC PANE -->
            <div class="xfw-pane xfw-active" data-pane="mic">
                <div class="xfw-section">
                    <label class="xfw-label" for="xfw-input">Mic device</label>
                    <select id="xfw-input" class="xfw-select"></select>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Mic channel</label>
                    <div class="xfw-row">
                        <div>Mute mic<span class="xfw-help">Silence the mic channel without disabling the device.</span></div>
                        <div class="xfw-toggle" data-key="micMuted"></div>
                    </div>
                    <div class="xfw-slider-row" data-slider="micGainDb" data-min="-40" data-max="18" data-step="0.5" data-suffix=" dB" data-label="Mic level"></div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Browser capture (off = clean signal)</label>
                    <div class="xfw-row">
                        <div>Auto Gain Control<span class="xfw-help">Browser AGC. Keep OFF — we do compression instead.</span></div>
                        <div class="xfw-toggle" data-key="autoGainControl"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Noise Suppression<span class="xfw-help">Browser denoiser. OFF for music, ON if very noisy room.</span></div>
                        <div class="xfw-toggle" data-key="noiseSuppression"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Echo Cancellation<span class="xfw-help">Only useful with speakers + open mic. Usually OFF.</span></div>
                        <div class="xfw-toggle" data-key="echoCancellation"></div>
                    </div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Live levels</label>
                    <div class="xfw-meters">
                        <div class="xfw-meter-row"><div class="xfw-meter-label">Mic</div><div class="xfw-meter"><div id="xfw-meter-mic" class="xfw-meter-fill"></div></div></div>
                        <div class="xfw-meter-row"><div class="xfw-meter-label">Aux</div><div class="xfw-meter"><div id="xfw-meter-aux" class="xfw-meter-fill"></div></div></div>
                        <div class="xfw-meter-row"><div class="xfw-meter-label">Mix</div><div class="xfw-meter"><div id="xfw-meter-in" class="xfw-meter-fill"></div></div></div>
                        <div class="xfw-meter-row"><div class="xfw-meter-label">Out</div><div class="xfw-meter"><div id="xfw-meter-out" class="xfw-meter-fill"></div></div></div>
                        <div class="xfw-meter-row"><div class="xfw-meter-label">GR</div><div class="xfw-meter"><div id="xfw-meter-gr" class="xfw-gr-meter-fill"></div></div></div>
                    </div>
                </div>
            </div>

            <!-- AUX PANE -->
            <div class="xfw-pane" data-pane="aux">
                <div class="xfw-section">
                    <label class="xfw-label" for="xfw-aux">Aux device (mix into X alongside mic)</label>
                    <select id="xfw-aux" class="xfw-select"></select>
                    <div class="xfw-help" style="margin-top:6px;color:var(--xfw-muted);font-size:11px;">
                        Pick a virtual cable, line-in, or any second capture device to mix audio (music, soundboard, browser tab via VB-CABLE) into your X transmission. Set to <b>None</b> to disable.
                    </div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Aux channel</label>
                    <div class="xfw-row">
                        <div>Mute aux<span class="xfw-help">Silence the aux channel without disabling the device.</span></div>
                        <div class="xfw-toggle" data-key="auxMuted"></div>
                    </div>
                    <div class="xfw-slider-row" data-slider="auxGainDb" data-min="-40" data-max="18" data-step="0.5" data-suffix=" dB" data-label="Aux level"></div>
                </div>
            </div>

            <!-- SPEAKERS PANE -->
            <div class="xfw-pane" data-pane="spk">
                <div class="xfw-section">
                    <label class="xfw-label" for="xfw-output">Output device (where X plays into your ears)</label>
                    <select id="xfw-output" class="xfw-select"></select>
                    <div class="xfw-help" style="margin-top:6px;color:var(--xfw-muted);font-size:11px;">
                        X's incoming Spaces audio plays directly to this device. The mic graph never receives this audio, so there is no feedback loop into what you transmit.
                    </div>
                </div>
            </div>

            <!-- DSP PANE -->
            <div class="xfw-pane" data-pane="dsp">
                <div class="xfw-section">
                    <div class="xfw-row">
                        <div>Bypass all processing<span class="xfw-help">Send raw mic to X. Disables compressor/limiter/EQ.</span></div>
                        <div class="xfw-toggle" data-key="bypass"></div>
                    </div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">High-pass filter</label>
                    <div class="xfw-slider-row" data-slider="hpfHz" data-min="20" data-max="300" data-step="5" data-suffix=" Hz"></div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">EQ</label>
                    <div class="xfw-slider-row" data-slider="eqLowDb" data-min="-12" data-max="12" data-step="0.5" data-suffix=" dB" data-label="Low (120 Hz shelf)"></div>
                    <div class="xfw-slider-row" data-slider="eqMidDb" data-min="-12" data-max="12" data-step="0.5" data-suffix=" dB" data-label="Mid (1 kHz)"></div>
                    <div class="xfw-slider-row" data-slider="eqHighDb" data-min="-12" data-max="12" data-step="0.5" data-suffix=" dB" data-label="High (8 kHz shelf)"></div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Compressor</label>
                    <div class="xfw-slider-row" data-slider="compThresholdDb" data-min="-60" data-max="0" data-step="0.5" data-suffix=" dB" data-label="Threshold"></div>
                    <div class="xfw-slider-row" data-slider="compRatio" data-min="1" data-max="20" data-step="0.1" data-suffix=":1" data-label="Ratio"></div>
                    <div class="xfw-slider-row" data-slider="compAttackMs" data-min="0" data-max="200" data-step="1" data-suffix=" ms" data-label="Attack"></div>
                    <div class="xfw-slider-row" data-slider="compReleaseMs" data-min="20" data-max="600" data-step="5" data-suffix=" ms" data-label="Release"></div>
                    <div class="xfw-slider-row" data-slider="compKneeDb" data-min="0" data-max="40" data-step="1" data-suffix=" dB" data-label="Knee"></div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Limiter</label>
                    <div class="xfw-slider-row" data-slider="limThresholdDb" data-min="-12" data-max="-0.5" data-step="0.1" data-suffix=" dB" data-label="Ceiling"></div>
                    <div class="xfw-slider-row" data-slider="limReleaseMs" data-min="10" data-max="300" data-step="5" data-suffix=" ms" data-label="Release"></div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Output</label>
                    <div class="xfw-slider-row" data-slider="outputGainDb" data-min="-12" data-max="18" data-step="0.5" data-suffix=" dB" data-label="Makeup gain"></div>
                </div>
            </div>

            <!-- PRESETS PANE -->
            <div class="xfw-pane" data-pane="pre">
                <div class="xfw-section">
                    <label class="xfw-label">Voice presets for X Spaces</label>
                    <div class="xfw-presets">
                        <button class="xfw-preset" data-preset="spaces"><b>Spaces (loud + steady)</b><span>Heavy comp, hard limit. Defeats X auto-leveling.</span></button>
                        <button class="xfw-preset" data-preset="podcast"><b>Podcast voice</b><span>Warm, light comp, slight presence boost.</span></button>
                        <button class="xfw-preset" data-preset="music"><b>Music / interface</b><span>Minimal processing, headroom preserved.</span></button>
                        <button class="xfw-preset" data-preset="off"><b>Off (raw)</b><span>Bypass entire chain. Mic goes straight in.</span></button>
                    </div>
                </div>
            </div>

            <!-- SKIN PANE -->
            <div class="xfw-pane" data-pane="skin">
                <div class="xfw-section">
                    <div class="xfw-row">
                        <div>Background video<span class="xfw-help">Play background.mp4 behind the X content.</span></div>
                        <div class="xfw-toggle" data-key="bgEnabled"></div>
                    </div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Content opacity</label>
                    <div class="xfw-slider-row" data-slider="bgOpacity" data-min="0.3" data-max="1" data-step="0.01" data-suffix="" data-label="X content opacity"></div>
                    <div class="xfw-slider-row" data-slider="bgTint" data-min="0" data-max="0.8" data-step="0.01" data-suffix="" data-label="Background dim"></div>
                </div>
                <div class="xfw-section">
                    <div class="xfw-buttons">
                        <button id="xfw-reset-positions" class="xfw-btn">Reset gear &amp; panel position</button>
                    </div>
                    <div class="xfw-help" style="margin-top:6px;color:var(--xfw-muted);font-size:11px;">
                        Drag the gear button anywhere on screen. Drag the panel by its title bar. Positions persist between launches.
                    </div>
                </div>
            </div>

            <div class="xfw-buttons">
                <button id="xfw-rebuild" class="xfw-btn">Reapply audio graph</button>
                <button id="xfw-reload" class="xfw-btn xfw-primary">Reload page</button>
            </div>

            <div class="xfw-status" id="xfw-status">
                <span class="xfw-dot"></span>Audio engine ready.
            </div>
        </div>`;
        document.documentElement.appendChild(root);
        return root;
    }

    function paintToggles() {
        document.querySelectorAll('#xfw-panel .xfw-toggle').forEach(t => {
            const k = t.getAttribute('data-key');
            t.classList.toggle('xfw-on', !!settings[k]);
        });
    }

    function buildSliders() {
        document.querySelectorAll('#xfw-panel [data-slider]').forEach(row => {
            if (row.__xfwBuilt) return;
            row.__xfwBuilt = true;
            const key = row.getAttribute('data-slider');
            const min = +row.getAttribute('data-min');
            const max = +row.getAttribute('data-max');
            const step = +row.getAttribute('data-step');
            const suffix = row.getAttribute('data-suffix') || '';
            const label = row.getAttribute('data-label') || key;
            row.innerHTML = `
                <div class="xfw-slider-head"><span>${label}</span><span class="xfw-val"></span></div>
                <input type="range" class="xfw-slider" min="${min}" max="${max}" step="${step}" />`;
            const input = row.querySelector('input');
            const valSpan = row.querySelector('.xfw-val');
            input.value = settings[key];
            valSpan.textContent = formatVal(settings[key], suffix);
            input.addEventListener('input', () => {
                settings[key] = +input.value;
                valSpan.textContent = formatVal(settings[key], suffix);
                saveSettings(settings);
                if (key === 'micGainDb' || key === 'auxGainDb') applyMixerLive();
                else applySettingsLive();
            });
        });
    }
    function formatVal(v, suffix) {
        const n = Math.round(v * 10) / 10;
        return `${n}${suffix}`;
    }

    async function populateInputs() {
        const sel = document.getElementById('xfw-input');
        if (!sel) return;
        sel.innerHTML = '';
        try {
            const probe = await __xfwOriginalGUM.call(navigator.mediaDevices, { audio: true });
            probe.getTracks().forEach(t => t.stop());
        } catch {}
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
        const opts = [{ deviceId: 'default', label: 'System default' }, ...devs];
        for (const d of opts) {
            const o = document.createElement('option');
            o.value = d.deviceId || 'default';
            o.textContent = d.label || `Microphone (${(d.deviceId || '').slice(0, 6)})`;
            sel.appendChild(o);
        }
        sel.value = settings.inputDeviceId || 'default';

        // Aux dropdown reuses the same input list, plus a 'None' entry.
        const auxSel = document.getElementById('xfw-aux');
        if (auxSel) {
            auxSel.innerHTML = '';
            const auxOpts = [{ deviceId: 'none', label: 'None (mic only)' }, ...devs];
            for (const d of auxOpts) {
                const o = document.createElement('option');
                o.value = d.deviceId || 'none';
                o.textContent = d.label || `Device (${(d.deviceId || '').slice(0, 6)})`;
                auxSel.appendChild(o);
            }
            auxSel.value = settings.auxDeviceId || 'none';
        }
    }
    async function populateOutputs() {
        const sel = document.getElementById('xfw-output');
        if (!sel) return;
        sel.innerHTML = '';
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
        const opts = [{ deviceId: 'default', label: 'System default' }, ...devs];
        for (const d of opts) {
            const o = document.createElement('option');
            o.value = d.deviceId || 'default';
            o.textContent = d.label || `Output (${(d.deviceId || '').slice(0, 6)})`;
            sel.appendChild(o);
        }
        sel.value = settings.outputDeviceId || 'default';
    }

    // ---------- presets ----------------------------------------------------
    const PRESETS = {
        spaces: {
            bypass: false,
            hpfHz: 100, eqLowDb: -1, eqMidDb: 1.5, eqHighDb: 2,
            compThresholdDb: -24, compRatio: 6, compAttackMs: 5, compReleaseMs: 120, compKneeDb: 10,
            limThresholdDb: -2, limReleaseMs: 50, outputGainDb: 9,
        },
        podcast: {
            bypass: false,
            hpfHz: 80, eqLowDb: 1, eqMidDb: 0.5, eqHighDb: 1.5,
            compThresholdDb: -20, compRatio: 3, compAttackMs: 10, compReleaseMs: 180, compKneeDb: 8,
            limThresholdDb: -3, limReleaseMs: 80, outputGainDb: 5,
        },
        music: {
            bypass: false,
            hpfHz: 30, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0,
            compThresholdDb: -16, compRatio: 2, compAttackMs: 20, compReleaseMs: 250, compKneeDb: 6,
            limThresholdDb: -1, limReleaseMs: 100, outputGainDb: 0,
        },
        off: {
            bypass: true,
        },
    };
    function applyPreset(name) {
        const p = PRESETS[name];
        if (!p) return;
        Object.assign(settings, p);
        saveSettings(settings);
        // Rebuild graph because bypass route changes connectivity.
        buildGraph();
        replaceTracksOnActivePCs();
        // Refresh UI.
        document.querySelectorAll('#xfw-panel [data-slider]').forEach(row => {
            const key = row.getAttribute('data-slider');
            const input = row.querySelector('input');
            const val = row.querySelector('.xfw-val');
            const suffix = row.getAttribute('data-suffix') || '';
            if (input && key in settings) {
                input.value = settings[key];
                val.textContent = formatVal(settings[key], suffix);
            }
        });
        paintToggles();
    }

    // ---------- meters -----------------------------------------------------
    let meterRaf = 0;
    function startMeters() {
        cancelAnimationFrame(meterRaf);
        const inFill = document.getElementById('xfw-meter-in');
        const outFill = document.getElementById('xfw-meter-out');
        const grFill = document.getElementById('xfw-meter-gr');
        const micFill = document.getElementById('xfw-meter-mic');
        const auxFill = document.getElementById('xfw-meter-aux');
        const inBuf = inputAnalyser ? new Uint8Array(inputAnalyser.fftSize) : null;
        const outBuf = outputAnalyser ? new Uint8Array(outputAnalyser.fftSize) : null;
        const micBuf = micAnalyser ? new Uint8Array(micAnalyser.fftSize) : null;
        const auxBuf = auxAnalyser ? new Uint8Array(auxAnalyser.fftSize) : null;
        const tick = () => {
            if (micAnalyser && micFill && micBuf) {
                micAnalyser.getByteTimeDomainData(micBuf);
                micFill.style.width = peakPct(micBuf);
            } else if (micFill) { micFill.style.width = '0%'; }
            if (auxAnalyser && auxFill && auxBuf) {
                auxAnalyser.getByteTimeDomainData(auxBuf);
                auxFill.style.width = peakPct(auxBuf);
            } else if (auxFill) { auxFill.style.width = '0%'; }
            if (inputAnalyser && inFill && inBuf) {
                inputAnalyser.getByteTimeDomainData(inBuf);
                inFill.style.width = peakPct(inBuf);
            }
            if (outputAnalyser && outFill && outBuf) {
                outputAnalyser.getByteTimeDomainData(outBuf);
                outFill.style.width = peakPct(outBuf);
            }
            if (grFill && comp) {
                const r = comp.reduction || 0;
                grFill.style.width = Math.min(100, Math.max(0, -r * 5)) + '%';
            }
            meterRaf = requestAnimationFrame(tick);
        };
        tick();
    }
    function stopMeters() { cancelAnimationFrame(meterRaf); meterRaf = 0; }
    function peakPct(buf) {
        let p = 0;
        for (let i = 0; i < buf.length; i++) {
            const v = Math.abs(buf[i] - 128) / 128;
            if (v > p) p = v;
        }
        return Math.min(100, p * 140) + '%';
    }

    // ---------- wire UI ----------------------------------------------------
    function wire() {
        const fab = document.getElementById('xfw-fab');
        const panel = document.getElementById('xfw-panel');

        fab.addEventListener('click', async () => {
            const opening = !panel.classList.contains('xfw-open');
            panel.classList.toggle('xfw-open', opening);
            if (opening) {
                buildSliders();
                paintToggles();
                await populateInputs();
                await populateOutputs();
                await ensureProcessedStream();
                startMeters();
            } else {
                stopMeters();
            }
        });

        window.addEventListener('keydown', e => {
            if (e.ctrlKey && e.key === ',') { e.preventDefault(); fab.click(); }
        });

        // tabs
        panel.querySelectorAll('.xfw-tab').forEach(t => {
            t.addEventListener('click', () => {
                panel.querySelectorAll('.xfw-tab').forEach(x => x.classList.remove('xfw-active'));
                panel.querySelectorAll('.xfw-pane').forEach(x => x.classList.remove('xfw-active'));
                t.classList.add('xfw-active');
                panel.querySelector(`.xfw-pane[data-pane="${t.getAttribute('data-pane')}"]`).classList.add('xfw-active');
            });
        });

        // toggles
        panel.addEventListener('click', e => {
            const t = e.target.closest('.xfw-toggle');
            if (!t || !panel.contains(t)) return;
            const key = t.getAttribute('data-key');
            settings[key] = !settings[key];
            saveSettings(settings);
            paintToggles();
            // bypass changes graph wiring
            if (key === 'bypass') { buildGraph(); replaceTracksOnActivePCs(); }
            // mute toggles update the per-channel gain live
            if (key === 'micMuted' || key === 'auxMuted') applyMixerLive();
            // browser-side capture toggles need a fresh raw stream
            if (['autoGainControl', 'noiseSuppression', 'echoCancellation'].includes(key)) {
                rebuildAfterDeviceChange();
            }
        });

        // device pickers
        document.getElementById('xfw-input').addEventListener('change', async e => {
            settings.inputDeviceId = e.target.value;
            saveSettings(settings);
            await rebuildMic();
            startMeters();
        });
        const auxSelEl = document.getElementById('xfw-aux');
        if (auxSelEl) {
            auxSelEl.addEventListener('change', async e => {
                settings.auxDeviceId = e.target.value;
                saveSettings(settings);
                await rebuildAux();
                startMeters();
            });
        }
        document.getElementById('xfw-output').addEventListener('change', e => {
            settings.outputDeviceId = e.target.value;
            saveSettings(settings);
            applySinkToAll();
            applySinkToAllContexts();
        });

        // presets
        panel.querySelectorAll('.xfw-preset').forEach(b => {
            b.addEventListener('click', () => applyPreset(b.getAttribute('data-preset')));
        });

        // bottom buttons
        document.getElementById('xfw-rebuild').addEventListener('click', async () => {
            await rebuildAfterDeviceChange();
            startMeters();
        });
        document.getElementById('xfw-reload').addEventListener('click', () => location.reload());

        navigator.mediaDevices.addEventListener?.('devicechange', () => {
            populateInputs(); populateOutputs();
        });

        // skin reset button
        const resetBtn = document.getElementById('xfw-reset-positions');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                settings.fabPos = null;
                settings.panelPos = null;
                saveSettings(settings);
                applyFabPos();
                applyPanelPos();
            });
        }

        // sliders that affect skin in real time
        panel.addEventListener('input', (e) => {
            const row = e.target.closest && e.target.closest('[data-slider]');
            if (!row) return;
            const key = row.getAttribute('data-slider');
            if (key === 'bgOpacity' || key === 'bgTint') applySkin();
        });

        // bg toggle is handled in the generic toggle handler — re-apply skin
        panel.addEventListener('click', (e) => {
            const t = e.target.closest && e.target.closest('.xfw-toggle');
            if (t && t.getAttribute('data-key') === 'bgEnabled') applySkin();
        });

        // Drag: gear button (anywhere on the button) — panel follows with same delta
        installDrag(fab, {
            getPos: () => settings.fabPos,
            setPos: (p) => { settings.fabPos = p; saveSettings(settings); applyFabPos(); },
            apply: applyFabPos,
            target: fab,
            // suppress the click that follows a drag
            clickEl: fab,
            coMove: {
                getOrigin: () => {
                    const r = panel.getBoundingClientRect();
                    return { x: r.left, y: r.top };
                },
                setPos: (p) => { settings.panelPos = p; saveSettings(settings); applyPanelPos(); },
            },
        });

        // Drag: panel by header
        const header = panel.querySelector('.xfw-header');
        installDrag(header, {
            getPos: () => settings.panelPos,
            setPos: (p) => { settings.panelPos = p; saveSettings(settings); applyPanelPos(); },
            apply: applyPanelPos,
            target: panel,
        });
    }

    // ---------- background skin -------------------------------------------
    function installBackground() {
        if (document.getElementById('xfw-bg')) return;
        const tint = document.createElement('div');
        tint.id = 'xfw-bg-tint';
        const vid = document.createElement('video');
        vid.id = 'xfw-bg';
        vid.src = 'xfw://local/background.mp4';
        vid.autoplay = true;
        vid.loop = true;
        vid.muted = true;
        vid.defaultMuted = true;
        vid.playsInline = true;
        vid.setAttribute('disableremoteplayback', '');
        // Insert at the very top of <html> so it sits behind everything.
        document.documentElement.insertBefore(tint, document.documentElement.firstChild);
        document.documentElement.insertBefore(vid, document.documentElement.firstChild);
        // Browsers may pause the muted autoplay if the page hasn't been interacted
        // with yet; try to kick it.
        const tryPlay = () => { vid.play?.().catch(() => {}); };
        tryPlay();
        document.addEventListener('visibilitychange', tryPlay);
        window.addEventListener('focus', tryPlay);
    }

    function applySkin() {
        const html = document.documentElement;
        const on = !!settings.bgEnabled;
        html.classList.toggle('xfw-skin-on', on);
        const vid = document.getElementById('xfw-bg');
        const tint = document.getElementById('xfw-bg-tint');
        if (vid) vid.style.display = on ? '' : 'none';
        if (tint) {
            tint.style.display = on ? '' : 'none';
            const t = Math.max(0, Math.min(0.95, Number(settings.bgTint) || 0));
            tint.style.background = `rgba(0,0,0,${t})`;
        }
        const op = Math.max(0.1, Math.min(1, Number(settings.bgOpacity) || 1));
        html.style.setProperty('--xfw-content-opacity', String(op));
    }

    // ---------- drag (FAB + panel) ----------------------------------------
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function applyFabPos() {
        const fab = document.getElementById('xfw-fab');
        if (!fab) return;
        const p = settings.fabPos;
        if (!p) {
            fab.style.left = '';
            fab.style.top = '';
            fab.style.right = '';
            fab.style.bottom = '';
            return;
        }
        const w = fab.offsetWidth || 46;
        const h = fab.offsetHeight || 46;
        fab.style.left = clamp(p.x, 0, window.innerWidth - w) + 'px';
        fab.style.top = clamp(p.y, 0, window.innerHeight - h) + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    }

    function applyPanelPos() {
        const panel = document.getElementById('xfw-panel');
        if (!panel) return;
        const p = settings.panelPos;
        if (!p) {
            panel.style.left = '';
            panel.style.top = '';
            panel.style.right = '';
            panel.style.bottom = '';
            return;
        }
        const w = panel.offsetWidth || 400;
        const h = panel.offsetHeight || 300;
        panel.style.left = clamp(p.x, 0, window.innerWidth - Math.min(w, window.innerWidth)) + 'px';
        panel.style.top = clamp(p.y, 0, window.innerHeight - Math.min(h, window.innerHeight)) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }

    function installDrag(handle, opts) {
        let startX = 0, startY = 0;
        let originLeft = 0, originTop = 0;
        let dragging = false;
        let moved = false;
        const THRESH = 4;

        let coOrigin = null;

        const onDown = (e) => {
            // Only primary button / touch
            if (e.button !== undefined && e.button !== 0) return;
            const target = opts.target;
            const rect = target.getBoundingClientRect();
            originLeft = rect.left;
            originTop = rect.top;
            startX = e.clientX;
            startY = e.clientY;
            dragging = true;
            moved = false;
            coOrigin = opts.coMove ? opts.coMove.getOrigin() : null;
            target.classList.add('xfw-dragging');
            window.addEventListener('mousemove', onMove, true);
            window.addEventListener('mouseup', onUp, true);
        };
        const onMove = (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!moved && Math.hypot(dx, dy) < THRESH) return;
            moved = true;
            opts.setPos({ x: originLeft + dx, y: originTop + dy });
            if (coOrigin && opts.coMove) {
                opts.coMove.setPos({ x: coOrigin.x + dx, y: coOrigin.y + dy });
            }
            e.preventDefault();
            e.stopPropagation();
        };
        const onUp = (e) => {
            if (!dragging) return;
            dragging = false;
            opts.target.classList.remove('xfw-dragging');
            window.removeEventListener('mousemove', onMove, true);
            window.removeEventListener('mouseup', onUp, true);
            if (moved) {
                // Swallow the click that browsers fire after a drag.
                if (opts.clickEl) {
                    const swallow = (ev) => {
                        ev.stopPropagation();
                        ev.preventDefault();
                        opts.clickEl.removeEventListener('click', swallow, true);
                    };
                    opts.clickEl.addEventListener('click', swallow, true);
                }
                e.preventDefault();
                e.stopPropagation();
            }
        };
        handle.addEventListener('mousedown', onDown);

        // Re-clamp on window resize
        window.addEventListener('resize', () => opts.apply && opts.apply());
    }

    // ---------- resilience: focus/visibility/periodic watchdog ---------------
    // Resume AudioContext whenever the page regains visibility or focus.
    // Chromium can suspend it on hide even with disable-background-media-suspend
    // applied at the process level, because the policy can be re-applied by the
    // page visibility API inside the renderer.
    document.addEventListener('visibilitychange', () => {
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    });
    window.addEventListener('focus', () => {
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    });

    // Periodic health check catches state drift that event listeners miss
    // (some virtual cable drivers on Windows don't fire 'ended' reliably).
    function startHealthWatchdog() {
        setInterval(() => {
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            if (micRawStream) {
                const t = micRawStream.getAudioTracks()[0];
                if (t && t.readyState === 'ended') rebuildMic();
            }
            if (auxRawStream && settings.auxDeviceId && settings.auxDeviceId !== 'none') {
                const t = auxRawStream.getAudioTracks()[0];
                if (t && t.readyState === 'ended') rebuildAux();
            }
        }, 4000);
    }

    function install() {
        if (!document.body) { requestAnimationFrame(install); return; }
        installBackground();
        buildUI();
        applySkin();
        applyFabPos();
        applyPanelPos();
        wire();
        startHealthWatchdog();
    }
    install();
})();
