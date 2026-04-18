// ===== DOM Elements =====
const elements = {
  generationMode: document.getElementById('generationMode'),
  prompts: document.getElementById('prompts'),
  clearPrompts: document.getElementById('clearPrompts'),
  removeCount: document.getElementById('removeCount'),
  removePromptsBtn: document.getElementById('removePromptsBtn'),
  promptCount: document.getElementById('promptCount'),
  autoDownload: document.getElementById('autoDownload'),
  doUpscale: document.getElementById('doUpscale'),
  savePromptTxt: document.getElementById('savePromptTxt'),
  subfolder: document.getElementById('subfolder'),
  delaySeconds: document.getElementById('delaySeconds'),
  aspectRatio: document.getElementById('aspectRatio'),
  aspectRatioGroup: document.getElementById('aspectRatioGroup'),
  imageModel: document.getElementById('imageModel'),
  imageModelGroup: document.getElementById('imageModelGroup'),
  videoModel: document.getElementById('videoModel'),
  videoModelGroup: document.getElementById('videoModelGroup'),
  imageResolution: document.getElementById('imageResolution'),
  imageResolutionGroup: document.getElementById('imageResolutionGroup'),
  videoResolution: document.getElementById('videoResolution'),
  videoResolutionGroup: document.getElementById('videoResolutionGroup'),
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
  randomIncludeLandscape43: document.getElementById('randomIncludeLandscape43'),
  randomIncludeLandscape43Wrapper: document.getElementById('randomIncludeLandscape43Wrapper'),
  randomIncludeSquare: document.getElementById('randomIncludeSquare'),
  randomIncludeSquareWrapper: document.getElementById('randomIncludeSquareWrapper'),
  randomIncludePortrait34: document.getElementById('randomIncludePortrait34'),
  randomIncludePortrait34Wrapper: document.getElementById('randomIncludePortrait34Wrapper'),
  randomIncludePortrait: document.getElementById('randomIncludePortrait'),
  randomIncludeLandscape: document.getElementById('randomIncludeLandscape'),
  scheduledPauseEnabled: document.getElementById('scheduledPauseEnabled'),
  scheduledPauseOptions: document.getElementById('scheduledPauseOptions'),
  videoModelWrapper: document.getElementById('videoModelWrapper'),
  pauseEveryN: document.getElementById('pauseEveryN'),
  pauseUnitText: document.getElementById('pauseUnitText'),
  pauseMinMinutes: document.getElementById('pauseMinMinutes'),
  pauseMaxMinutes: document.getElementById('pauseMaxMinutes'),
  pauseMinDisplay: document.getElementById('pauseMinDisplay'),
  pauseMaxDisplay: document.getElementById('pauseMaxDisplay'),
  rangeFill: document.getElementById('rangeFill'),
  imageInput: document.getElementById('imageInput'),
  dropZone: document.getElementById('dropZone'),
  dropZoneText: document.getElementById('dropZoneText'),
  imageCountBadge: document.getElementById('imageCountBadge'),
  imageUploadGroup: document.getElementById('imageUploadGroup'),
  imagePreviewContainer: document.getElementById('imagePreviewContainer'),
  clearImagesBtn: document.getElementById('clearImagesBtn'),
  videoDuration: document.getElementById('videoDuration'),
  videoDurationGroup: document.getElementById('videoDurationGroup')
};

// ===== State =====
let isProcessing = false;
let selectedImages = [];

const VIDEO_RATIOS = ['16:9', '9:16'];

function getAllowedRatios() {
  return elements.generationMode.value === 'video'
    ? VIDEO_RATIOS
    : ['16:9', '4:3', '1:1', '3:4', '9:16'];
}

