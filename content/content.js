
// ===== Flow Automator Content Script =====
console.log('[Flow Automator] Content script loaded');

// ===== Selectors for Google Flow =====
const SELECTORS = {
    PROMPT_TEXTAREA_XPATH: "//div[@role='textbox']",
    GENERATE_BUTTON_XPATH: "//button[.//i[text()='arrow_forward'] or contains(., 'arrow_forward')]",
    // Settings trigger button confirmed by browser inspection
    SETTINGS_POPOVER_TRIGGER_XPATH: "//button[descendant::i[text()='crop_16_9' or text()='crop_9_16']]",
    QUEUE_FULL_POPUP_XPATH: "//li[@data-sonner-toast and .//i[normalize-space(text())='error'] and .//*[contains(., '5')]]",
    PROMPT_POLICY_ERROR_POPUP_XPATH: "//li[@data-sonner-toast and .//i[normalize-space(text())='error'] and not(.//*[contains(., '5')])]",
    START_IMAGE_ADD_BUTTON_XPATH: "//button[.//i[text()='add'] or .//svg]",
    HIDDEN_FILE_INPUT_XPATH: '//input[@type="file"]',
    UPLOAD_SPINNER_XPATH: "//i[contains(text(), 'progress_activity')]",
    OPEN_MEDIA_DIALOG_XPATH: "//div[@role='dialog' and @data-state='open']",
    MEDIA_DIALOG_UPLOAD_BUTTON_XPATH: "//div[@role='dialog' and @data-state='open']//button[.//i[normalize-space(text())='upload']]"
};

const IMAGE_DOWNLOAD_OPTIONS = {
    '1k': ['1K', 'Download 1K', 'Standard', 'Padrao'],
    '2k': ['2K', 'Download 2K', 'High', 'Alta'],
    '4k': ['4K', 'Download 4K', 'Ultra', 'Maxima']
};

const IMAGE_RESULT_SELECTOR = 'img[src*="storage.googleapis.com"], img[src*="googleusercontent.com"], img[src^="blob:"], img[src*="getMediaUrlRedirect"]';
const VIDEO_RESULT_SELECTOR = 'video[src*="storage.googleapis.com"], video[src*="googleusercontent.com"], video[src^="blob:"], video[src*="getMediaUrlRedirect"]';

// ===== State =====
let isProcessing = false;
let currentPromptText = '';
let lastFlowDownloadDetectedAt = 0;

// ===== Message Handler =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Flow Automator] Received message:', message.type);
    if (message.type === 'processPrompt') {
        processPrompt(message.prompt, message.index, message.config, message.image);
        sendResponse({ received: true });
    } else if (message.type === 'ping') {
        sendResponse({ pong: true });
    } else if (message.type === 'complete') {
        // Show completion screen
        showComplete(message.success || 0, message.failed || 0);
        sendResponse({ received: true });
    } else if (message.type === 'paused') {
        // Update overlay to show paused state
        handlePaused(message);
        sendResponse({ received: true });
    } else if (message.type === 'unpaused') {
        // Update overlay to show resumed state
        handleUnpaused();
        sendResponse({ received: true });
    } else if (message.type === 'flowDownloadDetected') {
        lastFlowDownloadDetectedAt = Date.now();
        console.log('[Flow Automator] Flow download detected by background:', message.filename || message.url || '');
        sendResponse({ received: true });
    }
    return true;
});

// ===== Helper: Click Element by XPath =====
function clickElementByXPath(xpath) {
    try {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (result) {
            try {
                result.click();
                return true;
            } catch (e) {
                try {
                    result.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                    return true;
                } catch (e) {
                    return false;
                }
            }
        }
        return false;
    } catch (e) {
        return false;
    }
}

// ===== Helper: React Click via __reactProps$ (React 17+ approach) =====
// Calls React event handlers directly on the element - bypasses isTrusted.
// Tries onPointerDown (used by Radix UI dropdowns) then onClick.
function rightClick(element) {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const events = ['contextmenu', 'mousedown', 'mouseup'];
    events.forEach(name => {
        element.dispatchEvent(new MouseEvent(name, {
            bubbles: true, cancelable: true, view: window, button: 2, clientX: x, clientY: y
        }));
    });
}
function reactClick(element) {
    if (!element) return false;

    const syntheticEvent = {
        stopPropagation: () => { },
        preventDefault: () => { },
        nativeEvent: { stopImmediatePropagation: () => { } },
        target: element,
        currentTarget: element,
        bubbles: true,
        button: 0,
        isPrimary: true,
        type: 'pointerdown'
    };

    try {
        // React 17+: props stored directly on DOM node as __reactProps$xxx
        const propsKey = Object.keys(element).find(k => k.startsWith('__reactProps$'));
        if (propsKey) {
            const props = element[propsKey];
            // Radix DropdownMenu.Item uses onPointerDown for selection
            if (props.onPointerDown) {
                props.onPointerDown({ ...syntheticEvent, type: 'pointerdown' });
                return true;
            }
            if (props.onMouseDown) {
                props.onMouseDown({ ...syntheticEvent, type: 'mousedown' });
                return true;
            }
            if (props.onClick) {
                props.onClick({ ...syntheticEvent, type: 'click' });
                return true;
            }
        }

        // Fallback: React fiber walk
        const fiberKey = Object.keys(element).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (fiberKey) {
            let fiber = element[fiberKey];
            while (fiber) {
                const props = fiber.memoizedProps || fiber.pendingProps;
                if (props && (props.onPointerDown || props.onClick || props.onMouseDown)) {
                    if (props.onPointerDown) props.onPointerDown({ ...syntheticEvent, type: 'pointerdown' });
                    else if (props.onMouseDown) props.onMouseDown({ ...syntheticEvent, type: 'mousedown' });
                    else if (props.onClick) props.onClick({ ...syntheticEvent, type: 'click' });
                    return true;
                }
                fiber = fiber.return;
            }
        }
    } catch (e) {
        console.warn('[Flow Automator] reactClick failed:', e.message);
    }

    // Final fallback: native click
    element.click();
    return true;
}


async function realClickElement(element) {
    // For elements we have a reference to but need main-world access,
    // build an XPath from the element's position in DOM if possible
    // then use mainWorldReactClick. For simplicity, just use reactClick from isolated world.
    return reactClick(element);
}

// Primary function: routes click through background script into PAGE's main world
// where React handlers are fully accessible without isTrusted restrictions.
async function realClickByXPath(xpath) {
    return new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'mainWorldReactClick', xpath }, (res) => {
            if (chrome.runtime.lastError) {
                console.warn('[Flow Automator] mainWorldReactClick error:', chrome.runtime.lastError.message);
                // Fallback to direct click
                const el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (el) el.click();
                resolve(false);
            } else {
                console.log('[Flow Automator] mainWorldReactClick:', JSON.stringify(res));
                resolve(res && res.success);
            }
        });
    });
}


// ===== Helper: Wait for Element by XPath =====
async function waitForElementByXPath(xpath, timeout = 5000) {
    let timeLeft = timeout;
    while (timeLeft > 0) {
        const element = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (element) return element;
        await sleep(500);
        timeLeft -= 500;
    }
    return null;
}

