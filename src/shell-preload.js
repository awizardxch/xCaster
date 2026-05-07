// XCaster shell preload
// Exposes a minimal safe API to the browser-shell renderer via contextBridge.
// The renderer (shell.js) has NO direct Node.js access; everything goes through here.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function readText(fileName) {
    try { return fs.readFileSync(path.join(__dirname, fileName), 'utf8'); } catch { return ''; }
}

contextBridge.exposeInMainWorld('xcaster', {
    // Absolute file:// URL to the webview preload script.
    webviewPreloadURL: pathToFileURL(path.join(__dirname, 'webview-preload.js')).toString(),

    // Fallback sources used by the shell gear if the webview preload hasn't
    // installed the mixer yet for the current page/document.
    overlayCSS: readText('overlay.css'),
    overlayJS: readText('overlay.js'),

    // Open a URL in the system default browser (outside the app).
    openExternal: (url) => ipcRenderer.invoke('xfw:open-external', url),

    // Chrome-extension management
    installMetaMask: () => ipcRenderer.invoke('xfw:install-metamask'),
    listExtensions:  () => ipcRenderer.invoke('xfw:list-extensions'),

    // Open a chrome-extension:// page in a new BrowserWindow (correct context).
    openExtensionPage: (url) => ipcRenderer.invoke('xfw:open-extension-page', url),

    // ── BrowserView management for x.com tabs (v0.5.0 audio path) ──────────
    setToolbarHeight:    (h)       => ipcRenderer.invoke('xfw:set-toolbar-height', h),
    createXView:         (id, url) => ipcRenderer.invoke('xfw:create-xview', id, url),
    showXView:           (id)      => ipcRenderer.invoke('xfw:show-xview', id),
    hideXView:           (id)      => ipcRenderer.invoke('xfw:hide-xview', id),
    destroyXView:        (id)      => ipcRenderer.invoke('xfw:destroy-xview', id),
    navigateXView:       (id, url) => ipcRenderer.invoke('xfw:navigate-xview', id, url),
    backXView:           (id)      => ipcRenderer.invoke('xfw:back-xview', id),
    forwardXView:        (id)      => ipcRenderer.invoke('xfw:forward-xview', id),
    reloadXView:         (id)      => ipcRenderer.invoke('xfw:reload-xview', id),
    canGoBackXView:      (id)      => ipcRenderer.invoke('xfw:cangoback-xview', id),
    canGoForwardXView:   (id)      => ipcRenderer.invoke('xfw:cangoforward-xview', id),
    devtoolsXView:       (id)      => ipcRenderer.invoke('xfw:devtools-xview', id),
    toggleMixerXView:    (id)      => ipcRenderer.invoke('xfw:toggle-mixer-xview', id),
    onXViewEvent: (cb) => ipcRenderer.on('xfw:xview-event', (_e, id, type, data) => cb(id, type, data)),
});
