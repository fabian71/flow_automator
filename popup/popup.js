// ===== DOM Elements =====
const elements = {
  generationMode: document.getElementById('generationMode'),
  prompts: document.getElementById('prompts'),
  clearPrompts: document.getElementById('clearPrompts'),
  promptCount: document.getElementById('promptCount'),
  autoDownload: document.getElementById('autoDownload'),
  doUpscale: document.getElementById('doUpscale'),
  savePromptTxt: document.getElementById('savePromptTxt'),
  subfolder: document.getElementById('subfolder'),
  delaySeconds: document.getElementById('delaySeconds'),
  aspectRatio: document.getElementById('aspectRatio'),
  aspectRatioGroup: document.getElementById('aspectRatioGroup'),
  imageResolution: document.getElementById('imageResolution'),
  imageResolutionGroup: document.getElementById('imageResolutionGroup'),
  upscaleRow: document.getElementById('upscaleRow'),
  generationTimeout: document.getElementById('generationTimeout'),
  maxRetries: document.getElementById('maxRetries'),
  startBtn: document.getElementById('startBtn'),
  unpauseBtn: document.getElementById('unpauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  statusIndicator: document.getElementById('statusIndicator'),
  progressSection: document.getElementById('progressSection'),
  progressText: document.getElementById('progressText'),
  progressPercent: document.getElementById('progressPercent'),
  progressFill: document.getElementById('progressFill'),
  randomizeAspectRatio: document.getElementById('randomizeAspectRatio'),
  randomAspectRatioOptions: document.getElementById('randomAspectRatioOptions'),
  randomIncludePortrait: document.getElementById('randomIncludePortrait'),
  randomIncludeLandscape: document.getElementById('randomIncludeLandscape'),
  scheduledPauseEnabled: document.getElementById('scheduledPauseEnabled'),
  scheduledPauseOptions: document.getElementById('scheduledPauseOptions'),
  pauseEveryN: document.getElementById('pauseEveryN'),
  pauseUnitText: document.getElementById('pauseUnitText'),
  pauseMinMinutes: document.getElementById('pauseMinMinutes'),
  pauseMaxMinutes: document.getElementById('pauseMaxMinutes'),
  pauseMinDisplay: document.getElementById('pauseMinDisplay'),
  pauseMaxDisplay: document.getElementById('pauseMaxDisplay'),
  rangeFill: document.getElementById('rangeFill')
};

// ===== State =====
let isProcessing = false;

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupEventListeners();
  updatePromptCount();
  checkProcessingStatus();
  updateModeVisibility();

  // Generate default subfolder name
  if (!elements.subfolder.value) {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    elements.subfolder.value = `flow_${month}_${day}`;
  }
});

// Update visibility based on mode and aspect ratio
function updateModeVisibility() {
  const isImage = elements.generationMode.value === 'image';
  const isPortrait = elements.aspectRatio.value === '9:16';
  const autoDownloadEnabled = elements.autoDownload.checked;

  // Upscale only available for videos in 16:9 mode
  // 9:16 videos have no upscale option (direct download)
  // Images don't use this checkbox (they have resolution select)
  if (elements.upscaleRow) {
    if (isImage) {
      // Hide upscale for images (they use resolution select)
      elements.upscaleRow.style.display = 'none';
    } else {
      // Show for videos, but disable for 9:16 or if autoDownload is off
      elements.upscaleRow.style.display = 'flex';
      const shouldDisable = isPortrait || !autoDownloadEnabled;
      elements.doUpscale.disabled = shouldDisable;
      elements.upscaleRow.style.opacity = shouldDisable ? '0.5' : '1';
    }
  }

  // Image resolution only available for images and when autoDownload is enabled
  if (elements.imageResolutionGroup) {
    if (isImage) {
      elements.imageResolutionGroup.style.display = 'block';
      elements.imageResolution.disabled = !autoDownloadEnabled;
      elements.imageResolutionGroup.style.opacity = autoDownloadEnabled ? '1' : '0.5';
    } else {
      elements.imageResolutionGroup.style.display = 'none';
    }
  }

  // Save prompt txt only enabled when autoDownload is enabled
  if (elements.savePromptTxt) {
    elements.savePromptTxt.disabled = !autoDownloadEnabled;
    const savePromptRow = elements.savePromptTxt.closest('.option-row');
    if (savePromptRow) {
      savePromptRow.style.opacity = autoDownloadEnabled ? '1' : '0.5';
    }
  }
}

