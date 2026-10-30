/* ══ Hoster Host UI — JavaScript Controller ══ */

const API = '';
let ws = null;
let serverRunning = false;
let uptimeInterval = null;
let startedAt = null;
let bytesServed = 0;

// ── DOM Refs ──────────────────────────────────
const $ = id => document.getElementById(id);
const ipText      = $('ipText');
const ipDot       = document.querySelector('.ip-dot');
const serverToggle= $('serverToggle');
const serverBtnText=$('serverBtnText');
const statusDot   = $('statusDot');
const statusText  = $('statusText');
const dirPathInput= $('dirPath');
const portInput   = $('portInput');
const domainInput = $('domainInput');
const httpsToggle = $('httpsToggle');
const uploadToggle= $('uploadToggle');
const webdavToggle= $('webdavToggle');
const hostnameToggle = $('hostnameToggle');
const dirPreview  = $('dirPreview');
const shareUrl    = $('shareUrl');
const urlCard     = $('urlCard');
const copyBtn     = $('copyBtn');
const qrBtn       = $('qrBtn');
const webdavUrlContainer = $('webdavUrlContainer');
const webdavUrl   = $('webdavUrl');
const copyWebdavBtn = $('copyWebdavBtn');
const qrModal     = $('qrModal');
const qrImage     = $('qrImage');
const qrClose     = $('qrClose');
const modalUrl    = $('modalUrl');
const statClients = $('statClients');
const statSpeed   = $('statSpeed');
const statBytes   = $('statBytes');
const statUptime  = $('statUptime');
const uploadsCard = $('uploadsCard');
const uploadsList = $('uploadsList');
const uploadCountBadge = $('uploadCountBadge');
const logStream   = $('logStream');
const clearLogsBtn= $('clearLogsBtn');
const settingsBtn = $('settingsBtn');
const settingsModal=$('settingsModal');
const browseBtn   = $('browseBtn');
const folderModal = $('folderModal');
const folderClose = $('folderClose');
const folderUpBtn = $('folderUpBtn');
const folderCurrentPath = $('folderCurrentPath');
const folderList  = $('folderList');
const shortcutsRow= $('shortcutsRow');
const selectFolderBtn = $('selectFolderBtn');

// ── Helpers ───────────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(startISO) {
  if (!startISO) return '--:--';
  const elapsed = Math.floor((Date.now() - new Date(startISO).getTime()) / 1000);
  const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = elapsed % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function setServerState(running, url, webdavEnabled, localHostname, localUrl) {
  serverRunning = running;
  $('radioCard').classList.toggle('hidden', !running);
  if (running) refreshRadio();

  statusDot.className = 'status-dot ' + (running ? 'on' : 'off');
  statusText.textContent = running ? 'Running' : 'Stopped';

  serverToggle.className = 'server-btn ' + (running ? 'on' : 'off');
  serverBtnText.textContent = running ? 'Stop Server' : 'Start Server';

  const icon = serverToggle.querySelector('.server-btn-icon svg');
  if (running) {
    icon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2"/>';
  } else {
    icon.innerHTML = '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>';
  }

  if (running && url) {
    // Primary display: always the IP-based URL (or custom .local if set by user)
    shareUrl.textContent = url;
    shareUrl.title = url;

    // Show .local as a secondary tip only when a custom domain is set
    let ipHint = document.getElementById('__ipHint');
    if (!ipHint) {
      ipHint = document.createElement('div');
      ipHint.id = '__ipHint';
      ipHint.style.cssText = 'font-size:0.72rem;color:rgba(240,240,255,0.4);margin-top:4px;font-family:monospace;';
      shareUrl.parentNode.insertBefore(ipHint, shareUrl.nextSibling);
    }
    // Primary is the stable .local URL; show the raw IP as a backup (it changes with DHCP)
    const backupHint = localUrl && url !== localUrl ? `Backup (IP, may change): ${localUrl}` : '';
    ipHint.textContent = backupHint;

    if (webdavEnabled) {
      webdavUrlContainer.classList.remove('hidden');
      webdavUrl.textContent = url + '/webdav';
    } else {
      webdavUrlContainer.classList.add('hidden');
    }
    urlCard.classList.add('active');
  } else {
    urlCard.classList.remove('active');
    const ipHint = document.getElementById('__ipHint');
    if (ipHint) ipHint.textContent = '';
  }
}

