// XCaster main process
// Standalone Chromium shell for x.com with WebRTC audio processing disabled.
// Gives streamers full control over launch flags and getUserMedia constraints,
// plus a full DSP/mixer overlay for professional X Spaces audio.

const { app, BrowserWindow, BrowserView, session, Menu, shell, ipcMain, dialog, protocol, net, powerSaveBlocker, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');

// Register custom protocol so the in-page overlay can load packaged assets
// (e.g. background.mp4) from an https origin without tripping CSP/CORS.
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'xfw',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true,
            bypassCSP: true,
            corsEnabled: true,
        },
    },
]);

// --- Chromium command-line switches -----------------------------------------
// These run before app.whenReady() and disable Chromium's built-in input-side
// audio processing so X cannot auto-level us.
//
// Notes:
//  - We force the audio service to NOT apply WebRTC APM (AGC/NS/AEC).
//  - We disable hybrid AGC variants and the analog gain controller that
//    silently rides the OS mic slider.
//  - We still patch getUserMedia in the preload as a belt-and-suspenders
//    measure, because X passes its own constraints.
app.commandLine.appendSwitch(
    'disable-features',
    [
        // WebRTC input-side audio processing (we do our own).
        'WebRtcAllowInputVolumeAdjustment',
        'WebRtcAnalogAgcClippingControl',
        'WebRtcHybridAgc',
        'ChromeWideEchoCancellation',
        'WebRtcApmInAudioService',
        // Background throttling / freezing that causes choppy audio.
        'IntensiveWakeUpThrottling',
        'CalculateNativeWinOcclusion',
        'TabFreezing',
        'FreezingOnEnergySaverDesktop',
    ].join(',')
);
app.commandLine.appendSwitch('try-supported-channel-layouts');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Keep the renderer process at full priority when the window is minimized,
// occluded, or the user switches to another app. Without these, Chromium
// throttles the renderer CPU allocation, which causes the Web Audio processing
// thread to miss its callback deadlines and produce choppy audio.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Prevent media (AudioContext, MediaStream capture) from being suspended when
// the page is hidden. This is the main cause of audio cuts when alt-tabbing.
app.commandLine.appendSwitch('disable-background-media-suspend');
// Disable the priority manager which lowers process priority on idle/hidden.
app.commandLine.appendSwitch('disable-renderer-priority-management');

// Single-instance lock so a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
}

let mainWindow = null;
const xViews = new Map();  // tabId → BrowserView (for x.com tabs)
let TOOLBAR_HEIGHT = 82;   // updated dynamically via xfw:set-toolbar-height
const runtimeIntervals = new Set();
const powerSaveBlockerIds = new Set();

function registerInterval(callback, delay) {
    const timer = setInterval(callback, delay);
    runtimeIntervals.add(timer);
    return timer;
}

function startPowerSaveBlocker(type) {
    try {
        const id = powerSaveBlocker.start(type);
        if (id) powerSaveBlockerIds.add(id);
    } catch {}
}

function cleanupRuntimeGuards() {
    for (const timer of runtimeIntervals) clearInterval(timer);
    runtimeIntervals.clear();

    for (const id of powerSaveBlockerIds) {
        try {
            if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
        } catch {}
    }
    powerSaveBlockerIds.clear();
}