// ===== Event Listeners =====
function setupEventListeners() {
  // Generation mode change
  elements.generationMode.addEventListener('change', () => {
    updateModeVisibility();
    saveSettings();
  });

  // Prompts textarea
  elements.prompts.addEventListener('input', () => {
    updatePromptCount();
    saveSettings();
  });

  // Clear prompts
  elements.clearPrompts.addEventListener('click', () => {
    elements.prompts.value = '';
    updatePromptCount();
    saveSettings();
  });

  // Aspect ratio change - affects upscale visibility
  elements.aspectRatio.addEventListener('change', () => {
    updateModeVisibility();
    saveSettings();
  });

  // Randomize aspect ratio toggle
  elements.randomizeAspectRatio.addEventListener('change', () => {
    elements.randomAspectRatioOptions.style.display =
      elements.randomizeAspectRatio.checked ? 'block' : 'none';

    // Hide aspect ratio select when randomizing
    elements.aspectRatio.closest('.form-group').style.opacity =
      elements.randomizeAspectRatio.checked ? '0.5' : '1';
    elements.aspectRatio.disabled = elements.randomizeAspectRatio.checked;

    saveSettings();
  });

  // Validate at least one option is checked when randomizing
  const validateRandomOptions = () => {
    if (elements.randomizeAspectRatio.checked) {
      const hasAtLeastOne = elements.randomIncludePortrait.checked || elements.randomIncludeLandscape.checked;
      if (!hasAtLeastOne) {
        // Re-check the last unchecked one
        if (!elements.randomIncludePortrait.checked) {
          elements.randomIncludePortrait.checked = true;
        } else {
          elements.randomIncludeLandscape.checked = true;
        }
      }
    }
    saveSettings();
  };

  elements.randomIncludePortrait.addEventListener('change', validateRandomOptions);
  elements.randomIncludeLandscape.addEventListener('change', validateRandomOptions);

  // Auto download change - affects visibility of dependent options
  elements.autoDownload.addEventListener('change', () => {
    // If unchecked, uncheck dependent options too
    if (!elements.autoDownload.checked) {
      elements.doUpscale.checked = false;
      elements.savePromptTxt.checked = false;
      // Don't uncheck imageResolution as it's a select, not checkbox
    }
    updateModeVisibility();
    saveSettings();
  });

  // Scheduled pause toggle
  elements.scheduledPauseEnabled.addEventListener('change', () => {
    elements.scheduledPauseOptions.style.display =
      elements.scheduledPauseEnabled.checked ? 'block' : 'none';
    saveSettings();
  });

  // Update pause unit text based on mode
  elements.generationMode.addEventListener('change', () => {
    const isImage = elements.generationMode.value === 'image';
    elements.pauseUnitText.textContent = isImage ? 'imagens' : 'vídeos';
  });

  // Update pause range display and fill
  const updatePauseRangeDisplay = () => {
    let min = parseInt(elements.pauseMinMinutes.value) || 1;
    let max = parseInt(elements.pauseMaxMinutes.value) || 6;

    // Validate min <= max
    if (min > max) {
      const temp = min;
      min = max;
      max = temp;
      elements.pauseMinMinutes.value = min;
      elements.pauseMaxMinutes.value = max;
    }

    // Update displays
    elements.pauseMinDisplay.textContent = min;
    elements.pauseMaxDisplay.textContent = max;

    // Update fill bar position
    const percent = (value) => ((value - 1) / (60 - 1)) * 100;
    const leftPercent = percent(min);
    const rightPercent = percent(max);

    elements.rangeFill.style.left = leftPercent + '%';
    elements.rangeFill.style.width = (rightPercent - leftPercent) + '%';

    saveSettings();
  };

  elements.pauseMinMinutes.addEventListener('input', updatePauseRangeDisplay);
  elements.pauseMaxMinutes.addEventListener('input', updatePauseRangeDisplay);
  elements.pauseEveryN.addEventListener('change', saveSettings);

  // All inputs - save on change
  const inputElements = [
    elements.autoDownload,
    elements.doUpscale,
    elements.savePromptTxt,
    elements.subfolder,
    elements.delaySeconds,
    elements.generationTimeout,
    elements.maxRetries,
    elements.imageResolution,
    elements.randomIncludePortrait,
    elements.randomIncludeLandscape
  ];

  inputElements.forEach(el => {
    if (el) {
      el.addEventListener('change', saveSettings);
      if (el.tagName === 'INPUT' && el.type !== 'checkbox') {
        el.addEventListener('input', saveSettings);
      }
    }
  });

  // Start button
  elements.startBtn.addEventListener('click', startAutomation);

  // Unpause button
  elements.unpauseBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'unpause' });
  });

  // Stop button
  elements.stopBtn.addEventListener('click', stopAutomation);

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'progress') {
      updateProgress(message.current, message.total, message.status);
    } else if (message.type === 'complete') {
      handleComplete(message.success, message.failed);
    } else if (message.type === 'error') {
      handleError(message.error);
    } else if (message.type === 'paused') {
      handlePaused(message);
    } else if (message.type === 'unpaused') {
      handleUnpaused();
    }
  });
}