function getActiveRandomRatioElements() {
  const base = [
    { input: elements.randomIncludeLandscape, wrapper: null, ratio: '16:9' },
    { input: elements.randomIncludePortrait, wrapper: null, ratio: '9:16' }
  ];

  if (elements.generationMode.value === 'image') {
    base.splice(1, 0,
      { input: elements.randomIncludeLandscape43, wrapper: elements.randomIncludeLandscape43Wrapper, ratio: '4:3' },
      { input: elements.randomIncludeSquare, wrapper: elements.randomIncludeSquareWrapper, ratio: '1:1' },
      { input: elements.randomIncludePortrait34, wrapper: elements.randomIncludePortrait34Wrapper, ratio: '3:4' }
    );
  }

  return base.filter(item => item.input);
}

function syncAspectRatioOptionsByMode() {
  const isVideo = elements.generationMode.value === 'video';

  Array.from(elements.aspectRatio.options).forEach((option) => {
    const isImageOnly = option.dataset.mode === 'image';
    option.hidden = isVideo && isImageOnly;
  });

  if (!getAllowedRatios().includes(elements.aspectRatio.value)) {
    elements.aspectRatio.value = '16:9';
  }

  [
    { input: elements.randomIncludeLandscape43, wrapper: elements.randomIncludeLandscape43Wrapper },
    { input: elements.randomIncludeSquare, wrapper: elements.randomIncludeSquareWrapper },
    { input: elements.randomIncludePortrait34, wrapper: elements.randomIncludePortrait34Wrapper }
  ].forEach(({ input, wrapper }) => {
    if (!input || !wrapper) return;
    wrapper.style.display = isVideo ? 'none' : '';
    if (isVideo) input.checked = false;
  });

  if (isVideo && !elements.randomIncludeLandscape.checked && !elements.randomIncludePortrait.checked) {
    elements.randomIncludeLandscape.checked = true;
  }
}

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
  const isVideo = elements.generationMode.value === 'video';

  syncAspectRatioOptionsByMode();

  if (elements.imageUploadGroup) {
    // Enable image upload for Video mode (Image to Video)
    elements.imageUploadGroup.style.display = isVideo ? 'block' : 'none';
  }

  if (elements.videoDurationGroup) {
    elements.videoDurationGroup.style.display = isVideo ? 'block' : 'none';
  }

  if (elements.videoModelGroup) {
    elements.videoModelGroup.style.display = isVideo ? 'block' : 'none';
  }

  if (elements.imageModelGroup) {
    elements.imageModelGroup.style.display = isImage ? 'block' : 'none';
  }

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
      // Video now uses explicit resolution selector
      elements.upscaleRow.style.display = 'none';
      const shouldDisable = isPortrait || !autoDownloadEnabled;
      elements.doUpscale.disabled = shouldDisable;
      elements.upscaleRow.style.opacity = shouldDisable ? '0.5' : '1';
    }
  }

  if (elements.videoResolutionGroup) {
    if (isVideo) {
      elements.videoResolutionGroup.style.display = 'block';
      elements.videoResolution.disabled = !autoDownloadEnabled;
      elements.videoResolutionGroup.style.opacity = autoDownloadEnabled ? '1' : '0.5';
    } else {
      elements.videoResolutionGroup.style.display = 'none';
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
  // Remove prompts
  elements.removePromptsBtn.addEventListener('click', () => {
    const countToRemove = parseInt(elements.removeCount.value) || 0;
    if (countToRemove <= 0) return;

    const lines = elements.prompts.value.split('\n');
    let promptsRemoved = 0;
    let removedIndices = [];

    // Filter out non-empty lines to count prompts
    for (let i = 0; i < lines.length && promptsRemoved < countToRemove; i++) {
      const cleaned = cleanInvisibleChars(lines[i]);
      if (cleaned.length > 0) {
        promptsRemoved++;
      }
      removedIndices.push(i);
    }

    const finalLines = lines.filter((_, index) => !removedIndices.includes(index));
    elements.prompts.value = finalLines.join('\n');
    updatePromptCount();
    saveSettings();
  });
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
      const randomRatioElements = getActiveRandomRatioElements().map((item) => item.input);
      const hasAtLeastOne = randomRatioElements.some((el) => el.checked);
      if (!hasAtLeastOne) {
        randomRatioElements[0].checked = true;
      }
    }
    saveSettings();
  };

  elements.randomIncludeLandscape43.addEventListener('change', validateRandomOptions);
  elements.randomIncludeSquare.addEventListener('change', validateRandomOptions);
  elements.randomIncludePortrait34.addEventListener('change', validateRandomOptions);
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

  // Easter egg: 10 clicks on the logo unlocks the video model select + adds 4K resolution
  let videoModelEggClicks = 0;
  let videoModelEggTimer = null;
  const logoIcon = document.getElementById('logoIcon');
  if (logoIcon) {
    logoIcon.addEventListener('click', async () => {
      videoModelEggClicks++;
      clearTimeout(videoModelEggTimer);
      // Reset counter if no click for 4 seconds
      videoModelEggTimer = setTimeout(() => { videoModelEggClicks = 0; }, 4000);

      if (videoModelEggClicks >= 10) {
        videoModelEggClicks = 0;
        const sel = elements.videoModel;
        const wrapper = elements.videoModelWrapper;
        if (sel && sel.disabled) {
          sel.disabled = false;
          if (wrapper) wrapper.style.opacity = '1';
        }
        // Add 4K to video resolution select if not already present
        const resSel = elements.videoResolution;
        if (resSel && !Array.from(resSel.options).some(o => o.value === '4k')) {
          const opt = document.createElement('option');
          opt.value = '4k';
          opt.textContent = '4K';
          resSel.appendChild(opt);
        }
        // Add 4K to image resolution select if not already present
        const imgResSel = elements.imageResolution;
        if (imgResSel && !Array.from(imgResSel.options).some(o => o.value === '4k')) {
          const opt = document.createElement('option');
          opt.value = '4k';
          opt.textContent = '4K';
          imgResSel.appendChild(opt);
        }
        await chrome.storage.local.set({ videoModelUnlocked: true });
      }
    });
  }


  // Update pause unit text based on mode
  elements.generationMode.addEventListener('change', () => {
    const isImage = elements.generationMode.value === 'image';
    elements.pauseUnitText.textContent = isImage ? 'imagens' : 'videos';
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
    elements.imageModel,
    elements.videoModel,
    elements.imageResolution,
    elements.videoResolution,
    elements.videoDuration,
    elements.removeCount,
    elements.randomIncludeLandscape43,
    elements.randomIncludeSquare,
    elements.randomIncludePortrait34,
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

  // Image upload handling
  if (elements.dropZone && elements.imageInput) {
    elements.dropZone.addEventListener('click', () => {
      elements.imageInput.click();
    });

    elements.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      elements.dropZone.style.borderColor = 'var(--accent-primary)';
      elements.dropZone.style.backgroundColor = 'var(--bg-tertiary)';
    });

    elements.dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      elements.dropZone.style.borderColor = 'var(--border-color)';
      elements.dropZone.style.backgroundColor = 'transparent';
    });

    elements.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      elements.dropZone.style.borderColor = 'var(--border-color)';
      elements.dropZone.style.backgroundColor = 'transparent';

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    });

    elements.imageInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFiles(e.target.files);
      }
    });

    // Clear images button
    if (elements.clearImagesBtn) {
      elements.clearImagesBtn.addEventListener('click', () => {
        selectedImages = [];
        updateImagePreview();
        saveImagesToStorage();
      });
    }
  }
}

