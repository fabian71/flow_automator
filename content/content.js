// ===== Flow Automator Content Script (v6 - flow.google.com) =====
// The new Google Flow (flow.google.com) is an Angular Material app:
//   - prompt editor: ProseMirror (.ProseMirror[contenteditable])
//   - settings: overlay panel (.cdk-overlay-container) with mat-button-toggle radios
//   - results: <flow-grid-tile-container> tiles, media served from flow-content.google
//   - download: right-click (context menu) > "download" > resolution submenu
// All lookups prefer icon ligatures (mat-icon text) over translated labels so the
// script works with the UI in Portuguese or English.
console.log('[Flow Automator] Content script loaded (v6)');



// ===== State =====
let isProcessing = false;
let currentPromptText = '';
let lastFlowDownloadDetectedAt = 0;

// ===== Message handling =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'processPrompt') {
        processPrompt(message.prompt, message.index, message.config || {}, message.image);
        sendResponse({ received: true });
    } else if (message.type === 'ping') {
        sendResponse({ pong: true });
    } else if (message.type === 'complete') {
        showComplete(message.success || 0, message.failed || 0);
        sendResponse({ received: true });
    } else if (message.type === 'paused') {
        handlePaused(message);
        sendResponse({ received: true });
    } else if (message.type === 'unpaused') {
        handleUnpaused();
        sendResponse({ received: true });
    } else if (message.type === 'flowDownloadDetected') {
        lastFlowDownloadDetectedAt = Date.now();
        console.log('[Flow Automator] Download detected:', message.filename || message.url || '');
        sendResponse({ received: true });
    }
    return true;
});

// ===== Generic DOM helpers =====
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function norm(v) {
    return String(v || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Letters/digits only ("Veo 3.1 - Lite" -> "veo31lite")
function compact(v) {
    return norm(v).replace(/[^a-z0-9]/g, '');
}

function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const st = window.getComputedStyle(el);
    if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
}

async function waitFor(fn, timeoutMs = 5000, stepMs = 150) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        let v = null;
        try { v = fn(); } catch (_) { v = null; }
        if (v) return v;
        await sleep(stepMs);
    }
    return null;
}

// Text of the first material icon inside an element (e.g. "download", "crop_16_9")
function iconOf(el) {
    const icon = el?.querySelector('mat-icon, .google-symbols, i');
    return String(icon?.textContent || '').trim();
}

// Visible label without the icon ligature text
function labelOf(el) {
    if (!el) return '';
    let txt = el.textContent || '';
    el.querySelectorAll('mat-icon, .google-symbols, i').forEach(i => {
        txt = txt.replace(i.textContent || '', ' ');
    });
    return txt.replace(/\s+/g, ' ').trim();
}

function isDisabled(el) {
    return !!(el?.disabled || el?.getAttribute('aria-disabled') === 'true');
}

// Synthetic pointer+mouse sequence (single click event - avoids double submits)
function fireClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) { }
    const r = el.getBoundingClientRect();
    const o = {
        bubbles: true, cancelable: true, view: window,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0
    };
    try {
        ['pointerover', 'pointerenter', 'pointermove', 'pointerdown'].forEach(t => el.dispatchEvent(new PointerEvent(t, o)));
    } catch (_) { }
    el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (_) { }
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    return true;
}

// Real (trusted) click through the background's chrome.debugger (CDP).
// Flow ignores synthetic events on the "generate" button (checks isTrusted).
async function trustedClick(el) {
    if (!el) return false;
    const token = 'fa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    el.setAttribute('data-fa-click', token);
    try {
        const res = await chrome.runtime.sendMessage({ type: 'humanClickElement', token });
        return !!res?.success;
    } catch (_) {
        return false;
    } finally {
        setTimeout(() => { try { el.removeAttribute('data-fa-click'); } catch (_) { } }, 1000);
    }
}

function overlayRoot() {
    return document.querySelector('.cdk-overlay-container');
}

function overlayButtons(selector = 'button, [role="menuitem"], [role="option"]') {
    const root = overlayRoot();
    if (!root) return [];
    return Array.from(root.querySelectorAll(selector)).filter(isVisible);
}

// Closes menus/popovers (CDK listens to Escape on body, backdrop click closes too)
async function closeOverlays() {
    if (getSettingsPanel() && !getModelMenuItems().length) {
        await closeSettingsPanel();
    }
    await escapeOverlays();
}