function addLog(log) {
  const empty = logStream.querySelector('.log-empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'log-entry';

  const statusClass = log.status >= 500 ? 'err' : log.status >= 400 ? 'warn' : 'ok';

  el.innerHTML = `
    <span class="log-time">${formatTime(log.time)}</span>
    <span class="log-method ${log.method}">${log.method}</span>
    <span class="log-path" title="${log.path}">${log.path}</span>
    <span class="log-status ${statusClass}">${log.status}</span>
    <span class="log-ip">${log.ip?.replace('::ffff:','') || ''}</span>
  `;
  logStream.insertBefore(el, logStream.firstChild);
  // Keep max 100 entries in DOM
  while (logStream.children.length > 100) logStream.lastChild.remove();
}

// ── Init: Fetch Status ─────────────────────────
async function init() {
  try {
    const res = await fetch(`${API}/api/status`);
    const data = await res.json();

    ipText.textContent = data.localIP || '—';
    ipDot.classList.add('online');

    httpsToggle.checked = !!data.useHttps;
    uploadToggle.checked = !!data.uploadEnabled;
    hostnameToggle.checked = data.preferHostname !== false;
    webdavToggle.checked = !!data.webdavEnabled;

    if (data.running) {
      startedAt = data.startedAt;
      bytesServed = data.bytesServed || 0;
      const protocol = data.useHttps ? 'https' : 'http';
      const localUrl = `${protocol}://${data.localIP}:${data.port}`;
      // Show IP as primary; .local only when custom domain was set (url !== localUrl)
      const url = data.url || localUrl;
      setServerState(true, url, data.webdavEnabled, data.localHostname, localUrl);
      dirPathInput.value = data.sharedDir || '';
      portInput.value = data.port || 8080;
      startUptimeTicker();
      showPreview(data.sharedDir);
    } else {
      // Not sharing: refill the form from remembered settings (or sensible defaults)
      const dir = data.sharedDir || '/storage/emulated/0/Download';
      if (!dirPathInput.value) { dirPathInput.value = dir; showPreview(dir); }
      if (data.port) portInput.value = data.port;
      if (data.customDomain) domainInput.value = data.customDomain;
    }

    // PIN settings are remembered too
    pinToggle.checked = !!data.pinEnabled;
    pinGroup.classList.toggle('hidden', !pinToggle.checked);
    if (data.pin) pinInput.value = data.pin;

    statClients.textContent = data.clients || '0';
    statBytes.textContent = formatBytes(data.bytesServed || 0);

    // Restore logs
    if (data.logs && data.logs.length) {
      data.logs.slice().reverse().forEach(addLog);
    }
  } catch(e) {
    ipText.textContent = 'Offline';
  }
}

// ── WebSocket ─────────────────────────────────
function connectWS() {
  const wsUrl = location.href.replace(/^http/, 'ws').replace(/\/host.*/, '');
  ws = new WebSocket(wsUrl);

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'devices':
        if (window.renderDevices) window.renderDevices(msg.data);
        break;
      case 'init':
        ipText.textContent = msg.data.localIP || '—';
        ipDot.classList.add('online');
        break;
      case 'status':
        if (msg.data.running !== undefined) {
          if (msg.data.running) {
            startedAt = new Date().toISOString();
            startUptimeTicker();
            const url = msg.data.url || `http://${msg.data.localIP}:${msg.data.port}`;
            const localUrl = msg.data.localUrl || `http://${msg.data.localIP}:${msg.data.port}`;
            setServerState(true, url, msg.data.webdavEnabled !== undefined ? msg.data.webdavEnabled : webdavToggle.checked, msg.data.localHostname, localUrl);
          } else {
            stopUptimeTicker();
            setServerState(false);
            startedAt = null;
          }
        }
        break;
      case 'clients':
        statClients.textContent = msg.data.count || '0';
        break;
      case 'log':
        addLog(msg.data);
        break;
      case 'upload':
        showToast(`↑ ${msg.data.files.length} file(s) uploaded!`);
        uploadsCard.classList.remove('hidden');
        const empty = uploadsList.querySelector('.log-empty');
        if (empty) empty.remove();
        
        (msg.data.files || []).forEach(f => {
          uploadedFilesCount++;
          uploadCountBadge.textContent = `${uploadedFilesCount} file(s)`;
          const item = document.createElement('div');
          item.className = 'upload-item';
          item.innerHTML = `
            <span class="upload-item-name">📄 ${f.originalname || f.filename || 'File'}</span>
            <span class="upload-item-time">${new Date().toLocaleTimeString()}</span>
          `;
          uploadsList.insertBefore(item, uploadsList.firstChild);
        });
        break;
    }
  };

  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => ws.close();
}

