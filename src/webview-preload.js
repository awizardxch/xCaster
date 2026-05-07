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

'use strict';

const { webFrame } = require('electron');
const fs   = require('fs');
const path = require('path');

// NOTE: Shell ↔ overlay IPC is handled entirely by wv.executeJavaScript in
// shell.js. No bridge code is needed in the preload.

const cssText = (() => {
    try { return fs.readFileSync(path.join(__dirname, 'overlay.css'), 'utf8'); } catch { return ''; }
})();
const jsText = (() => {
    try { return fs.readFileSync(path.join(__dirname, 'overlay.js'), 'utf8'); } catch { return ''; }
})();

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
    if (!jsText) return;
    try {
        // Mark this as a webview context so overlay.js knows not to auto-start
        // xCaster capture (that only happens in the shell window).
        await webFrame.executeJavaScript('window.__xfwIsWebview = true;', false);
        await webFrame.executeJavaScript(jsText, false);
        console.info('[XCaster] overlay inject requested');
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

