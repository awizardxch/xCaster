// XCaster Browser Shell
// Manages tabs, navigation, bookmarks, and the home page.
// Runs as the renderer for shell.html (contextIsolation=true, no Node.js access).
// All Node/Electron calls go via window.xcaster (exposed by shell-preload.js).

'use strict';

(function () {

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_BOOKMARKS = [
    { id: 'x',       name: 'X',          url: 'https://x.com/',           color: '#111111', letter: 'X' },
    { id: 'wizard',  name: 'aWizard',    url: 'https://mintgarden.io/aWizard', color: '#16a34a', letter: 'A' },
    { id: 'youtube', name: 'YouTube',    url: 'https://www.youtube.com',  color: '#dc2626', letter: 'Y' },
    { id: 'warp',    name: 'Warp',        url: 'https://warp.awizard.dev', color: '#6366f1', letter: 'W' },
    { id: 'caster',  name: 'Caster101',   url: 'https://caster101.xyz',    color: '#d97706', letter: 'C' },
    { id: 'xch',     name: 'XCH Trade',   url: 'https://xch.trade',        color: '#059669', letter: 'T' },
    { id: 'cast',    name: 'Cast',        url: 'https://cast.awizard.dev', color: '#7c3aed', letter: 'A' },
    { id: 'tibet',   name: 'TibetSwap',   url: 'https://v2.tibetswap.io/\u2728\u2764\uFE0F\u200D\uD83D\uDD25\uD83E\uDDD9\u200D\u2642\uFE0F', color: '#0ea5e9', letter: 'T' },
];

const BM_STORAGE_KEY   = 'xcaster_bookmarks_v1';
const TILE_COLORS      = ['#2563eb','#6366f1','#d97706','#059669','#7c3aed','#dc2626','#0891b2','#65a30d'];
const WEBVIEW_PRELOAD  = window.xcaster?.webviewPreloadURL ?? null;
const OVERLAY_CSS      = window.xcaster?.overlayCSS ?? '';
const OVERLAY_JS       = window.xcaster?.overlayJS ?? '';

// ── State ────────────────────────────────────────────────────────────────────

let tabs        = [];   // { id, title, url, favicon, loading, wv, showingHome }
let activeTabId = null;
let nextTabId   = 1;
let bookmarks   = loadBookmarks();
let modalOpen   = false;

// ── DOM ──────────────────────────────────────────────────────────────────────

const tabsList      = document.getElementById('tabs-list');
const browser       = document.getElementById('browser');
const btnNewTab     = document.getElementById('btn-new-tab');
const btnBack       = document.getElementById('btn-back');
const btnForward    = document.getElementById('btn-forward');
const btnReload     = document.getElementById('btn-reload');
const btnHome       = document.getElementById('btn-home');
const btnBookmark   = document.getElementById('btn-bookmark');
const addressInput  = document.getElementById('address-input');
const securityIcon  = document.getElementById('security-icon');
const progressFill  = document.getElementById('progress-fill');
const homeView      = document.getElementById('home-view');
const webviewsDiv   = document.getElementById('webviews');
const modal         = document.getElementById('add-bookmark-modal');
const bmNameInput   = document.getElementById('bm-name-input');
const bmUrlInput    = document.getElementById('bm-url-input');

// ── Bookmark persistence ─────────────────────────────────────────────────────

function loadBookmarks() {
    try {
        const raw = localStorage.getItem(BM_STORAGE_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            const seen = new Set(saved.map(b => b.id || b.url));
            const missingDefaults = DEFAULT_BOOKMARKS.filter(b => !seen.has(b.id) && !seen.has(b.url));
            return saved.concat(missingDefaults.map(b => ({ ...b })));
        }
    } catch { /* ignore */ }
    return DEFAULT_BOOKMARKS.map(b => ({ ...b }));
}

function saveBookmarks() {
    try { localStorage.setItem(BM_STORAGE_KEY, JSON.stringify(bookmarks)); } catch { /* ignore */ }
}

// ── URL helpers ──────────────────────────────────────────────────────────────

function normalizeURL(raw) {
    const s = (raw || '').trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (/^localhost(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
    // Looks like a hostname/path (has a dot, no spaces)
    if (/^[\w-]+\.[\w.-]+(\/|$)/.test(s) && !s.includes(' ')) return 'https://' + s;
    // Otherwise: search on DuckDuckGo.
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}

function displayURL(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        let display = u.host + u.pathname;
        if (display.endsWith('/') && u.pathname === '/') display = u.host;
        if (u.search) display += u.search;
        if (u.hash)   display += u.hash;
        return display;
    } catch { return url; }
}

function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ── Tab helpers ───────────────────────────────────────────────────────────────

function getTab(id)    { return tabs.find(t => t.id === id) ?? null; }
function activeTab()   { return getTab(activeTabId); }

function setHomeVisible(visible) {
    homeView.classList.toggle('visible', visible);
    homeView.hidden = !visible;
    homeView.style.display = visible ? 'block' : 'none';
    homeView.style.visibility = visible ? 'visible' : 'hidden';
    homeView.style.pointerEvents = visible ? 'auto' : 'none';
    browser?.classList.toggle('site-active', !visible);
}

function showWebview(tab) {
    setHomeVisible(false);
    document.querySelectorAll('#webviews webview').forEach(wv => wv.classList.remove('active'));
    if (tab?.wv) tab.wv.classList.add('active');
}

// ── Tab: create ───────────────────────────────────────────────────────────────

function createTab(url = null) {
    const id = nextTabId++;
    const tab = {
        id,
        title:       url ? 'Loading…' : 'New Tab',
        url:         url ?? '',
        favicon:     null,
        loading:     false,
        wv:          null,
        showingHome: !url,
    };
    tabs.push(tab);
    renderTabBar();
    activateTab(id);
    if (url) navigateTab(tab, url);
    return tab;
}

// ── Tab: close ────────────────────────────────────────────────────────────────

function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const tab = tabs[idx];
    if (tab.wv) { try { tab.wv.remove(); } catch { /* ignore */ } }
    tabs.splice(idx, 1);
    if (tabs.length === 0) { createTab(); return; }
    if (activeTabId === id) {
        activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
    }
    renderTabBar();
    updateAllTabsForCapture();
}

// Push all loaded tab wcIds to the overlay so it can capture every tab.
function updateAllTabsForCapture() {
    const ids = tabs
        .filter(t => t.wv && typeof t.webContentsId === 'number')
        .map(t => t.webContentsId);
    window.__xcAllTabWcIds = ids;
    // If the shell overlay is installed, tell it about new tabs immediately.
    if (typeof window.__xcTabsUpdated === 'function') {
        window.__xcTabsUpdated(ids);
    }
}

// ── Tab: activate ─────────────────────────────────────────────────────────────

function activateTab(id) {
    activeTabId = id;
    const tab = getTab(id);

    // Expose active webview's webContentsId for main.js display-media handler.
    if (tab?.wv && typeof tab.webContentsId === 'number') {
        window.__xcActiveWcId = tab.webContentsId;
    } else {
        window.__xcActiveWcId = null;
    }

    document.querySelectorAll('#webviews webview').forEach(wv => wv.classList.remove('active'));

    if (!tab || tab.showingHome || !tab.wv) {
        setHomeVisible(true);
    } else {
        showWebview(tab);
    }

    syncAddressBar(tab);
    syncNavButtons(tab);
    renderTabBar();
}

// ── Tab: navigate ─────────────────────────────────────────────────────────────

function navigateTab(tab, url) {
    tab.url         = url;
    tab.showingHome = false;
    tab.title       = 'Loading…';
    tab.loading     = true;
    tab.favicon     = null;

    if (!tab.wv) {
        const wv = buildWebview(url);
        webviewsDiv.appendChild(wv);
        tab.wv = wv;
        attachWebviewListeners(tab, wv);
    } else {
        tab.wv.setAttribute('src', url);
    }

    showWebview(tab);
    activeTabId = tab.id;  // make sure ID is current

    syncAddressBar(tab);
    syncNavButtons(tab);
    renderTabBar();
    startProgress();
}

// ── Webview factory ───────────────────────────────────────────────────────────

function buildWebview(url) {
    const wv = document.createElement('webview');
    wv.setAttribute('allowpopups', '');
    // Inject DSP overlay into every webview.
    if (WEBVIEW_PRELOAD) wv.setAttribute('preload', WEBVIEW_PRELOAD);
    wv.setAttribute('src', url);
    // Mute ALL webview audio from the system output immediately.
    // Tab audio is routed exclusively through the xCaster mixer channel,
    // so it never reaches PC default output, virtual cable, or Aux1.
    try { wv.setAudioMuted(true); } catch {}
    // Apply current opacity setting. DO NOT inject background:transparent CSS
    // into pages — that destroys site styling. The webview opacity alone creates
    // the see-through effect (page contents fade, video bg shows through).
    try {
        const op = (shellSettings && (shellSettings.pageOpacity / 100)) || 1;
        wv.style.opacity = op.toFixed(2);
    } catch { /* shellSettings not initialized yet */ }
    return wv;
}

// ── Webview event listeners ───────────────────────────────────────────────────

function attachWebviewListeners(tab, wv) {
    wv.addEventListener('did-start-loading', () => {
        tab.loading = true;
        if (activeTabId === tab.id) { startProgress(); syncNavButtons(tab); }
        renderTabBar();
    });

    wv.addEventListener('dom-ready', () => {
        try {
            tab.webContentsId = wv.getWebContentsId();
            // Re-assert mute in case it wasn't applied before first load.
            try { wv.setAudioMuted(true); } catch {}
            if (activeTabId === tab.id) window.__xcActiveWcId = tab.webContentsId;
            // Notify overlay to capture this tab into the xCaster channel.
            updateAllTabsForCapture();
        } catch { /* ignore */ }
    });

    wv.addEventListener('did-stop-loading', () => {
        tab.loading = false;
        if (activeTabId === tab.id) { stopProgress(); syncNavButtons(tab); syncAddressBar(tab); }
        renderTabBar();
    });

    wv.addEventListener('did-navigate', (e) => {
        tab.url = e.url;
        if (activeTabId === tab.id) syncAddressBar(tab);
    });

    wv.addEventListener('did-navigate-in-page', (e) => {
        if (e.isMainFrame) {
            tab.url = e.url;
            if (activeTabId === tab.id) syncAddressBar(tab);
        }
    });

    wv.addEventListener('page-title-updated', (e) => {
        tab.title = e.title || domainOf(tab.url) || 'Untitled';
        renderTabBar();
    });

    wv.addEventListener('page-favicon-updated', (e) => {
        if (e.favicons && e.favicons.length > 0) {
            tab.favicon = e.favicons[0];
            renderTabBar();
        }
    });

    wv.addEventListener('new-window', (e) => {
        // Trap all new-window / target=_blank → open as a new tab
        createTab(e.url);
    });

    wv.addEventListener('close', () => closeTab(tab.id));

    wv.addEventListener('did-fail-load', (e) => {
        // Ignore aborted loads (e.g. user clicked stop)
        if (e.errorCode === -3) return;
        tab.title = 'Error';
        tab.loading = false;
        if (activeTabId === tab.id) { stopProgress(); renderTabBar(); }
    });
}

// ── Overlay bridge (xCaster tab selection + audio isolation) ────────────────

// ── Overlay bridge (audio mute for xCaster capture) ──────────────────────
// overlay.js pushes { type, tabId? } to window.__xfwOutbox[].
// We drain it every 200ms via wv.executeJavaScript.
const _DRAIN = '(function(){var q=window.__xfwOutbox;if(!q||!q.length)return null;window.__xfwOutbox=[];return q})();';
setInterval(() => {
    for (const t of tabs) {
        if (!t.wv) continue;
        ((tab, wv) => {
            wv.executeJavaScript(_DRAIN).then(msgs => {
                if (!msgs || !Array.isArray(msgs)) return;
                for (const msg of msgs) {
                    if (!msg || typeof msg.type !== 'string') continue;
                    const safe = { type: msg.type };
                    if (typeof msg.tabId === 'number') safe.tabId = msg.tabId;
                    _handleMuteMsg(safe);
                }
            }).catch(() => {});
        })(t, t.wv);
    }
}, 200);

function _handleMuteMsg(msg) {
    if (msg.type === 'set-capture-target') {
        window.__xcPendingCapture = msg.tabId;
        for (const t of tabs) {
            if (!t.wv) continue;
            const id = _resolveWcId(t);
            if (id == null) continue;
            try { t.wv.setAudioMuted(id === msg.tabId); } catch {}
        }
    } else if (msg.type === 'clear-capture') {
        window.__xcPendingCapture = null;
        for (const t of tabs) {
            if (!t.wv) continue;
            try { t.wv.setAudioMuted(false); } catch {}
        }
    }
}

// ── Progress bar ──────────────────────────────────────────────────────────────

let progressTimer = null;

function startProgress() {
    progressFill.style.transition = 'none';
    progressFill.style.opacity    = '1';
    progressFill.style.width      = '0%';
    clearTimeout(progressTimer);
    requestAnimationFrame(() => {
        progressFill.style.transition = 'width 2.5s cubic-bezier(0.1,0.6,0.3,1)';
        progressFill.style.width      = '72%';
    });
}

function stopProgress() {
    clearTimeout(progressTimer);
    progressFill.style.transition = 'width 0.15s ease';
    progressFill.style.width      = '100%';
    progressTimer = setTimeout(() => {
        progressFill.style.transition = 'opacity 0.3s';
        progressFill.style.opacity    = '0';
        progressTimer = setTimeout(() => {
            progressFill.style.transition = 'none';
            progressFill.style.width      = '0%';
        }, 320);
    }, 160);
}

// ── Address bar sync ──────────────────────────────────────────────────────────

function syncAddressBar(tab) {
    if (!tab || tab.showingHome || !tab.wv) {
        addressInput.value  = '';
        securityIcon.textContent = '';
        return;
    }
    try {
        const u = new URL(tab.url);
        securityIcon.textContent = u.protocol === 'https:' ? '🔒' : '⚠';
    } catch {
        securityIcon.textContent = '';
    }
    if (document.activeElement !== addressInput) {
        addressInput.value = displayURL(tab.url);
    }
}

function syncNavButtons(tab) {
    if (!tab || !tab.wv) {
        btnBack.disabled    = true;
        btnForward.disabled = true;
        btnReload.innerHTML = '&#8635;';
        return;
    }
    try { btnBack.disabled    = !tab.wv.canGoBack();    } catch { btnBack.disabled = false; }
    try { btnForward.disabled = !tab.wv.canGoForward(); } catch { btnForward.disabled = false; }
    btnReload.innerHTML = tab.loading ? '&#10005;' : '&#8635;';
    btnReload.title     = tab.loading ? 'Stop'    : 'Reload (Ctrl+R)';
}

// ── Tab bar rendering ─────────────────────────────────────────────────────────

function renderTabBar() {
    tabsList.innerHTML = '';
    for (const tab of tabs) {
        const el = document.createElement('div');
        el.className    = 'tab' + (tab.id === activeTabId ? ' active' : '');
        el.dataset.tabId = tab.id;

        // Favicon / spinner
        const fav = document.createElement('div');
        fav.className = 'tab-favicon';
        if (tab.loading) {
            fav.innerHTML = '<div class="tab-spinner"></div>';
        } else if (tab.favicon) {
            const img = document.createElement('img');
            img.src = tab.favicon;
            img.onerror = () => { fav.innerHTML = tab.showingHome ? '&#9962;' : '&#127760;'; };
            fav.appendChild(img);
        } else {
            fav.innerHTML = tab.showingHome ? '&#9962;' : '&#127760;';
        }

        // Title
        const title = document.createElement('span');
        title.className   = 'tab-title';
        title.textContent = tab.title || tab.url || 'New Tab';

        // Close
        const close = document.createElement('button');
        close.className = 'tab-close';
        close.innerHTML = '&times;';
        close.title     = 'Close tab';
        close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });

        el.appendChild(fav);
        el.appendChild(title);
        el.appendChild(close);
        el.addEventListener('click', () => activateTab(tab.id));
        tabsList.appendChild(el);
    }
}

