// ===== Flow Automator Content Script =====
console.log('[Flow Automator] Content script loaded');

// ===== Selectors for Google Flow =====
const SELECTORS = {
    promptInput: '#PINHOLE_TEXT_AREA_ELEMENT_ID',
    modeCombobox: 'button[role="combobox"]',
    modeOption: 'div[role="option"]',
    settingsBtn: 'button[aria-haspopup="dialog"]',
    // Prompt text inside video cards
    videoPromptText: '.sc-e6a99d5c-3, .sc-20145656-8',
    // Video card container
    videoCard: '.sc-20145656-0, [class*="ekxBaW"]',
    // Image card container
    imageCard: '.sc-6349d8ef-0, [class*="kPrIhK"]',
    // Image prompt text
    imagePromptText: '.sc-6349d8ef-10, [class*="eScTfS"]'
};

// Mode text mappings (EN/PT)
const MODE_TEXTS = {
    video: ['Text to Video', 'Texto para vídeo', 'Text to video'],
    image: ['Create Image', 'Criar imagens', 'Create image', 'Criar Imagens']
};

// Aspect Ratio text mappings
const ASPECT_RATIO_TEXTS = {
    '16:9': ['Landscape (16:9)', 'Paisagem (16:9)', '16:9'],
    '9:16': ['Portrait (9:16)', 'Retrato (9:16)', '9:16']
};

// Dropdown label texts (EN/PT)
const DROPDOWN_LABELS = {
    aspectRatio: ['Aspect Ratio', 'Proporção'],
    outputsPerPrompt: ['Outputs per prompt', 'Respostas por comando']
};

// Download menu options for VIDEO (EN/PT)
const VIDEO_DOWNLOAD_OPTIONS = {
    original: ['Original size (720p)', 'Tamanho original (720p)', '720p'],
    upscaled: ['Upscaled (1080p)', 'Resolução ampliada (1080p)', '1080p']
};

// Download menu options for IMAGE (EN/PT)
const IMAGE_DOWNLOAD_OPTIONS = {
    '1k': ['Download 1K', 'Baixar 1K', '1K'],
    '2k': ['Download 2K', 'Baixar 2K', '2K'],
    '4k': ['Download 4K', 'Baixar 4K', '4K']
};

// ===== State =====
let isProcessing = false;
let currentPromptText = '';

// ===== Message Handler =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Flow Automator] Received message:', message.type);
    if (message.type === 'processPrompt') {
        processPrompt(message.prompt, message.index, message.config);
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
    }
    return true;
});