// ===== Functions =====
function updatePromptCount() {
  const prompts = elements.prompts.value.trim().split('\n').filter(p => p.trim());
  const count = prompts.length;
  elements.promptCount.textContent = `${count} prompt${count !== 1 ? 's' : ''}`;
}

async function loadSettings() {
  const settings = await chrome.storage.local.get([
    'generationMode',
    'prompts',
    'autoDownload',
    'doUpscale',
    'savePromptTxt',
    'subfolder',
    'delaySeconds',
    'aspectRatio',
    'imageResolution',
    'generationTimeout',
    'maxRetries',
    'randomizeAspectRatio',
    'randomIncludePortrait',
    'randomIncludeLandscape',
    'scheduledPauseEnabled',
    'pauseEveryN',
    'pauseMinMinutes',
    'pauseMaxMinutes'
  ]);

  if (settings.generationMode) elements.generationMode.value = settings.generationMode;
  if (settings.prompts) elements.prompts.value = settings.prompts;
  if (settings.autoDownload !== undefined) elements.autoDownload.checked = settings.autoDownload;
  if (settings.doUpscale !== undefined) elements.doUpscale.checked = settings.doUpscale;
  if (settings.savePromptTxt !== undefined) elements.savePromptTxt.checked = settings.savePromptTxt;
  if (settings.subfolder) elements.subfolder.value = settings.subfolder;
  if (settings.delaySeconds) elements.delaySeconds.value = settings.delaySeconds;
  if (settings.aspectRatio) elements.aspectRatio.value = settings.aspectRatio;
  if (settings.imageResolution) elements.imageResolution.value = settings.imageResolution;
  if (settings.generationTimeout) elements.generationTimeout.value = settings.generationTimeout;
  if (settings.maxRetries) elements.maxRetries.value = settings.maxRetries;

  // Randomization settings
  if (settings.randomizeAspectRatio !== undefined) {
    elements.randomizeAspectRatio.checked = settings.randomizeAspectRatio;
    elements.randomAspectRatioOptions.style.display = settings.randomizeAspectRatio ? 'block' : 'none';
    elements.aspectRatio.closest('.form-group').style.opacity = settings.randomizeAspectRatio ? '0.5' : '1';
    elements.aspectRatio.disabled = settings.randomizeAspectRatio;
  }
  if (settings.randomIncludePortrait !== undefined) elements.randomIncludePortrait.checked = settings.randomIncludePortrait;
  if (settings.randomIncludeLandscape !== undefined) elements.randomIncludeLandscape.checked = settings.randomIncludeLandscape;

  // Scheduled pause settings
  if (settings.scheduledPauseEnabled !== undefined) {
    elements.scheduledPauseEnabled.checked = settings.scheduledPauseEnabled;
    elements.scheduledPauseOptions.style.display = settings.scheduledPauseEnabled ? 'block' : 'none';
  }
  if (settings.pauseEveryN) elements.pauseEveryN.value = settings.pauseEveryN;
  if (settings.pauseMinMinutes) elements.pauseMinMinutes.value = settings.pauseMinMinutes;
  if (settings.pauseMaxMinutes) elements.pauseMaxMinutes.value = settings.pauseMaxMinutes;

  // Update pause displays and fill bar
  const min = settings.pauseMinMinutes || 1;
  const max = settings.pauseMaxMinutes || 6;
  elements.pauseMinDisplay.textContent = min;
  elements.pauseMaxDisplay.textContent = max;

  const percent = (value) => ((value - 1) / (60 - 1)) * 100;
  const leftPercent = percent(min);
  const rightPercent = percent(max);
  elements.rangeFill.style.left = leftPercent + '%';
  elements.rangeFill.style.width = (rightPercent - leftPercent) + '%';

  // Update visibility based on mode
  updateModeVisibility();
}