// ── Home page ─────────────────────────────────────────────────────────────────

function renderHomePage() {
    homeView.innerHTML = `
        <div id="home-page">
            <header id="home-header">
                <div id="home-logo">X<span class="logo-accent">Caster</span></div>
                <p id="home-tagline">Your dedicated streaming browser</p>
            </header>
            <section id="bookmarks-section">
                <div class="section-header">
                    <span class="section-title">Bookmarks</span>
                    <button class="section-action" id="btn-add-bookmark">+ Add bookmark</button>
                </div>
                <div id="bookmarks-grid"></div>
            </section>
        </div>
    `;
    renderBookmarks();
    document.getElementById('btn-add-bookmark').addEventListener('click', () => openModal());
}

function renderBookmarks() {
    const grid = document.getElementById('bookmarks-grid');
    if (!grid) return;
    grid.innerHTML = '';
    for (const bm of bookmarks) {
        const tile = document.createElement('div');
        tile.className = 'bookmark-tile';
        tile.innerHTML = `
            <div class="bookmark-icon" style="background:${esc(bm.color || '#2563eb')}">${esc(bm.letter || bm.name[0])}</div>
            <div class="bookmark-name">${esc(bm.name)}</div>
            <div class="bookmark-domain">${esc(domainOf(bm.url))}</div>
            <button class="bookmark-remove" title="Remove bookmark" data-bm-id="${esc(bm.id)}">&times;</button>
        `;
        tile.addEventListener('click', (e) => {
            if (e.target.classList.contains('bookmark-remove')) return;
            openBookmarkURL(bm.url);
        });
        tile.querySelector('.bookmark-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            removeBookmark(bm.id);
        });
        grid.appendChild(tile);
    }
}

