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
    pauseEndTime: null,
    processedSinceLastPause: 0
};

// Map URL -> filename for renaming downloads
const pendingDownloads = new Map();

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

// Register a URL -> filename mapping before download starts
function registerPendingDownload(url, type) {
    if (!automationState.isProcessing) return;

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

    console.log('[BG] Registering download:', url.substring(0, 80) + '...', '->', filename);
    pendingDownloads.set(url, filename);

    // Store for txt file
    automationState.lastDownloadBasename = basename;
    automationState.lastDownloadSubfolder = cfg.subfolder || '';
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
        pauseEndTime: null,
        processedSinceLastPause: 0
    };
    await chrome.storage.local.set({
        isProcessing: true,
        currentIndex: 0,
        totalPrompts: config.prompts.length,
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
    if (!automationState.isProcessing || automationState.currentIndex >= automationState.prompts.length) {
        if (automationState.isProcessing) stopAutomation();
        return;
    }
    const prompt = automationState.prompts[automationState.currentIndex];
    const config = automationState.config;

    // Store current prompt info for download renaming
    await chrome.storage.local.set({
        currentIndex: automationState.currentIndex,
        currentPrompt: prompt
    });

    broadcastMessage({ type: 'progress', current: automationState.currentIndex, total: automationState.prompts.length, status: 'Gerando...' });

    try {
        await chrome.tabs.sendMessage(config.tabId, {
            type: 'processPrompt',
            prompt,
            index: automationState.currentIndex,
            config: {
                mode: config.mode,
                doUpscale: config.doUpscale,
                aspectRatio: config.aspectRatio,
                imageResolution: config.imageResolution,
                generationTimeout: config.generationTimeout,
                totalPrompts: automationState.prompts.length,
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
            index: automationState.currentIndex,
            config: {
                mode: config.mode,
                doUpscale: config.doUpscale,
                aspectRatio: config.aspectRatio,
                imageResolution: config.imageResolution,
                generationTimeout: config.generationTimeout,
                totalPrompts: automationState.prompts.length,
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
        await sleep(2000);

        // Save prompt as txt file if enabled
        if (automationState.config.savePromptTxt) {
            await savePromptTxt(msg.prompt);
        }
    } else {
        automationState.failCount++;
    }

    // Wait delay before next prompt
    const delayMs = (automationState.config.delaySeconds || 5) * 1000;
    console.log('[BG] Waiting', delayMs, 'ms before next prompt...');

    broadcastMessage({ type: 'progress', current: automationState.currentIndex, total: automationState.prompts.length, status: 'Aguardando...' });

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
    if (!cfg.scheduledPauseEnabled) return false;

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
    console.log('[BG] onDeterminingFilename:', downloadItem.filename);
    console.log('[BG] URL:', downloadItem.url?.substring(0, 80));

    // Check if we have a pending filename for this EXACT URL
    if (pendingDownloads.has(downloadItem.url)) {
        const desiredFilename = pendingDownloads.get(downloadItem.url);
        pendingDownloads.delete(downloadItem.url);

        console.log('[BG] Found pending! Renaming to:', desiredFilename);
        suggest({ filename: desiredFilename, conflictAction: 'uniquify' });
        return true;
    }

    // Check if this is a txt file from data URL
    if (downloadItem.url && downloadItem.url.startsWith('data:text/plain') && automationState.pendingTxtFilename) {
        const txtFilename = automationState.pendingTxtFilename;
        automationState.pendingTxtFilename = '';

        console.log('[BG] Renaming txt to:', txtFilename);
        suggest({ filename: txtFilename, conflictAction: 'uniquify' });
        return true;
    }

    // Check if we're processing automation and this is a video/image file
    if (automationState.isProcessing) {
        const filename = downloadItem.filename || '';
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const isVideoOrImage = ['mp4', 'webm', 'png', 'jpg', 'jpeg', 'webp'].includes(ext);
        const isFromGoogleLabs = downloadItem.url?.includes('blob:https://labs.google') ||
            downloadItem.url?.includes('storage.googleapis.com') ||
            downloadItem.url?.startsWith('data:image/'); // 1K images come as data URLs

        console.log('[BG] isProcessing:', true, 'ext:', ext, 'isVideoOrImage:', isVideoOrImage, 'isFromGoogleLabs:', isFromGoogleLabs);

        if (isVideoOrImage && isFromGoogleLabs) {
            const cfg = automationState.config;
            const idx = automationState.currentIndex;
            const prompt = automationState.prompts[idx] || '';
            const name = sanitizeFilename(prompt.substring(0, 50));
            const basename = String(idx + 1).padStart(3, '0') + '_' + name;

            let newFilename = basename + '.' + ext;
            if (cfg.subfolder) {
                newFilename = cfg.subfolder + '/' + newFilename;
            }

            automationState.lastDownloadBasename = basename;
            automationState.lastDownloadSubfolder = cfg.subfolder || '';

            console.log('[BG] Renaming video/image to:', newFilename);
            suggest({ filename: newFilename, conflictAction: 'uniquify' });
            return true;
        }
    }

    console.log('[BG] Download not matched - not renaming');
});

console.log('[BG] Background script loaded');
