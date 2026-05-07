
// ===== Flow Automator Content Script =====
console.log('[Flow Automator] Content script loaded');

// ===== Selectors for Google Flow =====
const SELECTORS = {
    PROMPT_TEXTAREA_XPATH: "//div[@role='textbox']",
    GENERATE_BUTTON_XPATH: "//button[.//i[normalize-space(text())='arrow_forward'] or (descendant::span[normalize-space(text())='Criar' or normalize-space(text())='Create'] and not(descendant::i[normalize-space(text())='add_2' or normalize-space(text())='add']))]",
    // Settings trigger button confirmed by browser inspection
    SETTINGS_POPOVER_TRIGGER_XPATH: "//button[descendant::i[text()='crop_16_9' or text()='crop_9_16' or text()='crop_square']]",
    QUEUE_FULL_POPUP_XPATH: "//li[@data-sonner-toast and .//i[normalize-space(text())='error'] and .//*[contains(., '5')]]",
    PROMPT_POLICY_ERROR_POPUP_XPATH: "//li[@data-sonner-toast and .//i[normalize-space(text())='error'] and not(.//*[contains(., '5')])]",
    START_IMAGE_ADD_BUTTON_XPATH: "//button[.//i[text()='add'] or .//svg]",
    HIDDEN_FILE_INPUT_XPATH: '//input[@type="file"]',
    UPLOAD_SPINNER_XPATH: "//i[contains(text(), 'progress_activity')]",
    OPEN_MEDIA_DIALOG_XPATH: "//div[@role='dialog' and @data-state='open']",
    MEDIA_DIALOG_UPLOAD_BUTTON_XPATH: "//div[@role='dialog' and @data-state='open']//button[.//i[normalize-space(text())='upload' or normalize-space(text())='file_upload']]"
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
let dashboardSetupDone = false;

// ===== Dashboard Setup (runs once before first prompt) =====
async function initDashboardSetup(config = {}) {
    if (dashboardSetupDone) return;
    console.log('[Flow Automator] Running one-time dashboard setup...');

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const norm = (v) => String(v || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const st = window.getComputedStyle(el);
        if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
    };
    const humanClick = (el) => {
        if (!el) return;
        try {
            const rect = el.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const common = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
            try { el.dispatchEvent(new PointerEvent('pointerdown', common)); } catch (_) { }
            el.dispatchEvent(new MouseEvent('mousedown', common));
            try { el.dispatchEvent(new PointerEvent('pointerup', common)); } catch (_) { }
            el.dispatchEvent(new MouseEvent('mouseup', common));
            el.dispatchEvent(new MouseEvent('click', common));
        } catch (_) { try { el.click(); } catch (_) { } }
    };

    try {
        // Step 1: Click the "View full dashboard" button (icon: dashboard)
        const allButtons = Array.from(document.querySelectorAll('button'));
        const dashboardBtn = allButtons.find(b => {
            const icon = b.querySelector('i');
            return icon && icon.textContent.trim() === 'dashboard' && isVisible(b);
        });
        if (dashboardBtn) {
            console.log('[Flow Automator] Clicking dashboard button...');
            humanClick(dashboardBtn);
            await sleep(1000);
        } else {
            console.log('[Flow Automator] Dashboard button not found (already on dashboard?), continuing...');
        }

        // Step 2 was removed because it was clicking the "Criação de cenas" button which is incorrect now.

        // Step 3: Click the grid settings button (icon: settings_2)
        const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => {
            const icon = norm(b.querySelector('i')?.textContent);
            const popupType = norm(b.getAttribute('aria-haspopup') || '');
            const label = norm(
                (b.getAttribute('aria-label') || '') + ' ' +
                (b.getAttribute('data-tooltip') || '') + ' ' +
                (b.textContent || '')
            );
            // Match the tile-grid settings trigger, not any generic settings_2 button.
            return (
                icon === 'settings_2' &&
                popupType === 'menu' &&
                isVisible(b) &&
                (
                    label.includes('grid settings') ||
                    label.includes('tile grid') ||
                    label.includes('configuracoes da grade') ||
                    label.includes('configuracoes de grade') ||
                    label.includes('grade de blocos')
                )
            );
        });

        if (settingsBtn) {
            // Only click if not already expanded
            if (settingsBtn.getAttribute('aria-expanded') !== 'true') {
                console.log('[Flow Automator] Opening settings_2 menu...');
                humanClick(settingsBtn);
                await sleep(800);
            } else {
                console.log('[Flow Automator] settings_2 menu already open.');
            }
        } else {
            console.warn('[Flow Automator] Settings_2 button not found, continuing to look for Grid tab...');
        }

        // Step 4: Wait for the dropdown menu and click the 'Grid/Grade' tab
        let gridTab = null;
        for (let i = 0; i < 25; i++) {
            gridTab = Array.from(document.querySelectorAll('[role="tab"], button')).find(b => {
                const label = norm(b.getAttribute('aria-label') || '');
                const iconText = norm(b.querySelector('i')?.textContent);
                const text = norm(b.textContent || '');
                const isGridTab = (
                    label === 'grid' ||
                    label === 'grade' ||
                    text.startsWith('grid') ||
                    text.startsWith('grade')
                );
                return isGridTab && isVisible(b);
            });
            if (gridTab) break;
            await sleep(200);
        }

        if (gridTab) {
            console.log('[Flow Automator] Clicking Grid/Grade tab...');
            humanClick(gridTab);
            await sleep(500);
            // Close the menu with Escape to clean up
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
            await sleep(300);
            dashboardSetupDone = true;
        } else {
            console.warn('[Flow Automator] Grid/Grade tab not found; setup will be retried later.');
        }

        console.log('[Flow Automator] Dashboard setup complete.');
    } catch (e) {
        console.warn('[Flow Automator] initDashboardSetup error:', e.message);
    }
}

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