function updateImagePreview() {
  elements.imageCountBadge.style.display = selectedImages.length > 0 ? 'block' : 'none';
  elements.imageCountBadge.textContent = `${selectedImages.length} imagem(ns) selecionada(s)`;

  elements.dropZoneText.style.display = selectedImages.length > 0 ? 'none' : 'block';

  // Toggle active border depending on functionality state or styling requirements
  // elements.dropZone.style.borderColor = selectedImages.length > 0 ? 'var(--success-color)' : 'var(--border-color)';

  elements.clearImagesBtn.style.display = selectedImages.length > 0 ? 'flex' : 'none';

  // Show previews
  elements.imagePreviewContainer.innerHTML = '';

  if (selectedImages.length > 0) {
    elements.imagePreviewContainer.style.display = 'grid';

    selectedImages.forEach((file, index) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const div = document.createElement('div');
        div.className = 'image-preview-item';
        div.style.position = 'relative';
        div.style.aspectRatio = '1';
        div.style.borderRadius = 'var(--radius-sm)';
        div.style.overflow = 'hidden';
        div.style.border = '1px solid var(--border-color)';

        const img = document.createElement('img');
        img.src = e.target.result;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';

        // Remove button
        const removeBtn = document.createElement('div');
        removeBtn.innerHTML = '×';
        removeBtn.style.position = 'absolute';
        removeBtn.style.top = '2px';
        removeBtn.style.right = '2px';
        removeBtn.style.width = '18px';
        removeBtn.style.height = '18px';
        removeBtn.style.background = 'rgba(239, 68, 68, 0.9)'; // Red
        removeBtn.style.color = 'white';
        removeBtn.style.borderRadius = '50%';
        removeBtn.style.display = 'flex';
        removeBtn.style.alignItems = 'center';
        removeBtn.style.justifyContent = 'center';
        removeBtn.style.cursor = 'pointer';
        removeBtn.style.fontSize = '14px';
        removeBtn.style.fontWeight = 'bold';
        removeBtn.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';
        removeBtn.style.zIndex = '10';

        removeBtn.onclick = (ev) => {
          ev.stopPropagation();
          removeImage(index);
        };

        div.appendChild(img);
        div.appendChild(removeBtn);
        elements.imagePreviewContainer.appendChild(div);
      };
      reader.readAsDataURL(file);
    });
  } else {
    elements.imagePreviewContainer.style.display = 'none';
    // Reset file input
    if (elements.imageInput) elements.imageInput.value = '';
  }
}