// ===== Main Processing Function =====
async function processPrompt(prompt, index, config) {
    console.log('[Flow Automator] Processing prompt ' + (index + 1) + ': ' + prompt.substring(0, 50) + '...');
    isProcessing = true;
    currentPromptText = prompt.trim();

    try {
        showOverlay('Processando...', prompt);
        setStatusProgress(index + 1, config.totalPrompts || 1);
        await waitForPageReady();

        // Count existing cards with this prompt BEFORE generating
        const existingCardCount = countCardsWithPromptByMode(currentPromptText, config.mode);
        console.log('[Flow Automator] Existing cards with this prompt:', existingCardCount);

        // Select the correct mode (video or image) - only on first prompt
        if (index === 0) {
            updateOverlay('Selecionando modo...');
            await selectMode(config.mode);
            await sleep(500);
        }

        // Randomize aspect ratio if enabled
        let aspectRatio = config.aspectRatio;
        if (config.randomizeAspectRatio) {
            const options = [];
            if (config.randomIncludePortrait) options.push('9:16');
            if (config.randomIncludeLandscape) options.push('16:9');

            if (options.length > 0) {
                aspectRatio = options[Math.floor(Math.random() * options.length)];
                console.log('[Flow Automator] Randomized aspect ratio:', aspectRatio);
            }
        }

        // Configure settings for each prompt (aspect ratio, outputs=1)
        updateOverlay('Configurando settings...');
        await configureSettings(aspectRatio);
        await sleep(300);

        updateOverlay('Inserindo prompt...');
        const inputSuccess = await fillPromptInput(prompt);
        if (!inputSuccess) throw new Error('Não foi possível encontrar o campo de prompt');

        updateOverlay('Iniciando geração...');
        await sleep(500);
        const generateSuccess = await clickGenerateButton();
        if (!generateSuccess) throw new Error('Não foi possível clicar no botão de gerar');

        // Wait for NEW card to appear
        updateOverlay('Aguardando geração...');
        const cardResult = await waitForNewCard(existingCardCount, config.generationTimeout * 1000, config.mode);

        if (!cardResult) {
            throw new Error('Timeout na geração');
        }

        console.log('[Flow Automator] Found new', config.mode, 'card');

        // Now download from THIS specific card
        updateOverlay('Fazendo download...');
        await sleep(1000);

        let downloadSuccess = false;

        if (config.mode === 'image') {
            // For images, use image resolution (1k, 2k, 4k)
            // Pass wrapper as fallback to find download button
            downloadSuccess = await downloadFromImageCard(cardResult.wrapper || cardResult.card, config.imageResolution || '2k');
        } else {
            // For videos: both 9:16 and 16:9 have menu
            // 9:16 has: GIF (270p), Original (720p)
            // 16:9 has: GIF, Original (720p), Upscaled (1080p)
            // Use the randomized aspectRatio value, not config.aspectRatio
            const canUpscale = aspectRatio !== '9:16';
            const shouldUpscale = canUpscale && config.doUpscale;

            downloadSuccess = await downloadFromVideoCard(cardResult.wrapper || cardResult.card, shouldUpscale);
        }

        if (!downloadSuccess) {
            throw new Error('Falha no download');
        }

        // Wait a bit for download to actually start
        console.log('[Flow Automator] Waiting for download to start...');
        await sleep(1000);

        // For images 2K/4K, wait for upscale to complete (Google Flow shows a modal)
        if (config.mode === 'image' && (config.imageResolution === '2k' || config.imageResolution === '4k')) {
            updateOverlay('Aguardando upscale (' + config.imageResolution.toUpperCase() + ')...');
            const upscaleComplete = await waitForUpscaleComplete(300000); // 5 minutes timeout

            if (upscaleComplete) {
                console.log('[Flow Automator] Image upscale complete!');
                await clickDismissButton();
                await sleep(3000); // Wait longer for upscaled image download to start
            } else {
                console.log('[Flow Automator] Image upscale timeout');
            }
        } else if (config.mode === 'image' && config.imageResolution === '1k') {
            // 1K doesn't have upscale modal, but needs extra time for download to start
            console.log('[Flow Automator] Waiting for 1K download to register...');
            await sleep(2000);
        }

        // If upscale is enabled for VIDEO 16:9, wait for upscale to complete
        // Use the randomized aspectRatio value, not config.aspectRatio
        if (config.mode === 'video' && config.doUpscale && aspectRatio !== '9:16') {
            updateOverlay('Aguardando upscale (1080p)...');
            const upscaleComplete = await waitForUpscaleComplete(300000); // 5 minutes timeout

            if (upscaleComplete) {
                console.log('[Flow Automator] Upscale complete!');
                await clickDismissButton();
                // Wait additional time after upscale download
                await sleep(2000);
            } else {
                console.log('[Flow Automator] Upscale timeout');
            }
        }

        console.log('[Flow Automator] Prompt completed successfully');
        sendComplete(true, null, prompt);
        // Don't hide overlay - it will be updated by next prompt or show completion

    } catch (error) {
        console.error('[Flow Automator] Error:', error);
        sendComplete(false, null, prompt, error.message);
        // Don't hide overlay on error either
    }

    isProcessing = false;
}

// ===== Count READY cards (with video/image loaded) for a specific prompt =====
function countCardsWithPromptByMode(promptText, mode) {
    const promptLower = promptText.toLowerCase().trim();
    let count = 0;

    if (mode === 'image') {
        // Find all image cards with prompt and READY image
        const imageCards = document.querySelectorAll('.sc-6349d8ef-0, [class*="kPrIhK"]');

        for (const card of imageCards) {
            // Check if has ready image
            const img = card.querySelector('img');
            const imgSrc = img ? img.getAttribute('src') : '';
            if (!img || !imgSrc || !imgSrc.includes('storage.googleapis.com')) {
                continue; // Skip cards without ready image
            }

            const promptElements = card.querySelectorAll('.sc-6349d8ef-10, [class*="eScTfS"], button');
            for (const el of promptElements) {
                if (el.textContent.trim().toLowerCase() === promptLower) {
                    count++;
                    break;
                }
            }
        }
    } else {
        // Find all video cards with prompt and READY video
        const videoCards = document.querySelectorAll('.sc-20145656-0, [class*="ekxBaW"]');

        for (const card of videoCards) {
            // Check if has ready video
            const video = card.querySelector('video');
            const videoSrc = video ? video.getAttribute('src') : '';
            if (!video || !videoSrc || !videoSrc.includes('storage.googleapis.com')) {
                continue; // Skip cards without ready video (loading)
            }

            const promptElements = card.querySelectorAll('.sc-e6a99d5c-3, .sc-20145656-8, [class*="eVxyTT"], [class*="ihIesb"]');
            for (const el of promptElements) {
                if (el.textContent.trim().toLowerCase() === promptLower) {
                    count++;
                    break;
                }
            }
        }
    }

    console.log('[Flow Automator] Counted', count, 'READY', mode, 'cards with prompt:', promptText.substring(0, 50) + '...');
    return count;
}