async function saveSettings() {
  await chrome.storage.local.set({
    generationMode: elements.generationMode.value,
    prompts: elements.prompts.value,
    autoDownload: elements.autoDownload.checked,
    doUpscale: elements.doUpscale.checked,
    savePromptTxt: elements.savePromptTxt.checked,
    subfolder: elements.subfolder.value,
    delaySeconds: parseInt(elements.delaySeconds.value) || 5,
    aspectRatio: elements.aspectRatio.value,
    imageResolution: elements.imageResolution.value,
    generationTimeout: parseInt(elements.generationTimeout.value) || 180,
    maxRetries: parseInt(elements.maxRetries.value) || 2,
    randomizeAspectRatio: elements.randomizeAspectRatio.checked,
    randomIncludePortrait: elements.randomIncludePortrait.checked,
    randomIncludeLandscape: elements.randomIncludeLandscape.checked,
    scheduledPauseEnabled: elements.scheduledPauseEnabled.checked,
    pauseEveryN: parseInt(elements.pauseEveryN.value) || 3,
    pauseMinMinutes: parseInt(elements.pauseMinMinutes.value) || 1,
    pauseMaxMinutes: parseInt(elements.pauseMaxMinutes.value) || 6
  });
}

async function checkProcessingStatus() {
  const status = await chrome.storage.local.get(['isProcessing', 'currentIndex', 'totalPrompts']);
  if (status.isProcessing) {
    isProcessing = true;
    showProcessingUI();
    updateProgress(status.currentIndex || 0, status.totalPrompts || 0, 'Processando...');
  }
}

