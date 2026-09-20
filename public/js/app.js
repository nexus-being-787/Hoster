// Hoster Client App Logic

const state = {
  currentPath: '/',
  files: [],
  pin: null,
  viewMode: localStorage.getItem('hoster_view') || 'grid',
  searchQuery: '',
  previewIndex: -1,
  previewFiles: []
};

// DOM Elements
const els = {
  fileGrid: document.getElementById('fileGrid'),
  breadcrumb: document.getElementById('breadcrumb'),
  loader: document.getElementById('loader'),
  emptyState: document.getElementById('emptyState'),
  errorState: document.getElementById('errorState'),
  pinGate: document.getElementById('pinGate'),
  itemCount: document.getElementById('itemCount'),
  
  gridViewBtn: document.getElementById('gridViewBtn'),
  listViewBtn: document.getElementById('listViewBtn'),
  
  searchInput: document.getElementById('searchInput'),
  searchClear: document.getElementById('searchClear'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),
  
  uploadZone: document.getElementById('uploadZone'),
  dropZone: document.getElementById('dropZone'),
  fileInput: document.getElementById('fileInput'),
  uploadProgress: document.getElementById('uploadProgress'),
  progressFill: document.getElementById('progressFill'),
  uploadStatus: document.getElementById('uploadStatus'),
  
  pinInputs: Array.from(document.querySelectorAll('.pin-digit')),
  pinSubmit: document.getElementById('pinSubmit'),
  pinError: document.getElementById('pinError'),
  
  previewOverlay: document.getElementById('previewOverlay'),
  previewClose: document.getElementById('previewClose'),
  previewPrev: document.getElementById('previewPrev'),
  previewNext: document.getElementById('previewNext'),
  previewContent: document.getElementById('previewContent'),
  previewFilename: document.getElementById('previewFilename'),
  previewDownload: document.getElementById('previewDownload')
};

// ─────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────

function init() {
  setupEventListeners();
  applyViewMode(state.viewMode);
  checkServerStatus().then(online => {
    if (online) loadFiles(state.currentPath);
  });
}

function setupEventListeners() {
  els.gridViewBtn.addEventListener('click', () => applyViewMode('grid'));
  els.listViewBtn.addEventListener('click', () => applyViewMode('list'));
  
  els.searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase();
    els.searchClear.classList.toggle('hidden', !state.searchQuery);
    renderFiles();
  });
  
  els.searchClear.addEventListener('click', () => {
    els.searchInput.value = '';
    state.searchQuery = '';
    els.searchClear.classList.add('hidden');
    renderFiles();
  });
  
  els.downloadAllBtn.addEventListener('click', () => {
    const url = `/files/zip?path=${encodeURIComponent(state.currentPath)}` + (state.pin ? `&pin=${state.pin}` : '');
    window.location.href = url;
  });
  
  document.getElementById('retryBtn').addEventListener('click', () => {
    els.errorState.classList.add('hidden');
    loadFiles(state.currentPath);
  });

  // PIN Input
  els.pinInputs.forEach((input, idx) => {
    input.addEventListener('input', (e) => {
      if (e.target.value && idx < 3) els.pinInputs[idx + 1].focus();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && idx > 0) {
        els.pinInputs[idx - 1].focus();
      } else if (e.key === 'Enter') {
        submitPin();
      }
    });
  });
  els.pinSubmit.addEventListener('click', submitPin);
  
  // Preview
  els.previewClose.addEventListener('click', closePreview);
  els.previewPrev.addEventListener('click', () => navigatePreview(-1));
  els.previewNext.addEventListener('click', () => navigatePreview(1));
  document.addEventListener('keydown', (e) => {
    if (els.previewOverlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') closePreview();
    if (e.key === 'ArrowLeft') navigatePreview(-1);
    if (e.key === 'ArrowRight') navigatePreview(1);
  });
  
  setupUpload();
}

// ─────────────────────────────────────────────
// API & Data Loading
// ─────────────────────────────────────────────

async function checkServerStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data.uploadEnabled) els.uploadZone.classList.remove('hidden');
    return data.running;
  } catch (err) {
    showError('Server is currently offline or unreachable.');
    return false;
  }
}

async function loadFiles(path) {
  showLoader(true);
  hideAllStates();
  
  try {
    const headers = {};
    if (state.pin) headers['x-hoster-pin'] = state.pin;
    
    const res = await fetch(`/files/list?path=${encodeURIComponent(path)}`, { headers });
    
    if (res.status === 401) {
      showLoader(false);
      els.pinGate.classList.remove('hidden');
      els.pinInputs[0].focus();
      return;
    }
    
    if (!res.ok) throw new Error(await res.text());
    
    const data = await res.json();
    state.currentPath = data.path;
    state.files = data.items;
    
    renderBreadcrumb();
    renderFiles();
    showLoader(false);
    
  } catch (err) {
    showLoader(false);
    showError('Failed to load files. The directory might not exist.');
  }
}