// ===== Find all cards (video or image) that contain a specific prompt =====
function findCardsWithPrompt(promptText, mode) {
    const promptLower = promptText.toLowerCase().trim();
    const matchingCards = [];

    if (mode === 'image') {
        // Use [data-index] as stable anchor for images too
        const wrappers = document.querySelectorAll('[data-index][data-item-index]');
        console.log('[Flow Automator] Found', wrappers.length, 'data-index wrappers (image mode)');

        for (const wrapper of wrappers) {
            // Skip items without images
            const img = wrapper.querySelector('img[src*="storage.googleapis.com"]');
            if (!img) continue;

            // Find prompt text anywhere in this wrapper
            let promptText = '';

            // Method 1: Look for known prompt classes
            const promptEl = wrapper.querySelector('.sc-6349d8ef-10, [class*="eScTfS"], .sc-e6a99d5c-3, [class*="eVxyTT"]');
            if (promptEl) {
                promptText = promptEl.textContent.trim().toLowerCase();
            }

            // Method 2: If not found, look for any button/div with long text
            if (!promptText) {
                const allTexts = wrapper.querySelectorAll('button, div');
                for (const el of allTexts) {
                    const t = el.textContent.trim();
                    if (t.length > 50 && t.length < 500) {
                        promptText = t.toLowerCase();
                        break;
                    }
                }
            }

            // Check if this prompt matches
            if (promptText === promptLower || promptText.includes(promptLower.substring(0, 40))) {
                const dataIndex = parseInt(wrapper.getAttribute('data-index')) || 999;

                // Find the card container
                const card = wrapper.querySelector('[class*="kPrIhK"], [class*="sc-6349d8ef-0"]') || wrapper;

                const imgSrc = img.getAttribute('src') || '';
                const isReady = imgSrc.includes('storage.googleapis.com');

                console.log('[Flow Automator] Image match! dataIndex:', dataIndex, 'isReady:', isReady);
                matchingCards.push({ card, type: 'image', dataIndex, isReady, wrapper });
            }
        }
    } else {
        // Use [data-index] as stable anchor - contains both video and prompt
        const wrappers = document.querySelectorAll('[data-index][data-item-index]');
        console.log('[Flow Automator] Found', wrappers.length, 'data-index wrappers');

        for (const wrapper of wrappers) {
            // Skip date headers (they have data-index but no video)
            const video = wrapper.querySelector('video');
            if (!video) continue;

            // Find prompt text anywhere in this wrapper
            // Try multiple selectors to be resilient to class changes
            let promptText = '';

            // Method 1: Look for known prompt classes
            const promptEl = wrapper.querySelector('.sc-e6a99d5c-3, .sc-20145656-8, [class*="eVxyTT"], [class*="ihIesb"]');
            if (promptEl) {
                promptText = promptEl.textContent.trim().toLowerCase();
            }

            // Method 2: If not found, look for any button/div with long text
            if (!promptText) {
                const allTexts = wrapper.querySelectorAll('button, div');
                for (const el of allTexts) {
                    const t = el.textContent.trim();
                    if (t.length > 50 && t.length < 500) { // Prompt-like length
                        promptText = t.toLowerCase();
                        break;
                    }
                }
            }

            // Check if this prompt matches
            if (promptText === promptLower || promptText.includes(promptLower.substring(0, 40))) {
                const dataIndex = parseInt(wrapper.getAttribute('data-index')) || 999;

                // Find the card container (for download button)
                const card = wrapper.querySelector('[class*="ekxBaW"], [class*="sc-20145656-0"]') || wrapper;

                // Check if video is ready
                const videoSrc = video.getAttribute('src') || '';
                const isReady = videoSrc.includes('storage.googleapis.com');

                console.log('[Flow Automator] Match! dataIndex:', dataIndex, 'isReady:', isReady);
                matchingCards.push({ card, type: 'video', dataIndex, isReady, wrapper });
                continue; // Continue to find more cards
            }
        }
    }

    // Sort by dataIndex - LOWEST index = MOST RECENT card (new cards appear at top)
    matchingCards.sort((a, b) => a.dataIndex - b.dataIndex);

    // Count ready cards
    const readyCount = matchingCards.filter(c => c.isReady).length;

    console.log('[Flow Automator] Found', matchingCards.length, mode, 'cards with prompt,', readyCount, 'ready');
    if (matchingCards.length > 0) {
        console.log('[Flow Automator] Most recent: data-index', matchingCards[0].dataIndex, 'isReady:', matchingCards[0].isReady);
    }
    return matchingCards;
}