let lastBytes = 0;
let lastSpeedTime = Date.now();
let uploadedFilesCount = 0;

function startUptimeTicker() {
  stopUptimeTicker();
  lastBytes = bytesServed;
  lastSpeedTime = Date.now();

  uptimeInterval = setInterval(() => {
    statUptime.textContent = formatUptime(startedAt);
    
    fetch(`${API}/api/status`).then(r => r.json()).then(d => {
      const currentBytes = d.bytesServed || 0;
      const now = Date.now();
      const timeDiff = (now - lastSpeedTime) / 1000;
      
      if (timeDiff > 0) {
        const speed = Math.max(0, (currentBytes - lastBytes) / timeDiff);
        statSpeed.textContent = formatBytes(speed) + '/s';
      }
      
      lastBytes = currentBytes;
      lastSpeedTime = now;
      statBytes.textContent = formatBytes(currentBytes);
    }).catch(() => {});
  }, 1000);
}

function stopUptimeTicker() {
  if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null; }
  statUptime.textContent = '--:--';
  statBytes.textContent = '0 B';
  statSpeed.textContent = '0 B/s';
}

// ── Server Toggle ─────────────────────────────
serverToggle.addEventListener('click', async () => {
  if (!serverRunning) {
    const dir = dirPathInput.value.trim();
    if (!dir) { shake(dirPathInput); return; }

    serverToggle.disabled = true;
    try {
      const res = await fetch(`${API}/api/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dir,
          port: parseInt(portInput.value) || 8080,
          customDomain: domainInput.value.trim(),
          useHttps: httpsToggle.checked,
          pinEnabled: pinToggle.checked,
          pin: pinInput.value,
          uploadEnabled: uploadToggle.checked,
          webdavEnabled: webdavToggle.checked,
          preferHostname: hostnameToggle.checked,
        })
      });
      const data = await res.json();
      if (res.ok) {
        startedAt = new Date().toISOString();
        setServerState(true, data.url, webdavToggle.checked);
        startUptimeTicker();
        showPreview(dir);
      } else {
        showToast(data.error || 'Failed to start', 'error');
      }
    } catch(e) {
      showToast('Connection error', 'error');
    } finally {
      serverToggle.disabled = false;
    }
  } else {
    serverToggle.disabled = true;
    try {
      await fetch(`${API}/api/stop`, { method: 'POST' });
      stopUptimeTicker();
      setServerState(false);
    } finally {
      serverToggle.disabled = false;
    }
  }
});

// ── Dir Input Preview ─────────────────────────
dirPathInput.addEventListener('change', () => showPreview(dirPathInput.value.trim()));
dirPathInput.addEventListener('input', () => showPreview(dirPathInput.value.trim()));
dirPathInput.addEventListener('keydown', e => e.key === 'Enter' && showPreview(dirPathInput.value.trim()));

async function showPreview(dir) {
  if (!dir) { dirPreview.classList.add('hidden'); return; }
  try {
    const res = await fetch(`${API}/api/check-dir?path=${encodeURIComponent(dir)}`);
    const data = await res.json();
    if (data.exists && data.isDirectory) {
      dirPreview.textContent = `📂 ${data.total} item(s) found in directory`;
      dirPreview.className = 'dir-preview has-items';
      if (data.path !== dir && data.path) dirPathInput.value = data.path;
    } else {
      dirPreview.textContent = `⚠️ ${data.error || 'Invalid directory path'}`;
      dirPreview.className = 'dir-preview';
    }
  } catch(e) {
    dirPreview.textContent = dir;
    dirPreview.className = 'dir-preview';
  }
}

// ── Folder Picker Modal ───────────────────────
let pickerCurrentPath = '/storage/emulated/0';

browseBtn.addEventListener('click', () => {
  folderModal.classList.remove('hidden');
  const startPath = dirPathInput.value.trim() || '/storage/emulated/0';
  loadFolder(startPath);
});

folderClose.addEventListener('click', () => folderModal.classList.add('hidden'));
folderModal.addEventListener('click', e => { if (e.target === folderModal) folderModal.classList.add('hidden'); });

folderUpBtn.addEventListener('click', () => {
  if (folderUpBtn.dataset.parent) {
    loadFolder(folderUpBtn.dataset.parent);
  }
});

selectFolderBtn.addEventListener('click', () => {
  dirPathInput.value = pickerCurrentPath;
  showPreview(pickerCurrentPath);
  folderModal.classList.add('hidden');
  showToast('Folder selected!');
});

async function loadFolder(targetPath) {
  folderList.innerHTML = '<div class="log-empty">Loading folders...</div>';
  try {
    const res = await fetch(`${API}/api/filesystem?path=${encodeURIComponent(targetPath)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to list folders');

    pickerCurrentPath = data.currentPath;
    folderCurrentPath.textContent = data.currentPath;

    if (data.parentPath) {
      folderUpBtn.disabled = false;
      folderUpBtn.dataset.parent = data.parentPath;
      folderUpBtn.style.opacity = '1';
    } else {
      folderUpBtn.disabled = true;
      folderUpBtn.dataset.parent = '';
      folderUpBtn.style.opacity = '0.4';
    }

    shortcutsRow.innerHTML = '';
    (data.commonPaths || []).forEach(cp => {
      const chip = document.createElement('button');
      chip.className = 'shortcut-chip' + (cp.path === data.currentPath ? ' active' : '');
      chip.textContent = cp.name;
      chip.addEventListener('click', () => loadFolder(cp.path));
      shortcutsRow.appendChild(chip);
    });

    folderList.innerHTML = '';
    if (!data.dirs || data.dirs.length === 0) {
      folderList.innerHTML = '<div class="log-empty">No subfolders here. Tap "Select This Folder" to choose it.</div>';
      return;
    }

    data.dirs.forEach(d => {
      const item = document.createElement('div');
      item.className = 'folder-item';
      item.innerHTML = `<span class="folder-icon">📁</span> <span class="folder-name">${d.name}</span>`;
      item.addEventListener('click', () => loadFolder(d.path));
      folderList.appendChild(item);
    });
  } catch(e) {
    folderList.innerHTML = `<div class="log-empty" style="color:#ef4444">Error: ${e.message}</div>`;
  }
}

// ── QR Code ───────────────────────────────────
qrBtn.addEventListener('click', async () => {
  try {
    const res = await fetch(`${API}/api/qrcode`);
    const data = await res.json();
    qrImage.src = data.qrcode;
    modalUrl.textContent = data.url;
    qrModal.classList.remove('hidden');
  } catch(e) { showToast('Could not generate QR code', 'error'); }
});
qrClose.addEventListener('click', () => qrModal.classList.add('hidden'));
qrModal.addEventListener('click', e => { if (e.target === qrModal) qrModal.classList.add('hidden'); });

// ── Copy URL ──────────────────────────────────
copyBtn.addEventListener('click', () => {
  const txt = shareUrl.textContent;
  if (!txt || txt === '—') return;
  navigator.clipboard.writeText(txt).then(() => showToast('URL copied!')).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = txt; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
    ta.remove(); showToast('URL copied!');
  });
});

copyWebdavBtn.addEventListener('click', () => {
  const txt = webdavUrl.textContent;
  if (!txt || txt === '—') return;
  navigator.clipboard.writeText(txt).then(() => showToast('WebDAV URL copied!')).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = txt; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
    ta.remove(); showToast('WebDAV URL copied!');
  });
});

