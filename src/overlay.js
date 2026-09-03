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
    const STORAGE_KEY = 'xfw.settings.v4';
    const DEFAULTS = {
        // I/O — three independent input channels (mic + aux1 + aux2) summed pre-DSP.
        inputDeviceId: 'default',           // mic (headset)
        auxDeviceId: 'none',                // aux 1 — desktop audio
        aux2DeviceId: 'none',               // aux 2 — external receiver/mixer
        outputDeviceId: 'default',          // playback / monitor (headset)
        broadcastDeviceId: 'none',          // broadcast out — route full mix here (e.g. virtual cable input)
        // Per-channel mixer
        micGainDb: 0,
        micMuted: false,
        auxGainDb: 0,
        auxMuted: false,
        aux2GainDb: 0,
        aux2Muted: false,
        // xCaster channel — captures audio from another in-app tab via
        // getDisplayMedia. Stream is acquired on demand (not from a device id).
        xcastEnabled: false,
        xcastSourceLabel: '',
        xcastGainDb: 0,
        xcastMuted: false,
        xcastMonitor: true,
        xcastCue: false,
        // Browser-side capture toggles — independent per input channel.
        // Keep all OFF for a flat signal we process ourselves.
        micAutoGainControl: false,
        micNoiseSuppression: false,
        micEchoCancellation: false,
        auxAutoGainControl: false,
        auxNoiseSuppression: false,
        auxEchoCancellation: false,
        aux2AutoGainControl: false,
        aux2NoiseSuppression: false,
        aux2EchoCancellation: false,
        // Per-channel headset monitor (route channel to your headphones).
        // Mic monitor defaults OFF to avoid latency/feedback in your ear.
        micMonitor: false,
        auxMonitor: true,
        aux2Monitor: true,
        // Cue (PFL) — routes channel ONLY to monitor, not to broadcast mix.
        // Used to preload/audition audio without sending it to the Space.
        micCue: false,
        auxCue: false,
        aux2Cue: false,
        // Processing chain
        bypass: false,
        hpfHz: 30,
        eqLowDb: 0,
        eqMidDb: 0,
        eqHighDb: 0,
        compThresholdDb: -16,
        compRatio: 2,
        compAttackMs: 20,
        compReleaseMs: 250,
        compKneeDb: 6,
        limThresholdDb: -1,
        limReleaseMs: 100,
        outputGainDb: 1,
        // UI / skin
        bgEnabled: true,
        bgOpacity: 0.9,         // X content opacity (0.3 - 1.0)
        bgTint: 0,              // black tint between video and content (0 - 0.8)
        fabPos: null,           // {x, y} or null = default (bottom-right)
        panelPos: null,         // {x, y} or null = default (anchored to fab)
        padsPopupPos: null,     // {x, y} or null = default position
        loopPopupPos: null,     // {x, y} or null = default position
        padsPopupOpen: true,    // whether the Pads window should auto-show with the Sounds tab
        loopPopupOpen: true,    // whether the Looper window should auto-show with the Sounds tab
        pianoRollPopupPos: null,     // {x, y} or null = default position
        pianoRollPopupOpen: false,   // Piano Roll starts hidden — opt-in via its own show button
        pianoRollRowH: 18,           // px per note row — "expand"/zoom control, taller = easier to read
        pianoRollTrack: 'live',      // 'live' (rolling view of whatever's being played) | 0-4 (a loop track's recorded notes)
        // FX / Autotune
        autotuneEnabled: false,
        pitchShiftSemitones: 0, // -12 to +12
        autotuneAuto: false,    // false = manual shift, true = snap-to-scale
        autotuneKey: 0,         // 0=C, 1=C#, 2=D … 11=B
        autotuneStrength: 1.0,  // 0–1 how hard to correct
        // Soundboard channel
        sbGainDb: 0, sbMuted: false, sbMonitor: true, sbCue: false,
        sbPads: null,           // array of 16 pad configs — initialised post-load
        // Synthesizer (MIDI keyboard)
        synthEnabled: false, synthWave: 'sawtooth',
        synthAttackMs: 10, synthDecayMs: 80, synthSustain: 0.7, synthReleaseMs: 200,
        synthFilterHz: 8000, synthFilterQ: 1.5, synthGainDb: -6, synthOctave: 0,
        midiVelocitySensitive: true,
        // MIDI routing
        midiDeviceId: 'all', midiChannel: 0,
        midiRecordMap: null,    // {type:'note'|'cc', number} — hardware Record button (e.g. Launchkey)
        midiPlayMap: null,      // {type:'note'|'cc', number} — hardware Play button
        // Looper — RC-505-style 5-track Loop Station
        loopGainDb: 0,                          // master looper output level
        loopBpm: 120,                            // shared tempo; drives auto-loop bar length + tap tempo
        loopBars: [16, 16, 16, 16, 16],          // per-track auto-loop length in bars; null/0 = Manual
        loopTrackGainDb: [0, 0, 0, 0, 0],        // per-track level (like the RC-505's 5 track faders)
        loopQuantize: ['auto', 'auto', 'auto', 'auto', 'auto'], // per-track record/overdub start snap: 'off' | 'auto' (=1/4) | 4|8|16|32 (snap to 1/N of a bar)
        metronomeEnabled: false, // click track — monitor-only, wired directly to monitorDest so it's NEVER recorded/broadcast
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
    // Ensure sbPads array is always 16 entries.
    if (!Array.isArray(settings.sbPads) || settings.sbPads.length < 16) {
        const PAD_COLORS = ['#2563eb','#6366f1','#d97706','#059669','#7c3aed','#dc2626','#0891b2','#65a30d',
                            '#1d4ed8','#4f46e5','#b45309','#047857','#6d28d9','#b91c1c','#0369a1','#4d7c0f'];
        settings.sbPads = Array.from({length:16}, (_,i) => ({
            name: `Pad ${i+1}`, midiNote: 36+i, volume: 0.8,
            color: PAD_COLORS[i], loop: false, builtin: null,
        }));
    }
    // Ensure looper per-track arrays always cover all 5 tracks (RC-505-style Loop Station).
    if (!Array.isArray(settings.loopBars) || settings.loopBars.length < 5) {
        settings.loopBars = [16, 16, 16, 16, 16];
    }
    if (!Array.isArray(settings.loopTrackGainDb) || settings.loopTrackGainDb.length < 5) {
        settings.loopTrackGainDb = [0, 0, 0, 0, 0];
    }
    if (!Array.isArray(settings.loopQuantize) || settings.loopQuantize.length < 5) {
        settings.loopQuantize = ['auto', 'auto', 'auto', 'auto', 'auto'];
    }

    // PAGE → SHELL: mute messages only (no tab-list IPC needed).
    function _shellSend(msg) {
        try {
            if (!window.__xfwOutbox) window.__xfwOutbox = [];
            window.__xfwOutbox.push(msg);
        } catch {}
    }

    // ---------- audio graph ------------------------------------------------
    // Three input channels (mic, aux1, aux2) -> per-channel Gain -> summing
    // bus -> DSP chain -> MediaStreamDestination handed to X.
    let audioCtx = null;
    let micRawStream = null, auxRawStream = null, aux2RawStream = null;
    let micSrcNode = null, auxSrcNode = null, aux2SrcNode = null;
    // xCaster channel — arrays so we can capture every tab simultaneously.
    let xcastRawStreams = [];  // one MediaStream per captured tab
    let xcastSrcNodes  = [];  // corresponding MediaStreamSourceNodes
    const _capturedWcIds = new Set(); // wcIds currently being captured
    let micGainNode = null, auxGainNode = null, aux2GainNode = null, xcastGainNode = null;
    let micMixSend = null, auxMixSend = null, aux2MixSend = null, xcastMixSend = null;
    let micMonitorGain = null, auxMonitorGain = null, aux2MonitorGain = null, xcastMonitorGain = null;
    // Soundboard channel nodes
    let sbBus = null, sbSourceBus = null, sbGainNode = null, sbMixSend = null, sbMonitorGain = null, sbAnalyser = null;
    let monitorDest = null;
    let monitorAudioEl = null;
    let mixBus = null;
    let metronomeGain = null; // monitor-only click bus — never connects to sbBus/loopRecordBus/mixBus
    let hpf = null, eqLow = null, eqMid = null, eqHigh = null;
    let comp = null, limiter = null, makeup = null;
    let processedDest = null;
    let processedStream = null;
    // Dedicated Loop Station recording tap — sums mic/aux/aux2/xcast right
    // after their per-channel gain (mute), BEFORE the mixSend/Cue split. This
    // means Loop Station recording always captures whatever you can hear on
    // those channels, regardless of whether a channel's "Cue (monitor only)"
    // toggle is on (which intentionally zeroes mixBus/processedStream so that
    // channel doesn't reach the X broadcast) — otherwise a cued channel would
    // record as total silence even though you can hear it in your headset.
    let loopRecordBus = null, loopRecordDest = null, loopRecordStream = null;
    let xBroadcastCtx = null;       // dedicated AudioContext for broadcast out device
    let xBroadcastCtxSink = null;   // last sinkId applied to xBroadcastCtx
    let broadcastSrcNode = null;    // source node inside xBroadcastCtx
    let inputAnalyser = null;
    let outputAnalyser = null;
    let micAnalyser = null, auxAnalyser = null, aux2Analyser = null, xcastAnalyser = null;

    // Track every AudioContext the page creates so we can rebind their sink
    // when the user changes the speaker selection.
    const __xfwContexts = new Set();

    // ── Pitch Shifter / Autotune ──────────────────────────────────────────────
    // Loaded as an AudioWorklet via a Blob URL so no separate file is needed.
    const _PITCH_WORKLET_SRC = `
'use strict';
class XCasterPitch extends AudioWorkletProcessor {
  constructor() {
    super();
    const N=2048,HOP=512,OVL=4;
    this.N=N; this.HOP=HOP; this.OVL=OVL;
    this.ratio=1.0; this.enabled=false;
    this.autoMode=false; this.scaleKey=0; this.strength=1.0;
    this.scaleDef=[0,2,4,5,7,9,11]; // major by default
    this.win=new Float32Array(N);
    for(let i=0;i<N;i++) this.win[i]=0.5*(1-Math.cos(2*Math.PI*i/N));
    this.lp=new Float32Array(N); this.sp=new Float32Array(N);
    this.inRing=new Float32Array(N*2); this.inWr=0; this.sinceHop=0; this.tot=0;
    this.outBuf=new Float32Array(N*4); this.outWr=0; this.outRd=0; this.outAvail=0;
    this.re=new Float32Array(N); this.im=new Float32Array(N);
    this.smoothPitch=0; this.SMOOTH=0.85;
    this.port.onmessage=({data:d})=>{
      if(d.ratio   !=null)this.ratio    =+d.ratio;
      if(d.enable  !=null)this.enabled  =!!d.enable;
      if(d.auto    !=null)this.autoMode =!!d.auto;
      if(d.key     !=null)this.scaleKey =+d.key;
      if(d.scale   !=null)this.scaleDef =d.scale;
      if(d.strength!=null)this.strength =+d.strength;
      if(d.reset   )     {this.lp.fill(0);this.sp.fill(0);}
    };
  }
  _fft(re,im,inv){
    const n=re.length;
    for(let i=1,j=0;i<n;i++){
      let b=n>>1;for(;j&b;b>>=1)j^=b;j^=b;
      if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}
    }
    for(let len=2;len<=n;len<<=1){
      const ang=(inv?2:-2)*Math.PI/len;
      const wr=Math.cos(ang),wi=Math.sin(ang);
      for(let i=0;i<n;i+=len){
        let cr=1,ci=0;
        for(let j=0;j<len>>1;j++){
          const h=i+j+(len>>1);
          const vr=re[h]*cr-im[h]*ci,vi=re[h]*ci+im[h]*cr;
          re[h]=re[i+j]-vr;im[h]=im[i+j]-vi;
          re[i+j]+=vr;im[i+j]+=vi;
          const nr=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=nr;
        }
      }
    }
    if(inv)for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}
  }
  _detectPitch(frame){
    const M=Math.min(1024,frame.length);
    const minLag=Math.ceil(sampleRate/1100),maxLag=Math.min(M-2,Math.floor(sampleRate/60));
    let e=0;for(let i=0;i<M;i++)e+=frame[i]*frame[i];
    if(e/M<5e-5||maxLag<minLag)return 0;
    let best=0,bestLag=-1;
    for(let lag=minLag;lag<=maxLag;lag++){
      let r=0;for(let i=0;i<M-lag;i++)r+=frame[i]*frame[i+lag];
      r/=(M-lag);
      if(r>best){best=r;bestLag=lag;}
    }
    return(bestLag<0||best<e/M*0.3)?0:sampleRate/bestLag;
  }
  _snapToScale(midiF){
    const key=this.scaleKey,scale=this.scaleDef;
    const nr=Math.round(midiF);
    const nOct=((nr-key)%12+12)%12;
    let best=scale[0],bestD=Infinity;
    for(const s of scale){let d=((s-nOct)%12+12)%12;if(d>6)d=12-d;if(d<bestD){bestD=d;best=s;}}
    const corr=((best-nOct)%12+12)%12;
    return nr+(corr>6?corr-12:corr);
  }
  _vocoder(frame,ratio){
    const n=this.N,hop=this.HOP,pi2=6.283185307;
    const re=this.re,im=this.im;
    for(let i=0;i<n;i++){re[i]=frame[i]*this.win[i];im[i]=0;}
    this._fft(re,im,false);
    const rO=new Float32Array(n),iO=new Float32Array(n);
    const lp=this.lp,sp=this.sp;
    for(let k=0;k<=(n>>1);k++){
      const mag=Math.sqrt(re[k]*re[k]+im[k]*im[k]);
      const ph=Math.atan2(im[k],re[k]);
      let dp=ph-lp[k]-pi2*k*hop/n;
      lp[k]=ph;
      dp-=pi2*Math.round(dp/pi2);
      const freq=k+dp*n/(pi2*hop);
      const ok=Math.round(k*ratio);
      if(ok>=0&&ok<=(n>>1)){
        sp[ok]+=freq*ratio*pi2*hop/n;
        rO[ok]+=mag*Math.cos(sp[ok]);
        iO[ok]+=mag*Math.sin(sp[ok]);
        if(ok>0&&ok<(n>>1)){rO[n-ok]=rO[ok];iO[n-ok]=-iO[ok];}
      }
    }
    this._fft(rO,iO,true);
    const out=new Float32Array(n);
    for(let i=0;i<n;i++)out[i]=rO[i]*this.win[i];
    return out;
  }
  process(inputs,outputs){
    const inp=inputs[0]?.[0],out=outputs[0]?.[0];
    if(!inp||!out)return true;
    if(!this.enabled){out.set(inp.subarray(0,out.length));return true;}
    const n=this.N,hop=this.HOP,rLen=this.inRing.length,oLen=this.outBuf.length;
    for(let i=0;i<inp.length;i++){this.inRing[this.inWr]=inp[i];this.inWr=(this.inWr+1)%rLen;}
    this.sinceHop+=inp.length;this.tot+=inp.length;
    if(!this.ready&&this.tot>=n)this.ready=true;
    while(this.ready&&this.sinceHop>=hop){
      const frame=new Float32Array(n);
      const fs=(this.inWr-n+rLen)%rLen;
      for(let i=0;i<n;i++)frame[i]=this.inRing[(fs+i)%rLen];
      let ratio=this.ratio;
      if(this.autoMode){
        const p=this._detectPitch(frame);
        if(p>0){
          this.smoothPitch=this.smoothPitch?this.SMOOTH*this.smoothPitch+(1-this.SMOOTH)*p:p;
          const midi=12*Math.log2(this.smoothPitch/440)+69;
          const target=this._snapToScale(midi);
          ratio=Math.pow(2,(target-midi)*this.strength/12);
        }else{this.smoothPitch*=this.SMOOTH;ratio=1.0;}
      }
      const result=(Math.abs(ratio-1)<0.002)?frame:this._vocoder(frame,ratio);
      for(let i=0;i<n;i++)this.outBuf[(this.outWr+i)%oLen]+=result[i];
      this.outWr=(this.outWr+hop)%oLen;
      this.outAvail+=hop;
      this.sinceHop-=hop;
    }
    const norm=2.0/this.OVL;
    const toOut=Math.min(out.length,this.outAvail);
    for(let i=0;i<toOut;i++){const p=(this.outRd+i)%oLen;out[i]=this.outBuf[p]*norm;this.outBuf[p]=0;}
    for(let i=toOut;i<out.length;i++)out[i]=0;
    this.outRd=(this.outRd+toOut)%oLen;
    this.outAvail-=toOut;
    return true;
  }
}
registerProcessor('xcaster-pitch',XCasterPitch);
`;

    let _pitchWorkletURL = null;
    let _pitchWorkletPromise = null;
    let _pitchWorkletLoaded = false;
    let pitchNode = null;

    function ensurePitchWorklet(ctx) {
        if (!_pitchWorkletURL) {
            try {
                const blob = new Blob([_PITCH_WORKLET_SRC], { type: 'application/javascript' });
                _pitchWorkletURL = URL.createObjectURL(blob);
            } catch (e) { return Promise.reject(e); }
        }
        if (!_pitchWorkletPromise) {
            _pitchWorkletPromise = ctx.audioWorklet.addModule(_pitchWorkletURL)
                .then(() => {
                    _pitchWorkletLoaded = true;
                    console.info('[XCaster] pitch worklet loaded');
                    // If autotune is enabled and graph was already built, rebuild now.
                    if (settings.autotuneEnabled && processedDest) {
                        buildGraph();
                        replaceTracksOnActivePCs();
                    }
                })
                .catch(err => {
                    console.warn('[XCaster] pitch worklet failed', err);
                    _pitchWorkletPromise = null;
                    _pitchWorkletURL = null;
                });
        }
        return _pitchWorkletPromise;
    }

    function updatePitchNode() {
        if (!pitchNode) return;
        const semitones = settings.pitchShiftSemitones || 0;
        pitchNode.port.postMessage({
            ratio:    settings.autotuneAuto ? 1.0 : Math.pow(2, semitones / 12),
            enable:   settings.autotuneEnabled,
            auto:     settings.autotuneAuto,
            key:      settings.autotuneKey || 0,
            scale:    settings.autotuneAuto ? _AUTOTUNE_SCALES.chromatic : undefined,
            strength: settings.autotuneStrength || 1.0,
        });
    }

    const _AUTOTUNE_SCALES = {
        chromatic: [0,1,2,3,4,5,6,7,8,9,10,11],
        major:     [0,2,4,5,7,9,11],
        minor:     [0,2,3,5,7,8,10],
        pentatonic:[0,2,4,7,9],
    };
    const _NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

    // ══════════════════════════════════════════════════════════════════════════
    // SOUNDBOARD · MIDI · SYNTHESIZER · LOOPER
    // ══════════════════════════════════════════════════════════════════════════

    // ── Built-in sound kits ────────────────────────────────────────────────────
    // Procedurally synthesized (no bundled audio assets needed / no licensing
    // concerns). Gives the pads instant test content: a drum kit, a piano/
    // guitar scale, X-mobile-style sound effects (clap, cheer, air horn…) and
    // a set of synth-keys pluck tones. Rendered once per sound and cached.
    function _noiseBuffer(ctx, durationSec) {
        const n = Math.max(1, Math.round(ctx.sampleRate * durationSec));
        const buf = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        return buf;
    }
    function _renderOffline(durationSec, buildFn) {
        const sr = 44100;
        const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(sr * durationSec)), sr);
        buildFn(ctx);
        return ctx.startRendering();
    }
    function _midiToFreq(note) { return 440 * Math.pow(2, (note - 69) / 12); }
    function _midiToName(note) { return `${_NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`; }

    // Pitched percussive thump (kick/tom): sine with a fast downward pitch sweep.
    function _renderThump(startHz, endHz, durationSec, decaySec) {
        return _renderOffline(durationSec, ctx => {
            const osc = ctx.createOscillator(), gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(startHz, 0);
            osc.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), decaySec);
            gain.gain.setValueAtTime(1, 0);
            gain.gain.exponentialRampToValueAtTime(0.001, decaySec);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(0); osc.stop(durationSec);
        });
    }
    // One or more filtered-noise bursts scheduled inside a single buffer —
    // used for hats/snare/clap/crash and the crowd/clap-style SFX.
    function _renderNoiseBursts(durationSec, bursts) {
        return _renderOffline(durationSec, ctx => {
            bursts.forEach(b => {
                const len = Math.max(0.01, durationSec - b.t);
                const src = ctx.createBufferSource();
                src.buffer = _noiseBuffer(ctx, len);
                const filt = ctx.createBiquadFilter();
                filt.type = b.type || 'bandpass';
                filt.frequency.value = b.type === 'bandpass' ? (b.freqLo + b.freqHi) / 2 : b.freqLo;
                if (b.type === 'bandpass') filt.Q.value = b.q || 1.2;
                const gain = ctx.createGain();
                gain.gain.setValueAtTime(b.gain ?? 1, b.t);
                gain.gain.exponentialRampToValueAtTime(0.001, b.t + (b.decay || 0.12));
                src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
                src.start(b.t);
            });
        });
    }
    // Plucked/sustained tone (piano / guitar / synth keys): a small stack of
    // detuned harmonics over a decaying envelope.
    function _renderPluck(freq, durationSec, opts = {}) {
        const { wave = 'triangle', harmonics = [1, 2, 3], harmAmp = [1, 0.45, 0.2], decaySec, detune = 0 } = opts;
        const decay = decaySec || durationSec * 0.9;
        return _renderOffline(durationSec, ctx => {
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(1, 0);
            gain.gain.linearRampToValueAtTime(1, 0.01);
            gain.gain.exponentialRampToValueAtTime(0.001, decay);
            gain.connect(ctx.destination);
            harmonics.forEach((h, i) => {
                const osc = ctx.createOscillator();
                osc.type = wave;
                osc.frequency.value = freq * h;
                osc.detune.value = detune * (i % 2 === 0 ? 1 : -1);
                const hg = ctx.createGain();
                hg.gain.value = (harmAmp[i] ?? 0.3) / harmonics.length;
                osc.connect(hg); hg.connect(gain);
                osc.start(0); osc.stop(durationSec);
            });
        });
    }
    // Sustained honk (air horn): two closely-detuned sawtooths, fast attack.
    function _renderHonk(freq, durationSec) {
        return _renderOffline(durationSec, ctx => {
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0, 0);
            gain.gain.linearRampToValueAtTime(1, 0.03);
            gain.gain.setValueAtTime(1, durationSec * 0.7);
            gain.gain.exponentialRampToValueAtTime(0.001, durationSec);
            gain.connect(ctx.destination);
            [freq, freq * 1.011].forEach(f => {
                const osc = ctx.createOscillator();
                osc.type = 'sawtooth'; osc.frequency.value = f;
                const hg = ctx.createGain(); hg.gain.value = 0.5;
                osc.connect(hg); hg.connect(gain);
                osc.start(0); osc.stop(durationSec);
            });
        });
    }
    // Descending pitch sweep (boo).
    function _renderSweep(startHz, endHz, durationSec) {
        return _renderOffline(durationSec, ctx => {
            const osc = ctx.createOscillator(), gain = ctx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(startHz, 0);
            osc.frequency.linearRampToValueAtTime(endHz, durationSec * 0.85);
            gain.gain.setValueAtTime(0, 0);
            gain.gain.linearRampToValueAtTime(1, 0.08);
            gain.gain.exponentialRampToValueAtTime(0.001, durationSec);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(0); osc.stop(durationSec);
        });
    }

    // ── Dedicated crowd/reaction SFX renderers ──────────────────────────────
    // The generic noise-burst helper above sounds too "one-note" for the more
    // complex X-Spaces-style reaction sounds (applause, cheer, laughter, an
    // air horn, etc.), so these build a more convincing timbre/envelope per
    // sound: broadband + resonant layering for claps, multi-voice filtered
    // noise "roar" for crowd cheer/boo, pitch-swept breath noise for gasps,
    // pulsed formant tone for laughter, and so on — still 100% procedural
    // (no bundled audio assets), just closer to the real-world sound.

    // A single realistic hand clap: broadband snap + a short resonant "ring".
    function _renderClapBurst(ctx, t, out) {
        const len = 0.18;
        const src = ctx.createBufferSource();
        src.buffer = _noiseBuffer(ctx, len);
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5500;
        const snapGain = ctx.createGain();
        snapGain.gain.setValueAtTime(1, t);
        snapGain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
        src.connect(hp); hp.connect(lp); lp.connect(snapGain); snapGain.connect(out);
        const ring = ctx.createBufferSource();
        ring.buffer = _noiseBuffer(ctx, len);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 2.2;
        const ringGain = ctx.createGain();
        ringGain.gain.setValueAtTime(0.5, t);
        ringGain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        ring.connect(bp); bp.connect(ringGain); ringGain.connect(out);
        src.start(t); ring.start(t);
    }
    function _renderClap(durationSec) {
        return _renderOffline(durationSec, ctx => {
            const out = ctx.createGain(); out.connect(ctx.destination);
            _renderClapBurst(ctx, 0, out);
            _renderClapBurst(ctx, 0.025, out);
            _renderClapBurst(ctx, 0.05, out);
        });
    }
    // Dense, randomized crowd applause: many overlapping clap transients
    // (denser mid-roll, thinning at the tail) over a soft continuous "room" bed.
    function _renderApplause(durationSec) {
        return _renderOffline(durationSec, ctx => {
            const out = ctx.createGain(); out.connect(ctx.destination);
            const bed = ctx.createBufferSource();
            bed.buffer = _noiseBuffer(ctx, durationSec);
            const bedFilt = ctx.createBiquadFilter(); bedFilt.type = 'bandpass'; bedFilt.frequency.value = 2200; bedFilt.Q.value = 0.6;
            const bedGain = ctx.createGain();
            bedGain.gain.setValueAtTime(0, 0);
            bedGain.gain.linearRampToValueAtTime(0.06, durationSec * 0.15);
            bedGain.gain.linearRampToValueAtTime(0.05, durationSec * 0.75);
            bedGain.gain.linearRampToValueAtTime(0, durationSec);
            bed.connect(bedFilt); bedFilt.connect(bedGain); bedGain.connect(out);
            bed.start(0);
            let t = 0.02;
            while (t < durationSec - 0.05) {
                _renderClapBurst(ctx, t, out);
                const progress = t / durationSec;
                const gap = progress < 0.7 ? 0.045 : 0.045 + (progress - 0.7) * 0.25;
                t += gap + Math.random() * gap * 0.8;
            }
        });
    }
    // Swelling crowd "roar": 3 layers of filtered noise with slow independent
    // formant-like sweeps, plus scattered claps/whoops near the peak.
    function _renderCrowdCheer(durationSec) {
        return _renderOffline(durationSec, ctx => {
            const out = ctx.createGain(); out.connect(ctx.destination);
            [{ f0: 500, f1: 1100, g: 0.55, d: 0 }, { f0: 800, f1: 1800, g: 0.4, d: 0.05 }, { f0: 1400, f1: 2600, g: 0.3, d: 0.1 }]
                .forEach(v => {
                    const src = ctx.createBufferSource();
                    src.buffer = _noiseBuffer(ctx, durationSec);
                    const filt = ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.Q.value = 1.1;
                    filt.frequency.setValueAtTime(v.f0, 0);
                    filt.frequency.linearRampToValueAtTime(v.f1, durationSec * 0.6);
                    filt.frequency.linearRampToValueAtTime(v.f0 * 1.1, durationSec);
                    const g = ctx.createGain();
                    g.gain.setValueAtTime(0, 0);
                    g.gain.linearRampToValueAtTime(v.g, durationSec * 0.25 + v.d);
                    g.gain.linearRampToValueAtTime(v.g * 0.9, durationSec * 0.7);
                    g.gain.linearRampToValueAtTime(0, durationSec);
                    src.connect(filt); filt.connect(g); g.connect(out);
                    src.start(0);
                });
            let t = durationSec * 0.3;
            while (t < durationSec * 0.85) { _renderClapBurst(ctx, t, out); t += 0.1 + Math.random() * 0.15; }
        });
    }
    // Descending crowd "boo": a few detuned sawtooth voices sliding down in
    // pitch together, over a low noise body for crowd texture.
    function _renderCrowdBoo(durationSec) {
        return _renderOffline(durationSec, ctx => {
            const out = ctx.createGain(); out.connect(ctx.destination);
            [220, 180, 260, 150].forEach((f, i) => {
                const start = 0.05 * i;
                const osc = ctx.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(f, start);
                osc.frequency.linearRampToValueAtTime(f * 0.55, durationSec * 0.9);
                const g = ctx.createGain();
                g.gain.setValueAtTime(0, start);
                g.gain.linearRampToValueAtTime(0.22, start + 0.12);
                g.gain.exponentialRampToValueAtTime(0.001, durationSec);
                osc.connect(g); g.connect(out);
                osc.start(start); osc.stop(durationSec);
            });
            const src = ctx.createBufferSource();
            src.buffer = _noiseBuffer(ctx, durationSec);
            const filt = ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.frequency.value = 500; filt.Q.value = 0.7;
            const g2 = ctx.createGain();
            g2.gain.setValueAtTime(0, 0);
            g2.gain.linearRampToValueAtTime(0.15, 0.15);
            g2.gain.exponentialRampToValueAtTime(0.001, durationSec);
            src.connect(filt); filt.connect(g2); g2.connect(out);
            src.start(0);
        });
    }
    // Air horn: quick pitch-rise attack into a sustained blast — sawtooth pair
    // + a square sub-oscillator an octave down for body, then a fast fade.
    function _renderAirhorn(freq, durationSec) {
        return _renderOffline(durationSec, ctx => {
            const attack = 0.05;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0, 0);
            gain.gain.linearRampToValueAtTime(1, attack);
            gain.gain.setValueAtTime(1, durationSec * 0.75);
            gain.gain.exponentialRampToValueAtTime(0.001, durationSec);
            gain.connect(ctx.destination);
            [1, 1.011, 0.5].forEach((mult, i) => {
                const osc = ctx.createOscillator();
                osc.type = i === 2 ? 'square' : 'sawtooth';
                osc.frequency.setValueAtTime(freq * mult * 0.85, 0);
                osc.frequency.exponentialRampToValueAtTime(freq * mult, attack);
                const hg = ctx.createGain(); hg.gain.value = i === 2 ? 0.35 : 0.5;
                osc.connect(hg); hg.connect(gain);
                osc.start(0); osc.stop(durationSec);
            });
        });
    }
    // Harsh game-show-style buzzer: square wave chopped by a fast square-wave
    // tremolo (amplitude modulation), instead of a smooth air-horn-like blast.
    function _renderBuzzerTone(freq, durationSec) {
        return _renderOffline(durationSec, ctx => {
            const osc = ctx.createOscillator();
            osc.type = 'square'; osc.frequency.value = freq;
            const lfo = ctx.createOscillator();
            lfo.type = 'square'; lfo.frequency.value = 26;
            const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.5;
            const amGain = ctx.createGain(); amGain.gain.value = 0.5;
            lfo.connect(lfoGain); lfoGain.connect(amGain.gain);
            const env = ctx.createGain();
            env.gain.setValueAtTime(0, 0);
            env.gain.linearRampToValueAtTime(1, 0.02);
            env.gain.setValueAtTime(1, durationSec * 0.85);
            env.gain.linearRampToValueAtTime(0, durationSec);
            osc.connect(amGain); amGain.connect(env); env.connect(ctx.destination);
            osc.start(0); osc.stop(durationSec);
            lfo.start(0); lfo.stop(durationSec);
        });
    }
    // Confetti popper: a sharp broadband pop, then a fluttering paper crackle
    // tail made of many tiny randomized high-frequency clicks.
    function _renderConfettiPop(durationSec) {
        return _renderOffline(durationSec, ctx => {
            const out = ctx.createGain(); out.connect(ctx.destination);
            const pop = ctx.createBufferSource();
            pop.buffer = _noiseBuffer(ctx, 0.05);
            const popFilt = ctx.createBiquadFilter(); popFilt.type = 'bandpass'; popFilt.frequency.value = 2500; popFilt.Q.value = 1.5;
            const popGain = ctx.createGain();
            popGain.gain.setValueAtTime(1, 0);
            popGain.gain.exponentialRampToValueAtTime(0.001, 0.05);
            pop.connect(popFilt); popFilt.connect(popGain); popGain.connect(out);
            pop.start(0);
            let t = 0.03;
            while (t < durationSec) {
                const len = 0.015 + Math.random() * 0.02;
                const src = ctx.createBufferSource();
                src.buffer = _noiseBuffer(ctx, len);
                const filt = ctx.createBiquadFilter(); filt.type = 'highpass'; filt.frequency.value = 4000 + Math.random() * 3000;
                const g = ctx.createGain();
                const peak = 0.25 * (1 - t / durationSec) + 0.05;
                g.gain.setValueAtTime(peak, t);
                g.gain.exponentialRampToValueAtTime(0.001, t + len);
                src.connect(filt); filt.connect(g); g.connect(out);
                src.start(t);
                t += 0.02 + Math.random() * 0.05;
            }
        });
    }
    // Rhythmic "ha-ha-ha" laughter: a handful of short pulsed, formant-filtered
    // tone bursts with a bouncing pitch, gently accelerating like real laughs do.
    function _renderLaughter(durationSec) {
        return _renderOffline(durationSec, ctx => {
            const out = ctx.createGain(); out.connect(ctx.destination);
            const beats = 5;
            let t = 0;
            for (let i = 0; i < beats; i++) {
                const dur = 0.14;
                const osc = ctx.createOscillator();
                osc.type = 'sawtooth';
                const baseFreq = 260 - i * 8;
                osc.frequency.setValueAtTime(baseFreq * 0.75, t);
                osc.frequency.linearRampToValueAtTime(baseFreq, t + 0.04);
                osc.frequency.linearRampToValueAtTime(baseFreq * 0.8, t + dur);
                const formant = ctx.createBiquadFilter(); formant.type = 'bandpass'; formant.frequency.value = 900; formant.Q.value = 3.5;
                const g = ctx.createGain();
                g.gain.setValueAtTime(0, t);
                g.gain.linearRampToValueAtTime(0.5, t + 0.03);
                g.gain.exponentialRampToValueAtTime(0.001, t + dur);
                osc.connect(formant); formant.connect(g); g.connect(out);
                osc.start(t); osc.stop(t + dur);
                t += dur + 0.05 - i * 0.005;
            }
        });
    }
    // Sharp inhale/gasp: noise burst run through a bandpass filter that sweeps
    // upward quickly then settles — mimics the "in-rush" of a startled breath.
    function _renderGaspBreath(durationSec) {
        return _renderOffline(durationSec, ctx => {
            const src = ctx.createBufferSource();
            src.buffer = _noiseBuffer(ctx, durationSec);
            const filt = ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.Q.value = 0.8;
            filt.frequency.setValueAtTime(700, 0);
            filt.frequency.exponentialRampToValueAtTime(2600, durationSec * 0.4);
            filt.frequency.exponentialRampToValueAtTime(1500, durationSec);
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0, 0);
            gain.gain.linearRampToValueAtTime(0.8, durationSec * 0.25);
            gain.gain.exponentialRampToValueAtTime(0.001, durationSec);
            src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
            src.start(0);
        });
    }
    // Breathy whistle: sine tone with vibrato + a touch of high-passed noise
    // (breath) mixed underneath, instead of a bare pure tone.
    function _renderWhistleTone(freq, durationSec) {
        return _renderOffline(durationSec, ctx => {
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0, 0);
            gain.gain.linearRampToValueAtTime(0.8, 0.06);
            gain.gain.setValueAtTime(0.8, durationSec * 0.75);
            gain.gain.exponentialRampToValueAtTime(0.001, durationSec);
            gain.connect(ctx.destination);
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq * 0.9, 0);
            osc.frequency.exponentialRampToValueAtTime(freq, 0.06);
            const vibrato = ctx.createOscillator(); vibrato.frequency.value = 6;
            const vibratoGain = ctx.createGain(); vibratoGain.gain.value = freq * 0.01;
            vibrato.connect(vibratoGain); vibratoGain.connect(osc.frequency);
            osc.connect(gain);
            const breath = ctx.createBufferSource();
            breath.buffer = _noiseBuffer(ctx, durationSec);
            const breathFilt = ctx.createBiquadFilter(); breathFilt.type = 'highpass'; breathFilt.frequency.value = 3500;
            const breathGain = ctx.createGain(); breathGain.gain.value = 0.05;
            breath.connect(breathFilt); breathFilt.connect(breathGain); breathGain.connect(gain);
            osc.start(0); osc.stop(durationSec);
            vibrato.start(0); vibrato.stop(durationSec);
            breath.start(0);
        });
    }
    // Cricket chirps: a few short trills, each made of several very short
    // pulsed tone blips, instead of a single flat high-passed noise burst.
    function _renderCricketChirps(durationSec) {
        return _renderOffline(durationSec, ctx => {
            const out = ctx.createGain(); out.connect(ctx.destination);
            [0, 0.32, 0.64].forEach(start => {
                for (let p = 0; p < 4; p++) {
                    const t = start + p * 0.028;
                    const osc = ctx.createOscillator();
                    osc.type = 'triangle'; osc.frequency.value = 4200 + Math.random() * 300;
                    const g = ctx.createGain();
                    g.gain.setValueAtTime(0, t);
                    g.gain.linearRampToValueAtTime(0.3, t + 0.006);
                    g.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
                    osc.connect(g); g.connect(out);
                    osc.start(t); osc.stop(t + 0.022);
                }
            });
        });
    }

    function _synthesizeBuiltin(key) {
        const parts = key.split(':');
        const cat = parts[0];
        const arg = parts.length > 1 ? parts.slice(1).join(':') : undefined;
        const midi = arg !== undefined ? +arg : 0;
        switch (cat) {
            case 'kick':    return _renderThump(150, 45, 0.35, 0.22);
            case 'kick2':   return _renderThump(120, 35, 0.4, 0.28);
            case 'tomlo':   return _renderThump(190, 95, 0.4, 0.3);
            case 'tommid':  return _renderThump(250, 130, 0.35, 0.26);
            case 'tomhi':   return _renderThump(330, 170, 0.3, 0.22);
            case 'snare':   return _renderNoiseBursts(0.25, [{ t: 0, decay: 0.15, freqLo: 1600, freqHi: 2600 }, { t: 0, decay: 0.08, freqLo: 200, freqHi: 400 }]);
            case 'rim':     return _renderNoiseBursts(0.1, [{ t: 0, decay: 0.05, freqLo: 3000, freqHi: 5000 }]);
            case 'hihat_closed': return _renderNoiseBursts(0.08, [{ t: 0, decay: 0.05, type: 'highpass', freqLo: 7000 }]);
            case 'hihat_open':   return _renderNoiseBursts(0.5, [{ t: 0, decay: 0.4, type: 'highpass', freqLo: 6000 }]);
            case 'hihat_pedal':  return _renderNoiseBursts(0.15, [{ t: 0, decay: 0.1, type: 'highpass', freqLo: 6500 }]);
            case 'clap':    return _renderClap(0.3);
            case 'crash':   return _renderNoiseBursts(1.6, [{ t: 0, decay: 1.4, type: 'highpass', freqLo: 5000 }]);
            case 'ride':    return _renderNoiseBursts(1.0, [{ t: 0, decay: 0.9, type: 'highpass', freqLo: 4000 }]);
            case 'cowbell': return _renderThump(800, 560, 0.3, 0.28);
            case 'shaker':  return _renderNoiseBursts(0.2, [{ t: 0, decay: 0.15, type: 'highpass', freqLo: 5500 }]);
            case 'stick':   return _renderNoiseBursts(0.06, [{ t: 0, decay: 0.03, freqLo: 2500, freqHi: 4000 }]);
            case 'piano':   return _renderPluck(_midiToFreq(midi), 1.6, { wave: 'triangle', harmonics: [1, 2, 3, 4], harmAmp: [1, 0.5, 0.28, 0.12], decaySec: 1.4 });
            case 'guitar':  return _renderPluck(_midiToFreq(midi), 2.0, { wave: 'sawtooth', harmonics: [1, 2, 3], harmAmp: [1, 0.35, 0.15], decaySec: 1.8, detune: 6 });
            case 'synthkeys': return _renderPluck(_midiToFreq(midi), 0.9, { wave: 'sawtooth', harmonics: [1, 2], harmAmp: [1, 0.4], decaySec: 0.7, detune: 8 });
            // ── 808-style kit (dedicated tuning for the signature sounds) ──────
            case 'kick808':  return _renderThump(150, 35, 0.55, 0.45);
            case 'kick808b': return _renderThump(110, 26, 0.7, 0.6);
            case 'snare808': return _renderNoiseBursts(0.3, [{ t: 0, decay: 0.2, freqLo: 1800, freqHi: 3000 }, { t: 0, decay: 0.1, freqLo: 220, freqHi: 420 }]);
            case 'clap808':  return _renderNoiseBursts(0.32, [
                { t: 0,    decay: 0.05, freqLo: 1000, freqHi: 1800 },
                { t: 0.025,decay: 0.05, freqLo: 1000, freqHi: 1800 },
                { t: 0.05, decay: 0.2,  freqLo: 1000, freqHi: 1800 },
            ]);
            case 'subdrop':  return _renderThump(90, 20, 1.3, 1.05);
            // ── Generic parametric drum hits — used to build kit variants
            // (808 / Lo-Fi / future kits) without a dedicated case per sound. ──
            case 'thump': {
                const [s, e, d, dec] = arg.split(':').map(Number);
                return _renderThump(s, e, d, dec);
            }
            case 'noise1': {
                const [type, freqLo, freqHi, dur, decay] = arg.split(':');
                return _renderNoiseBursts(+dur, [{ t: 0, decay: +decay, type, freqLo: +freqLo, freqHi: freqHi ? +freqHi : undefined }]);
            }
            case 'claplike': {
                const [freqLo, freqHi, dur] = arg.split(':').map(Number);
                return _renderNoiseBursts(dur, [
                    { t: 0,     decay: 0.06,       freqLo, freqHi },
                    { t: 0.025, decay: 0.06,       freqLo, freqHi },
                    { t: 0.05,  decay: dur * 0.55, freqLo, freqHi },
                ]);
            }
            case 'roll': {
                const [type, freqLo, freqHi, totalDurStr, startGapStr] = arg.split(':');
                const total = +totalDurStr;
                const bursts = [];
                let t = 0, gap = +startGapStr;
                while (t < total) {
                    bursts.push({ t, decay: gap * 0.85, type, freqLo: +freqLo, freqHi: freqHi ? +freqHi : undefined });
                    t += gap; gap = Math.max(0.025, gap * 0.92);
                }
                return _renderNoiseBursts(total + 0.2, bursts);
            }
            case 'sfx': {
                switch (arg) {
                    case 'clap':      return _renderClap(0.32);
                    case 'cheer':     return _renderCrowdCheer(2.4);
                    case 'applause':  return _renderApplause(2.2);
                    case 'airhorn':   return _renderAirhorn(420, 1.1);
                    case 'drumroll': {
                        const bursts = [];
                        let t = 0, gap = 0.09;
                        while (t < 1.3) { bursts.push({ t, decay: gap * 0.9, freqLo: 1500, freqHi: 2600 }); t += gap; gap = Math.max(0.03, gap * 0.94); }
                        return _renderNoiseBursts(1.5, bursts);
                    }
                    case 'rimshot':   return _renderNoiseBursts(0.1, [{ t: 0, decay: 0.05, freqLo: 3000, freqHi: 5000 }]);
                    case 'boo':       return _renderCrowdBoo(1.3);
                    case 'confetti':  return _renderConfettiPop(0.9);
                    case 'laugh':     return _renderLaughter(1.15);
                    case 'gasp':      return _renderGaspBreath(0.45);
                    case 'whistle':   return _renderWhistleTone(2200, 0.9);
                    case 'buzzer':    return _renderBuzzerTone(190, 0.6);
                    case 'bell':      return _renderPluck(1200, 1.2, { wave: 'sine', harmonics: [1, 2.4, 3.8], harmAmp: [1, 0.4, 0.2], decaySec: 1.1 });
                    case 'crickets':  return _renderCricketChirps(1.0);
                    case 'thud':      return _renderThump(100, 40, 0.3, 0.24);
                    case 'pop':       return _renderNoiseBursts(0.15, [{ t: 0, decay: 0.03, freqLo: 2000, freqHi: 4000 }, { t: 0.02, decay: 0.12, type: 'highpass', freqLo: 5000 }]);
                    default:          return _renderNoiseBursts(0.2, [{ t: 0, decay: 0.15, freqLo: 800, freqHi: 1600 }]);
                }
            }
            default: return _renderNoiseBursts(0.2, [{ t: 0, decay: 0.15, freqLo: 800, freqHi: 1600 }]);
        }
    }

    // ---------- decoded-audio budget ---------------------------------------
    // _realSampleCache / _wafZoneCache / _padBufferCache hold DECODED
    // AudioBuffers — float32 PCM, so a 1 MB compressed sample lands as ~10-20 MB
    // resident. They were plain Maps with no eviction anywhere: the only
    // .delete() calls were for in-flight load keys and failed URLs. Browsing the
    // GM instrument catalog therefore grew the renderer without bound, and
    // nothing short of reloading the tab gave the memory back.
    //
    // Track every decoded buffer against a byte budget, evict least-recently-used
    // past the cap, and drop the lot once the Sounds rig has gone idle.
    //
    // Eviction is safe while audio is playing: an AudioBufferSourceNode holds its
    // own reference to the AudioBuffer, so a note already sounding runs to
    // completion. The cost of evicting is a re-fetch on next use, not a glitch.
    const AUDIO_CACHE_MAX_BYTES = 200 * 1024 * 1024;
    const AUDIO_CACHE_IDLE_MS   = 5 * 60 * 1000;
    const _audioCache = new Map();   // key → { bytes, used, drop }
    let _audioCacheBytes = 0;
    let _soundsLastUsed = Date.now();

    function _bufBytes(b) {
        try { return b && b.length ? b.length * (b.numberOfChannels || 1) * 4 : 0; }
        catch { return 0; }
    }
    const _mb = n => Math.round(n / 1048576) + 'MB';

    function _trackDecoded(key, bytes, drop) {
        if (!bytes) return;
        const prev = _audioCache.get(key);
        if (prev) _audioCacheBytes -= prev.bytes;
        _audioCache.set(key, { bytes, used: Date.now(), drop });
        _audioCacheBytes += bytes;
        _soundsLastUsed = Date.now();
        _enforceAudioBudget();
    }

    function _touchDecoded(key) {
        const e = _audioCache.get(key);
        if (e) e.used = Date.now();
        _soundsLastUsed = Date.now();
    }

    function _dropDecoded(key) {
        const e = _audioCache.get(key);
        if (!e) return;
        _audioCache.delete(key);
        _audioCacheBytes -= e.bytes;
        try { e.drop(); } catch { /* ignore */ }
        // _padBufferCache holds REFERENCES to these same AudioBuffers, so
        // dropping the source cache while a pad still points at one frees
        // nothing — the buffer stays reachable and the budget is fiction.
        // Pads reload lazily through loadPadBuffer(), so clearing is cheap.
        _purgePadBuffers();
    }

    function _purgePadBuffers() {
        try {
            if (typeof _padBufferCache !== 'undefined') _padBufferCache.clear();
            if (typeof _padSamplePitch !== 'undefined') _padSamplePitch.clear();
        } catch { /* not built yet */ }
    }

    function _enforceAudioBudget() {
        if (_audioCacheBytes <= AUDIO_CACHE_MAX_BYTES) return;
        const oldestFirst = [..._audioCache.entries()].sort((a, b) => a[1].used - b[1].used);
        let freed = 0;
        for (const [key] of oldestFirst) {
            if (_audioCacheBytes <= AUDIO_CACHE_MAX_BYTES) break;
            freed += _audioCache.get(key)?.bytes || 0;
            _dropDecoded(key);
        }
        if (freed) console.info('[XCaster] decoded-audio budget: freed', _mb(freed) + ',', _mb(_audioCacheBytes), 'still cached');
    }

    function _freeAllDecoded(reason) {
        if (!_audioCache.size) return;
        const was = _audioCacheBytes;
        for (const key of [..._audioCache.keys()]) _dropDecoded(key);
        console.info('[XCaster] released', _mb(was), 'of decoded audio —', reason);
    }

    // Called from the health watchdog. Frees everything once the Sounds rig has
    // been untouched long enough that holding a GM catalog in RAM is pure cost.
    function sweepIdleAudioCache() {
        if (!_audioCache.size) return;
        if (Date.now() - _soundsLastUsed < AUDIO_CACHE_IDLE_MS) return;
        _freeAllDecoded('Sounds idle for ' + Math.round(AUDIO_CACHE_IDLE_MS / 60000) + ' min');
    }

    const _builtinBufferCache = new Map(); // builtin key → Promise<AudioBuffer>
    function _getBuiltinBuffer(key) {
        if (_builtinBufferCache.has(key)) return _builtinBufferCache.get(key);
        const p = _synthesizeBuiltin(key).catch(e => { console.warn('[XCaster] builtin sound synth failed', key, e); return null; });
        _builtinBufferCache.set(key, p);
        return p;
    }

    // ── Real sample-based kits ────────────────────────────────────────────
    // Free, openly-licensed drum-machine multisamples hosted by the smplr
    // project (https://github.com/danigb/smplr, MIT) at smpldsnds.github.io.
    // We fetch the real audio files directly (no bundler / npm runtime needed
    // in this raw-injected overlay) and decode them into normal AudioBuffers,
    // so they drop straight into the existing pad-playback pipeline. Every
    // real-sample pad also keeps its original procedural `builtin` sound as
    // an automatic offline/network-failure fallback — nothing breaks if the
    // stream has no internet access mid-show.
    const _realSampleCache = new Map(); // url → AudioBuffer
    async function _getRealSampleBuffer(urlOrBase) {
        if (_realSampleCache.has(urlOrBase)) { _touchDecoded('real:' + urlOrBase); return _realSampleCache.get(urlOrBase); }
        const ctx = ensureAudioContext();
        // If the URL already ends in a known audio extension, fetch it directly.
        // Otherwise try .ogg then .m4a (the smpldsnds.github.io CDN pattern).
        const hasExt = /\.(ogg|m4a|flac|mp3|wav)$/i.test(urlOrBase);
        const candidates = hasExt ? [urlOrBase] : [`${urlOrBase}.ogg`, `${urlOrBase}.m4a`];
        for (const url of candidates) {
            try {
                const res = await fetch(url);
                if (!res.ok) continue;
                const buf = await res.arrayBuffer();
                const ab = await ctx.decodeAudioData(buf);
                _realSampleCache.set(urlOrBase, ab);
                _trackDecoded('real:' + urlOrBase, _bufBytes(ab), () => _realSampleCache.delete(urlOrBase));
                return ab;
            } catch { /* try next / fail silently */ }
        }
        console.warn('[XCaster] real sample fetch failed, using procedural fallback:', urlOrBase);
        return null;
    }
    // Warms the cache for a kit's real samples in the background so the first
    // pad hit isn't laggy waiting on a network round-trip.
    function _prefetchRealSamples(padList) {
        for (const p of padList) {
            if (p.sample) _getRealSampleBuffer(p.sample).catch(() => {});
            if (p.sfzInstrument && p.sfzNote != null) _getSfzSampleBuffer(p.sfzInstrument, p.sfzNote).catch(() => {});
            if (p.wafUrl && p.wafNote != null) _getWAFBuffer(p.wafUrl, p.wafNote).catch(() => {});
        }
    }

    // ── Real multisampled instruments (FreePats, CC0/CC-BY) ───────────────
    // Piano/Guitar pads used to be 100% procedurally synthesized (see
    // _synthesizeBuiltin's 'piano'/'guitar' cases below) — these tables let
    // them use REAL recorded instrument samples instead, sourced from the
    // FreePats project's plain FLAC sample files (no code execution: this is
    // just fetch()+decodeAudioData() on ordinary audio files, exactly like
    // the drum-machine real samples above — NOT the WebAudioFont/SpessaSynth
    // approach, which packages sample data as executable JS and was
    // deliberately avoided as an unnecessary remote-code-execution risk).
    // Each `regions` entry is copied directly from that instrument's own
    // FreePats .sfz file (a plain-text sample map — lokey/hikey = the MIDI
    // note range this region covers, pitch = the MIDI note the sample was
    // actually recorded at). Notes that don't have their own recorded sample
    // reuse the nearest region's file, pitch-shifted via playbackRate — the
    // same technique a hardware sampler uses to cover a full keyboard from a
    // handful of recorded notes. Builtin procedural synthesis remains the
    // automatic fallback if a fetch/decode ever fails (offline mid-show etc).
    const _SFZ_INSTRUMENTS = {
        // FM Piano 2 (Roberto/FreePats, CC0) — freepats/fm-piano2
        piano: {
            base: 'https://raw.githubusercontent.com/freepats/fm-piano2/main/samples/', ext: 'flac',
            regions: [
                { lokey: 26, hikey: 32, pitch: 30, sample: 'F#1v80' },
                { lokey: 33, hikey: 38, pitch: 36, sample: 'C2v80' },
                { lokey: 39, hikey: 44, pitch: 42, sample: 'F#2v80' },
                { lokey: 45, hikey: 50, pitch: 48, sample: 'C3v80' },
                { lokey: 51, hikey: 56, pitch: 54, sample: 'F#3v80' },
                { lokey: 57, hikey: 62, pitch: 60, sample: 'C4v80' },
                { lokey: 63, hikey: 68, pitch: 66, sample: 'F#4v80' },
                { lokey: 69, hikey: 74, pitch: 72, sample: 'C5v80' },
                { lokey: 75, hikey: 80, pitch: 78, sample: 'F#5v80' },
                { lokey: 81, hikey: 86, pitch: 84, sample: 'C6v80' },
                { lokey: 87, hikey: 92, pitch: 90, sample: 'F#6v80' },
                { lokey: 93, hikey: 103, pitch: 96, sample: 'C7v80' },
            ],
        },
        // Spanish classical guitar (Roberto/FreePats, CC0) — freepats/spanish-classical-guitar
        // Near-fully chromatic (almost every note has its OWN recorded sample),
        // so pitch-shift is minimal/inaudible — highest realism of the two.
        guitar: {
            base: 'https://raw.githubusercontent.com/freepats/spanish-classical-guitar/main/samples/', ext: 'flac',
            regions: [
                { lokey: 29, hikey: 31, pitch: 31, sample: 'G1' }, { lokey: 32, hikey: 32, pitch: 32, sample: 'G#1' },
                { lokey: 33, hikey: 33, pitch: 33, sample: 'A1' }, { lokey: 34, hikey: 34, pitch: 34, sample: 'A#1' },
                { lokey: 35, hikey: 35, pitch: 35, sample: 'B1' }, { lokey: 36, hikey: 36, pitch: 36, sample: 'C2' },
                { lokey: 37, hikey: 37, pitch: 37, sample: 'C#2' }, { lokey: 38, hikey: 38, pitch: 38, sample: 'D2' },
                { lokey: 39, hikey: 39, pitch: 39, sample: 'D#2' }, { lokey: 40, hikey: 40, pitch: 40, sample: 'E2' },
                { lokey: 41, hikey: 41, pitch: 41, sample: 'F2' }, { lokey: 42, hikey: 43, pitch: 43, sample: 'G2' },
                { lokey: 44, hikey: 45, pitch: 45, sample: 'A2' }, { lokey: 46, hikey: 47, pitch: 47, sample: 'B2' },
                { lokey: 48, hikey: 48, pitch: 48, sample: 'C3' }, { lokey: 49, hikey: 50, pitch: 50, sample: 'D3' },
                { lokey: 51, hikey: 52, pitch: 52, sample: 'E3' }, { lokey: 53, hikey: 53, pitch: 53, sample: 'F3' },
                { lokey: 54, hikey: 54, pitch: 54, sample: 'F#3' }, { lokey: 55, hikey: 55, pitch: 55, sample: 'G3' },
                { lokey: 56, hikey: 56, pitch: 56, sample: 'G#3' }, { lokey: 57, hikey: 57, pitch: 57, sample: 'A3' },
                { lokey: 58, hikey: 58, pitch: 58, sample: 'A#3' }, { lokey: 59, hikey: 59, pitch: 59, sample: 'B3' },
                { lokey: 60, hikey: 60, pitch: 60, sample: 'C4' }, { lokey: 61, hikey: 61, pitch: 61, sample: 'C#4' },
                { lokey: 62, hikey: 62, pitch: 62, sample: 'D4' }, { lokey: 63, hikey: 63, pitch: 63, sample: 'D#4' },
                { lokey: 64, hikey: 64, pitch: 64, sample: 'E4' }, { lokey: 65, hikey: 65, pitch: 65, sample: 'F4' },
                { lokey: 66, hikey: 66, pitch: 66, sample: 'F#4' }, { lokey: 67, hikey: 67, pitch: 67, sample: 'G4' },
                { lokey: 68, hikey: 69, pitch: 69, sample: 'A4' }, { lokey: 70, hikey: 70, pitch: 70, sample: 'A#4' },
                { lokey: 71, hikey: 71, pitch: 71, sample: 'B4' }, { lokey: 72, hikey: 72, pitch: 72, sample: 'C5' },
                { lokey: 73, hikey: 73, pitch: 73, sample: 'C#5' }, { lokey: 74, hikey: 74, pitch: 74, sample: 'D5' },
                { lokey: 75, hikey: 75, pitch: 75, sample: 'D#5' }, { lokey: 76, hikey: 76, pitch: 76, sample: 'E5' },
                { lokey: 77, hikey: 77, pitch: 77, sample: 'F5' }, { lokey: 78, hikey: 78, pitch: 78, sample: 'F#5' },
                { lokey: 79, hikey: 79, pitch: 79, sample: 'G5' }, { lokey: 80, hikey: 80, pitch: 80, sample: 'G#5' },
                { lokey: 81, hikey: 81, pitch: 81, sample: 'A5' }, { lokey: 82, hikey: 82, pitch: 82, sample: 'A#5' },
                { lokey: 83, hikey: 83, pitch: 83, sample: 'B5' }, { lokey: 84, hikey: 88, pitch: 84, sample: 'C6' },
            ],
        },
        // Electric Guitar FSBS Bridge Clean (Andrea Biasior/FreePats, CC0) — freepats/e-guitar-FSBS-clean
        // Fender Stratocaster bridge pickup clean tone, chromatic from C2 to C#6.
        'guitar-clean': {
            base: 'https://raw.githubusercontent.com/freepats/e-guitar-FSBS-clean/main/samples/', ext: 'flac',
            regions: [
                { lokey: 35, hikey: 38,  pitch: 36, sample: 'C2_s1_01' },
                { lokey: 39, hikey: 40,  pitch: 40, sample: 'E2_s1_01' },
                { lokey: 41, hikey: 42,  pitch: 41, sample: 'F2_s1_01' },
                { lokey: 43, hikey: 46,  pitch: 45, sample: 'A2_s2_01' },
                { lokey: 47, hikey: 49,  pitch: 48, sample: 'C3_s2_01' },
                { lokey: 50, hikey: 51,  pitch: 50, sample: 'D3_s3_01' },
                { lokey: 52, hikey: 53,  pitch: 52, sample: 'E3_s3_01' },
                { lokey: 54, hikey: 56,  pitch: 55, sample: 'G3_s4_01' },
                { lokey: 57, hikey: 59,  pitch: 59, sample: 'B3_s5_01' },
                { lokey: 60, hikey: 62,  pitch: 61, sample: 'C#4_s5_01' },
                { lokey: 63, hikey: 65,  pitch: 64, sample: 'E4_s6_01' },
                { lokey: 66, hikey: 69,  pitch: 67, sample: 'G4_s6_01' },
                { lokey: 70, hikey: 71,  pitch: 71, sample: 'B4_s6_01' },
                { lokey: 72, hikey: 72,  pitch: 72, sample: 'C5_s6_01' },
                { lokey: 73, hikey: 75,  pitch: 74, sample: 'D5_s6_01' },
                { lokey: 76, hikey: 78,  pitch: 77, sample: 'F5_s6_01' },
                { lokey: 79, hikey: 81,  pitch: 80, sample: 'G#5_s6_01' },
                { lokey: 82, hikey: 83,  pitch: 82, sample: 'A#5_s6_01' },
                { lokey: 84, hikey: 127, pitch: 85, sample: 'C#6_s6_01' },
            ],
        },
    };
    function _sfzRegionFor(instrument, note) {
        const inst = _SFZ_INSTRUMENTS[instrument];
        if (!inst) return null;
        return inst.regions.find(r => note >= r.lokey && note <= r.hikey) || null;
    }
    // Warm the cache for every distinct sample file in an sfz instrument so
    // the full keyboard range is available offline/lag-free on first key press.
    function _prefetchSfzAllRegions(instrument) {
        const inst = _SFZ_INSTRUMENTS[instrument];
        if (!inst) return;
        const seen = new Set();
        for (const r of inst.regions) {
            const url = `${inst.base}${r.sample}.${inst.ext}`;
            if (!seen.has(url)) { seen.add(url); _getSfzSampleBuffer(instrument, r.lokey).catch(() => {}); }
        }
    }
    async function _getSfzSampleBuffer(instrument, note) {
        const region = _sfzRegionFor(instrument, note);
        if (!region) return null;
        const inst = _SFZ_INSTRUMENTS[instrument];
        const url = `${inst.base}${region.sample}.${inst.ext}`;
        if (_realSampleCache.has(url)) { _touchDecoded('real:' + url); return { buffer: _realSampleCache.get(url), pitch: region.pitch }; }
        const ctx = ensureAudioContext();
        try {
            const res = await fetch(url);
            if (!res.ok) return null;
            const buf = await res.arrayBuffer();
            const ab = await ctx.decodeAudioData(buf);
            _realSampleCache.set(url, ab);
            _trackDecoded('real:' + url, _bufBytes(ab), () => _realSampleCache.delete(url));
            return { buffer: ab, pitch: region.pitch };
        } catch (e) {
            console.warn('[XCaster] FreePats sample fetch failed, using procedural fallback:', url, e);
            return null;
        }
    }

    // Plays a note directly from the sfz instrument's region table — used for
    // keyboard notes that aren't mapped to any pad, bypassing the 16-pad
    // nearest-neighbor pitch-stretch so every semitone sounds accurate.
    async function _playSfzNote(instrument, note) {
        if (!sbBus) { try { await ensureProcessedStream(); } catch {} }
        const res = await _getSfzSampleBuffer(instrument, note);
        if (!res || !sbSourceBus) {
            // Cache miss / offline — try nearest-pad fallback so there's always some sound
            const melodic = _melodicPadForNote(note);
            if (melodic) playPadPitched(melodic.index, note - melodic.baked);
            return;
        }
        const ctx = ensureAudioContext();
        const src = ctx.createBufferSource();
        src.buffer = res.buffer;
        src.playbackRate.value = Math.pow(2, (note - res.pitch) / 12);
        const vol = ctx.createGain();
        // Inherit volume from whichever pad's sfzNote is nearest — consistent with kit level
        const refPad = settings.sbPads.reduce((best, p, i) => {
            if (!p?.sfzNote) return best;
            const d = Math.abs(p.sfzNote - note);
            return (best === null || d < best.d) ? { d, v: p.volume ?? 0.8 } : best;
        }, null);
        vol.gain.value = refPad?.v ?? 0.8;
        src.connect(vol); vol.connect(sbSourceBus);
        src.start();
    }

    const TR808_BASE = 'https://smpldsnds.github.io/drum-machines/tr-808/';
    const LM2_BASE    = 'https://smpldsnds.github.io/drum-machines/lm-2/';
    const RZ1_BASE    = 'https://smpldsnds.github.io/drum-machines/casio-rz1/';

    // ── WebAudioFont GM instruments (surikov/webaudiofontdata) ───────────────
    // ~1 400 instruments across all 128 GM programs (5-10 soundfont variants
    // each), served as JS files that embed base64-encoded OGG zone samples.
    // We fetch as plain text and extract the audio data with regex — no eval(),
    // no script injection. Decoded AudioBuffers are cached so each instrument
    // is downloaded only once per session.
    const _WAF_BASE = 'https://surikov.github.io/webaudiofontdata/sound/';
    const _wafZoneCache = new Map(); // url → [{lokey,hikey,pitch,buffer}]
    // Build WAF file URL: MIDI program × 10, zero-padded to 4 digits.
    const _wafUrl = prog => `${_WAF_BASE}${String(prog * 10).padStart(4,'0')}_FluidR3_GM_sf2_file.js`;

    async function _fetchWAFZones(url) {
        if (_wafZoneCache.has(url)) { _touchDecoded('waf:' + url); return _wafZoneCache.get(url); }
        const loadKey = url + ':loading';
        if (_wafZoneCache.has(loadKey)) return _wafZoneCache.get(loadKey);
        const prom = (async () => {
            try {
                const res = await fetch(url);
                if (!res.ok) { console.warn('[XCaster] WAF fetch', res.status, url); _wafZoneCache.set(url, null); _wafZoneCache.delete(loadKey); return null; }
                const text = await res.text();
                const ctx = ensureAudioContext();
                const zones = [];
                // Each WAF zone: {keyRangeLow:N, keyRangeHigh:N, originalPitch:N (centitones), ..., file:"data:audio/...;base64,..."}
                const fileRe = /"file"\s*:\s*"data:audio[^;]*;base64,([^"]+)"/g;
                let m;
                while ((m = fileRe.exec(text)) !== null) {
                    const before = text.slice(Math.max(0, m.index - 400), m.index);
                    const lo    = +(/keyRangeLow\s*:\s*(\d+)/.exec(before)?.[1]    ?? 0);
                    const hi    = +(/keyRangeHigh\s*:\s*(\d+)/.exec(before)?.[1]   ?? 127);
                    const raw   = +(/originalPitch\s*:\s*(\d+)/.exec(before)?.[1]  ?? 6000);
                    const pitch = Math.round(raw / 100);
                    try {
                        // WAF data URIs sometimes contain embedded newlines/spaces in the base64 — strip them.
                        const b64 = m[1].replace(/\s+/g, '');
                        const bin = atob(b64);
                        const buf = new ArrayBuffer(bin.length);
                        const view = new Uint8Array(buf);
                        for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
                        const ab = await ctx.decodeAudioData(buf);
                        zones.push({ lokey: lo, hikey: hi, pitch, buffer: ab });
                    } catch (e) { console.warn('[XCaster] WAF zone decode:', e?.message, lo, hi); }
                }
                if (zones.length) {
                    _wafZoneCache.set(url, zones); _wafZoneCache.delete(loadKey);
                    // A GM instrument is many multisampled zones — the single
                    // biggest contributor to the old unbounded growth.
                    let bytes = 0;
                    for (const z of zones) bytes += _bufBytes(z.buffer);
                    _trackDecoded('waf:' + url, bytes, () => _wafZoneCache.delete(url));
                    return zones;
                }
                console.warn('[XCaster] WAF no zones decoded from', url);
            } catch (e) { console.warn('[XCaster] WAF error:', e?.message, url); }
            _wafZoneCache.set(url, null); // cache null so we don't re-fetch a broken URL
            _wafZoneCache.delete(loadKey);
            return null;
        })();
        _wafZoneCache.set(loadKey, prom);
        return prom;
    }

    async function _getWAFBuffer(url, note) {
        const zones = await _fetchWAFZones(url);
        if (!zones) return null;
        const zone = zones.find(z => note >= z.lokey && note <= z.hikey);
        if (!zone) return null;
        return { buffer: zone.buffer, pitch: zone.pitch };
    }

    async function _playWAFNote(url, note) {
        if (!sbBus) { try { await ensureProcessedStream(); } catch {} }
        const res = await _getWAFBuffer(url, note);
        if (!res || !sbSourceBus) return;
        const ctx = ensureAudioContext();
        const src = ctx.createBufferSource();
        src.buffer = res.buffer;
        src.playbackRate.value = Math.pow(2, (note - res.pitch) / 12);
        const vol = ctx.createGain();
        vol.gain.value = settings.sbPads.reduce((v, p) => p?.wafNote != null ? (p.volume ?? 0.8) : v, 0.8);
        src.connect(vol); vol.connect(sbSourceBus);
        src.start();
    }


    // Google's public "Sound Library" CDN (used by Actions on Google) — real
    // recorded royalty-free effects, served with Access-Control-Allow-Origin: *
    // so they can be fetched directly from the page. Used for the handful of
    // SFX pads that have a genuine real-recording equivalent; effects with no
    // good match (e.g. a cartoonish game-show "buzzer") stay procedural.
    const SFX_BASE = 'https://actions.google.com/sounds/v1/';

    // 16-pad kits — each entry becomes one pad's { builtin, name, sample? }.
    // `sample` (when present) is a real recorded drum-machine hit that's tried
    // first; `builtin` is the procedurally-synthesized sound used as a fallback.
    const _SOUND_KITS = {
        drums: [
            ['kick','Kick', LM2_BASE+'kick'],['kick2','Kick 2', LM2_BASE+'kick-alt'],
            ['snare','Snare', LM2_BASE+'snare-h'],['rim','Rimshot', LM2_BASE+'stick-h'],
            ['hihat_closed','HH Closed', LM2_BASE+'hhclosed'],['hihat_open','HH Open', LM2_BASE+'hhopen'],
            ['hihat_pedal','HH Pedal', LM2_BASE+'hhclosed-short'],['clap','Clap', LM2_BASE+'clap'],
            ['tomlo','Tom Lo', LM2_BASE+'tom-l'],['tommid','Tom Mid', LM2_BASE+'tom-m'],['tomhi','Tom Hi', LM2_BASE+'tom-h'],
            ['crash','Crash', LM2_BASE+'crash'],['ride','Ride', LM2_BASE+'ride'],['cowbell','Cowbell', LM2_BASE+'cowbell'],
            ['shaker','Shaker', LM2_BASE+'cabasa'],['stick','Stick', LM2_BASE+'stick-l'],
        ].map(([s, n, u]) => ({ builtin: s, name: n, sample: u })),
        '808': [
            ['kick808','808 Kick', TR808_BASE+'kick/bd5000'],['kick808b','808 Kick Long', TR808_BASE+'kick/bd2500'],
            ['snare808','808 Snare', TR808_BASE+'snare/sd5000'],['clap808','808 Clap', TR808_BASE+'clap/cp'],
            ['noise1:highpass:4000::0.08:0.045','808 Rim', TR808_BASE+'rimshot/rs'],
            ['noise1:highpass:8000::0.06:0.045','HH Closed', TR808_BASE+'hihat-close/ch'],
            ['noise1:highpass:7000::0.55:0.45','HH Open', TR808_BASE+'hihat-open/oh50'],
            ['roll:highpass:7500::0.9:0.07','HH Roll'],
            ['thump:180:80:0.4:0.32','Tom Lo', TR808_BASE+'tom-low/lt50'],
            ['thump:240:120:0.35:0.28','Tom Mid', TR808_BASE+'mid-tom/mt50'],
            ['thump:320:160:0.3:0.24','Tom Hi', TR808_BASE+'tom-hi/ht50'],
            ['thump:760:540:0.28:0.26','808 Cowbell', TR808_BASE+'cowbell/cb'],
            ['noise1:highpass:6000::0.18:0.13','Shaker', TR808_BASE+'maraca/ma'],
            ['noise1:highpass:5500::1.4:1.2','Crash', TR808_BASE+'cymbal/cy5050'],
            ['roll:bandpass:2000:3000:0.8:0.07','Snare Roll'],['subdrop','Sub Drop'],
        ].map(([s, n, u]) => ({ builtin: s, name: n, sample: u })),
        lofi: [
            ['thump:120:38:0.5:0.34','Lofi Kick', RZ1_BASE+'kick'],['thump:95:30:0.6:0.42','Lofi Kick 2'],
            ['noise1:lowpass:1800::0.3:0.22','Lofi Snare', RZ1_BASE+'snare'],['claplike:900:1600:0.34','Lofi Clap', RZ1_BASE+'clap'],
            ['noise1:lowpass:3000::0.09:0.05','Lofi Rim', RZ1_BASE+'clave'],['noise1:lowpass:3800::0.08:0.06','HH Closed', RZ1_BASE+'hihat-closed'],
            ['noise1:lowpass:3200::0.5:0.4','HH Open', RZ1_BASE+'hihat-open'],['roll:lowpass:3500::0.9:0.08','HH Roll'],
            ['thump:160:70:0.42:0.34','Tom Lo', RZ1_BASE+'tom-1'],['thump:210:105:0.36:0.3','Tom Mid', RZ1_BASE+'tom-2'],
            ['thump:280:140:0.3:0.26','Tom Hi', RZ1_BASE+'tom-3'],
            ['thump:620:440:0.3:0.28','Lofi Cowbell', RZ1_BASE+'cowbell'],['noise1:lowpass:3600::0.2:0.15','Shaker'],
            ['noise1:lowpass:3200::1.3:1.1','Crash', RZ1_BASE+'crash'],['roll:lowpass:2400::0.8:0.08','Snare Roll'],['thump:80:22:1.2:1.0','Sub Drop'],
        ].map(([s, n, u]) => ({ builtin: s, name: n, sample: u })),
        piano: Array.from({ length: 16 }, (_, i) => { const m = 60 + i; return { builtin: `piano:${m}`, name: _midiToName(m), sfzInstrument: 'piano', sfzNote: m }; }),
        guitar: Array.from({ length: 16 }, (_, i) => { const m = 40 + i; return { builtin: `guitar:${m}`, name: _midiToName(m), sfzInstrument: 'guitar', sfzNote: m }; }),
        sfx: [
            ['clap','Clap', SFX_BASE+'foley/hand_claps_close'],
            ['cheer','Cheer', SFX_BASE+'crowds/team_cheer'],
            ['applause','Applause'],
            ['airhorn','Airhorn', SFX_BASE+'transportation/air_horn_in_close_hall_series'],
            ['drumroll','Drumroll', SFX_BASE+'cartoon/drum_roll'],
            ['rimshot','Rimshot'],
            ['boo','Boo'],
            ['confetti','Confetti'],
            ['laugh','Laugh', SFX_BASE+'human_voices/man_laugh_and_knee_slap'],
            ['gasp','Gasp'],
            ['whistle','Whistle', SFX_BASE+'cartoon/slide_whistle'],
            ['buzzer','Buzzer'],
            ['bell','Bell', SFX_BASE+'alarms/medium_bell_ringing_near'],
            ['crickets','Crickets'],
            ['thud','Thud', SFX_BASE+'impacts/metal_thud'],
            ['pop','Pop', SFX_BASE+'cartoon/pop'],
        ].map(([s, n, u]) => ({ builtin: `sfx:${s}`, name: n, sample: u || null })),
        synthkeys: Array.from({ length: 16 }, (_, i) => { const m = 60 + i; return { builtin: `synthkeys:${m}`, name: _midiToName(m) }; }),
        // Guitar - Electric Clean (FreePats, CC0)
        'guitar-clean': Array.from({ length: 16 }, (_, i) => { const m = 40 + i; return { builtin: `guitar:${m}`, name: _midiToName(m), sfzInstrument: 'guitar-clean', sfzNote: m }; }),
        // ── WebAudioFont GM kits — fetched lazily, no eval, FluidR3 soundfont ──
        // Helper: 16 pads for a GM MIDI program starting at startNote.
        ...(function() {
            const waf = (prog, start, label, low) => Array.from({ length: 16 }, (_, i) => {
                const m = start + i;
                return { builtin: `piano:${m}`, name: _midiToName(m), wafUrl: _wafUrl(prog), wafNote: m };
            });
            return {
                // Keys
                'piano-bright':   waf(1,  60),
                'epiano1':        waf(4,  60),
                'epiano2':        waf(5,  60),
                'harpsichord':    waf(6,  48),
                'organ-rock':     waf(18, 48),
                'organ-church':   waf(19, 48),
                'organ-drawbar':  waf(16, 48),
                'accordion':      waf(21, 48),
                // Guitar family
                'guitar-nylon':   waf(24, 40),
                'guitar-steel':   waf(25, 40),
                'guitar-jazz':    waf(26, 40),
                'guitar-overdrive': waf(29, 40),
                'guitar-distortion': waf(30, 40),
                // Bass
                'bass-acoustic':  waf(32, 28),
                'bass-electric':  waf(33, 28),
                'bass-fretless':  waf(35, 28),
                'bass-slap':      waf(36, 28),
                'bass-synth1':    waf(38, 28),
                'bass-synth2':    waf(39, 28),
                // Strings
                'violin':         waf(40, 55),
                'viola':          waf(41, 48),
                'cello':          waf(42, 36),
                'harp':           waf(46, 41),
                'strings':        waf(48, 48),
                'strings-synth':  waf(50, 48),
                // Brass
                'trumpet':        waf(56, 52),
                'trombone':       waf(57, 40),
                'french-horn':    waf(60, 40),
                'brass-section':  waf(61, 48),
                'synth-brass':    waf(62, 48),
                // Winds/Reed
                'sax-soprano':    waf(64, 54),
                'sax-alto':       waf(65, 46),
                'sax-tenor':      waf(66, 44),
                'flute':          waf(73, 60),
                'clarinet':       waf(71, 50),
                'oboe':           waf(68, 58),
                // World/Ethnic
                'banjo':          waf(105, 48),
                'sitar':          waf(104, 48),
                'koto':           waf(107, 55),
                'kalimba':        waf(108, 57),
                'fiddle':         waf(110, 55),
                'shanai':         waf(111, 48),
                // Synth Pads & Leads
                'pad-new-age':    waf(88, 48),
                'pad-warm':       waf(89, 48),
                'pad-choir':      waf(91, 48),
                'pad-metallic':   waf(93, 48),
                'synth-lead-sq':  waf(80, 48),
                'synth-lead-saw': waf(81, 48),
                'synth-lead-chiff': waf(83, 48),
            };
        })(),
        // Acoustic drum kit (FreePats muldjordkit, CC BY 4.0)
        // Real acoustic kit recorded with multiple round-robins and velocity layers.
        // We use one representative mid-velocity sample per voice for pad triggering.
        muldjordkit: (() => {
            const BASE = 'https://raw.githubusercontent.com/freepats/muldjordkit/main/samples/';
            return [
                { builtin: 'kick',      name: 'Kick',       sample: BASE+'KdrumL/13-KdrumL.flac' },
                { builtin: 'kick2',     name: 'Kick 2',     sample: BASE+'KdrumR/13-KdrumR.flac' },
                { builtin: 'snare',     name: 'Snare 1',    sample: BASE+'Snare1/30-Snare.flac' },
                { builtin: 'rim',       name: 'Snare 2',    sample: BASE+'Snare2/30-Snare.flac' },
                { builtin: 'hihat_closed', name: 'HH Closed', sample: BASE+'HihatClosed/14-HihatClosed.flac' },
                { builtin: 'hihat_open',   name: 'HH Open',   sample: BASE+'HihatOpen/12-HihatOpen.flac' },
                { builtin: 'hihat_pedal',  name: 'Ride',      sample: BASE+'RideL/5-RideL.flac' },
                { builtin: 'clap',         name: 'Ride Bell', sample: BASE+'RideLBell/2-RideLBell.flac' },
                { builtin: 'crash',        name: 'Crash L',   sample: BASE+'CrashL/5-CrashL.flac' },
                { builtin: 'ride',         name: 'Crash R',   sample: BASE+'CrashR/5-CrashR.flac' },
                { builtin: 'cowbell',      name: 'China',     sample: BASE+'China/6-China.flac' },
                { builtin: 'tomlo',        name: 'Tom 1',     sample: BASE+'Tom1/5-Tom1.flac' },
                { builtin: 'tommid',       name: 'Tom 2',     sample: BASE+'Tom2/5-Tom2.flac' },
                { builtin: 'tomhi',        name: 'Tom 3',     sample: BASE+'Tom3/6-Tom3.flac' },
                { builtin: 'shaker',       name: 'Tom 4',     sample: BASE+'Tom4/10-Tom4.flac' },
                { builtin: 'stick',        name: 'Brush Snr', sample: BASE+'SnareRest1/6-SnareRest.flac' },
            ];
        })(),
    };


    function loadKit(kitName) {
        const kit = _SOUND_KITS[kitName];
        if (!kit) return;
        const PAD_COLORS = ['#2563eb','#6366f1','#d97706','#059669','#7c3aed','#dc2626','#0891b2','#65a30d',
                            '#1d4ed8','#4f46e5','#b45309','#047857','#6d28d9','#b91c1c','#0369a1','#4d7c0f'];
        for (let i = 0; i < 16; i++) {
            stopPad(i);
            _padBufferCache.delete(i);
            _padSamplePitch.delete(i);
            const item = kit[i];
            settings.sbPads[i] = {
                name: item.name, midiNote: 36 + i, volume: 0.8,
                color: PAD_COLORS[i], loop: false, builtin: item.builtin,
                sample: item.sample || null,
                sfzInstrument: item.sfzInstrument || null,
                sfzNote: item.sfzNote != null ? item.sfzNote : null,
                wafUrl: item.wafUrl || null,
                wafNote: item.wafNote != null ? item.wafNote : null,
            };
        }
        saveSettings(settings);
        _refreshPadGridUI();
        _prefetchRealSamples(settings.sbPads); // warm 16-pad real-sample cache
        const fp = settings.sbPads[0];
        if (fp?.sfzInstrument) _prefetchSfzAllRegions(fp.sfzInstrument);
        else if (fp?.wafUrl) _fetchWAFZones(fp.wafUrl).catch(() => {});
    }

    // ── IndexedDB pad storage (audio files persist across sessions) ──────────
    const _padDB = (() => {
        let _db = null;
        const open = () => new Promise((res,rej) => {
            if (_db) return res(_db);
            const r = indexedDB.open('xcaster-soundboard', 1);
            r.onupgradeneeded = e => e.target.result.createObjectStore('pads',{keyPath:'id'});
            r.onsuccess = e => { _db = e.target.result; res(_db); };
            r.onerror = e => rej(e.target.error);
        });
        return {
            put: async (id, buf, name) => { const db=await open(); return new Promise((res,rej)=>{ const tx=db.transaction('pads','readwrite'); tx.objectStore('pads').put({id,buf,name}); tx.oncomplete=res; tx.onerror=e=>rej(e.target.error); }); },
            get: async (id)         => { const db=await open(); return new Promise((res,rej)=>{ const tx=db.transaction('pads','readonly'); const r=tx.objectStore('pads').get(id); r.onsuccess=e=>res(e.target.result||null); r.onerror=e=>rej(e.target.error); }); },
            del: async (id)         => { const db=await open(); return new Promise((res,rej)=>{ const tx=db.transaction('pads','readwrite'); tx.objectStore('pads').delete(id); tx.oncomplete=res; tx.onerror=e=>rej(e.target.error); }); },
        };
    })();

    const _padBufferCache = new Map(); // padIndex → AudioBuffer
    const _padSources     = new Map(); // padIndex → AudioBufferSourceNode
    const _padSamplePitch = new Map(); // padIndex → recorded MIDI pitch of a real-instrument sample (sfzInstrument pads only)

    async function loadPadBuffer(index) {
        if (_padBufferCache.has(index)) return _padBufferCache.get(index);
        const pad = settings.sbPads[index];
        if (pad?.wafUrl && pad?.wafNote != null) {
            const res = await _getWAFBuffer(pad.wafUrl, pad.wafNote);
            if (res) { _padBufferCache.set(index, res.buffer); _padSamplePitch.set(index, res.pitch); return res.buffer; }
        }
        if (pad?.sfzInstrument && pad?.sfzNote != null) {
            const res = await _getSfzSampleBuffer(pad.sfzInstrument, pad.sfzNote);
            if (res) { _padBufferCache.set(index, res.buffer); _padSamplePitch.set(index, res.pitch); return res.buffer; }
            // Network/decode failed (e.g. offline mid-show) — fall through to
            // the procedural builtin sound below so the pad still makes noise.
        }
        if (pad?.sample) {
            const ab = await _getRealSampleBuffer(pad.sample);
            if (ab) { _padBufferCache.set(index, ab); return ab; }
            // Network/decode failed (e.g. offline mid-show) — fall through to
            // the procedural builtin sound below so the pad still makes noise.
        }
        if (pad?.builtin) {
            const ab = await _getBuiltinBuffer(pad.builtin);
            if (ab) _padBufferCache.set(index, ab);
            return ab;
        }
        const rec = await _padDB.get(`pad-${index}`);
        if (!rec) return null;
        const ctx = ensureAudioContext();
        try {
            const ab = await ctx.decodeAudioData(rec.buf.slice(0));
            _padBufferCache.set(index, ab);
            return ab;
        } catch (e) { console.warn('[XCaster] pad decode failed', index, e); return null; }
    }

    async function playPad(index) {
        // The Sounds channel shares the main mixer graph (sbBus) with mic/aux.
        // If the user hasn't joined a Space / granted mic access yet, that
        // graph doesn't exist — build it now so pads actually produce sound.
        if (!sbBus) { try { await ensureProcessedStream(); } catch {} }
        const ab = await loadPadBuffer(index);
        if (!ab || !sbBus) return;
        stopPad(index);
        const ctx = ensureAudioContext();
        const src = ctx.createBufferSource();
        src.buffer = ab;
        const pad = settings.sbPads[index];
        const pitch = _padSamplePitch.get(index);
        // Real-instrument pads (piano/guitar) recorded a nearby note rather
        // than the pad's own note — pitch-shift to land exactly on pitch.
        if (pitch != null && pad?.sfzNote != null) src.playbackRate.value = Math.pow(2, (pad.sfzNote - pitch) / 12);
        const vol = ctx.createGain();
        vol.gain.value = pad?.volume ?? 0.8;
        src.loop = !!(pad?.loop);
        src.connect(vol); vol.connect(sbSourceBus);
        src.start();
        src.onended = () => { if (_padSources.get(index)===src) _padSources.delete(index); _paintPadState(index,false); };
        _padSources.set(index, src);
        _paintPadState(index, true);
    }

    function stopPad(index) {
        const src = _padSources.get(index);
        if (src) { try { src.stop(); } catch {} _padSources.delete(index); }
        _paintPadState(index, false);
    }

    function stopAllPads() { for (let i=0;i<16;i++) stopPad(i); }

    // Melodic kits (Piano/Guitar/Synth keys) render each of the 16 pads at a
    // fixed baked-in MIDI note (see the piano/guitar/synthkeys entries in
    // _SOUND_KITS), but pads only ever TRIGGER from midiNote 36-51 — so
    // shifting a MIDI keyboard's octave (+/-) outside that fixed 16-note
    // range used to produce silence for these kits, even though "Enable
    // synth" worked fine at any octave. This extends melodic kits across the
    // WHOLE keyboard: find whichever pad's baked note is closest to the note
    // actually played, and pitch-shift its rendered buffer (via playbackRate)
    // by the semitone difference — the same trick a basic sampler uses to
    // cover a full keyboard from one recorded note.
    function _melodicPadForNote(note) {
        let best = null, bestDist = Infinity;
        for (let i = 0; i < 16; i++) {
            const m = /^(?:piano|guitar|synthkeys):(\d+)$/.exec(settings.sbPads[i]?.builtin || '');
            if (!m) continue;
            const baked = +m[1];
            const dist = Math.abs(baked - note);
            if (dist < bestDist) { bestDist = dist; best = { index: i, baked }; }
        }
        return best;
    }

    async function playPadPitched(index, semitones) {
        if (!sbBus) { try { await ensureProcessedStream(); } catch {} }
        const ab = await loadPadBuffer(index);
        if (!ab || !sbSourceBus) return;
        const ctx = ensureAudioContext();
        const src = ctx.createBufferSource();
        src.buffer = ab;
        const pad = settings.sbPads[index];
        const pitch = _padSamplePitch.get(index);
        if (pitch != null && pad?.sfzNote != null) {
            // Real-instrument pad: compute the shift straight from the actual
            // recorded pitch to the actual target note, not from the pad's own
            // (possibly already-shifted) baked note.
            src.playbackRate.value = Math.pow(2, (pad.sfzNote + semitones - pitch) / 12);
        } else {
            src.playbackRate.value = Math.pow(2, semitones / 12);
        }
        const vol = ctx.createGain();
        vol.gain.value = settings.sbPads[index]?.volume ?? 0.8;
        src.connect(vol); vol.connect(sbSourceBus);
        src.start();
    }

    function _paintPadState(index, playing) {
        const btn = document.querySelector(`[data-pad="${index}"]`);
        if (btn) btn.classList.toggle('xfw-pad-playing', playing);
    }

    // Refresh all 16 pad buttons' label/color/loaded-state from settings.sbPads
    // (used after loading a built-in kit, since the grid itself is built once).
    function _refreshPadGridUI() {
        for (let i = 0; i < 16; i++) {
            const pad = settings.sbPads[i];
            const btn = document.querySelector(`[data-pad="${i}"]`);
            if (!btn || !pad) continue;
            btn.style.setProperty('--pad-color', pad.color);
            btn.title = `${pad.name} (MIDI: ${pad.midiNote})`;
            const nameEl = btn.querySelector('.xfw-pad-name');
            if (nameEl) nameEl.textContent = pad.name;
            btn.classList.toggle('xfw-pad-loaded', !!(pad.builtin));
        }
        // Refresh the editor if it's open on one of these pads.
        const editor = document.getElementById('xfw-pad-editor');
        if (editor && editor.style.display !== 'none' && typeof window.__xcOpenPadEditor === 'function' && editor.dataset.padIndex !== undefined) {
            window.__xcOpenPadEditor(+editor.dataset.padIndex);
        }
    }

    // ── Synthesizer (polyphonic, MIDI-driven) ─────────────────────────────────
    const _SYNTH_VOICES = 8;
    let _synthVoices = [], _synthCtx = null, _synthDest = null;

    function initSynth() {
        const ctx = ensureAudioContext();
        if (_synthCtx === ctx && _synthDest && _synthVoices.length) return;
        _synthCtx = ctx;
        _synthVoices.forEach(v => { try { v.osc.stop(); } catch {} });
        _synthVoices = [];
        if (_synthDest) { try { _synthDest.disconnect(); } catch {} }
        _synthDest = ctx.createGain();
        _synthDest.gain.value = 1.0;
        if (sbSourceBus) _synthDest.connect(sbSourceBus);
        for (let i=0;i<_SYNTH_VOICES;i++) {
            const osc=ctx.createOscillator(), flt=ctx.createBiquadFilter(), gain=ctx.createGain();
            flt.type='lowpass'; flt.frequency.value=settings.synthFilterHz; flt.Q.value=settings.synthFilterQ;
            gain.gain.value=0; osc.type=settings.synthWave;
            osc.connect(flt); flt.connect(gain); gain.connect(_synthDest); osc.start();
            _synthVoices.push({osc,flt,gain,note:-1,startTime:0});
        }
    }

    function synthNoteOn(midiNote, velocity=100) {
        if (!settings.synthEnabled) return;
        if (!sbBus) { ensureProcessedStream().catch(()=>{}); return; } // graph not ready yet — next note-on will work
        initSynth();
        const ctx=_synthCtx;
        const note=midiNote + settings.synthOctave*12;
        const freq=440*Math.pow(2,(note-69)/12);
        const vel=settings.midiVelocitySensitive?(velocity/127):1.0;
        let v=_synthVoices.find(v=>v.note<0)||_synthVoices.reduce((a,b)=>a.startTime<b.startTime?a:b);
        v.note=note; v.startTime=ctx.currentTime;
        v.osc.type=settings.synthWave;
        v.osc.frequency.setValueAtTime(freq, ctx.currentTime);
        v.flt.frequency.setValueAtTime(settings.synthFilterHz, ctx.currentTime);
        v.flt.Q.setValueAtTime(settings.synthFilterQ, ctx.currentTime);
        const peak=vel*dbToLin(settings.synthGainDb);
        const atk=settings.synthAttackMs/1000, dec=settings.synthDecayMs/1000, now=ctx.currentTime;
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setValueAtTime(0,now);
        v.gain.gain.linearRampToValueAtTime(peak, now+atk);
        v.gain.gain.linearRampToValueAtTime(peak*settings.synthSustain, now+atk+dec);
    }

    function synthNoteOff(midiNote) {
        if (!_synthCtx) return;
        const note=midiNote+settings.synthOctave*12, ctx=_synthCtx;
        const rel=settings.synthReleaseMs/1000;
        _synthVoices.filter(v=>v.note===note).forEach(v=>{
            v.note=-1;
            const now=ctx.currentTime;
            v.gain.gain.cancelScheduledValues(now);
            v.gain.gain.setValueAtTime(v.gain.gain.value,now);
            v.gain.gain.linearRampToValueAtTime(0,now+rel);
        });
    }

    function synthAllNotesOff() { for(let i=0;i<128;i++) synthNoteOff(i); }

    // ── MIDI note capture (Piano Roll view) ─────────────────────────────────
    // Tracks every note actually played (after the channel filter, so it only
    // reflects real activity) so the Piano Roll popup has something to draw:
    // a rolling "live" buffer for the always-on view, plus each loop track's
    // own note list captured only while that track is recording/overdubbing
    // (relative to that track's own recording start, so it lines up with the
    // recorded audio's bar 1 beat 1).
    const _activeNoteOnTimes = new Map(); // note -> { t: ctx.currentTime, vel }
    const _liveMidiEvents = [];           // { note, on, off, vel } in ctx.currentTime seconds
    const _LIVE_MIDI_KEEP_SEC = 60;       // don't let this grow unbounded

    function _midiCaptureNoteOn(note, vel) {
        _activeNoteOnTimes.set(note, { t: ensureAudioContext().currentTime, vel });
    }
    function _midiCaptureNoteOff(note) {
        const on = _activeNoteOnTimes.get(note);
        if (!on) return;
        _activeNoteOnTimes.delete(note);
        const off = ensureAudioContext().currentTime;
        _liveMidiEvents.push({ note, on: on.t, off, vel: on.vel });
        const cutoff = off - _LIVE_MIDI_KEEP_SEC;
        while (_liveMidiEvents.length && _liveMidiEvents[0].off < cutoff) _liveMidiEvents.shift();
        // Feed whichever track(s) are currently capturing, relative to their own start.
        for (let i = 0; i < _LOOP_LAYERS; i++) {
            const L = _loops[i];
            if (!L || (L.state !== 'recording' && L.state !== 'overdubbing') || L.recordStartCtxTime == null) continue;
            if (on.t < L.recordStartCtxTime) continue;
            L.midiEvents.push({ note, on: on.t - L.recordStartCtxTime, off: off - L.recordStartCtxTime, vel: on.vel });
        }
    }

    // ── MIDI ──────────────────────────────────────────────────────────────────
    let _midiAccess = null;

    async function initMIDI() {
        if (!navigator.requestMIDIAccess) { console.warn('[XCaster] Web MIDI not available'); return; }
        // Idempotent: re-requesting MIDIAccess every time a Learn button is
        // clicked (on top of the one requested when the Sounds tab first opens)
        // used to re-run the whole permission handshake and re-attach a second
        // statechange listener each time. Skip straight to a listener refresh if
        // we already have a live access object — avoids any redundant
        // reconnection glitch that could interrupt note/CC delivery to _onMIDIMsg.
        if (_midiAccess) { _rebuildMIDIListeners(); paintMIDIDevices(); return; }
        try {
            _midiAccess = await navigator.requestMIDIAccess({sysex:false});
            _midiAccess.addEventListener('statechange', () => { _rebuildMIDIListeners(); paintMIDIDevices(); });
            _rebuildMIDIListeners();
            paintMIDIDevices();
        } catch(e) { console.warn('[XCaster] MIDI denied', e); }
    }

    function _rebuildMIDIListeners() {
        if (!_midiAccess) return;
        _midiAccess.inputs.forEach(inp => {
            inp.onmidimessage = _onMIDIMsg;
            // Assigning onmidimessage should implicitly open the port per spec, but
            // explicitly opening it too is a harmless safety net for controllers/
            // drivers that don't reliably auto-open (port stays "pending"/"closed"
            // otherwise and silently never delivers messages).
            if (typeof inp.open === 'function') inp.open().catch(() => {});
        });
    }

    function _onMIDIMsg(msg) {
        const [status, note, val] = msg.data;
        if (status >= 0xf0) return; // ignore system real-time bytes (clock/active-sensing/sysex)
        const type=status&0xf0, chan=(status&0x0f)+1;
        // Always-on raw monitor (fires BEFORE the channel filter and BEFORE any
        // MIDI-Learn swallow) so the Sounds panel can prove whether hardware
        // messages are even reaching the app, and on which channel, no matter
        // what else is going on — the quickest way to diagnose "nothing happens".
        _reportRawMidi(type, chan, note, val);
        if (settings.midiChannel>0 && chan!==settings.midiChannel) return;
        if (type===0x90 && val>0) {
            // MIDI Learn: next note-on is captured by the pad editor / transport Learn instead of playing.
            if (typeof window.__xcMidiLearn === 'function' && window.__xcMidiLearn('note', note)) return;
            const pi=settings.sbPads.findIndex(p=>p&&p.midiNote===note);
            // A note that's mapped to a pad ALWAYS plays that pad — never treated as
            // a hardware Record/Play transport trigger. This guarantees a bad/stray
            // Record-Play mapping (e.g. accidentally learned from a pad note instead
            // of the controller's actual transport button) can never hijack pad
            // playback again, regardless of what got learned.
            if (pi < 0) {
                // Hardware Record/Play transport buttons (e.g. Launchkey Mini), if mapped.
                if (_matchesTransport(settings.midiRecordMap, 'note', note)) { _loopRecordToggleFromMIDI(); return; }
                if (_matchesTransport(settings.midiPlayMap, 'note', note)) { _loopPlayToggleFromMIDI(); return; }
            }
            // Note On — pad selection is the main trigger. "Enable synth" layers a
            // synth tone as an EFFECT on top of whatever pad/key you hit (or plays
            // alone if the note isn't mapped to a pad). synthNoteOn() already no-ops
            // when settings.synthEnabled is off, so this is safe either way.
            if (pi>=0) {
                const p = settings.sbPads[pi];
                // Melodic kits (WAF/SFZ): play the actual MIDI note received so the
                // full keyboard is chromatic — pad layout stays as a visual guide only.
                if (p?.wafUrl) {
                    _playWAFNote(p.wafUrl, note);
                    _paintPadState(pi, true);
                    setTimeout(() => { if (!_padSources.has(pi)) _paintPadState(pi, false); }, 200);
                } else if (p?.sfzInstrument && _SFZ_INSTRUMENTS[p.sfzInstrument]) {
                    _playSfzNote(p.sfzInstrument, note);
                    _paintPadState(pi, true);
                    setTimeout(() => { if (!_padSources.has(pi)) _paintPadState(pi, false); }, 200);
                } else {
                    playPad(pi); // drums/sample kits — use the assigned hit
                }
            } else {
                // No pad is mapped to this exact note. For real-sample melodic
                // kits (piano/guitar) fetch the exact SFZ region for this note
                // and play it at the correct pitch — no 16-pad nearest-neighbor
                // stretch, so every semitone across the full keyboard sounds right.
                // For procedural kits (synthkeys, custom) fall back to the old
                // nearest-pad pitch-shift path.
                const sfzKit = settings.sbPads[0]?.sfzInstrument;
                const wafKit = settings.sbPads[0]?.wafUrl;
                if (sfzKit && _SFZ_INSTRUMENTS[sfzKit]) {
                    _playSfzNote(sfzKit, note);
                } else if (wafKit) {
                    _playWAFNote(wafKit, note);
                } else {
                    const melodic = _melodicPadForNote(note);
                    if (melodic) playPadPitched(melodic.index, note - melodic.baked);
                }
            }
            synthNoteOn(note, val);
            _midiCaptureNoteOn(note, val);
            _reportMidiActivity(note, pi);
        } else if (type===0x80 || (type===0x90&&val===0)) {
            // Note Off
            synthNoteOff(note);
            _midiCaptureNoteOff(note);
            const pi=settings.sbPads.findIndex(p=>p&&p.midiNote===note&&p.loop);
            if (pi>=0) stopPad(pi);
        } else if (type===0xb0) {
            if (note===123) { synthAllNotesOff(); return; }
            if (typeof window.__xcMidiLearn === 'function' && window.__xcMidiLearn('cc', note)) return;
            // Only trigger on the button-down value. Many controllers send a CC
            // message BOTH when a transport button is pressed (val>0) AND when it
            // is released (val===0) — without this guard, every press+release of
            // a CC-mapped hardware Record/Play button toggled the loop twice in a
            // row (start, then immediately stop again on release).
            if (val > 0) {
                if (_matchesTransport(settings.midiRecordMap, 'cc', note)) { _loopRecordToggleFromMIDI(); return; }
                if (_matchesTransport(settings.midiPlayMap, 'cc', note)) { _loopPlayToggleFromMIDI(); return; }
            }
        }
    }

    function _matchesTransport(map, kind, number) {
        return !!map && map.type === kind && map.number === number;
    }

    // Hardware Record button (e.g. Launchkey Mini transport): toggle recording
    // on whichever track is currently recording/overdubbing (or armed, waiting
    // for its quantize snap), or arm the first empty track (or overdub track 0
    // if it's playing and none are empty).
    function _loopRecordToggleFromMIDI() {
        const activeIdx = _loops.findIndex(L => L.state === 'recording' || L.state === 'overdubbing' || L.state === 'armed-record' || L.state === 'armed-overdub');
        if (activeIdx >= 0) { loopStopButton(activeIdx); return; }
        const emptyIdx = _loops.findIndex(L => L.state === 'empty');
        if (emptyIdx >= 0) { loopStartRecord(emptyIdx); return; }
        if (_loops[0].state === 'playing') loopStartOverdub(0);
    }
    // Hardware Play button: play/stop every track that has a recorded loop together.
    function _loopPlayToggleFromMIDI() {
        const anyPlaying = _loops.some(L => L.state === 'playing' || L.state === 'overdubbing');
        if (anyPlaying) { for (let i = 0; i < _LOOP_LAYERS; i++) loopStop(i); }
        else { for (let i = 0; i < _LOOP_LAYERS; i++) if (_loops[i].buf) loopPlay(i); }
    }


    function _reportMidiActivity(note, matchedPadIndex) {
        const el = document.getElementById('xfw-midi-lastnote');
        if (!el) return;
        el.textContent = matchedPadIndex >= 0
            ? `Note ${note} (${_midiToName(note)}) → Pad ${matchedPadIndex+1}`
            : `Note ${note} (${_midiToName(note)}) received — no pad mapped (right-click a pad → Learn)`;
    }
    const _MIDI_TYPE_NAMES = { 0x80:'Note Off', 0x90:'Note On', 0xa0:'Aftertouch', 0xb0:'CC', 0xc0:'Program', 0xd0:'Ch.Pressure', 0xe0:'Pitch Bend' };
    function _reportRawMidi(type, chan, note, val) {
        const el = document.getElementById('xfw-midi-raw');
        if (!el) return;
        const blocked = settings.midiChannel>0 && chan!==settings.midiChannel;
        const name = _MIDI_TYPE_NAMES[type] || `0x${type.toString(16)}`;
        el.textContent = `Raw: ${name} ch${chan} #${note} val${val}` + (blocked ? ` — blocked by channel filter (listening on ${settings.midiChannel})` : '');
        el.style.color = blocked ? '#dc2626' : 'var(--xfw-muted)';
    }

    function paintMIDIDevices() {
        const sel=document.getElementById('xfw-midi-device');
        if (!sel) return;
        const prev=sel.value;
        sel.innerHTML='<option value="all">All MIDI inputs</option>';
        if (_midiAccess) _midiAccess.inputs.forEach(inp=>{ const o=document.createElement('option'); o.value=inp.id; o.textContent=inp.name; sel.appendChild(o); });
        if([...sel.options].some(o=>o.value===prev)) sel.value=prev;
        const st=document.getElementById('xfw-midi-status');
        if (st) {
            if (!_midiAccess) {
                st.textContent = 'MIDI not available — check browser permissions';
            } else {
                // List each input's NAME + connection state — e.g. some controllers
                // (Novation Launchpad/Launchkey) expose extra "DAW"/control-surface
                // ports alongside the real note-sending port; if the port your pads
                // actually send on shows "closed"/"pending" here (instead of "open"),
                // that's the port that isn't delivering to _onMIDIMsg.
                const names = [];
                _midiAccess.inputs.forEach(inp => names.push(`${inp.name} (${inp.connection})`));
                st.textContent = `${_midiAccess.inputs.size} device(s): ${names.join(', ')}`;
            }
        }
    }

    // ── Looper (RC-505 Mk2-style Loop Station) ─────────────────────────────
    // 5 independent tracks (like the Boss RC-505's 5 track buttons). Each has
    // 4 explicit buttons instead of one overloaded multi-function pad (that
    // was confusing since the same button meant different things depending
    // on state): ● Record (fresh take from empty, or overdub on top of the
    // current loop), ▶ Play (resume a stopped loop), ❚❚ Stop/Pause (ends
    // whatever's active — recording/overdubbing/playback — keeping the loop),
    // ✕ Clear (erases the loop, discarding an in-progress take if any is
    // running). Tracks record the live mic+aux mix and loop on their own
    // gain node into sbBus, so multiple tracks can play together to build up
    // a beat/vocal round instead of a single overwritten loop.
    const _LOOP_LAYERS = 5;
    const _loops = Array.from({ length: _LOOP_LAYERS }, () => ({
        rec: null, chunks: [], src: null, buf: null, gainNode: null,
        state: 'empty', // 'empty' | 'armed-record' | 'recording' | 'playing' | 'armed-overdub' | 'overdubbing' | 'stopped'
        autoStopTimer: null, armTimer: null,
        recDeadline: null, recDurationMs: null, // known auto-stop end time, for the progress ring
        midiEvents: [], recordStartCtxTime: null, playStartCtxTime: null, // MIDI note capture for the Piano Roll view
    }));

    // Record/overdub progress ring: while a track has a KNOWN end time (auto-loop
    // bar count set, or an overdub pass which is always exactly one loop-length),
    // paint a --loop-progress (0→1) CSS var on its Record button so the ring
    // drawn by .xfw-loop-btn-rec::before in overlay.css fills all the way
    // around the button from start to finish — like the RC-505's segment
    // LEDs, so you can see exactly when the take will end without a timer.
    let _loopProgressRAF = null;
    function _ensureLoopProgressRAF() {
        if (_loopProgressRAF) return;
        const tick = () => {
            let anyActive = false;
            for (let i = 0; i < _LOOP_LAYERS; i++) {
                const L = _loops[i];
                if ((L.state === 'recording' || L.state === 'overdubbing') && L.recDeadline) {
                    anyActive = true;
                    const total = L.recDurationMs || 1;
                    const remaining = L.recDeadline - performance.now();
                    const progress = Math.max(0, Math.min(1, 1 - remaining / total));
                    const btn = document.querySelector(`[data-loop-rec="${i}"]`);
                    if (btn) btn.style.setProperty('--loop-progress', progress);
                }
            }
            _loopProgressRAF = anyActive ? requestAnimationFrame(tick) : null;
        };
        _loopProgressRAF = requestAnimationFrame(tick);
    }

    function _loopStatus(layer, msg) { const e = document.querySelector(`[data-loop-status="${layer}"]`); if (e) e.textContent = msg; }
    function _loopTrackGain(layer) { return dbToLin((settings.loopGainDb || 0) + (settings.loopTrackGainDb[layer] || 0)); }

    // Quantize: snaps the ACTUAL start of a recording/overdub to the tempo
    // grid instead of starting the instant Record is pressed — since input is
    // usually MIDI-triggered (hardware Record button / auto-loop), pressing a
    // beat early/late would otherwise bake that timing error permanently into
    // the loop. 'auto' resolves to 1/4 bar (one beat in 4/4) — e.g. a 4-bar
    // auto-loop record snaps to the beat. Users can override per-track via
    // the quantize dial in the UI (Off / Auto / 1/4 / 1/8 / 1/16 / 1/32).
    function _resolveQuantizeDiv(layer) {
        const q = settings.loopQuantize[layer];
        if (q === 'off') return 0;
        if (q === 'auto' || q == null) return 4;
        return +q || 4;
    }
    function _quantizeLabel(layer) {
        const q = settings.loopQuantize[layer];
        if (q === 'off') return 'Off';
        if (q === 'auto' || q == null) return 'Auto (1/4)';
        return `1/${q}`;
    }
    // Milliseconds to wait (from right now) until the next grid line, using a
    // clock anchored to the AudioContext's own time origin (ctx.currentTime=0)
    // at the shared loopBpm — 0 means "start immediately" (quantize is Off).
    function _quantizeDelayMs(divisor) {
        if (!divisor) return 0;
        const ctx = ensureAudioContext();
        const secPerBar = (60 / (settings.loopBpm || 120)) * 4;
        const unit = secPerBar / divisor;
        const now = ctx.currentTime;
        let next = Math.ceil(now / unit) * unit;
        if (next - now < 0.005) next += unit; // avoid a near-0ms "immediate" snap right on the line
        return Math.max(0, (next - now) * 1000);
    }
    function _cancelArm(layer) {
        const L = _loops[layer];
        if (L?.armTimer) { clearTimeout(L.armTimer); L.armTimer = null; }
    }

    // ── Metronome (click track) ──────────────────────────────────────────────
    // Plays a click on the SAME idealized BPM grid that quantize/auto-snap uses
    // (anchored to ctx.currentTime=0, not to when the metronome was turned on),
    // so it's also a direct audible reference for "where auto-snap will land".
    // Uses a standard lookahead scheduler (setInterval polls slightly ahead of
    // real time and schedules exact-timed oscillator clicks) instead of naive
    // setTimeout-per-beat, which would drift. metronomeGain connects ONLY to
    // monitorDest (see buildGraph) — it is structurally impossible for it to
    // reach loopRecordBus/sbSourceBus/processedDest, so it can never be baked
    // into a loop recording or sent to the X broadcast, regardless of state.
    const _METRO_SCHEDULE_AHEAD_SEC = 0.1;
    const _METRO_POLL_MS = 25;
    let _metroTimer = null;
    let _metroNextNoteTime = 0;
    let _metroNextBeatIndex = 0;

    function _metronomeClick(time, accent) {
        if (!metronomeGain) return;
        const ctx = ensureAudioContext();
        // Wood-block feel: two harmonically-related sines with fast decay.
        const freqs = accent ? [1200, 1800] : [800, 1200];
        const vols  = accent ? [0.55, 0.22] : [0.36, 0.14];
        freqs.forEach((f, h) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine'; osc.frequency.value = f;
            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(vols[h], time + 0.001);
            gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
            osc.connect(gain); gain.connect(metronomeGain);
            osc.start(time); osc.stop(time + 0.07);
        });
    }

    function _metronomeScheduleTick() {
        const ctx = ensureAudioContext();
        const secPerBeat = 60 / (settings.loopBpm || 120);
        while (_metroNextNoteTime < ctx.currentTime + _METRO_SCHEDULE_AHEAD_SEC) {
            _metronomeClick(_metroNextNoteTime, _metroNextBeatIndex % 4 === 0);
            _metroNextBeatIndex++;
            _metroNextNoteTime += secPerBeat;
        }
    }

    function _startMetronome() {
        if (_metroTimer || !metronomeGain) return;
        const ctx = ensureAudioContext();
        const secPerBeat = 60 / (settings.loopBpm || 120);
        // Snap the FIRST click onto the same grid quantize/auto-snap uses, so
        // turning the metronome on mid-take doesn't feel offset from the beat.
        _metroNextNoteTime = Math.ceil(ctx.currentTime / secPerBeat) * secPerBeat;
        _metroNextBeatIndex = Math.round(_metroNextNoteTime / secPerBeat);
        _metronomeScheduleTick();
        _metroTimer = setInterval(_metronomeScheduleTick, _METRO_POLL_MS);
    }

    function _stopMetronome() {
        if (_metroTimer) { clearInterval(_metroTimer); _metroTimer = null; }
    }

    function _setMetronomeEnabled(on) {
        settings.metronomeEnabled = on;
        saveSettings(settings);
        if (on) { ensureProcessedStream().then(_startMetronome).catch(() => {}); }
        else { _stopMetronome(); }
        const btn = document.getElementById('xfw-metronome-toggle');
        if (btn) btn.classList.toggle('xfw-metronome-on', on);
    }

    // Locks a decoded recording onto an EXACT duration (in samples) — needed
    // because MediaRecorder's real start()/stop() calls always have a few ms
    // of latency/jitter, so a "4 bar" auto-loop recording never comes back at
    // *exactly* 4 bars. Loop playback loops on the buffer's own real length,
    // but quantize timing is anchored to an idealized BPM grid — if those two
    // don't match exactly, every subsequent quantized record/overdub start
    // drifts a little further from the loop's actual downbeat each pass, which
    // is what "autosnap doesn't seem to snap" turns into after a few takes.
    // Truncating/padding to the ideal length keeps the loop's real period
    // perfectly locked to the grid so future snaps always land on-beat.
    function _lockBufferDuration(buf, targetSec) {
        const ctx = ensureAudioContext();
        const targetLen = Math.max(1, Math.round(targetSec * buf.sampleRate));
        if (targetLen === buf.length) return buf;
        const out = ctx.createBuffer(buf.numberOfChannels, targetLen, buf.sampleRate);
        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
            const dst = out.getChannelData(ch);
            const src = buf.getChannelData(ch);
            dst.set(src.subarray(0, Math.min(targetLen, src.length)));
        }
        return out;
    }

    async function loopStartRecord(layer) {
        const L = _loops[layer];
        if (!L || L.state !== 'empty') return;
        await ensureProcessedStream();
        if (!loopRecordStream) return;

        const ctx = ensureAudioContext();
        const secPerBeat = 60 / (settings.loopBpm || 120);
        const secPerBar  = secPerBeat * 4;
        const anyPlaying = _loops.some(l => l.state === 'playing' || l.state === 'overdubbing');

        if (!anyPlaying) {
            // Count-in: snap to the next bar boundary and fire 4 clicks in the bar
            // before it so the musician knows exactly when recording will start.
            const now = ctx.currentTime;
            let nextBar = Math.ceil(now / secPerBar) * secPerBar;
            if (nextBar - now < 0.05) nextBar += secPerBar;
            const countStart = nextBar - secPerBar;
            for (let i = 0; i < 4; i++) {
                _metronomeClick(Math.max(now + 0.02, countStart + i * secPerBeat), i === 0);
            }
            const msUntilBar = Math.max(0, (nextBar - ctx.currentTime) * 1000);
            L.state = 'armed-record';
            _loopStatus(layer, `⏳ 1`);
            _updateLoopUI(layer);
            // Show beat number in the status label so the performer sees the count.
            const beatMs = secPerBeat * 1000;
            const countStartMs = Math.max(0, (countStart - ctx.currentTime) * 1000);
            for (let b = 2; b <= 4; b++) {
                const delay = countStartMs + (b - 1) * beatMs;
                setTimeout(() => { if (L.state === 'armed-record') _loopStatus(layer, b < 4 ? `⏳ ${b}` : `⏳ 4 ►`); }, delay);
            }
            L.armTimer = setTimeout(() => { L.armTimer = null; _beginRecording(layer); }, msUntilBar);
            return;
        }

        const delayMs = _quantizeDelayMs(_resolveQuantizeDiv(layer));
        if (delayMs <= 0) { _beginRecording(layer); return; }
        L.state = 'armed-record';
        _loopStatus(layer, `⏳ Waiting for downbeat… (${_quantizeLabel(layer)})`);
        _updateLoopUI(layer);
        L.armTimer = setTimeout(() => { L.armTimer = null; _beginRecording(layer); }, delayMs);
    }

    function _beginRecording(layer) {
        const L = _loops[layer];
        if (!L) return;
        L.chunks = [];
        L.midiEvents = []; // fresh recording — clear any notes captured on a previous take
        try { L.rec = new MediaRecorder(loopRecordStream, { mimeType: 'audio/webm;codecs=opus' }); }
        catch { L.rec = new MediaRecorder(loopRecordStream); }
        L.rec.ondataavailable = e => { if (e.data.size > 0) L.chunks.push(e.data); };
        L.rec.onstop = async () => {
            if (L.autoStopTimer) { clearTimeout(L.autoStopTimer); L.autoStopTimer = null; }
            const blob = new Blob(L.chunks, { type: L.rec.mimeType });
            try {
                L.buf = await ensureAudioContext().decodeAudioData(await blob.arrayBuffer());
                // Auto-loop mode has a known ideal length (bars × bar duration) —
                // lock the buffer to it so this loop's real playback period stays
                // exactly on the tempo grid (see _lockBufferDuration above).
                if (settings.loopBars[layer]) {
                    const secPerBar = (60 / (settings.loopBpm || 120)) * 4;
                    L.buf = _lockBufferDuration(L.buf, settings.loopBars[layer] * secPerBar);
                }
                // Clip captured notes to the final (locked) buffer length so the Piano
                // Roll never shows a note hanging past the end of its own loop.
                L.midiEvents = L.midiEvents.filter(ev => ev.on < L.buf.duration).map(ev => ({ ...ev, off: Math.min(ev.off, L.buf.duration) }));
                L.state = 'stopped';
                _loopStatus(layer, `Loop ready ⟳ ${L.buf.duration.toFixed(2)}s`);
                // Auto-loop: if this track has a bar-length selected (not Manual),
                // start looping playback immediately — one tap, hands-free.
                if (settings.loopBars[layer]) loopPlay(layer);
            } catch (e) { L.state = 'empty'; _loopStatus(layer, 'Record failed — retry'); }
            _updateLoopUI(layer);
        };
        L.rec.start();
        L.recordStartCtxTime = ensureAudioContext().currentTime;
        L.state = 'recording';
        _loopStatus(layer, '● Recording…');
        _updateLoopUI(layer);

        // Auto-loop record: if a bar count is selected for this track, schedule
        // an automatic stop after that many bars at the current BPM (4/4 time),
        // so you can set a beat with a single tap instead of timing it yourself.
        const bars = settings.loopBars[layer];
        if (bars) {
            const secPerBar = (60 / (settings.loopBpm || 120)) * 4;
            const ms = Math.max(200, bars * secPerBar * 1000);
            L.recDurationMs = ms;
            L.recDeadline = performance.now() + ms;
            L.autoStopTimer = setTimeout(() => loopStopRecord(layer), ms);
            _ensureLoopProgressRAF();
        } else {
            // Manual (no bar count) recording has no known end time, so there's
            // nothing to draw a fill-ring toward — the pulsing glow is the only
            // indicator until you tap/hold to stop it yourself.
            L.recDurationMs = null; L.recDeadline = null;
        }
    }

    function loopStopRecord(layer) {
        const L = _loops[layer];
        if (L?.autoStopTimer) { clearTimeout(L.autoStopTimer); L.autoStopTimer = null; }
        if (L?.rec && L.state === 'recording') { L.rec.stop(); _loopStatus(layer, 'Processing…'); }
    }

    // Sums two buffers sample-for-sample (clamped), padding the shorter one
    // with silence — used to layer an overdub pass onto the existing loop.
    function _mixAudioBuffers(bufA, bufB) {
        const ctx = ensureAudioContext();
        const length = Math.max(bufA.length, bufB.length);
        const channels = Math.max(bufA.numberOfChannels, bufB.numberOfChannels);
        const out = ctx.createBuffer(channels, length, bufA.sampleRate);
        for (let ch = 0; ch < channels; ch++) {
            const data = out.getChannelData(ch);
            const a = bufA.getChannelData(Math.min(ch, bufA.numberOfChannels - 1));
            const b = bufB.getChannelData(Math.min(ch, bufB.numberOfChannels - 1));
            for (let i = 0; i < length; i++) {
                const av = i < a.length ? a[i] : 0;
                const bv = i < b.length ? b[i] : 0;
                data[i] = Math.max(-1, Math.min(1, av + bv));
            }
        }
        return out;
    }

    // Overdub: records one more full loop-length pass while the existing loop
    // keeps playing, then mixes it into the loop buffer — exactly like the
    // RC-505's OVERDUB behavior (additive, non-destructive, stays in the loop).
    async function loopStartOverdub(layer) {
        const L = _loops[layer];
        if (!L?.buf || L.state !== 'playing') return;
        await ensureProcessedStream();
        if (!loopRecordStream) return;
        const delayMs = _quantizeDelayMs(_resolveQuantizeDiv(layer));
        if (delayMs <= 0) { _beginOverdub(layer); return; }
        L.state = 'armed-overdub';
        _loopStatus(layer, `⏳ Waiting for downbeat… (${_quantizeLabel(layer)})`);
        _updateLoopUI(layer);
        L.armTimer = setTimeout(() => { L.armTimer = null; _beginOverdub(layer); }, delayMs);
    }

    function _beginOverdub(layer) {
        const L = _loops[layer];
        if (!L?.buf) return;
        L.chunks = [];
        try { L.rec = new MediaRecorder(loopRecordStream, { mimeType: 'audio/webm;codecs=opus' }); }
        catch { L.rec = new MediaRecorder(loopRecordStream); }
        L.rec.ondataavailable = e => { if (e.data.size > 0) L.chunks.push(e.data); };
        const baseBuf = L.buf;
        L.rec.onstop = async () => {
            if (L.autoStopTimer) { clearTimeout(L.autoStopTimer); L.autoStopTimer = null; }
            const blob = new Blob(L.chunks, { type: L.rec.mimeType });
            try {
                const newBuf = await ensureAudioContext().decodeAudioData(await blob.arrayBuffer());
                L.buf = _mixAudioBuffers(baseBuf, newBuf);
                // Keep the loop's length exactly what it was before this overdub
                // pass (rather than whatever MediaRecorder's real stop latency
                // produced) — same drift-prevention reasoning as the initial
                // recording lock above, and it applies in Manual mode too since
                // overdub is always meant to be exactly one loop-length pass.
                L.buf = _lockBufferDuration(L.buf, baseBuf.duration);
            } catch (e) { console.warn('[XCaster] overdub decode failed', layer, e); }
            // Clip to the final length (notes from THIS pass only — earlier passes
            // were already clipped when they were recorded/overdubbed).
            L.midiEvents = L.midiEvents.filter(ev => ev.on < L.buf.duration).map(ev => ({ ...ev, off: Math.min(ev.off, L.buf.duration) }));
            L.state = 'stopped';
            _loopStatus(layer, `Loop ready ⟳ ${L.buf.duration.toFixed(2)}s`);
            loopPlay(layer); // resume, phase-aligned from the top of the merged loop
            _updateLoopUI(layer);
        };
        // Restart playback right now from the top so what you hear (and what
        // gets captured) is phase-aligned with the new overdub pass. New notes
        // are appended to the SAME L.midiEvents list (not cleared) so this pass's
        // notes overlay the base recording's, matching the additive audio mix.
        _restartLoopSource(layer);
        L.rec.start();
        L.recordStartCtxTime = ensureAudioContext().currentTime;
        L.state = 'overdubbing';
        _loopStatus(layer, `◑ Overdubbing ⟳ ${baseBuf.duration.toFixed(2)}s`);
        _updateLoopUI(layer);
        const ms = Math.max(200, baseBuf.duration * 1000);
        L.recDurationMs = ms;
        L.recDeadline = performance.now() + ms;
        L.autoStopTimer = setTimeout(() => loopStopOverdub(layer), ms);
        _ensureLoopProgressRAF();
    }

    function loopStopOverdub(layer) {
        const L = _loops[layer];
        if (L?.autoStopTimer) { clearTimeout(L.autoStopTimer); L.autoStopTimer = null; }
        if (L?.rec && L.state === 'overdubbing') { L.rec.stop(); _loopStatus(layer, 'Processing…'); }
    }

    // (Re)starts the loop's buffer source from t=0 without touching state/status text.
    function _restartLoopSource(layer) {
        const L = _loops[layer];
        if (!L?.buf) return;
        if (L.src) { try { L.src.stop(); } catch {} L.src = null; }
        const ctx = ensureAudioContext();
        if (!L.gainNode) { L.gainNode = ctx.createGain(); if (sbBus) L.gainNode.connect(sbBus); }
        L.gainNode.gain.value = _loopTrackGain(layer);
        L.src = ctx.createBufferSource();
        L.src.buffer = L.buf; L.src.loop = true;
        L.src.connect(L.gainNode); L.src.start();
        L.playStartCtxTime = ctx.currentTime; // Piano Roll playhead: (now - this) % buf.duration
    }

    function loopPlay(layer) {
        const L = _loops[layer];
        if (!L?.buf) return;
        _restartLoopSource(layer);
        L.state = 'playing';
        _loopStatus(layer, `▶ Looping ⟳ ${L.buf.duration.toFixed(2)}s`);
        _updateLoopUI(layer);
    }

    function loopStop(layer) {
        const L = _loops[layer];
        if (!L) return;
        if (L.src) { try { L.src.stop(); } catch {} L.src = null; }
        L.state = L.buf ? 'stopped' : 'empty';
        _loopStatus(layer, L.buf ? `Loop ready ⟳ ${L.buf.duration.toFixed(2)}s` : 'No loop recorded');
        _updateLoopUI(layer);
    }

    function loopClear(layer) {
        const L = _loops[layer];
        if (!L) return;
        _cancelArm(layer);
        // If a take is actively being recorded/overdubbed, discard it instead of
        // finishing and saving it — detach the recorder's handlers first so its
        // async onstop (decode + save) never runs on the truncated audio.
        if (L.rec && (L.state === 'recording' || L.state === 'overdubbing')) {
            if (L.autoStopTimer) { clearTimeout(L.autoStopTimer); L.autoStopTimer = null; }
            try { L.rec.ondataavailable = null; L.rec.onstop = null; L.rec.stop(); } catch {}
            L.rec = null; L.chunks = [];
        }
        loopStop(layer);
        L.buf = null; L.state = 'empty';
        L.recDeadline = null; L.recDurationMs = null;
        L.midiEvents = []; L.recordStartCtxTime = null; L.playStartCtxTime = null;
        _loopStatus(layer, 'No loop recorded');
        _updateLoopUI(layer);
    }

    function loopStopAllPlaying() { for (let i = 0; i < _LOOP_LAYERS; i++) loopStop(i); }
    function loopClearAll() { for (let i = 0; i < _LOOP_LAYERS; i++) loopClear(i); }
    // Mirrors Stop All — (re)starts every track that currently has a recorded
    // loop sitting stopped, so a full multi-track arrangement can be brought
    // back in with one tap instead of hitting Play on each track individually.
    function loopPlayAllStopped() { for (let i = 0; i < _LOOP_LAYERS; i++) { if (_loops[i]?.state === 'stopped') loopPlay(i); } }

    // Four explicit transport buttons per track (replaces the old single
    // multi-function pad, which was confusing since the SAME button meant
    // different things depending on state):
    //   ● Record — starts a fresh recording on an empty track, or overdubs on
    //     top of the current loop while it's playing/stopped.
    //   ▶ Play — resumes a stopped loop.
    //   ❚❚ Stop/Pause — stops whatever is currently active (recording,
    //     overdubbing, or playback), keeping the recorded loop intact.
    //   ✕ Clear — erases the loop on this track completely (discards an
    //     in-progress take too, if one is running).
    function loopRecordButton(layer) {
        const L = _loops[layer];
        if (!L) return;
        if (L.state === 'empty') { loopStartRecord(layer); return; }
        if (L.state === 'playing') { loopStartOverdub(layer); return; }
        if (L.state === 'stopped') { loopPlay(layer); loopStartOverdub(layer); return; }
        // 'recording'/'overdubbing' — already in progress; use Stop to finish it.
    }
    function loopPlayButton(layer) {
        const L = _loops[layer];
        if (!L || L.state !== 'stopped') return;
        loopPlay(layer);
    }
    function loopStopButton(layer) {
        const L = _loops[layer];
        if (!L) return;
        if (L.state === 'armed-record') { _cancelArm(layer); L.state = 'empty'; _loopStatus(layer, 'No loop recorded'); _updateLoopUI(layer); return; }
        if (L.state === 'armed-overdub') { _cancelArm(layer); L.state = 'playing'; _loopStatus(layer, `▶ Looping ⟳ ${L.buf.duration.toFixed(2)}s`); _updateLoopUI(layer); return; }
        if (L.state === 'recording') { loopStopRecord(layer); return; }
        if (L.state === 'overdubbing') { loopStopOverdub(layer); return; }
        if (L.state === 'playing') { loopStop(layer); return; }
    }
    function loopClearButton(layer) { loopClear(layer); }

    function _updateLoopUI(layer) {
        const L = _loops[layer];
        if (!L) return;
        const recBtn = document.querySelector(`[data-loop-rec="${layer}"]`);
        const playBtn = document.querySelector(`[data-loop-play="${layer}"]`);
        const stopBtn = document.querySelector(`[data-loop-stop="${layer}"]`);
        const clearBtn = document.querySelector(`[data-loop-clear="${layer}"]`);
        const armed = L.state === 'armed-record' || L.state === 'armed-overdub';
        const recording = L.state === 'recording' || L.state === 'overdubbing';
        const playing = L.state === 'playing' || L.state === 'overdubbing';
        if (recBtn) {
            recBtn.classList.toggle('xfw-loop-active', recording);
            recBtn.classList.toggle('xfw-loop-armed', armed);
            recBtn.disabled = !(L.state === 'empty' || L.state === 'playing' || L.state === 'stopped');
            recBtn.title = L.state === 'empty' ? 'Record a new loop'
                : armed ? `Waiting for downbeat… (${_quantizeLabel(layer)})`
                : recording ? 'Recording… use Stop/Pause to finish'
                : 'Overdub on top of the current loop';
            // Reset the fill-ring whenever a fresh recording/overdub pass starts (or
            // ends) — _ensureLoopProgressRAF() will drive it back up from 0 while
            // L.state stays 'recording'/'overdubbing' with a known recDeadline.
            if (!recording) recBtn.style.setProperty('--loop-progress', 0);
        }
        if (playBtn) {
            playBtn.classList.toggle('xfw-loop-active', playing);
            playBtn.disabled = L.state !== 'stopped';
        }
        if (stopBtn) {
            stopBtn.disabled = !(recording || armed || L.state === 'playing');
        }
        if (clearBtn) {
            clearBtn.disabled = L.state === 'empty';
        }
        _setDisabled(`[data-bar-dial="${layer}"]`, L.state !== 'empty');
        _setDisabled(`[data-quantize-dial="${layer}"]`, !(L.state === 'empty' || L.state === 'stopped' || L.state === 'playing'));
    }
    function _setDisabled(selector, dis) { const e = document.querySelector(selector); if (e) e.disabled = dis; }

    // ── Piano Roll (Ableton-style clip view) ────────────────────────────────
    // Draws the notes captured above onto a canvas: a mini piano-key strip on
    // the left, a note grid on the right with bar/beat lines at the shared
    // loopBpm, and colored blocks for each note (x = time, y = pitch row,
    // width = held duration). Two data sources: 'live' (a rolling window of
    // whatever's currently being played, auto-scrolling) or a specific loop
    // track's captured notes (static once the track isn't actively
    // recording/overdubbing/playing, but still redrawn continuously via rAF
    // since it's cheap and keeps the playhead moving during playback).
    const PIANO_ROLL_KEY_W = 34;
    const PIANO_ROLL_PX_PER_SEC = 90;
    const PIANO_ROLL_LIVE_WINDOW_SEC = 8;

    function _pianoRollData() {
        const sel = settings.pianoRollTrack;
        if (sel === 'live') {
            const ctx = ensureAudioContext();
            const now = ctx.currentTime;
            const startT = now - PIANO_ROLL_LIVE_WINDOW_SEC;
            const events = _liveMidiEvents
                .filter(e => e.off > startT)
                .map(e => ({ note: e.note, on: Math.max(0, e.on - startT), off: Math.min(PIANO_ROLL_LIVE_WINDOW_SEC, e.off - startT), vel: e.vel }));
            // Notes still physically held draw as growing bars up to "now".
            _activeNoteOnTimes.forEach((v, note) => {
                events.push({ note, on: Math.max(0, v.t - startT), off: PIANO_ROLL_LIVE_WINDOW_SEC, vel: v.vel });
            });
            return { events, durationSec: PIANO_ROLL_LIVE_WINDOW_SEC, playheadSec: PIANO_ROLL_LIVE_WINDOW_SEC, live: true };
        }
        const layer = +sel;
        const L = _loops[layer];
        if (!L || !L.buf) return { events: [], durationSec: 4, playheadSec: null, live: false };
        let playheadSec = null;
        if ((L.state === 'playing' || L.state === 'overdubbing') && L.playStartCtxTime != null) {
            const ctx = ensureAudioContext();
            const elapsed = ctx.currentTime - L.playStartCtxTime;
            playheadSec = ((elapsed % L.buf.duration) + L.buf.duration) % L.buf.duration;
        }
        return { events: L.midiEvents || [], durationSec: L.buf.duration, playheadSec, live: false };
    }

    function _drawPianoRoll() {
        const canvas = document.getElementById('xfw-pianoroll-canvas');
        if (!canvas) return;
        const { events, durationSec, playheadSec, live } = _pianoRollData();
        const rowH = Math.max(6, Math.min(40, settings.pianoRollRowH || 14));
        let lo = 60, hi = 71; // default: one octave around middle C when there's no data yet
        if (events.length) {
            lo = Math.min(...events.map(e => e.note));
            hi = Math.max(...events.map(e => e.note));
        }
        lo = Math.max(0, lo - 3); hi = Math.min(127, hi + 3);
        if (hi - lo < 11) { const pad = Math.ceil((11 - (hi - lo)) / 2); lo = Math.max(0, lo - pad); hi = Math.min(127, hi + pad); }
        const numRows = hi - lo + 1;
        const scroll = document.getElementById('xfw-pianoroll-scroll');
        const minW = scroll ? Math.max(200, scroll.clientWidth - 4) : 600;
        const width = PIANO_ROLL_KEY_W + Math.max(minW, Math.ceil(durationSec * PIANO_ROLL_PX_PER_SEC)) + 20;
        const height = numRows * rowH;
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const g = canvas.getContext('2d');
        g.clearRect(0, 0, width, height);

        const isBlack = n => [1, 3, 6, 8, 10].includes(((n % 12) + 12) % 12);
        // Row backgrounds + C-note dividers, so the grid reads like a keyboard.
        for (let row = 0; row < numRows; row++) {
            const note = hi - row;
            g.fillStyle = isBlack(note) ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.015)';
            g.fillRect(PIANO_ROLL_KEY_W, row * rowH, width - PIANO_ROLL_KEY_W, rowH);
            if (note % 12 === 0) {
                g.strokeStyle = 'rgba(255,255,255,0.14)';
                g.beginPath(); g.moveTo(PIANO_ROLL_KEY_W, row * rowH); g.lineTo(width, row * rowH); g.stroke();
            }
        }
        // Mini piano-key strip on the left.
        for (let row = 0; row < numRows; row++) {
            const note = hi - row;
            g.fillStyle = isBlack(note) ? '#14161b' : '#e7e7ec';
            g.fillRect(0, row * rowH, PIANO_ROLL_KEY_W - 2, rowH - 1);
            if (note % 12 === 0 && rowH >= 9) {
                g.fillStyle = '#1d9bf0';
                g.font = '9px sans-serif';
                g.fillText(_midiToName(note), 2, row * rowH + rowH - 3);
            }
        }
        // Bar/beat grid lines at the shared loop tempo.
        const bpm = settings.loopBpm || 120;
        const secPerBeat = 60 / bpm;
        let beat = 0;
        for (let t = 0; t <= durationSec + 0.001; t += secPerBeat, beat++) {
            const x = PIANO_ROLL_KEY_W + t * PIANO_ROLL_PX_PER_SEC;
            const isBar = beat % 4 === 0;
            g.strokeStyle = isBar ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)';
            g.lineWidth = isBar ? 1.5 : 1;
            g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke();
            if (isBar) {
                g.fillStyle = 'rgba(255,255,255,0.55)';
                g.font = '9px sans-serif';
                g.fillText(String(Math.floor(beat / 4) + 1), x + 2, 9);
            }
        }
        // Note blocks.
        events.forEach(ev => {
            if (ev.note < lo || ev.note > hi) return;
            const row = hi - ev.note;
            const x = PIANO_ROLL_KEY_W + ev.on * PIANO_ROLL_PX_PER_SEC;
            const w = Math.max(3, (ev.off - ev.on) * PIANO_ROLL_PX_PER_SEC);
            const alpha = 0.5 + 0.5 * ((ev.vel || 100) / 127);
            g.fillStyle = `rgba(29,155,240,${alpha.toFixed(2)})`;
            g.fillRect(x, row * rowH + 1, w, rowH - 2);
        });
        // Playhead.
        if (playheadSec != null) {
            const x = PIANO_ROLL_KEY_W + playheadSec * PIANO_ROLL_PX_PER_SEC;
            g.strokeStyle = '#ef4444'; g.lineWidth = 2;
            g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke();
        }
        // Live view keeps the newest content in view.
        const wrap = document.getElementById('xfw-pianoroll-scroll');
        if (wrap && live) wrap.scrollLeft = wrap.scrollWidth;
    }

    let _pianoRollRAF = null;
    function _ensurePianoRollRAF() {
        if (_pianoRollRAF) return;
        const tick = () => {
            const popup = document.getElementById('xfw-pianoroll-popup');
            if (!popup || popup.style.display === 'none') { _pianoRollRAF = null; return; }
            _drawPianoRoll();
            _pianoRollRAF = requestAnimationFrame(tick);
        };
        _pianoRollRAF = requestAnimationFrame(tick);
    }

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

    // Save the native constructor BEFORE our patch wraps it.
    // xOutputCtx must be created with this so we fully control setSinkId timing.
    const _NativeAudioContext = window.AudioContext || window.webkitAudioContext;

    // Save the native RTCPeerConnection BEFORE we patch it below.
    // xcast relay peer connections must use this so they are never added to
    // __xfwPCs and never trigger replaceTracksOnActivePCs (which would call
    // replaceTrack on X Spaces' live sender and cause an audible cut).
    const RealPC = window.RTCPeerConnection;

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
            // 'playback' uses a larger buffer than 'interactive', which keeps
            // audio glitch-free when the renderer is briefly throttled (window
            // minimized/occluded). The added ~20ms latency is invisible for X.
            audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
            // Now there is an audio graph worth keeping scheduled when occluded.
            setTimeout(maybeStartWorkerKeepalive, 0);
            // Auto-resume whenever Chromium suspends the context (focus loss,
            // device switch, OS audio session change, etc.)
            audioCtx.addEventListener('statechange', () => {
                if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
            });
            // Silent keepalive: a zero-gain ConstantSourceNode keeps the Chromium
            // audio rendering thread scheduled even when the window is minimized.
            // Without it, background CPU throttling starves the DSP callbacks.
            installAudioKeepalive(audioCtx);
            // Pre-load the pitch worklet so it is ready when autotune is first enabled.
            ensurePitchWorklet(audioCtx).catch(() => {});
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

    async function acquireDevice(deviceId, captureOpts) {
        // Raw capture for any input. captureOpts overrides per-channel toggles.
        const audioConstraints = {
            autoGainControl: !!(captureOpts && captureOpts.autoGainControl),
            noiseSuppression: !!(captureOpts && captureOpts.noiseSuppression),
            echoCancellation: !!(captureOpts && captureOpts.echoCancellation),
        };
        if (deviceId && deviceId !== 'default') {
            audioConstraints.deviceId = { exact: deviceId };
        }
        return __xfwOriginalGUM.call(navigator.mediaDevices, { audio: audioConstraints });
    }

    function buildGraph() {
        const ctx = ensureAudioContext();
        // Always build — even with zero sources we need processedDest.stream so
        // the WebRTC relay has a live (possibly silent) track ready for X before
        // the user opens the mixer or adds any sources.

        // Tear down existing wiring on every node we touch.
        try { micSrcNode && micSrcNode.disconnect(); } catch {}
        try { auxSrcNode && auxSrcNode.disconnect(); } catch {}
        try { aux2SrcNode && aux2SrcNode.disconnect(); } catch {}
        for (const n of xcastSrcNodes) { try { n.disconnect(); } catch {} }
        try { micGainNode && micGainNode.disconnect(); } catch {}
        try { auxGainNode && auxGainNode.disconnect(); } catch {}
        try { aux2GainNode && aux2GainNode.disconnect(); } catch {}
        try { xcastGainNode && xcastGainNode.disconnect(); } catch {}
        try { micMixSend && micMixSend.disconnect(); } catch {}
        try { auxMixSend && auxMixSend.disconnect(); } catch {}
        try { aux2MixSend && aux2MixSend.disconnect(); } catch {}
        try { xcastMixSend && xcastMixSend.disconnect(); } catch {}
        try { micMonitorGain && micMonitorGain.disconnect(); } catch {}
        try { auxMonitorGain && auxMonitorGain.disconnect(); } catch {}
        try { aux2MonitorGain && aux2MonitorGain.disconnect(); } catch {}
        try { xcastMonitorGain && xcastMonitorGain.disconnect(); } catch {}
        try { mixBus && mixBus.disconnect(); } catch {}
        try { loopRecordBus && loopRecordBus.disconnect(); } catch {}

        // Per-channel input gains (with mute) and meters.
        micGainNode = ctx.createGain();
        micGainNode.gain.value = settings.micMuted ? 0 : dbToLin(settings.micGainDb);
        auxGainNode = ctx.createGain();
        auxGainNode.gain.value = settings.auxMuted ? 0 : dbToLin(settings.auxGainDb);
        aux2GainNode = ctx.createGain();
        aux2GainNode.gain.value = settings.aux2Muted ? 0 : dbToLin(settings.aux2GainDb);
        xcastGainNode = ctx.createGain();
        xcastGainNode.gain.value = settings.xcastMuted ? 0 : dbToLin(settings.xcastGainDb);
        micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 1024;
        auxAnalyser = ctx.createAnalyser(); auxAnalyser.fftSize = 1024;
        aux2Analyser = ctx.createAnalyser(); aux2Analyser.fftSize = 1024;
        xcastAnalyser = ctx.createAnalyser(); xcastAnalyser.fftSize = 1024;

        // Summing bus where all channels meet before the DSP chain.
        mixBus = ctx.createGain();
        mixBus.gain.value = 1;

        // Loop Station recording tap (see declaration above) — independent of
        // Cue/mixSend, so recording a loop always captures live mic/aux input.
        loopRecordBus = ctx.createGain(); loopRecordBus.gain.value = 1;
        loopRecordDest = ctx.createMediaStreamDestination();
        loopRecordBus.connect(loopRecordDest);
        loopRecordStream = loopRecordDest.stream;
        micGainNode.connect(loopRecordBus);
        auxGainNode.connect(loopRecordBus);
        aux2GainNode.connect(loopRecordBus);
        xcastGainNode.connect(loopRecordBus);

        // Headset monitor bus — separate destination so we can hear channels
        // in our headphones without sending the monitor mix back to X.
        monitorDest = ctx.createMediaStreamDestination();
        // Mix-send gains: when cue is ON, this gain is 0 — channel is heard in
        // monitor only and never reaches the broadcast mix.
        micMixSend = ctx.createGain();
        micMixSend.gain.value = settings.micCue ? 0 : 1;
        auxMixSend = ctx.createGain();
        auxMixSend.gain.value = settings.auxCue ? 0 : 1;
        aux2MixSend = ctx.createGain();
        aux2MixSend.gain.value = settings.aux2Cue ? 0 : 1;
        xcastMixSend = ctx.createGain();
        xcastMixSend.gain.value = settings.xcastCue ? 0 : 1;
        micMonitorGain = ctx.createGain();
        micMonitorGain.gain.value = (settings.micMonitor || settings.micCue) ? 1 : 0;
        auxMonitorGain = ctx.createGain();
        auxMonitorGain.gain.value = (settings.auxMonitor || settings.auxCue) ? 1 : 0;
        aux2MonitorGain = ctx.createGain();
        aux2MonitorGain.gain.value = (settings.aux2Monitor || settings.aux2Cue) ? 1 : 0;
        xcastMonitorGain = ctx.createGain();
        xcastMonitorGain.gain.value = (settings.xcastMonitor || settings.xcastCue) ? 1 : 0;
        micMixSend.connect(mixBus);
        auxMixSend.connect(mixBus);
        aux2MixSend.connect(mixBus);
        xcastMixSend.connect(mixBus);
        micMonitorGain.connect(monitorDest);
        auxMonitorGain.connect(monitorDest);
        aux2MonitorGain.connect(monitorDest);
        xcastMonitorGain.connect(monitorDest);

        // Metronome click — wired STRAIGHT to monitorDest (headset/monitor-only
        // bus), never to sbBus/loopRecordBus/mixBus, so it's always audible to
        // the caster but can never leak into loop recordings or the X broadcast.
        if (metronomeGain) { try { metronomeGain.disconnect(); } catch {} }
        metronomeGain = ctx.createGain();
        metronomeGain.gain.value = 1;
        metronomeGain.connect(monitorDest);
        if (settings.metronomeEnabled) _startMetronome();

        // Soundboard bus — pads, synth voices, and looper all connect here.
        if (sbBus)  { try { sbBus.disconnect();  } catch {} }
        if (sbSourceBus)   { try { sbSourceBus.disconnect();   } catch {} }
        if (sbGainNode)    { try { sbGainNode.disconnect();    } catch {} }
        if (sbMixSend)     { try { sbMixSend.disconnect();     } catch {} }
        if (sbMonitorGain) { try { sbMonitorGain.disconnect(); } catch {} }
        if (sbAnalyser)    { try { sbAnalyser.disconnect();    } catch {} }
        sbBus = ctx.createGain(); sbBus.gain.value = 1;
        // Pads + synth (live-triggered sound, NOT existing loop tracks) also feed
        // the Loop Station recording tap — otherwise hitting a pad/MIDI key while
        // recording is perfectly audible live but never ends up in the recorded
        // loop, since loopRecordBus previously only tapped mic/aux/xcast. Loop
        // tracks intentionally do NOT connect here (they connect straight to
        // sbBus below) so overdubbing a track doesn't re-capture its own already-
        // recorded playback into the new take. Respects the Sounds channel Mute
        // (like mic mute does for its own recording tap) via applyMixerLive().
        sbSourceBus = ctx.createGain();
        sbSourceBus.gain.value = settings.sbMuted ? 0 : 1;
        sbSourceBus.connect(sbBus);
        sbSourceBus.connect(loopRecordBus);
        sbGainNode = ctx.createGain();
        sbGainNode.gain.value = (settings.sbMuted || settings.sbGainDb <= -40) ? 0 : dbToLin(settings.sbGainDb);
        sbMixSend = ctx.createGain(); sbMixSend.gain.value = settings.sbCue ? 0 : 1;
        sbMonitorGain = ctx.createGain();
        sbMonitorGain.gain.value = (settings.sbMonitor || settings.sbCue) ? 1 : 0;
        sbAnalyser = ctx.createAnalyser(); sbAnalyser.fftSize = 1024;
        sbBus.connect(sbGainNode);
        sbGainNode.connect(sbAnalyser);
        sbGainNode.connect(sbMixSend);
        sbGainNode.connect(sbMonitorGain);
        sbMixSend.connect(mixBus);
        sbMonitorGain.connect(monitorDest);
        // Reconnect synth to the new pad/synth source bus, and looper layers straight to sbBus.
        if (_synthDest) { try { _synthDest.disconnect(); } catch {} _synthDest.connect(sbSourceBus); }
        for (const L of _loops) {
            if (L.gainNode) { try { L.gainNode.disconnect(); } catch {} L.gainNode.connect(sbBus); }
        }

        // Pitch / autotune node — inserted between mic source and mic gain.
        if (pitchNode) { try { pitchNode.disconnect(); } catch {} pitchNode = null; }
        if (settings.autotuneEnabled && _pitchWorkletLoaded) {
            try {
                pitchNode = new AudioWorkletNode(ctx, 'xcaster-pitch', {
                    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
                });
                updatePitchNode();
            } catch (e) {
                console.warn('[XCaster] pitch node create failed', e);
                pitchNode = null;
            }
        }

        if (micSrcNode) {
            if (pitchNode) {
                micSrcNode.connect(pitchNode);
                pitchNode.connect(micGainNode);
            } else {
                micSrcNode.connect(micGainNode);
            }
            micSrcNode.connect(micAnalyser);
            micGainNode.connect(micMixSend);
            micGainNode.connect(micMonitorGain);
        }
        if (auxSrcNode) {
            auxSrcNode.connect(auxGainNode);
            auxSrcNode.connect(auxAnalyser);
            auxGainNode.connect(auxMixSend);
            auxGainNode.connect(auxMonitorGain);
        }
        if (aux2SrcNode) {
            aux2SrcNode.connect(aux2GainNode);
            aux2SrcNode.connect(aux2Analyser);
            aux2GainNode.connect(aux2MixSend);
            aux2GainNode.connect(aux2MonitorGain);
        }
        if (xcastSrcNodes.length) {
            // Pre-mix all tab captures into one bus before the channel gain.
            const xcastPreMix = audioCtx.createGain();
            xcastPreMix.gain.value = 1;
            for (const src of xcastSrcNodes) src.connect(xcastPreMix);
            xcastPreMix.connect(xcastGainNode);
            xcastPreMix.connect(xcastAnalyser);
            xcastGainNode.connect(xcastMixSend);
            xcastGainNode.connect(xcastMonitorGain);
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

        // Pipe the monitor MediaStream directly into xOutputCtx so it plays out
        // the user's selected output device. Done async after ensureXOutputCtx
        // has set the sink, so first sample lands on the right device.
        attachMonitorToOutput(monitorDest.stream);
        // Route the fully processed mix to the broadcast output device (virtual cable).
        // Always on — independent of per-channel monitor toggles and cue state.
        attachBroadcastToOutput(processedDest.stream);
    }

    let monitorSrcNode = null; // node inside xOutputCtx
    async function attachMonitorToOutput(stream) {
        try {
            const ctx = await ensureXOutputCtx();
            if (monitorSrcNode) { try { monitorSrcNode.disconnect(); } catch {} }
            monitorSrcNode = ctx.createMediaStreamSource(stream);
            monitorSrcNode.connect(ctx.destination);
            console.info('[XCaster] monitor bus attached to output device');
        } catch (err) {
            console.warn('[XCaster] attachMonitorToOutput failed', err);
        }
    }

    // Broadcast out — routes the fully processed mix to a separate device
    // (e.g. virtual cable input) at all times, independent of monitor toggles.
    // X Spaces receives this via CABLE Output selected as the mic in X's UI.
    async function ensureXBroadcastCtx() {
        const id = settings.broadcastDeviceId;
        if (!id || id === 'none') return null;
        if (!xBroadcastCtx || xBroadcastCtx.state === 'closed') {
            xBroadcastCtx = new _NativeAudioContext({ latencyHint: 'playback' });
            xBroadcastCtxSink = null;
        }
        if (xBroadcastCtx.state === 'suspended') await xBroadcastCtx.resume().catch(() => {});
        if (id !== xBroadcastCtxSink && typeof xBroadcastCtx.setSinkId === 'function') {
            try {
                await xBroadcastCtx.setSinkId(id === 'default' ? '' : id);
                xBroadcastCtxSink = id;
            } catch (err) {
                console.warn('[XCaster] xBroadcastCtx.setSinkId failed', err);
            }
        }
        return xBroadcastCtx;
    }

    async function attachBroadcastToOutput(stream) {
        if (!stream) return;
        try {
            const ctx = await ensureXBroadcastCtx();
            if (!ctx) return; // no broadcast device selected
            if (broadcastSrcNode) { try { broadcastSrcNode.disconnect(); } catch {} }
            broadcastSrcNode = ctx.createMediaStreamSource(stream);
            broadcastSrcNode.connect(ctx.destination);
            console.info('[XCaster] broadcast mix attached to broadcast device');
        } catch (err) {
            console.warn('[XCaster] attachBroadcastToOutput failed', err);
        }
    }

    function applyMixerLive() {
        // Mic mute is a CHANNEL mute: it zeroes the mic channel gain only.
        // It must NOT touch the WebRTC sender track — that track carries the
        // whole mix (mic + aux 1 + aux 2 + xCaster + Sounds), so disabling it
        // here would silence every channel instead of just the mic.
        // Muting the whole outgoing feed is X's own in-Space mic button; see
        // setXBroadcastMuted() / bridgeXMuteTrack().
        if (micGainNode) micGainNode.gain.value = settings.micMuted ? 0 : dbToLin(settings.micGainDb);
        if (sbGainNode)    sbGainNode.gain.value    = (settings.sbMuted || settings.sbGainDb <= -40) ? 0 : dbToLin(settings.sbGainDb);
        if (sbSourceBus)   sbSourceBus.gain.value   = settings.sbMuted ? 0 : 1;
        if (sbMixSend)     sbMixSend.gain.value     = settings.sbCue  ? 0 : 1;
        if (sbMonitorGain) sbMonitorGain.gain.value = (settings.sbMonitor || settings.sbCue) ? 1 : 0;
        if (_loops) for (let i = 0; i < _loops.length; i++) { if (_loops[i].gainNode) _loops[i].gainNode.gain.value = _loopTrackGain(i); }
        if (auxGainNode) auxGainNode.gain.value = settings.auxMuted ? 0 : dbToLin(settings.auxGainDb);
        if (aux2GainNode) aux2GainNode.gain.value = settings.aux2Muted ? 0 : dbToLin(settings.aux2GainDb);
        if (xcastGainNode) xcastGainNode.gain.value = settings.xcastMuted ? 0 : dbToLin(settings.xcastGainDb);
        if (micMixSend) micMixSend.gain.value = settings.micCue ? 0 : 1;
        if (auxMixSend) auxMixSend.gain.value = settings.auxCue ? 0 : 1;
        if (aux2MixSend) aux2MixSend.gain.value = settings.aux2Cue ? 0 : 1;
        if (xcastMixSend) xcastMixSend.gain.value = settings.xcastCue ? 0 : 1;
        // Cue forces monitor on so you can hear the cued channel.
        if (micMonitorGain) micMonitorGain.gain.value = (settings.micMonitor || settings.micCue) ? 1 : 0;
        if (auxMonitorGain) auxMonitorGain.gain.value = (settings.auxMonitor || settings.auxCue) ? 1 : 0;
        if (aux2MonitorGain) aux2MonitorGain.gain.value = (settings.aux2Monitor || settings.aux2Cue) ? 1 : 0;
        if (xcastMonitorGain) xcastMonitorGain.gain.value = (settings.xcastMonitor || settings.xcastCue) ? 1 : 0;
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
        const ctx = ensureAudioContext();
        // Await resume so the graph isn't built on a suspended context.
        // This is safe here because getUserMedia is always triggered by a
        // user gesture (joining a Space), which allows AudioContext.resume().
        if (ctx.state === 'suspended') {
            try { await ctx.resume(); } catch {}
        }
        if (!micRawStream) {
            try { micRawStream = await acquireDevice(settings.inputDeviceId, {
                autoGainControl: settings.micAutoGainControl,
                noiseSuppression: settings.micNoiseSuppression,
                echoCancellation: settings.micEchoCancellation,
            }); }
            catch (err) { console.warn('[XCaster] mic acquire failed', err); }
        }
        if (micRawStream && !micSrcNode) {
            micSrcNode = audioCtx.createMediaStreamSource(micRawStream);
            watchStream(micRawStream, () => rebuildMic());
        }
        if (settings.auxDeviceId && settings.auxDeviceId !== 'none' && !auxRawStream) {
            try { auxRawStream = await acquireDevice(settings.auxDeviceId, {
                autoGainControl: settings.auxAutoGainControl,
                noiseSuppression: settings.auxNoiseSuppression,
                echoCancellation: settings.auxEchoCancellation,
            }); }
            catch (err) { console.warn('[XCaster] aux acquire failed', err); }
        }
        if (auxRawStream && !auxSrcNode) {
            auxSrcNode = audioCtx.createMediaStreamSource(auxRawStream);
            watchStream(auxRawStream, () => rebuildAux());
        }
        if (settings.aux2DeviceId && settings.aux2DeviceId !== 'none' && !aux2RawStream) {
            try { aux2RawStream = await acquireDevice(settings.aux2DeviceId, {
                autoGainControl: settings.aux2AutoGainControl,
                noiseSuppression: settings.aux2NoiseSuppression,
                echoCancellation: settings.aux2EchoCancellation,
            }); }
            catch (err) { console.warn('[XCaster] aux2 acquire failed', err); }
        }
        if (aux2RawStream && !aux2SrcNode) {
            aux2SrcNode = audioCtx.createMediaStreamSource(aux2RawStream);
            watchStream(aux2RawStream, () => rebuildAux2());
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
            buildGraph(); replaceTracksOnActivePCs(); return;
        }
        await ensureProcessedStream();
        replaceTracksOnActivePCs();
    }
    async function rebuildAux2() {
        try { if (aux2RawStream) aux2RawStream.getTracks().forEach(t => t.stop()); } catch {}
        aux2RawStream = null; aux2SrcNode = null;
        if (!settings.aux2DeviceId || settings.aux2DeviceId === 'none') {
            buildGraph(); replaceTracksOnActivePCs(); return;
        }
        await ensureProcessedStream();
        replaceTracksOnActivePCs();
    }

    // ── xCaster channel ────────────────────────────────────────────────────
    // Captures audio from every tab via getDisplayMedia (one call per tab).
    // suppressLocalAudioPlayback stops the tab from playing to system audio,
    // so the virtual cable / Aux1 never see the tab's audio.
    // All tab streams are pre-mixed into the xCaster channel gain/DSP chain.

    async function requestXcastDisplayStream() {
        try {
            return await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: {
                    suppressLocalAudioPlayback: true,
                    autoGainControl: false,
                    noiseSuppression: false,
                    echoCancellation: false,
                },
            });
        } catch (err) {
            console.warn('[XCaster] suppress-local capture failed, retrying', err);
            return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        }
    }

    async function captureTab(wcId) {
        if (_capturedWcIds.has(wcId)) return; // already captured
        _capturedWcIds.add(wcId);
        const ctx = ensureAudioContext();
        // Tell main.js which tab to resolve this specific getDisplayMedia call with.
        window.__xcNextCaptureWcId = wcId;
        try {
            const stream = await requestXcastDisplayStream();
            for (const t of stream.getVideoTracks()) { try { t.stop(); } catch {} }
            const audioTracks = stream.getAudioTracks();
            if (!audioTracks.length) { _capturedWcIds.delete(wcId); return; }
            const rawStream = new MediaStream(audioTracks);
            const srcNode = ctx.createMediaStreamSource(rawStream);
            xcastRawStreams.push(rawStream);
            xcastSrcNodes.push(srcNode);
            audioTracks[0].addEventListener('ended', () => {
                _capturedWcIds.delete(wcId);
                const i = xcastSrcNodes.indexOf(srcNode);
                if (i !== -1) {
                    try { srcNode.disconnect(); } catch {}
                    try { rawStream.getTracks().forEach(t => t.stop()); } catch {}
                    xcastSrcNodes.splice(i, 1);
                    xcastRawStreams.splice(i, 1);
                }
                settings.xcastEnabled = xcastSrcNodes.length > 0;
                settings.xcastSourceLabel = xcastSrcNodes.length > 0 ? xcastSrcNodes.length + ' tab(s)' : '';
                saveSettings(settings);
                buildGraph();
                replaceTracksOnActivePCs();
                paintXcastStatus();
            });
        } catch (err) {
            _capturedWcIds.delete(wcId);
            console.warn('[XCaster] captureTab failed', wcId, err);
        } finally {
            window.__xcNextCaptureWcId = null;
        }
    }

    async function startXcast() {
        ensureAudioContext();
        // Stop all existing captures.
        for (const s of xcastRawStreams) { try { s.getTracks().forEach(t => t.stop()); } catch {} }
        for (const n of xcastSrcNodes) { try { n.disconnect(); } catch {} }
        xcastRawStreams = []; xcastSrcNodes = []; _capturedWcIds.clear();

        // Ensure mic/aux DSP chain is ready before wiring xcast into it.
        await ensureProcessedStream();

        const allTabs = Array.isArray(window.__xcAllTabWcIds) ? [...window.__xcAllTabWcIds] : [];
        for (const wcId of allTabs) await captureTab(wcId);

        settings.xcastEnabled = xcastSrcNodes.length > 0;
        settings.xcastSourceLabel = xcastSrcNodes.length > 0 ? xcastSrcNodes.length + ' tab(s)' : '';
        saveSettings(settings);
        buildGraph();
        replaceTracksOnActivePCs();
        paintXcastStatus();
    }

    // Called by shell.js when the tab list changes (new tabs loaded).
    window.__xcTabsUpdated = async (allWcIds) => {
        if (!Array.isArray(allWcIds)) return;
        let added = false;
        for (const wcId of allWcIds) {
            if (!_capturedWcIds.has(wcId)) {
                await captureTab(wcId);
                added = true;
            }
        }
        if (added) {
            settings.xcastEnabled = xcastSrcNodes.length > 0;
            settings.xcastSourceLabel = xcastSrcNodes.length > 0 ? xcastSrcNodes.length + ' tab(s)' : '';
            saveSettings(settings);
            buildGraph();
            replaceTracksOnActivePCs();
            paintXcastStatus();
        }
    };

    function stopXcast() {
        for (const s of xcastRawStreams) { try { s.getTracks().forEach(t => t.stop()); } catch {} }
        for (const n of xcastSrcNodes) { try { n.disconnect(); } catch {} }
        xcastRawStreams = []; xcastSrcNodes = []; _capturedWcIds.clear();
        settings.xcastEnabled = false;
        settings.xcastSourceLabel = '';
        saveSettings(settings);
        buildGraph();
        replaceTracksOnActivePCs();
        paintXcastStatus();
    }

    function paintXcastStatus() {
        const status = document.getElementById('xfw-xcast-status');
        if (!status) return;
        if (settings.xcastEnabled) {
            const n = xcastSrcNodes.length;
            status.textContent = '\u25CF Capturing ' + n + ' tab' + (n !== 1 ? 's' : '');
            status.className = 'xfw-spk-status xfw-spk-ok';
        } else {
            status.textContent = 'No tabs captured. Open a tab to start.';
            status.className = 'xfw-spk-status';
        }
    }

    async function rebuildAfterDeviceChange() {
        // Settings are in this context's own localStorage — no IPC sync needed.
        try { if (micRawStream) micRawStream.getTracks().forEach(t => t.stop()); } catch {}
        try { if (auxRawStream) auxRawStream.getTracks().forEach(t => t.stop()); } catch {}
        try { if (aux2RawStream) aux2RawStream.getTracks().forEach(t => t.stop()); } catch {}
        micRawStream = null; micSrcNode = null;
        auxRawStream = null; auxSrcNode = null;
        aux2RawStream = null; aux2SrcNode = null;
        processedStream = null;
        await ensureProcessedStream();
        replaceTracksOnActivePCs();
    }

    // More robust version: find opus PT and set/replace its fmtp line entirely.
    function patchOpusSdp(sdp) {
        const ptMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
        if (!ptMatch) return sdp;
        const pt = ptMatch[1];
        const fmtp = `a=fmtp:${pt} minptime=10;useinbandfec=0;usedtx=0;stereo=1;sprop-stereo=1;maxaveragebitrate=510000;cbr=1`;
        // Remove any existing fmtp for this PT, then insert after rtpmap line.
        let out = sdp.replace(new RegExp(`a=fmtp:${pt} [^\r\n]+[\r\n]+`, 'g'), '');
        out = out.replace(new RegExp(`(a=rtpmap:${pt} opus[^\r\n]+[\r\n])`), `$1${fmtp}\r\n`);
        return out;
    }

    const _broadcastPCs = {};
    // Expose current settings to webview so it can mirror our device selection.
    window.__xcGetSettings = () => JSON.stringify(settings);

    // Creates a relay carrying ONLY the xCaster tab-capture mix.
    // Webview uses this as its xcast source node — mic/aux are captured directly
    // in the webview context (one Opus encode, same as v0.5.0).
    window.__xcCreateXcastOffer = async () => {
        try {
            if (!xcastSrcNodes.length) return { empty: true };
            const ctx = ensureAudioContext();
            const xcastOnlyDest = ctx.createMediaStreamDestination();
            const premix = ctx.createGain();
            premix.connect(xcastOnlyDest);
            for (const node of xcastSrcNodes) { try { node.connect(premix); } catch {} }
            const pc = new RealPC({ iceServers: [] }); // unpatched — keep out of __xfwPCs
            const id = 'xc_' + Date.now() + '_' + Math.random().toString(36).slice(2);
            _broadcastPCs[id] = pc;
            for (const t of xcastOnlyDest.stream.getAudioTracks()) pc.addTrack(t);
            const offerSdp = await new Promise((resolve) => {
                let settled = false;
                const finish = () => { if (!settled) { settled = true; resolve(pc.localDescription?.sdp || null); } };
                pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') finish(); };
                pc.createOffer().then(o => {
                    const patched = { type: o.type, sdp: patchOpusSdp(o.sdp) };
                    return pc.setLocalDescription(patched);
                });
                setTimeout(finish, 3000);
            });
            if (!offerSdp) { delete _broadcastPCs[id]; return null; }
            return { id, sdp: offerSdp };
        } catch (err) {
            console.warn('[XCaster] createXcastOffer failed', err);
            return null;
        }
    };

    // ---------- X Space mute bridge ----------------------------------------
    // X's in-Space mic button mutes by flipping `enabled` on the audio track it
    // was handed by getUserMedia. We hand X a *clone* of our processed mix, and
    // swap in fresh clones on every device change / graph rebuild, so the object
    // X holds drifts away from the one the RTCRtpSender is actually sending —
    // flipping it did nothing at all.
    //
    // Fix: intercept `enabled` on every track we give X (the gUM return value and
    // each replaceTrack clone) and translate it into a broadcast master mute. The
    // gate is applied to the sender tracks, so it silences what X receives while
    // leaving the headset monitor and the broadcast-out device alone.
    let xBroadcastMuted = false;
    const _TRACK_ENABLED_DESC =
        Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled');

    function _setTrackEnabledRaw(track, value) {
        try {
            if (_TRACK_ENABLED_DESC && _TRACK_ENABLED_DESC.set) _TRACK_ENABLED_DESC.set.call(track, value);
            else track.enabled = value;
        } catch { /* ignore */ }
    }

    // Wrap `enabled` on a track handed to X so we learn when X mutes/unmutes.
    // Set the track's initial state with _setTrackEnabledRaw BEFORE bridging it,
    // otherwise the seed value is read back as a user mute action.
    function bridgeXMuteTrack(track) {
        if (!track || track.__xfwMuteBridged) return track;
        if (!_TRACK_ENABLED_DESC || !_TRACK_ENABLED_DESC.set) return track;
        track.__xfwMuteBridged = true;
        try {
            Object.defineProperty(track, 'enabled', {
                configurable: true,
                enumerable: false,
                get() { return _TRACK_ENABLED_DESC.get.call(this); },
                set(v) {
                    _TRACK_ENABLED_DESC.set.call(this, v);
                    setXBroadcastMuted(!v);
                },
            });
        } catch { /* ignore */ }
        return track;
    }

    function setXBroadcastMuted(muted) {
        muted = !!muted;
        if (muted === xBroadcastMuted) return;
        xBroadcastMuted = muted;
        applyXBroadcastMute();
        paintXMuteStatus();
        console.info('[XCaster] X Space mic', muted ? 'MUTED' : 'live');
    }

    // Mirror the mute onto every outgoing audio sender. Written through the raw
    // descriptor so bridged tracks don't re-enter setXBroadcastMuted().
    function applyXBroadcastMute() {
        const enabled = !xBroadcastMuted;
        for (const pc of __xfwPCs) {
            try {
                for (const s of pc.getSenders()) {
                    if (s.track && s.track.kind === 'audio') _setTrackEnabledRaw(s.track, enabled);
                }
            } catch { /* ignore */ }
        }
    }

    function paintXMuteStatus() {
        const el = document.getElementById('xfw-xmute-status');
        if (!el) return;
        el.textContent = xBroadcastMuted
            ? 'X Space mic: MUTED — nothing is reaching the Space.'
            : 'X Space mic: live — the full mix is reaching the Space.';
        el.style.color = xBroadcastMuted ? '#f87171' : 'var(--xfw-muted)';
    }

    // ---------- getUserMedia interception ----------------------------------
    // Save originals BEFORE anything else can capture references.
    const md = navigator.mediaDevices;
    const __xfwOriginalGUM = md.getUserMedia.bind(md);
    window.__xfwOriginalGUM = __xfwOriginalGUM;

    md.getUserMedia = async function (constraints) {
        try {
            // v0.5.0: single unified path. Only intercept when audio is requested.
            const wantsAudio = constraints && constraints.audio;
            const wantsVideo = constraints && constraints.video;

            if (!wantsAudio) {
                return __xfwOriginalGUM(constraints);
            }

            const isXDomain = /(?:^|\.)(?:x\.com|twitter\.com)$/.test(location.hostname);
            if (!isXDomain) {
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
            const xTrack = audioTrack.clone();
            _setTrackEnabledRaw(xTrack, !xBroadcastMuted);
            out.addTrack(bridgeXMuteTrack(xTrack));
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
    // RealPC was saved earlier (before patchAudioContext) — no re-declaration needed.
    if (RealPC) {
        window.RTCPeerConnection = function (...args) {
            const pc = new RealPC(...args);
            __xfwPCs.add(pc);
            pc.addEventListener('connectionstatechange', () => {
                // Only 'closed' is untrackable. A 'failed' connection was being
                // dropped here too, which hid the dead Space from the inbound
                // watchdog and from _updateAudioActiveFlag — so the view got
                // throttled and de-prioritised at the exact moment it needed
                // help recovering. 'failed' can still be ICE-restarted; keep it.
                if (pc.connectionState === 'closed') __xfwPCs.delete(pc);
                if (pc.connectionState === 'connected') replaceTracksOnActivePCs();
                // Immediate, so switching tabs right after joining a Space does
                // not race the 4s health watchdog and get the view throttled.
                _updateAudioActiveFlag();
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
                        // Preserve the mute state X or the host applied to the current
                        // track: our own X-Space mute, or a mute X set on this sender.
                        const muted = xBroadcastMuted || !sender.track.enabled;
                        const t = newTrack.clone();
                        // Seed through the raw setter first, then bridge, so seeding
                        // isn't mistaken for X toggling its mic button.
                        _setTrackEnabledRaw(t, !muted);
                        bridgeXMuteTrack(t);
                        // Disable APM so Chrome's AGC doesn't pump the level.
                        t.applyConstraints({ autoGainControl: false, noiseSuppression: false, echoCancellation: false }).catch(() => {});
                        sender.replaceTrack(t);
                    }
                }
            } catch (e) { /* ignore */ }
        }
    }

    async function healActiveAudioSendersIfNeeded() {
        let hasStaleSender = false;
        for (const pc of __xfwPCs) {
            try {
                for (const sender of pc.getSenders()) {
                    const track = sender?.track;
                    if (!track || track.kind !== 'audio') continue;
                    if (track.readyState === 'ended') {
                        hasStaleSender = true;
                        break;
                    }
                }
            } catch { /* ignore */ }
            if (hasStaleSender) break;
        }
        if (!hasStaleSender) return false;

        // Ensure we have a live processed source before swapping sender tracks.
        const live = processedStream?.getAudioTracks?.()[0];
        if (!live || live.readyState === 'ended') {
            await ensureProcessedStream();
        }
        replaceTracksOnActivePCs();
        return true;
    }

    // ---------- output (speaker) routing -----------------------------------
    // X Spaces renders remote audio via HTMLMediaElement with srcObject = MediaStream.
    // HTMLMediaElement.setSinkId is unreliable here but AudioContext.setSinkId works
    // (confirmed by test tone). So we tap each element's stream via
    // createMediaStreamSource → route through xOutputCtx whose setSinkId is
    // explicitly AWAITED before any audio flows through it.

    const knownMedia = new WeakSet();
    const xRoutedElements = new WeakMap(); // element → { srcNode, gainNode, stream }

    // Dedicated context for X playback routing. Uses _NativeAudioContext so
    // our patchAudioContext doesn't fire a competing fire-and-forget setSinkId.
    let xOutputCtx = null;
    let xOutputCtxSink = null; // last successfully applied sinkId

    async function ensureXOutputCtx() {
        if (!xOutputCtx || xOutputCtx.state === 'closed') {
            xOutputCtx = new _NativeAudioContext({ latencyHint: 'playback' });
            xOutputCtxSink = null;
        }
        if (xOutputCtx.state === 'suspended') await xOutputCtx.resume().catch(() => {});
        const id = currentSinkId();
        if (id !== xOutputCtxSink && typeof xOutputCtx.setSinkId === 'function') {
            try {
                await xOutputCtx.setSinkId(id === 'default' ? '' : id);
                xOutputCtxSink = id;
                clearSinkError();
            } catch (err) {
                console.warn('[XCaster] xOutputCtx.setSinkId failed', err);
                notifySinkError(err);
            }
        }
        return xOutputCtx;
    }

    // Route an element's audio through xOutputCtx via createMediaElementSource.
    // Works for BOTH src= (timeline videos, blob URLs) and srcObject= (Spaces WebRTC).
    // createMediaElementSource detaches the element from the default output entirely,
    // so audio only exits via xOutputCtx → selected device.
    // NOTE: createMediaElementSource can only be called ONCE per element (browser
    // restriction), so we cache the source node and never re-create it.
    async function routeXElement(el) {
        if (!el) return;
        // Already routed? Just make sure the sink is current.
        if (xRoutedElements.has(el)) {
            await ensureXOutputCtx();
            return;
        }
        try {
            const ctx = await ensureXOutputCtx();
            // Guard: createMediaElementSource throws if element was already attached
            // to a different AudioContext. xOutputCtx is the only one we use for
            // routing so this should never happen — but catch defensively.
            const srcNode = ctx.createMediaElementSource(el);
            const gainNode = ctx.createGain();
            gainNode.gain.value = 1;
            srcNode.connect(gainNode);
            gainNode.connect(ctx.destination);
            xRoutedElements.set(el, { srcNode, gainNode });
            console.info('[XCaster] element routed to output device', el.tagName, el.src ? 'src=' : el.srcObject ? 'srcObject' : '(empty)');
        } catch (err) {
            console.warn('[XCaster] routeXElement failed', err, el);
        }
    }

    // No-op kept for compatibility; once createMediaElementSource is called we
    // can't undo it, and we don't need to — the element stays silent on default.
    function unrouteXElement(_el) { /* intentionally empty */ }

    function notifySinkError(err) {
        const el = document.getElementById('xfw-spk-status');
        if (el) {
            el.textContent = `⚠ Routing failed: ${err.message || err}. Audio may be going to the wrong device.`;
            el.className = 'xfw-spk-status xfw-spk-warn';
        }
        const tab = document.querySelector('.xfw-tab[data-pane="spk"]');
        if (tab && !tab.querySelector('.xfw-tab-warn')) {
            const badge = document.createElement('span');
            badge.className = 'xfw-tab-warn';
            badge.title = 'Output routing has errors';
            tab.appendChild(badge);
        }
    }
    function clearSinkError() {
        const el = document.getElementById('xfw-spk-status');
        if (el) { el.textContent = ''; el.className = 'xfw-spk-status'; }
        document.querySelector('.xfw-tab-warn')?.remove();
    }

    function currentSinkId() { return settings.outputDeviceId || 'default'; }

    // Fallback setSinkId for elements with no srcObject (static src= audio).
    async function ensureSink(el) {
        if (!el || typeof el.setSinkId !== 'function') return;
        const id = currentSinkId();
        if (el.__xfwSink === id) return;
        try {
            await el.setSinkId(id === 'default' ? '' : id);
            el.__xfwSink = id;
        } catch (err) {
            console.warn('[XCaster] setSinkId fallback failed', err);
        }
    }

    async function testOutputDevice() {
        const statusEl = document.getElementById('xfw-spk-status');
        let ctx;
        try {
            // Use the native constructor (bypass patchAudioContext) so the
            // explicit awaited setSinkId below is the only sink call \u2014 no
            // race with the patch's fire-and-forget setSinkId.
            ctx = new _NativeAudioContext({ latencyHint: 'interactive' });
            if (typeof ctx.setSinkId === 'function') {
                const id = currentSinkId();
                await ctx.setSinkId(id === 'default' ? '' : id);
            }
            // Resume in case autoplay policy left it suspended.
            if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            gain.gain.value = 0.12;
            osc.type = 'sine';
            osc.frequency.value = 880;
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.5);
            osc.addEventListener('ended', () => { setTimeout(() => { try { ctx.close(); } catch {} }, 200); });
            if (statusEl) {
                statusEl.textContent = 'Tone sent \u2014 did you hear it from the right device?';
                statusEl.className = 'xfw-spk-status xfw-spk-ok';
            }
            document.querySelector('.xfw-tab-warn')?.remove();
        } catch (err) {
            try { ctx && ctx.close(); } catch {}
            console.warn('[XCaster] test tone failed', err);
            if (statusEl) {
                statusEl.textContent = `⚠ Routing failed: ${err.message || err}`;
                statusEl.className = 'xfw-spk-status xfw-spk-warn';
            }
        }
    }

    function registerMedia(el) {
        if (!el || knownMedia.has(el)) return;
        knownMedia.add(el);
        routeXElement(el);
    }

    // Update output routing on all elements. Awaits sink before re-routing.
    async function applySinkToAll() {
        await ensureXOutputCtx();      // set xOutputCtx sink first, awaited
        applySinkToAllContexts();       // update mic/aux AudioContexts
        document.querySelectorAll('audio, video').forEach(el => {
            registerMedia(el); // routes if not already; ensureXOutputCtx handles sink
        });
    }

    // ---------- incoming (Space playback) watchdog --------------------------
    // The capture side has recovery everywhere: rebuildMic/Aux/Aux2 on ended
    // tracks, healActiveAudioSendersIfNeeded() for stale senders, watchStream()
    // for device handoff. The playback side had none of it — the only check was
    // "resume xOutputCtx if suspended". So if the output context's render thread
    // died (a USB interface re-enumerating mid-Space is the usual cause) or a
    // remote element stalled, incoming Space audio went silent and STAYED silent
    // until you left and rejoined. This restores the symmetry.
    //
    // We cannot rebuild xOutputCtx to recover: createMediaElementSource may be
    // called only ONCE per element, so a fresh context would permanently orphan
    // every element already routed through the old one (see routeXElement). The
    // recovery is therefore resume + a FORCED setSinkId re-apply, which is what
    // un-wedges a stalled sink, plus re-playing elements that paused while still
    // holding a live track.
    let _xOutLastTime = -1;        // xOutputCtx.currentTime at the previous probe
    let _xOutLastAdvance = 0;      // wall clock when that value last changed
    let _xOutLastRecovery = 0;     // wall clock of the last recovery attempt
    const XOUT_STALL_MS = 6000;            // clock frozen this long => render thread dead
    const XOUT_RECOVERY_COOLDOWN_MS = 15000;

    function _hasLiveAudio(el) {
        const so = el && el.srcObject;
        if (!so || typeof so.getAudioTracks !== 'function') return false;
        try {
            return so.getAudioTracks().some(t => t.readyState === 'live' && !t.muted);
        } catch { return false; }
    }

    async function recoverXOutput(reason) {
        const now = Date.now();
        if (now - _xOutLastRecovery < XOUT_RECOVERY_COOLDOWN_MS) return;
        _xOutLastRecovery = now;
        console.warn('[XCaster] incoming-audio watchdog firing:', reason);
        try {
            if (xOutputCtx && xOutputCtx.state !== 'closed') {
                await xOutputCtx.resume().catch(() => {});
                // Re-issue setSinkId even though the device id is unchanged —
                // that is what recovers a wedged output endpoint. ensureXOutputCtx
                // skips the call when id === xOutputCtxSink, so clear it first.
                xOutputCtxSink = null;
            }
            await ensureXOutputCtx();
        } catch (err) {
            console.warn('[XCaster] output context recovery failed', err);
        }
        // Restart any routed element that paused while still holding live audio.
        for (const el of document.querySelectorAll('audio, video')) {
            if (!xRoutedElements.has(el) || !el.paused || !_hasLiveAudio(el)) continue;
            try {
                await el.play();
                console.info('[XCaster] restarted stalled media element', el.tagName);
            } catch (err) {
                console.warn('[XCaster] could not restart stalled element', err);
            }
        }
        _xOutLastTime = -1;              // re-baseline the probe after recovery
        _xOutLastAdvance = Date.now();
    }

    // Liveness probe. A frozen AudioContext clock is a direct signal that the
    // render thread stopped — unlike silence detection it cannot false-positive
    // on a quiet Space where nobody happens to be talking.
    function probeXOutputLiveness() {
        if (!xOutputCtx || xOutputCtx.state === 'closed') return;
        const now = Date.now();
        // 'interrupted' is a real state the old suspended-only check never
        // handled, and from the listener's side it looks exactly like a freeze.
        if (xOutputCtx.state !== 'running') {
            recoverXOutput('output context state=' + xOutputCtx.state);
            return;
        }
        const t = xOutputCtx.currentTime;
        if (t !== _xOutLastTime) { _xOutLastTime = t; _xOutLastAdvance = now; return; }
        if (_xOutLastAdvance && now - _xOutLastAdvance >= XOUT_STALL_MS) {
            recoverXOutput('output clock frozen at ' + t.toFixed(3) + 's for '
                + Math.round((now - _xOutLastAdvance) / 1000) + 's');
        }
    }

    // ---------- incoming WebRTC receive-side watchdog -----------------------
    // The output-context watchdog above cannot explain a freeze that only clears
    // when you leave and REJOIN the Space. xOutputCtx is created once and reused
    // (ensureXOutputCtx only rebuilds a CLOSED context), so the fresh <audio>
    // elements X creates on rejoin are routed into the SAME context. If that
    // context were the wedge, rejoining would change nothing — yet rejoining
    // reliably restores audio. So the stall is UPSTREAM of our output routing,
    // in the WebRTC receive path, and nothing watched that: watchStream() covers
    // mic/aux/aux2 only, and there was no getStats/getReceivers monitoring
    // anywhere in the overlay.
    //
    // Detect it from inbound-rtp stats. If packetsReceived stops advancing while
    // the connection still reports itself connected, incoming audio has stalled.
    // Opus DTX still emits roughly one packet per 400ms through silence, so a
    // completely flat counter over INBOUND_STALL_MS means a stall, not a quiet
    // room — the same reasoning that made the context clock the right signal
    // for the output side.
    let _inboundLastPackets = -1;
    let _inboundLastAdvance = 0;
    let _inboundStalled = false;
    let inboundScanInterval = 0;
    const INBOUND_POLL_MS = 3000;
    const INBOUND_STALL_MS = 10000;

    async function _readInboundAudio() {
        let total = 0, sawInbound = false, active = false, broken = null;
        for (const pc of __xfwPCs) {
            let state;
            try { state = pc.connectionState; } catch { continue; }
            if (state === 'closed') continue;
            // A connection in 'failed' or 'disconnected' is the whole point of
            // this probe: that is a Space that has gone dead and will not come
            // back on its own. The first version skipped every state except
            // 'connected', so it went silent in exactly that case and reported
            // "not in a Space" instead of a stall.
            if (state === 'failed' || state === 'disconnected') {
                broken = state;
                continue;
            }
            if (state !== 'connected') continue;   // 'new' / 'connecting'
            active = true;
            let stats;
            try { stats = await pc.getStats(); } catch { continue; }
            stats.forEach(r => {
                if (r.type === 'inbound-rtp' && r.kind === 'audio') {
                    sawInbound = true;
                    total += r.packetsReceived || 0;
                }
            });
        }
        return { total, sawInbound, active, broken };
    }

    function setInboundStalled(stalled, detail) {
        if (stalled === _inboundStalled) return;
        _inboundStalled = stalled;
        if (stalled) console.warn('[XCaster] incoming Space audio STALLED —', detail);
        else console.info('[XCaster] incoming Space audio flowing again');
        paintInboundStatus();
    }

    function paintInboundStatus() {
        const el = document.getElementById('xfw-inbound-status');
        const btn = document.getElementById('xfw-recover-inbound');
        if (el) {
            el.textContent = _inboundStalled
                ? '⚠ Incoming Space audio has stopped arriving. Recovery was attempted automatically — if it is still silent, leave and rejoin the Space.'
                : '';
            el.className = _inboundStalled ? 'xfw-spk-status xfw-spk-warn' : 'xfw-spk-status';
        }
        if (btn) btn.style.display = _inboundStalled ? '' : 'none';
    }

    async function probeInboundAudio() {
        const { total, sawInbound, active, broken } = await _readInboundAudio();

        // A failed/disconnected connection is a hard stall. Report it at once
        // rather than waiting out the packet timer — there are no packets to
        // wait for, and this is the state the user sees as audio frozen until
        // they leave and rejoin.
        if (broken) {
            _inboundLastPackets = -1;
            _inboundLastAdvance = 0;
            setInboundStalled(true, 'peer connection is ' + broken);
            autoRecoverInbound('connection ' + broken);
            return;
        }
        // Not in a Space, or no inbound audio yet — nothing to judge.
        if (!active || !sawInbound) {
            _inboundLastPackets = -1;
            _inboundLastAdvance = 0;
            setInboundStalled(false, '');
            return;
        }
        const now = Date.now();
        if (total !== _inboundLastPackets) {
            _inboundLastPackets = total;
            _inboundLastAdvance = now;
            setInboundStalled(false, '');
            return;
        }
        if (_inboundLastAdvance && now - _inboundLastAdvance >= INBOUND_STALL_MS) {
            const detail = 'packetsReceived frozen at ' + total + ' for '
                + Math.round((now - _inboundLastAdvance) / 1000) + 's';
            setInboundStalled(true, detail);
            autoRecoverInbound(detail);
        }
    }

    // Automatic recovery. This was deliberately manual-only at first, on the
    // reasoning that X owns the signalling and forcing renegotiation under it
    // should be the user's call. That reasoning does not survive the evidence:
    // the stall is PERMANENT — it does not clear when the app is brought back
    // to the foreground, and the only cure is leaving and rejoining. Against a
    // Space that is already dead, an ICE restart cannot make things worse, and
    // doing nothing guarantees the user has to rejoin. The manual button stays
    // for a second attempt.
    let _lastAutoRecover = 0;
    const AUTO_RECOVER_COOLDOWN_MS = 20000;
    function autoRecoverInbound(reason) {
        const now = Date.now();
        if (now - _lastAutoRecover < AUTO_RECOVER_COOLDOWN_MS) return;
        _lastAutoRecover = now;
        console.warn('[XCaster] attempting automatic ICE restart —', reason);
        recoverInboundAudio().catch(err => console.warn('[XCaster] auto recovery failed', err));
    }

    function startInboundScan() {
        if (inboundScanInterval) return;
        inboundScanInterval = setInterval(() => {
            probeInboundAudio().catch(() => {});
        }, INBOUND_POLL_MS);
    }

    // Manual recovery. restartIce() is the standard remedy for a receive path
    // that stopped getting packets, but X owns the signalling, so forcing a
    // renegotiation underneath it is the user's call — this is wired to a
    // BUTTON, never fired automatically. The fallback if it does not work is
    // leaving and rejoining, which is what you would be doing anyway.
    async function recoverInboundAudio() {
        let tried = 0;
        for (const pc of __xfwPCs) {
            try {
                if (pc.connectionState === 'closed') continue;
                if (typeof pc.restartIce !== 'function') continue;
                pc.restartIce();
                tried++;
            } catch (err) {
                console.warn('[XCaster] restartIce failed', err);
            }
        }
        console.info('[XCaster] requested ICE restart on', tried, 'connection(s)');
        // Give the output side a nudge too, in case both ends stalled together.
        await recoverXOutput('manual recovery requested from the Speakers pane');
        return tried;
    }

    let sinkScanInterval = 0;
    function startSinkScan() {
        if (sinkScanInterval) return;
        sinkScanInterval = setInterval(async () => {
            // Re-sync xOutputCtx sink in case device changed externally
            await ensureXOutputCtx();
            applySinkToAllContexts();
            document.querySelectorAll('audio, video').forEach(registerMedia);
            // Watchdog for the incoming Space audio (see recoverXOutput above).
            probeXOutputLiveness();
            // Fallback sync for X's in-Space mic button. bridgeXMuteTrack()
            // normally catches the toggle the moment X flips it; this covers a
            // sender whose track we never handed out (so was never bridged).
            // It drives the broadcast mute only — never the mic CHANNEL mute,
            // which is the user's own mixer setting and must stay independent.
            for (const pc of __xfwPCs) {
                try {
                    for (const s of pc.getSenders()) {
                        if (s.track && s.track.kind === 'audio') {
                            if (!s.track.__xfwMuteBridged) setXBroadcastMuted(!s.track.enabled);
                            break;
                        }
                    }
                } catch { /* ignore */ }
                break; // only check the first active PC
            }
        }, 2000);
    }

    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        registerMedia(this);
        return origPlay.call(this);
    };

    const srcObjectDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    if (srcObjectDesc && srcObjectDesc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
            configurable: true,
            enumerable: srcObjectDesc.enumerable,
            get: srcObjectDesc.get,
            set: function (val) {
                srcObjectDesc.set.call(this, val);
                registerMedia(this);
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
                <div class="xfw-version">v1.4.6</div>
            </div>

            <!-- PERSISTENT METERS (always visible) -->
            <div class="xfw-meters-bar">
                <div class="xfw-meter-row"><div class="xfw-meter-label">Mic</div><div class="xfw-meter"><div id="xfw-meter-mic" class="xfw-meter-fill"></div></div></div>
                <div class="xfw-meter-row"><div class="xfw-meter-label">Aux 1</div><div class="xfw-meter"><div id="xfw-meter-aux" class="xfw-meter-fill"></div></div></div>
                <div class="xfw-meter-row"><div class="xfw-meter-label">Aux 2</div><div class="xfw-meter"><div id="xfw-meter-aux2" class="xfw-meter-fill"></div></div></div>
                <div class="xfw-meter-row"><div class="xfw-meter-label">xCast</div><div class="xfw-meter"><div id="xfw-meter-xcast" class="xfw-meter-fill"></div></div></div>
                <div class="xfw-meter-row"><div class="xfw-meter-label">Sounds</div><div class="xfw-meter"><div id="xfw-meter-sb" class="xfw-meter-fill"></div></div></div>
                <div class="xfw-meter-row"><div class="xfw-meter-label">Mix</div><div class="xfw-meter"><div id="xfw-meter-in" class="xfw-meter-fill"></div></div></div>
                <div class="xfw-meter-row"><div class="xfw-meter-label">Out</div><div class="xfw-meter"><div id="xfw-meter-out" class="xfw-meter-fill"></div></div></div>
                <div class="xfw-meter-row"><div class="xfw-meter-label">GR</div><div class="xfw-meter"><div id="xfw-meter-gr" class="xfw-gr-meter-fill"></div></div></div>
            </div>

            <div class="xfw-tabs">
                <button class="xfw-tab xfw-active" data-pane="mic">Mic</button>
                <button class="xfw-tab" data-pane="aux">Aux 1</button>
                <button class="xfw-tab" data-pane="aux2">Aux 2</button>
                <button class="xfw-tab" data-pane="xcast">xCaster</button>
                <button class="xfw-tab" data-pane="sounds">Sounds</button>
                <button class="xfw-tab" data-pane="spk">Speakers</button>
                <button class="xfw-tab" data-pane="dsp">Processing</button>
                <button class="xfw-tab" data-pane="pre">Presets</button>
                <button class="xfw-tab" data-pane="fx">FX</button>
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
                        <div>Mute mic<span class="xfw-help">Silence the mic channel only. Aux, xCaster and Sounds keep sending. To mute everything, use X's own mic button in the Space.</span></div>
                        <div class="xfw-toggle" data-key="micMuted"></div>
                    </div>
                    <div id="xfw-xmute-status" class="xfw-help" style="margin:-2px 0 8px;font-size:11px;color:var(--xfw-muted);">X Space mic: live — the full mix is reaching the Space.</div>
                    <div class="xfw-row">
                        <div>Monitor in headset<span class="xfw-help">Hear yourself. OFF avoids latency/feedback.</span></div>
                        <div class="xfw-toggle" data-key="micMonitor"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Cue (monitor only)<span class="xfw-help">Hear it in your headset but DON'T send to X. Use to preload audio.</span></div>
                        <div class="xfw-toggle" data-key="micCue"></div>
                    </div>
                    <div class="xfw-slider-row" data-slider="micGainDb" data-min="-40" data-max="18" data-step="0.5" data-suffix=" dB" data-label="Mic level"></div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Browser capture (off = clean signal)</label>
                    <div class="xfw-row">
                        <div>Auto Gain Control<span class="xfw-help">Browser AGC. Keep OFF — we do compression instead.</span></div>
                        <div class="xfw-toggle" data-key="micAutoGainControl"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Noise Suppression<span class="xfw-help">Browser denoiser. OFF for music, ON if very noisy room.</span></div>
                        <div class="xfw-toggle" data-key="micNoiseSuppression"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Echo Cancellation<span class="xfw-help">Only useful with speakers + open mic. Usually OFF.</span></div>
                        <div class="xfw-toggle" data-key="micEchoCancellation"></div>
                    </div>
                </div>
            </div>

            <!-- AUX 1 PANE -->
            <div class="xfw-pane" data-pane="aux">
                <div class="xfw-section">
                    <label class="xfw-label" for="xfw-aux">Aux 1 device — desktop audio</label>
                    <select id="xfw-aux" class="xfw-select"></select>
                    <div class="xfw-help" style="margin-top:6px;color:var(--xfw-muted);font-size:11px;">
                        Desktop system audio (e.g. via VB-CABLE). Set to <b>None</b> to disable.
                    </div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Aux 1 channel</label>
                    <div class="xfw-row">
                        <div>Mute aux 1<span class="xfw-help">Silence without disabling the device.</span></div>
                        <div class="xfw-toggle" data-key="auxMuted"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Monitor in headset<span class="xfw-help">Hear Aux 1 (desktop audio) in your headphones.</span></div>
                        <div class="xfw-toggle" data-key="auxMonitor"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Cue (monitor only)<span class="xfw-help">Hear it in your headset but DON'T send to X. Use to preload audio.</span></div>
                        <div class="xfw-toggle" data-key="auxCue"></div>
                    </div>
                    <div class="xfw-slider-row" data-slider="auxGainDb" data-min="-40" data-max="18" data-step="0.5" data-suffix=" dB" data-label="Aux 1 level"></div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Browser capture (off = clean signal)</label>
                    <div class="xfw-row">
                        <div>Auto Gain Control<span class="xfw-help">Browser AGC. Keep OFF — we do compression instead.</span></div>
                        <div class="xfw-toggle" data-key="auxAutoGainControl"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Noise Suppression<span class="xfw-help">Browser denoiser. OFF for music, ON if very noisy room.</span></div>
                        <div class="xfw-toggle" data-key="auxNoiseSuppression"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Echo Cancellation<span class="xfw-help">Only useful with speakers + open mic. Usually OFF.</span></div>
                        <div class="xfw-toggle" data-key="auxEchoCancellation"></div>
                    </div>
                </div>
            </div>

            <!-- AUX 2 PANE -->
            <div class="xfw-pane" data-pane="aux2">
                <div class="xfw-section">
                    <label class="xfw-label" for="xfw-aux2">Aux 2 device — external receiver / mixer</label>
                    <select id="xfw-aux2" class="xfw-select"></select>
                    <div class="xfw-help" style="margin-top:6px;color:var(--xfw-muted);font-size:11px;">
                        External audio hardware (receiver, mixer, line-in). Set to <b>None</b> to disable.
                    </div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Aux 2 channel</label>
                    <div class="xfw-row">
                        <div>Mute aux 2<span class="xfw-help">Silence without disabling the device.</span></div>
                        <div class="xfw-toggle" data-key="aux2Muted"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Monitor in headset<span class="xfw-help">Hear Aux 2 (external hardware) in your headphones.</span></div>
                        <div class="xfw-toggle" data-key="aux2Monitor"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Cue (monitor only)<span class="xfw-help">Hear it in your headset but DON'T send to X. Use to preload audio.</span></div>
                        <div class="xfw-toggle" data-key="aux2Cue"></div>
                    </div>
                    <div class="xfw-slider-row" data-slider="aux2GainDb" data-min="-40" data-max="18" data-step="0.5" data-suffix=" dB" data-label="Aux 2 level"></div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Browser capture (off = clean signal)</label>
                    <div class="xfw-row">
                        <div>Auto Gain Control<span class="xfw-help">Browser AGC. Keep OFF — we do compression instead.</span></div>
                        <div class="xfw-toggle" data-key="aux2AutoGainControl"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Noise Suppression<span class="xfw-help">Browser denoiser. OFF for music, ON if very noisy room.</span></div>
                        <div class="xfw-toggle" data-key="aux2NoiseSuppression"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Echo Cancellation<span class="xfw-help">Only useful with speakers + open mic. Usually OFF.</span></div>
                        <div class="xfw-toggle" data-key="aux2EchoCancellation"></div>
                    </div>
                </div>
            </div>

            <!-- xCASTER PANE — in-app tab audio capture -->
            <div class="xfw-pane" data-pane="xcast">
                <div class="xfw-section">
                    <label class="xfw-label">xCaster audio channel</label>
                    <div class="xfw-help" style="color:var(--xfw-muted);font-size:11px;">
                        Audio from any tab in this app feeds into the xCaster channel and into your mix.
                    </div>
                    <div id="xfw-xcast-status" class="xfw-spk-status" style="margin-top:8px;"></div>
                </div>
                <div class="xfw-section">
                    <div class="xfw-row">
                        <div>Mute xCaster<span class="xfw-help">Silence the channel without stopping capture.</span></div>
                        <div class="xfw-toggle" data-key="xcastMuted"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Monitor in headset<span class="xfw-help">Hear the captured audio in your headphones.</span></div>
                        <div class="xfw-toggle" data-key="xcastMonitor"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Cue (monitor only)<span class="xfw-help">Audition without sending to the broadcast. Useful for previewing.</span></div>
                        <div class="xfw-toggle" data-key="xcastCue"></div>
                    </div>
                    <div class="xfw-slider-row" data-slider="xcastGainDb" data-min="-40" data-max="18" data-step="0.5" data-suffix=" dB" data-label="xCaster level"></div>
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
                <div class="xfw-section">
                    <div class="xfw-buttons">
                        <button id="xfw-test-spk" class="xfw-btn">Test speaker</button>
                    </div>
                    <div id="xfw-spk-status" class="xfw-spk-status"></div>
                    <div class="xfw-help" style="margin-top:6px;color:var(--xfw-muted);font-size:11px;">
                        Plays a short tone to confirm audio is reaching the selected device. If you hear it from your desktop speakers instead of the selected device, output routing is failing.
                    </div>
                </div>
            </div>

            <!-- SOUNDS PANE: Soundboard / Synth / Looper -->
            <div class="xfw-pane" data-pane="sounds">

                <!-- channel strip -->
                <div class="xfw-section">
                    <label class="xfw-label">Sounds channel</label>
                    <div class="xfw-row">
                        <div>Mute sounds<span class="xfw-help">Silence all pads, synth and looper without stopping playback.</span></div>
                        <div class="xfw-toggle" data-key="sbMuted"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Monitor in headset<span class="xfw-help">Hear sounds locally while broadcasting.</span></div>
                        <div class="xfw-toggle" data-key="sbMonitor"></div>
                    </div>
                    <div class="xfw-row">
                        <div>Cue (monitor only)<span class="xfw-help">Hear it in your headset but DON'T send to X. Use to preload/test sounds.</span></div>
                        <div class="xfw-toggle" data-key="sbCue"></div>
                    </div>
                    <div class="xfw-slider-row" data-slider="sbGainDb" data-min="-40" data-max="12" data-step="0.5" data-suffix=" dB" data-label="Sounds level"></div>
                    <div class="xfw-help" style="color:var(--xfw-muted);font-size:11px;">Drag all the way left to fully silence — one live slider for the whole Sounds channel.</div>
                </div>

                <!-- sub-tabs -->
                <div class="xfw-tabs xfw-sub-tabs">
                    <button class="xfw-tab xfw-sub-tab xfw-active" data-sub="pads">Pads</button>
                    <button class="xfw-tab xfw-sub-tab" data-sub="synth">Synth</button>
                    <button class="xfw-tab xfw-sub-tab" data-sub="looper">Looper</button>
                </div>

                <!-- PADS sub-pane -->
                <div class="xfw-sub-pane xfw-active" data-sub="pads">
                    <div class="xfw-section">
                        <div class="xfw-row xfw-row-select">
                            <div>MIDI input<span class="xfw-help">MIDI device used to trigger pads and play the synth.</span></div>
                            <select id="xfw-midi-device" class="xfw-select xfw-select-sm"><option value="all">All inputs</option></select>
                        </div>
                        <div class="xfw-row xfw-row-select">
                            <div>MIDI channel</div>
                            <select id="xfw-midi-channel" class="xfw-select xfw-select-sm">
                                <option value="0">All channels</option>
                                <option value="1">Ch 1</option><option value="2">Ch 2</option>
                                <option value="3">Ch 3</option><option value="4">Ch 4</option>
                                <option value="5">Ch 5</option><option value="6">Ch 6</option>
                                <option value="7">Ch 7</option><option value="8">Ch 8</option>
                                <option value="9">Ch 9</option><option value="10">Ch 10</option>
                                <option value="11">Ch 11</option><option value="12">Ch 12</option>
                                <option value="13">Ch 13</option><option value="14">Ch 14</option>
                                <option value="15">Ch 15</option><option value="16">Ch 16</option>
                            </select>
                        </div>
                        <div id="xfw-midi-status" class="xfw-spk-status" style="margin-top:4px;font-size:11px;"></div>
                        <div id="xfw-midi-lastnote" class="xfw-spk-status" style="margin-top:2px;font-size:11px;color:var(--xfw-muted);">Press a pad/key on your device to test…</div>
                        <div id="xfw-midi-raw" class="xfw-spk-status" style="margin-top:2px;font-size:10px;color:var(--xfw-muted);opacity:0.85;"></div>
                    </div>
                    <div class="xfw-section">
                        <label class="xfw-label">Default kits <span style="font-weight:400;font-size:11px;color:var(--xfw-muted)">(fills all 16 pads — like the sounds on X mobile)</span></label>
                        <div id="xfw-kit-tabs" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;">
                            <button class="xfw-btn xfw-kit-tab" data-cat="drums">🥁 Drums</button>
                            <button class="xfw-btn xfw-kit-tab" data-cat="keys">🎹 Keys</button>
                            <button class="xfw-btn xfw-kit-tab" data-cat="guitar">🎸 Guitar</button>
                            <button class="xfw-btn xfw-kit-tab" data-cat="bass">🎵 Bass</button>
                            <button class="xfw-btn xfw-kit-tab" data-cat="strings">🎻 Strings</button>
                            <button class="xfw-btn xfw-kit-tab" data-cat="brass">🎺 Brass</button>
                            <button class="xfw-btn xfw-kit-tab" data-cat="winds">🎷 Winds</button>
                            <button class="xfw-btn xfw-kit-tab" data-cat="world">🌍 World</button>
                            <button class="xfw-btn xfw-kit-tab" data-cat="pads">🌊 Pads</button>
                            <button class="xfw-btn xfw-kit-tab" data-cat="fx">🎉 FX</button>
                        </div>
                        <!-- Drum tab: buttons for each kit variant -->
                        <div id="xfw-kit-group-drums" class="xfw-kit-group xfw-buttons" style="gap:6px;flex-wrap:wrap;display:none;">
                            <button class="xfw-btn xfw-kit-btn" data-kit="drums" style="flex:1;">LM-2</button>
                            <button class="xfw-btn xfw-kit-btn" data-kit="808" style="flex:1;">TR-808</button>
                            <button class="xfw-btn xfw-kit-btn" data-kit="lofi" style="flex:1;">Lo-Fi</button>
                            <button class="xfw-btn xfw-kit-btn" data-kit="muldjordkit" style="flex:1;">Acoustic</button>
                        </div>
                        <!-- All other tabs: select dropdown that loads on change -->
                        <div id="xfw-kit-group-keys" class="xfw-kit-group" style="display:none;">
                            <select class="xfw-select xfw-kit-select" style="width:100%;">
                                <option value="piano">Piano — FM Electric (FreePats)</option>
                                <option value="piano-bright">Bright Acoustic Piano</option>
                                <option value="epiano1">Electric Piano 1 (Rhodes style)</option>
                                <option value="epiano2">Electric Piano 2 (DX style)</option>
                                <option value="harpsichord">Harpsichord</option>
                                <option value="organ-drawbar">Drawbar Organ</option>
                                <option value="organ-rock">Rock Organ</option>
                                <option value="organ-church">Church Organ</option>
                                <option value="accordion">Accordion</option>
                                <option value="synthkeys">Synth Keys (procedural)</option>
                            </select>
                        </div>
                        <div id="xfw-kit-group-guitar" class="xfw-kit-group" style="display:none;">
                            <select class="xfw-select xfw-kit-select" style="width:100%;">
                                <option value="guitar">Classical / Nylon (FreePats)</option>
                                <option value="guitar-clean">Electric Clean (FreePats)</option>
                                <option value="guitar-nylon">Nylon Guitar (WAF)</option>
                                <option value="guitar-steel">Steel Acoustic Guitar</option>
                                <option value="guitar-jazz">Jazz Guitar</option>
                                <option value="guitar-overdrive">Overdriven Guitar</option>
                                <option value="guitar-distortion">Distortion Guitar</option>
                            </select>
                        </div>
                        <div id="xfw-kit-group-bass" class="xfw-kit-group" style="display:none;">
                            <select class="xfw-select xfw-kit-select" style="width:100%;">
                                <option value="bass-acoustic">Acoustic Bass</option>
                                <option value="bass-electric">Electric Bass (finger)</option>
                                <option value="bass-fretless">Fretless Bass</option>
                                <option value="bass-slap">Slap Bass</option>
                                <option value="bass-synth1">Synth Bass 1</option>
                                <option value="bass-synth2">Synth Bass 2</option>
                            </select>
                        </div>
                        <div id="xfw-kit-group-strings" class="xfw-kit-group" style="display:none;">
                            <select class="xfw-select xfw-kit-select" style="width:100%;">
                                <option value="violin">Violin</option>
                                <option value="viola">Viola</option>
                                <option value="cello">Cello</option>
                                <option value="harp">Orchestral Harp</option>
                                <option value="strings">String Ensemble 1</option>
                                <option value="strings-synth">Synth Strings</option>
                            </select>
                        </div>
                        <div id="xfw-kit-group-brass" class="xfw-kit-group" style="display:none;">
                            <select class="xfw-select xfw-kit-select" style="width:100%;">
                                <option value="trumpet">Trumpet</option>
                                <option value="trombone">Trombone</option>
                                <option value="french-horn">French Horn</option>
                                <option value="brass-section">Brass Section</option>
                                <option value="synth-brass">Synth Brass</option>
                            </select>
                        </div>
                        <div id="xfw-kit-group-winds" class="xfw-kit-group" style="display:none;">
                            <select class="xfw-select xfw-kit-select" style="width:100%;">
                                <option value="sax-alto">Alto Saxophone</option>
                                <option value="sax-tenor">Tenor Saxophone</option>
                                <option value="sax-soprano">Soprano Saxophone</option>
                                <option value="flute">Flute</option>
                                <option value="clarinet">Clarinet</option>
                                <option value="oboe">Oboe</option>
                            </select>
                        </div>
                        <div id="xfw-kit-group-world" class="xfw-kit-group" style="display:none;">
                            <select class="xfw-select xfw-kit-select" style="width:100%;">
                                <option value="banjo">Banjo</option>
                                <option value="sitar">Sitar</option>
                                <option value="koto">Koto</option>
                                <option value="kalimba">Kalimba</option>
                                <option value="fiddle">Fiddle</option>
                                <option value="shanai">Shanai</option>
                            </select>
                        </div>
                        <div id="xfw-kit-group-pads" class="xfw-kit-group" style="display:none;">
                            <select class="xfw-select xfw-kit-select" style="width:100%;">
                                <option value="pad-warm">Pad — Warm</option>
                                <option value="pad-new-age">Pad — New Age</option>
                                <option value="pad-choir">Pad — Choir</option>
                                <option value="pad-metallic">Pad — Metallic</option>
                                <option value="synth-lead-sq">Synth Lead — Square</option>
                                <option value="synth-lead-saw">Synth Lead — Sawtooth</option>
                                <option value="synth-lead-chiff">Synth Lead — Chiff</option>
                            </select>
                        </div>
                        <div id="xfw-kit-group-fx" class="xfw-kit-group xfw-buttons" style="gap:6px;flex-wrap:wrap;display:none;">
                            <button class="xfw-btn xfw-kit-btn" data-kit="sfx" style="flex:1;">Sound FX</button>
                        </div>
                    </div>
                    <div class="xfw-section">
                        <label class="xfw-label">Sample pads <span style="font-weight:400;font-size:11px;color:var(--xfw-muted)">(drag audio file onto pad · right-click to configure)</span></label>
                        <div class="xfw-help" style="color:var(--xfw-muted);font-size:11px;">
                            Pads open in a separate movable window so you can drag it anywhere on screen while you stream.
                        </div>
                        <div class="xfw-buttons" style="margin-top:8px;">
                            <button id="xfw-show-pads-popup" class="xfw-btn xfw-primary">⧉ Show Pads window</button>
                        </div>
                    </div>
                </div>

                <!-- SYNTH sub-pane -->
                <div class="xfw-sub-pane" data-sub="synth">
                    <div class="xfw-section">
                        <div class="xfw-row">
                            <div>Enable synth<span class="xfw-help">Route MIDI keyboard notes to the built-in synthesizer.</span></div>
                            <div class="xfw-toggle" data-key="synthEnabled"></div>
                        </div>
                        <div class="xfw-row xfw-row-select">
                            <div>Waveform</div>
                            <select id="xfw-synth-wave" class="xfw-select xfw-select-sm">
                                <option value="sawtooth">Sawtooth</option>
                                <option value="square">Square</option>
                                <option value="sine">Sine</option>
                                <option value="triangle">Triangle</option>
                            </select>
                        </div>
                        <div class="xfw-row xfw-row-select">
                            <div>Octave</div>
                            <select id="xfw-synth-octave" class="xfw-select xfw-select-sm">
                                <option value="-2">-2</option><option value="-1">-1</option>
                                <option value="0">0</option>
                                <option value="1">+1</option><option value="2">+2</option>
                            </select>
                        </div>
                    </div>
                    <div class="xfw-section">
                        <label class="xfw-label">Presets</label>
                        <div class="xfw-buttons" style="gap:6px;flex-wrap:wrap;">
                            <button class="xfw-btn xfw-synth-preset-btn" data-synth-preset="pluck">Pluck</button>
                            <button class="xfw-btn xfw-synth-preset-btn" data-synth-preset="pad">Warm Pad</button>
                            <button class="xfw-btn xfw-synth-preset-btn" data-synth-preset="bass">Bass</button>
                            <button class="xfw-btn xfw-synth-preset-btn" data-synth-preset="lead">Lead</button>
                        </div>
                    </div>
                    <div class="xfw-section">
                        <label class="xfw-label">Envelope (ADSR)</label>
                        <div class="xfw-slider-row" data-slider="synthAttackMs"  data-min="1"   data-max="2000" data-step="1"   data-suffix=" ms" data-label="Attack"></div>
                        <div class="xfw-slider-row" data-slider="synthDecayMs"   data-min="1"   data-max="2000" data-step="1"   data-suffix=" ms" data-label="Decay"></div>
                        <div class="xfw-slider-row" data-slider="synthSustain"   data-min="0"   data-max="1"    data-step="0.01" data-suffix=""    data-label="Sustain"></div>
                        <div class="xfw-slider-row" data-slider="synthReleaseMs" data-min="10"  data-max="5000" data-step="10"  data-suffix=" ms" data-label="Release"></div>
                    </div>
                    <div class="xfw-section">
                        <label class="xfw-label">Filter (lowpass)</label>
                        <div class="xfw-slider-row" data-slider="synthFilterHz" data-min="200" data-max="20000" data-step="50" data-suffix=" Hz" data-label="Cutoff"></div>
                        <div class="xfw-slider-row" data-slider="synthFilterQ"  data-min="0.1" data-max="20"    data-step="0.1" data-suffix=""    data-label="Resonance"></div>
                        <div class="xfw-slider-row" data-slider="synthGainDb"   data-min="-40" data-max="0"     data-step="0.5" data-suffix=" dB" data-label="Gain"></div>
                    </div>
                    <div class="xfw-section">
                        <div class="xfw-row">
                            <div>Velocity sensitive<span class="xfw-help">Louder keys play louder.</span></div>
                            <div class="xfw-toggle" data-key="midiVelocitySensitive"></div>
                        </div>
                    </div>
                </div>

                <!-- LOOPER sub-pane -->
                <div class="xfw-sub-pane" data-sub="looper">
                    <div class="xfw-section">
                        <label class="xfw-label">Loop Station (RC-505 Mk2-style)</label>
                        <div class="xfw-help" style="color:var(--xfw-muted);font-size:11px;margin-bottom:8px;">
                            5 independent tracks record your live mic+aux mix and stack together — tap a track pad to Record, tap again to stop &amp; loop, tap again to Overdub a layer on top, just like a Boss RC-505. Opens in a separate movable window.
                        </div>
                        <div class="xfw-buttons">
                            <button id="xfw-show-loop-popup" class="xfw-btn xfw-primary">⧉ Show Loop Station</button>
                        </div>
                    </div>
                    <div class="xfw-section">
                        <div class="xfw-slider-row" data-slider="loopGainDb" data-min="-40" data-max="12" data-step="0.5" data-suffix=" dB" data-label="Master level"></div>
                    </div>
                    <div class="xfw-section">
                        <label class="xfw-label">Piano Roll <span style="font-weight:400;font-size:11px;color:var(--xfw-muted)">(Ableton-style view of the MIDI notes you play or record)</span></label>
                        <div class="xfw-buttons">
                            <button id="xfw-show-pianoroll-popup" class="xfw-btn xfw-primary">⧉ Show Piano Roll</button>
                        </div>
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

            <!-- FX PANE: Autotune / Pitch Shift -->
            <div class="xfw-pane" data-pane="fx">
                <div class="xfw-section">
                    <label class="xfw-label">Pitch Shift</label>
                    <div class="xfw-row">
                        <div>Enable pitch FX<span class="xfw-help">Inserts a real-time pitch shifter / autotune on your mic signal.</span></div>
                        <div class="xfw-toggle" data-key="autotuneEnabled"></div>
                    </div>
                    <div class="xfw-slider-row" data-slider="pitchShiftSemitones" data-min="-12" data-max="12" data-step="0.5" data-suffix=" st" data-label="Pitch shift (semitones)"></div>
                    <div class="xfw-help" style="margin-top:6px;color:var(--xfw-muted);font-size:11px;">
                        Shifts your voice up or down by the given number of semitones. 0 = no shift. Works in real time with ~43 ms latency.
                    </div>
                </div>
                <div class="xfw-section">
                    <label class="xfw-label">Auto-Tune (snap to scale)</label>
                    <div class="xfw-row">
                        <div>Auto-correct pitch<span class="xfw-help">Detects your voice pitch and snaps it to the nearest note in the selected scale — T-Pain / pitch-correction style.</span></div>
                        <div class="xfw-toggle" data-key="autotuneAuto"></div>
                    </div>
                    <div class="xfw-row xfw-row-select">
                        <div>Key<span class="xfw-help">Root note of the scale to snap to.</span></div>
                        <select id="xfw-at-key" class="xfw-select xfw-select-sm"></select>
                    </div>
                    <div class="xfw-row xfw-row-select">
                        <div>Scale<span class="xfw-help">Which notes in the key are valid targets.</span></div>
                        <select id="xfw-at-scale" class="xfw-select xfw-select-sm">
                            <option value="chromatic">Chromatic (all 12)</option>
                            <option value="major">Major</option>
                            <option value="minor">Minor</option>
                            <option value="pentatonic">Pentatonic</option>
                        </select>
                    </div>
                    <div class="xfw-slider-row" data-slider="autotuneStrength" data-min="0" data-max="1" data-step="0.05" data-suffix="" data-label="Correction strength"></div>
                    <div class="xfw-help" style="margin-top:6px;color:var(--xfw-muted);font-size:11px;">
                        Strength 1.0 = hard snap (classic Auto-Tune). Lower values give subtle correction. When enabled, the Pitch shift slider above is ignored.
                    </div>
                </div>
                <div class="xfw-section">
                    <div class="xfw-help" style="color:var(--xfw-muted);font-size:11px;">
                        <b>Note on Soundboard &amp; Emoji:</b> Emoji reactions and the soundboard in X Spaces use X’s native server-side API and should work normally. If emoji don’t appear, try reloading the page (Reload button above). The Soundboard broadcasts audio via the X mobile app’s WebRTC path; on web/desktop it currently plays locally only — this is an X platform limitation.
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

            <div id="xfw-inbound-status" class="xfw-spk-status"></div>

            <div class="xfw-buttons">
                <button id="xfw-rebuild" class="xfw-btn">Reapply audio graph</button>
                <button id="xfw-recover-inbound" class="xfw-btn" style="display:none;">Recover incoming audio</button>
                <button id="xfw-reload" class="xfw-btn xfw-primary">Reload page</button>
            </div>

            <div class="xfw-status" id="xfw-status">
                <span class="xfw-dot"></span>Audio engine ready.
            </div>
        </div>

        <!-- PADS POPUP — movable window, shows automatically with the Sounds tab -->
        <div id="xfw-pads-popup" class="xfw-popup" style="display:none;">
            <div class="xfw-popup-header">
                <span>🎛 Pads</span>
            </div>
            <div class="xfw-popup-body">
                <div id="xfw-pad-grid" class="xfw-pad-grid"></div>
                <div id="xfw-pad-editor" class="xfw-pad-editor" style="display:none">
                    <div class="xfw-row"><b id="xfw-pe-title">Pad 1</b>
                        <button id="xfw-pe-close" class="xfw-btn" style="padding:2px 8px;">✕</button>
                    </div>
                    <div class="xfw-row">
                        <label>Name</label>
                        <input id="xfw-pe-name" class="xfw-modal-input" style="flex:1;margin:0;" />
                    </div>
                    <div class="xfw-row xfw-row-select">
                        <label>MIDI note</label>
                        <select id="xfw-pe-note" class="xfw-select xfw-select-sm"></select>
                        <button id="xfw-pe-learn" class="xfw-btn" style="margin-left:6px;">Learn…</button>
                    </div>
                    <div class="xfw-row">
                        <label>Volume</label>
                        <input id="xfw-pe-vol" type="range" min="0" max="1" step="0.05" style="flex:1;" />
                        <span id="xfw-pe-vol-val" style="width:32px;text-align:right;font-size:12px;"></span>
                    </div>
                    <div class="xfw-row">
                        <div>Loop<span class="xfw-help">Looping: hold note to play, release to stop.</span></div>
                        <div class="xfw-toggle" id="xfw-pe-loop"></div>
                    </div>
                    <div class="xfw-row">
                        <button id="xfw-pe-load" class="xfw-btn xfw-primary" style="flex:1;">Load audio file…</button>
                        <button id="xfw-pe-clear" class="xfw-btn" style="margin-left:6px;">Clear</button>
                    </div>
                    <input id="xfw-pe-file" type="file" accept="audio/*" style="display:none;" />
                </div>
            </div>
        </div>

        <!-- LOOPER POPUP — RC-505 Mk2-style 5-track Loop Station, movable window,
             shows automatically with the Sounds tab -->
        <div id="xfw-loop-popup" class="xfw-popup" style="display:none;">
            <div class="xfw-popup-header">
                <span>🔁 Loop Station</span>
            </div>
            <div class="xfw-popup-body">
                <div class="xfw-row">
                    <div>Tempo<span class="xfw-help">Shared by every track's auto-loop dial. Tap TAP a few times to set it by feel.</span></div>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <input id="xfw-loop-bpm" type="number" min="40" max="240" step="1" class="xfw-modal-input" style="width:52px;text-align:center;" />
                        <span style="font-size:11px;color:var(--xfw-muted);">BPM</span>
                        <button id="xfw-loop-tap-tempo" class="xfw-btn" style="flex:0 0 auto;padding:6px 10px;">TAP</button>
                        <button id="xfw-metronome-toggle" class="xfw-btn xfw-metronome-btn" style="flex:0 0 auto;padding:6px 10px;" title="Click track for timing — heard on your monitor output only, never recorded into a loop">🔔</button>
                    </div>
                </div>
                <div class="xfw-buttons" style="gap:6px;flex-wrap:wrap;margin-bottom:6px;">
                    <button id="xfw-loop-play-all" class="xfw-btn" style="flex:1;">▶ Play All</button>
                    <button id="xfw-loop-stop-all" class="xfw-btn" style="flex:1;">■ Stop All</button>
                    <button id="xfw-loop-clear-all" class="xfw-btn" style="flex:1;">✕ Clear All</button>
                    <button id="xfw-loop-show-pianoroll" class="xfw-btn" style="flex:0 0 auto;padding:6px 10px;" title="Show the Piano Roll — see every MIDI note you played and recorded">🎹</button>
                </div>
                <div class="xfw-buttons" style="gap:6px;flex-wrap:wrap;margin-bottom:6px;">
                    <button id="xfw-learn-loop-record" class="xfw-btn" style="flex:1;">🎙 Learn Record</button>
                    <button id="xfw-unlearn-loop-record" class="xfw-btn" style="flex:0 0 auto;padding:6px 8px;" title="Clear Record mapping">✕</button>
                    <button id="xfw-learn-loop-play" class="xfw-btn" style="flex:1;">▶ Learn Play</button>
                    <button id="xfw-unlearn-loop-play" class="xfw-btn" style="flex:0 0 auto;padding:6px 8px;" title="Clear Play mapping">✕</button>
                </div>
                <div id="xfw-loop-transport-status" class="xfw-spk-status" style="margin-bottom:8px;">Map your controller's Record/Play buttons (e.g. Launchkey Mini) to auto-loop hands-free.</div>
                ${[0,1,2,3,4].map(n => `
                <div class="xfw-loop-track" data-layer="${n}">
                    <div class="xfw-loop-track-top">
                        <div class="xfw-loop-track-badge" style="--track-color:${['#ef4444','#f59e0b','#22c55e','#3b82f6','#a855f7'][n]}">${n+1}</div>
                        <div class="xfw-loop-btns">
                            <button type="button" class="xfw-loop-btn xfw-loop-btn-rec" data-loop-rec="${n}" title="Record a new loop, or overdub on top of the current one">●</button>
                            <button type="button" class="xfw-loop-btn xfw-loop-btn-play" data-loop-play="${n}" title="Play — resume the loop">▶</button>
                            <button type="button" class="xfw-loop-btn xfw-loop-btn-stop" data-loop-stop="${n}" title="Stop/Pause">❚❚</button>
                            <button type="button" class="xfw-loop-btn xfw-loop-btn-clear" data-loop-clear="${n}" title="Clear this loop completely">✕</button>
                        </div>
                        <button type="button" class="xfw-bar-dial" data-bar-dial="${n}" title="Auto-loop length in bars — click to cycle (Manual / 4 / 8 / 16 / 32 / 64)">16</button>
                        <button type="button" class="xfw-quantize-dial" data-quantize-dial="${n}" title="Record/overdub start snap — click to cycle (Auto / Off / 1/4 / 1/8 / 1/16 / 1/32)">A</button>
                    </div>
                    <input type="range" class="xfw-loop-track-vol" data-track-vol="${n}" min="-40" max="12" step="0.5" title="Track ${n+1} level" />
                    <div data-loop-status="${n}" class="xfw-spk-status">No loop recorded</div>
                </div>`).join('')}
            </div>
        </div>

        <!-- PIANO ROLL POPUP — Ableton-style clip view of MIDI notes played,
             either a live rolling window or a specific loop track's recording -->
        <div id="xfw-pianoroll-popup" class="xfw-popup" style="display:none;width:640px;min-width:360px;resize:both;overflow:auto;">
            <div class="xfw-popup-header">
                <span>🎹 Piano Roll</span>
            </div>
            <div class="xfw-popup-body">
                <div class="xfw-row xfw-row-select">
                    <div>Source</div>
                    <select id="xfw-pianoroll-source" class="xfw-select xfw-select-sm">
                        <option value="live">Live (now playing)</option>
                        <option value="0">Track 1</option>
                        <option value="1">Track 2</option>
                        <option value="2">Track 3</option>
                        <option value="3">Track 4</option>
                        <option value="4">Track 5</option>
                    </select>
                </div>
                <div class="xfw-row">
                    <div>Expand keys<span class="xfw-help">Taller rows = easier to read pitches, like zooming in Ableton's piano roll.</span></div>
                    <input id="xfw-pianoroll-zoom" type="range" min="6" max="40" step="1" style="flex:1;" />
                </div>
                <div class="xfw-row xfw-row-select">
                    <div>Quantize<span class="xfw-help">Snap all notes in the selected track to this grid after recording.</span></div>
                    <select id="xfw-pianoroll-quantize" class="xfw-select xfw-select-sm">
                        <option value="1">1 bar</option>
                        <option value="2">1/2 bar</option>
                        <option value="4" selected>1/4 (beat)</option>
                        <option value="8">1/8</option>
                        <option value="16">1/16</option>
                        <option value="32">1/32</option>
                    </select>
                    <button id="xfw-pianoroll-quantize-btn" class="xfw-btn" style="flex:0 0 auto;margin-left:6px;padding:4px 10px;">Apply</button>
                </div>
                <div id="xfw-pianoroll-scroll" style="overflow:auto;flex:1;min-height:200px;border:1px solid var(--xfw-border);border-radius:8px;margin-top:6px;">
                    <canvas id="xfw-pianoroll-canvas" width="600" height="200" style="display:block;"></canvas>
                </div>
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
                if (key === 'micGainDb' || key === 'auxGainDb' || key === 'aux2GainDb') applyMixerLive();
                else if (key === 'xcastGainDb' || key === 'sbGainDb' || key === 'loopGainDb') applyMixerLive();
                else if (key === 'synthAttackMs' || key === 'synthDecayMs' || key === 'synthReleaseMs') { /* live - no rebuild needed */ }
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
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
        const opts = [{ deviceId: 'default', label: 'System default' }, ...devs];
        for (const d of opts) {
            const o = document.createElement('option');
            o.value = d.deviceId || 'default';
            o.textContent = d.label || `Microphone (${(d.deviceId || '').slice(0, 6)})`;
            sel.appendChild(o);
        }
        sel.value = settings.inputDeviceId || 'default';

        // Aux 1 dropdown
        const auxSel = document.getElementById('xfw-aux');
        if (auxSel) {
            auxSel.innerHTML = '';
            const auxOpts = [{ deviceId: 'none', label: 'None (disabled)' }, ...devs];
            for (const d of auxOpts) {
                const o = document.createElement('option');
                o.value = d.deviceId || 'none';
                o.textContent = d.label || `Device (${(d.deviceId || '').slice(0, 6)})`;
                auxSel.appendChild(o);
            }
            auxSel.value = settings.auxDeviceId || 'none';
        }
        // Aux 2 dropdown
        const aux2Sel = document.getElementById('xfw-aux2');
        if (aux2Sel) {
            aux2Sel.innerHTML = '';
            const aux2Opts = [{ deviceId: 'none', label: 'None (disabled)' }, ...devs];
            for (const d of aux2Opts) {
                const o = document.createElement('option');
                o.value = d.deviceId || 'none';
                o.textContent = d.label || `Device (${(d.deviceId || '').slice(0, 6)})`;
                aux2Sel.appendChild(o);
            }
            aux2Sel.value = settings.aux2DeviceId || 'none';
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
        paintXMuteStatus();
    }

    // ── Synth (MIDI keyboard) presets ───────────────────────────────────────
    const SYNTH_PRESETS = {
        pluck: { synthWave: 'triangle', synthAttackMs: 5,   synthDecayMs: 180,  synthSustain: 0.15, synthReleaseMs: 200,  synthFilterHz: 6000,  synthFilterQ: 0.7, synthGainDb: -6 },
        pad:   { synthWave: 'sawtooth', synthAttackMs: 400, synthDecayMs: 600,  synthSustain: 0.8,  synthReleaseMs: 1200, synthFilterHz: 2200,  synthFilterQ: 0.5, synthGainDb: -8 },
        bass:  { synthWave: 'square',   synthAttackMs: 3,   synthDecayMs: 120,  synthSustain: 0.9,  synthReleaseMs: 150,  synthFilterHz: 900,   synthFilterQ: 2,   synthGainDb: -4, synthOctave: -1 },
        lead:  { synthWave: 'sawtooth', synthAttackMs: 15,  synthDecayMs: 100,  synthSustain: 0.7,  synthReleaseMs: 250,  synthFilterHz: 9000,  synthFilterQ: 3,   synthGainDb: -6 },
    };
    function applySynthPreset(name) {
        const p = SYNTH_PRESETS[name];
        if (!p) return;
        Object.assign(settings, p);
        saveSettings(settings);
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
        const waveEl2 = document.getElementById('xfw-synth-wave');
        if (waveEl2) waveEl2.value = settings.synthWave;
        const octEl2 = document.getElementById('xfw-synth-octave');
        if (octEl2 && 'synthOctave' in p) octEl2.value = settings.synthOctave;
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
        const aux2Fill = document.getElementById('xfw-meter-aux2');
        const xcastFill = document.getElementById('xfw-meter-xcast');
        const sbFill    = document.getElementById('xfw-meter-sb');

        // Analysers are created by buildGraph() and REPLACED every time it runs,
        // and they do not exist at all before the graph is first built. This used
        // to capture one Uint8Array per analyser here, once — so opening the gear
        // before the graph existed bound every meter to null and left them dead
        // forever, and a later rebuild left them reading replaced analysers. That
        // is exactly why levels only appeared after "Reapply audio graph", whose
        // handler happens to call startMeters() a second time.
        //
        // Resolve per frame instead, keyed on the analyser instance, so meters
        // pick up the graph whenever it appears or is rebuilt.
        const bufs = new WeakMap();
        const bufFor = a => {
            if (!a) return null;
            let b = bufs.get(a);
            if (!b || b.length !== a.fftSize) { b = new Uint8Array(a.fftSize); bufs.set(a, b); }
            return b;
        };
        const paint = (analyser, fill) => {
            const buf = bufFor(analyser);
            if (analyser && fill && buf) {
                analyser.getByteTimeDomainData(buf);
                fill.style.width = peakPct(buf);
            } else if (fill) { fill.style.width = '0%'; }
        };

        const tick = () => {
            paint(micAnalyser, micFill);
            paint(auxAnalyser, auxFill);
            paint(aux2Analyser, aux2Fill);
            paint(xcastAnalyser, xcastFill);
            paint(sbAnalyser, sbFill);
            paint(inputAnalyser, inFill);
            paint(outputAnalyser, outFill);
            if (grFill && comp) {
                const r = comp.reduction || 0;
                grFill.style.width = Math.min(100, Math.max(0, -r * 5)) + '%';
            }
            meterRaf = requestAnimationFrame(tick);
        };
        tick();
    }
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

        function selectPane(name) {
            if (!name) return;
            const tab = panel.querySelector(`.xfw-tab[data-pane="${name}"]`);
            if (tab) tab.click();
        }

        async function setMixerOpen(opening, paneName) {
            const alreadyOpen = panel.classList.contains('xfw-open');
            if (opening === alreadyOpen) {
                if (opening) selectPane(paneName);
                syncSoundsPopups(opening && !!panel.querySelector('.xfw-tab[data-pane="sounds"].xfw-active'));
                return true;
            }
            panel.classList.toggle('xfw-open', opening);
            if (opening) {
                buildSliders();
                paintToggles();
                await populateInputs();
                await populateOutputs();
                // Build the graph if nothing has yet. X only calls getUserMedia
                // when you join a Space, so on a fresh page there are no analysers
                // and every meter reads zero — which is what made "Reapply audio
                // graph" look mandatory. Opening the gear is a user gesture, so
                // it is a valid moment to resume an AudioContext and acquire the
                // mic. Guarded on the graph being absent, so this can never
                // disturb a live Space by rebuilding underneath it.
                if (!audioCtx || !micAnalyser) {
                    try {
                        await ensureProcessedStream();
                    } catch (err) {
                        // Non-X tabs are denied mic access since v1.4.1, so this
                        // is expected there; buildGraph() still runs and the
                        // meters simply sit at zero rather than breaking.
                        console.warn('[XCaster] could not build graph on panel open', err);
                    }
                }
                // Start once and keep running; panel visibility must not affect
                // active Space audio state.
                startMeters();
                startSinkScan();
                startInboundScan();
            }
            if (opening) selectPane(paneName);
            syncSoundsPopups(opening && !!panel.querySelector('.xfw-tab[data-pane="sounds"].xfw-active'));
            return true;
        }

        window.__xcOpenMixer = (paneName) => setMixerOpen(true, paneName);
        window.__xcCloseMixer = () => setMixerOpen(false);
        window.__xcToggleMixer = (paneName) => setMixerOpen(!panel.classList.contains('xfw-open'), paneName);

        fab.addEventListener('click', () => {
            window.__xcToggleMixer();
        });

        window.addEventListener('keydown', e => {
            if (e.ctrlKey && e.key === ',') { e.preventDefault(); fab.click(); }
        });

        // tabs (top-level only — sub-tabs like Pads/Synth/Looper are handled separately
        // below; they must NOT match here or they'll wipe every pane's active state)
        panel.querySelectorAll('.xfw-tab:not(.xfw-sub-tab)').forEach(t => {
            t.addEventListener('click', () => {
                panel.querySelectorAll('.xfw-tab:not(.xfw-sub-tab)').forEach(x => x.classList.remove('xfw-active'));
                panel.querySelectorAll('.xfw-pane').forEach(x => x.classList.remove('xfw-active'));
                t.classList.add('xfw-active');
                panel.querySelector(`.xfw-pane[data-pane="${t.getAttribute('data-pane')}"]`).classList.add('xfw-active');
                syncSoundsPopups(t.getAttribute('data-pane') === 'sounds');
            });
        });

        // Pads / Looper / Piano Roll popups — movable windows shown while the Sounds tab is active.
        const padsPopup = document.getElementById('xfw-pads-popup');
        const loopPopup = document.getElementById('xfw-loop-popup');
        const pianoRollPopup = document.getElementById('xfw-pianoroll-popup');
        function showPadsPopup() { if (padsPopup) { padsPopup.style.display = 'block'; applyPadsPopupPos(); } }
        function hidePadsPopup() { if (padsPopup) padsPopup.style.display = 'none'; }
        function showLoopPopup() { if (loopPopup) { loopPopup.style.display = 'block'; applyLoopPopupPos(); } }
        function hideLoopPopup() { if (loopPopup) loopPopup.style.display = 'none'; }
        function showPianoRollPopup() { if (pianoRollPopup) { pianoRollPopup.style.display = 'block'; applyPianoRollPopupPos(); _ensurePianoRollRAF(); } }
        function hidePianoRollPopup() { if (pianoRollPopup) pianoRollPopup.style.display = 'none'; }
        function syncSoundsPopups(soundsActive) {
            if (soundsActive && panel.classList.contains('xfw-open')) {
                if (settings.padsPopupOpen) showPadsPopup(); else hidePadsPopup();
                if (settings.loopPopupOpen) showLoopPopup(); else hideLoopPopup();
                if (settings.pianoRollPopupOpen) showPianoRollPopup(); else hidePianoRollPopup();
            } else {
                hidePadsPopup();
                hideLoopPopup();
                hidePianoRollPopup();
            }
        }
        window.__xcSyncSoundsPopups = () => {
            const active = panel.querySelector('.xfw-tab[data-pane="sounds"]');
            syncSoundsPopups(!!(active && active.classList.contains('xfw-active')));
        };
        const showPadsBtn = document.getElementById('xfw-show-pads-popup');
        if (showPadsBtn) showPadsBtn.addEventListener('click', () => {
            settings.padsPopupOpen = true; saveSettings(settings); showPadsPopup();
        });
        const showLoopBtn = document.getElementById('xfw-show-loop-popup');
        if (showLoopBtn) showLoopBtn.addEventListener('click', () => {
            settings.loopPopupOpen = true; saveSettings(settings); showLoopPopup();
        });
        const showPianoRollBtn = document.getElementById('xfw-show-pianoroll-popup');
        if (showPianoRollBtn) showPianoRollBtn.addEventListener('click', () => {
            settings.pianoRollPopupOpen = true; saveSettings(settings); showPianoRollPopup();
        });
        // Note: no manual close (✕) button on these popup headers — the windows
        // already auto-hide when you switch away from the Sounds tab (via
        // syncSoundsPopups above), so a separate close control was redundant.
        if (padsPopup) {
            installDrag(padsPopup.querySelector('.xfw-popup-header'), {
                getPos: () => settings.padsPopupPos,
                setPos: (p) => { settings.padsPopupPos = p; saveSettings(settings); applyPadsPopupPos(); },
                apply: applyPadsPopupPos,
                target: padsPopup,
            });
        }
        if (loopPopup) {
            installDrag(loopPopup.querySelector('.xfw-popup-header'), {
                getPos: () => settings.loopPopupPos,
                setPos: (p) => { settings.loopPopupPos = p; saveSettings(settings); applyLoopPopupPos(); },
                apply: applyLoopPopupPos,
                target: loopPopup,
            });
        }
        if (pianoRollPopup) {
            installDrag(pianoRollPopup.querySelector('.xfw-popup-header'), {
                getPos: () => settings.pianoRollPopupPos,
                setPos: (p) => { settings.pianoRollPopupPos = p; saveSettings(settings); applyPianoRollPopupPos(); },
                apply: applyPianoRollPopupPos,
                target: pianoRollPopup,
            });
            const srcSel = document.getElementById('xfw-pianoroll-source');
            if (srcSel) {
                srcSel.value = String(settings.pianoRollTrack);
                srcSel.addEventListener('change', () => {
                    settings.pianoRollTrack = srcSel.value === 'live' ? 'live' : +srcSel.value;
                    saveSettings(settings);
                    _drawPianoRoll();
                });
            }
            const zoomSlider = document.getElementById('xfw-pianoroll-zoom');
            if (zoomSlider) {
                zoomSlider.value = String(settings.pianoRollRowH);
                zoomSlider.addEventListener('input', () => {
                    settings.pianoRollRowH = +zoomSlider.value;
                    saveSettings(settings);
                    _drawPianoRoll();
                });
            }
            const qBtn = document.getElementById('xfw-pianoroll-quantize-btn');
            if (qBtn) {
                qBtn.addEventListener('click', () => {
                    const sel = settings.pianoRollTrack;
                    if (sel === 'live') return;
                    const track = +sel;
                    const L = _loops[track];
                    if (!L || !L.midiEvents || !L.midiEvents.length) return;
                    const div = +( document.getElementById('xfw-pianoroll-quantize')?.value || 4 );
                    const secPerBar = (60 / (settings.loopBpm || 120)) * 4;
                    const grid = secPerBar / div;
                    L.midiEvents = L.midiEvents.map(ev => {
                        const snapped = Math.round(ev.on / grid) * grid;
                        const dur = ev.off - ev.on;
                        return { ...ev, on: snapped, off: snapped + Math.max(grid * 0.1, dur) };
                    });
                    _drawPianoRoll();
                });
            }
        }

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
            if (key === 'micMuted' || key === 'auxMuted' || key === 'aux2Muted') applyMixerLive();
            if (key === 'xcastMuted') applyMixerLive();
            if (key === 'micMonitor' || key === 'auxMonitor' || key === 'aux2Monitor') applyMixerLive();
            if (key === 'xcastMonitor') applyMixerLive();
            if (key === 'micCue' || key === 'auxCue' || key === 'aux2Cue') applyMixerLive();
            if (key === 'xcastCue') applyMixerLive();
            // browser-side capture toggles need a fresh raw stream — only rebuild the affected channel
            if (['micAutoGainControl', 'micNoiseSuppression', 'micEchoCancellation'].includes(key)) {
                rebuildMic();
            }
            if (['auxAutoGainControl', 'auxNoiseSuppression', 'auxEchoCancellation'].includes(key)) {
                rebuildAux();
            }
            if (['aux2AutoGainControl', 'aux2NoiseSuppression', 'aux2EchoCancellation'].includes(key)) {
                rebuildAux2();
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
        const aux2SelEl = document.getElementById('xfw-aux2');
        if (aux2SelEl) {
            aux2SelEl.addEventListener('change', async e => {
                settings.aux2DeviceId = e.target.value;
                saveSettings(settings);
                await rebuildAux2();
                startMeters();
            });
        }
        document.getElementById('xfw-output').addEventListener('change', e => {
            settings.outputDeviceId = e.target.value;
            saveSettings(settings);
            clearSinkError();
            applySinkToAll();
            applySinkToAllContexts();
            // Reattach the monitor bus so it plays through the newly selected device.
            if (monitorDest) attachMonitorToOutput(monitorDest.stream);
        });

        const testSpkBtn = document.getElementById('xfw-test-spk');
        if (testSpkBtn) testSpkBtn.addEventListener('click', () => testOutputDevice());

        paintXcastStatus();

        // ── Sounds / MIDI / Looper wiring ────────────────────────────────────
        // Sub-tab switching inside the Sounds pane
        panel.querySelectorAll('.xfw-sub-tab').forEach(t => {
            t.addEventListener('click', () => {
                const sub = t.getAttribute('data-sub');
                const soundsPane = panel.querySelector('.xfw-pane[data-pane="sounds"]');
                if (!soundsPane) return;
                soundsPane.querySelectorAll('.xfw-sub-tab').forEach(x => x.classList.remove('xfw-active'));
                soundsPane.querySelectorAll('.xfw-sub-pane').forEach(x => x.classList.remove('xfw-active'));
                t.classList.add('xfw-active');
                const target = soundsPane.querySelector(`.xfw-sub-pane[data-sub="${sub}"]`);
                if (target) target.classList.add('xfw-active');
            });
        });

        // Build the 4×4 pad grid
        function buildPadGrid() {
            const grid = document.getElementById('xfw-pad-grid');
            if (!grid || grid.childElementCount) return;
            for (let i = 0; i < 16; i++) {
                const pad = settings.sbPads[i];
                const btn = document.createElement('button');
                btn.className = 'xfw-pad';
                btn.setAttribute('data-pad', i);
                btn.style.setProperty('--pad-color', pad.color);
                btn.title = `${pad.name} (MIDI: ${pad.midiNote})`;
                btn.innerHTML = `<span class="xfw-pad-name">${pad.name}</span>`;
                // Left-click: play / toggle
                btn.addEventListener('click', () => {
                    if (_padSources.has(i)) stopPad(i);
                    else playPad(i);
                });
                // Right-click: open pad editor
                btn.addEventListener('contextmenu', e => { e.preventDefault(); openPadEditor(i); });
                // Drag-and-drop audio files
                btn.addEventListener('dragover', e => { e.preventDefault(); btn.classList.add('xfw-pad-drag'); });
                btn.addEventListener('dragleave', () => btn.classList.remove('xfw-pad-drag'));
                btn.addEventListener('drop', async e => {
                    e.preventDefault(); btn.classList.remove('xfw-pad-drag');
                    const file = [...e.dataTransfer.files].find(f => f.type.startsWith('audio/'));
                    if (file) await loadPadFile(i, file);
                });
                grid.appendChild(btn);
            }
        }
        buildPadGrid();

        // Load audio file into a pad
        async function loadPadFile(index, file) {
            const buf = await file.arrayBuffer();
            await _padDB.put(`pad-${index}`, buf, file.name);
            _padBufferCache.delete(index); // clear cached decode
            _padSamplePitch.delete(index);
            settings.sbPads[index].name = file.name.replace(/\.[^.]+$/, '').slice(0, 20);
            settings.sbPads[index].builtin = null;
            settings.sbPads[index].sample = null;
            settings.sbPads[index].sfzInstrument = null;
            settings.sbPads[index].wafUrl = null; settings.sbPads[index].wafNote = null;
            saveSettings(settings);
            const btn = document.querySelector(`[data-pad="${index}"]`);
            if (btn) { btn.querySelector('.xfw-pad-name').textContent = settings.sbPads[index].name; btn.title = settings.sbPads[index].name; btn.classList.add('xfw-pad-loaded'); }
            // Update editor if open for this pad
            const editor = document.getElementById('xfw-pad-editor');
            if (editor && editor.dataset.padIndex == index) openPadEditor(index);
        }

        // Pad editor
        let _peIndex = -1;
        function openPadEditor(index) {
            _peIndex = index;
            const pad = settings.sbPads[index];
            const editor = document.getElementById('xfw-pad-editor');
            if (!editor) return;
            editor.dataset.padIndex = index;
            editor.style.display = '';
            document.getElementById('xfw-pe-title').textContent = `Pad ${index+1}`;
            document.getElementById('xfw-pe-name').value = pad.name;
            const noteEl = document.getElementById('xfw-pe-note');
            if (noteEl && !noteEl.options.length) {
                for (let n = 0; n < 128; n++) {
                    const o = document.createElement('option');
                    o.value = n;
                    o.textContent = `${_NOTE_NAMES[n%12]}${Math.floor(n/12)-1} (${n})`;
                    noteEl.appendChild(o);
                }
            }
            if (noteEl) noteEl.value = pad.midiNote;
            const volEl = document.getElementById('xfw-pe-vol');
            const volVal = document.getElementById('xfw-pe-vol-val');
            if (volEl) { volEl.value = pad.volume; if (volVal) volVal.textContent = Math.round(pad.volume*100)+'%'; }
            const loopEl = document.getElementById('xfw-pe-loop');
            if (loopEl) loopEl.classList.toggle('xfw-on', !!pad.loop);
        }
        window.__xcOpenPadEditor = openPadEditor;

        const editorEl = document.getElementById('xfw-pad-editor');
        if (editorEl) {
            document.getElementById('xfw-pe-close').addEventListener('click', () => { editorEl.style.display='none'; _peIndex=-1; });
            document.getElementById('xfw-pe-name').addEventListener('input', e => {
                if (_peIndex<0) return;
                settings.sbPads[_peIndex].name = e.target.value;
                saveSettings(settings);
                const btn=document.querySelector(`[data-pad="${_peIndex}"]`);
                if (btn) btn.querySelector('.xfw-pad-name').textContent = e.target.value;
            });
            document.getElementById('xfw-pe-note').addEventListener('change', e => {
                if (_peIndex<0) return;
                settings.sbPads[_peIndex].midiNote = +e.target.value;
                saveSettings(settings);
            });
            const learnBtn = document.getElementById('xfw-pe-learn');
            if (learnBtn) {
                const learnDefaultLabel = learnBtn.textContent;
                learnBtn.addEventListener('click', async () => {
                    if (_peIndex<0) return;
                    learnBtn.textContent = 'Connecting…';
                    learnBtn.disabled = true;
                    await initMIDI(); // make sure MIDI access is requested if not already
                    learnBtn.textContent = 'Waiting for note…';
                    const targetIndex = _peIndex;
                    // 8s auto-cancel so a Learn arm that's never completed (e.g. user
                    // clicked away) can't sit armed and swallow a later note-on forever.
                    let learnTimeoutId = setTimeout(() => {
                        window.__xcMidiLearn = null;
                        learnBtn.textContent = learnDefaultLabel;
                        learnBtn.disabled = false;
                    }, 8000);
                    window.__xcMidiLearn = (kind, number) => {
                        if (kind !== 'note') return false;
                        clearTimeout(learnTimeoutId);
                        settings.sbPads[targetIndex].midiNote = number;
                        saveSettings(settings);
                        const noteEl2 = document.getElementById('xfw-pe-note');
                        if (noteEl2 && _peIndex === targetIndex) noteEl2.value = number;
                        const btn = document.querySelector(`[data-pad="${targetIndex}"]`);
                        if (btn) btn.title = `${settings.sbPads[targetIndex].name} (MIDI: ${number})`;
                        learnBtn.textContent = learnDefaultLabel;
                        learnBtn.disabled = false;
                        window.__xcMidiLearn = null;
                        return true; // swallow this note-on so it doesn't also fire the pad/synth
                    };
                });
            }
            const volEl2=document.getElementById('xfw-pe-vol');
            const volVal2=document.getElementById('xfw-pe-vol-val');
            if (volEl2) volEl2.addEventListener('input', e => {
                if (_peIndex<0) return;
                settings.sbPads[_peIndex].volume = +e.target.value;
                if (volVal2) volVal2.textContent = Math.round(+e.target.value*100)+'%';
                saveSettings(settings);
            });
            document.getElementById('xfw-pe-loop').addEventListener('click', () => {
                if (_peIndex<0) return;
                settings.sbPads[_peIndex].loop = !settings.sbPads[_peIndex].loop;
                document.getElementById('xfw-pe-loop').classList.toggle('xfw-on', settings.sbPads[_peIndex].loop);
                saveSettings(settings);
            });
            const fileInput = document.getElementById('xfw-pe-file');
            document.getElementById('xfw-pe-load').addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', async () => {
                if (_peIndex<0||!fileInput.files[0]) return;
                await loadPadFile(_peIndex, fileInput.files[0]);
                fileInput.value='';
            });
            document.getElementById('xfw-pe-clear').addEventListener('click', async () => {
                if (_peIndex<0) return;
                await _padDB.del(`pad-${_peIndex}`);
                _padBufferCache.delete(_peIndex);
                _padSamplePitch.delete(_peIndex);
                stopPad(_peIndex);
                settings.sbPads[_peIndex].name = `Pad ${_peIndex+1}`;
                settings.sbPads[_peIndex].builtin = null;
                settings.sbPads[_peIndex].sample = null;
                settings.sbPads[_peIndex].sfzInstrument = null;
                settings.sbPads[_peIndex].sfzNote = null;
                settings.sbPads[_peIndex].wafUrl = null;
                settings.sbPads[_peIndex].wafNote = null;
                saveSettings(settings);
                const btn=document.querySelector(`[data-pad="${_peIndex}"]`);
                if (btn) { btn.querySelector('.xfw-pad-name').textContent=settings.sbPads[_peIndex].name; btn.classList.remove('xfw-pad-loaded'); }
                openPadEditor(_peIndex);
            });
        }

        // Synth controls
        const waveEl = document.getElementById('xfw-synth-wave');
        if (waveEl) {
            waveEl.value = settings.synthWave || 'sawtooth';
            waveEl.addEventListener('change', () => {
                settings.synthWave = waveEl.value;
                saveSettings(settings);
                _synthVoices.forEach(v => { v.osc.type = settings.synthWave; });
            });
        }
        const octaveEl = document.getElementById('xfw-synth-octave');
        if (octaveEl) {
            octaveEl.value = settings.synthOctave || 0;
            octaveEl.addEventListener('change', () => {
                synthAllNotesOff();
                settings.synthOctave = +octaveEl.value;
                saveSettings(settings);
            });
        }

        // MIDI controls
        const midiDevSel = document.getElementById('xfw-midi-device');
        if (midiDevSel) midiDevSel.addEventListener('change', () => {
            settings.midiDeviceId = midiDevSel.value;
            saveSettings(settings);
        });
        const midiChanSel = document.getElementById('xfw-midi-channel');
        if (midiChanSel) {
            midiChanSel.value = settings.midiChannel || 0;
            midiChanSel.addEventListener('change', () => {
                settings.midiChannel = +midiChanSel.value;
                saveSettings(settings);
            });
        }

        // Loop Station track transport buttons: four explicit buttons per track
        // — Record (●, new take or overdub), Play (▶, resume), Stop/Pause (❚❚,
        // ends whatever is active), Clear (✕, erases the loop). These live in
        // the separate Loop Station popup window, not inside #xfw-panel, so
        // query the whole document.
        document.querySelectorAll('[data-loop-rec]').forEach(btn => {
            const layer = +btn.getAttribute('data-loop-rec');
            btn.addEventListener('click', () => loopRecordButton(layer));
        });
        document.querySelectorAll('[data-loop-play]').forEach(btn => {
            const layer = +btn.getAttribute('data-loop-play');
            btn.addEventListener('click', () => loopPlayButton(layer));
        });
        document.querySelectorAll('[data-loop-stop]').forEach(btn => {
            const layer = +btn.getAttribute('data-loop-stop');
            btn.addEventListener('click', () => loopStopButton(layer));
        });
        document.querySelectorAll('[data-loop-clear]').forEach(btn => {
            const layer = +btn.getAttribute('data-loop-clear');
            btn.addEventListener('click', () => loopClearButton(layer));
        });
        for (let i = 0; i < _LOOP_LAYERS; i++) _updateLoopUI(i);

        // Master Play All / Stop All / Clear All — like the RC-505's global play + stop + all-erase.
        const loopPlayAllBtn = document.getElementById('xfw-loop-play-all');
        if (loopPlayAllBtn) loopPlayAllBtn.addEventListener('click', () => loopPlayAllStopped());
        const loopStopAllBtn = document.getElementById('xfw-loop-stop-all');
        if (loopStopAllBtn) loopStopAllBtn.addEventListener('click', () => loopStopAllPlaying());
        const loopClearAllBtn = document.getElementById('xfw-loop-clear-all');
        if (loopClearAllBtn) loopClearAllBtn.addEventListener('click', () => loopClearAll());
        const loopShowPianoRollBtn = document.getElementById('xfw-loop-show-pianoroll');
        if (loopShowPianoRollBtn) loopShowPianoRollBtn.addEventListener('click', () => {
            settings.pianoRollPopupOpen = !settings.pianoRollPopupOpen;
            saveSettings(settings);
            if (settings.pianoRollPopupOpen) showPianoRollPopup(); else hidePianoRollPopup();
        });

        // Per-track level fader (like the RC-505's 5 physical track faders).
        document.querySelectorAll('[data-track-vol]').forEach(input => {
            const layer = +input.getAttribute('data-track-vol');
            input.value = settings.loopTrackGainDb[layer] || 0;
            input.addEventListener('input', () => {
                settings.loopTrackGainDb[layer] = +input.value;
                saveSettings(settings);
                const L = _loops[layer];
                if (L?.gainNode) L.gainNode.gain.value = _loopTrackGain(layer);
            });
        });

        // Tempo (BPM) — shared by all 5 tracks' auto-loop bar-length dials.
        const bpmEl = document.getElementById('xfw-loop-bpm');
        if (bpmEl) {
            bpmEl.value = settings.loopBpm || 120;
            bpmEl.addEventListener('change', () => {
                settings.loopBpm = Math.max(40, Math.min(240, +bpmEl.value || 120));
                bpmEl.value = settings.loopBpm;
                saveSettings(settings);
            });
        }

        // Tap tempo — tap a few times in rhythm to set the BPM by feel, like
        // the RC-505's press-and-hold tempo tap.
        const tapBtn = document.getElementById('xfw-loop-tap-tempo');
        if (tapBtn) {
            let tapTimes = [];
            tapBtn.addEventListener('click', () => {
                const now = performance.now();
                if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) tapTimes = [];
                tapTimes.push(now);
                if (tapTimes.length > 5) tapTimes.shift();
                if (tapTimes.length >= 2) {
                    const intervals = [];
                    for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
                    const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
                    const bpm = Math.max(40, Math.min(240, Math.round(60000 / avgMs)));
                    settings.loopBpm = bpm;
                    saveSettings(settings);
                    if (bpmEl) bpmEl.value = bpm;
                }
            });
        }

        // Metronome (click track) — monitor-only, never recorded/broadcast.
        const metroBtn = document.getElementById('xfw-metronome-toggle');
        if (metroBtn) {
            metroBtn.classList.toggle('xfw-metronome-on', !!settings.metronomeEnabled);
            metroBtn.addEventListener('click', () => _setMetronomeEnabled(!settings.metronomeEnabled));
        }

        // Bar-length dial (circular selector) per layer: click cycles
        // Manual → 4 → 8 → 16 → 32 → 64 → Manual… When a bar count is set,
        // Rec auto-stops after that many bars (at the current BPM) and
        // immediately starts looping — one click, hands-free.
        const _BAR_OPTIONS = [null, 4, 8, 16, 32, 64];
        function _paintBarDial(layer) {
            const btn = document.querySelector(`[data-bar-dial="${layer}"]`);
            if (!btn) return;
            const bars = settings.loopBars[layer];
            btn.textContent = bars ? String(bars) : 'M';
            btn.classList.toggle('xfw-bar-dial-on', !!bars);
            btn.title = bars
                ? `Auto-loop: ${bars} bars @ ${settings.loopBpm || 120} BPM — click to change`
                : 'Manual — click to set an auto-loop bar length';
        }
        document.querySelectorAll('[data-bar-dial]').forEach(btn => {
            const layer = +btn.getAttribute('data-bar-dial');
            _paintBarDial(layer);
            btn.addEventListener('click', () => {
                const cur = settings.loopBars[layer] || null;
                const idx = (_BAR_OPTIONS.indexOf(cur) + 1) % _BAR_OPTIONS.length;
                settings.loopBars[layer] = _BAR_OPTIONS[idx];
                saveSettings(settings);
                _paintBarDial(layer);
            });
        });

        // Quantize dial per layer: click cycles Auto (=1/4 bar) → Off → 1/4 →
        // 1/8 → 1/16 → 1/32 → Auto… Snaps the ACTUAL start of Record/Overdub
        // to this grid interval (at the shared BPM) instead of starting the
        // instant the button/hardware key is pressed — important since input
        // is usually MIDI-triggered and a beat early/late would otherwise be
        // baked permanently into the loop.
        const _QUANTIZE_OPTIONS = ['auto', 'off', 4, 8, 16, 32];
        function _paintQuantizeDial(layer) {
            const btn = document.querySelector(`[data-quantize-dial="${layer}"]`);
            if (!btn) return;
            const q = settings.loopQuantize[layer];
            btn.textContent = q === 'auto' ? 'A' : (q === 'off' ? 'off' : `⅟${q}`);
            btn.classList.toggle('xfw-quantize-dial-on', q !== 'off');
            btn.title = `Record/overdub start snap: ${_quantizeLabel(layer)} — click to change`;
        }
        document.querySelectorAll('[data-quantize-dial]').forEach(btn => {
            const layer = +btn.getAttribute('data-quantize-dial');
            _paintQuantizeDial(layer);
            btn.addEventListener('click', () => {
                const cur = settings.loopQuantize[layer];
                const idx = (_QUANTIZE_OPTIONS.indexOf(cur) + 1) % _QUANTIZE_OPTIONS.length;
                settings.loopQuantize[layer] = _QUANTIZE_OPTIONS[idx];
                saveSettings(settings);
                _paintQuantizeDial(layer);
            });
        });

        // Learn Record / Play transport buttons (e.g. Launchkey Mini hardware
        // Record & Play keys) — captures the next MIDI note or CC and maps it.
        // MIDI access is awaited BEFORE arming the listener, and the arm times
        // out after 8s, so a stray later keypress/pad hit can never be mis-
        // captured as the transport mapping (this was the root cause of pads
        // triggering Record instead of playing — a pad note got learned by
        // accident because the click handler armed listening immediately, even
        // while MIDI access was still being requested).
        function _paintTransportStatus() {
            const status = document.getElementById('xfw-loop-transport-status');
            if (!status) return;
            const fmt = (m) => m ? `${m.type === 'note' ? 'note' : 'CC'} ${m.number}` : 'not set';
            status.textContent = (settings.midiRecordMap || settings.midiPlayMap)
                ? `Record: ${fmt(settings.midiRecordMap)} · Play: ${fmt(settings.midiPlayMap)}`
                : `Map your controller's Record/Play buttons (e.g. Launchkey Mini) to auto-loop hands-free.`;
        }
        function _wireTransportLearn(btnId, settingsKey, label) {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            const defaultLabel = btnId === 'xfw-learn-loop-record' ? '🎙 Learn Record' : '▶ Learn Play';
            btn.addEventListener('click', async () => {
                btn.textContent = 'Connecting…';
                btn.disabled = true;
                await initMIDI();
                btn.textContent = `Waiting for ${label}…`;
                let timeoutId = setTimeout(() => {
                    window.__xcMidiLearn = null;
                    btn.textContent = defaultLabel;
                    btn.disabled = false;
                }, 8000);
                window.__xcMidiLearn = (kind, number) => {
                    clearTimeout(timeoutId);
                    settings[settingsKey] = { type: kind, number };
                    saveSettings(settings);
                    _paintTransportStatus();
                    btn.textContent = defaultLabel;
                    btn.disabled = false;
                    window.__xcMidiLearn = null;
                    return true;
                };
            });
        }
        _wireTransportLearn('xfw-learn-loop-record', 'midiRecordMap', 'Record');
        _wireTransportLearn('xfw-learn-loop-play', 'midiPlayMap', 'Play');
        function _wireUnlearnTransport(btnId, settingsKey) {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', () => {
                settings[settingsKey] = null;
                saveSettings(settings);
                _paintTransportStatus();
            });
        }
        _wireUnlearnTransport('xfw-unlearn-loop-record', 'midiRecordMap');
        _wireUnlearnTransport('xfw-unlearn-loop-play', 'midiPlayMap');
        _paintTransportStatus();

        // Kit category tabs — show/hide the relevant kit buttons group
        function _switchKitTab(cat) {
            panel.querySelectorAll('.xfw-kit-tab').forEach(t => t.classList.toggle('xfw-kit-tab-active', t.getAttribute('data-cat') === cat));
            panel.querySelectorAll('.xfw-kit-group').forEach(g => g.style.display = 'none');
            const grp = panel.querySelector(`#xfw-kit-group-${cat}`);
            if (grp) grp.style.display = grp.classList.contains('xfw-buttons') ? 'flex' : 'block';
            // Auto-load the current selection when switching to a select-based tab
            const sel = grp?.querySelector('.xfw-kit-select');
            if (sel) loadKit(sel.value);
        }
        panel.querySelectorAll('.xfw-kit-tab').forEach(tab => {
            tab.addEventListener('click', () => _switchKitTab(tab.getAttribute('data-cat')));
        });
        // Select-based tabs auto-load on change
        panel.querySelectorAll('.xfw-kit-select').forEach(sel => {
            sel.addEventListener('change', () => loadKit(sel.value));
        });
        _switchKitTab('drums'); // open on Drums tab by default

        // Default kit buttons (Drums / Piano / Guitar / SFX / Synth keys)
        panel.querySelectorAll('.xfw-kit-btn').forEach(btn => {
            btn.addEventListener('click', () => loadKit(btn.getAttribute('data-kit')));
        });

        // Synth preset buttons
        panel.querySelectorAll('.xfw-synth-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => applySynthPreset(btn.getAttribute('data-synth-preset')));
        });

        // Toggle handler: add soundboard-specific keys
        // (These are caught by the generic toggle handler already via data-key.
        //  Here we add extra side effects.)
        panel.addEventListener('click', e => {
            const t = e.target.closest('.xfw-toggle');
            if (!t) return;
            const key = t.getAttribute('data-key');
            if (key === 'sbMuted' || key === 'sbMonitor' || key === 'sbCue') applyMixerLive();
            if (key === 'synthEnabled' && settings.synthEnabled) initSynth();
        });

        // Init MIDI + warm up the shared audio graph on first open of the Sounds pane,
        // so pads/synth are ready to make sound the moment a MIDI device is pressed.
        let _midiInited = false;
        panel.querySelectorAll('.xfw-tab[data-pane]').forEach(t => {
            t.addEventListener('click', () => {
                if (t.getAttribute('data-pane')==='sounds' && !_midiInited) {
                    _midiInited = true;
                    initMIDI();
                    ensureProcessedStream().catch(()=>{});
                }
            });
        });

        // presets
        panel.querySelectorAll('.xfw-preset').forEach(b => {
            b.addEventListener('click', () => applyPreset(b.getAttribute('data-preset')));
        });

        // ── FX / Autotune wiring ────────────────────────────────────────────
        // Populate key selector
        const atKey = document.getElementById('xfw-at-key');
        if (atKey) {
            _NOTE_NAMES.forEach((n, i) => {
                const o = document.createElement('option');
                o.value = i; o.textContent = n;
                atKey.appendChild(o);
            });
            atKey.value = settings.autotuneKey || 0;
            atKey.addEventListener('change', () => {
                settings.autotuneKey = +atKey.value;
                saveSettings(settings);
                updatePitchNode();
            });
        }

        const atScale = document.getElementById('xfw-at-scale');
        if (atScale) {
            atScale.value = 'major'; // default shown
            atScale.addEventListener('change', () => {
                const def = _AUTOTUNE_SCALES[atScale.value] || _AUTOTUNE_SCALES.chromatic;
                settings.autotuneScale = def; // store for reload
                saveSettings(settings);
                if (pitchNode) pitchNode.port.postMessage({ scale: def });
            });
        }

        // When autotuneEnabled toggle fires, rebuild graph to insert/remove the node.
        const _origToggleHandler = panel.onclick;
        panel.addEventListener('click', e => {
            const t = e.target.closest('.xfw-toggle');
            if (!t) return;
            const key = t.getAttribute('data-key');
            if (key === 'autotuneEnabled') {
                // Ensure worklet is loaded, then rebuild.
                if (settings.autotuneEnabled && audioCtx) {
                    ensurePitchWorklet(audioCtx).then(() => {
                        buildGraph();
                        replaceTracksOnActivePCs();
                    }).catch(() => {});
                } else {
                    if (pitchNode) { try { pitchNode.disconnect(); } catch {} pitchNode = null; }
                    buildGraph();
                    replaceTracksOnActivePCs();
                }
            }
            if (key === 'autotuneAuto') {
                updatePitchNode();
            }
        });

        // bottom buttons
        document.getElementById('xfw-rebuild').addEventListener('click', async () => {
            await rebuildAfterDeviceChange();
            startMeters();
        });
        document.getElementById('xfw-reload').addEventListener('click', () => location.reload());

        document.getElementById('xfw-recover-inbound')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const prev = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Recovering…';
            try {
                const n = await recoverInboundAudio();
                btn.textContent = n ? 'ICE restart requested' : 'No active connection';
            } catch (err) {
                console.warn('[XCaster] inbound recovery failed', err);
                btn.textContent = 'Recovery failed';
            }
            // Let the next probe decide whether audio actually came back.
            setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 4000);
        });

        navigator.mediaDevices.addEventListener?.('devicechange', () => {
            populateInputs(); populateOutputs();
        });

        // skin reset button
        const resetBtn = document.getElementById('xfw-reset-positions');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                settings.fabPos = null;
                settings.panelPos = null;
                settings.padsPopupPos = null;
                settings.loopPopupPos = null;
                settings.pianoRollPopupPos = null;
                saveSettings(settings);
                applyFabPos();
                applyPanelPos();
                applyPadsPopupPos();
                applyLoopPopupPos();
                applyPianoRollPopupPos();
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
        // Only decode video when the skin is actually on. This used to run
        // unconditionally at boot with applySkin() merely setting display:none
        // afterwards, so every tab in the app — the overlay is injected into
        // ALL of them — kept an autoplay/loop <video> alive and decoding, and
        // tryPlay() below re-kicked it on every visibilitychange and focus.
        if (!settings.bgEnabled) return;
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
        // Only decode while this tab is actually on screen. The overlay is
        // injected into every tab, so the previous unconditional tryPlay() —
        // which fired on visibilitychange even when the page had just become
        // HIDDEN — kept a video decoding in every background tab at once.
        const syncPlayback = () => {
            if (document.hidden) { try { vid.pause(); } catch { /* ignore */ } return; }
            vid.play?.().catch(() => {});
        };
        syncPlayback();
        document.addEventListener('visibilitychange', syncPlayback);
        window.addEventListener('focus', syncPlayback);
    }

    // Tear the background video down rather than hiding it — display:none keeps
    // the element, its decoder and its buffered data resident.
    function removeBackground() {
        const vid = document.getElementById('xfw-bg');
        if (vid) {
            try { vid.pause(); vid.removeAttribute('src'); vid.load(); } catch { /* ignore */ }
            vid.remove();
        }
        document.getElementById('xfw-bg-tint')?.remove();
    }

    function applySkin() {
        const html = document.documentElement;
        const on = !!settings.bgEnabled;
        html.classList.toggle('xfw-skin-on', on);
        if (on) installBackground();
        else removeBackground();
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

    function _applyFloatingPopupPos(id, pos, defaultLeft, defaultTop) {
        const el = document.getElementById(id);
        if (!el) return;
        const p = pos;
        const w = el.offsetWidth || 220;
        const h = el.offsetHeight || 260;
        const x = p ? p.x : defaultLeft;
        const y = p ? p.y : defaultTop;
        el.style.left = clamp(x, 0, window.innerWidth - Math.min(w, window.innerWidth)) + 'px';
        el.style.top = clamp(y, 0, window.innerHeight - Math.min(h, window.innerHeight)) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    }
    function applyPadsPopupPos() {
        _applyFloatingPopupPos('xfw-pads-popup', settings.padsPopupPos, 24, 90);
    }
    function applyLoopPopupPos() {
        _applyFloatingPopupPos('xfw-loop-popup', settings.loopPopupPos, 300, 90);
    }
    function applyPianoRollPopupPos() {
        _applyFloatingPopupPos('xfw-pianoroll-popup', settings.pianoRollPopupPos, 24, 640);
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

    // Tell the main process whether this tab is carrying a live Space. main.js
    // background-throttles any X view that is not the visible one, which stalls
    // the WebRTC pipeline of a Space you switched away from — it needs to know
    // which views must stay unthrottled even while hidden.
    function _updateAudioActiveFlag() {
        let live = false;
        try {
            for (const pc of __xfwPCs) {
                // 'disconnected' counts as live: it often recovers on its own,
                // and throttling or de-prioritising the view mid-blip is the
                // worst possible moment. Only 'failed'/'closed'/'new' do not.
                if (['connected', 'connecting', 'disconnected'].includes(pc.connectionState)) {
                    live = true; break;
                }
            }
        } catch { /* ignore */ }
        try { window.__xfwAudioActive = live; } catch { /* ignore */ }
    }

    // Periodic health check catches state drift that event listeners miss
    // (some virtual cable drivers on Windows don't fire 'ended' reliably).
    function startHealthWatchdog() {
        setInterval(() => {
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            if (xOutputCtx && xOutputCtx.state === 'suspended') {
                xOutputCtx.resume().catch(() => {});
            }
            if (micRawStream) {
                const t = micRawStream.getAudioTracks()[0];
                if (t && t.readyState === 'ended') rebuildMic();
            }
            if (auxRawStream && settings.auxDeviceId && settings.auxDeviceId !== 'none') {
                const t = auxRawStream.getAudioTracks()[0];
                if (t && t.readyState === 'ended') rebuildAux();
            }
            if (aux2RawStream && settings.aux2DeviceId && settings.aux2DeviceId !== 'none') {
                const t = aux2RawStream.getAudioTracks()[0];
                if (t && t.readyState === 'ended') rebuildAux2();
            }
            healActiveAudioSendersIfNeeded().catch(() => {});
            sweepIdleAudioCache();
            _updateAudioActiveFlag();
        }, 4000);
    }

    // ---------- worker keepalive --------------------------------------------
    // Chromium throttles main-thread timers when the window is occluded, but
    // Web Worker timers are exempt from that throttling. We spawn a tiny
    // worker that pings the main thread every 250ms; the message handler
    // resumes any suspended AudioContexts and forces the main thread to
    // remain scheduled regularly. This eliminates audio choppiness when
    // other apps cover the XCaster window.
    let _keepaliveStarted = false;
    // Only worth running where an AudioContext exists. Called from install()
    // (a no-op on a tab with no graph) and again from ensureAudioContext().
    function maybeStartWorkerKeepalive() {
        if (_keepaliveStarted) return;
        if (!audioCtx && !xOutputCtx && !xBroadcastCtx) return;
        _keepaliveStarted = true;
        startWorkerKeepalive();
    }

    function startWorkerKeepalive() {
        try {
            const src = `let id = setInterval(() => postMessage(0), 250);`;
            const blob = new Blob([src], { type: 'application/javascript' });
            const w = new Worker(URL.createObjectURL(blob));
            w.onmessage = () => {
                if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
                if (xOutputCtx && xOutputCtx.state === 'suspended') xOutputCtx.resume().catch(() => {});
                if (xBroadcastCtx && xBroadcastCtx.state === 'suspended') xBroadcastCtx.resume().catch(() => {});
            };
        } catch (err) {
            console.warn('[XCaster] worker keepalive failed', err);
        }
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
        // startWorkerKeepalive() is NOT called here any more. It exists to keep
        // the audio thread scheduled when the window is occluded, so it is worth
        // a Worker plus a 250ms ping only on a tab that actually has an audio
        // graph. The overlay is injected into every tab, so starting it at boot
        // meant a worker per tab doing nothing. ensureAudioContext() starts it.
        maybeStartWorkerKeepalive();
    }
    install();
})();