// ===== Wait for a NEW card to appear (by count, not prompt matching) =====
async function waitForNewCard(existingCount, timeout, mode) {
    const startTime = Date.now();
    let lastCardCount = existingCount;

    console.log('[Flow Automator] Waiting for new', mode, 'card');
    console.log('[Flow Automator] Existing cards:', existingCount);

    // Wait a bit after clicking generate before checking
    await sleep(1500);

    while (Date.now() - startTime < timeout) {
        // Check for progress indicators (percentage like "15%", "50%", etc.)
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

        // Find cards with the same prompt
        const currentCards = findCardsWithPrompt(currentPromptText, mode);
        const currentCardCount = currentCards.length;
        const readyCards = currentCards.filter(c => c.isReady);
        const readyCount = readyCards.length;

        console.log('[Flow Automator] Total cards:', currentCardCount, 'Ready:', readyCount, 'Existing:', existingCount, 'Generating:', isGenerating);

        // Check if we have MORE READY cards than before
        if (readyCount > existingCount && readyCards.length > 0) {
            // Get the most recent READY card (sorted by data-index ascending, so first is most recent)
            const newestCardResult = readyCards[0];

            console.log('[Flow Automator] New card is ready! data-index:', newestCardResult.dataIndex);
            await sleep(500);
            return newestCardResult;
        }

        await sleep(1000);
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (!isGenerating) {
            updateStatus('Aguardando... (' + elapsed + 's)');
        }
    }

    return null; // Timeout
}

// ===== Download video from a specific card =====
async function downloadFromVideoCard(card, doUpscale) {
    console.log('[Flow Automator] Starting VIDEO download, Upscale:', doUpscale);

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

    // Find download button within THIS card
    const buttons = card.querySelectorAll('button');
    let downloadBtn = null;

    // Look for button with download icon
    for (const btn of buttons) {
        const icon = btn.querySelector('i');
        if (icon && icon.textContent && icon.textContent.includes('download')) {
            downloadBtn = btn;
            break;
        }
    }

    if (!downloadBtn) {
        console.log('[Flow Automator] No download button found in video card');
        return false;
    }

    console.log('[Flow Automator] Clicking download button');
    downloadBtn.click();
    await sleep(1000); // Wait for menu to open

    // Find menu items
    let menuItems = document.querySelectorAll('[role="menuitem"]');
    console.log('[Flow Automator] Found', menuItems.length, 'menu items');

    // Retry if no menu items
    if (menuItems.length === 0) {
        await sleep(500);
        menuItems = document.querySelectorAll('[role="menuitem"]');
        console.log('[Flow Automator] Retry: Found', menuItems.length, 'menu items');
    }

    if (menuItems.length === 0) {
        console.log('[Flow Automator] No menu items - download may have started directly');
        return true;
    }

    // Simple logic: upscale = 1080p, no upscale = 720p
    const searchText = doUpscale ? '1080' : '720';
    console.log('[Flow Automator] Looking for:', searchText);

    for (const item of menuItems) {
        const itemText = item.textContent;
        console.log('[Flow Automator] Menu item:', itemText);

        if (itemText.includes(searchText)) {
            console.log('[Flow Automator] Clicking:', itemText);
            item.click();
            await sleep(500);
            return true;
        }
    }

    // Fallback: if looking for 1080 but not found (9:16 video), click 720
    if (doUpscale) {
        console.log('[Flow Automator] 1080p not available, trying 720p');
        for (const item of menuItems) {
            if (item.textContent.includes('720')) {
                console.log('[Flow Automator] Clicking 720p fallback');
                item.click();
                await sleep(500);
                return true;
            }
        }
    }

    // Last fallback: click second item (usually the video option, not GIF)
    if (menuItems.length >= 2) {
        console.log('[Flow Automator] Clicking second menu item as fallback');
        menuItems[1].click();
        await sleep(500);
        return true;
    }

    // Final fallback
    if (menuItems.length >= 1) {
        console.log('[Flow Automator] Clicking first menu item as final fallback');
        menuItems[0].click();
        await sleep(500);
        return true;
    }

    return false;
}