function raiseMainProcessPriorityWindows() {
    if (process.platform !== 'win32') return;
    try {
        const highPriority = os.constants?.priority?.PRIORITY_HIGH ?? -14;
        os.setPriority(process.pid, highPriority);
    } catch {}
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#000000',
        title: 'XCaster',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'shell-preload.js'),
            contextIsolation: true,
            // sandbox:false so the preload can use Node APIs (path, url) for contextBridge.
            sandbox: false,
            nodeIntegration: false,
            webviewTag: true,          // enables <webview> in shell.html
            backgroundThrottling: false,
        },
    });

    // Grant media / notification permissions for all sites loaded in this trusted browser.
    // The user explicitly chose to open a site in XCaster, so we treat every tab as trusted.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        const allowed = ['media', 'notifications', 'geolocation', 'pointerLock', 'clipboard-read', 'clipboard-sanitized-write'];
        callback(allowed.includes(permission));
    });

    // Strip the Electron token from the UA at the session level so all webviews
    // (and the shell itself) present as a standard Chrome desktop browser.
    session.defaultSession.setUserAgent(
        session.defaultSession.getUserAgent().replace(/Electron\/[^\s]+\s?/, '')
    );

    // Keep system + display awake while XCaster runs so Windows doesn't
    // throttle the audio capture pipeline when minimized.
    startPowerSaveBlocker('prevent-app-suspension');
    // 'prevent-display-sleep' also keeps the renderer at full priority on
    // Windows when the window is occluded (covered by other apps).
    startPowerSaveBlocker('prevent-display-sleep');

    // Re-assert no-throttling whenever the window is minimized, hidden, or
    // restored — Chromium can re-enable throttling on these transitions.
    const reassertNoThrottle = () => {
        try { mainWindow.webContents.setBackgroundThrottling(false); } catch {}
        try { mainWindow.webContents.setFrameRate(60); } catch {}
    };
    mainWindow.on('minimize', reassertNoThrottle);
    mainWindow.on('restore', reassertNoThrottle);
    mainWindow.on('hide', reassertNoThrottle);
    mainWindow.on('show', reassertNoThrottle);
    mainWindow.on('blur', reassertNoThrottle);
    mainWindow.on('focus', reassertNoThrottle);
    // Periodic re-assertion catches occlusion-driven throttling that no
    // event fires for (when other apps cover the window without minimizing).
    registerInterval(reassertNoThrottle, 2000);

    // Resize all visible BrowserViews (x.com tabs) to match new window size.
    // Must handle resize, maximize, fullscreen, and their reverses explicitly —
    // Electron does not fire 'resize' reliably for all of these on Windows.
    function updateXViewBounds() {
        if (!mainWindow) return;
        const [w, h] = mainWindow.getContentSize();
        for (const [, view] of xViews) {
            if (mainWindow.getBrowserViews().includes(view)) {
                view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: Math.max(0, h - TOOLBAR_HEIGHT) });
            }
        }
    }
    mainWindow.on('resize', updateXViewBounds);
    mainWindow.on('maximize', updateXViewBounds);
    mainWindow.on('unmaximize', updateXViewBounds);
    mainWindow.on('enter-full-screen', updateXViewBounds);
    mainWindow.on('leave-full-screen', updateXViewBounds);
    mainWindow.on('enter-html-full-screen', updateXViewBounds);
    mainWindow.on('leave-html-full-screen', updateXViewBounds);

    // Raise the main process priority without spawning terminal processes.
    // Renderer throttling is handled by Chromium flags and webContents settings above.
    raiseMainProcessPriorityWindows();

    // The shell window (shell.html) does not itself open new windows.
    // New-window events from webviews are handled inside shell.js.
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // ── Display-media handler ────────────────────────────────────────────
    // Fired when a webview calls navigator.mediaDevices.getDisplayMedia.
    // If the overlay dropdown pre-selected a tab (stored in window.__xcPendingCapture
    // on the shell window), resolve immediately with that tab — no picker modal.
    // Falls back to the interactive picker if no target was pre-set.
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
        try {
            // Check for pre-selected capture target from the overlay dropdown.
            let pendingId = null;
            try {
                pendingId = await mainWindow.webContents.executeJavaScript('window.__xcPendingCapture || null');
            } catch {}

            if (pendingId != null) {
                // Clear immediately so a second call starts fresh.
                try { await mainWindow.webContents.executeJavaScript('window.__xcPendingCapture = null'); } catch {}
                const target = webContents.fromId(+pendingId);
                if (target && !target.isDestroyed()) {
                    callback({ video: target.mainFrame, audio: target.mainFrame });
                    return;
                }
            }

            // If the request comes from the shell window itself (no tab selected),
            // capture the tab whose wcId the overlay set in __xcNextCaptureWcId.
            // The overlay sets this before each getDisplayMedia call so each
            // per-tab capture resolves with the right tab's audio frame.
            // suppressLocalAudioPlayback in the overlay request stops that tab
            // from playing to system output (virtual cable stays clean).
            const isShellFrame = mainWindow?.webContents?.mainFrame === request.frame;
            if (isShellFrame) {
                let wcId = null;
                try { wcId = await mainWindow.webContents.executeJavaScript('window.__xcNextCaptureWcId || null'); } catch {}
                if (wcId != null) {
                    const target = webContents.fromId(+wcId);
                    if (target && !target.isDestroyed()) {
                        callback({ video: target.mainFrame, audio: target.mainFrame });
                        return;
                    }
                }
                // No specific tab set — deny so overlay shows 'No tabs captured'.
                callback();
                return;
            }

            // Fall back to the interactive tab-picker modal.
            const requestor = request.frame?.frameTreeNodeId ?? null;
            const tabsList = webContents.getAllWebContents()
                .filter(wc => !wc.isDestroyed() && wc.getType() === 'webview')
                .map(wc => ({ id: wc.id, url: wc.getURL(), title: wc.getTitle() || wc.getURL() }))
                .filter(t => t.id !== requestor);

            const json = JSON.stringify(tabsList).replace(/`/g, '\\`');
            const picked = await mainWindow.webContents.executeJavaScript(
                `(window.__xcasterShowTabPicker && window.__xcasterShowTabPicker(${json})) || null`
            );
            if (!picked) { callback(); return; }

            const target = webContents.fromId(picked);
            if (!target || target.isDestroyed()) { callback(); return; }

            callback({ video: target.mainFrame, audio: target.mainFrame });
        } catch (err) {
            console.warn('[XCaster] display media handler failed', err);
            try { callback(); } catch { /* ignore */ }
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'shell.html'));

    // Once the shell UI is ready, check for a virtual audio cable and prompt to
    // install one if none is found — keeps XCaster's injection output isolated.
    mainWindow.webContents.once('dom-ready', () => {
        checkAndInstallVirtualCable().catch(err => {
            console.warn('[XCaster] virtual cable check error', err);
        });
    });

    // Minimal menu: File / View / Help. Hidden by default (autoHideMenuBar).
    const template = [
        {
            label: 'File',
            submenu: [
                { label: 'New Tab',  accelerator: 'CmdOrCtrl+T', click: () => mainWindow.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"t",ctrlKey:true,bubbles:true}))') },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { role: 'resetZoom' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
                { label: 'DevTools', accelerator: 'Ctrl+Shift+I', click: () => mainWindow.webContents.toggleDevTools() },
            ],
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'About XCaster',
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: 'About XCaster',
                            message: 'XCaster v1.1.1',
                            detail:
                                'Standalone Windows shell for x.com with WebRTC AGC, noise suppression, and echo cancellation disabled.\n\n' +
                                'v1.0.1 — Full multi-channel DSP mixer (Mic + Aux 1 + Aux 2 + xCaster), dual output routing (X Spaces injection + monitor/cue), reapply audio graph for clean channel selection, virtual cable auto-installer, compressor, limiter, EQ, background skin, and live meters.\n\n' +
                                'Built for X Spaces streamers who need clean, professional audio.',
                        });
                    },
                },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
    // Serve packaged assets via xfw://local/<file> (e.g. xfw://local/background.mp4).
    protocol.handle('xfw', (request) => {
        try {
            const url = new URL(request.url);
            // Treat host as a namespace and pathname as the file. Strip leading '/'.
            const rel = path.posix.normalize(url.pathname.replace(/^\/+/, ''));
            if (!rel || rel.includes('..')) {
                return new Response('not found', { status: 404 });
            }
            const full = path.join(__dirname, 'assets', rel);
            return net.fetch(pathToFileURL(full).toString());
        } catch (err) {
            return new Response('error', { status: 500 });
        }
    });

    // Strip Content-Security-Policy and related headers from x.com responses so
    // our injected overlay <script>/<style> is allowed to run. Without this, X's
    // CSP blocks the gear button and DSP graph from ever appearing.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = details.responseHeaders || {};
        const stripped = {};
        for (const k of Object.keys(headers)) {
            const lk = k.toLowerCase();
            if (
                lk === 'content-security-policy' ||
                lk === 'content-security-policy-report-only' ||
                lk === 'x-frame-options' ||
                lk === 'cross-origin-embedder-policy' ||
                lk === 'cross-origin-opener-policy' ||
                lk === 'cross-origin-resource-policy'
            ) {
                continue;
            }
            stripped[k] = headers[k];
        }
        callback({ responseHeaders: stripped });
    });

    // Load any extensions placed in <userData>/extensions before opening the window.
    autoLoadExtensions().finally(() => createWindow());
});

