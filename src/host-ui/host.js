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
const uploadToggle= $('uploadToggle');
const dirPreview  = $('dirPreview');
const shareUrl    = $('shareUrl');
const urlCard     = $('urlCard');
const copyBtn     = $('copyBtn');
const qrBtn       = $('qrBtn');
const qrModal     = $('qrModal');
const qrImage     = $('qrImage');
const qrClose     = $('qrClose');
const modalUrl    = $('modalUrl');
const statClients = $('statClients');
const statBytes   = $('statBytes');
const statUptime  = $('statUptime');
const logStream   = $('logStream');
const clearLogsBtn= $('clearLogsBtn');
const settingsBtn = $('settingsBtn');
const settingsModal=$('settingsModal');
const settingsClose=$('settingsClose');
const pinToggle   = $('pinToggle');
const pinGroup    = $('pinGroup');
const pinInput    = $('pinInput');
const genPinBtn   = $('genPinBtn');
const saveSettingsBtn=$('saveSettingsBtn');

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

function setServerState(running, url) {
  serverRunning = running;

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
    shareUrl.textContent = url;
    urlCard.classList.add('active');
  } else {
    urlCard.classList.remove('active');
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

    if (data.running) {
      startedAt = data.startedAt;
      bytesServed = data.bytesServed || 0;
      const url = `http://${data.localIP}:${data.port}`;
      setServerState(true, url);
      dirPathInput.value = data.sharedDir || '';
      portInput.value = data.port || 8080;
      startUptimeTicker();
    }

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
      case 'init':
        ipText.textContent = msg.data.localIP || '—';
        ipDot.classList.add('online');
        break;
      case 'status':
        if (msg.data.running !== undefined) {
          if (msg.data.running) {
            startedAt = new Date().toISOString();
            startUptimeTicker();
            const url = `http://${msg.data.localIP}:${msg.data.port}`;
            setServerState(true, url);
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
        showToast(`↑ ${msg.data.files.length} file(s) uploaded to ${msg.data.dir}`);
        break;
    }
  };

  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => ws.close();
}

// ── Uptime Ticker ──────────────────────────────
function startUptimeTicker() {
  stopUptimeTicker();
  uptimeInterval = setInterval(() => {
    statUptime.textContent = formatUptime(startedAt);
    // Poll bytes
    fetch(`${API}/api/status`).then(r => r.json()).then(d => {
      statBytes.textContent = formatBytes(d.bytesServed || 0);
    }).catch(() => {});
  }, 2000);
}

function stopUptimeTicker() {
  if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null; }
  statUptime.textContent = '--:--';
  statBytes.textContent = '0 B';
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
          pinEnabled: pinToggle.checked,
          pin: pinInput.value,
          uploadEnabled: uploadToggle.checked,
        })
      });
      const data = await res.json();
      if (res.ok) {
        startedAt = new Date().toISOString();
        setServerState(true, data.url);
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
dirPathInput.addEventListener('keydown', e => e.key === 'Enter' && showPreview(dirPathInput.value.trim()));

async function showPreview(dir) {
  if (!dir) { dirPreview.classList.add('hidden'); return; }
  try {
    const res = await fetch(`${API}/files/list?path=/`);
    if (res.ok) {
      const data = await res.json();
      dirPreview.textContent = `📂 ${data.total} items in ${dir}`;
      dirPreview.className = 'dir-preview has-items';
    }
  } catch(e) {
    dirPreview.textContent = dir;
    dirPreview.className = 'dir-preview';
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

// ── Settings ──────────────────────────────────
settingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
settingsClose.addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

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