// ===== Download image from a specific card =====
async function downloadFromImageCard(card, resolution) {
    console.log('[Flow Automator] Starting IMAGE download from card, Resolution:', resolution);

    // Note: We don't register the image URL here because:
    // - The img src is the PREVIEW url
    // - The actual DOWNLOAD url is different
    // - The background script will detect it by timing and file type

    // Get image URL from card FIRST (before clicking download)
    const img = card.querySelector('img[src*="storage.googleapis.com"]');
    const imgUrl = img ? img.getAttribute('src') : '';

    if (imgUrl) {
        console.log('[Flow Automator] Image preview URL:', imgUrl.substring(0, 100) + '...');
        // Register to help background identify - even though preview URL != download URL
        chrome.runtime.sendMessage({
            action: 'registerDownload',
            url: imgUrl,
            type: 'image'
        });
    }

    // Hover over the image to reveal the overlay buttons
    if (img) {
        img.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        img.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await sleep(300); // Wait for overlay to appear
    }

    // Find download button within THIS wrapper/card
    const buttons = card.querySelectorAll('button');
    console.log('[Flow Automator] Found', buttons.length, 'buttons in wrapper');

    // Debug: Log all buttons
    buttons.forEach((btn, i) => {
        const icon = btn.querySelector('i');
        const span = btn.querySelector('span');
        const iconText = icon ? icon.textContent.trim() : '';
        const spanText = span ? span.textContent.trim() : '';
        console.log(`[Flow Automator] Button ${i}: icon="${iconText}", span="${spanText}", hasMenu=${btn.getAttribute('aria-haspopup') === 'menu'}`);
    });

    let downloadBtn = null;

    for (const btn of buttons) {
        const icon = btn.querySelector('i');
        const span = btn.querySelector('span');
        const iconText = icon ? icon.textContent.trim().toLowerCase() : '';
        const spanText = span ? span.textContent.trim().toLowerCase() : '';

        // Check icon text or span text for "download" or "baixar" (Portuguese)
        if (iconText === 'download' || spanText === 'download' || spanText === 'baixar') {
            if (btn.getAttribute('aria-haspopup') === 'menu') {
                console.log('[Flow Automator] Found download button with aria-haspopup=menu');
                downloadBtn = btn;
                break;
            }
        }
    }

    if (!downloadBtn) {
        // Fallback: find any button with download icon (without aria-haspopup check)
        for (const btn of buttons) {
            const icon = btn.querySelector('i');
            const span = btn.querySelector('span');
            const iconText = icon ? icon.textContent.trim().toLowerCase() : '';
            const spanText = span ? span.textContent.trim().toLowerCase() : '';

            if (iconText === 'download' || spanText === 'download' || spanText === 'baixar') {
                console.log('[Flow Automator] Found download button (fallback)');
                downloadBtn = btn;
                break;
            }
        }
    }

    if (!downloadBtn) {
        console.log('[Flow Automator] No download button found in image card');
        return false;
    }

    downloadBtn.click();
    console.log('[Flow Automator] Clicked download button, waiting for menu...');
    await sleep(800);

    let menuItems = document.querySelectorAll('[role="menuitem"]');

    // Retry if no menu items found
    if (menuItems.length === 0) {
        console.log('[Flow Automator] No menu items found, retrying...');
        await sleep(500);
        menuItems = document.querySelectorAll('[role="menuitem"]');
    }

    if (menuItems.length === 0) {
        console.log('[Flow Automator] Still no menu items found - menu may not have opened');
        return false; // Changed from true to false
    }

    console.log('[Flow Automator] Found', menuItems.length, 'menu items');

    // Select correct resolution (1K, 2K, or 4K)
    const targetTexts = IMAGE_DOWNLOAD_OPTIONS[resolution] || IMAGE_DOWNLOAD_OPTIONS['2k'];
    console.log('[Flow Automator] Looking for targetTexts:', targetTexts, 'for resolution:', resolution);

    for (const item of menuItems) {
        const itemText = item.textContent.trim();
        console.log('[Flow Automator] Menu item:', itemText);

        for (const target of targetTexts) {
            if (itemText.toLowerCase().includes(target.toLowerCase())) {
                console.log('[Flow Automator] Match found! Clicking image option:', itemText);
                item.click();
                await sleep(500);
                return true;
            }
        }
    }

    // Fallback: click first available option
    if (menuItems.length >= 1) {
        console.log('[Flow Automator] Fallback: clicking first menu item');
        menuItems[0].click();
        await sleep(500);
        return true;
    }

    return false;
}