app.on('window-all-closed', () => {
    app.quit();
});

app.on('before-quit', cleanupRuntimeGuards);
app.on('will-quit', cleanupRuntimeGuards);

// Diagnostic IPC: webview preload notifies when overlay is injected.
ipcMain.on('xfw:gum-patched', (_e, info) => {
    console.log('[XCaster] getUserMedia patched on', info?.url);
});

// IPC: open a URL in the system default browser (called from shell renderer).
ipcMain.handle('xfw:open-external', (_e, url) => {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            shell.openExternal(url);
        }
    } catch { /* ignore invalid URLs */ }
});

// IPC: broadcast relay — webview asks shell for a WebRTC offer carrying the
// fully processed mix. Shell creates an RTCPeerConnection, adds the processed
// stream track, and returns the SDP offer + session id. The webview then
// completes the handshake so it receives the mix as a local MediaStreamTrack,
// which it returns from getUserMedia — no physical virtual cable required.
ipcMain.handle('xfw:broadcast-offer', async () => {
    try {
        return await mainWindow.webContents.executeJavaScript('window.__xcCreateBroadcastOffer()');
    } catch (err) {
        console.warn('[XCaster] broadcast-offer IPC failed', err);
        return null;
    }
});
ipcMain.handle('xfw:broadcast-answer', async (_e, id, answerSdp) => {
    try {
        const idJ = JSON.stringify(String(id));
        const sdpJ = JSON.stringify(String(answerSdp));
        await mainWindow.webContents.executeJavaScript(`window.__xcApplyBroadcastAnswer(${idJ}, ${sdpJ})`);
    } catch (err) {
        console.warn('[XCaster] broadcast-answer IPC failed', err);
    }
});
ipcMain.handle('xfw:get-settings', async () => {
    try {
        return await mainWindow.webContents.executeJavaScript('window.__xcGetSettings()');
    } catch (err) {
        console.warn('[XCaster] get-settings IPC failed', err);
        return null;
    }
});
ipcMain.handle('xfw:get-xcast-offer', async () => {
    try {
        return await mainWindow.webContents.executeJavaScript('window.__xcCreateXcastOffer()');
    } catch (err) {
        console.warn('[XCaster] get-xcast-offer IPC failed', err);
        return null;
    }
});