// ─────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────

function renderFiles() {
  els.fileGrid.innerHTML = '';
  
  let filtered = state.files;
  if (state.searchQuery) {
    filtered = state.files.filter(f => f.name.toLowerCase().includes(state.searchQuery));
  }
  
  els.itemCount.textContent = `${filtered.length} item${filtered.length !== 1 ? 's' : ''}`;
  
  if (filtered.length === 0) {
    els.emptyState.classList.remove('hidden');
    return;
  } else {
    els.emptyState.classList.add('hidden');
  }
  
  // Extract previewable files (images, videos, audio) for carousel
  state.previewFiles = filtered.filter(f => f.type === 'file' && isPreviewable(f.mimeType));
  
  filtered.forEach(file => {
    const item = document.createElement('div');
    item.className = `file-item ${file.type} ${getFileCategory(file.mimeType)}`;
    
    const icon = getFileIcon(file);
    const sizeStr = file.type === 'dir' ? '' : formatBytes(file.size);
    const dateStr = file.mtime ? new Date(file.mtime).toLocaleDateString() : '';
    
    item.innerHTML = `
      <div class="file-icon">${icon}</div>
      <div class="file-details">
        <div class="file-name" title="${file.name}">${file.name}</div>
        <div class="file-meta">
          <span>${sizeStr}</span>
          ${sizeStr && dateStr ? '<span>•</span>' : ''}
          <span>${dateStr}</span>
        </div>
      </div>
      <div class="file-actions">
        ${file.type === 'dir' ? 
          `<button class="action-btn" title="Download ZIP" data-action="zip">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
           </button>` : 
          `<button class="action-btn" title="Download" data-action="download">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
           </button>`
        }
      </div>
    `;
    
    item.addEventListener('click', (e) => {
      // Handle action buttons
      const actionBtn = e.target.closest('.action-btn');
      if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.dataset.action;
        if (action === 'download') triggerDownload(file.path, false);
        if (action === 'zip') triggerDownload(file.path, true);
        return;
      }
      
      // Default item click
      if (file.type === 'dir') {
        loadFiles(file.path);
      } else {
        if (isPreviewable(file.mimeType)) {
          openPreview(file);
        } else {
          triggerDownload(file.path, false);
        }
      }
    });
    
    els.fileGrid.appendChild(item);
  });
}

function renderBreadcrumb() {
  const parts = state.currentPath.split('/').filter(p => p);
  els.breadcrumb.innerHTML = '';
  
  // Home
  const home = document.createElement('button');
  home.className = 'crumb crumb-home';
  home.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg> Home`;
  home.addEventListener('click', () => loadFiles('/'));
  els.breadcrumb.appendChild(home);
  
  let buildPath = '';
  parts.forEach((part, idx) => {
    buildPath += '/' + part;
    const currentPath = buildPath;
    
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    els.breadcrumb.appendChild(sep);
    
    const btn = document.createElement('button');
    btn.className = 'crumb';
    btn.textContent = part;
    btn.addEventListener('click', () => loadFiles(currentPath));
    els.breadcrumb.appendChild(btn);
  });
}

function applyViewMode(mode) {
  state.viewMode = mode;
  localStorage.setItem('hoster_view', mode);
  
  if (mode === 'grid') {
    els.fileGrid.classList.remove('list-view');
    els.gridViewBtn.classList.add('active');
    els.listViewBtn.classList.remove('active');
  } else {
    els.fileGrid.classList.add('list-view');
    els.listViewBtn.classList.add('active');
    els.gridViewBtn.classList.remove('active');
  }
}

// ─────────────────────────────────────────────
// PIN logic
// ─────────────────────────────────────────────

function submitPin() {
  const pin = els.pinInputs.map(i => i.value).join('');
  if (pin.length !== 4) return;
  
  state.pin = pin;
  els.pinError.classList.add('hidden');
  els.pinGate.classList.add('hidden');
  
  // Re-attempt loading with PIN
  loadFiles(state.currentPath).catch(() => {
    els.pinGate.classList.remove('hidden');
    els.pinError.classList.remove('hidden');
    els.pinInputs.forEach(i => i.value = '');
    els.pinInputs[0].focus();
    state.pin = null;
  });
}

// ─────────────────────────────────────────────
// Upload Logic
// ─────────────────────────────────────────────

function setupUpload() {
  els.fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) uploadFiles(e.target.files);
  });
  
  els.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropZone.classList.add('dragover');
  });
  els.dropZone.addEventListener('dragleave', () => {
    els.dropZone.classList.remove('dragover');
  });
  els.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
  });
}

function uploadFiles(fileList) {
  const formData = new FormData();
  for (let i = 0; i < fileList.length; i++) {
    formData.append('files', fileList[i]);
  }
  
  els.uploadProgress.classList.remove('hidden');
  els.progressFill.style.width = '0%';
  els.uploadStatus.textContent = `Uploading ${fileList.length} item(s)...`;
  
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/upload?path=${encodeURIComponent(state.currentPath)}`);
  if (state.pin) xhr.setRequestHeader('x-hoster-pin', state.pin);
  
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const percentComplete = (e.loaded / e.total) * 100;
      els.progressFill.style.width = percentComplete + '%';
    }
  };
  
  xhr.onload = () => {
    setTimeout(() => {
      els.uploadProgress.classList.add('hidden');
      els.fileInput.value = '';
      if (xhr.status === 200) {
        loadFiles(state.currentPath); // Refresh
      } else {
        alert('Upload failed: ' + xhr.responseText);
      }
    }, 500);
  };
  
  xhr.onerror = () => {
    els.uploadProgress.classList.add('hidden');
    alert('Upload failed due to network error.');
  };
  
  xhr.send(formData);
}