// ===== Helper: Fill Prompt Input via Main World =====
// Uses clipboard paste (best for Lexical) executed directly in page main world.
async function fillPromptInput(promptText) {
    // First ensure element exists            
    const input = document.evaluate(SELECTORS.PROMPT_TEXTAREA_XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    if (!input) return false;

    // Route through background -> executeScript(world:'MAIN') for reliable Lexical injection
    return new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'mainWorldFillText', text: promptText }, (res) => {
            if (chrome.runtime.lastError || !res?.success) {
                console.warn('[Flow Automator] mainWorldFillText failed, using fallback:', chrome.runtime.lastError?.message);
                // Fallback: old execCommand approach
                try {
                    input.focus();
                    document.execCommand('selectAll', false, null);
                    document.execCommand('delete', false, null);
                    input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: promptText, bubbles: true, cancelable: true }));
                    document.execCommand('insertText', false, promptText);
                    input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: promptText, bubbles: true, cancelable: true }));
                    resolve(true);
                } catch (e) {
                    console.error('[Flow Automator] Fill prompt fallback failed:', e);
                    resolve(false);
                }
            } else {
                console.log('[Flow Automator] mainWorldFillText result:', JSON.stringify(res));
                resolve(true);
            }
        });
    });
}


// ===== Settings Selection (all in MAIN world via background.js) =====
// Uses afHumanClick (with clientX/clientY) - confirmed working approach from reference extension.
// Selectors confirmed by browser inspection:
//   Mode tabs:   button[role='tab'][id$='trigger-IMAGE'] / trigger-VIDEO
//   Ratio tabs:  button[role='tab'][id$='trigger-LANDSCAPE'] / trigger-PORTRAIT
//   Quantity:    button[role='tab'][id$='trigger-1']
//   Model dropdown: button with arrow_drop_down inside div[role='menu']
//   Model items: div[role='menuitem'] containing model name text
async function applyFlowSettings(config) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'mainWorldSelectSettings', config }, (res) => {
            if (chrome.runtime.lastError) {
                console.error('[Flow Automator] mainWorldSelectSettings error:', chrome.runtime.lastError.message);
                resolve(false);
            } else {
                console.log('[Flow Automator] mainWorldSelectSettings result:', JSON.stringify(res));
                resolve(!!res?.success);
            }
        });
    });
}

// Legacy aliases (kept for processPrompt compatibility)
async function openSettingsPopover() {
    const btn = await waitForElementByXPath(SELECTORS.SETTINGS_POPOVER_TRIGGER_XPATH, 3000);
    if (!btn) return false;
    if (btn.getAttribute('aria-expanded') !== 'true') {
        const rect = btn.getBoundingClientRect();
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        await sleep(600);
    }
    return true;
}