// ── BrowserView management for x.com tabs (v0.5.0 audio fidelity) ───────────
// Each x.com/twitter.com tab runs in a dedicated BrowserView with preload.js —
// identical to v0.5.0's architecture. overlay.js patches getUserMedia directly
// in the renderer process, so the DSP graph and WebRTC senders are in the same
// context. This is what makes audio work reliably.

ipcMain.handle('xfw:set-toolbar-height', (_e, h) => {
    if (typeof h === 'number' && h > 0) TOOLBAR_HEIGHT = Math.ceil(h);
});

function getXViewBounds() {
    if (!mainWindow) return { x: 0, y: TOOLBAR_HEIGHT, width: 1200, height: 600 };
    const [w, h] = mainWindow.getContentSize();
    return { x: 0, y: TOOLBAR_HEIGHT, width: w, height: Math.max(0, h - TOOLBAR_HEIGHT) };
}

ipcMain.handle('xfw:create-xview', (_e, tabId, url) => {
    if (xViews.has(tabId)) return { ok: true };
    const view = new BrowserView({
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'), // v0.5.0 preload — direct injection
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
    });
    // Match v0.5.0 UA (strip Electron token).
    view.webContents.setUserAgent(
        view.webContents.getUserAgent().replace(/Electron\/[^\s]+\s?/, '')
    );
    view.webContents.setBackgroundThrottling(false);

    // Forward navigation/loading events back to the shell renderer.
    const fwd = (type, data) => {
        try { mainWindow.webContents.send('xfw:xview-event', tabId, type, data); } catch {}
    };
    view.webContents.on('did-navigate', (_e, u) => fwd('navigate', u));
    view.webContents.on('did-navigate-in-page', (_e, u, isMain) => { if (isMain) fwd('navigate', u); });
    view.webContents.on('did-start-loading', () => fwd('loading', true));
    view.webContents.on('did-stop-loading', () => {
        fwd('loading', false);
        fwd('title', view.webContents.getTitle());
    });
    view.webContents.on('page-title-updated', (_e, title) => fwd('title', title));
    view.webContents.on('page-favicon-updated', (_e, favicons) => fwd('favicon', favicons[0] || null));

    // Open new windows: x.com links navigate in-place, others go to system browser.
    view.webContents.setWindowOpenHandler(({ url: u }) => {
        try {
            const host = new URL(u).hostname;
            if (host.endsWith('x.com') || host.endsWith('twitter.com')) {
                view.webContents.loadURL(u);
                return { action: 'deny' };
            }
        } catch {}
        shell.openExternal(u);
        return { action: 'deny' };
    });

    xViews.set(tabId, view);
    view.webContents.loadURL(url);
    return { ok: true };
});