function openBookmarkURL(url) {
    const tab = activeTab();
    if (tab && tab.showingHome) {
        navigateTab(tab, url);   // reuse the home tab
    } else {
        createTab(url);          // open in a new tab
    }
}

function removeBookmark(id) {
    bookmarks = bookmarks.filter(b => b.id !== id);
    saveBookmarks();
    renderBookmarks();
}

// ── Add-bookmark modal ────────────────────────────────────────────────────────

function openModal(prefillURL = '', prefillName = '') {
    bmNameInput.value = prefillName;
    bmUrlInput.value  = prefillURL;
    modal.classList.add('open');
    modalOpen = true;
    (prefillName ? bmUrlInput : bmNameInput).focus();
}

function closeModal() {
    modal.classList.remove('open');
    modalOpen = false;
}

function commitBookmark() {
    const name   = bmNameInput.value.trim();
    const rawUrl = bmUrlInput.value.trim();
    if (!name || !rawUrl) return;
    const url   = normalizeURL(rawUrl) || rawUrl;
    const color = TILE_COLORS[bookmarks.length % TILE_COLORS.length];
    bookmarks.push({ id: 'bm_' + Date.now(), name, url, color, letter: name[0].toUpperCase() });
    saveBookmarks();
    closeModal();
    renderBookmarks();
}

