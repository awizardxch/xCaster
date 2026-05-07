// XCaster webview preload.
// Runs inside every <webview> in the shell. Injects the DSP overlay (overlay.css
// + overlay.js) on EVERY page so the gear / mixer panel is always accessible.
//
// Uses webFrame.executeJavaScript which is NOT subject to the page CSP, so
// the gear button + audio graph always appear even on strict-CSP hosts.
//
// The WebRTC interception inside overlay.js only matters on x.com (it patches
// getUserMedia so X Spaces receives the processed stream). On all other pages
// the patch is present but harmlessly falls back to the real getUserMedia.
//
// NOTE: Patching navigator.mediaDevices in the preload's isolated world has
// NO effect on x.com — page scripts live in the main world. The only way to
// intercept getUserMedia is via webFrame.executeJavaScript (main world), which
// is what overlay.js does when injected below. This matches exactly how v0.5.0
// worked.

'use strict';

const { webFrame, ipcRenderer } = require('electron');
const fs   = require('fs');
const path = require('path');

const cssText = (() => {
    try { return fs.readFileSync(path.join(__dirname, 'overlay.css'), 'utf8'); } catch { return ''; }
})();
const jsText = (() => {
    try { return fs.readFileSync(path.join(__dirname, 'overlay.js'), 'utf8'); } catch { return ''; }
})();

let injected = false;

function injectStyle() {
    try {
        if (cssText && !document.getElementById('xfw-style')) {
            const style = document.createElement('style');
            style.id = 'xfw-style';
            style.textContent = cssText;
            (document.head || document.documentElement).appendChild(style);
        }
    } catch (err) { console.warn('[XCaster] style inject failed', err); }
}

async function injectScript() {
    if (injected || !jsText) return;
    try {
        // Inject overlay.js into the page's main world — identical to v0.5.0.
        // getUserMedia is patched synchronously before x.com scripts run.
        await webFrame.executeJavaScript(jsText, false);
        injected = true;
        console.info('[XCaster] overlay injected');
    } catch (err) {
        console.warn('[XCaster] executeJavaScript failed, falling back to <script> tag', err);
        try {
            const script = document.createElement('script');
            script.textContent = jsText;
            (document.head || document.documentElement).appendChild(script);
        } catch (e) {
            console.warn('[XCaster] <script> fallback also failed', e);
        }
    }
}

function inject() {
    injectStyle();
    injectScript();
}

inject();
document.addEventListener('DOMContentLoaded', inject, { once: true });
window.addEventListener('load', inject, { once: true });
