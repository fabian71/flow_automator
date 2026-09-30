const FLOW_ORIGIN_FALLBACK = 'https://flow.google.com';
// ===== State =====
let automationState = {
    isProcessing: false,
    currentIndex: 0,
    prompts: [],
    config: null,
    successCount: 0,
    failCount: 0,
    lastDownloadBasename: '',
    lastDownloadSubfolder: '',
    isPaused: false,
    lastRegistrationTime: 0,
    pauseEndTime: null,
    processedSinceLastPause: 0,
    totalItems: 0,
    downloadPhase: 'none', // 'none', 'waiting_for_edit_view', 'selecting_resolution', 'waiting_for_upscale'
    targetResolution: '2k'
};

// Map URL -> filename for renaming downloads
const pendingDownloadQueue = [];

let keepAliveInterval = null;

function startKeepAlive() {
    if (keepAliveInterval) return;
    keepAliveInterval = setInterval(() => {
        chrome.storage.local.get(['keepAlive'], () => { });
    }, 20000);
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

// ===== Message Handlers =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[BG] Msg:', message.type || message.action);

    // Handle registerDownload from content script
    if (message.action === 'registerDownload') {
        registerPendingDownload(message.url, message.type);
        sendResponse({ success: true });
        return true;
    }

    // Handle direct download URL (fallback when menu-based download fails)
    if (message.type === 'downloadUrl' || message.action === 'downloadUrl') {
        const url = message.url;
        if (!url) { sendResponse({ success: false, error: 'No url' }); return true; }
        const fileType = message.fileType || 'image';
        registerPendingDownload(url, fileType);
        // Pass filename directly (reference extension pattern — more robust than relying only on onDeterminingFilename)
        const pending = pendingDownloadQueue[pendingDownloadQueue.length - 1];
        const downloadOptions = { url: url, saveAs: false };
        if (pending?.filename) {
            downloadOptions.filename = pending.filename;
            downloadOptions.conflictAction = 'uniquify';
            console.log('[BG] Downloading with filename:', pending.filename);
        }
        chrome.downloads.download(downloadOptions)
            .then(() => sendResponse({ success: true }))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    // Handle main-world React click via chrome.scripting.executeScript
    if (message.action === 'mainWorldReactClick') {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false, error: 'No tab' }); return true; }
        mainWorldReactClick(tabId, message.xpath).then(result => sendResponse(result));
        return true;
    }

    // Upload a file through the page's own file input (MAIN world, picker intercepted)
    if (message.action === 'mainWorldUploadFile') {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false, error: 'No tab' }); return true; }
        mainWorldUploadFile(tabId, message.dataUrl, message.fileName, message.fileType).then(result => sendResponse(result));
        return true;
    }

    // Handle direct CDP click by coordinates
    if (message.type === 'humanHover') {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false, error: 'No tab' }); return true; }
        mainWorldCdpHover(tabId, message.x, message.y).then(result => sendResponse(result));
        return true;
    }
    if (message.type === 'humanClickElement') {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false, error: 'No tab' }); return true; }
        cdpClickMarkedElement(tabId, message.token).then(result => sendResponse(result));
        return true;
    }
    if (message.type === 'humanClick') {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false, error: 'No tab' }); return true; }
        mainWorldCdpClick(tabId, message.x, message.y).then(result => sendResponse(result));
        return true;
    }

    // Handle main-world Enter key press
    if (message.action === 'mainWorldPressEnter') {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false, error: 'No tab' }); return true; }
        mainWorldPressEnter(tabId).then(result => sendResponse(result));
        return true;
    }


    // Handle getState for resuming automation after navigation
    if (message.action === 'getState') {
        sendResponse({ state: automationState });
        return true;
    }

    // Handle updating download phase
    if (message.action === 'updatePhase') {
        console.log('[BG] Updating phase to:', message.phase);
        automationState.downloadPhase = message.phase;
        if (message.targetResolution) automationState.targetResolution = message.targetResolution;
        sendResponse({ success: true });
        return true;
    }

    switch (message.type) {
        case 'start': startAutomation(message.config); break;
        case 'stop': stopAutomation(); break;
        case 'pause': handlePause(); break;
        case 'unpause': handleUnpause(); break;
        case 'promptComplete': handlePromptComplete(message); break;
        case 'error': handleError(message.error); break;
    }
    sendResponse({ success: true });
    return true;
});