document.getElementById('bm-cancel').addEventListener('click', closeModal);
document.getElementById('bm-save').addEventListener('click', commitBookmark);
bmUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  commitBookmark();
    if (e.key === 'Escape') closeModal();
});
bmNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
});
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

// ── Nav bar buttons ───────────────────────────────────────────────────────────

btnNewTab.addEventListener('click', () => createTab());

// ── Appearance dropdown + mixer button ──────────────────────────────────────
const btnMixer        = document.getElementById('btn-mixer');
const btnAppearance   = document.getElementById('btn-appearance');
const settingsDD      = document.getElementById('settings-dropdown');
const sdBgToggle      = document.getElementById('sd-bg-toggle');
const sdPageOpacity   = document.getElementById('sd-page-opacity');
const sdPageOpacityV  = document.getElementById('sd-page-opacity-val');
const sdBgDim         = document.getElementById('sd-bg-dim');
const sdBgDimV        = document.getElementById('sd-bg-dim-val');
const bgVideo         = document.getElementById('bg-video');
const bgTint          = document.getElementById('bg-tint');

const SETTINGS_KEY = 'xfw_shell_settings_v1';
let shellSettings = (() => {
    try { return Object.assign({ bgEnabled: true, pageOpacity: 100, bgDim: 55 }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
    catch { return { bgEnabled: true, pageOpacity: 100, bgDim: 55 }; }
})();

function saveShellSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(shellSettings)); } catch { /* ignore */ }
}