ipcMain.handle('xfw:show-xview', (_e, tabId) => {
    const view = xViews.get(tabId);
    if (!view || !mainWindow) return;
    if (!mainWindow.getBrowserViews().includes(view)) mainWindow.addBrowserView(view);
    view.setBounds(getXViewBounds());
    view.webContents.setBackgroundThrottling(false);
});

ipcMain.handle('xfw:hide-xview', (_e, tabId) => {
    const view = xViews.get(tabId);
    if (!view || !mainWindow) return;
    mainWindow.removeBrowserView(view);
});

ipcMain.handle('xfw:destroy-xview', (_e, tabId) => {
    const view = xViews.get(tabId);
    if (!view) return;
    try { if (mainWindow) mainWindow.removeBrowserView(view); } catch {}
    try { view.webContents.destroy(); } catch {}
    xViews.delete(tabId);
});

ipcMain.handle('xfw:navigate-xview', (_e, tabId, url) => {
    xViews.get(tabId)?.webContents.loadURL(url);
});

ipcMain.handle('xfw:back-xview', (_e, tabId) => {
    xViews.get(tabId)?.webContents.goBack();
});

ipcMain.handle('xfw:forward-xview', (_e, tabId) => {
    xViews.get(tabId)?.webContents.goForward();
});

ipcMain.handle('xfw:reload-xview', (_e, tabId) => {
    const v = xViews.get(tabId);
    if (v) { try { v.webContents.isLoadingMainFrame() ? v.webContents.stop() : v.webContents.reload(); } catch {} }
});

ipcMain.handle('xfw:cangoback-xview', (_e, tabId) => {
    return xViews.get(tabId)?.webContents.canGoBack() ?? false;
});

ipcMain.handle('xfw:cangoforward-xview', (_e, tabId) => {
    return xViews.get(tabId)?.webContents.canGoForward() ?? false;
});

ipcMain.handle('xfw:devtools-xview', (_e, tabId) => {
    xViews.get(tabId)?.webContents.toggleDevTools();
});

ipcMain.handle('xfw:toggle-mixer-xview', async (_e, tabId) => {
    try {
        const v = xViews.get(tabId);
        if (!v) return false;
        return await v.webContents.executeJavaScript(
            'typeof window.__xcToggleMixer === "function" ? window.__xcToggleMixer() : false'
        );
    } catch { return false; }
});

// IPC: open a chrome-extension:// page in a real BrowserWindow so it has
// the correct extension context (necessary for MetaMask popup / home page).
ipcMain.handle('xfw:open-extension-page', (_e, extUrl) => {
    try {
        const parsed = new URL(extUrl);
        if (parsed.protocol !== 'chrome-extension:') return;
        const win = new BrowserWindow({
            width: 400, height: 620,
            title: 'Extension',
            webPreferences: { sandbox: false, contextIsolation: true },
            parent: mainWindow,
            modal: false,
            autoHideMenuBar: true,
        });
        win.loadURL(extUrl);
    } catch (err) { console.warn('[XCaster] open-extension-page failed', err); }
});