// ===== Main World React Click (afHumanClick approach from working extension) =====
// Key insight: pointer events MUST include clientX/clientY or Radix ignores them.
// ===== Main World React Click (Improved Sequence) =====
async function mainWorldReactClick(tabId, xpath) {
    const target = { tabId };
    try {
        const results = await chrome.scripting.executeScript({
            target,
            world: 'MAIN',
            func: (xpathStr) => {
                const el = document.evaluate(xpathStr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (!el) return { success: false, reason: 'not_found' };
                
                // Scroll into view
                el.scrollIntoView({ block: 'center', inline: 'center' });
                
                const rect = el.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

                // Event sequence from reference extension (page-hook.js:3591 pointerClick)
                try {
                    el.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerId: 1 }));
                    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, pointerId: 1 }));
                } catch(_) {}
                
                const pointerDown = new PointerEvent('pointerdown', { ...opts, pointerId: 1 });
                el.dispatchEvent(pointerDown);
                
                el.dispatchEvent(new MouseEvent('mouseover', opts));
                el.dispatchEvent(new MouseEvent('mousemove', opts));
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                
                try { el.focus(); } catch(_) {}
                
                el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
                el.dispatchEvent(new MouseEvent('mouseup', opts));
                
                if (!pointerDown.defaultPrevented) {
                    el.dispatchEvent(new MouseEvent('click', opts));
                }
                
                // Final fallback
                if (typeof el.click === 'function') el.click();
                
                return { success: true, x, y };
            },
            args: [xpath]
        });
        return results?.[0]?.result || { success: false };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// Trusted click on an element marked with data-fa-click="<token>".
// Coordinates are measured AFTER attaching the debugger, because Chrome's
// "is debugging this browser" bar resizes the viewport and moves the page.
async function cdpClickMarkedElement(tabId, token) {
    const target = { tabId };
    let attached = false;
    try {
        await chrome.debugger.attach(target, '1.3');
        attached = true;
        await sleep(350);
        const expr = `(() => {
            const e = document.querySelector('[data-fa-click="${String(token).replace(/[^a-z0-9_-]/gi, '')}"]');
            if (!e) return null;
            e.scrollIntoView({ block: 'center', inline: 'center' });
            const r = e.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
        })()`;
        const ev = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: expr, returnByValue: true });
        const pos = ev?.result?.value;
        if (!pos || !pos.w) throw new Error('element-not-found');
        const base = { x: pos.x, y: pos.y, button: 'left', clickCount: 1, pointerType: 'mouse' };
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
        await sleep(60);
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
        await sleep(60);
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
        await sleep(150);
        return { success: true, method: 'cdp-element-click', x: pos.x, y: pos.y };
    } catch (e) {
        console.warn('[BG] CDP element click failed:', e.message);
        return { success: false, error: e.message };
    } finally {
        if (attached) { try { await chrome.debugger.detach(target); } catch (_) { } }
    }
}

async function mainWorldCdpClick(tabId, x, y) {
    const target = { tabId };
    try {
        await chrome.debugger.attach(target, '1.3');
        const clickParams = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...clickParams, type: 'mousePressed' });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...clickParams, type: 'mouseReleased' });
        await chrome.debugger.detach(target);
        return { success: true, method: 'cdp-direct-click', x, y };
    } catch (e) {
        console.warn('[BG] CDP Direct Click failed:', e.message);
        try { await chrome.debugger.detach(target); } catch (_) { }
        return { success: false, error: e.message };
    }
}

// ===== Direct CDP Hover by Coordinates =====
async function mainWorldCdpHover(tabId, x, y) {
    const target = { tabId };
    try {
        await chrome.debugger.attach(target, '1.3');
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { 
            type: 'mouseMoved', 
            x: x, 
            y: y,
            pointerType: 'mouse'
        });
        await chrome.debugger.detach(target);
        return { success: true, method: 'cdp-direct-hover', x, y };
    } catch (e) {
        console.warn('[BG] CDP Direct Hover failed:', e.message);
        try { await chrome.debugger.detach(target); } catch (_) { }
        return { success: false, error: e.message };
    }
}

