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
    downloadPhase: 'none', // 'none', 'waiting_for_edit_view', 'selecting_resolution', 'waiting_for_upscale'
    targetResolution: '2k',
    lastRegistrationTime: 0
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
async function mainWorldReactClick(tabId, xpath) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (xpathStr) => {
                const el = document.evaluate(xpathStr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (!el) return { success: false, reason: 'not found: ' + xpathStr };

                try {
                    const rect = el.getBoundingClientRect();
                    const x = rect.left + Math.max(6, Math.min(rect.width - 6, rect.width * 0.5));
                    const y = rect.top + Math.max(6, Math.min(rect.height - 6, rect.height * 0.5));
                    const common = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

                    let pointerDownPrevented = false;
                    try {
                        el.dispatchEvent(new PointerEvent('pointerover', common));
                        el.dispatchEvent(new PointerEvent('pointermove', common));
                        const pDown = new PointerEvent('pointerdown', common);
                        el.dispatchEvent(pDown);
                        pointerDownPrevented = pDown.defaultPrevented;
                    } catch (_) { }

                    el.dispatchEvent(new MouseEvent('mouseover', common));
                    el.dispatchEvent(new MouseEvent('mousemove', common));
                    el.dispatchEvent(new MouseEvent('mousedown', common));
                    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

                    try { el.dispatchEvent(new PointerEvent('pointerup', common)); } catch (_) { }
                    el.dispatchEvent(new MouseEvent('mouseup', common));
                    if (!pointerDownPrevented) {
                        el.dispatchEvent(new MouseEvent('click', common));
                    }
                    return { success: true, method: 'humanClick', x, y };
                } catch (e) {
                    try { el.click(); } catch (_) { }
                    return { success: true, method: 'native.click.fallback', error: e.message };
                }
            },
            args: [xpath]
        });
        const result = results?.[0]?.result;
        console.log('[BG] mainWorldReactClick result:', JSON.stringify(result));
        return { success: result?.success ?? false, result };
    } catch (e) {
        console.error('[BG] mainWorldReactClick error:', e.message);
        return { success: false, error: e.message };
    }
}

// ===== Main World Text Injection (Slate/Lexical editor.apply() approach) =====
// Key insight: use the Slate editor's internal apply() to insert text directly,
// bypassing all event/isTrusted restrictions. Falls back to CDP insertText.
async function mainWorldFillText(tabId, text) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (promptText) => {
                // Helper: find Slate editor object from a DOM element's React fiber
                function isSlateEditor(candidate) {
                    if (!candidate || typeof candidate !== 'object') return false;
                    return typeof candidate.insertText === 'function' &&
                        (typeof candidate.deleteBackward === 'function' || typeof candidate.deleteFragment === 'function');
                }

                function findSlateEditorFromEl(el) {
                    const root = el?.matches?.('[data-slate-editor="true"]') ? el : el?.closest?.('[data-slate-editor="true"]');
                    if (!root) return null;
                    const reactKeys = Object.keys(root).filter(k => k.startsWith('__react'));
                    for (const key of reactKeys) {
                        const value = root[key];
                        try {
                            if (key.startsWith('__reactProps') && isSlateEditor(value?.editor)) return value.editor;
                        } catch (_) { }
                        // Fiber walk
                        const stack = [value];
                        const visited = new Set();
                        let scanned = 0;
                        while (stack.length > 0 && scanned < 4000) {
                            const node = stack.pop();
                            if (!node || (typeof node !== 'object' && typeof node !== 'function') || visited.has(node)) continue;
                            visited.add(node);
                            scanned++;
                            const candidates = [
                                node?.memoizedProps?.editor, node?.memoizedState?.editor,
                                node?.pendingProps?.editor, node?.stateNode?.editor, node?.editor
                            ];
                            for (const c of candidates) if (isSlateEditor(c)) return c;
                            if (node.child) stack.push(node.child);
                            if (node.sibling) stack.push(node.sibling);
                            if (node.return) stack.push(node.return);
                        }
                    }
                    return null;
                }

                // Find the editor element
                const slateEl = document.querySelector('[data-slate-editor="true"]') ||
                    document.querySelector('[role="textbox"][contenteditable="true"]') ||
                    document.querySelector('[role="textbox"]');
                if (!slateEl) return { success: false, reason: 'editor element not found' };

                // Try Slate editor.apply() approach (most reliable)
                const editor = findSlateEditorFromEl(slateEl);
                if (editor) {
                    try {
                        slateEl.focus();
                        // Clear existing text
                        const existingText = String(editor?.children?.[0]?.children?.[0]?.text || '');
                        if (existingText) {
                            try { editor.apply({ type: 'remove_text', path: [0, 0], offset: 0, text: existingText }); } catch (_) { }
                        }
                        // Insert new text
                        editor.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: promptText });
                        if (typeof editor.onChange === 'function') editor.onChange();
                        slateEl.dispatchEvent(new Event('input', { bubbles: true }));
                        slateEl.dispatchEvent(new Event('change', { bubbles: true }));

                        // Verify
                        const committed = String(editor?.children?.[0]?.children?.[0]?.text || '');
                        if (committed.includes(promptText.slice(0, 20))) {
                            return { success: true, method: 'slate.apply', length: committed.length };
                        }
                    } catch (e) {
                        console.warn('slate.apply failed:', e.message);
                    }
                }

                // Fallback: execCommand in main world context
                try {
                    slateEl.focus();
                    document.execCommand('selectAll', false, null);
                    document.execCommand('delete', false, null);
                    slateEl.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: promptText, bubbles: true, cancelable: true }));
                    const inserted = document.execCommand('insertText', false, promptText);
                    if (inserted) {
                        slateEl.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: promptText, bubbles: true }));
                        return { success: true, method: 'execCommand', length: slateEl.textContent?.length };
                    }
                } catch (e2) { }

                return { success: false, reason: 'all methods failed' };
            },
            args: [text]
        });
        const result = results?.[0]?.result;
        console.log('[BG] mainWorldFillText result:', JSON.stringify(result));
        if (result?.success) return { success: true, result };

        // Final fallback: CDP Input.insertText
        const target = { tabId };
        try {
            await chrome.scripting.executeScript({
                target: { tabId }, world: 'MAIN',
                func: () => {
                    const el = document.querySelector('[data-slate-editor="true"], [role="textbox"]');
                    if (el) { el.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }
                }
            });
            await new Promise(r => setTimeout(r, 100));
            await chrome.debugger.attach(target, '1.3');
            await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
            await chrome.debugger.detach(target);
            return { success: true, method: 'cdp-insertText' };
        } catch (e2) {
            try { await chrome.debugger.detach(target); } catch (_) { }
            return { success: false, error: e2.message };
        }
    } catch (e) {
        console.error('[BG] mainWorldFillText error:', e.message);
        return { success: false, error: e.message };
    }
}