function applyShellSettings() {
    if (bgVideo) {
        bgVideo.style.display = shellSettings.bgEnabled ? '' : 'none';
        if (shellSettings.bgEnabled) bgVideo.play?.().catch(() => {});
    }
    if (bgTint) {
        bgTint.style.background = `rgba(13, 13, 13, ${(shellSettings.bgDim / 100).toFixed(2)})`;
        bgTint.style.display = shellSettings.bgEnabled ? '' : 'none';
    }
    // Apply same opacity to all webviews AND home view so they look identical.
    const op = (shellSettings.pageOpacity / 100).toFixed(2);
    document.querySelectorAll('webview').forEach(wv => { wv.style.opacity = op; });
    if (homeView) homeView.style.opacity = op;
    if (sdPageOpacityV) sdPageOpacityV.textContent = shellSettings.pageOpacity + '%';
    if (sdBgDimV)       sdBgDimV.textContent       = shellSettings.bgDim + '%';
    if (sdPageOpacity)  sdPageOpacity.value        = shellSettings.pageOpacity;
    if (sdBgDim)        sdBgDim.value              = shellSettings.bgDim;
    if (sdBgToggle)     sdBgToggle.checked         = shellSettings.bgEnabled;
}

function positionDropdown(dd, anchor) {
    const r = anchor.getBoundingClientRect();
    dd.style.left = 'auto';
    dd.style.right = (window.innerWidth - r.right) + 'px';
    dd.style.top  = (r.bottom + 6) + 'px';
}