// ===== Main World File Upload =====
// Flow opens a native file picker from its "Enviar midia"/"Upload media" button.
// We intercept HTMLInputElement.click (and showOpenFilePicker) in the page, grab the
// <input type=file>, fill it with our file and fire 'change' - no OS dialog appears.
async function mainWorldUploadFile(tabId, dataUrl, fileName, fileType) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            args: [dataUrl, fileName || 'frame.png', fileType || 'image/png'],
            func: async (dataUrl, fileName, fileType) => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                const iconOf = (el) => String(el?.querySelector('mat-icon, .google-symbols, i')?.textContent || '').trim();
                const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
                const root = document.querySelector('.cdk-overlay-container') || document;
                const btn = Array.from(root.querySelectorAll('button')).filter(visible).find(b => iconOf(b) === 'upload');
                if (!btn) return { success: false, error: 'upload-button-not-found' };

                const blob = await (await fetch(dataUrl)).blob();
                const file = new File([blob], fileName, { type: fileType || blob.type || 'image/png' });

                let captured = null;
                const origClick = HTMLInputElement.prototype.click;
                const origShowPicker = HTMLInputElement.prototype.showPicker;
                const origOpenPicker = window.showOpenFilePicker;
                HTMLInputElement.prototype.click = function () {
                    if (this.type === 'file') { captured = this; return; }
                    return origClick.call(this);
                };
                if (origShowPicker) {
                    HTMLInputElement.prototype.showPicker = function () {
                        if (this.type === 'file') { captured = this; return; }
                        return origShowPicker.call(this);
                    };
                }
                if (origOpenPicker) {
                    window.showOpenFilePicker = async () => { throw new DOMException('intercepted', 'AbortError'); };
                }
                try {
                    btn.click();
                    for (let i = 0; i < 30 && !captured; i++) await sleep(100);
                } finally {
                    HTMLInputElement.prototype.click = origClick;
                    if (origShowPicker) HTMLInputElement.prototype.showPicker = origShowPicker;
                    if (origOpenPicker) window.showOpenFilePicker = origOpenPicker;
                }
                if (!captured) {
                    captured = Array.from(document.querySelectorAll('input[type="file"]')).pop() || null;
                }
                if (!captured) return { success: false, error: 'file-input-not-captured' };

                const dt = new DataTransfer();
                dt.items.add(file);
                captured.files = dt.files;
                captured.dispatchEvent(new Event('input', { bubbles: true }));
                captured.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, size: file.size };
            }
        });
        return results?.[0]?.result || { success: false, error: 'no-result' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// Simulates Enter key on the editor using CDP (indistinguishable from real keyboard)
async function mainWorldPressEnter(tabId) {
    const target = { tabId };
    try {
        // First ensure focus via MAIN world
        await chrome.scripting.executeScript({
            target,
            world: 'MAIN',
            func: () => {
                const el = document.querySelector('.base-prompt-box .ProseMirror') ||
                    document.querySelector('.ProseMirror[contenteditable="true"]') ||
                    document.querySelector('[role="textbox"][contenteditable="true"]');
                if (el) {
                    el.focus();
                    // Scroll to it too
                    el.scrollIntoView({ block: 'center' });
                }
            }
        });

        await chrome.debugger.attach(target, '1.3');
        // Press Enter
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            windowsVirtualKeyCode: 13,
            unmodifiedText: '\r',
            text: '\r'
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            windowsVirtualKeyCode: 13,
            unmodifiedText: '\r',
            text: '\r'
        });
        await chrome.debugger.detach(target);
        return { success: true, method: 'cdp-Enter' };
    } catch (e) {
        console.warn('[BG] CDP Enter failed, trying JS fallback:', e.message);
        try { await chrome.debugger.detach(target); } catch (_) { }
        
        // JS Fallback
        try {
            const results = await chrome.scripting.executeScript({
                target,
                world: 'MAIN',
                func: () => {
                    const el = document.querySelector('.base-prompt-box .ProseMirror') ||
                        document.querySelector('.ProseMirror[contenteditable="true"]') ||
                        document.querySelector('[role="textbox"][contenteditable="true"]');
                    if (!el) return false;
                    el.focus();
                    const common = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
                    el.dispatchEvent(new KeyboardEvent('keydown', common));
                    el.dispatchEvent(new KeyboardEvent('keypress', common));
                    el.dispatchEvent(new KeyboardEvent('keyup', common));
                    return true;
                }
            });
            return { success: results?.[0]?.result ?? false, method: 'js-events' };
        } catch (e2) {
            return { success: false, error: e2.message };
        }
    }
}