function removeImage(index) {
  selectedImages.splice(index, 1);
  updateImagePreview();
  saveImagesToStorage();
}

function handleFiles(filesList) {
  const validFiles = Array.from(filesList).filter(file => file.type.startsWith('image/'));

  if (validFiles.length === 0) return;

  // Append new files instead of replacing
  // Append new files instead of replacing
  selectedImages = [...selectedImages, ...validFiles];
  updateImagePreview();
  saveImagesToStorage();
}

// Save current list of files to storage
async function saveImagesToStorage() {
  try {
    // Clear all existing first to avoid orphans
    const allKeys = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(allKeys).filter(k => k.startsWith('flow_img_'));
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }

    // Save current files
    const processed = await Promise.all(selectedImages.map(file => readFileAsDataURL(file)));
    for (let i = 0; i < processed.length; i++) {
      await chrome.storage.local.set({ [`flow_img_${i}`]: processed[i] });
    }
  } catch (e) {
    console.error('Error saving images:', e);
  }
}



// ===== Functions =====
// Remove invisible Unicode characters (zero-width spaces, etc)
function cleanInvisibleChars(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width spaces, joiners, BOM
    .replace(/[\u00A0]/g, ' ') // Non-breaking space to regular space
    .trim();
}

function updatePromptCount() {
  const prompts = elements.prompts.value
    .split('\n')
    .map(p => cleanInvisibleChars(p))
    .filter(p => p.length > 0);
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
    'imageModel',
    'videoModel',
    'imageResolution',
    'videoResolution',
    'generationTimeout',
    'maxRetries',
    'randomizeAspectRatio',
    'randomIncludeLandscape43',
    'randomIncludeSquare',
    'randomIncludePortrait34',
    'randomIncludePortrait',
    'randomIncludeLandscape',
    'scheduledPauseEnabled',
    'pauseEveryN',
    'pauseMinMinutes',
    'pauseMaxMinutes',
    'videoDuration',
    'videoModelUnlocked'
  ]);

  // Load saved images from Chunked Storage
  try {
    // 1. Scan for stored keys
    const allKeys = await chrome.storage.local.get(null);
    const imageKeys = Object.keys(allKeys)
      .filter(k => k.startsWith('flow_img_'))
      .sort((a, b) => {
        // Sort by index
        const idxA = parseInt(a.replace('flow_img_', ''));
        const idxB = parseInt(b.replace('flow_img_', ''));
        return idxA - idxB;
      });

    if (imageKeys.length > 0) {
      // 2. Reconstruct File objects from base64
      const files = [];
      for (const key of imageKeys) {
        const fileData = allKeys[key];
        if (fileData && fileData.data) {
          const blob = await (await fetch(fileData.data)).blob();
          const file = new File([blob], fileData.name, { type: fileData.type });
          files.push(file);
        }
      }
      selectedImages = files;
      updateImagePreview();
    }
  } catch (e) {
    console.error('Error loading saved images:', e);
  }

  if (settings.generationMode) elements.generationMode.value = settings.generationMode;
  if (settings.prompts) elements.prompts.value = settings.prompts;
  if (settings.autoDownload !== undefined) elements.autoDownload.checked = settings.autoDownload;
  if (settings.doUpscale !== undefined) elements.doUpscale.checked = settings.doUpscale;
  if (settings.savePromptTxt !== undefined) elements.savePromptTxt.checked = settings.savePromptTxt;
  if (settings.subfolder) elements.subfolder.value = settings.subfolder;
  if (settings.delaySeconds) elements.delaySeconds.value = settings.delaySeconds;
  if (settings.aspectRatio) elements.aspectRatio.value = settings.aspectRatio;
    // Unlock check: video model + 4K resolution
  if (settings.videoModelUnlocked && elements.videoModel) {
    elements.videoModel.disabled = false;
    if (elements.videoModelWrapper) elements.videoModelWrapper.style.opacity = '1';
    // Add 4K to video resolution if not present
    const resSel = elements.videoResolution;
    if (resSel && !Array.from(resSel.options).some(o => o.value === '4k')) {
      const opt = document.createElement('option');
      opt.value = '4k';
      opt.textContent = '4K';
      resSel.appendChild(opt);
    }
    // Add 4K to image resolution if not present
    const imgResSel = elements.imageResolution;
    if (imgResSel && !Array.from(imgResSel.options).some(o => o.value === '4k')) {
      const opt = document.createElement('option');
      opt.value = '4k';
      opt.textContent = '4K';
      imgResSel.appendChild(opt);
    }
  }

  if (settings.imageModel) elements.imageModel.value = settings.imageModel;
  if (settings.videoModel) elements.videoModel.value = settings.videoModel;
  if (settings.imageResolution) elements.imageResolution.value = settings.imageResolution; 
  if (settings.videoResolution) elements.videoResolution.value = settings.videoResolution;
  if (settings.generationTimeout) elements.generationTimeout.value = settings.generationTimeout;
  if (settings.maxRetries) elements.maxRetries.value = settings.maxRetries;
  if (settings.videoDuration) elements.videoDuration.value = settings.videoDuration;

  // Randomization settings
  if (settings.randomizeAspectRatio !== undefined) {
    elements.randomizeAspectRatio.checked = settings.randomizeAspectRatio;
    elements.randomAspectRatioOptions.style.display = settings.randomizeAspectRatio ? 'block' : 'none';
    elements.aspectRatio.closest('.form-group').style.opacity = settings.randomizeAspectRatio ? '0.5' : '1';
    elements.aspectRatio.disabled = settings.randomizeAspectRatio;
  }
  if (settings.randomIncludeLandscape43 !== undefined) elements.randomIncludeLandscape43.checked = settings.randomIncludeLandscape43;
  if (settings.randomIncludeSquare !== undefined) elements.randomIncludeSquare.checked = settings.randomIncludeSquare;
  if (settings.randomIncludePortrait34 !== undefined) elements.randomIncludePortrait34.checked = settings.randomIncludePortrait34;
  if (settings.randomIncludePortrait !== undefined) elements.randomIncludePortrait.checked = settings.randomIncludePortrait;
  if (settings.randomIncludeLandscape !== undefined) elements.randomIncludeLandscape.checked = settings.randomIncludeLandscape;

  syncAspectRatioOptionsByMode();


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
    imageModel: elements.imageModel.value,
    videoModel: elements.videoModel.value,
    imageResolution: elements.imageResolution.value,
    videoResolution: elements.videoResolution.value,
    generationTimeout: parseInt(elements.generationTimeout.value) || 180,
    maxRetries: parseInt(elements.maxRetries.value) || 2,
    randomizeAspectRatio: elements.randomizeAspectRatio.checked,
    randomIncludeLandscape43: elements.randomIncludeLandscape43.checked,
    randomIncludeSquare: elements.randomIncludeSquare.checked,
    randomIncludePortrait34: elements.randomIncludePortrait34.checked,
    randomIncludePortrait: elements.randomIncludePortrait.checked,
    randomIncludeLandscape: elements.randomIncludeLandscape.checked,
    scheduledPauseEnabled: elements.scheduledPauseEnabled.checked,
    pauseEveryN: parseInt(elements.pauseEveryN.value) || 3,
    pauseMinMinutes: parseInt(elements.pauseMinMinutes.value) || 1,
    pauseMaxMinutes: parseInt(elements.pauseMaxMinutes.value) || 6,
    videoDuration: elements.videoDuration.value
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