async function escapeOverlays() {
    for (let i = 0; i < 3; i++) {
        const backdrop = document.querySelector('.cdk-overlay-backdrop.cdk-overlay-backdrop-showing, .cdk-overlay-backdrop');
        const openPanel = overlayRoot()?.querySelector('.cdk-overlay-pane [role="menu"], .cdk-overlay-pane [role="radiogroup"], .cdk-overlay-pane [role="dialog"]');
        if (!backdrop && !openPanel) return;
        const kb = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
        (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', kb));
        document.body.dispatchEvent(new KeyboardEvent('keydown', kb));
        if (backdrop) fireClick(backdrop);
        await sleep(350);
    }
}

// Dismiss "Dispensar"/"Dismiss" snackbars so they don't pile up
function dismissToasts() {
    overlayButtons('button').forEach(b => {
        const t = norm(b.textContent);
        if (t === 'dispensar' || t === 'dismiss' || t === 'fechar' || t === 'close') {
            if (b.closest('.mat-mdc-snack-bar-container, mat-snack-bar-container, [class*="snack"], [role="status"], [role="alert"]')) {
                try { b.click(); } catch (_) { }
            }
        }
    });
}

function readToastTexts() {
    const root = overlayRoot();
    if (!root) return [];
    return Array.from(root.querySelectorAll('.mat-mdc-snack-bar-container, mat-snack-bar-container, [class*="snack"], [role="status"], [role="alert"]'))
        .filter(isVisible)
        .map(t => ({ text: (t.innerText || '').replace(/\s+/g, ' ').trim(), icon: iconOf(t) }))
        .filter(t => t.text);
}

const FAILURE_RE = /(erro|error|falh|fail|nao foi possivel|couldn.?t|could not|unable|violat|polic|nao e possivel|tente novamente|try again|limite|limit|quota|cota|creditos insuficientes|not enough credits|insufficient)/;

// ===== Prompt box =====
function getEditor() {
    const eds = Array.from(document.querySelectorAll('.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]')).filter(isVisible);
    // Prefer the one inside the prompt box
    return eds.find(e => e.closest('.base-prompt-box')) || eds[eds.length - 1] || null;
}

function getPromptBox() {
    const ed = getEditor();
    if (!ed) return null;
    const known = ed.closest('.base-prompt-box');
    if (known) return known;
    let el = ed;
    for (let i = 0; i < 10 && el; i++) {
        el = el.parentElement;
        if (el && getGenerateButtonIn(el)) return el;
    }
    return ed.parentElement;
}

function getGenerateButtonIn(scope) {
    if (!scope) return null;
    const btns = Array.from(scope.querySelectorAll('button'));
    return btns.find(b => /iniciar gera|start gen|generate|gerar|criar|create/i.test(b.getAttribute('aria-label') || '') && iconOf(b) === 'arrow_forward')
        || btns.find(b => iconOf(b) === 'arrow_forward')
        || null;
}

function getGenerateButton() {
    return getGenerateButtonIn(getPromptBox());
}

// The pill that opens the settings panel: contains a crop_* icon and "x1".."x4"
function getSettingsTrigger() {
    const box = getPromptBox() || document;
    const btns = Array.from(box.querySelectorAll('button')).filter(isVisible);
    return btns.find(b => /configura|settings/i.test(b.getAttribute('aria-label') || ''))
        || btns.find(b => /crop_/.test(b.textContent || '') && /x[1-4]/.test(b.textContent || ''))
        || null;
}

function editorText() {
    const ed = getEditor();
    return String(ed?.innerText || '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

async function fillPrompt(text) {
    const wanted = String(text || '').replace(/\s+/g, ' ').trim();
    for (let attempt = 1; attempt <= 3; attempt++) {
        const ed = getEditor();
        if (!ed) { await sleep(800); continue; }
        ed.focus();
        await sleep(80);
        // Select everything inside the editor and replace it (ProseMirror handles execCommand input)
        try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(ed);
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (_) { }
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, wanted);
        await sleep(400);
        const got = editorText();
        if (got === wanted || (wanted.length > 30 && got.includes(wanted.slice(0, 30)))) return true;
        console.warn(`[Flow Automator] Prompt not confirmed (attempt ${attempt}):`, got.slice(0, 60));
        await sleep(400);
    }
    return false;
}

// ===== Settings panel =====
function getSettingsPanel() {
    const root = overlayRoot();
    if (!root) return null;
    const panes = Array.from(root.querySelectorAll('.cdk-overlay-pane')).filter(isVisible);
    // The panel with the image/video toggle
    return panes.find(p => Array.from(p.querySelectorAll('button[role="radio"]')).some(b => ['image', 'videocam'].includes(iconOf(b)))) || null;
}

// The settings pill is a toggle whose internal state can get out of sync when the
// panel is closed by Escape/outside click, so we click, verify, and retry.
async function openSettingsPanel() {
    let panel = getSettingsPanel();
    if (panel) return panel;
    for (let attempt = 1; attempt <= 4; attempt++) {
        const trigger = getSettingsTrigger();
        if (!trigger) throw new Error('Botao de configuracoes nao encontrado');
        if (attempt < 4) fireClick(trigger); else await trustedClick(trigger);
        panel = await waitFor(getSettingsPanel, 1500, 100);
        if (panel) return panel;
    }
    throw new Error('Painel de configuracoes nao abriu');
}

async function closeSettingsPanel() {
    for (let attempt = 1; attempt <= 3 && getSettingsPanel(); attempt++) {
        const trigger = getSettingsTrigger();
        if (trigger) fireClick(trigger);
        if (await waitFor(() => !getSettingsPanel(), 1200, 100)) break;
    }
    if (getSettingsPanel()) await escapeOverlays();
    await sleep(250);
}

function panelRadios() {
    const panel = getSettingsPanel();
    return panel ? Array.from(panel.querySelectorAll('button[role="radio"]')).filter(isVisible) : [];
}

function findRadio(pred) {
    return panelRadios().find(b => pred({ icon: iconOf(b), label: norm(labelOf(b)), el: b })) || null;
}

async function selectRadio(pred, what, required = true) {
    let btn = findRadio(pred);
    if (!btn) {
        if (required) throw new Error(`Opcao nao encontrada no Flow: ${what}`);
        console.warn('[Flow Automator] Option not available:', what);
        return false;
    }
    if (btn.getAttribute('aria-checked') === 'true') return true;
    if (isDisabled(btn)) {
        if (required) throw new Error(`Opcao desabilitada no Flow: ${what}`);
        return false;
    }
    fireClick(btn);
    const ok = await waitFor(() => findRadio(pred)?.getAttribute('aria-checked') === 'true', 2000, 100);
    if (!ok) {
        await trustedClick(findRadio(pred));
        const ok2 = await waitFor(() => findRadio(pred)?.getAttribute('aria-checked') === 'true', 2500, 100);
        if (!ok2 && required) throw new Error(`Nao foi possivel selecionar: ${what}`);
    }
    await sleep(250);
    return true;
}

function getModelButton() {
    const panel = getSettingsPanel();
    if (!panel) return null;
    const btns = Array.from(panel.querySelectorAll('button')).filter(isVisible);
    return btns.find(b => /modelo|model/i.test(b.getAttribute('aria-label') || ''))
        || btns.find(b => iconOf(b) === 'arrow_drop_down' || (b.textContent || '').includes('arrow_drop_down'))
        || null;
}

function getModelMenuItems() {
    const root = overlayRoot();
    if (!root) return [];
    const menus = Array.from(root.querySelectorAll('.flow-model-picker-panel, [role="menu"]')).filter(isVisible);
    const menu = menus.find(m => m.classList.contains('flow-model-picker-panel')) || menus[menus.length - 1];
    return menu ? Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).filter(isVisible) : [];
}

// Canonical model names used by the current Flow UI
const IMAGE_MODELS = ['Nano Banana Pro', 'Nano Banana 2', 'Nano Banana 2 Lite'];
const VIDEO_MODELS = ['Omni 1.1 Flash', 'Veo 3.1 - Lite', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality'];

function resolveModelName(wanted, isImage) {
    const w = compact(String(wanted || '').replace(/\[.*?\]/g, ''));
    if (isImage) {
        if (w.includes('pro')) return 'Nano Banana Pro';
        if (w.includes('lite')) return 'Nano Banana 2 Lite';
        if (w.includes('imagen') || w.includes('image4') || w.includes('imagem4')) {
            console.warn('[Flow Automator] Imagen 4 nao existe mais no Flow; usando Nano Banana 2');
        }
        return 'Nano Banana 2';
    }
    if (w.includes('omni') || w.includes('flash')) return 'Omni 1.1 Flash';
    if (w.includes('quality')) return 'Veo 3.1 - Quality';
    if (w.includes('fast')) return 'Veo 3.1 - Fast';
    return 'Veo 3.1 - Lite';
}

function modelMatches(text, target) {
    const t = compact(String(text || '').replace(/arrow_drop_down|volume_up/g, ''));
    const g = compact(target);
    if (!t) return false;
    if (t === g) return true;
    // "Omni 1.1 Flash" could get a new version number: match by family
    if (g.startsWith('omni')) return t.includes('omni');
    // Nano Banana 2 must NOT match "Nano Banana 2 Lite"
    return t.endsWith(g) && !(g === 'nanobanana2' && t.includes('lite'));
}

async function selectModel(targetName) {
    const current = getModelButton();
    if (!current) throw new Error('Seletor de modelo nao encontrado');
    if (modelMatches(labelOf(current), targetName)) return true;

    fireClick(current);
    let items = await waitFor(() => { const i = getModelMenuItems(); return i.length ? i : null; }, 3000);
    if (!items) {
        await trustedClick(getModelButton());
        items = await waitFor(() => { const i = getModelMenuItems(); return i.length ? i : null; }, 3000);
    }
    if (!items) throw new Error('Menu de modelos nao abriu');

    const item = items.find(i => modelMatches(labelOf(i), targetName));
    if (!item) {
        const available = items.map(i => labelOf(i)).join(', ');
        await closeOverlays();
        throw new Error(`Modelo "${targetName}" nao disponivel. Disponiveis: ${available}`);
    }
    if (isDisabled(item)) throw new Error(`Modelo "${targetName}" desabilitado no seu plano`);
    fireClick(item);
    const ok = await waitFor(() => modelMatches(labelOf(getModelButton()), targetName), 3000, 120);
    if (!ok) throw new Error(`Modelo "${targetName}" nao foi confirmado`);
    await sleep(300);
    return true;
}

const RATIO_ICONS = {
    '16:9': 'crop_16_9',
    '4:3': 'crop_landscape',
    '1:1': 'crop_square',
    '3:4': 'crop_portrait',
    '9:16': 'crop_9_16'
};

function normalizeRatio(v) {
    const raw = String(v || '').trim();
    if (raw === 'portrait') return '9:16';
    if (raw === 'landscape') return '16:9';
    return RATIO_ICONS[raw] ? raw : '16:9';
}

// settings: { isImage, useFrames, model, ratio, duration, genResolution }
async function applySettings(s) {
    const steps = [];
    await openSettingsPanel();

    await selectRadio(r => r.icon === (s.isImage ? 'image' : 'videocam'), s.isImage ? 'Imagem' : 'Video');
    steps.push(s.isImage ? 'modo:imagem' : 'modo:video');

    if (!s.isImage) {
        // "Frames" (start/end frame) sub-mode - also works for plain text-to-video
        await selectRadio(r => r.icon === 'crop_free' || r.label === 'frames', 'Frames', false);
    }

    await selectModel(s.model);
    steps.push('modelo:' + s.model);

    const ratio = normalizeRatio(s.ratio);
    const ratioOk = await selectRadio(r => r.icon === RATIO_ICONS[ratio] || r.label === ratio, 'Proporcao ' + ratio, false);
    if (!ratioOk) {
        // Video only supports 16:9 / 9:16 - pick the closest orientation
        const fallback = (ratio === '3:4' || ratio === '9:16') ? '9:16' : '16:9';
        await selectRadio(r => r.icon === RATIO_ICONS[fallback] || r.label === fallback, 'Proporcao ' + fallback);
        steps.push('proporcao:' + fallback + '(fallback)');
    } else {
        steps.push('proporcao:' + ratio);
    }

    if (!s.isImage) {
        if (s.genResolution) {
            const want = norm(s.genResolution);
            const ok = await selectRadio(r => r.label === want || r.label.startsWith(want), 'Resolucao ' + want, false);
            if (ok) steps.push('res:' + want);
        }
        if (s.duration) {
            const want = norm(s.duration);
            const ok = await selectRadio(r => r.label === want, 'Duracao ' + want, false);
            if (ok) steps.push('duracao:' + want);
        }
    }

    await selectRadio(r => r.label === 'x1', 'Quantidade x1', false);
    steps.push('qtd:x1');

    await closeSettingsPanel();
    console.log('[Flow Automator] Settings applied:', steps.join(' | '));
    return steps;
}

// ===== Start-frame image upload (Video > Frames > "Inicio") =====
function promptBoxImages() {
    const box = getPromptBox();
    return box ? Array.from(box.querySelectorAll('img')).filter(isVisible) : [];
}

async function clearPromptBoxImages() {
    for (let i = 0; i < 4; i++) {
        const box = getPromptBox();
        if (!box) return;
        const chip = Array.from(box.querySelectorAll('button')).find(b => iconOf(b) === 'cancel' && b.querySelector('img'))
            || Array.from(box.querySelectorAll('button')).find(b => iconOf(b) === 'cancel');
        if (!chip) return;
        fireClick(chip);
        await sleep(500);
    }
}

function getStartFrameButton() {
    const box = getPromptBox();
    if (!box) return null;
    const btns = Array.from(box.querySelectorAll('button')).filter(isVisible);
    const byLabel = btns.find(b => /^(inicio|start|primeiro frame|first frame)$/.test(norm(labelOf(b))));
    if (byLabel) return byLabel;
    const swapIdx = btns.findIndex(b => iconOf(b) === 'swap_horiz');
    return swapIdx > 0 ? btns[swapIdx - 1] : null;
}

function getMediaDialog() {
    const root = overlayRoot();
    if (!root) return null;
    return Array.from(root.querySelectorAll('.cdk-overlay-pane')).filter(isVisible)
        .find(p => Array.from(p.querySelectorAll('button')).some(b => iconOf(b) === 'upload')) || null;
}

function findAgreeButton() {
    return overlayButtons('button').find(b => /^(concordo|aceito|i agree|agree|accept|ok|entendi|got it)$/.test(norm(b.textContent))) || null;
}

async function uploadStartFrame(image) {
    if (!image?.data) return true;
    await clearPromptBoxImages();

    const slot = getStartFrameButton();
    if (!slot) throw new Error('Slot "Inicio" (frame inicial) nao encontrado - modo Frames nao ativo?');
    fireClick(slot);
    let dialog = await waitFor(getMediaDialog, 3000);
    if (!dialog) {
        await trustedClick(getStartFrameButton());
        dialog = await waitFor(getMediaDialog, 4000);
    }
    if (!dialog) throw new Error('Janela de selecao de imagem nao abriu');

    const optionsBefore = dialog.querySelectorAll('[role="option"]').length;

    // Upload runs in the page (MAIN world) so the file picker can be intercepted
    const res = await chrome.runtime.sendMessage({
        action: 'mainWorldUploadFile',
        dataUrl: image.data,
        fileName: image.name || 'frame.png',
        fileType: image.type || 'image/png'
    });
    if (!res?.success) throw new Error('Falha ao enviar imagem: ' + (res?.error || 'desconhecido'));

    // "Direitos de uso desta imagem" confirmation
    const agree = await waitFor(findAgreeButton, 5000);
    if (agree) {
        fireClick(agree);
        await sleep(500);
    }

    // Wait for the image to land in the start slot. If the dialog stays open,
    // pick the newly uploaded item (first option) ourselves.
    const filled = await waitFor(() => {
        if (promptBoxImages().length > 0 && !getMediaDialog()) return true;
        const d = getMediaDialog();
        if (d) {
            const opts = Array.from(d.querySelectorAll('[role="option"]')).filter(isVisible);
            const busy = d.querySelector('mat-progress-bar, mat-spinner, mat-progress-spinner, [role="progressbar"]');
            if (!busy && opts.length > optionsBefore) {
                fireClick(opts[0]);
            }
        }
        return false;
    }, 60000, 800);
    if (!filled) {
        await closeOverlays();
        throw new Error('Imagem enviada mas nao apareceu no frame inicial');
    }
    await sleep(500);
    return true;
}

// ===== Result tiles =====
const MEDIA_ID_RE = /flow-content\.google\/(?:image|video)\/([0-9a-f-]{16,})/i;

function tileMediaIds(tile) {
    const ids = new Set();
    tile.querySelectorAll('[data-media-id]').forEach(e => ids.add(e.getAttribute('data-media-id')));
    tile.querySelectorAll('img[src], video[src], source[src], video[poster]').forEach(e => {
        const m = String(e.getAttribute('src') || e.getAttribute('poster') || '').match(MEDIA_ID_RE);
        if (m) ids.add(m[1]);
    });
    return Array.from(ids);
}

function getTiles() {
    return Array.from(document.querySelectorAll('flow-grid-tile-container'));
}

function allKnownMediaIds() {
    const s = new Set();
    getTiles().forEach(t => tileMediaIds(t).forEach(id => s.add(id)));
    return s;
}

function findTileByMediaId(id) {
    return getTiles().find(t => tileMediaIds(t).includes(id)) || null;
}

function tileText(tile) {
    return norm(tile?.innerText || '');
}

function isTileComplete(tile, mode) {
    if (!tile) return false;
    const txt = tileText(tile);
    if (/\b\d{1,3}\s?%/.test(txt)) return false;
    if (mode === 'image') {
        const img = tile.querySelector('flow-image-tile img, img');
        return !!(img && MEDIA_ID_RE.test(img.getAttribute('src') || '') && img.complete !== false);
    }
    return !!tile.querySelector('flow-video-tile') && (tileMediaIds(tile).length > 0);
}

function tileFailureText(tile) {
    if (!tile) return '';
    const icons = Array.from(tile.querySelectorAll('mat-icon, .google-symbols')).map(i => i.textContent.trim());
    const txt = tileText(tile);
    const hasErrIcon = icons.some(i => ['error', 'warning', 'report', 'error_outline', 'block'].includes(i));
    if (hasErrIcon || (FAILURE_RE.test(txt) && !tileMediaIds(tile).length)) {
        return (tile.innerText || '').replace(/\s+/g, ' ').trim() || 'falha na geracao';
    }
    return '';
}

// Scroll the grid back to the top so the newest tile is rendered (virtual scroll)
function scrollGridTop() {
    const sc = document.querySelector('.virtual-scroll-container');
    let el = sc;
    for (let i = 0; i < 6 && el; i++) {
        if (el.scrollHeight > el.clientHeight + 10) { el.scrollTop = 0; break; }
        el = el.parentElement;
    }
}

async function submitGeneration(beforeIds, beforeCount) {
    const started = () => {
        if (!editorText()) return true;                        // Flow clears the box on submit
        const tiles = getTiles();
        if (tiles.length > beforeCount) return true;
        const top = tiles[0];
        return !!(top && !tileMediaIds(top).some(id => beforeIds.has(id)) && /\d+\s?%/.test(tileText(top)));
    };

    const btn = await waitFor(() => { const b = getGenerateButton(); return b && !isDisabled(b) ? b : null; }, 6000);
    if (!btn) throw new Error('Botao de gerar desabilitado (prompt nao aceito?)');

    // Trusted (CDP) click first - synthetic clicks are ignored by Flow's submit
    const clicked = await trustedClick(btn);
    if (clicked && await waitFor(started, 6000, 200)) return 'trusted-click';
    if (!clicked) console.warn('[Flow Automator] Trusted click failed, trying fallbacks');

    fireClick(getGenerateButton());
    if (await waitFor(started, 3000, 200)) return 'synthetic-click';

    try { await chrome.runtime.sendMessage({ action: 'mainWorldPressEnter' }); } catch (_) { }
    if (await waitFor(started, 5000, 200)) return 'enter';

    // An immediate error toast explains why nothing started
    const err = readToastTexts().find(t => t.icon === 'error' || FAILURE_RE.test(norm(t.text)));
    throw new Error(err ? 'Flow: ' + err.text : 'A geracao nao iniciou');
}

async function waitForResult(beforeIds, mode, timeoutMs) {
    const end = Date.now() + timeoutMs;
    const toastsBefore = new Set(readToastTexts().map(t => t.text));
    let lastLog = 0;
    while (Date.now() < end) {
        if (Date.now() - lastLog > 10000) { scrollGridTop(); lastLog = Date.now(); }
        const tiles = getTiles();
        // Newest tiles are rendered first
        for (const tile of tiles.slice(0, 6)) {
            const ids = tileMediaIds(tile);
            const isNew = ids.length ? !ids.some(id => beforeIds.has(id)) : false;
            if (isNew && isTileComplete(tile, mode)) {
                return { tile, mediaId: ids[0] };
            }
        }
        const top = tiles[0];
        if (top && !tileMediaIds(top).some(id => beforeIds.has(id))) {
            const fail = tileFailureText(top);
            if (fail) throw new Error('Flow: ' + fail.slice(0, 160));
            const pct = (top.innerText || '').match(/(\d{1,3})\s?%/);
            if (pct) updateOverlay(`Gerando... ${pct[1]}%`);
        }
        const newErr = readToastTexts().find(t => !toastsBefore.has(t.text) && (t.icon === 'error' || FAILURE_RE.test(norm(t.text))));
        if (newErr) throw new Error('Flow: ' + newErr.text.slice(0, 160));
        await sleep(1500);
    }
    throw new Error('Timeout na geracao');
}

// ===== Download (context menu > download > resolution) =====
async function openTileMenu(mediaId) {
    await closeOverlays();
    scrollGridTop();
    const tile = await waitFor(() => findTileByMediaId(mediaId), 5000);
    if (!tile) throw new Error('Card gerado nao encontrado para download');
    tile.scrollIntoView({ block: 'center' });
    await sleep(300);

    const findDownloadItem = () => overlayButtons('[role="menuitem"]').find(i => iconOf(i) === 'download') || null;

    // 1) right-click (context menu)
    const r = tile.getBoundingClientRect();
    tile.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, view: window, button: 2,
        clientX: r.left + Math.min(60, r.width / 2), clientY: r.top + Math.min(60, r.height / 2)
    }));
    let item = await waitFor(findDownloadItem, 2500);

    // 2) "more_vert" button on the tile hotbar
    if (!item) {
        tile.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        tile.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        await sleep(300);
        const more = Array.from(tile.querySelectorAll('button')).find(b => iconOf(b) === 'more_vert');
        if (more) {
            fireClick(more);
            item = await waitFor(findDownloadItem, 2500);
        }
    }
    if (!item) throw new Error('Menu de download nao abriu');
    return item;
}