// Register a URL -> filename mapping before download starts
function registerPendingDownload(url, type) {
    if (!automationState.isProcessing || !automationState.config) return;

    const cfg = automationState.config;
    const idx = automationState.currentIndex;
    const prompt = automationState.prompts[idx] || '';
    const name = sanitizeFilename(prompt.substring(0, 50));
    const basename = String(idx + 1).padStart(3, '0') + '_' + name;
    const ext = type === 'image' ? 'png' : 'mp4';

    let filename = basename + '.' + ext;
    if (cfg.subfolder) {
        filename = cfg.subfolder + '/' + filename;
    }

    const isFlowRedirect = url && url.includes('getMediaUrlRedirect');
    const urlBase = url ? (isFlowRedirect ? url : url.split('?')[0]) : null;

    // Extract media UUID for matching (reference extension pattern)
    let mediaId = '';
    if (isFlowRedirect) {
        try {
            const parsed = new URL(url, FLOW_ORIGIN_FALLBACK);
            const name = parsed.searchParams.get('name');
            if (name) mediaId = name;
        } catch (_) { }
    }

    console.log('[BG] Registering download:', (urlBase || 'unknown').substring(0, 80) + '...', '->', filename);

    pendingDownloadQueue.push({
        urlBase: urlBase,
        mediaId: mediaId,
        filename: filename,
        basename: basename,
        subfolder: cfg.subfolder || '',
        createdAt: Date.now()
    });

    automationState.lastRegistrationTime = Date.now();
    automationState.lastDownloadBasename = basename;
    automationState.lastDownloadSubfolder = cfg.subfolder || '';
}

function cleanupDownloadQueue() {
    const now = Date.now();
    const ttl = 15 * 60 * 1000; // 15 minutes
    while (pendingDownloadQueue.length > 0 && (now - pendingDownloadQueue[0].createdAt > ttl)) {
        pendingDownloadQueue.shift();
    }
}

const FLOW_HOME_URL = 'https://flow.google.com/';

function isFlowToolsUrl(url) {
    const u = String(url || '').toLowerCase();
    if (u.startsWith('https://flow.google.com')) return true;
    return u.includes('labs.google/fx') && u.includes('/tools/flow');
}

function isFlowProjectUrl(url) {
    const u = String(url || '').toLowerCase();
    return isFlowToolsUrl(u) && u.includes('/project/');
}

function waitForTabUrl(tabId, predicate, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const done = (ok, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            ok ? resolve(value) : reject(value);
        };

        const onUpdated = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId !== tabId) return;
            if (changeInfo.status === 'complete' && predicate(tab?.url || '')) {
                done(true, tab?.url || '');
            }
        };

        const timer = setTimeout(() => done(false, new Error('Timeout waiting tab URL')), timeoutMs);
        chrome.tabs.onUpdated.addListener(onUpdated);

        chrome.tabs.get(tabId).then(tab => {
            if (predicate(tab?.url || '')) done(true, tab?.url || '');
        }).catch(() => { });
    });
}