// Helper to read file as DataURL and detect aspect ratio
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Detect aspect ratio: 16:9 (video landscape) or 9:16 (video portrait) 
        // Logic: if width >= height -> Landscape (16:9), else -> Portrait (9:16)
        const aspectRatio = img.width >= img.height ? '16:9' : '9:16';

        resolve({
          name: file.name,
          type: file.type,
          data: reader.result,
          aspectRatio: aspectRatio,
          width: img.width,
          height: img.height
        });
      };
      img.onerror = () => {
        // Fallback if image load fails, just resolve with data
        resolve({
          name: file.name,
          type: file.type,
          data: reader.result,
          aspectRatio: '16:9' // Default
        });
      };
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function startAutomation() {
  // Debug: Show raw input
  console.log('[Flow Automator] Raw prompts input:', elements.prompts.value);

  const prompts = elements.prompts.value
    .split('\n')
    .map(p => cleanInvisibleChars(p))
    .filter(p => p.length > 0);

  // Debug: Show filtered prompts
  console.log('[Flow Automator] Filtered prompts:', prompts);
  console.log('[Flow Automator] Total prompts after filter:', prompts.length);

  // Validation: Must have at least one prompt OR one image (if image-to-video mode)
  const isVideoMode = elements.generationMode.value === 'video';
  const hasImages = selectedImages.length > 0;
  const fallbackImagePrompt = 'Animate this image with natural cinematic motion, preserving subject identity and scene details.';
  const effectivePrompts = (isVideoMode && hasImages && prompts.length === 0) ? [fallbackImagePrompt] : prompts;

  if (effectivePrompts.length === 0) {
    alert('Por favor, adicione pelo menos um prompt' + (isVideoMode ? ' ou uma imagem.' : '.'));
    return;
  }

  // If we have images in Video mode, process them
  let processedImages = [];
  if (isVideoMode && hasImages) {
    elements.statusIndicator.querySelector('.status-text').textContent = 'Lendo imagens...';
    try {
      processedImages = await Promise.all(selectedImages.map(file => readFileAsDataURL(file)));
    } catch (e) {
      alert('Erro ao ler imagens: ' + e.message);
      return;
    }
  }

  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.id) {
    alert('Nao foi possivel identificar a aba ativa.');
    return;
  }

  isProcessing = true;
  showProcessingUI();

  // Save current settings
  await saveSettings();

  // Handle Image Storage (Chunked Storage Strategy)
  if (processedImages.length > 0) {
    elements.statusIndicator.querySelector('.status-text').textContent = 'Armazenando dados...';
    try {
      // 1. Clear old image data
      const allKeys = await chrome.storage.local.get(null);
      const keysToRemove = Object.keys(allKeys).filter(k => k.startsWith('flow_img_'));
      if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
      }

      // 2. Save new images individually
      for (let i = 0; i < processedImages.length; i++) {
        await chrome.storage.local.set({ [`flow_img_${i}`]: processedImages[i] });
      }
    } catch (e) {
      alert('Erro ao salvar imagens no storage: ' + e.message);
      hideProcessingUI();
      isProcessing = false;
      return;
    }
  }

  // Send message to background script
  // Note: we do NOT send the images array, just the count
  chrome.runtime.sendMessage({
    type: 'start',
    config: {
      tabId: tab.id,
      prompts: effectivePrompts,
      images: [], // Empty array to avoid message size limit
      imageCount: processedImages.length, // Send count instead
      usingStorageImages: true, // Flag to tell BG to read from storage
      mode: elements.generationMode.value,
      autoDownload: elements.autoDownload.checked,
      doUpscale: elements.doUpscale.checked,
      savePromptTxt: elements.savePromptTxt.checked,
      subfolder: elements.subfolder.value,
      delaySeconds: parseInt(elements.delaySeconds.value) || 5,
      aspectRatio: elements.aspectRatio.value,
      imageModel: elements.imageModel.value,
      videoModel: elements.videoModel.value,
      imageResolution: elements.imageResolution.value,
      videoResolution: elements.videoResolution.value,
      generationTimeout: parseInt(elements.generationTimeout.value) || 180,
      maxRetries: parseInt(elements.maxRetries.value) || 2,
      randomizeAspectRatio: elements.randomizeAspectRatio.checked,
      randomIncludeLandscape43: elements.randomIncludeLandscape43.checked,
      randomIncludeSquare: elements.randomIncludeSquare.checked,
      randomIncludePortrait34: elements.randomIncludePortrait34.checked,
      randomIncludePortrait: elements.randomIncludePortrait.checked,
      randomIncludeLandscape: elements.randomIncludeLandscape.checked,
      scheduledPauseEnabled: elements.scheduledPauseEnabled.checked,
      pauseEveryN: parseInt(elements.pauseEveryN.value) || 3,
      pauseMinMinutes: parseInt(elements.pauseMinMinutes.value) || 1,
      pauseMaxMinutes: parseInt(elements.pauseMaxMinutes.value) || 6,
      videoDuration: elements.videoDuration.value
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
  elements.videoDuration.disabled = disabled;
  if (elements.videoResolution) elements.videoResolution.disabled = disabled;
  if (elements.videoModel) {
    if (disabled) {
      elements.videoModel.disabled = true;
    } else {
      // Quando parar, só reabilita se o usuário tiver debloqueado (opacity do wrapper === '1')
      if (elements.videoModelWrapper && elements.videoModelWrapper.style.opacity === '1') {
        elements.videoModel.disabled = false;
      } else {
        elements.videoModel.disabled = true;
      }
    }
  }
  elements.generationTimeout.disabled = disabled;

  elements.maxRetries.disabled = disabled;
  if (elements.imageInput) elements.imageInput.disabled = disabled;
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

  const message = `Automacao concluida!\n\nOK Sucesso: ${success}\nFAIL Falhas: ${failed}`;
  alert(message);
}

function handleError(error) {
  elements.statusIndicator.classList.add('error');
  elements.statusIndicator.querySelector('.status-text').textContent = 'Erro';

  alert(`Erro: ${error}`);
  hideProcessingUI();
  isProcessing = false;
}