function pickDownloadOption(items, mode, wanted) {
    const enabled = items.filter(i => !isDisabled(i));
    const lab = (i) => norm(labelOf(i));
    if (mode === 'image') {
        const order = ['4k', '2k', '1k'];
        const w = String(wanted || '2k').toLowerCase();
        const start = Math.max(0, order.indexOf(w));
        for (const res of order.slice(start)) {
            const it = enabled.find(i => lab(i).startsWith(res));
            if (it) return it;
        }
        return enabled[0] || null;
    }
    // video: "270p GIF", "<res> Tamanho original", "<res> Aprimorada"...
    const gif = enabled.find(i => lab(i).includes('gif'));
    const nonGif = enabled.filter(i => !lab(i).includes('gif'));
    const original = nonGif.find(i => /original/.test(lab(i))) || nonGif[0] || null;
    const upscaled = nonGif.filter(i => i !== original);
    if (wanted === 'gif') return gif || original;
    if (wanted === 'upscale') return upscaled[upscaled.length - 1] || original;
    return original || gif;
}

async function downloadResult(result, mode, config) {
    const wanted = mode === 'image'
        ? String(config.imageResolution || '2k').toLowerCase()
        : normalizeVideoDownload(config.videoResolution);

    const dlItem = await openTileMenu(result.mediaId);
    fireClick(dlItem);
    const sub = await waitFor(() => {
        const items = overlayButtons('[role="menuitem"]').filter(i => /\d+\s?(k|p)\b/i.test(labelOf(i)));
        return items.length ? items : null;
    }, 3000);
    if (!sub) throw new Error('Opcoes de resolucao do download nao apareceram');

    const choice = pickDownloadOption(sub, mode, wanted);
    if (!choice) throw new Error('Nenhuma opcao de download disponivel');
    console.log('[Flow Automator] Download option:', labelOf(choice));

    // Tell background which name to give to the next Flow download
    try {
        await chrome.runtime.sendMessage({
            action: 'registerDownload',
            url: `https://flow-content.google/${mode === 'image' ? 'image' : 'video'}/${result.mediaId}`,
            type: mode === 'image' ? 'image' : 'video'
        });
    } catch (_) { }

    const before = lastFlowDownloadDetectedAt;
    fireClick(choice);
    updateOverlay(/aprimor|upscal|enhanc|2k|4k/i.test(labelOf(choice)) ? 'Aprimorando e baixando...' : 'Baixando...');

    const ok = await waitFor(() => lastFlowDownloadDetectedAt > before, 180000, 500);
    await sleep(800);
    dismissToasts();
    if (!ok) throw new Error('Download nao foi detectado');
    return true;
}