async function clickNewProjectButton(tabId) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
            const isVisible = (el) => {
                if (!el || !el.isConnected) return false;
                const st = window.getComputedStyle(el);
                if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
                const r = el.getBoundingClientRect();
                return r.width > 8 && r.height > 8;
            };

            const clickHuman = (el) => {
                const r = el.getBoundingClientRect();
                const x = r.left + r.width / 2;
                const y = r.top + r.height / 2;
                const evt = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
                try { el.dispatchEvent(new PointerEvent('pointerdown', evt)); } catch (_) { }
                el.dispatchEvent(new MouseEvent('mousedown', evt));
                try { el.dispatchEvent(new PointerEvent('pointerup', evt)); } catch (_) { }
                el.dispatchEvent(new MouseEvent('mouseup', evt));
                el.dispatchEvent(new MouseEvent('click', evt));
            };

            const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
            const byIcon = buttons.find(btn => btn.classList.contains('new-project-button')) ||
                buttons.find(btn => /^\s*(add_2|add)?\s*(novo projeto|new project)\s*$/i.test(btn.textContent || '')) ||
                buttons.find(btn => {
                    const icon = String(btn.querySelector('mat-icon, i')?.textContent || '').trim().toLowerCase();
                    return icon === 'add_2' && /projeto|project/i.test(btn.textContent || '');
                });

            if (!byIcon) return { success: false, reason: 'new-project-button-not-found' };

            clickHuman(byIcon);
            try { byIcon.click(); } catch (_) { }
            return { success: true };
        }
    });
    return results?.[0]?.result?.success === true;
}

async function ensureFlowProjectReady(tabId) {
    const current = await chrome.tabs.get(tabId);
    const currentUrl = current?.url || '';

    if (!isFlowProjectUrl(currentUrl)) {
        if (!isFlowToolsUrl(currentUrl)) {
            await chrome.tabs.update(tabId, { url: FLOW_HOME_URL });
            await waitForTabUrl(tabId, isFlowToolsUrl, 60000);
        } else {
            await sleep(1000);
        }

        let opened = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const clicked = await clickNewProjectButton(tabId);
            if (clicked) {
                try {
                    await waitForTabUrl(tabId, isFlowProjectUrl, 60000);
                    opened = true;
                    break;
                } catch (_) { }
            }
            await sleep(1200);
        }

        if (!opened) {
            throw new Error('Nao foi possivel abrir Novo projeto automaticamente.');
        }
    }
}

async function startAutomation(config) {
    automationState = {
        isProcessing: true,
        currentIndex: 0,
        prompts: config.prompts,
        config: config,
        successCount: 0,
        failCount: 0,
        isPaused: false,
        lastRegistrationTime: 0,
        pauseEndTime: null,
        processedSinceLastPause: 0,
        totalItems: 0
    };

    try {
        await ensureFlowProjectReady(config.tabId);
    } catch (e) {
        console.error('[BG] Failed to prepare Flow project:', e?.message || e);
        automationState.isProcessing = false;
        await chrome.storage.local.set({ isProcessing: false });
        broadcastMessage({ type: 'error', error: e?.message || 'Falha ao abrir projeto no Flow' });
        return;
    }

    const imageCount = config.imageCount || (config.images ? config.images.length : 0);
    const totalItems = imageCount > 0 ? imageCount : config.prompts.length;
    automationState.totalItems = totalItems;

    await chrome.storage.local.set({
        isProcessing: true,
        currentIndex: 0,
        totalPrompts: totalItems,
        currentPrompt: config.prompts[0] || '',
        subfolder: config.subfolder || ''
    });
    startKeepAlive();
    processNextPrompt();
}

function stopAutomation() {
    const tabId = automationState.config?.tabId;
    const successCount = automationState.successCount;
    const failCount = automationState.failCount;

    automationState.isProcessing = false;
    stopKeepAlive();
    chrome.storage.local.set({ isProcessing: false });
    broadcastMessage({ type: 'complete', success: successCount, failed: failCount });

    // Also send to content script to show completion UI
    if (tabId) {
        chrome.tabs.sendMessage(tabId, {
            type: 'complete',
            success: successCount,
            failed: failCount
        }).catch(() => { });
    }
}

function buildContentConfig(config, totalItems) {
    // Everything except the heavy arrays
    const { prompts, images, ...rest } = config || {};
    return { ...rest, totalPrompts: totalItems };
}