// ===== Wait for upscale to complete =====
async function waitForUpscaleComplete(timeout) {
    const startTime = Date.now();

    console.log('[Flow Automator] Waiting for upscale to complete...');

    while (Date.now() - startTime < timeout) {
        // Look for toast messages using the exact selectors from the site
        const toastMessages = document.querySelectorAll('.sc-f6076f05-2, [data-sonner-toast] [data-title]');

        for (const msg of toastMessages) {
            const text = msg.textContent.toLowerCase();

            // Check if upscale is complete (look for "complete" text or check_circle icon nearby)
            if (text.includes('upscaling complete') || text.includes('has been downloaded')) {
                console.log('[Flow Automator] Found upscale complete message!');
                await sleep(500);
                return true;
            }

            // Check if still upscaling
            if (text.includes('upscaling your video') || text.includes('several minutes')) {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                updateStatus('Upscaling... (' + elapsed + 's)');
            }
        }

        // Also check for check_circle icon which appears when complete
        const checkIcon = document.querySelector('[data-sonner-toast] i.google-symbols');
        if (checkIcon && checkIcon.textContent.includes('check_circle')) {
            console.log('[Flow Automator] Found check_circle icon - upscale complete!');
            await sleep(500);
            return true;
        }

        await sleep(2000);
    }

    return false; // Timeout
}

// ===== Click Dismiss button on toast =====
async function clickDismissButton() {
    console.log('[Flow Automator] Looking for Dismiss button...');
    await sleep(500);

    // Find Dismiss button by class
    const dismissBtn = document.querySelector('.sc-f6076f05-0.hDgmZP, button.hDgmZP');
    if (dismissBtn) {
        console.log('[Flow Automator] Clicking Dismiss button (by class)');
        dismissBtn.click();
        await sleep(300);
        return true;
    }

    // Find by text
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
        const text = btn.textContent.trim().toLowerCase();
        if (text === 'dismiss') {
            console.log('[Flow Automator] Clicking Dismiss button');
            btn.click();
            await sleep(300);
            return true;
        }
    }

    console.log('[Flow Automator] Dismiss button not found');
    return false;
}

// ===== DOM Interaction Functions =====
async function waitForPageReady() {
    await sleep(1000);
    return true;
}

// Select the generation mode (video or image)
async function selectMode(mode) {
    const modeTexts = MODE_TEXTS[mode] || MODE_TEXTS.video;
    console.log('[Flow Automator] Selecting mode:', mode);

    const combobox = document.querySelector(SELECTORS.modeCombobox);
    if (!combobox) {
        console.log('[Flow Automator] Mode combobox not found');
        return false;
    }

    combobox.click();
    await sleep(500);

    const options = document.querySelectorAll(SELECTORS.modeOption);
    for (const option of options) {
        const optionText = option.innerText.trim();
        for (const targetText of modeTexts) {
            if (optionText.toLowerCase().includes(targetText.toLowerCase())) {
                option.click();
                console.log('[Flow Automator] Mode selected:', optionText);
                await sleep(300);
                return true;
            }
        }
    }

    document.body.click();
    return false;
}

// Configure settings (aspect ratio and outputs per prompt = 1)
async function configureSettings(aspectRatio) {
    console.log('[Flow Automator] Configuring settings, aspect ratio:', aspectRatio);

    // Find Settings button (tune icon)
    const allButtons = document.querySelectorAll('button');
    let settingsBtn = null;

    for (const btn of allButtons) {
        const icon = btn.querySelector('i');
        if (icon && icon.textContent && icon.textContent.includes('tune')) {
            settingsBtn = btn;
            break;
        }
    }

    if (!settingsBtn) {
        settingsBtn = document.querySelector(SELECTORS.settingsBtn);
    }

    if (!settingsBtn) {
        console.log('[Flow Automator] Settings button not found');
        return false;
    }

    settingsBtn.click();
    await sleep(500);

    // Set Outputs per prompt to 1
    await selectDropdownOption(DROPDOWN_LABELS.outputsPerPrompt, '1');
    await sleep(300);

    // Set Aspect Ratio if provided
    if (aspectRatio) {
        const aspectTexts = ASPECT_RATIO_TEXTS[aspectRatio] || [aspectRatio];
        await selectDropdownOption(DROPDOWN_LABELS.aspectRatio, aspectTexts);
        await sleep(300);
    }

    document.body.click();
    await sleep(200);

    console.log('[Flow Automator] Settings configured');
    return true;
}