// ── Settings ──────────────────────────────────
settingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
settingsClose.addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

// Switching the main address applies immediately while sharing (URL card + QR refresh via WebSocket)
hostnameToggle.addEventListener('change', async () => {
  if (!serverRunning) return; // applied on next Start
  try {
    await fetch(`${API}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferHostname: hostnameToggle.checked })
    });
    showToast(hostnameToggle.checked ? 'Main address: hoster.local' : 'Main address: IP');
  } catch (e) { showToast('Failed to change address', 'error'); }
});

pinToggle.addEventListener('change', () => {
  pinGroup.classList.toggle('hidden', !pinToggle.checked);
});

genPinBtn.addEventListener('click', () => {
  pinInput.value = String(Math.floor(1000 + Math.random() * 9000));
});

saveSettingsBtn.addEventListener('click', async () => {
  try {
    await fetch(`${API}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pinEnabled: pinToggle.checked,
        pin: pinInput.value,
        uploadEnabled: uploadToggle.checked,
        webdavEnabled: webdavToggle.checked,
      })
    });
    settingsModal.classList.add('hidden');
    showToast('Settings saved!');
  } catch(e) { showToast('Failed to save', 'error'); }
});

// ── Logs ──────────────────────────────────────
clearLogsBtn.addEventListener('click', () => {
  logStream.innerHTML = '<div class="log-empty">Log cleared.</div>';
});