async function realPressEnter() {
    return new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'mainWorldPressEnter' }, (res) => {
            if (chrome.runtime.lastError) console.warn('[Flow Automator] realPressEnter error:', chrome.runtime.lastError.message);
            resolve(res && res.success);
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

// ===== Helper: Find Prompt Editor (scores candidates by size/visibility) =====
// Avoids picking hidden/disabled editors or search inputs.
function findPromptEditor() {
    const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
    };
    const selector = "textarea, [role='textbox'], [contenteditable='true'], [contenteditable='plaintext-only'], [data-slate-editor='true']";
    const candidates = Array.from(document.querySelectorAll(selector))
        .filter(el => isVisible(el))
        .filter(el => !el.disabled && !el.readOnly)
        .filter(el => {
            const label = [
                el.getAttribute('type'),
                el.getAttribute('aria-label'),
                el.getAttribute('placeholder'),
                el.getAttribute('name'),
                el.id,
                el.className
            ].map(v => String(v || '')).join(' ').toLowerCase();
            return !/\bsearch\b/.test(label);
        })
        .map(el => {
            const rect = el.getBoundingClientRect();
            const tag = String(el.tagName || '').toLowerCase();
            const score = rect.width * rect.height + rect.bottom + (tag === 'textarea' ? 5000 : 0);
            return { element: el, score };
        })
        .sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
}

// ===== Helper: Fill Prompt Input via Main World =====
// Delegates entirely to background.js which uses Slate's native API via React Fiber.
async function fillPromptInput(promptText) {
    const input = findPromptEditor();
    if (!input) {
        console.warn('[Flow Automator] fillPromptInput: editor element not found');
        return false;
    }

    // Delegate to background.js (Slate native API via React Fiber)
    const res = await chrome.runtime.sendMessage({ action: 'mainWorldFillText', text: promptText });
    if (!res?.success) {
        console.warn('[Flow Automator] mainWorldFillText failed:', res?.error);
        return false;
    }
    console.log('[Flow Automator] mainWorldFillText result:', JSON.stringify(res));
    return true;
}

function normalizePromptText(value) {
    return String(value || '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isPromptApplied(promptText) {
    const input = findPromptEditor();
    if (!input) return false;

    const expected = normalizePromptText(promptText);
    const actual = normalizePromptText(input.innerText || input.textContent || input.value || '');
    if (!expected) return actual.length > 0;
    if (actual.includes(expected)) return true;

    // Accept partial match for long prompts when editor normalizes punctuation/spaces.
    return expected.length > 24 && actual.includes(expected.slice(0, 24));
}

async function ensurePromptInput(promptText, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const ok = await fillPromptInput(promptText);
        await sleep(500);
        if (ok && isPromptApplied(promptText)) return true;
        console.warn(`[Flow Automator] Prompt not confirmed in editor (attempt ${attempt}/${maxAttempts})`);
    }
    return false;
}