// Helper function to select a dropdown option
async function selectDropdownOption(labelTexts, targetValue) {
    const comboboxes = document.querySelectorAll('button[role="combobox"]');
    let targetCombobox = null;

    for (const cb of comboboxes) {
        const parentText = cb.parentElement ? cb.parentElement.innerText : '';
        const cbText = cb.innerText;

        for (const label of labelTexts) {
            if (parentText.includes(label) || cbText.includes(label)) {
                targetCombobox = cb;
                break;
            }
        }
        if (targetCombobox) break;
    }

    if (!targetCombobox) {
        console.log('[Flow Automator] Dropdown not found for labels:', labelTexts);
        return false;
    }

    targetCombobox.click();
    await sleep(400);

    const options = document.querySelectorAll('div[role="option"]');
    const targetValues = Array.isArray(targetValue) ? targetValue : [targetValue];

    for (const option of options) {
        const optionText = option.innerText.trim();

        for (const val of targetValues) {
            if (optionText === val || optionText.includes(val)) {
                option.click();
                console.log('[Flow Automator] Selected option:', optionText);
                return true;
            }
        }
    }

    document.body.click();
    return false;
}

async function fillPromptInput(prompt) {
    const flowInput = document.getElementById('PINHOLE_TEXT_AREA_ELEMENT_ID');
    if (flowInput) {
        flowInput.value = '';
        flowInput.focus();
        await sleep(100);
        flowInput.value = prompt;
        flowInput.dispatchEvent(new Event('input', { bubbles: true }));
        flowInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[Flow Automator] Prompt filled');
        return true;
    }

    // Fallback to any textarea
    const textareas = document.querySelectorAll('textarea');
    for (const ta of textareas) {
        if (ta.offsetParent !== null) {
            ta.value = '';
            ta.focus();
            await sleep(100);
            ta.value = prompt;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        }
    }
    return false;
}

async function clickGenerateButton() {
    const allButtons = document.querySelectorAll('button');

    // Look for button with arrow_forward icon
    for (const btn of allButtons) {
        const icon = btn.querySelector('i.google-symbols');
        if (icon && icon.textContent && icon.textContent.includes('arrow_forward')) {
            if (btn.offsetParent !== null && !btn.disabled) {
                btn.click();
                console.log('[Flow Automator] Generate button clicked');
                return true;
            }
        }
    }

    // Fallback: buttons with text Criar/Generate
    for (const btn of allButtons) {
        const text = btn.textContent.toLowerCase();
        if (text.includes('criar') || text.includes('generate')) {
            if (btn.offsetParent !== null && !btn.disabled) {
                btn.click();
                return true;
            }
        }
    }

    return false;
}

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
        if (counterEl) counterEl.textContent = `Prompt ${current} de ${total}`;
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
    const totalTime = `${mins}:${secs}`;

    // Update the overlay to show completion
    const mainEl = statusElement.querySelector('.fa-status-main');
    const bodyEl = statusElement.querySelector('.fa-status-body');
    const spinnerEl = statusElement.querySelector('.fa-spinner-small');

    if (mainEl) {
        mainEl.textContent = '✅ Concluído!';
        mainEl.style.color = '#10b981';
    }

    if (spinnerEl) {
        spinnerEl.style.display = 'none';
    }

    if (bodyEl) {
        bodyEl.innerHTML = `
            <div style="text-align: center; padding: 10px 0;">
                <div style="font-size: 24px; margin-bottom: 8px;">🎉</div>
                <div style="color: #10b981; font-size: 14px; font-weight: 600; margin-bottom: 4px;">
                    Automação finalizada!
                </div>
                <div style="color: rgba(255,255,255,0.7); font-size: 12px; margin-bottom: 8px;">
                    ${successCount} prompt${successCount !== 1 ? 's' : ''} processado${successCount !== 1 ? 's' : ''} com sucesso
                    ${failCount > 0 ? `<br><span style="color: #f87171;">${failCount} falha${failCount !== 1 ? 's' : ''}</span>` : ''}
                </div>
                <div style="color: #a855f7; font-size: 13px; font-weight: 500;">
                    ⏱️ Tempo total: ${totalTime}
                </div>
            </div>
        `;
    }
}