// ── Chrome-extension management (MetaMask, etc.) ────────────────────────────
// Extensions live in <userData>/extensions/<id>/ as unpacked folders. They are
// auto-loaded into defaultSession on app start so any webview can use them.

function extensionsRoot() {
    return path.join(app.getPath('userData'), 'extensions');
}

async function autoLoadExtensions() {
    const root = extensionsRoot();
    try { fs.mkdirSync(root, { recursive: true }); } catch { /* ignore */ }
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        // Walk into nested folders if manifest.json isn't at the top level
        // (zip layouts vary).
        const manifestPath = findManifest(dir);
        if (!manifestPath) continue;
        try {
            await session.defaultSession.loadExtension(path.dirname(manifestPath), { allowFileAccess: true });
            console.log('[XCaster] loaded extension', entry.name);
        } catch (err) {
            console.warn('[XCaster] loadExtension failed for', entry.name, err);
        }
    }
}

function findManifest(dir, depth = 0) {
    if (depth > 3) return null;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.isFile() && e.name === 'manifest.json') return path.join(dir, e.name);
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                const found = findManifest(path.join(dir, e.name), depth + 1);
                if (found) return found;
            }
        }
    } catch { /* ignore */ }
    return null;
}

function httpsGetJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'XCaster' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(httpsGetJSON(res.headers.location));
            }
            if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

function httpsDownload(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const req = https.get(url, { headers: { 'User-Agent': 'XCaster' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close(); fs.unlinkSync(destPath);
                return resolve(httpsDownload(res.headers.location, destPath));
            }
            if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve(destPath)));
        });
        req.on('error', err => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
    });
}

function unzip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(destDir, { recursive: true });
        // Use PowerShell's Expand-Archive — built into Windows, no extra deps.
        execFile('powershell.exe',
            ['-NoProfile', '-Command', `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`],
            (err) => err ? reject(err) : resolve(destDir)
        );
    });
}

// ── Virtual cable auto-installer ────────────────────────────────────────────
// VB-Audio Virtual Cable gives XCaster a dedicated CABLE Input / CABLE Output
// pair so the X Spaces injection output is fully isolated from desktop audio,
// preventing the feedback loop that occurs when both share the same cable.

const CABLE_SKIP_FLAG = path.join(app.getPath('userData'), 'skip-cable-check.flag');

function checkCableInstalled() {
    return new Promise((resolve) => {
        execFile('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            'try { (Get-WmiObject Win32_SoundDevice).Name | Where-Object { $_ -match "CABLE" } | ConvertTo-Json } catch { "[]" }'
        ], { timeout: 8000 }, (err, stdout) => {
            if (err) { resolve(false); return; }
            try {
                const raw = (stdout || '').trim();
                if (!raw || raw === 'null') { resolve(false); return; }
                const items = [].concat(JSON.parse(raw));
                resolve(items.some(n => typeof n === 'string' && /cable/i.test(n)));
            } catch { resolve(false); }
        });
    });
}

async function downloadAndInstallCable() {
    const tmpDir = path.join(os.tmpdir(), 'xcaster-vbcable');
    fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, 'VBCABLE_Driver_Pack.zip');

    await httpsDownload(
        'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip',
        zipPath
    );
    await unzip(zipPath, tmpDir);
    try { fs.unlinkSync(zipPath); } catch {}

    // Prefer the 64-bit setup, fall back to 32-bit.
    let setupExe = path.join(tmpDir, 'VBCABLE_Setup_x64.exe');
    if (!fs.existsSync(setupExe)) setupExe = path.join(tmpDir, 'VBCABLE_Setup.exe');
    if (!fs.existsSync(setupExe)) {
        throw new Error('VB-Audio CABLE setup executable not found after extraction.');
    }

    // Run with UAC elevation — user will see the Windows security prompt.
    await new Promise((resolve, reject) => {
        execFile('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Start-Process -FilePath "${setupExe}" -Verb RunAs -Wait`
        ], { timeout: 120000 }, (err) => err ? reject(err) : resolve());
    });

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