// ─────────────────────────────────────────────
// Preview Logic
// ─────────────────────────────────────────────

function openPreview(file) {
  state.previewIndex = state.previewFiles.findIndex(f => f.path === file.path);
  if (state.previewIndex === -1) {
    state.previewFiles = [file];
    state.previewIndex = 0;
  }
  
  renderPreview();
  els.previewOverlay.classList.remove('hidden');
}

function closePreview() {
  els.previewOverlay.classList.add('hidden');
  els.previewContent.innerHTML = ''; // Stop media playback
}

function navigatePreview(dir) {
  if (state.previewFiles.length <= 1) return;
  state.previewIndex += dir;
  if (state.previewIndex >= state.previewFiles.length) state.previewIndex = 0;
  if (state.previewIndex < 0) state.previewIndex = state.previewFiles.length - 1;
  renderPreview();
}

function renderPreview() {
  const file = state.previewFiles[state.previewIndex];
  if (!file) return;
  
  els.previewContent.innerHTML = '<div class="spinner"></div>';
  els.previewFilename.textContent = file.name;
  
  const streamUrl = `/files/stream?path=${encodeURIComponent(file.path)}${state.pin ? '&pin=' + state.pin : ''}`;
  const downloadUrl = `/files/download?path=${encodeURIComponent(file.path)}${state.pin ? '&pin=' + state.pin : ''}`;
  
  els.previewDownload.href = downloadUrl;
  
  if (file.mimeType.startsWith('image/')) {
    const img = new Image();
    img.src = streamUrl;
    img.onload = () => { els.previewContent.innerHTML = ''; els.previewContent.appendChild(img); };
    img.onerror = () => { els.previewContent.innerHTML = '<div class="error-title">Failed to load image</div>'; };
  } else if (file.mimeType.startsWith('video/')) {
    els.previewContent.innerHTML = `<video controls autoplay name="media"><source src="${streamUrl}" type="${file.mimeType}"></video>`;
  } else if (file.mimeType.startsWith('audio/')) {
    els.previewContent.innerHTML = `<audio controls autoplay name="media"><source src="${streamUrl}" type="${file.mimeType}"></audio>`;
  }
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function triggerDownload(path, isZip) {
  const endpoint = isZip ? '/files/zip' : '/files/download';
  const url = `${endpoint}?path=${encodeURIComponent(path)}${state.pin ? '&pin=' + state.pin : ''}`;
  
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function showLoader(show) {
  els.loader.classList.toggle('hidden', !show);
  if (show) els.fileGrid.innerHTML = '';
}

function hideAllStates() {
  els.emptyState.classList.add('hidden');
  els.errorState.classList.add('hidden');
  els.pinGate.classList.add('hidden');
}

function showError(msg) {
  hideAllStates();
  els.fileGrid.innerHTML = '';
  document.getElementById('errorMsg').textContent = msg;
  els.errorState.classList.remove('hidden');
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function isPreviewable(mime) {
  if (!mime) return false;
  return mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/');
}

function getFileCategory(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function getFileIcon(file) {
  if (file.type === 'dir') {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
  }
  if (file.mimeType && file.mimeType.startsWith('image/')) {
    // Attempt thumbnail if small enough, else just icon
    if (file.size < 5000000) { // < 5MB
      const url = `/files/stream?path=${encodeURIComponent(file.path)}${state.pin ? '&pin=' + state.pin : ''}`;
      return `<img src="${url}" loading="lazy" />`;
    }
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  }
  if (file.mimeType && file.mimeType.startsWith('video/')) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
  }
  if (file.mimeType && file.mimeType.startsWith('audio/')) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  }
  if (file.name.endsWith('.zip') || file.name.endsWith('.tar') || file.name.endsWith('.gz')) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M12 4v16"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h8"/></svg>`;
  }
  // Generic file
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
}

// Start app
init();