async function startAutomation() {
  const prompts = elements.prompts.value.trim().split('\n').filter(p => p.trim());

  if (prompts.length === 0) {
    alert('Por favor, adicione pelo menos um prompt.');
    return;
  }

  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url.includes('labs.google/fx/tools/flow')) {
    alert('Por favor, abra o Google Flow antes de iniciar a automação.\n\nhttps://labs.google/fx/tools/flow');
    return;
  }

  isProcessing = true;
  showProcessingUI();

  // Save current settings
  await saveSettings();

  // Send message to background script
  chrome.runtime.sendMessage({
    type: 'start',
    config: {
      tabId: tab.id,
      prompts: prompts,
      mode: elements.generationMode.value,
      autoDownload: elements.autoDownload.checked,
      doUpscale: elements.doUpscale.checked,
      savePromptTxt: elements.savePromptTxt.checked,
      subfolder: elements.subfolder.value,
      delaySeconds: parseInt(elements.delaySeconds.value) || 5,
      aspectRatio: elements.aspectRatio.value,
      imageResolution: elements.imageResolution.value,
      generationTimeout: parseInt(elements.generationTimeout.value) || 180,
      maxRetries: parseInt(elements.maxRetries.value) || 2,
      randomizeAspectRatio: elements.randomizeAspectRatio.checked,
      randomIncludePortrait: elements.randomIncludePortrait.checked,
      randomIncludeLandscape: elements.randomIncludeLandscape.checked,
      scheduledPauseEnabled: elements.scheduledPauseEnabled.checked,
      pauseEveryN: parseInt(elements.pauseEveryN.value) || 3,
      pauseMinMinutes: parseInt(elements.pauseMinMinutes.value) || 1,
      pauseMaxMinutes: parseInt(elements.pauseMaxMinutes.value) || 6
    }
  });
}

function stopAutomation() {
  chrome.runtime.sendMessage({ type: 'stop' });
  hideProcessingUI();
  isProcessing = false;
}

function showProcessingUI() {
  elements.startBtn.style.display = 'none';
  elements.stopBtn.style.display = 'flex';
  elements.progressSection.style.display = 'block';
  elements.statusIndicator.classList.add('processing');
  elements.statusIndicator.querySelector('.status-text').textContent = 'Processando';

  // Disable inputs
  setInputsDisabled(true);
}

function hideProcessingUI() {
  elements.startBtn.style.display = 'flex';
  elements.stopBtn.style.display = 'none';
  elements.progressSection.style.display = 'none';
  elements.statusIndicator.classList.remove('processing', 'error');
  elements.statusIndicator.querySelector('.status-text').textContent = 'Pronto';

  // Enable inputs
  setInputsDisabled(false);
}

function setInputsDisabled(disabled) {
  elements.generationMode.disabled = disabled;
  elements.prompts.disabled = disabled;
  elements.autoDownload.disabled = disabled;
  elements.doUpscale.disabled = disabled;
  elements.savePromptTxt.disabled = disabled;
  elements.subfolder.disabled = disabled;
  elements.delaySeconds.disabled = disabled;
  elements.aspectRatio.disabled = disabled;
  elements.generationTimeout.disabled = disabled;
  elements.maxRetries.disabled = disabled;
}

function updateProgress(current, total, status) {
  // current is 0-based index, so use current for completed count
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  elements.progressText.textContent = status || `Processando prompt ${current + 1} de ${total}...`;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressFill.style.width = `${percent}%`;
}

function handlePaused(message) {
  // Show unpause button, hide start button
  elements.startBtn.style.display = 'none';
  elements.unpauseBtn.style.display = 'flex';
  elements.stopBtn.style.display = 'flex';

  // Update status
  elements.statusIndicator.classList.add('processing');
  elements.statusIndicator.querySelector('.status-text').textContent = 'Em pausa';

  // Update progress text
  let pauseText = 'Pausado';
  if (message.isScheduled && message.pauseMinutes) {
    pauseText = `Pausa programada (${message.pauseMinutes} min)`;
  }
  elements.progressText.textContent = pauseText;
}

function handleUnpaused() {
  // Keep unpause button visible during processing
  elements.unpauseBtn.style.display = 'none';
  elements.startBtn.style.display = 'none';
  elements.stopBtn.style.display = 'flex';

  // Update status
  elements.statusIndicator.querySelector('.status-text').textContent = 'Processando';
}

function handleComplete(success, failed) {
  hideProcessingUI();
  isProcessing = false;

  const message = `Automação concluída!\n\n✅ Sucesso: ${success}\n❌ Falhas: ${failed}`;
  alert(message);
}

function handleError(error) {
  elements.statusIndicator.classList.add('error');
  elements.statusIndicator.querySelector('.status-text').textContent = 'Erro';

  alert(`Erro: ${error}`);
  hideProcessingUI();
  isProcessing = false;
}