function closeDropdowns() {
    settingsDD?.classList.remove('open');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForWebviewReady(wv, timeoutMs = 8000) {
    if (!wv) return Promise.resolve(false);
    try { if (!wv.isLoading()) return Promise.resolve(true); } catch { /* keep waiting */ }
    return new Promise(resolve => {
        let settled = false;
        const done = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            wv.removeEventListener('dom-ready', onReady);
            wv.removeEventListener('did-stop-loading', onReady);
            wv.removeEventListener('did-fail-load', onFail);
            resolve(ok);
        };
        const onReady = () => done(true);
        const onFail = () => done(false);
        const timer = setTimeout(() => done(false), timeoutMs);
        wv.addEventListener('dom-ready', onReady, { once: true });
        wv.addEventListener('did-stop-loading', onReady, { once: true });
        wv.addEventListener('did-fail-load', onFail, { once: true });
    });
}

function mixerTargetTab() {
    let tab = activeTab();
    // Already on a real page - use it.
    if (tab?.wv && !tab.showingHome) return tab;
    // On the home view but webview exists - show it.
    if (tab?.wv) {
        tab.showingHome = false;
        showWebview(tab);
        syncAddressBar(tab);
        syncNavButtons(tab);
        renderTabBar();
        return tab;
    }
    // Fall back to any open site tab.
    const openSiteTab = tabs.find(t => t.wv && !t.showingHome);
    if (openSiteTab) { activateTab(openSiteTab.id); return openSiteTab; }
    // No webview at all - return null; gear click will be a no-op.
    return null;
}

async function ensureOverlayForWebview(wv) {
    if (!wv) return;
    if (OVERLAY_CSS) {
        const css = JSON.stringify(OVERLAY_CSS);
        await wv.executeJavaScript(`(() => {
            if (!document.getElementById('xfw-style')) {
                const style = document.createElement('style');
                style.id = 'xfw-style';
                style.textContent = ${css};
                (document.head || document.documentElement).appendChild(style);
            }
        })()`, true).catch(() => {});
    }
    if (OVERLAY_JS) {
        const installed = await wv.executeJavaScript('!!window.__xcInstalled', true).catch(() => false);
        if (!installed) await wv.executeJavaScript(OVERLAY_JS, true).catch(() => {});
    }
}

