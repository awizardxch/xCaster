// XCaster preload.
// Injects overlay.css + overlay.js into the page's MAIN world. CSS is added
// via a <style> tag (allowed by 'unsafe-inline' style-src in most cases, and
// the main process also strips CSP headers as a guarantee). JS is injected
// using webFrame.executeJavaScript which is NOT subject to the page CSP, so
// the gear button + audio graph always appear even if the host site is strict.

const { webFrame } = require('electron');
const fs = require('fs');
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
        // This runs at document_start, where BOTH document.head and
        // document.documentElement can still be null - which threw
        // "Cannot read properties of null (reading 'appendChild')" on every
        // page load. The later DOMContentLoaded/load calls re-run this, so
        // simply bail out and let one of those land it.
        const mount = document.head || document.documentElement;
        if (!mount) return;
        if (cssText && !document.getElementById('xfw-style')) {
            const style = document.createElement('style');
            style.id = 'xfw-style';
            style.textContent = cssText;
            mount.appendChild(style);
        }
    } catch (err) { console.warn('[XCaster] style inject failed', err); }
}

async function injectScript() {
    if (injected || !jsText) return;
    try {
        // executeJavaScript runs in the main world and bypasses page CSP.
        await webFrame.executeJavaScript(jsText, false);
        injected = true;
        console.info('[XCaster] overlay injected');
    } catch (err) {
        console.warn('[XCaster] executeJavaScript failed, falling back to <script> tag', err);
        try {
            const script = document.createElement('script');
            script.textContent = jsText;
            (document.head || document.documentElement).appendChild(script);
            injected = true;
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