// ===== Helper: Upload Image (Robust) =====
async function uploadImage(dataUrl, fileName, fileType, cropMode = 'landscape') {
    const norm = (v) => String(v || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
    };

    const listFileInputs = () => {
        const snapshot = document.evaluate(
            SELECTORS.HIDDEN_FILE_INPUT_XPATH,
            document,
            null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
            null
        );
        const out = [];
        for (let i = 0; i < snapshot.snapshotLength; i++) out.push(snapshot.snapshotItem(i));
        return out.filter(Boolean);
    };

    const waitForNewFileInput = async (beforeSet, timeoutMs = 6000) => {
        let left = timeoutMs;
        while (left > 0) {
            const now = listFileInputs();
            const fresh = now.find(el => !beforeSet.has(el));
            if (fresh) return fresh;
            await sleep(200);
            left -= 200;
        }
        return null;
    };

    const waitForOpenMediaDialog = async (timeoutMs = 3500) => {
        let left = timeoutMs;
        while (left > 0) {
            const dlg = document.evaluate(
                SELECTORS.OPEN_MEDIA_DIALOG_XPATH,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
            ).singleNodeValue;
            if (dlg && isVisible(dlg)) return dlg;
            await sleep(150);
            left -= 150;
        }
        return null;
    };

    const getOpenMediaDialog = () => {
        return document.evaluate(
            SELECTORS.OPEN_MEDIA_DIALOG_XPATH,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
        ).singleNodeValue;
    };

    const countSlotImages = () => {
        return document.querySelectorAll('button[data-card-open] img[src], button[data-card-open] [style*="background-image"]').length;
    };

    const waitForInitialSlotFilled = async (beforeCount, timeoutMs = 12000) => {
        let left = timeoutMs;
        while (left > 0) {
            const afterCount = countSlotImages();
            if (afterCount > beforeCount) return true;
            await sleep(250);
            left -= 250;
        }
        return false;
    };

    const clickElementSafe = async (el) => {
        if (!el) return false;
        try {
            reactClick(el);
            await sleep(220);
            return true;
        } catch (_) {
            try {
                el.click();
                await sleep(220);
                return true;
            } catch (_e) {
                return false;
            }
        }
    };

    const selectInitialSlot = async () => {
        const candidates = Array.from(document.querySelectorAll("[aria-haspopup='dialog'], [type='button'][aria-haspopup='dialog']"))
            .filter(isVisible);

        const initialBtn = candidates.find(el => {
            const t = norm(el.textContent);
            return t === 'inicial' || t === 'initial' || t.startsWith('inicial ') || t.startsWith('initial ') || t.includes(' inicial') || t.includes(' initial');
        });

        if (initialBtn) return clickElementSafe(initialBtn);
        return false;
    };

    const clickUploadInsideMediaDialog = async () => {
        const btnByXpath = document.evaluate(
            SELECTORS.MEDIA_DIALOG_UPLOAD_BUTTON_XPATH,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
        ).singleNodeValue;
        if (btnByXpath && isVisible(btnByXpath)) {
            return clickElementSafe(btnByXpath);
        }

        const dialog = document.evaluate(
            SELECTORS.OPEN_MEDIA_DIALOG_XPATH,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
        ).singleNodeValue;
        if (!dialog) return false;

        const buttons = Array.from(dialog.querySelectorAll('button')).filter(isVisible);
        const byIcon = buttons.find(b => {
            const icon = norm(b.querySelector('i')?.textContent || '');
            return icon === 'upload';
        });
        if (byIcon) return clickElementSafe(byIcon);

        return false;
    };

    const setFileOnInput = (inputEl, file) => {
        try {
            const dt = new DataTransfer();
            dt.items.add(file);
            inputEl.files = dt.files;
            inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            return true;
        } catch (e) {
            console.warn('[Flow Automator] setFileOnInput failed:', e?.message || e);
            return false;
        }
    };

    const buildUploadInputCandidates = (beforeSet) => {
        const dialog = getOpenMediaDialog();
        const freshInputs = listFileInputs().filter(el => !beforeSet.has(el));
        const dialogInputs = dialog
            ? Array.from(dialog.querySelectorAll('input[type="file"]'))
            : [];
        const allInputs = listFileInputs();

        const merged = [];
        const pushUnique = (el) => {
            if (!el) return;
            if (merged.includes(el)) return;
            if (el.disabled) return;
            merged.push(el);
        };

        // Priority: input inside open dialog, then fresh inputs, then any existing file input.
        dialogInputs.forEach(pushUnique);
        freshInputs.forEach(pushUnique);
        allInputs.forEach(pushUnique);
        return merged;
    };

    const beforeInputs = new Set(listFileInputs());
    const slotImageCountBefore = countSlotImages();

    // Flow required by current UI: click "Initial/Inicial" -> open dialog -> click "upload" button.
    const initialClicked = await selectInitialSlot();
    if (initialClicked) {
        await waitForOpenMediaDialog(3500);
        await clickUploadInsideMediaDialog();
    }

    // Inject File
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const file = new File([blob], fileName, { type: fileType });

    let fileInjected = false;
    let candidateInputs = buildUploadInputCandidates(beforeInputs);
    if (candidateInputs.length === 0) {
        // Fallback to legacy "add" button flow used by reference extension.
        console.log("No input candidates after Initial dialog, trying add button...");
        const btnAdd = await waitForElementByXPath(SELECTORS.START_IMAGE_ADD_BUTTON_XPATH, 2500);
        if (btnAdd) await clickElementSafe(btnAdd);
        await waitForNewFileInput(beforeInputs, 3000);
        candidateInputs = buildUploadInputCandidates(beforeInputs);
    }

    for (const inputEl of candidateInputs) {
        if (!setFileOnInput(inputEl, file)) continue;
        fileInjected = true;
        await sleep(200);
        break;
    }

    if (!fileInjected) {
        console.warn('[Flow Automator] Could not inject file into any input[type=file] candidate.');
        return false;
    }

    // Wait for Spinner
    let spinner = await waitForElementByXPath(SELECTORS.UPLOAD_SPINNER_XPATH, 2000);
    if (spinner) {
        let maxWait = 180000;
        while (maxWait > 0) {
            await sleep(500);
            maxWait -= 500;
            const exists = document.evaluate(SELECTORS.UPLOAD_SPINNER_XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (!exists) break;
        }
        if (maxWait <= 0) return false;
    } else {
        await sleep(2000);
    }

    // Explicitly wait until the "Initial" slot receives the uploaded image preview.
    const slotFilled = await waitForInitialSlotFilled(slotImageCountBefore, 12000);
    if (!slotFilled) {
        console.warn('[Flow Automator] Upload finished but Initial slot was not confirmed as filled in time.');
        return false;
    }
    return true;
}

// ===== Helper: Set Video Aspect Ratio (Text-to-Video) =====
async function setVideoAspectRatio(aspectRatio) {
    if (!aspectRatio) return true;
    if (await openSettingsPopover()) {
        const targetXpath = (aspectRatio === '9:16') ? SELECTORS.ASPECT_RATIO_PORTRAIT_XPATH : SELECTORS.ASPECT_RATIO_LANDSCAPE_XPATH;
        const btn = document.evaluate(targetXpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (btn) btn.click();
        await sleep(500);

        // Close popover
        try {
            document.body.click();
        } catch (e) { }
        return true;
    }
    return false;
}

// ===== Helper: Set Video Duration =====
async function setVideoDuration(duration) {
    if (!duration) return;
    if (await openSettingsPopover()) {
        const val = duration === '10s' ? 'x2' : 'x1'; // assumption that 10s corresponds to x2 multiplier
        const xpath = `//div[@role='dialog']//button[contains(., '${val}')]`;
        const btn = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (btn) {
            btn.click();
            await sleep(500);
        }
        // Close popover
        document.body.click();
        return true;
    }
    return false;
}

// ===== Scan Existing URLs (Video/Image) =====
function scanExistingUrls(mode) {
    const urls = new Set();
    const selector = mode === 'image' ? IMAGE_RESULT_SELECTOR : VIDEO_RESULT_SELECTOR;
    document.querySelectorAll(selector).forEach(el => {
        const src = (el.getAttribute('src') || '').trim();
        if (src) urls.add(src);
    });
    // Adicionalmente busca em links de edição que guardam o ID
    document.querySelectorAll('a[href*="/edit/"]').forEach(a => {
        const parts = a.href.split('/edit/');
        if (parts.length > 1) urls.add('id:' + parts[1]);
    });
    return urls;
}

function hasDownloadButton(card) {
    if (!card) return false;
    const buttons = card.querySelectorAll('button');
    for (const btn of buttons) {
        const icon = btn.querySelector('i');
        const span = btn.querySelector('span');
        const iconText = (icon?.textContent || '').toLowerCase();
        const spanText = (span?.textContent || '').toLowerCase();
        const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
        if (
            iconText.includes('download') ||
            iconText.includes('file_download') ||
            spanText.includes('download') ||
            tooltip.includes('download')
        ) {
            return true;
        }
    }
    return false;
}

function isDownloadButton(btn) {
    if (!btn) return false;
    const icon = btn.querySelector('i');
    const span = btn.querySelector('span');
    const iconText = (icon?.textContent || '').toLowerCase();
    const spanText = (span?.textContent || '').toLowerCase();
    const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
    return (
        iconText.includes('download') ||
        iconText.includes('file_download') ||
        spanText.includes('download') ||
        tooltip.includes('download') ||
        ariaLabel.includes('download') ||
        // NOVO: Aceitar o botão "Mais" como proxy para o card estar pronto para download
        iconText.includes('more_vert') ||
        iconText.includes('more_horiz') ||
        tooltip.includes('mais') ||
        ariaLabel.includes('mais') ||
        tooltip.includes('more') ||
        ariaLabel.includes('more')
    );
}

function findLikelyCard(startEl, mode) {
    let el = startEl;
    for (let depth = 0; el && depth < 12; depth++, el = el.parentElement) {
        if (!el || el === document.body) break;
        const hasMedia = mode === 'image'
            ? !!el.querySelector('img')
            : !!el.querySelector('video');
        if (hasMedia && hasDownloadButton(el)) return el;
    }
    return null;
}

function scanExistingCards(mode) {
    const cardSet = new Set();
    const selector = mode === 'image' ? IMAGE_RESULT_SELECTOR : VIDEO_RESULT_SELECTOR;
    document.querySelectorAll(selector).forEach(el => {
        const card =
            findLikelyCard(el, mode) ||
            el.closest('[data-index], [data-item-index], [role="listitem"], article, li, .sc-20145656-0, .sc-6349d8ef-0');
        if (card) cardSet.add(card);
    });

    // Fallback: derive cards from download buttons (Flow DOM often changes container classes)
    document.querySelectorAll('button').forEach(btn => {
        if (!isDownloadButton(btn)) return;
        const card =
            findLikelyCard(btn, mode) ||
            btn.closest('[data-index], [data-item-index], [role="listitem"], article, li, .sc-20145656-0, .sc-6349d8ef-0') ||
            btn.parentElement;
        if (card) cardSet.add(card);
    });

    return cardSet;
}

// ===== Wait for a NEW card to appear (by identifying NEW URL) =====
async function waitForNewCard(existingUrls, existingCards, timeout, mode) {
    const startTime = Date.now();
    console.log('[Flow Automator] Waiting for new', mode, 'card. Known URLs:', existingUrls.size);

    // Initial wait to let generation start
    await sleep(2000);

    while (Date.now() - startTime < timeout) {
        // Check for error toasts (Queue Full / Policy)
        const queueFull = document.evaluate(SELECTORS.QUEUE_FULL_POPUP_XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (queueFull) throw new Error("A fila esta cheia (QUEUE_FULL)");

        const policyError = document.evaluate(SELECTORS.PROMPT_POLICY_ERROR_POPUP_XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (policyError) {
            const errorText = policyError.innerText || policyError.textContent || "Erro deconhecido";
            throw new Error("Erro do Flow: " + errorText.trim());
        }

        // 1. Check for Progress Indicators (reliable "Generating" state)
        // If we see "Generating", we know we are validly waiting.
        const progressElements = document.querySelectorAll('[class*="iEQNVH"], [class*="percentage"]');
        let isGenerating = false;
        for (const el of progressElements) {
            const text = el.textContent.trim();
            if (text.match(/^\d+%$/)) {
                isGenerating = true;
                updateStatus('Gerando: ' + text);
                break;
            }
        }

        // 2. Scan for NEW Ready Items
        let newReadyItem = null;
        const selector = mode === 'image' ? IMAGE_RESULT_SELECTOR : VIDEO_RESULT_SELECTOR;
        const candidates = document.querySelectorAll(selector);

        for (const el of candidates) {
            const src = (el.getAttribute('src') || '').trim();
            if (src && !existingUrls.has(src)) {
                // NEW ITEM FOUND!
                console.log('[Flow Automator] Detectado novo src:', src);
                // Busca o container mais próximo que represente o card
                const card = el.closest('[data-index]') || el.closest('[data-tile-id]') || el.closest('.sc-b04ce3b3-0') || el.parentElement;
                newReadyItem = { card: card, wrapper: card, src };
                break;
            }
        }

        // 3. Fallback: detect NEW card by DOM/container (even when media URL is lazy or different)
        if (!newReadyItem) {
            const cards = Array.from(scanExistingCards(mode));
            for (const card of cards) {
                if (!existingCards.has(card) && hasDownloadButton(card)) {
                    const mediaEl = card.querySelector(mode === 'image' ? IMAGE_RESULT_SELECTOR : VIDEO_RESULT_SELECTOR);
                    const mediaSrc = (mediaEl?.getAttribute('src') || '').trim();
                    newReadyItem = {
                        card,
                        wrapper: card,
                        src: mediaSrc || 'card-with-download-button'
                    };
                    break;
                }
            }
        }

        if (newReadyItem) {
            console.log('[Flow Automator] New finished item found:', newReadyItem.src);
            await sleep(1000); // Stabilize
            return newReadyItem;
        }

        await sleep(1000);
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (!isGenerating) {
            // If not generating and no new item, maybe it's still initializing or failed?
            // checking simple "UPDATING" status
            updateStatus('Aguardando... (' + elapsed + 's)');
        }
    }

    return null; // Timeout
}

function findLatestDownloadableCard(mode) {
    const cards = Array.from(scanExistingCards(mode));
    if (!cards.length) return null;
    const sorted = cards
        .slice()
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return sorted[0] || null;
}

async function clickDismissButton() {
    try {
        const isVisible = (el) => {
            if (!el || !el.isConnected) return false;
            const st = window.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
            const r = el.getBoundingClientRect();
            return r.width > 4 && r.height > 4;
        };

        const norm = (v) => String(v || '').toLowerCase().trim();
        const candidates = Array.from(document.querySelectorAll('button,[role="button"]')).filter(isVisible);

        const btn = candidates.find((el) => {
            const txt = norm(el.textContent);
            const aria = norm(el.getAttribute('aria-label'));
            const title = norm(el.getAttribute('title'));
            const icon = norm(el.querySelector('i')?.textContent);
            return (
                icon === 'close' ||
                icon === 'cancel' ||
                txt.includes('fechar') ||
                txt.includes('close') ||
                txt.includes('dispens') ||
                aria.includes('fechar') ||
                aria.includes('close') ||
                title.includes('fechar') ||
                title.includes('close')
            );
        });

        if (btn) {
            reactClick(btn);
            await sleep(250);
            return true;
        }
    } catch (_) { }

    try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
        await sleep(200);
        return true;
    } catch (_) {
        return false;
    }
}

// ===== Main Processing Function (Replaces earlier implementation) =====
async function processPrompt(prompt, index, config, image = null) {
    console.log('[Flow Automator] Processing prompt via temp logic:', prompt);
    isProcessing = true;
    currentPromptText = prompt.trim();

    try {
        showOverlay('Processando...', prompt);
        setStatusProgress(index + 1, config.totalPrompts || 1);

        // Improved Page Ready Wait: Wait for history to likely load
        await waitForPageReady();
        // Scan existing URLs to avoid "History Loaded Late" race condition
        // We assume anything currently on page is "Old"
        const scanMode = config.mode === 'image' ? 'image' : 'video';
        const existingUrls = scanExistingUrls(scanMode);
        const existingCards = scanExistingCards(scanMode);
        console.log(`[Flow Automator] Initial scan: ${existingUrls.size} existing items.`);

        // 1. Determine Mode
        let mode = 'text-to-video';
        if (image || config.mode === 'image-to-video' || config.mode === 'frames') {
            mode = 'image-to-video';
        } else if (config.mode === 'image') {
            mode = 'create-image';
        }


        // 2. If image-to-video with source image, upload FIRST (requested flow).
        if (mode === 'image-to-video' && image) {
            updateOverlay('Enviando imagem (Inicial)...');
            const uploadSuccess = await uploadImage(
                image.data,
                image.name,
                image.type,
                image.aspectRatio === '9:16' ? 'portrait' : 'landscape'
            );
            if (!uploadSuccess) throw new Error('Falha no upload da imagem');
            await sleep(700);
        }

        // 3. Select Mode, Model, Ratio (all in MAIN world via mainWorldSelectSettings)
        updateOverlay('Configurando modo/modelo/proporcao...');

        // Determine aspect ratio for this prompt
        let targetRatio = config.aspectRatio || '16:9';
        if (config.randomizeAspectRatio) {
            const options = [];
            if (config.randomIncludeLandscape) options.push('16:9');
            if (config.randomIncludePortrait) options.push('9:16');
            if (options.length > 0) {
                targetRatio = options[Math.floor(Math.random() * options.length)];
                console.log('[Flow Automator] Randomized ratio:', targetRatio);
            }
        }

        const settingsConfig = {
            mode: mode,  // 'create-image' | 'text-to-video' | 'image-to-video'
            imageModel: config.imageModel || 'Nano Banana 2',
            videoModel: config.videoModel || 'Veo 3.1 - Fast',
            modelKey: normalizeImageModelKey(config.imageModel || 'Nano Banana 2'),
            aspectRatio: (targetRatio === '9:16') ? 'portrait' : 'landscape'
        };
        console.log('[Flow Automator] settingsConfig:', settingsConfig);

        let settingsOk = false;
        for (let attempt = 1; attempt <= 3 && !settingsOk; attempt++) {
            settingsOk = await applyFlowSettings(settingsConfig);
            if (!settingsOk) {
                console.warn(`[Flow Automator] applyFlowSettings failed (attempt ${attempt}/3)`);
                await sleep(500);
            }
        }
        if (!settingsOk) {
            throw new Error('Falha ao aplicar modo/modelo/proporcao (modelo nao confirmado)');
        }
        await sleep(500);

        // Video-specific: duration setting
        if (mode !== 'create-image' && config.videoDuration) {
            updateOverlay(`Ajustando duracao (${config.videoDuration})...`);
            await setVideoDuration(config.videoDuration);
        }


        // 4. Input Prompt
        updateOverlay('Inserindo prompt...');
        const inputSuccess = await fillPromptInput(prompt);
        if (!inputSuccess) throw new Error('Nao foi possivel encontrar o campo de prompt');
        await sleep(2000);

        // 5. Click Generate
        updateOverlay('Iniciando geracao...');
        const generateBtn = await waitForElementByXPath(SELECTORS.GENERATE_BUTTON_XPATH, 2000);

        // Wait specifically for ENABLED button
        let enabledGenerateBtn = null;
        let retries = 20; // 10 seconds (20 * 500ms)
        while (retries > 0) {
            const btn = document.evaluate(SELECTORS.GENERATE_BUTTON_XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            // Check disabled property AND aria-disabled attribute AND class
            if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && !btn.classList.contains('disabled')) {
                enabledGenerateBtn = btn;
                break;
            }
            // If button exists but is disabled, wait
            if (btn) {
                updateOverlay('Aguardando botao Gerar ativar...');
            }
            await sleep(500);
            retries--;
        }

        if (enabledGenerateBtn) {
            clickElementByXPath(SELECTORS.GENERATE_BUTTON_XPATH);
            await sleep(1000);
            console.log('[Flow Automator] Clicked Generate');

            // Wait for NEW card (URL based)
            updateOverlay('Aguardando geracao...');

            // We pass existingUrls. 
            // Logic: Wait until a URL appears that is NOT in existingUrls.
            let cardResult = await waitForNewCard(existingUrls, existingCards, config.generationTimeout * 1000, config.mode);

            if (!cardResult) {
                const fallbackCard = findLatestDownloadableCard(scanMode);
                if (fallbackCard) {
                    console.warn('[Flow Automator] waitForNewCard timeout; using fallback latest downloadable card');
                    cardResult = {
                        card: fallbackCard,
                        wrapper: fallbackCard,
                        src: 'fallback-latest-card'
                    };
                } else {
                    // Determine if it was a timeout or something else
                    throw new Error('Timeout na geracao');
                }
            }

            console.log('[Flow Automator] Found new', config.mode, 'card');

            // Now download...
            updateOverlay('Fazendo download...');
            await sleep(1000);

            let downloadSuccess = false;

            if (config.mode === 'image') {
                downloadSuccess = await downloadFromImageCard(cardResult.wrapper || cardResult.card, config.imageResolution || '2k');
            } else {
                const desiredVideoRes = normalizeVideoResolution(config.videoResolution || (config.doUpscale ? '1080p' : '720p'));
                downloadSuccess = await downloadFromVideoCard(cardResult.wrapper || cardResult.card, desiredVideoRes);
            }

            if (!downloadSuccess) {
                throw new Error('Falha no download');
            }

            console.log('[Flow Automator] Waiting for download to start...');
            await sleep(1000);

            // Upscale waits...
            if (config.mode === 'image' && (config.imageResolution === '2k' || config.imageResolution === '4k')) {
                updateOverlay('Aguardando upscale (' + config.imageResolution.toUpperCase() + ')...');
                const upscaleComplete = await waitForUpscaleComplete(300000);
                if (upscaleComplete) {
                    await clickDismissButton();
                    await sleep(3000);
                }
            } else if (config.mode === 'image' && config.imageResolution === '1k') {
                await sleep(2000);
            }

            const targetVideoRes = normalizeVideoResolution(config.videoResolution || (config.doUpscale ? '1080p' : '720p'));
            if (config.mode === 'video' && (targetVideoRes === '1080p' || targetVideoRes === '4k') && config.aspectRatio !== '9:16') {
                updateOverlay('Aguardando upscale (' + targetVideoRes.toUpperCase() + ')...');
                const upscaleComplete = await waitForUpscaleComplete(300000);

                if (upscaleComplete) {
                    await clickDismissButton();
                    await sleep(2000);
                }
            }

            console.log('[Flow Automator] Prompt completed successfully');
            sendComplete(true, null, prompt);

        } else {
            console.error("Generate button not found or disabled");
            throw new Error("Generate button invalid or disabled");
        }
    } catch (e) {
        console.error('[Flow Automator] Error processing prompt:', e);
        updateOverlay('Erro: ' + e.message);
        await sleep(3000); // Give user time to see error
        sendComplete(false, null, prompt, e.message);
    } finally {
        isProcessing = false;
    }
}


// ===== Download video from a specific card =====
async function downloadFromVideoCard(card, targetResolution) {
    console.log('[Flow Automator] Starting VIDEO download, target:', targetResolution);

    // Get video URL from card FIRST
    const video = card.querySelector('video');
    const videoUrl = video ? video.getAttribute('src') : '';

    if (videoUrl) {
        console.log('[Flow Automator] Video URL found:', videoUrl.substring(0, 100) + '...');
        // Register this URL with background for renaming
        chrome.runtime.sendMessage({
            action: 'registerDownload',
            url: videoUrl,
            type: 'video'
        });
    }

    // Hover card/video to reveal 3-dot action menu
    try {
        card.scrollIntoView({ block: 'center' });
        card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        if (video) {
            video.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            video.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        }
    } catch (_) { }
    await sleep(350);

    const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
    };
    const norm = (v) => String(v || '').toLowerCase().trim();
    const iconText = (el) => norm(el?.querySelector('i')?.textContent);

    const findMainMenuWithDownload = () => {
        const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(isVisible);
        return menus.find(m => {
            const items = Array.from(m.querySelectorAll('[role="menuitem"]'));
            return items.some(it => iconText(it).includes('download'));
        }) || null;
    };

    // 1) Try opening via 3 dots first; if that fails, use right-click context menu fallback.
    let mainMenu = null;
    let moreBtn = Array.from(card.querySelectorAll('button')).find(b => {
        if (!isVisible(b)) return false;
        const iTxt = iconText(b);
        const lbl = norm((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-tooltip') || ''));
        return iTxt.includes('more_vert') || iTxt.includes('more_horiz') || lbl.includes('more') || lbl.includes('mais') || lbl.includes('menu');
    });
    if (!moreBtn) {
        moreBtn = Array.from(card.querySelectorAll('[role="button"], button')).find(b => {
            if (!isVisible(b)) return false;
            const iTxt = iconText(b);
            return iTxt.includes('more_vert') || iTxt.includes('more_horiz');
        }) || null;
    }
    if (moreBtn) {
        reactClick(moreBtn);
        await sleep(500);
        mainMenu = findMainMenuWithDownload();
    }

    if (!mainMenu) {
        const target = video || card;
        console.log('[Flow Automator] Three-dots menu not found, trying right-click context menu...');
        rightClick(target);
        await sleep(700);
        mainMenu = findMainMenuWithDownload();
    }

    if (!mainMenu) {
        console.log('[Flow Automator] Main context menu not found');
        return false;
    }

    const downloadEntry = Array.from(mainMenu.querySelectorAll('[role="menuitem"]')).find(it => {
        const txt = norm(it.textContent);
        const iTxt = iconText(it);
        const hasSub = it.getAttribute('aria-haspopup') === 'menu';
        return iTxt.includes('download') || txt.includes('download') || txt.includes('baixar') || hasSub;
    });
    if (!downloadEntry) {
        console.log('[Flow Automator] Download entry not found in context menu');
        return false;
    }

    // 3) Open download submenu (hover + click, because Radix may require pointer intent)
    downloadEntry.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    downloadEntry.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    reactClick(downloadEntry);
    await sleep(500);

    // 4) Find submenu with resolution options by numeric labels (language agnostic)
    const parseResolution = (text) => {
        const t = norm(text);
        if (t.includes('4k')) return '4k';
        if (t.includes('1080')) return '1080p';
        if (t.includes('720')) return '720p';
        if (t.includes('270')) return '270p';
        return null;
    };

    const resMenu = Array.from(document.querySelectorAll('[role=\"menu\"]'))
        .filter(isVisible)
        .find(m => {
            const items = Array.from(m.querySelectorAll('[role=\"menuitem\"]'));
            return items.some(it => parseResolution(it.textContent));
        });
    if (!resMenu) {
        console.log('[Flow Automator] Resolution submenu not found');
        return false;
    }

    const items = Array.from(resMenu.querySelectorAll('[role=\"menuitem\"]')).map(el => ({
        el,
        res: parseResolution(el.textContent),
        disabled: el.getAttribute('aria-disabled') === 'true'
    })).filter(x => x.res);
    if (!items.length) {
        console.log('[Flow Automator] No resolution options found');
        return false;
    }

    const preferred = normalizeVideoResolution(targetResolution);
    const fallbackOrder = preferred === '4k'
        ? ['4k', '1080p', '720p', '270p']
        : preferred === '1080p'
            ? ['1080p', '720p', '270p']
            : preferred === '720p'
                ? ['720p', '270p']
                : ['270p'];

    let chosen = null;
    for (const r of fallbackOrder) {
        chosen = items.find(x => x.res === r && !x.disabled);
        if (chosen) break;
    }
    if (!chosen) {
        chosen = items.find(x => !x.disabled) || null;
    }
    if (!chosen) {
        console.log('[Flow Automator] All resolution options are disabled');
        return false;
    }

    console.log('[Flow Automator] Clicking video resolution:', chosen.res);
    reactClick(chosen.el);
    await sleep(500);
    return true;
}

// ===== Download image from a specific card =====
async function downloadFromImageCard(card, resolution) {
    console.log('[Flow Automator] Iniciando download via Menu de Contexto...');
    updateOverlay('Preparando card para download...');

    const img = card.querySelector(IMAGE_RESULT_SELECTOR);
    if (!img) {
        console.log('[Flow Automator] Erro: img não encontrada no card');
        return false;
    }

    // Garante que o card esteja visível e em foco (hover simulado)
    img.scrollIntoView({ block: 'center', behavior: 'smooth' });
    img.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await sleep(500);

    // Tenta clique direito para abrir o menu
    console.log('[Flow Automator] Disparando clique direito na imagem...');
    rightClick(img);
    await sleep(1000);

    // Busca a opção "Baixar" - agnóstico a idioma usando o ícone se possível
    let menuItems = document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]');
    let downloadOption = Array.from(menuItems).find(i => {
        const text = i.textContent.toLowerCase();
        const icon = i.querySelector('i');
        const iconText = (icon?.textContent || '').toLowerCase();
        // Verifica texto em PT/EN ou o ícone do sistema
        return text.includes('baixar') || text.includes('download') || iconText.includes('download');
    });

    if (!downloadOption) {
        console.log('[Flow Automator] Menu de contexto não apareceu. Tentando via botão Mais/More...');
        // O botão de 3 pontinhos só aparece com o foco, vamos tentar achar ele agora que demos mouseenter
        const moreBtn = Array.from(card.querySelectorAll('button')).find(b => {
            const i = b.querySelector('i');
            const tooltip = (b.getAttribute('data-tooltip') || b.getAttribute('aria-label') || '').toLowerCase();
            return (i && (i.textContent.includes('more_vert') || i.textContent.includes('more_horiz'))) || tooltip.includes('mais') || tooltip.includes('more');
        });
        if (moreBtn) {
            reactClick(moreBtn);
            await sleep(1000);
            menuItems = document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]');
            downloadOption = Array.from(menuItems).find(i => {
                const text = i.textContent.toLowerCase();
                const icon = i.querySelector('i');
                const iconText = (icon?.textContent || '').toLowerCase();
                return text.includes('baixar') || text.includes('download') || iconText.includes('download');
            });
        }
    }

    if (!downloadOption) {
        updateOverlay('Erro: Menu de download não encontrado');
        return false;
    }

    // Abre o submenu de resoluções
    updateOverlay('Selecionando resolução...');
    reactClick(downloadOption);
    await sleep(1200);

    // Busca as opções (1K, 2K, 4K)
    const targets = IMAGE_DOWNLOAD_OPTIONS[resolution] || IMAGE_DOWNLOAD_OPTIONS['2k'];
    menuItems = document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]');

    let resolutionItem = null;
    for (const item of menuItems) {
        const text = item.textContent.toUpperCase();
        // Busca direta pelo texto da resolução (agnóstico a palavras extras)
        if (text.includes(resolution.toUpperCase())) {
            resolutionItem = item;
            break;
        }
    }

    // Fallback por posição se não achar o texto exato
    if (!resolutionItem && menuItems.length > 0) {
        console.log('[Flow Automator] Seleção exata falhou, tentando por fallback de texto...');
        resolutionItem = Array.from(menuItems).find(i => targets.some(t => i.textContent.toLowerCase().includes(t.toLowerCase())));
    }

    if (resolutionItem) {
        console.log('[Flow Automator] Registrando download para o prompt atual...');
        const mediaSrc = img.getAttribute('src');
        chrome.runtime.sendMessage({
            action: 'registerDownload',
            url: mediaSrc,
            type: 'image',
            resolution: resolution
        });

        console.log('[Flow Automator] Clicando na resolução:', resolutionItem.textContent.trim());
        reactClick(resolutionItem);

        if (resolution !== '1k') {
            await waitForUpscaleComplete();
        } else {
            await sleep(3000);
        }
        return true;
    }

    return false;
}

// ===== DOM Interaction Functions =====
async function waitForPageReady() {
    console.log('[Flow Automator] Waiting for page history to load (3s)...');
    await sleep(3000);
    return true;
}

// Helper: Sleep
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: Overlay (Simple version)
function showOverlay(title, subtitle) {
    showStatus(title, subtitle);
}
function updateOverlay(title) { updateStatus(title); }



// ===== Floating Status UI (bottom right corner) =====
let statusElement = null;
let statusStartTime = null;
let statusTimerInterval = null;
let statusTotalPrompts = 1;
let statusCurrentPrompt = 1;

function showOverlay(title, subtitle) {
    showStatus(title, subtitle);
}

function updateOverlay(title) {
    updateStatus(title);
}

function hideOverlay() {
    hideStatus();
}

function setStatusProgress(current, total) {
    statusCurrentPrompt = current;
    statusTotalPrompts = total;
    if (statusElement) {
        const counterEl = statusElement.querySelector('.fa-counter');
        if (counterEl) counterEl.textContent = `Prompt ${current} de ${total} `;
    }
}

function showComplete(successCount, failCount) {
    if (!statusElement) return;

    // Stop the timer but keep the time
    if (statusTimerInterval) {
        clearInterval(statusTimerInterval);
        statusTimerInterval = null;
    }

    // Calculate total time
    const elapsed = statusStartTime ? Math.floor((Date.now() - statusStartTime) / 1000) : 0;
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    const totalTime = `${mins}:${secs} `;

    // Update the overlay to show completion
    const mainEl = statusElement.querySelector('.fa-status-main');
    const bodyEl = statusElement.querySelector('.fa-status-body');
    const spinnerEl = statusElement.querySelector('.fa-spinner-small');

    if (mainEl) {
        mainEl.textContent = 'OK - Concluido!';
        mainEl.style.color = '#10b981';
    }

    if (spinnerEl) {
        spinnerEl.style.display = 'none';
    }
    if (bodyEl) {
        bodyEl.innerHTML = `
            <div style="text-align: center; padding: 10px 0;">
                <div style="font-size: 24px; margin-bottom: 8px;">DONE</div>
                <div style="color: #10b981; font-size: 14px; font-weight: 600; margin-bottom: 4px;">
                    Automacao finalizada!
                </div>
                <div style="color: rgba(255,255,255,0.7); font-size: 12px; margin-bottom: 8px;">
                    ${successCount} prompt${successCount !== 1 ? 's' : ''} processado${successCount !== 1 ? 's' : ''} com sucesso
                    ${failCount > 0 ? `<br><span style="color: #f87171;">${failCount} falha${failCount !== 1 ? 's' : ''}</span>` : ''}
                </div>
                <div style="color: #a855f7; font-size: 13px; font-weight: 500;">
                    Tempo total: ${totalTime}
                </div>
            </div>
    `;
    }
}

function handlePaused(message) {
    if (!statusElement) return;
    const mainEl = statusElement.querySelector('.fa-status-main');
    if (mainEl) {
        let pauseText = '|| Pausado';
        if (message.isScheduled && message.pauseMinutes) {
            pauseText = `Pausa programada(${message.pauseMinutes} min)`;
        }
        mainEl.textContent = pauseText;
    }

    const bodyEl = statusElement.querySelector('.fa-status-body');
    if (bodyEl && message.isScheduled) {
        const unpauseBtn = document.createElement('button');
        unpauseBtn.textContent = 'Continuar Agora';
        unpauseBtn.style.cssText = `
            margin-top: 12px;
            padding: 8px 16px;
            background: linear-gradient(135deg, #7c3aed, #a855f7);
            border: none;
            border-radius: 8px;
            color: white;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s;
        `;
        unpauseBtn.onmouseover = () => unpauseBtn.style.transform = 'scale(1.05)';
        unpauseBtn.onmouseout = () => unpauseBtn.style.transform = 'scale(1)';
        unpauseBtn.onclick = () => {
            chrome.runtime.sendMessage({ type: 'unpause' });
        };
        bodyEl.appendChild(unpauseBtn);
    }
}

function handleUnpaused() {
    updateOverlay('Retomando automacao...');
}

function showStatus(title, subtitle) {
    subtitle = subtitle || '';
    if (statusElement && document.body.contains(statusElement)) {
        const mainEl = statusElement.querySelector('.fa-status-main');
        const promptEl = statusElement.querySelector('.fa-status-prompt');
        if (mainEl) mainEl.textContent = title;
        if (promptEl) promptEl.textContent = subtitle.substring(0, 150) + (subtitle.length > 150 ? '...' : '');
        return;
    }

    statusElement = null;
    statusStartTime = Date.now();

    if (statusTimerInterval) clearInterval(statusTimerInterval);
    statusTimerInterval = setInterval(() => {
        if (statusElement) {
            const elapsed = Math.floor((Date.now() - statusStartTime) / 1000);
            const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const secs = (elapsed % 60).toString().padStart(2, '0');
            const timerEl = statusElement.querySelector('.fa-timer');
            if (timerEl) timerEl.textContent = `Tempo: ${mins}:${secs} `;
        }
    }, 1000);

    statusElement = document.createElement('div');
    statusElement.id = 'flow-automator-status';
    statusElement.innerHTML =
        '<div class="fa-status-content">' +
        '<div class="fa-status-header">' +
        '<span class="fa-spinner-small"></span>' +
        '<span class="fa-status-title">Flow Automator</span>' +
        '<span class="fa-status-main">' + title + '</span>' +
        '<button class="fa-close-btn" onclick="this.closest(\'#flow-automator-status\').remove()">X</button>' +
        '</div>' +
        '<div class="fa-status-body">' +
        '<p class="fa-status-prompt">' + subtitle.substring(0, 150) + (subtitle.length > 150 ? '...' : '') + '</p>' +
        '<div class="fa-status-info">' +
        '<span class="fa-counter">Prompt ' + statusCurrentPrompt + ' de ' + statusTotalPrompts + '</span>' +
        '<span class="fa-timer">Tempo: 00:00</span>' +
        '</div>' +
        '</div>' +
        '<div class="fa-status-footer">' +
        'Gosta do projeto? <a href="https://ko-fi.com/dentparanoide" target="_blank">Me paga um cafezinho</a>' +
        '</div>' +
        '</div>';

    const styles = document.createElement('style');
    styles.textContent = `
        #flow-automator-status {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 999999;
            font-family: 'Inter', -apple-system, sans-serif;
        }
        .fa-status-content {
            background: linear-gradient(135deg, rgba(30, 30, 40, 0.97), rgba(20, 20, 30, 0.97));
            border: 1px solid rgba(168, 85, 247, 0.4);
            border-radius: 12px;
            padding: 14px 16px;
            min-width: 320px;
            max-width: 380px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(10px);
        }
        .fa-status-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 10px;
            padding-bottom: 10px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .fa-spinner-small {
            width: 14px;
            height: 14px;
            border: 2px solid rgba(168, 85, 247, 0.3);
            border-top-color: #a855f7;
            border-radius: 50%;
            animation: fa-spin 1s linear infinite;
        }
        @keyframes fa-spin {
            to { transform: rotate(360deg); }
        }
        .fa-status-title {
            background: linear-gradient(90deg, #a855f7, #6366f1);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .fa-status-main {
            flex: 1;
            text-align: right;
            color: #10b981;
            font-size: 12px;
            font-weight: 600;
        }
        .fa-close-btn {
            background: none;
            border: none;
            color: rgba(255, 255, 255, 0.4);
            cursor: pointer;
            font-size: 12px;
            padding: 2px 6px;
            border-radius: 4px;
            margin-left: 4px;
        }
        .fa-close-btn:hover {
            background: rgba(255, 255, 255, 0.1);
            color: white;
        }
        .fa-status-body {
            color: white;
        }
        .fa-status-prompt {
            font-size: 12px;
            color: rgba(255, 255, 255, 0.8);
            margin: 0 0 10px 0;
            word-break: break-word;
            line-height: 1.4;
        }
        .fa-status-info {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
        }
        .fa-counter {
            font-size: 11px;
            color: #a855f7;
            font-weight: 500;
        }
        .fa-timer {
            font-size: 11px;
            color: rgba(255, 255, 255, 0.6);
        }
        .fa-progress-bar {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 4px;
            height: 4px;
            overflow: hidden;
            margin-bottom: 10px;
        }
        .fa-progress-fill {
            background: linear-gradient(90deg, #a855f7, #6366f1);
            height: 100%;
            width: 0%;
        }
        .fa-status-footer {
            font-size: 10px;
            color: rgba(255, 255, 255, 0.4);
            text-align: center;
            padding-top: 8px;
            border-top: 1px solid rgba(255, 255, 255, 0.05);
        }
        .fa-status-footer a {
            color: #f472b6;
            text-decoration: none;
        }
        .fa-status-footer a:hover {
            text-decoration: underline;
        }
`;

    // Remove old styles if exist
    const oldStyles = document.getElementById('flow-automator-styles');
    if (oldStyles) oldStyles.remove();

    document.head.appendChild(styles);
    document.body.appendChild(statusElement);
}

function updateStatus(text) {
    if (statusElement) {
        const mainEl = statusElement.querySelector('.fa-status-main');
        if (mainEl) mainEl.textContent = text;
    }
}

function hideStatus() {
    if (statusTimerInterval) {
        clearInterval(statusTimerInterval);
        statusTimerInterval = null;
    }
    if (statusElement) {
        statusElement.remove();
        statusElement = null;
    }
}


// ===== Communication =====
function sendComplete(success, mediaUrl, prompt, error) {
    error = error || null;
    try {
        chrome.runtime.sendMessage({
            type: 'promptComplete',
            success: success,
            mediaUrl: mediaUrl,
            prompt: prompt,
            error: error
        }, () => {
            // Extension may reload while page stays open; ignore stale-context errors.
            if (chrome.runtime.lastError) {
                console.warn('[Flow Automator] sendComplete ignored:', chrome.runtime.lastError.message);
            }
        });
    } catch (e) {
        console.warn('[Flow Automator] sendComplete failed:', e?.message || e);
    }
}

// ===== Utilities =====
function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function normalizeImageModelKey(modelValue) {
    const t = String(modelValue || '').toLowerCase();
    if (t.includes('pro')) return 'nb_pro';
    if (t.includes('image 4') || t.includes('imagen 4') || t.includes('imagem 4')) return 'img4';
    return 'nb2';
}

function normalizeVideoResolution(value) {
    const t = String(value || '').toLowerCase();
    if (t.includes('4k')) return '4k';
    if (t.includes('1080')) return '1080p';
    if (t.includes('270')) return '270p';
    return '720p';
}

console.log('[Flow Automator] Ready on:', window.location.href);


// Check automation state on load
chrome.runtime.sendMessage({ action: 'getState' }, (response) => {
    if (response && response.state && response.state.isProcessing && !response.state.isPaused) {
        console.log('[Flow Automator] Automation active. Phase:', response.state.downloadPhase);
        if (response.state.downloadPhase === 'waiting_for_edit_view' || response.state.downloadPhase === 'selecting_resolution') {
            startAutomationResume(response.state);
        } else if (response.state.downloadPhase === 'none') {
            // Standard start or after returning from edit view
            processNextPrompt();
        }
    }
});

async function startAutomationResume(state) {
    createOverlay();
    updateOverlay('Retomando download...');
    if (window.location.href.includes('/edit/')) {
        const success = await finishDownloadInEditView(state.targetResolution);
        if (success) {
            updateOverlay('Download ok! Voltando ao dashboard...');
            await sleep(1000);
            const backBtn = document.querySelector('button[aria-label="Voltar"], button[aria-label="Back"]');
            if (backBtn) { reactClick(backBtn); } else { window.history.back(); }
        }
    } else {
        if (state.downloadPhase === 'selecting_resolution' || state.downloadPhase === 'waiting_for_edit_view') {
            updateOverlay('Download finalizado. Continuando automacao...');
            chrome.runtime.sendMessage({ action: 'updatePhase', phase: 'none' });
            handleSuccess();
            await sleep(1000);
            processNextPrompt();
        }
    }
}

async function finishDownloadInEditView(resolution) {
    updateOverlay('Finalizando download...');
    await sleep(3000); // Wait for page to settle

    // Find Header Download button
    const buttons = Array.from(document.querySelectorAll('button'));
    let downloadBtn = buttons.find(b => {
        const i = b.querySelector('i');
        const tooltip = b.getAttribute('data-tooltip') || '';
        const label = b.getAttribute('aria-label') || '';
        return (i && (i.textContent.includes('download') || i.textContent.includes('file_download'))) ||
            tooltip.toLowerCase().includes('download') ||
            tooltip.toLowerCase().includes('baixar') ||
            label.toLowerCase().includes('download') ||
            label.toLowerCase().includes('baixar');
    });

    if (!downloadBtn) {
        downloadBtn = document.querySelector('button[aria-label*="Baixar"], button[aria-label*="Download"]');
    }

    if (!downloadBtn) {
        console.log('[Flow Automator] Header download button not found');
        return false;
    }

    console.log('[Flow Automator] Clicking header download button');
    reactClick(downloadBtn);
    await sleep(2000);

    const menuSelectors = ['[role="menuitem"]', '[role="menuitemradio"]', 'button[role="menuitem"]'];
    let menuItems = [];
    for (const sel of menuSelectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) { menuItems = Array.from(found); break; }
    }

    if (menuItems.length === 0) {
        console.log('[Flow Automator] Resolution menu not found');
        return false;
    }

    const targets = IMAGE_DOWNLOAD_OPTIONS[resolution] || IMAGE_DOWNLOAD_OPTIONS['2k'];
    for (const item of menuItems) {
        const text = item.textContent.toLowerCase();
        if (targets.some(t => text.includes(t.toLowerCase()))) {
            console.log('[Flow Automator] Clicking resolution:', text);
            reactClick(item);

            if (resolution !== '1k') {
                updateOverlay('Aguardando upscale...');
                await waitForUpscaleComplete(60000);
            } else {
                await sleep(2000);
            }

            chrome.runtime.sendMessage({ action: 'updatePhase', phase: 'none' });
            return true;
        }
    }

    return false;
}

async function waitForUpscaleComplete(timeoutMs = 60000) {
    console.log('[Flow Automator] Aguardando conclusao do upscale...');
    const baselineDownloadTs = lastFlowDownloadDetectedAt;
    const startTime = Date.now();
    await sleep(2000);
    while (Date.now() - startTime < timeoutMs) {
        if (lastFlowDownloadDetectedAt > baselineDownloadTs) {
            console.log('[Flow Automator] Download detectado via background. Encerrando espera de upscale.');
            await sleep(1000);
            return true;
        }

        const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]'));
        const upscaleToast = toasts.find(t => {
            const text = t.textContent.toLowerCase();
            return text.includes('aumentando') || text.includes('resoluc') || text.includes('upscaling') || text.includes('download vai comecar');
        });
        if (!upscaleToast) {
            console.log('[Flow Automator] Upscale concluido.');
            await sleep(2000);
            return true;
        }
        updateOverlay('Aguardando upscale...');
        await sleep(2000);
    }
    return false;
}