async function toggleMixerForTab(tab) {
    if (!tab?.wv) return false;
    await waitForWebviewReady(tab.wv);

    const script = `(() => {
        const toggle = window.__xcToggleMixer || window.__xcOpenMixer;
        if (typeof toggle === 'function') {
            const result = toggle();
            if (result && typeof result.then === 'function') return result.then(Boolean);
            return !!result;
        }
        const fab = document.getElementById('xfw-fab');
        if (!fab) return false;
        fab.click();
        return true;
    })()`;

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try {
            await ensureOverlayForWebview(tab.wv);
            const opened = await tab.wv.executeJavaScript(script, true);
            if (opened) return true;
        } catch { /* page may still be swapping documents */ }
        await sleep(150);
    }
    return false;
}

// Inject the overlay into the shell window itself so the mixer is always
// accessible regardless of whether any tabs are open.
function ensureShellOverlay() {
    if (window.__xcInstalled) return; // already running
    if (OVERLAY_CSS) {
        const style = document.createElement('style');
        style.id = 'xfw-style';
        // Hide the in-page FAB; the shell has its own gear button.
        style.textContent = OVERLAY_CSS + '\n#xfw-fab{display:none!important}';
        document.head.appendChild(style);
    }
    if (OVERLAY_JS) {
        const script = document.createElement('script');
        script.textContent = OVERLAY_JS;
        document.body.appendChild(script);
    }
}

// Gear button: open the mixer panel in the shell window (works even with no tabs).
if (btnMixer) {
    btnMixer.addEventListener('click', () => {
        ensureShellOverlay();
        if (typeof window.__xcToggleMixer === 'function') {
            window.__xcToggleMixer();
        }
    });
}

// Appearance button: bg video + opacity dropdown.
if (btnAppearance && settingsDD) {
    btnAppearance.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = !settingsDD.classList.contains('open');
        closeDropdowns();
        if (opening) { positionDropdown(settingsDD, btnAppearance); settingsDD.classList.add('open'); applyShellSettings(); }
    });
    sdBgToggle.addEventListener('change',   () => { shellSettings.bgEnabled   = sdBgToggle.checked;    saveShellSettings(); applyShellSettings(); });
    sdPageOpacity.addEventListener('input', () => { shellSettings.pageOpacity = +sdPageOpacity.value;  saveShellSettings(); applyShellSettings(); });
    sdBgDim.addEventListener('input',       () => { shellSettings.bgDim       = +sdBgDim.value;        saveShellSettings(); applyShellSettings(); });
}

document.addEventListener('click', (e) => {
    if (settingsDD?.classList.contains('open') && !settingsDD.contains(e.target) && e.target !== btnAppearance && !btnAppearance?.contains(e.target)) {
        settingsDD.classList.remove('open');
    }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDropdowns(); });

applyShellSettings();

btnBack.addEventListener('click', () => {
    const tab = activeTab();
    if (tab?.wv) try { tab.wv.goBack(); } catch { /* ignore */ }
});

btnForward.addEventListener('click', () => {
    const tab = activeTab();
    if (tab?.wv) try { tab.wv.goForward(); } catch { /* ignore */ }
});

btnReload.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab?.wv) return;
    try { tab.loading ? tab.wv.stop() : tab.wv.reload(); } catch { /* ignore */ }
});

btnHome.addEventListener('click', () => {
    // Show the home page for the active tab (webview is paused but kept in DOM).
    const tab = activeTab();
    if (!tab) { createTab(); return; }
    tab.showingHome = true;
    tab.title       = 'New Tab';
    if (tab.wv) tab.wv.classList.remove('active');
    setHomeVisible(true);
    syncAddressBar(tab);
    syncNavButtons(tab);
    renderTabBar();
});

btnBookmark.addEventListener('click', () => {
    const tab = activeTab();
    openModal(tab?.url ?? '', tab?.title ?? '');
});