// ── Toast ─────────────────────────────────────
function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  t.style.cssText = `
    position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
    background:${type==='error'? '#ef444440':'rgba(0,229,255,0.15)'};
    color:${type==='error'? '#ef4444':'#00e5ff'};
    border:1px solid ${type==='error'? 'rgba(239,68,68,0.4)':'rgba(0,229,255,0.4)'};
    border-radius:100px;padding:10px 22px;font-size:0.85rem;font-weight:600;
    z-index:9999;backdrop-filter:blur(10px);white-space:nowrap;
    animation:fadeIn 0.3s ease;font-family:'Outfit',sans-serif;
  `;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function shake(el) {
  el.style.animation = 'none'; el.offsetHeight;
  el.style.animation = 'shake 0.4s ease';
  el.style.borderColor = '#ef4444';
  setTimeout(() => { el.style.animation = ''; el.style.borderColor = ''; }, 600);
}

// Inject shake keyframe
const style = document.createElement('style');
style.textContent = `@keyframes shake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-6px)} 40%,80%{transform:translateX(6px)} }`;
document.head.appendChild(style);

// ── Boot ──────────────────────────────────────
init();
connectWS();
if (window.renderDevices) window.renderDevices();

// ── Devices & Blocking ────────────────────────
const devicesList = document.getElementById('devicesList');

window.renderDevices = function(devices) {
  // We need to fetch the blocklist to know which ones are blocked, but the WS broadcast only sends `devices`.
  // To avoid complexity, we can fetch from /api/devices directly to get both active and blocked.
  fetch('/api/devices').then(res => res.json()).then(data => {
    const active = data.devices;
    const blocked = new Set(data.blocked);
    
    if (active.length === 0 && blocked.size === 0) {
      devicesList.innerHTML = '<div class="log-empty">No devices tracked.</div>';
      return;
    }
    
    let html = '';
    
    // Render Active Devices
    active.forEach(d => {
      const time = new Date(d.lastSeen).toLocaleTimeString();
      html += `
        <div class="device-item">
          <div class="device-info">
            <span class="device-ip">${d.ip}</span>
            <span class="device-ua">${d.ua}</span>
            <span class="device-time">Last seen: ${time}</span>
          </div>
          <button class="btn btn-block" onclick="blockDevice('${d.ip}')">Block</button>
        </div>
      `;
    });
    
    // Render Blocked Devices
    blocked.forEach(ip => {
      html += `
        <div class="device-item" style="opacity:0.6; border-color: rgba(255, 59, 48, 0.4);">
          <div class="device-info">
            <span class="device-ip" style="color: #ff3b30;">${ip} (BLOCKED)</span>
            <span class="device-ua">Connection Dropped</span>
          </div>
          <button class="btn btn-unblock" onclick="unblockDevice('${ip}')">Unblock</button>
        </div>
      `;
    });
    
    devicesList.innerHTML = html;
  }).catch(e => console.error(e));
};

window.blockDevice = function(ip) {
  fetch('/api/devices/block', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip })
  }).then(res => res.json()).then(data => {
    if(data.success) {
      showToast('Device blocked', 'success');
      // Trigger a re-render by fetching devices again
      window.renderDevices([]);
    }
  });
};

window.unblockDevice = function(ip) {
  fetch('/api/devices/unblock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip })
  }).then(res => res.json()).then(data => {
    if(data.success) {
      showToast('Device unblocked', 'success');
      window.renderDevices([]);
    }
  });
};