async function checkAndInstallVirtualCable() {
    if (fs.existsSync(CABLE_SKIP_FLAG)) return; // user dismissed, don't nag again

    const hasCable = await checkCableInstalled();
    if (hasCable) return;

    const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'XCaster Virtual Cable',
        message: 'Install a dedicated virtual audio cable?',
        detail:
            'No virtual audio cable was detected on this system.\n\n' +
            'Without one, using the same cable for your desktop audio and X Spaces ' +
            'injection causes feedback — X picks up your desktop audio as your mic.\n\n' +
            'Clicking Install will download VB-Audio Virtual Cable (free) and launch ' +
            'the installer. A Windows security (UAC) prompt will appear — click Yes ' +
            'to allow the driver to install.',
        buttons: ['Install', 'Not Now'],
        defaultId: 0,
        cancelId: 1,
    });

    if (response === 1) {
        try { fs.writeFileSync(CABLE_SKIP_FLAG, ''); } catch {}
        return;
    }

    try {
        await downloadAndInstallCable();
        await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Virtual Cable Installed',
            message: 'VB-Audio Virtual Cable installed successfully!',
            detail:
                'In the XCaster Speakers tab:\n' +
                '  • "X Spaces Injection Output" → CABLE Input (VB-Audio Virtual Cable)\n' +
                '  • "Monitor & Cue Output" → your headset\n\n' +
                'In X Spaces settings, select "CABLE Output" as your microphone.\n' +
                'Your desktop audio should go directly to your headset — not through the cable.',
            buttons: ['OK'],
        });
        // Remove any existing skip flag now that cable is installed.
        try { fs.unlinkSync(CABLE_SKIP_FLAG); } catch {}
    } catch (err) {
        console.warn('[XCaster] cable install failed', err);
        await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Installation Failed',
            message: 'Could not install the virtual cable automatically.',
            detail:
                `Error: ${err.message}\n\n` +
                'Please download VB-Audio Virtual Cable manually from vb-audio.com, ' +
                'install it, then restart XCaster.\n\n' +
                'Once installed, set "X Spaces Injection Output" in the Speakers tab ' +
                'to "CABLE Input (VB-Audio Virtual Cable)".',
            buttons: ['OK'],
        });
    }
}

// IPC: install MetaMask from its official GitHub release.
ipcMain.handle('xfw:install-metamask', async () => {
    const releaseAPI = 'https://api.github.com/repos/MetaMask/metamask-extension/releases/latest';
    const release = await httpsGetJSON(releaseAPI);
    const asset = (release.assets || []).find(a => /^metamask-chrome-.*\.zip$/.test(a.name));
    if (!asset) throw new Error('No metamask-chrome zip found in latest release');

    const root = extensionsRoot();
    fs.mkdirSync(root, { recursive: true });
    const target = path.join(root, 'metamask');
    // Wipe any previous install
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
    const zipPath = path.join(root, asset.name);
    await httpsDownload(asset.browser_download_url, zipPath);
    await unzip(zipPath, target);
    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

    const manifest = findManifest(target);
    if (!manifest) throw new Error('manifest.json not found after unzip');
    const ext = await session.defaultSession.loadExtension(path.dirname(manifest), { allowFileAccess: true });
    return { name: ext.name, version: ext.version };
});

// IPC: list currently loaded extensions.
ipcMain.handle('xfw:list-extensions', () => {
    return session.defaultSession.getAllExtensions().map(e => {
        const m = e.manifest || {};
        const popup = (m.action && m.action.default_popup)
            || (m.browser_action && m.browser_action.default_popup)
            || m.default_popup
            || null;
        const popupUrl = popup ? `chrome-extension://${e.id}/${popup}` : null;
        // For extensions without a popup (or as a richer alternative), fall back
        // to the options page or home.html (MetaMask uses this).
        const homeRel = m.options_ui?.page || m.options_page || 'home.html';
        const homeUrl = homeRel ? `chrome-extension://${e.id}/${homeRel}` : null;
        let icon = null;
        if (m.icons) {
            const sizes = Object.keys(m.icons).map(Number).sort((a, b) => a - b);
            const pick = sizes.find(s => s >= 32) ?? sizes[sizes.length - 1];
            if (pick) icon = `chrome-extension://${e.id}/${m.icons[pick]}`;
        }
        return { id: e.id, name: e.name, version: e.version, popupUrl, homeUrl, icon };
    });
});