// ── Address bar ───────────────────────────────────────────────────────────────

addressInput.addEventListener('focus', () => {
    const tab = activeTab();
    if (tab?.url) addressInput.value = tab.url;
    addressInput.select();
});

addressInput.addEventListener('blur', () => {
    const tab = activeTab();
    if (tab && !tab.showingHome && tab.url) {
        addressInput.value = displayURL(tab.url);
    } else {
        addressInput.value = '';
    }
});

addressInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        const url = normalizeURL(addressInput.value);
        if (!url) return;
        const tab = activeTab();
        if (tab) {
            navigateTab(tab, url);
        } else {
            createTab(url);
        }
        addressInput.blur();
    }
    if (e.key === 'Escape') {
        addressInput.blur();
    }
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    if (modalOpen) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 't') { e.preventDefault(); createTab(); }
    if (ctrl && e.key === 'w') { e.preventDefault(); if (activeTabId) closeTab(activeTabId); }
    if (ctrl && e.key === 'l') { e.preventDefault(); addressInput.focus(); addressInput.select(); }
    if (ctrl && e.key === 'r') {
        e.preventDefault();
        const tab = activeTab();
        if (tab?.wv) try { tab.wv.reload(); } catch { /* ignore */ }
    }
    if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        const tab = activeTab();
        if (tab?.wv) try { tab.wv.goBack(); } catch { /* ignore */ }
    }
    if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        const tab = activeTab();
        if (tab?.wv) try { tab.wv.goForward(); } catch { /* ignore */ }
    }
    // Ctrl+Tab: next tab
    if (ctrl && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const idx = tabs.findIndex(t => t.id === activeTabId);
        if (idx !== -1) activateTab(tabs[(idx + 1) % tabs.length].id);
    }
    if (ctrl && e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        const idx = tabs.findIndex(t => t.id === activeTabId);
        if (idx !== -1) activateTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
    }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Tab picker (called by main process for getDisplayMedia) ─────────────────
// main.js evaluates `window.__xcasterShowTabPicker(tabs)` when an X tab requests
// audio capture from another tab. We resolve with a webContentsId or null.

const pickerModal = document.getElementById('tab-picker-modal');
const pickerList  = document.getElementById('tab-picker-list');

window.__xcasterShowTabPicker = function (incomingTabs) {
    return new Promise((resolve) => {
        const localById = new Map();
        for (const t of tabs) {
            if (typeof t.webContentsId === 'number') localById.set(t.webContentsId, t);
        }
        const choices = (incomingTabs || []).filter(t => localById.has(t.id) || t.url);

        pickerList.innerHTML = '';
        if (choices.length === 0) {
            const empty = document.createElement('div');
            empty.className   = 'picker-empty';
            empty.textContent = 'No other tabs are open. Open a tab with the audio you want to share, then try again.';
            pickerList.appendChild(empty);
        } else {
            for (const c of choices) {
                const local = localById.get(c.id);
                const title = (local && local.title) || c.title || c.url;
                const row = document.createElement('div');
                row.className = 'picker-row';
                row.innerHTML = `
                    <div class="pr-icon">&#127908;</div>
                    <div class="pr-text">
                        <div class="pr-title">${esc(title)}</div>
                        <div class="pr-url">${esc(domainOf(c.url) || c.url)}</div>
                    </div>
                `;
                row.addEventListener('click', () => close(c.id));
                pickerList.appendChild(row);
            }
        }

        const onCancel   = () => close(null);
        const onBackdrop = (e) => { if (e.target === pickerModal) close(null); };
        const onEsc      = (e) => { if (e.key === 'Escape') close(null); };

        function close(result) {
            pickerModal.classList.remove('open');
            modalOpen = false;
            document.getElementById('tp-cancel').removeEventListener('click', onCancel);
            pickerModal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onEsc);
            resolve(result);
        }

        document.getElementById('tp-cancel').addEventListener('click', onCancel);
        pickerModal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onEsc);

        pickerModal.classList.add('open');
        modalOpen = true;
    });
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────

renderHomePage();
createTab(); // start with one home tab

})();