// ===== Settings Selection (all in MAIN world via background.js) =====
// Uses afHumanClick (with clientX/clientY) - confirmed working approach from reference extension.
// Selectors confirmed by browser inspection:
//   Mode tabs:   button[role='tab'][id$='trigger-IMAGE'] / trigger-VIDEO
//   Ratio tabs:  trigger-LANDSCAPE / LANDSCAPE_4_3 / SQUARE / PORTRAIT_3_4 / PORTRAIT
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
        // Broad selector for slots: elements with aria-haspopup="dialog" or data-card-open
        // We match any element (div or button) that contains an img, video or background-image
        return document.querySelectorAll('[aria-haspopup="dialog"] img, [aria-haspopup="dialog"] video, [aria-haspopup="dialog"] [style*="background-image"], [data-card-open] img, [data-card-open] video, [data-card-open] [style*="background-image"]').length;
    };

    const waitForInitialSlotFilled = async (beforeCount, timeoutMs = 20000) => {
        let left = timeoutMs;
        while (left > 0) {
            const afterCount = countSlotImages();
            if (afterCount > beforeCount) return true;
            await sleep(500);
            left -= 500;
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
        // O Flow mudou para <div type="button" aria-haspopup="dialog">Start</div>
        const candidates = Array.from(document.querySelectorAll("[aria-haspopup='dialog'][type='button'], div[aria-haspopup='dialog'], button[aria-haspopup='dialog']"))
            .filter(isVisible);

        const initialBtn = candidates.find(el => {
            const t = norm(el.textContent);
            return t === 'start' || t === 'inicio' || t === 'inicial' || t === 'initial' || 
                   t.includes('start') || t.includes('inicio') || t.includes('inicial') || t.includes('initial');
        });

        if (initialBtn) return clickElementSafe(initialBtn);
        
        // Se não achar por texto, geralmente o 'Start' é o primeiro da lista
        if (candidates.length > 0) return clickElementSafe(candidates[0]);
        
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
    
    // 1. Scan by img/video src
    document.querySelectorAll(selector).forEach(el => {
        const src = (el.getAttribute('src') || '').trim();
        if (src) urls.add(src);
    });

    // 2. Scan by /edit/ UUIDs (more robust)
    let idCount = 0;
    document.querySelectorAll('a[href*="/edit/"]').forEach(a => {
        const href = a.getAttribute('href') || a.href || '';
        const match = href.match(/\/edit\/([a-f0-9-]{36})/i);
        if (match) {
            urls.add(match[1]);
            idCount++;
        }
    });

    // 3. Scan by [data-tile-id] directly (covers cards without media yet)
    document.querySelectorAll('[data-tile-id]').forEach(el => {
        const tid = el.getAttribute('data-tile-id');
        if (tid) {
            // Flow usually prefixes tile-id with fe_id_...
            const match = tid.match(/([a-f0-9-]{36})/i);
            if (match) urls.add(match[1]);
        }
    });
    
    console.log(`[Flow Automator] scanExistingUrls found ${urls.size} items.`);
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
        // Check for error toasts (Queue Full / Policy / Empty Command)
        const errorToasts = document.querySelectorAll('[data-sonner-toast]');
        for (const toast of errorToasts) {
            const icon = toast.querySelector('i');
            if (icon && icon.textContent.trim() === 'error') {
                const text = toast.textContent?.trim() || "";
                if (text.includes('5') || text.toLowerCase().includes('fila')) throw new Error("A fila esta cheia (QUEUE_FULL)");
                if (text.toLowerCase().includes('comando')) {
                    // This is handled by the retry logic in processPrompt
                    throw new Error("Erro do Flow: Você precisa fornecer um comando");
                }
                throw new Error("Erro do Flow: " + text);
            }
        }

        // 1. Check for Progress Indicators (reliable "Generating" state)
        const progressElements = document.querySelectorAll('[class*="percentage"], [class*="status"], [class*="Generating"], [class*="loading"], [class*="iEQNVH"]');
        let isGenerating = false;
        for (const el of progressElements) {
            const text = el.textContent.trim();
            if (text.match(/^\d+%$/) || text.toLowerCase().includes('gerando') || text.toLowerCase().includes('generating') || text.toLowerCase().includes('criando')) {
                isGenerating = true;
                updateStatus('Status detectado: ' + text);
                break;
            }
        }

        // 2. Scan for NEW Ready Items (Media UUIDs from /edit/ links)
        let newReadyItem = null;
        
        // Strategy A: UUIDs from Edit Links (Very robust)
        const editLinks = document.querySelectorAll('a[href*="/edit/"]');
        for (const link of editLinks) {
            const href = link.getAttribute('href');
            const match = href.match(/\/edit\/([a-f0-9-]{36})/i);
            if (match) {
                const uuid = match[1];
                if (!existingUrls.has(uuid)) {
                    console.log('[Flow Automator] Detectado novo UUID via link:', uuid);
                    // Prioritize specific card containers (tile-id) over rows (data-index)
                    const card = link.closest('[data-tile-id]') || link.closest('.sc-5923b123-0') || link.closest('[data-index]') || link.parentElement;
                    newReadyItem = { card: card, wrapper: card, src: uuid };
                    break;
                }
            }
        }

        // Strategy B: Media URLs (Legacy fallback)
        if (!newReadyItem) {
            const selector = mode === 'image' ? IMAGE_RESULT_SELECTOR : VIDEO_RESULT_SELECTOR;
            const candidates = document.querySelectorAll(selector);
            for (const el of candidates) {
                const src = (el.getAttribute('src') || '').trim();
                if (src && !existingUrls.has(src)) {
                    console.log('[Flow Automator] Detectado novo src:', src);
                    const card = el.closest('[data-tile-id]') || el.closest('.sc-5923b123-0') || el.closest('[data-index]') || el.parentElement;
                    newReadyItem = { card: card, wrapper: card, src };
                    break;
                }
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
        const isVisibleCheck = (el) => {
            if (!el || !el.isConnected) return false;
            const st = window.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
            const r = el.getBoundingClientRect();
            return r.width > 4 && r.height > 4;
        };

        const norm = (v) => String(v || '').toLowerCase().trim();
        const candidates = Array.from(document.querySelectorAll('button,[role="button"]')).filter(isVisibleCheck);

        const btn = candidates.find((el) => {
            const txt = norm(el.textContent);
            const aria = norm(el.getAttribute('aria-label'));
            const title = norm(el.getAttribute('title'));
            const icon = norm(el.querySelector('i')?.textContent);
            
            // Suporte expandido para icones de fechar/conclusao e texto Dismiss
            return (
                icon === 'close' ||
                icon === 'cancel' ||
                icon === 'check' ||
                icon === 'check_circle' ||
                txt === 'dismiss' ||
                txt === 'dismissed' ||
                txt === 'dispensar' ||
                txt === 'fechar' ||
                txt.includes('close') ||
                aria.includes('close') ||
                aria.includes('dismiss') ||
                aria.includes('fechar') ||
                title.includes('close') ||
                title.includes('fechar')
            );
        });

        if (btn) {
            console.log('[Flow Automator] Clicando para fechar toast/modal (' + (btn.textContent || 'icon') + ')...');
            reactClick(btn);
            await sleep(300);
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
    const fallbackPrompt = 'Animate this image with natural cinematic motion, preserving subject identity and scene details.';
    const effectivePrompt = String(prompt || '').trim() || fallbackPrompt;
    console.log('[Flow Automator] Processing prompt via temp logic:', effectivePrompt);

    // Guard against concurrent calls -- a new processPrompt must not start while another is running
    if (isProcessing) {
        console.warn('[Flow Automator] Already processing a prompt, ignoring new request');
        return;
    }
    isProcessing = true;
    currentPromptText = effectivePrompt;

    try {
        showOverlay('Processando...', effectivePrompt);
        setStatusProgress(index + 1, config.totalPrompts || 1);

        // One-time dashboard setup before the very first prompt
        if (index === 0) {
            updateOverlay('Configurando dashboard...');
            await initDashboardSetup(config);
        }

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
        if (image) {
            mode = 'image-to-video';
        } else if (config.mode === 'image') {
            mode = 'create-image';
        } else if (config.mode === 'image-to-video' || config.mode === 'frames') {
            // Only force image-to-video if no image provided but user explicitly wants that mode 
            // (e.g. if they already have an image in the slot manually)
            mode = 'image-to-video';
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
            if (config.randomIncludeLandscape43) options.push('4:3');
            if (config.randomIncludeSquare) options.push('1:1');
            if (config.randomIncludePortrait34) options.push('3:4');
            if (config.randomIncludePortrait) options.push('9:16');
            if (options.length > 0) {
                targetRatio = options[Math.floor(Math.random() * options.length)];
                console.log('[Flow Automator] Randomized ratio:', targetRatio);
            }
        }

        const settingsConfig = {
            mode: mode,  // 'create-image' | 'text-to-video' | 'image-to-video'
            imageModel: config.imageModel || 'Nano Banana 2',
            videoModel: config.videoModel || 'Veo 3.1 - Lite [Lower Priority]',
            modelKey: normalizeImageModelKey(config.imageModel || 'Nano Banana 2'),
            aspectRatio: targetRatio
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
        await sleep(1000); // Wait for settings menu to fully close

        // Video-specific: duration setting
        if (mode !== 'create-image' && config.videoDuration) {
            updateOverlay(`Ajustando duracao (${config.videoDuration})...`);
            await setVideoDuration(config.videoDuration);
        }


        // 4. Input Prompt
        updateOverlay('Inserindo prompt...');
        const inputSuccess = await ensurePromptInput(effectivePrompt, 3);
        if (!inputSuccess) throw new Error('Falha ao inserir prompt (campo permaneceu vazio)');
        await sleep(1500);

        // 5. Click Generate - wait for arrow_forward button to be enabled (like reference extension)
        updateOverlay('Iniciando geracao...');

        // Verify text is actually in the editor before trying to submit
        const editorEl = document.querySelector('[data-slate-editor="true"]');
        const editorText = editorEl ? (editorEl.innerText || editorEl.textContent || '').trim() : '';
        console.log('[Flow Automator] Editor text after insert:', editorText);
        if (!editorText) {
            throw new Error('Editor vazio apos insercao - texto nao foi aceito pelo Slate');
        }

        // Find generate button: look for arrow_forward icon (not aria-disabled) 
        // scoped to the editor's parent container
        let enabledGenerateBtn = null;
        let retries = 20;
        while (retries > 0) {
            const editorScope = document.querySelector('[data-slate-editor="true"]');
            let scope = editorScope;
            // Walk up max 10 levels to find the button near the editor
            for (let depth = 0; scope && depth < 10; depth++, scope = scope.parentElement) {
                const buttons = Array.from(scope.querySelectorAll('button, [role="button"]'));
                const found = buttons.find(b => {
                    if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
                    const text = (b.textContent || '').trim();
                    const icon = b.querySelector('i, svg');
                    const iconText = icon ? (icon.textContent || '').trim() : '';
                    const ariaLabel = (b.getAttribute('aria-label') || '').toLowerCase();
                    
                    return iconText === 'arrow_forward' || 
                           text === 'Criar' || 
                           text === 'Create' ||
                           ariaLabel.includes('gerar') ||
                           ariaLabel.includes('generate');
                });
                if (found) { enabledGenerateBtn = found; break; }
            }
            if (enabledGenerateBtn) break;
            await sleep(500);
            retries--;
        }

        if (!enabledGenerateBtn) {
            console.warn('[Flow Automator] Generate button not found near editor, falling back to global search');
            enabledGenerateBtn = document.evaluate(SELECTORS.GENERATE_BUTTON_XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        }

        if (enabledGenerateBtn) {
            // MARK the button with a unique attribute to ensure we click the RIGHT one via background
            const uniqueId = 'btn_' + Date.now();
            enabledGenerateBtn.setAttribute('data-flow-target-click', uniqueId);
            const targetXpath = `//*[@data-flow-target-click='${uniqueId}']`;

            // Re-scan right before clicking to avoid lazy-load race conditions
            const finalExistingUrls = scanExistingUrls(scanMode);
            console.log(`[Flow Automator] Final pre-click scan: ${finalExistingUrls.size} items.`);

            let cardResult = null;
            try {
                updateOverlay('Iniciando geração...');
                
                // 1. Local human events (Pointer/Mouse)
                try {
                    const rect = enabledGenerateBtn.getBoundingClientRect();
                    const x = rect.left + rect.width / 2;
                    const y = rect.top + rect.height / 2;
                    const common = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
                    try { enabledGenerateBtn.dispatchEvent(new PointerEvent('pointerdown', common)); } catch (_) { }
                    enabledGenerateBtn.dispatchEvent(new MouseEvent('mousedown', common));
                    try { enabledGenerateBtn.dispatchEvent(new PointerEvent('pointerup', common)); } catch (_) { }
                    enabledGenerateBtn.dispatchEvent(new MouseEvent('mouseup', common));
                    enabledGenerateBtn.dispatchEvent(new MouseEvent('click', common));
                } catch (_) { }
                await sleep(200);

                // 2. Native click
                if (typeof enabledGenerateBtn.click === 'function') enabledGenerateBtn.click();
                await sleep(200);

                // 3. Background click (redundancy)
                await chrome.runtime.sendMessage({ 
                    action: 'mainWorldReactClick', 
                    xpath: targetXpath 
                });
                
                // 4. Press Enter as final fallback
                await realPressEnter();

                // Cleanup
                enabledGenerateBtn.removeAttribute('data-flow-target-click');
                
                await sleep(2000); // Wait for generation to start 
                
                updateOverlay('Aguardando geracao...');
                cardResult = await waitForNewCard(finalExistingUrls, existingCards, config.generationTimeout * 1000, scanMode);
            } catch (e) {
                // Retry specifically for "empty command" error
                if (e.message.includes('fornecer um comando')) {
                    console.warn('[Flow Automator] Empty command detected. Retrying...');
                    // Dismiss the error toast so waitForNewCard doesn't re-detect it
                    await clickDismissButton();
                    // Aggressively remove any remaining sonner error toasts from DOM
                    const errorToasts = document.querySelectorAll('[data-sonner-toast]');
                    for (const toast of errorToasts) {
                        const icon = toast.querySelector('i');
                        if (icon && icon.textContent.trim() === 'error') {
                            console.warn('[Flow Automator] Force-removing error toast:', toast.textContent?.trim()?.substring(0, 80));
                            toast.remove();
                        }
                    }
                    await sleep(2000);

                    // Update existing sets in case partial generation occurred
                    const newUrls = scanExistingUrls(scanMode);
                    for (const url of newUrls) existingUrls.add(url);
                    const newCards = scanExistingCards(scanMode);
                    for (const card of newCards) existingCards.add(card);

                    // Re-fill prompt with full retry attempts
                    await ensurePromptInput(effectivePrompt, 3);
                    await sleep(2000);
                    await realClickByXPath(SELECTORS.GENERATE_BUTTON_XPATH);
                    await sleep(500);
                    await realPressEnter();
                    await sleep(1000);
                    cardResult = await waitForNewCard(existingUrls, existingCards, config.generationTimeout * 1000, scanMode);
                } else {
                    throw e;
                }
            }

            if (!cardResult) throw new Error('Timeout na geracao (card nao apareceu)');

            console.log('[Flow Automator] Found new card');

            // Now download...
            updateOverlay('Fazendo download...');
            await sleep(1000);

            let downloadSuccess = false;
            if (mode === 'create-image') {
                downloadSuccess = await downloadFromImageCard(cardResult.wrapper || cardResult.card, config.imageResolution || '2k');
            } else {
                const desiredVideoRes = normalizeVideoResolution(config.videoResolution || (config.doUpscale ? '1080p' : '720p'));
                downloadSuccess = await downloadFromVideoCard(cardResult.wrapper || cardResult.card, desiredVideoRes);
            }

            if (!downloadSuccess) throw new Error('Falha no download');

            console.log('[Flow Automator] Prompt completed successfully');
            sendComplete(true, null, effectivePrompt);

        } else {
            console.error("Generate button not found or disabled");
            throw new Error("Generate button invalid or disabled");
        }
    } catch (e) {
        console.error('[Flow Automator] Error processing prompt:', e);
        updateOverlay('Erro: ' + e.message);
        await sleep(3000); // Give user time to see error
        sendComplete(false, null, effectivePrompt, e.message);
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

    // CSS :hover cannot be triggered by JS events.
    // Strategy: inject a temporary <style> that forces child buttons visible on this card,
    // find the 3-dot button, click it, then remove the injected style.
    card.scrollIntoView({ block: 'center' });
    await sleep(300);

    const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
    };
    const norm = (v) => String(v || '').toLowerCase().trim();
    const iconText = (el) => norm(el?.querySelector('i')?.textContent);

    const findMoreBtn = (container = document.body) => {
        return Array.from(container.querySelectorAll('button, [role="button"], div')).find(b => {
            const iTxt = norm(b.querySelector('i')?.textContent);
            const lbl = norm((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-tooltip') || ''));
            const hasIcon = iTxt.includes('more_vert') || iTxt.includes('more_horiz');
            const hasLabel = lbl.includes('more') || lbl.includes('mais') || lbl.includes('menu') || lbl.includes('opcoes');
            return hasIcon || hasLabel;
        });
    };

    const findMainMenuWithDownload = () => {
        const menus = Array.from(document.querySelectorAll('[role="menu"], div[class*="menu-content"]')).filter(isVisible);
        return menus.find(m => {
            const items = Array.from(m.querySelectorAll('[role="menuitem"], [role="menuitemradio"], div[class*="menuitem"]'));
            return items.some(it => {
                const iTxt = norm(it.querySelector('i')?.textContent);
                const txt = norm(it.textContent);
                return iTxt.includes('download') || txt.includes('baixar') || txt.includes('download');
            });
        }) || null;
    };

    // 1) CSS injection approach: force card's overlay buttons visible, click 3-dots
    let mainMenu = null;
    const injectStyle = () => {
        const s = document.createElement('style');
        s.id = '__flow_hover_fix__';
        // Make all buttons/overlays inside card visible regardless of hover state
        s.textContent = `
            [data-flow-target-card] button,
            [data-flow-target-card] [role="button"],
            [data-flow-target-card] i,
            [data-flow-target-card] span,
            [data-flow-target-card] [class*="overlay"],
            [data-flow-target-card] [class*="action"],
            [data-flow-target-card] [class*="menu"] {
                opacity: 1 !important;
                visibility: visible !important;
                pointer-events: auto !important;
                display: block !important;
            }
        `;
        document.head.appendChild(s);
    };
    const removeStyle = () => {
        const s = document.getElementById('__flow_hover_fix__');
        if (s) s.remove();
    };

    // Tag the card temporarily so CSS targets it
    card.setAttribute('data-flow-target-card', '1');
    injectStyle();
    await sleep(300);

    // Real CDP Hover over the card center to trigger React's hover state
    const rect = card.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    console.log('[Flow Automator] Real CDP Hover (Video) at:', Math.round(cx), Math.round(cy));
    await chrome.runtime.sendMessage({ type: 'humanHover', x: cx, y: cy });
    await sleep(800);

    const moreBtn = findMoreBtn(card);
    if (moreBtn) {
        console.log('[Flow Automator] Found 3-dots button, clicking via CDP...');
        const btnRect = moreBtn.getBoundingClientRect();
        const bx = btnRect.left + btnRect.width / 2;
        const by = btnRect.top + btnRect.height / 2;
        await chrome.runtime.sendMessage({ type: 'humanClick', x: bx, y: by });
        await sleep(1000);
        mainMenu = findMainMenuWithDownload();
    } else {
        console.log('[Flow Automator] 3-dots button not found after hover');
    }

    // Always clean up
    removeStyle();
    card.removeAttribute('data-flow-target-card');

    // 2) Fallback: hover events
    if (!mainMenu) {
        console.log('[Flow Automator] Trying hover events fallback...');
        for (const el of [card, video].filter(Boolean)) {
            try {
                const rect = el.getBoundingClientRect();
                const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
                el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: cx, clientY: cy }));
                el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
                el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx, clientY: cy }));
            } catch (_) { }
        }
        await sleep(500);
        const moreBtnHover = findMoreBtn(card) || findMoreBtn(document.body);
        if (moreBtnHover) {
            reactClick(moreBtnHover);
            await sleep(600);
            mainMenu = findMainMenuWithDownload();
        }
    }

    // 3) Final fallback: right-click context menu
    if (!mainMenu) {
        const target = video || card;
        console.log('[Flow Automator] Trying right-click context menu as final fallback...');
        rightClick(target);
        await sleep(800);
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

    const resMenu = Array.from(document.querySelectorAll('[role="menu"]'))
        .filter(isVisible)
        .find(m => {
            const items = Array.from(m.querySelectorAll('[role="menuitem"]'));
            return items.some(it => parseResolution(it.textContent));
        });
    if (!resMenu) {
        console.log('[Flow Automator] Resolution submenu not found');
        return false;
    }

    const items = Array.from(resMenu.querySelectorAll('[role="menuitem"]')).map(el => ({
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
    console.log('[Flow Automator] Iniciando download de imagem...');
    updateOverlay('Preparando download...');

    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // CSS injection trick to force buttons visible
    const injectStyle = () => {
        const s = document.createElement('style');
        s.id = '__flow_hover_fix_img__';
        s.textContent = `
            [data-flow-target-card-img] button,
            [data-flow-target-card-img] [role="button"],
            [data-flow-target-card-img] i,
            [data-flow-target-card-img] span,
            [data-flow-target-card-img] [class*="overlay"] {
                opacity: 1 !important;
                visibility: visible !important;
                display: flex !important;
                pointer-events: auto !important;
            }
        `;
        document.head.appendChild(s);
    };
    const removeStyle = () => {
        const s = document.getElementById('__flow_hover_fix_img__');
        if (s) s.remove();
    };

    card.setAttribute('data-flow-target-card-img', '1');
    injectStyle();
    await sleep(300);

    // Force data-state="open" on all nested spans to trigger React's overlay visibility,
    // bypassing the need for a real hover event (which CDP might not reliably trigger).
    const stateSpans = card.querySelectorAll('span[data-state]');
    for (const span of stateSpans) {
        if (span.getAttribute('data-state') !== 'open') {
            span.setAttribute('data-state', 'open');
        }
    }
    await sleep(400);

    // Real CDP Hover over the card center to trigger React's hover state
    const rect = card.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    console.log('[Flow Automator] Real CDP Hover at:', Math.round(cx), Math.round(cy));
    await chrome.runtime.sendMessage({ type: 'humanHover', x: cx, y: cy });
    await sleep(800); // Wait for React to render the hover-only buttons

    const norm = (v) => String(v || '').toLowerCase().trim();

    const findMoreBtn = () => {
        const buttons = Array.from(card.querySelectorAll('button, [role="button"]'));
        if (buttons.length > 0) {
            console.log('[Flow Automator] Botoes encontrados no card:', buttons.map(b => (b.textContent || b.getAttribute('aria-label') || 'unlabeled').trim()).join(' | '));
        }
        
        // 1. Look for 'more' in text or label
        let btn = buttons.find(b => {
            const txt = norm(b.textContent + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-tooltip') || ''));
            const iconText = norm(b.querySelector('i')?.textContent || '');
            return txt.includes('more') || txt.includes('mais') || iconText.includes('more') || txt.includes('opções') || txt.includes('options');
        });
        if (btn) return btn;

        // 2. Look for any button with an icon that looks like 3 dots (vertical or horizontal)
        btn = buttons.find(b => {
            const icon = b.querySelector('i, svg, span[class*="icon"]');
            if (!icon) return false;
            const itxt = norm(icon.textContent);
            return itxt.includes('more_') || itxt.includes('dots');
        });
        
        return btn;
    };

    let moreBtn = findMoreBtn();
    if (moreBtn) {
        console.log('[Flow Automator] Encontrado botao de menu no card, clicando via CDP...');
        const btnRect = moreBtn.getBoundingClientRect();
        const bx = btnRect.left + btnRect.width / 2;
        const by = btnRect.top + btnRect.height / 2;
        await chrome.runtime.sendMessage({ type: 'humanClick', x: bx, y: by });
        await sleep(1000);
    } else {
        console.log('[Flow Automator] Botao de menu nao encontrado apos hover, tentando clique direito...');
        const img = card.querySelector(IMAGE_RESULT_SELECTOR) || card.querySelector('img');
        if (img) rightClick(img);
        await sleep(1000);
    }

    // Now look for download in the menu (portal at end of body)
    let menuItems = document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], div[class*="menuitem"]');
    let downloadOption = Array.from(menuItems).find(i => {
        const text = norm(i.textContent);
        const iTxt = norm(i.querySelector('i')?.textContent);
        return text.includes('baixar') || text.includes('download') || iTxt.includes('download');
    });

    if (!downloadOption) {
        removeStyle();
        card.removeAttribute('data-flow-target-card-img');
        return false;
    }

    // Resolucao
    reactClick(downloadOption);
    await sleep(800);

    // Options: 1k, 2k, 4k
    const targets = (IMAGE_DOWNLOAD_OPTIONS[resolution] || IMAGE_DOWNLOAD_OPTIONS['2k']).map(t => t.toLowerCase());
    menuItems = document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], .sc-16c4830a-1');
    const option = Array.from(menuItems).find(it => {
        const txt = norm(it.textContent);
        return targets.some(t => txt.includes(t));
    });

    if (option) {
        reactClick(option);
        await sleep(500);
        removeStyle();
        card.removeAttribute('data-flow-target-card-img');
        return true;
    }

    // Fallback: menu-based download failed. Try direct download from image src.
    removeStyle();
    card.removeAttribute('data-flow-target-card-img');

    const img = card.querySelector(IMAGE_RESULT_SELECTOR) || card.querySelector('img');
    const imgSrc = (img?.getAttribute('src') || img?.src || '').trim();
    if (imgSrc) {
        console.log('[Flow Automator] Falling back to direct download from src:', imgSrc.substring(0, 100));
        const absoluteUrl = imgSrc.startsWith('/') ? 'https://labs.google' + imgSrc : imgSrc;
        chrome.runtime.sendMessage({
            action: 'registerDownload',
            url: absoluteUrl,
            type: 'image'
        });
        await sleep(300);
        chrome.runtime.sendMessage({ type: 'downloadUrl', url: absoluteUrl });
        await sleep(500);
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
        // Prevent multiple buttons
        if (bodyEl.querySelector('.fa-unpause-btn')) return;

        const unpauseBtn = document.createElement('button');
        unpauseBtn.className = 'fa-unpause-btn';
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
            display: block;
            margin-left: auto;
            margin-right: auto;
        `;
        unpauseBtn.onmouseover = () => unpauseBtn.style.transform = 'scale(1.05)';
        unpauseBtn.onmouseout = () => unpauseBtn.style.transform = 'scale(1)';
        unpauseBtn.onclick = () => {
            chrome.runtime.sendMessage({ type: 'unpause' });
            unpauseBtn.remove();
        };
        bodyEl.appendChild(unpauseBtn);
    }
}

function handleUnpaused() {
    updateOverlay('Retomando automacao...');
    if (statusElement) {
        const btn = statusElement.querySelector('.fa-unpause-btn');
        if (btn) btn.remove();
    }
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

            if (resolution === '1k') {
                await sleep(1000);
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
    
    // Pequeno delay inicial
    await sleep(800);

    while (Date.now() - startTime < timeoutMs) {
        const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]'));
        
        // 1. Procura estritamente pelo ícone 'check_circle' (indica conclusão real)
        const finishedToast = toasts.find(t => {
            const icons = Array.from(t.querySelectorAll('i'));
            return icons.some(i => (i.textContent || '').trim() === 'check_circle');
        });

        if (finishedToast) {
            console.log('[Flow Automator] Conclusão detectada (check_circle encontrado).');
            // Procura o botão Dismiss dentro deste toast de conclusão
            const dismissBtn = Array.from(finishedToast.querySelectorAll('button')).find(b => {
                const t = (b.textContent || '').toLowerCase();
                return t.includes('dismiss') || t.includes('dispensar');
            }) || finishedToast.querySelector('button');

            if (dismissBtn) {
                console.log('[Flow Automator] Clicando em Dismiss no toast final...');
                reactClick(dismissBtn);
            }
            await sleep(1000);
            return true;
        }

        // 2. Verifica se é apenas o toast de "Upscaling your image" (progresso)
        const isProgress = toasts.some(t => {
            const text = t.textContent.toLowerCase();
            return text.includes('upscaling your image') || text.includes('aumentando sua imagem');
        });

        if (isProgress) {
            updateOverlay('Fazendo upscale...');
            // Não clicamos em Dismiss
        }

        // 3. Se o background já detectou o download, esperamos um pouco pelo toast de conclusão
        if (lastFlowDownloadDetectedAt > baselineDownloadTs) {
            console.log('[Flow Automator] Download detectado, procurando toast de conclusão para limpar...');
            const finalCheck = Array.from(document.querySelectorAll('[data-sonner-toast]')).find(t => 
                t.textContent.includes('check_circle') || 
                Array.from(t.querySelectorAll('i')).some(i => i.textContent === 'check_circle')
            );
            
            if (finalCheck) {
                const btn = finalCheck.querySelector('button');
                if (btn) reactClick(btn);
                await sleep(500);
            }
            return true;
        }

        // 4. Se não há toast de progresso nem de sucesso, e já passou um tempo, prosseguimos
        const anyUpscaleToast = toasts.some(t => t.textContent.toLowerCase().includes('upscal'));
        if (!anyUpscaleToast && Date.now() - startTime > 15000) {
            console.log('[Flow Automator] Nenhum toast de upscale detectado após 15s.');
            return true;
        }

        updateOverlay('Aguardando upscale...');
        await sleep(1000); 
    }
    
    console.log('[Flow Automator] Timeout aguardando upscale.');
    return false;
}