// ===== Main World Settings Selection =====
// Uses simple .click() - confirmed working by browser testing.
// The working reference extension (lhcmnhdbddgagibbbgppakocflbnknoa) also uses only .click()
// Config: { mode: 'create-image'|'text-to-video'|'image-to-video',
//           imageModel: 'Nano Banana 2'|'Nano Banana Pro'|'Imagen 4',
//           aspectRatio: 'landscape'|'portrait' }
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

                function findSettingsMenu() {
                    const menus = Array.from(document.querySelectorAll("[role='menu']")).filter(isVisible);
                    return menus.find(m => {
                        const t = normText(m.textContent);
                        return t.includes('image') || t.includes('video') || t.includes('paisagem') || t.includes('retrato') || t.includes('portrait') || t.includes('landscape');
                    }) || null;
                }

                return (async () => {
                    const steps = [];
                    try {
                        // 1) Close previous popovers.
                        pressEscape();
                        await sleep(250);

                        // 2) Open settings panel.
                        const trigger = await waitFor(
                            () => byXPath("//button[descendant::i[normalize-space(text())='crop_16_9' or normalize-space(text())='crop_9_16']]"),
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
                        const wantPortrait = cfg.aspectRatio === 'portrait';
                        const wantModel = normText(cfg.imageModel || 'nano banana 2');

                        // 4) Mode
                        const modeTab =
                            (isImage
                                ? menu.querySelector("button[role='tab'][id$='trigger-IMAGE']")
                                : menu.querySelector("button[role='tab'][id$='trigger-VIDEO']")) ||
                            Array.from(menu.querySelectorAll("button[role='tab']")).find(b => {
                                const t = normText(b.textContent);
                                return isImage ? t.includes('image') : t.includes('video');
                            });
                        if (!modeTab) return { success: false, error: 'mode-tab-not-found', steps };
                        humanClick(modeTab);
                        await sleep(350);
                        steps.push('mode:' + (isImage ? 'image' : 'video'));

                        // 5) Aspect ratio (always apply selected one)
                        const ratioTab =
                            (wantPortrait
                                ? menu.querySelector("button[role='tab'][id$='trigger-PORTRAIT']")
                                : menu.querySelector("button[role='tab'][id$='trigger-LANDSCAPE']")) ||
                            Array.from(menu.querySelectorAll("button[role='tab']")).find(b => {
                                const t = normText(b.textContent);
                                return wantPortrait
                                    ? (t.includes('retrato') || t.includes('portrait') || t.includes('9:16'))
                                    : (t.includes('paisagem') || t.includes('landscape') || t.includes('16:9'));
                            });
                        if (!ratioTab) return { success: false, error: 'ratio-tab-not-found', steps };
                        humanClick(ratioTab);
                        await sleep(320);
                        steps.push('ratio:' + (wantPortrait ? 'portrait' : 'landscape'));

                        // 6) Quantity x1 (always force x1)
                        const qtyTab =
                            menu.querySelector("button[role='tab'][id$='trigger-1']") ||
                            Array.from(menu.querySelectorAll("button[role='tab']")).find(b => normText(b.textContent) === 'x1');
                        if (!qtyTab) return { success: false, error: 'qty-x1-tab-not-found', steps };
                        humanClick(qtyTab);
                        await sleep(280);
                        steps.push('qty:x1');

                        // 7) Model (image only)
                        if (isImage) {
                            const menusBefore = Array.from(document.querySelectorAll("[role='menu']")).filter(isVisible);
                            const wantedModelKey = String(cfg.modelKey || '').trim() ||
                                (wantModel.includes('pro')
                                    ? 'nb_pro'
                                    : ((wantModel.includes('imagen') || wantModel.includes('image 4') || wantModel.includes('imagem 4'))
                                        ? 'img4'
                                        : 'nb2'));
                            const wantedUiModel = wantedModelKey === 'nb_pro'
                                ? 'nano banana pro'
                                : (wantedModelKey === 'img4' ? 'image 4' : 'nano banana 2');
                            let modelDrop =
                                Array.from(menu.querySelectorAll("button,[role='combobox']")).find(b => {
                                    if (!isVisible(b)) return false;
                                    const t = normText(b.textContent);
                                    const hasArrow = Array.from(b.querySelectorAll('i')).some(i => normText(i.textContent) === 'arrow_drop_down');
                                    return hasArrow && (
                                        t.includes('nano banana') || t.includes('imagen') || t.includes('image 4') || t.includes('imagem 4')
                                    );
                                }) ||
                                byXPath("//button[.//i[normalize-space(text())='arrow_drop_down'] and (contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),'nano banana') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),'imagen') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),'image 4') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),'imagem 4'))]");

                            if (!modelDrop) return { success: false, error: 'model-dropdown-not-found', steps };
                            humanClick(modelDrop);
                            await sleep(550);

                            const modelMenu = await waitFor(() => {
                                const menus = Array.from(document.querySelectorAll("[role='menu']")).filter(isVisible);
                                const pick = (arr) => arr.find(m => {
                                    const hasItems = m.querySelector("[role='menuitem'], [role='menuitemradio'], [role='option']");
                                    if (!hasItems) return false;
                                    const t = normText(m.textContent);
                                    return t.includes('nano banana') || t.includes('imagen') || t.includes('image 4') || t.includes('imagem 4');
                                }) || null;
                                const newer = menus.filter(m => !menusBefore.includes(m));
                                return pick(newer) || pick(menus);
                            }, 5000, 100);
                            if (!modelMenu) return { success: false, error: 'model-menu-not-found', steps };

                            let items = Array.from(modelMenu.querySelectorAll("[role='menuitem'], [role='menuitemradio'], [role='option']"));
                            if (!items.length) {
                                items = Array.from(modelMenu.querySelectorAll('button,div')).filter(el => {
                                    if (!isVisible(el)) return false;
                                    const t = normText(el.textContent);
                                    return t.includes('nano banana') || t.includes('imagen') || t.includes('image 4') || t.includes('imagem 4');
                                });
                            }
                            if (!items.length) return { success: false, error: 'model-items-not-found', steps };
                            const sortedItems = items
                                .slice()
                                .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

                            const scoreItem = (itemText) => {
                                const t = normText(itemText);
                                if (!t) return -1;
                                const hasNb = t.includes('nano banana');
                                const hasPro = t.includes('pro');
                                const hasImg4 = t.includes('image 4') || t.includes('imagen 4') || t.includes('imagem 4');
                                if (wantedModelKey === 'nb_pro') {
                                    if (hasNb && hasPro) return 100;
                                    if (hasNb) return 50;
                                    return 0;
                                }
                                if (wantedModelKey === 'nb2') {
                                    if (hasNb && !hasPro) return 100;
                                    if (hasNb) return 40;
                                    return 0;
                                }
                                // img4
                                if (hasImg4 && !hasNb) return 100;
                                if (hasImg4) return 70;
                                return 0;
                            };

                            let target = null;
                            let bestScore = -1;
                            for (const item of items) {
                                const s = scoreItem(item.textContent);
                                if (s > bestScore) {
                                    bestScore = s;
                                    target = item;
                                }
                            }
                            // Fallback by position (same order shown in Flow UI screenshot):
                            // 1) Nano Banana Pro, 2) Nano Banana 2, 3) Image/Imagen 4
                            if (!target || bestScore <= 0) {
                                const idx = wantedModelKey === 'nb_pro' ? 0 : (wantedModelKey === 'nb2' ? 1 : 2);
                                if (sortedItems[idx]) {
                                    target = sortedItems[idx];
                                    bestScore = 1;
                                }
                            }
                            if (!target || bestScore <= 0) {
                                return {
                                    success: false,
                                    error: 'model-target-not-found',
                                    wantModel,
                                    wantedModelKey,
                                    available: sortedItems.map(i => i.textContent?.trim())
                                };
                            }

                            const interactiveTarget = target.closest?.("[role='menuitem'], [role='menuitemradio'], [role='option'], button, [tabindex]") || target;
                            humanClick(interactiveTarget);
                            await sleep(420);

                            // Confirm model was really applied before continuing.
                            const modelApplied = await waitFor(() => {
                                const targetTxt = normText(interactiveTarget?.textContent || '');
                                const checked = interactiveTarget?.getAttribute?.('aria-checked') === 'true' ||
                                    interactiveTarget?.getAttribute?.('data-state') === 'checked' ||
                                    interactiveTarget?.getAttribute?.('data-state') === 'active';
                                if (checked && targetTxt) {
                                    if (wantedUiModel === 'nano banana pro') return targetTxt.includes('nano banana pro');
                                    if (wantedUiModel === 'nano banana 2') return targetTxt.includes('nano banana') && !targetTxt.includes('pro');
                                    return targetTxt.includes('image 4') || targetTxt.includes('imagen 4') || targetTxt.includes('imagem 4');
                                }
                                const t = normText(modelDrop?.textContent || '');
                                if (wantedUiModel === 'nano banana pro') return t.includes('nano banana pro');
                                if (wantedUiModel === 'nano banana 2') return t.includes('nano banana') && !t.includes('pro');
                                return t.includes('image 4') || t.includes('imagen 4') || t.includes('imagem 4');
                            }, 3500, 120);
                            if (!modelApplied) {
                                return {
                                    success: false,
                                    error: 'model-not-confirmed',
                                    wantModel,
                                    wantedModelKey,
                                    modelDropText: modelDrop?.textContent?.trim() || ''
                                };
                            }
                            steps.push('model:' + (cfg.imageModel || 'Nano Banana 2'));
                        }

                        // 8) Close panel.
                        pressEscape();
                        await sleep(250);
                        steps.push('done');
                        return { success: true, steps };
                    } catch (e) {
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
        processedSinceLastPause: 0
    };

    const imageCount = config.imageCount || (config.images ? config.images.length : 0);
    const totalItems = imageCount > 0 ? imageCount : config.prompts.length;

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

    if (!automationState.isProcessing || automationState.currentIndex >= totalItems) {
        if (automationState.isProcessing) stopAutomation();
        return;
    }

    const prompt = prompts.length > 0
        ? prompts[automationState.currentIndex % prompts.length]
        : '';

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
                doUpscale: config.doUpscale,
                aspectRatio: config.aspectRatio,
                imageResolution: config.imageResolution,
                generationTimeout: config.generationTimeout,
                generationTimeout: config.generationTimeout,
                totalPrompts: totalItems,
                randomizeAspectRatio: config.randomizeAspectRatio,
                randomizeAspectRatio: config.randomizeAspectRatio,
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
                doUpscale: config.doUpscale,
                aspectRatio: config.aspectRatio,
                imageResolution: config.imageResolution,
                generationTimeout: config.generationTimeout,
                generationTimeout: config.generationTimeout,
                totalPrompts: totalItems,
                randomizeAspectRatio: config.randomizeAspectRatio,
                randomizeAspectRatio: config.randomizeAspectRatio,
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
    if (automationState.isProcessing && automationState.currentIndex < automationState.prompts.length) {
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
        suggest({ filename: match.filename, conflictAction: 'uniquify' });
    } else {
        console.log('[BG] Download from Flow but no matching queue item. Letting it pass.');
        suggest();
    }
});

console.log('[BG] Background script loaded');