async function processNextPrompt() {
    const prompts = automationState.prompts || [];
    const config = automationState.config;

    if (!config) {
        console.error('[BG] Config is null, stopping automation');
        stopAutomation();
        return;
    }

    const imageCount = config.imageCount || (config.images ? config.images.length : 0);
    const totalItems = imageCount > 0 ? imageCount : prompts.length;

    if (!automationState.isProcessing || automationState.currentIndex >= automationState.totalItems) {
        if (automationState.isProcessing) stopAutomation();
        return;
    }

    let prompt = prompts.length > 0
        ? prompts[automationState.currentIndex % prompts.length]
        : '';
    prompt = String(prompt || '').trim();
    if (!prompt) {
        prompt = 'Animate this image with natural cinematic motion, preserving subject identity and scene details.';
    }

    // Get current image from storage (chunked) or config (legacy)
    let currentImage = null;
    if (config.usingStorageImages) {
        const key = `flow_img_${automationState.currentIndex}`;
        const result = await chrome.storage.local.get(key);
        currentImage = result[key] || null;
    } else {
        const images = config.images || [];
        currentImage = images.length > 0 ? images[automationState.currentIndex] : null;
    }

    // Store current prompt info for download renaming
    await chrome.storage.local.set({
        currentIndex: automationState.currentIndex,
        currentPrompt: prompt
    });

    broadcastMessage({ type: 'progress', current: automationState.currentIndex, total: totalItems, status: 'Gerando...' });

    try {
        await chrome.tabs.sendMessage(config.tabId, {
            type: 'processPrompt',
            prompt,
            image: currentImage, // Pass image data
            index: automationState.currentIndex,
            config: buildContentConfig(config, totalItems)
        });
    } catch (e) {
        console.log('[BG] Injecting content script...');
        await chrome.scripting.executeScript({ target: { tabId: config.tabId }, files: ['content/content.js'] });
        await sleep(1000);
        await chrome.tabs.sendMessage(config.tabId, {
            type: 'processPrompt',
            prompt,
            image: currentImage, // Pass image data
            index: automationState.currentIndex,
            config: buildContentConfig(config, totalItems)
        });
    }
}

async function handlePromptComplete(msg) {
    console.log('[BG] Prompt complete:', msg.success, msg.error);

    if (msg.success) {
        automationState.successCount++;

        // Wait for the video/image download to be fully processed
        // This ensures the download listener has time to rename the file
        console.log('[BG] Waiting for download to complete...');
        await sleep(3000); // Increased for larger 2K/4K image downloads

        // Save prompt as txt file if enabled
        if (automationState.config?.savePromptTxt) {
            await savePromptTxt(msg.prompt);
        }
    } else {
        automationState.failCount++;
    }

    // Wait delay before next prompt
    const delayMs = (automationState.config?.delaySeconds || 5) * 1000;
    console.log('[BG] Waiting', delayMs, 'ms before next prompt...');

    const prompts = automationState.prompts || [];
    const config = automationState.config;
    const imageCount = config.imageCount || (config.images ? config.images.length : 0);
    const totalItems = imageCount > 0 ? imageCount : prompts.length;

    broadcastMessage({ type: 'progress', current: automationState.currentIndex, total: totalItems, status: 'Aguardando...' });

    await sleep(delayMs);
    automationState.currentIndex++;

    // Check if we reached the end
    if (automationState.currentIndex >= automationState.totalItems) {
        console.log('[BG] Automation reached the end, stopping...');
        stopAutomation();
        return;
    }

    // Check if scheduled pause should be triggered
    if (checkScheduledPause()) {
        console.log('[BG] Automation paused due to scheduled pause');
        return; // Don't process next prompt until unpaused
    }

    processNextPrompt();
}

