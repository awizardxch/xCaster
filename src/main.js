// XCaster main process
// Standalone Chromium shell for x.com with WebRTC audio processing disabled.
// Gives streamers full control over launch flags and getUserMedia constraints,
// plus a full DSP/mixer overlay for professional X Spaces audio.

const { app, BrowserWindow, session, Menu, shell, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

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
        'WebRtcAllowInputVolumeAdjustment',
        'WebRtcAnalogAgcClippingControl',
        'WebRtcHybridAgc',
        'ChromeWideEchoCancellation',
        'WebRtcApmInAudioService',
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
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            // sandbox:false so the preload can read overlay.css/overlay.js from disk.
            // contextIsolation still keeps the page from touching Node APIs.
            sandbox: false,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
    });

    // Auto-grant microphone permission only for x.com / twitter.com.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const url = details?.requestingUrl ?? webContents.getURL();
        const allowedHosts = ['x.com', 'twitter.com', 'pbs.twimg.com', 'video.twimg.com'];
        const host = (() => {
            try { return new URL(url).hostname; } catch { return ''; }
        })();
        const isAllowedHost = allowedHosts.some(h => host === h || host.endsWith('.' + h));

        if (permission === 'media' && isAllowedHost) {
            callback(true);
            return;
        }
        if (permission === 'notifications' && isAllowedHost) {
            callback(true);
            return;
        }
        callback(false);
    });

    // Use a recent desktop Chrome UA so X serves the desktop experience cleanly.
    mainWindow.webContents.setUserAgent(
        mainWindow.webContents.getUserAgent().replace(/Electron\/[^\s]+\s?/, '')
    );

    // Open external links (non-x.com) in the user's default browser.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const host = new URL(url).hostname;
            if (host.endsWith('x.com') || host.endsWith('twitter.com')) {
                return { action: 'allow' };
            }
        } catch { /* ignore */ }
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.loadURL('https://x.com/');

    // Minimal menu: File / View / Help. Hidden by default (autoHideMenuBar).
    const template = [
        {
            label: 'File',
            submenu: [
                { label: 'Reload X', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
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
                            message: 'XCaster',
                            detail:
                                'Standalone Windows shell for x.com with WebRTC AGC, noise suppression, and echo cancellation disabled.\n\n' +
                                'Includes a 2-channel DSP mixer (mic + aux), compressor, limiter, EQ, speaker routing, background skin, and live meters. Built for X Spaces streamers who need clean, professional audio.',
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

    createWindow();
});

app.on('window-all-closed', () => {
    app.quit();
});

// Diagnostic IPC: preload can ping us to confirm the patch ran.
ipcMain.on('xfw:gum-patched', (_e, info) => {
    // eslint-disable-next-line no-console
    console.log('[XCaster] getUserMedia patched on', info?.url);
});