function normalizeVideoDownload(value) {
    const t = String(value || '').toLowerCase();
    if (t === 'gif' || t.includes('270')) return 'gif';
    if (t === 'upscale' || t.includes('1080') || t.includes('4k')) return 'upscale';
    return 'original';
}

// ===== Main flow =====
function pickAspectRatio(config) {
    let ratio = config.aspectRatio || '16:9';
    if (config.randomizeAspectRatio) {
        const opts = [];
        if (config.randomIncludeLandscape) opts.push('16:9');
        if (config.randomIncludePortrait) opts.push('9:16');
        if (config.mode === 'image') {
            if (config.randomIncludeLandscape43) opts.push('4:3');
            if (config.randomIncludeSquare) opts.push('1:1');
            if (config.randomIncludePortrait34) opts.push('3:4');
        }
        if (opts.length) ratio = opts[Math.floor(Math.random() * opts.length)];
    }
    return ratio;
}

async function runOnce(prompt, config, image) {
    const mode = config.mode === 'image' ? 'image' : 'video';
    const isImage = mode === 'image';

    await closeOverlays();
    const ready = await waitFor(() => getEditor() && getSettingsTrigger(), 20000, 500);
    if (!ready) throw new Error('Caixa de prompt do Flow nao encontrada (abra um projeto)');

    // 1. Settings
    updateOverlay('Configurando modo/modelo/proporcao...');
    const settings = {
        isImage,
        model: resolveModelName(isImage ? config.imageModel : config.videoModel, isImage),
        ratio: image?.aspectRatio && !isImage ? image.aspectRatio : pickAspectRatio(config),
        duration: config.videoDuration,
        genResolution: config.videoGenResolution
    };
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try { await applySettings(settings); lastErr = null; break; } catch (e) {
            lastErr = e;
            console.warn('[Flow Automator] applySettings failed:', e.message);
            await closeOverlays();
            await sleep(800);
        }
    }
    if (lastErr) throw lastErr;

    // 2. Start frame (video only)
    if (!isImage && image?.data) {
        updateOverlay('Enviando imagem (frame inicial)...');
        await uploadStartFrame(image);
    } else if (!isImage) {
        await clearPromptBoxImages();
    }

    // 3. Prompt
    updateOverlay('Inserindo prompt...');
    if (!await fillPrompt(prompt)) throw new Error('Falha ao inserir prompt');
    await sleep(500);

    // 4. Generate
    updateOverlay('Iniciando geracao...');
    scrollGridTop();
    const beforeIds = allKnownMediaIds();
    const beforeCount = getTiles().length;
    const how = await submitGeneration(beforeIds, beforeCount);
    console.log('[Flow Automator] Generation started via', how);

    // 5. Wait
    updateOverlay('Aguardando geracao...');
    const timeoutMs = Math.max(60, parseInt(config.generationTimeout) || 180) * 1000;
    const result = await waitForResult(beforeIds, mode, timeoutMs);
    console.log('[Flow Automator] New media:', result.mediaId);

    // 6. Download
    if (config.autoDownload !== false) {
        updateOverlay('Fazendo download...');
        let dlErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try { await downloadResult(result, mode, config); dlErr = null; break; } catch (e) {
                dlErr = e;
                console.warn('[Flow Automator] Download attempt failed:', e.message);
                await closeOverlays();
                await sleep(1500);
            }
        }
        if (dlErr) throw dlErr;
    }
    return result;
}