async function savePromptTxt(prompt) {
    let txtFn;

    // Use the same basename as the downloaded file if available
    if (automationState.lastDownloadBasename) {
        txtFn = automationState.lastDownloadBasename + '.txt';
        if (automationState.lastDownloadSubfolder) {
            txtFn = automationState.lastDownloadSubfolder + '/' + txtFn;
        }
    } else {
        // Fallback: generate name from prompt
        const cfg = automationState.config;
        if (!cfg) return; // Early return if config is null
        const idx = automationState.currentIndex;
        const name = sanitizeFilename(prompt.substring(0, 50));
        txtFn = String(idx + 1).padStart(3, '0') + '_' + name + '.txt';
        if (cfg.subfolder) {
            txtFn = cfg.subfolder + '/' + txtFn;
        }
    }

    try {
        // Store the filename for the onDeterminingFilename listener
        automationState.pendingTxtFilename = txtFn;

        // Create data URL (blob URL doesn't work in Service Worker)
        const blob = new Blob([prompt], { type: 'text/plain' });
        const dataUrl = await blobToDataURL(blob);

        // Start download - the listener will rename it
        const downloadId = await chrome.downloads.download({
            url: dataUrl,
            saveAs: false
        });

        console.log('[BG] Started txt download with id:', downloadId, 'Target:', txtFn);

        // Wait a bit before clearing basename to ensure txt download is processed
        await sleep(1000);

        // Clear the saved basename
        automationState.lastDownloadBasename = '';
        automationState.lastDownloadSubfolder = '';
    } catch (e) {
        console.error('[BG] Failed to save txt:', e);
        automationState.pendingTxtFilename = '';
    }
}

// ===== Scheduled Pause Functions =====
function handlePause() {
    console.log('[BG] Manual pause requested');
    automationState.isPaused = true;
    automationState.pauseEndTime = null; // Manual pause = indefinite
    broadcastMessage({ type: 'paused', isScheduled: false });

    // Also send to tab
    const tabId = automationState.config?.tabId;
    if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'paused', isScheduled: false }).catch(() => { });
    }
}

function handleUnpause() {
    console.log('[BG] Unpause requested');
    automationState.isPaused = false;
    automationState.pauseEndTime = null;
    broadcastMessage({ type: 'unpaused' });

    // Also send to tab
    const tabId = automationState.config?.tabId;
    if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'unpaused' }).catch(() => { });
    }

    // Resume processing if we have more prompts
    if (automationState.isProcessing && automationState.currentIndex < automationState.totalItems) {
        processNextPrompt();
    }
}

function checkScheduledPause() {
    const cfg = automationState.config;
    if (!cfg || !cfg.scheduledPauseEnabled) return false;

    // Increment processed count
    automationState.processedSinceLastPause++;

    // Check if we should pause
    if (automationState.processedSinceLastPause >= cfg.pauseEveryN) {
        // Calculate random pause duration (in ms)
        const minMs = cfg.pauseMinMinutes * 60 * 1000;
        const maxMs = cfg.pauseMaxMinutes * 60 * 1000;
        const randomDuration = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        const pauseMinutes = (randomDuration / 60 / 1000).toFixed(1);

        console.log(`[BG] Scheduled pause triggered! Pausing for ${pauseMinutes} minutes`);

        automationState.isPaused = true;
        automationState.pauseEndTime = Date.now() + randomDuration;
        automationState.processedSinceLastPause = 0;

        broadcastMessage({
            type: 'paused',
            isScheduled: true,
            pauseMinutes: pauseMinutes,
            pauseEndTime: automationState.pauseEndTime
        });

        // Also send to tab
        const tabId = automationState.config?.tabId;
        if (tabId) {
            chrome.tabs.sendMessage(tabId, {
                type: 'paused',
                isScheduled: true,
                pauseMinutes: pauseMinutes,
                pauseEndTime: automationState.pauseEndTime
            }).catch(() => { });
        }

        // Auto-unpause after duration
        setTimeout(() => {
            if (automationState.isPaused && automationState.pauseEndTime) {
                console.log('[BG] Scheduled pause ended, resuming...');
                handleUnpause();
            }
        }, randomDuration);

        return true;
    }

    return false;
}

function sanitizeFilename(str) {
    return str
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .trim()
        .substring(0, 50);
}

function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function handleError(err) {
    console.error('[BG] Error:', err);
    automationState.failCount++;
    setTimeout(() => { automationState.currentIndex++; processNextPrompt(); }, 2000);
}

function broadcastMessage(msg) {
    chrome.runtime.sendMessage(msg).catch(() => { });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function notifyFlowDownloadDetected(downloadItem, finalName = '') {
    const tabId = automationState.config?.tabId;
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, {
        type: 'flowDownloadDetected',
        url: downloadItem?.url || '',
        filename: finalName || downloadItem?.filename || ''
    }).catch(() => { });
}