function handlePaused(message) {
    // Update overlay to show paused state
    if (!statusElement) return;

    const mainEl = statusElement.querySelector('.fa-status-main');
    if (mainEl) {
        let pauseText = '⏸️ Pausado';
        if (message.isScheduled && message.pauseMinutes) {
            pauseText = `⏸️ Pausa programada (${message.pauseMinutes} min)`;
        }
        mainEl.textContent = pauseText;
    }

    // Show unpause button if needed
    const bodyEl = statusElement.querySelector('.fa-status-body');
    if (bodyEl && message.isScheduled) {
        // Add unpause button for manual override
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
    // Update overlay to show resumed state
    updateOverlay('Retomando automação...');
}

function showStatus(title, subtitle) {
    subtitle = subtitle || '';

    // If status already exists AND is still in DOM, just update it
    if (statusElement && document.body.contains(statusElement)) {
        const mainEl = statusElement.querySelector('.fa-status-main');
        const promptEl = statusElement.querySelector('.fa-status-prompt');
        if (mainEl) mainEl.textContent = title;
        if (promptEl) promptEl.textContent = subtitle.substring(0, 150) + (subtitle.length > 150 ? '...' : '');
        return;
    }

    // Element was removed (by X button), reset it
    statusElement = null;

    statusStartTime = Date.now();

    // Start timer
    if (statusTimerInterval) clearInterval(statusTimerInterval);
    statusTimerInterval = setInterval(() => {
        if (statusElement) {
            const elapsed = Math.floor((Date.now() - statusStartTime) / 1000);
            const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const secs = (elapsed % 60).toString().padStart(2, '0');
            const timerEl = statusElement.querySelector('.fa-timer');
            if (timerEl) timerEl.textContent = `Tempo: ${mins}:${secs}`;
        }
    }, 1000);

    // Create floating status div
    statusElement = document.createElement('div');
    statusElement.id = 'flow-automator-status';
    statusElement.innerHTML =
        '<div class="fa-status-content">' +
        '<div class="fa-status-header">' +
        '<span class="fa-spinner-small"></span>' +
        '<span class="fa-status-title">Flow Automator</span>' +
        '<span class="fa-status-main">' + title + '</span>' +
        '<button class="fa-close-btn" onclick="this.closest(\'#flow-automator-status\').remove()">✕</button>' +
        '</div>' +
        '<div class="fa-status-body">' +
        '<p class="fa-status-prompt">' + subtitle.substring(0, 150) + (subtitle.length > 150 ? '...' : '') + '</p>' +
        '<div class="fa-status-info">' +
        '<span class="fa-counter">Prompt ' + statusCurrentPrompt + ' de ' + statusTotalPrompts + '</span>' +
        '<span class="fa-timer">Tempo: 00:00</span>' +
        '</div>' +
        '</div>' +
        '<div class="fa-status-footer">' +
        'Gosta do projeto? ❤️ <a href="https://ko-fi.com/dentparanoide" target="_blank">Me paga um cafezinho</a>' +
        '</div>' +
        '</div>';

    // Add styles
    const styles = document.createElement('style');
    styles.id = 'flow-automator-styles';
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
            border-bottom: 1px solid rgba(255,255,255,0.1);
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
            color: rgba(255,255,255,0.4);
            cursor: pointer;
            font-size: 12px;
            padding: 2px 6px;
            border-radius: 4px;
            margin-left: 4px;
        }
        .fa-close-btn:hover {
            background: rgba(255,255,255,0.1);
            color: white;
        }
        .fa-status-body {
            color: white;
        }
        .fa-status-prompt {
            font-size: 12px;
            color: rgba(255,255,255,0.8);
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
            color: rgba(255,255,255,0.6);
        }
        .fa-progress-bar {
            background: rgba(255,255,255,0.1);
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
            color: rgba(255,255,255,0.4);
            text-align: center;
            padding-top: 8px;
            border-top: 1px solid rgba(255,255,255,0.05);
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
    chrome.runtime.sendMessage({
        type: 'promptComplete',
        success: success,
        mediaUrl: mediaUrl,
        prompt: prompt,
        error: error
    });
}

// ===== Utilities =====
function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

console.log('[Flow Automator] Ready on:', window.location.href);