// ─────────────────────────────────────────────
// Hoster Radio (owner controls). Titles come from file names/ID3 tags: textContent only, never innerHTML.
// ─────────────────────────────────────────────
const hRadio = {
  live: $('hRadioLive'), track: $('hRadioTrack'), meta: $('hRadioMeta'), queue: $('hRadioQueue'),
  play: $('hRadioPlay'), shuffle: $('hRadioShuffle'), repeat: $('hRadioRepeat'), guests: $('hRadioGuests'),
};
let radioState = null;

function fmtMs(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function renderRadio(s) {
  if (!s || !Array.isArray(s.queue)) return;
  radioState = s;
  const playing = s.status === 'playing';
  hRadio.live.classList.toggle('hidden', !playing);
  hRadio.track.textContent = s.track ? s.track.title : 'Nothing playing';
  hRadio.meta.textContent = s.track
    ? `${playing ? 'Playing' : 'Paused'} · ${fmtMs(s.positionMs)}${s.track.durationMs ? ' / ' + fmtMs(s.track.durationMs) : ''} · ${s.queue.length} in queue`
    : 'Queue a folder to start the station. Anyone on your Wi-Fi can tune in from the portal.';
  hRadio.play.textContent = playing ? '\u23F8' : '\u25B6';
  hRadio.shuffle.classList.toggle('on', !!s.shuffle);
  hRadio.repeat.classList.toggle('on', s.repeat !== 'off');
  hRadio.repeat.title = 'Repeat: ' + s.repeat;
  hRadio.guests.checked = !!s.allowGuestAdd;

  while (hRadio.queue.firstChild) hRadio.queue.removeChild(hRadio.queue.firstChild);
  if (!s.queue.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'The queue is empty';
    hRadio.queue.appendChild(li);
  }
  s.queue.forEach((q, i) => {
    const li = document.createElement('li');
    li.className = i === s.index ? 'current' : '';
    li.addEventListener('click', () => radioCall('/play', { id: q.id }));
    const name = document.createElement('span'); name.className = 'name'; name.textContent = q.title;
    const dur = document.createElement('span'); dur.className = 'dur'; dur.textContent = q.durationMs ? fmtMs(q.durationMs) : '';
    const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '\u00d7'; rm.title = 'Remove';
    rm.addEventListener('click', e => { e.stopPropagation(); radioCall('/remove', { id: q.id }); });
    li.appendChild(name); li.appendChild(dur); li.appendChild(rm);
    hRadio.queue.appendChild(li);
  });
}

async function refreshRadio() {
  try {
    const r = await fetch(`${API}/api/radio`);
    if (r.ok) renderRadio(await r.json());
  } catch (e) { /* server restarting */ }
}

async function radioCall(path, body) {
  try {
    const r = await fetch(`${API}/api/radio${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(j.error || 'Radio error', 'error'); return null; }
    renderRadio(j.state);
    return j;
  } catch (e) { showToast('Radio error', 'error'); return null; }
}

$('hRadioPrev').addEventListener('click', () => radioCall('/prev'));
$('hRadioNext').addEventListener('click', () => radioCall('/next'));
$('hRadioPlay').addEventListener('click', () => {
  if (!radioState || radioState.status === 'playing') return radioCall('/pause');
  return radioState.status === 'paused' ? radioCall('/resume') : radioCall('/play');
});
$('hRadioShuffle').addEventListener('click', () => radioCall('/settings', { shuffle: !(radioState && radioState.shuffle) }));
$('hRadioRepeat').addEventListener('click', () => {
  const order = ['off', 'all', 'one'];
  radioCall('/settings', { repeat: order[(order.indexOf(radioState ? radioState.repeat : 'off') + 1) % 3] });
});
$('hRadioClear').addEventListener('click', () => radioCall('/clear'));
$('hRadioQueueAll').addEventListener('click', async () => {
  const j = await radioCall('/enqueue', { path: '/', recursive: true });
  if (j) showToast(`Queued ${Number(j.added)} song${j.added === 1 ? '' : 's'}`);
});
hRadio.guests.addEventListener('change', () => radioCall('/settings', { allowGuestAdd: hRadio.guests.checked }));

setInterval(() => { if (serverRunning) refreshRadio(); }, 2000);