async function processPrompt(prompt, index, config, image = null) {
    const fallbackPrompt = 'Animate this image with natural cinematic motion, preserving subject identity and scene details.';
    const effectivePrompt = String(prompt || '').trim() || fallbackPrompt;

    if (isProcessing) {
        console.warn('[Flow Automator] Already processing a prompt, ignoring new request');
        return;
    }
    isProcessing = true;
    currentPromptText = effectivePrompt;

    const maxAttempts = Math.max(1, Math.min(5, parseInt(config.maxRetries) || 2));
    try {
        showOverlay('Processando...', effectivePrompt);
        setStatusProgress(index + 1, config.totalPrompts || 1);

        let lastError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                if (attempt > 1) updateOverlay(`Tentativa ${attempt}/${maxAttempts}...`);
                await runOnce(effectivePrompt, config, image);
                lastError = null;
                break;
            } catch (e) {
                lastError = e;
                console.error(`[Flow Automator] Attempt ${attempt}/${maxAttempts} failed:`, e.message);
                updateOverlay('Erro: ' + e.message);
                await closeOverlays();
                // Policy / credit errors will not fix themselves on retry
                if (/polic|violat|credit|credito|quota|cota|desabilitado|nao disponivel/i.test(e.message)) break;
                await sleep(3000);
            }
        }
        if (lastError) throw lastError;

        console.log('[Flow Automator] Prompt completed successfully');
        sendComplete(true, null, effectivePrompt);
    } catch (e) {
        console.error('[Flow Automator] Error processing prompt:', e);
        updateOverlay('Erro: ' + e.message);
        await sleep(2500);
        sendComplete(false, null, effectivePrompt, e.message);
    } finally {
        isProcessing = false;
    }
}

// Expose for manual debugging from the console of the extension's isolated world
window.__flowAutomator = { applySettings, fillPrompt, uploadStartFrame, getTiles, allKnownMediaIds, downloadResult, runOnce };

// ===== Floating Status UI =====
function showOverlay(title, subtitle) { showStatus(title, subtitle); }
function updateOverlay(title) { updateStatus(title); }

let statusElement = null;
let statusStartTime = null;
let statusTimerInterval = null;
let statusTotalPrompts = 1;
let statusCurrentPrompt = 1;



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
    try {
        chrome.runtime.sendMessage({
            type: 'promptComplete',
            success: success,
            mediaUrl: mediaUrl,
            prompt: prompt,
            error: error || null
        }, () => {
            if (chrome.runtime.lastError) {
                console.warn('[Flow Automator] sendComplete ignored:', chrome.runtime.lastError.message);
            }
        });
    } catch (e) {
        console.warn('[Flow Automator] sendComplete failed:', e?.message || e);
    }
}

console.log('[Flow Automator] Ready on:', window.location.href);