// ===== Download listener to rename files =====
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    cleanupDownloadQueue();
    const itemUrl = downloadItem.url || '';

    // 0. IMPORTANT: If not a Flow URL and not a data URL we expect, LET OTHER EXTENSIONS HANDLE IT
    const isFlowUrl = itemUrl.includes('storage.googleapis.com') ||
        itemUrl.includes('flow-content.google') ||
        itemUrl.includes('googleusercontent.com') ||
        itemUrl.includes('getMediaUrlRedirect') ||
        itemUrl.includes('googlevideo.com') ||
        itemUrl.includes('blob:https://labs.google') ||
        itemUrl.includes('blob:https://flow.google.com') ||
        downloadItem.referrer?.includes('labs.google') ||
        downloadItem.referrer?.includes('flow.google.com');

    const isOurDataTxt = itemUrl.startsWith('data:text/plain') && automationState.pendingTxtFilename;

    if (!isFlowUrl && !isOurDataTxt) {
        // We don't call suggest({filename:...}) here, so we don't interfere.
        // According to Chrome docs, calling suggest() with no arguments or not calling it at all 
        // (if synchronous) is okay, but calling it with empty object is safest for async.
        suggest();
        return;
    }

    // 1. Check for txt files
    if (isOurDataTxt) {
        const txtFilename = automationState.pendingTxtFilename;
        automationState.pendingTxtFilename = '';
        console.log('[BG] Renaming txt to:', txtFilename);
        suggest({ filename: txtFilename, conflictAction: 'uniquify' });
        return;
    }

    // 2. Check the queue for a match (by URL, mediaId, or time window)
    const isFlowRedirect = itemUrl.includes('getMediaUrlRedirect');
    const itemUrlBase = isFlowRedirect ? itemUrl : itemUrl.split('?')[0];

    // Extract mediaId from redirect URL (e.g. /fx/api/trpc/media.getMediaUrlRedirect?name=UUID)
    function extractMediaIdFromUrl(url) {
        try {
            const parsed = new URL(url);
            const name = parsed.searchParams.get('name');
            if (name) return name;
        } catch (_) { }
        return '';
    }
    const itemMediaId = extractMediaIdFromUrl(itemUrl);

    // Priority 1: Exact URL match
    let index = pendingDownloadQueue.findIndex(q => q.urlBase && q.urlBase === itemUrlBase);

    // Priority 2: Match by mediaId (UUID from redirect URL)
    if (index === -1 && itemMediaId) {
        index = pendingDownloadQueue.findIndex(q => q.mediaId && q.mediaId === itemMediaId);
        if (index !== -1) console.log('[BG] Matched by mediaId:', itemMediaId);
    }

    // Priority 3: Automation is running and it's a Flow URL, matching time window
    const timeSinceLastReg = Date.now() - (automationState.lastRegistrationTime || 0);
    if (index === -1 && isFlowUrl && pendingDownloadQueue.length > 0 && timeSinceLastReg < 120000) {
        console.log('[BG] Matching by time window (<120s) for Flow URL');
        index = 0;
    }

    if (index !== -1) {
        const match = pendingDownloadQueue.splice(index, 1)[0];
        const realExt = (String(downloadItem.filename || '').match(/\.([a-z0-9]{2,4})$/i) || [])[1] ||
            ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4' })[downloadItem.mime] || '';
        if (realExt) match.filename = match.filename.replace(/\.[a-z0-9]{2,4}$/i, '.' + realExt.toLowerCase());
        console.log('[BG] Found match! Renaming to:', match.filename);
        automationState.lastDownloadBasename = match.basename;
        automationState.lastDownloadSubfolder = match.subfolder;
        notifyFlowDownloadDetected(downloadItem, match.filename);
        suggest({ filename: match.filename, conflictAction: 'uniquify' });
    } else {
        console.log('[BG] Download from Flow but no matching queue item. Letting it pass.');
        notifyFlowDownloadDetected(downloadItem, downloadItem.filename || '');
        suggest();
    }
});

console.log('[BG] Background script loaded');
