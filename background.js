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

    // Handle main-world React click via chrome.scripting.executeScript
    if (message.action === 'mainWorldReactClick') {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false, error: 'No tab' }); return true; }
        mainWorldReactClick(tabId, message.xpath).then(result => sendResponse(result));
        return true;
    }

    // Handle main-world text injection for Lexical editors
    if (message.action === 'mainWorldFillText') {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false, error: 'No tab' }); return true; }
        mainWorldFillText(tabId, message.text).then(result => sendResponse(result));
        return true;
    }

    // Handle direct CDP click by coordinates
    if (message.type === 'humanHover') {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false, error: 'No tab' }); return true; }
        mainWorldCdpHover(tabId, message.x, message.y).then(result => sendResponse(result));
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

    // Handle main-world settings selection (mode, ratio, model, quantity)
    if (message.action === 'mainWorldSelectSettings') {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false, error: 'No tab' }); return true; }
        mainWorldSelectSettings(tabId, message.config).then(result => sendResponse(result));
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

// ===== Main World Text Injection (Slate native API via React Fiber) =====
// Adapted from the working reference extension. Accesses Slate's internal
// editor object through React Fiber to call insertText() directly.
// This fires Slate's own onChange listeners, which Flow uses to enable the submit button.
async function mainWorldFillText(tabId, text) {
    const target = { tabId };
    try {
        const result = await chrome.scripting.executeScript({
            target,
            world: 'MAIN',
            args: [text],
            func: (value) => {
                // --- Helper: find best prompt editor (scores by size/visibility) ---
                function findBestEditor() {
                    const visible = (el) => {
                        if (!el || !el.isConnected) return false;
                        const s = window.getComputedStyle(el);
                        if (!s || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
                        const r = el.getBoundingClientRect();
                        return r.width > 4 && r.height > 4;
                    };
                    const candidates = Array.from(document.querySelectorAll(
                        "textarea, [role='textbox'], [contenteditable='true'], [contenteditable='plaintext-only'], [data-slate-editor='true']"
                    ))
                        .filter(el => visible(el) && !el.disabled && !el.readOnly)
                        .filter(el => {
                            const label = [el.getAttribute('type'), el.getAttribute('aria-label'), el.getAttribute('placeholder'),
                                el.getAttribute('name'), el.id, el.className
                            ].map(v => String(v || '')).join(' ').toLowerCase();
                            return !/\bsearch\b/.test(label);
                        })
                        .map(el => {
                            const r = el.getBoundingClientRect();
                            const tag = String(el.tagName || '').toLowerCase();
                            return { el, score: r.width * r.height + r.bottom + (tag === 'textarea' ? 5000 : 0) };
                        })
                        .sort((a, b) => b.score - a.score);
                    return candidates[0]?.el || null;
                }

                // --- Helper: find Slate editor object via React Fiber ---
                function findSlateEditorObject(root) {
                    const slateRoot = root?.matches?.("[data-slate-editor='true']")
                        ? root
                        : root?.closest?.("[data-slate-editor='true']");
                    if (!slateRoot) return null;
                    for (const key of Object.keys(slateRoot).filter((k) => k.startsWith('__react'))) {
                        const stack = [slateRoot[key]];
                        const seen = new Set();
                        let guard = 0;
                        while (stack.length && guard < 4000) {
                            guard++;
                            const node = stack.pop();
                            if (!node || typeof node !== 'object' || seen.has(node)) continue;
                            seen.add(node);
                            const candidates = [
                                node.memoizedProps?.editor,
                                node.memoizedProps?.node,
                                node.memoizedState?.editor,
                                node.pendingProps?.editor,
                                node.stateNode?.editor,
                                node.editor
                            ];
                            const editor = candidates.find((c) =>
                                c && typeof c === 'object' &&
                                Array.isArray(c.children) &&
                                (typeof c.insertText === 'function' || typeof c.apply === 'function')
                            );
                            if (editor) return editor;
                            if (node.child) stack.push(node.child);
                            if (node.sibling) stack.push(node.sibling);
                            if (node.return) stack.push(node.return);
                            if (node.alternate) stack.push(node.alternate);
                        }
                    }
                    return null;
                }

                // --- Helper: collect text from Slate node tree ---
                function collectSlateText(node, out = []) {
                    if (!node || typeof node !== 'object') return out;
                    if (typeof node.text === 'string') out.push(node.text);
                    if (Array.isArray(node.children)) node.children.forEach((c) => collectSlateText(c, out));
                    return out;
                }

                // --- Helper: mark React receivedUserInput ref ---
                function markReceivedUserInput(el) {
                    const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
                    if (!fiberKey) return;
                    for (let fiber = el[fiberKey], depth = 0; fiber && depth < 50; depth++, fiber = fiber.return) {
                        const ref = fiber.memoizedProps?.receivedUserInput;
                        if (ref && typeof ref === 'object' && 'current' in ref) ref.current = true;
                    }
                }

                // --- Helper: sync Flow's internal Zustand store ---
                function syncPromptStore(editorEl, text) {
                    const fiberKey = Object.keys(editorEl).find((k) => k.startsWith('__reactFiber'));
                    if (!fiberKey) return false;
                    for (let fiber = editorEl[fiberKey], depth = 0; fiber && depth < 50; depth++, fiber = fiber.return) {
                        const store = fiber.memoizedProps?.promptBoxStore;
                        const setPrompt = store?.getState?.()?.actions?.setPrompt;
                        if (typeof setPrompt === 'function') {
                            setPrompt(String(text || ''));
                            return true;
                        }
                    }
                    return false;
                }

                // 1. Find editor element (smart: sizes, visibility, filters search inputs)
                const el = findBestEditor();
                if (!el) return { success: false, error: 'editor_not_found' };

                // 2. Scroll + focus
                el.scrollIntoView({ block: 'center' });
                el.focus();

                // 3. Get Slate editor object
                const slateEditor = findSlateEditorObject(el);
                if (slateEditor) {
                    try {
                        // Clear existing text via Slate API
                        const existingText = String(slateEditor?.children?.[0]?.children?.[0]?.text || '');
                        const range = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: existingText.length } };
                        if (typeof slateEditor.select === 'function') slateEditor.select(range);
                        if (typeof slateEditor.deleteFragment === 'function') slateEditor.deleteFragment();

                        // Insert text via Slate's native API (fires onChange, enables submit button)
                        if (typeof slateEditor.insertText === 'function') {
                            slateEditor.insertText(value);
                        } else if (typeof slateEditor.apply === 'function') {
                            slateEditor.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: value });
                        }
                        if (typeof slateEditor.onChange === 'function') slateEditor.onChange();

                        // Mark user interaction
                        markReceivedUserInput(el);

                        // Sync Flow's internal Zustand store as extra safety
                        syncPromptStore(el, value);

                        // Notify React
                        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: null }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        try {
                            el.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true, composed: true }));
                        } catch (_) {}

                        const persisted = collectSlateText(slateEditor.children?.[0] || {}, []).join('');
                        return { success: true, method: 'slate.insertText', length: persisted.length };
                    } catch (e) {
                        return { success: false, error: 'slate_insert_failed: ' + e.message };
                    }
                }

                // Fallback: execCommand (legacy)
                try {
                    el.focus();
                    document.execCommand('selectAll', false, null);
                    document.execCommand('insertText', false, value);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return { success: true, method: 'execCommand.insertText', length: value.length };
                } catch (e) {
                    return { success: false, error: 'execCommand_failed: ' + e.message };
                }
            }
        });

        const r = result[0]?.result;
        console.log('[BG] mainWorldFillText result:', JSON.stringify(r));
        return r || { success: false, error: 'no_result' };
    } catch (e) {
        console.error('[BG] mainWorldFillText error:', e.message);
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
                const el = document.querySelector('[data-slate-editor="true"]') ||
                    document.querySelector('[role="textbox"][contenteditable="true"]') ||
                    document.querySelector('[role="textbox"]');
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
                    const el = document.querySelector('[data-slate-editor="true"]') ||
                        document.querySelector('[role="textbox"][contenteditable="true"]') ||
                        document.querySelector('[role="textbox"]');
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


// ===== Main World Settings Selection =====
// Uses simple .click() - confirmed working by browser testing.
// The working reference extension (lhcmnhdbddgagibbbgppakocflbnknoa) also uses only .click()
// Config: { mode: 'create-image'|'text-to-video'|'image-to-video',
//           imageModel: 'Nano Banana 2'|'Nano Banana Pro'|'Imagen 4',
//           aspectRatio: '16:9'|'4:3'|'1:1'|'3:4'|'9:16'|'landscape'|'portrait' }
async function mainWorldSelectSettings(tabId, config) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (cfg) => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                const log = (...a) => console.log('[Flow Automator]', ...a);

                function byXPath(xpath, root = document) {
                    return document.evaluate(xpath, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                }

                function isVisible(el) {
                    if (!el || !el.isConnected) return false;
                    const style = window.getComputedStyle(el);
                    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 4 && r.height > 4;
                }

                function normText(v) {
                    return String(v || '')
                        .toLowerCase()
                        .normalize('NFD')
                        .replace(/[\u0300-\u036f]/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                }

                function pressEscape() {
                    document.body.dispatchEvent(new KeyboardEvent('keydown', {
                        key: 'Escape',
                        keyCode: 27,
                        bubbles: true,
                        cancelable: true,
                        composed: true
                    }));
                }

                function humanClick(el) {
                    if (!el) return false;
                    try {
                        const rect = el.getBoundingClientRect();
                        const x = rect.left + Math.max(6, Math.min(rect.width - 6, rect.width * 0.5));
                        const y = rect.top + Math.max(6, Math.min(rect.height - 6, rect.height * 0.5));
                        const common = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
                        try { el.dispatchEvent(new PointerEvent('pointerover', common)); } catch (_) { }
                        try { el.dispatchEvent(new PointerEvent('pointermove', common)); } catch (_) { }
                        try { el.dispatchEvent(new PointerEvent('pointerdown', common)); } catch (_) { }
                        el.dispatchEvent(new MouseEvent('mousedown', common));
                        try { el.dispatchEvent(new PointerEvent('pointerup', common)); } catch (_) { }
                        el.dispatchEvent(new MouseEvent('mouseup', common));
                        el.dispatchEvent(new MouseEvent('click', common));
                        return true;
                    } catch (_) {
                        try { el.click(); return true; } catch (e) { return false; }
                    }
                }

                async function waitFor(fn, timeoutMs = 5000, stepMs = 100) {
                    const max = Math.max(1, Math.ceil(timeoutMs / stepMs));
                    for (let i = 0; i < max; i++) {
                        const v = fn();
                        if (v) return v;
                        await sleep(stepMs);
                    }
                    return null;
                }

                    function normalizeAspectRatio(value) {
                        const raw = String(value || '').trim();
                        if (raw === 'portrait') return '9:16';
                        if (raw === 'landscape') return '16:9';
                        return raw || '16:9';
                    }

                    function findSettingsMenu() {
                        const menus = Array.from(document.querySelectorAll("[role='menu'], [role='dialog'], .DropdownMenuContent")).filter(isVisible);
                        return menus.find(m => {
                            const t = normText(m.textContent);
                            return t.includes('image') || t.includes('video') || t.includes('paisagem') || t.includes('retrato') || t.includes('portrait') || t.includes('landscape') || t.includes('square') || t.includes('quadrado') || t.includes('16:9') || t.includes('4:3') || t.includes('1:1') || t.includes('3:4') || t.includes('9:16') || t.includes('x1');
                        }) || null;
                    }

                return (async () => {
                    const steps = [];
                    try {
                        // 1) Close previous popovers.
                        pressEscape();
                        await sleep(250);

                        // 2) Open settings panel.
                        // In the new UI, the settings trigger is often the same as the model dropdown button (has aria-haspopup="menu")
                        const trigger = await waitFor(
                            () => byXPath("//button[descendant::i[normalize-space(text())='crop_16_9' or normalize-space(text())='crop_landscape' or normalize-space(text())='crop_square' or normalize-space(text())='crop_portrait' or normalize-space(text())='crop_9_16']]"),
                            6000,
                            120
                        );
                        if (!trigger) return { success: false, error: 'settings-trigger-not-found', steps };
                        humanClick(trigger);
                        await sleep(700);

                        // 3) Get settings menu.
                        const menu = await waitFor(() => findSettingsMenu(), 6000, 120);
                        if (!menu) return { success: false, error: 'settings-menu-not-opened', steps };

                        const isImage = cfg.mode === 'create-image';
                        const wantRatio = normalizeAspectRatio(cfg.aspectRatio);
                        const wantModel = isImage
                            ? normText(cfg.imageModel || 'nano banana 2')
                            : normText(cfg.videoModel || 'veo 3.1 - lite [lower priority]');

                        // 4) Mode
                        const modeTab =
                            (isImage
                                ? menu.querySelector("button[role='tab'][id$='trigger-IMAGE']")
                                : menu.querySelector("button[role='tab'][id$='trigger-VIDEO']")) ||
                            Array.from(menu.querySelectorAll("button[role='tab']")).find(b => {
                                const t = normText(b.textContent);
                                return isImage ? (t === 'image' || t.includes('imagem')) : t.includes('video');
                            });
                        if (!modeTab) return { success: false, error: 'mode-tab-not-found', steps };
                        humanClick(modeTab);
                        await sleep(350);
                        steps.push('mode:' + (isImage ? 'image' : 'video'));

                        // 5) Aspect ratio
                        const ratioIdSuffixByValue = {
                            '16:9': 'LANDSCAPE',
                            '4:3': 'LANDSCAPE_4_3',
                            '1:1': 'SQUARE',
                            '3:4': 'PORTRAIT_3_4',
                            '9:16': 'PORTRAIT'
                        };
                        const ratioLabelsByValue = {
                            '16:9': ['paisagem', 'landscape', '16:9'],
                            '4:3': ['4:3'],
                            '1:1': ['quadrado', 'square', '1:1'],
                            '3:4': ['3:4'],
                            '9:16': ['retrato', 'portrait', '9:16']
                        };
                        const ratioTab =
                            menu.querySelector(`button[role='tab'][id$='trigger-${ratioIdSuffixByValue[wantRatio] || 'LANDSCAPE'}']`) ||
                            Array.from(menu.querySelectorAll("button[role='tab']")).find(b => {
                                const t = normText(b.textContent);
                                return (ratioLabelsByValue[wantRatio] || ratioLabelsByValue['16:9']).some(label => t.includes(label));
                            });
                        if (!ratioTab) return { success: false, error: 'ratio-tab-not-found', steps };
                        humanClick(ratioTab);
                        await sleep(320);
                        steps.push('ratio:' + wantRatio);

                        // 6) Quantity x1
                        const qtyTab =
                            menu.querySelector("button[role='tab'][id$='trigger-1']") ||
                            Array.from(menu.querySelectorAll("button[role='tab']")).find(b => normText(b.textContent) === 'x1');
                        if (!qtyTab) return { success: false, error: 'qty-x1-tab-not-found', steps };
                        humanClick(qtyTab);
                        await sleep(280);
                        steps.push('qty:x1');

                        // 7) Model Selection (Unified Image/Video)
                        if (true) {
                            const menusBefore = Array.from(document.querySelectorAll("[role='menu']")).filter(isVisible);

                            // Image-specific mapping logic (keep existing user pattern)
                            let wantedModelKey = '';
                            let wantedUiModel = wantModel;

                            if (isImage) {
                                wantedModelKey = String(cfg.modelKey || '').trim() ||
                                    (wantModel.includes('pro') ? 'nb_pro' :
                                        ((wantModel.includes('imagen') || wantModel.includes('image 4') || wantModel.includes('imagem 4')) ? 'img4' : 'nb2'));

                                wantedUiModel = wantedModelKey === 'nb_pro' ? 'nano banana pro' : (wantedModelKey === 'img4' ? 'image 4' : 'nano banana 2');
                            }

                            const isModelButton = (b) => {
                                if (!isVisible(b)) return false;
                                const t = normText(b.textContent);
                                const hasArrow = Array.from(b.querySelectorAll('i')).some(i => normText(i.textContent) === 'arrow_drop_down');
                                const kws = isImage
                                    ? ['nano banana', 'imagen', 'image 4', 'imagem 4']
                                    : ['veo', 'fast', 'quality', 'video'];
                                return hasArrow && (kws.some(k => t.includes(k)) || b.id.includes('radix'));
                            };

                            let modelDrop = Array.from(menu.querySelectorAll("button,[role='combobox']")).find(isModelButton) ||
                                byXPath("//button[.//i[normalize-space(text())='arrow_drop_down'] and (contains(.,'Nano Banana') or contains(.,'Imagen') or contains(.,'Image 4') or contains(.,'Veo'))]");

                            if (!modelDrop) return { success: false, error: 'model-dropdown-not-found', steps };
                            log('Opening model dropdown:', modelDrop.textContent.trim());
                            humanClick(modelDrop);
                            await sleep(600);

                            const modelMenu = await waitFor(() => {
                                const menus = Array.from(document.querySelectorAll("[role='menu'], .DropdownMenuContent")).filter(isVisible);
                                return menus.find(m => {
                                    if (menusBefore.includes(m)) return false;
                                    const t = normText(m.textContent);
                                    const kws = isImage ? ['nano banana', 'imagen', 'image 4'] : ['veo', 'fast', 'quality'];
                                    return kws.some(k => t.includes(k));
                                });
                            }, 5000, 150);

                            if (!modelMenu) return { success: false, error: 'model-menu-not-found', steps };

                            let items = Array.from(modelMenu.querySelectorAll("[role='menuitem'], [role='menuitemradio'], [role='option'], button"));

                            const scoreItem = (itemEl, modelToMatch) => {
                                const t = normText(itemEl.textContent);
                                if (!t) return -1;

                                if (isImage) {
                                    const hasNb = t.includes('nano banana');
                                    const hasPro = t.includes('pro');
                                    const hasImg4 = t.includes('image 4') || t.includes('imagen 4');
                                    if (wantedModelKey === 'nb_pro') return (hasNb && hasPro) ? 100 : (hasNb ? 50 : 0);
                                    if (wantedModelKey === 'nb2') return (hasNb && !hasPro) ? 100 : (hasNb ? 40 : 0);
                                    if (hasImg4) return 100;
                                    return 0;
                                } else {
                                    // Video logic: fuzzy matching
                                    const target = modelToMatch || wantModel;
                                    if (t === target) return 100;
                                    if (t.includes(target) || target.includes(t)) return 80;
                                    // Split and match parts (e.g., "veo 2" and "fast")
                                    const parts = target.split(/[\s-]+/).filter(p => p !== 'lower' && p !== 'priority' && !p.includes('[') && !p.includes(']'));
                                    const matches = parts.filter(p => p.length > 1 && t.includes(p)).length;
                                    return matches * 20;
                                }
                            };

                            let bestItem = null;
                            let bestScore = -1;
                            for (const item of items) {
                                const s = scoreItem(item, wantModel);
                                if (s > bestScore) {
                                    bestScore = s;
                                    bestItem = item;
                                }
                            }

                            // Fallback: se for 'lower priority' e não encontrou item com score bom, tenta sem o suffix
                            if ((!bestItem || bestScore <= 0) && !isImage && wantModel.includes('[lower priority]')) {
                                const fallbackModel = wantModel.replace(/\s*\[lower priority\]/i, '').trim();
                                log('Modelo [Lower Priority] nao encontrado, tentando fallback:', fallbackModel);
                                bestItem = null;
                                bestScore = -1;
                                for (const item of items) {
                                    const s = scoreItem(item, fallbackModel);
                                    if (s > bestScore) { bestScore = s; bestItem = item; }
                                }
                            }

                            if (!bestItem || bestScore <= 0) {
                                return { success: false, error: 'model-target-not-found', wantModel, available: items.slice(0, 5).map(i => i.textContent.trim()) };
                            }

                            log('Clicking model:', bestItem.textContent.trim(), 'score:', bestScore);
                            humanClick(bestItem);
                            await sleep(500);

                            // Verification Logic
                            const verified = await waitFor(() => {
                                const currentText = normText(modelDrop.textContent);
                                if (isImage) {
                                    if (wantedUiModel === 'nano banana pro') return currentText.includes('nano banana pro');
                                    if (wantedUiModel === 'nano banana 2') return currentText.includes('nano banana') && !currentText.includes('pro');
                                    return currentText.includes('image 4') || currentText.includes('imagen 4');
                                } else {
                                    // For video, exact or partial match on the trigger button text
                                    return currentText.includes(wantModel) || wantModel.includes(currentText) || currentText.includes('veo');
                                }
                            }, 4000, 200);

                            if (!verified) log('Warning: Model selection could not be verified, but continuing...');

                            steps.push('model:' + wantModel);
                        }

                        // 8) Close panel
                        pressEscape();
                        await sleep(300);
                        steps.push('done');
                        return { success: true, steps };
                    } catch (e) {
                        log('Error in selectSettings:', e.message);
                        try { pressEscape(); } catch (_) { }
                        return { success: false, error: e?.message || String(e), steps };
                    }
                })();
            },
            args: [config]
        });

        const result = results?.[0]?.result;
        console.log('[BG] mainWorldSelectSettings result:', JSON.stringify(result));
        return { success: result?.success ?? false, result };
    } catch (e) {
        console.error('[BG] mainWorldSelectSettings error:', e.message);
        return { success: false, error: e.message };
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

    console.log('[BG] Registering download:', (urlBase || 'unknown').substring(0, 80) + '...', '->', filename);

    pendingDownloadQueue.push({
        urlBase: urlBase,
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

const FLOW_HOME_URL = 'https://labs.google/fx/tools/flow';

function isFlowToolsUrl(url) {
    const u = String(url || '').toLowerCase();
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
            const byIcon = buttons.find(btn => {
                const icon = String(btn.querySelector('i')?.textContent || '').trim().toLowerCase();
                return icon === 'add_2';
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
            config: {
                mode: config.mode,
                imageModel: config.imageModel,
                videoModel: config.videoModel,
                doUpscale: config.doUpscale,
                aspectRatio: config.aspectRatio,
                imageResolution: config.imageResolution,
                videoResolution: config.videoResolution,
                videoDuration: config.videoDuration,
                generationTimeout: config.generationTimeout,
                generationTimeout: config.generationTimeout,
                totalPrompts: totalItems,
                randomizeAspectRatio: config.randomizeAspectRatio,
                randomizeAspectRatio: config.randomizeAspectRatio,
                randomIncludeLandscape43: config.randomIncludeLandscape43,
                randomIncludeSquare: config.randomIncludeSquare,
                randomIncludePortrait34: config.randomIncludePortrait34,
                randomIncludePortrait: config.randomIncludePortrait,
                randomIncludeLandscape: config.randomIncludeLandscape
            }
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
            config: {
                mode: config.mode,
                imageModel: config.imageModel,
                videoModel: config.videoModel,
                doUpscale: config.doUpscale,
                aspectRatio: config.aspectRatio,
                imageResolution: config.imageResolution,
                videoResolution: config.videoResolution,
                videoDuration: config.videoDuration,
                generationTimeout: config.generationTimeout,
                generationTimeout: config.generationTimeout,
                totalPrompts: totalItems,
                randomizeAspectRatio: config.randomizeAspectRatio,
                randomizeAspectRatio: config.randomizeAspectRatio,
                randomIncludeLandscape43: config.randomIncludeLandscape43,
                randomIncludeSquare: config.randomIncludeSquare,
                randomIncludePortrait34: config.randomIncludePortrait34,
                randomIncludePortrait: config.randomIncludePortrait,
                randomIncludeLandscape: config.randomIncludeLandscape
            }
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
        itemUrl.includes('googleusercontent.com') ||
        itemUrl.includes('getMediaUrlRedirect') ||
        itemUrl.includes('googlevideo.com') ||
        itemUrl.includes('blob:https://labs.google') ||
        downloadItem.referrer?.includes('labs.google');

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

    // 2. Check the queue for a match
    const isFlowRedirect = itemUrl.includes('getMediaUrlRedirect');
    const itemUrlBase = isFlowRedirect ? itemUrl : itemUrl.split('?')[0];

    // Priority 1: Exact URL match
    let index = pendingDownloadQueue.findIndex(q => q.urlBase && q.urlBase === itemUrlBase);

    // Priority 2: Automation is running and it's a Flow URL, matching time window
    const timeSinceLastReg = Date.now() - (automationState.lastRegistrationTime || 0);
    if (index === -1 && isFlowUrl && pendingDownloadQueue.length > 0 && timeSinceLastReg < 120000) {
        console.log('[BG] Matching by time window (<120s) for Flow URL');
        index = 0;
    }

    if (index !== -1) {
        const match = pendingDownloadQueue.splice(index, 1)[0];
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
