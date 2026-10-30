/*
 * Hoster Radio — the listener side (browser).
 * Polls the station, keeps an <audio> element on the same moment as everybody else (see radio-sync.js),
 * and shows the queue. Song titles come from file names and ID3 tags — untrusted text — so this file only ever
 * writes them with textContent (never innerHTML); test/radio-client.test.js enforces that.
 */
(function () {
  'use strict';
  var Sync = window.HosterRadioSync;
  var doc = document;
  var $ = function (id) { return doc.getElementById(id); };

  var el = {
    btn: $('radioBtn'), dot: $('radioDot'), panel: $('radioPanel'), panelDot: $('radioPanelDot'), close: $('radioClose'),
    status: $('radioStatus'), track: $('radioTrack'), bar: $('radioBar'), pos: $('radioPos'), dur: $('radioDur'),
    tune: $('radioTune'), vol: $('radioVol'), sync: $('radioSync'), queue: $('radioQueue'), note: $('radioNote'),
    addFolder: $('radioAddFolder'), delay: $('radioDelay'), delayVal: $('radioDelayVal'),
  };
  if (!el.btn || !el.panel || !Sync) return;

  var POLL_ACTIVE_MS = 1500; // panel open or tuned in
  var POLL_IDLE_MS = 6000; // just keeping the "live" dot honest
  var TICK_MS = 400; // how often the audio element is nudged between polls
  var SEEK_HOLD_MS = 1500; // after a seek, let the audio settle before judging drift again
  // zero-length silent WAV: playing it inside the Tune-in tap unlocks audio on iOS/Safari for later tracks
  var SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

  var snap = null; // last station snapshot
  var samples = []; // clock-offset samples
  var tuned = false;
  var panelOpen = false;
  var trackId = null; // id of the track loaded into <audio>
  var needSeek = false; // a new track must be positioned before it is played
  var holdUntil = 0;
  var drawnVersion = -1;
  var reported = {};
  var delayMs = 0; // this device's speaker latency: play earlier by this much so it sounds in time (0–600)
  var audio = new Audio();
  audio.preload = 'auto';

  function headers() {
    return typeof state !== 'undefined' && state.pin ? { 'x-hoster-pin': state.pin } : {};
  }
  function jsonHeaders() {
    var h = headers(); h['content-type'] = 'application/json'; return h;
  }
  function fmt(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }
  function toast(text) {
    if (typeof hosterToast === 'function') hosterToast(text, 3500);
  }

  // ── talking to the station ─────────────────────────────────────────────────────────
  function poll() {
    var t0 = Date.now();
    return fetch('/radio/state', { headers: headers(), cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status); // 401 = PIN not entered yet, 503 = not sharing
        return r.json();
      })
      .then(function (j) {
        samples = Sync.addSample(samples, { t0: t0, t1: Date.now(), serverNow: j.serverNow });
        snap = j;
        render();
        if (tuned) apply();
      })
      .catch(function () { /* offline / locked: stay quiet and try again */ });
  }

  function loop() {
    poll().then(function () {
      var fast = panelOpen || tuned;
      setTimeout(loop, doc.hidden && !tuned ? POLL_IDLE_MS * 2 : fast ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    });
  }

  function post(path, body) {
    return fetch('/radio/' + path, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
  }

  // ── keeping <audio> on the station's moment ────────────────────────────────────────
  // Where the station is right now (what the progress bar shows)…
  function stationNow() {
    var off = Sync.clockOffset(samples);
    return snap && off !== null ? Sync.targetMs(snap, Date.now(), off) : null;
  }
  // …and where THIS device's audio should be: a Bluetooth speaker emits sound ~delayMs after the element "plays" it,
  // so the element has to run that much ahead for the sound to arrive together with everybody else's.
  function target() {
    var t = stationNow();
    return t === null ? null : t + delayMs;
  }

  function apply() {
    if (!tuned || !snap) return;
    var t = snap.track;
    if (!t || snap.status === 'stopped') { audio.pause(); trackId = null; return; }

    if (t.id !== trackId) { // a new song: load it, but don't play before we know where to start
      trackId = t.id;
      audio.src = t.stream;
      audio.playbackRate = 1;
      needSeek = true;
      holdUntil = 0;
      updateMediaSession(t);
    }
    var want = target();
    if (want === null || audio.readyState < 1) return; // no clock yet / metadata still loading

    if (snap.status === 'paused') {
      audio.pause();
      if (Math.abs(audio.currentTime * 1000 - want) > 150) audio.currentTime = Math.max(0, want) / 1000;
      return;
    }
    if (needSeek) {
      audio.currentTime = Math.max(0, want) / 1000;
      needSeek = false;
      holdUntil = Date.now() + SEEK_HOLD_MS;
    }
    if (audio.paused) {
      var p = audio.play();
      if (p && p.catch) p.catch(function () { setSync('Your browser blocked autoplay — tap Tune out, then Tune in again.', 'warn'); });
    }
    if (Date.now() < holdUntil) return;

    var drift = audio.currentTime * 1000 - want;
    var c = Sync.correction(audio.currentTime * 1000, want);
    if (c.action === 'seek') { audio.currentTime = c.seekToMs / 1000; audio.playbackRate = 1; holdUntil = Date.now() + SEEK_HOLD_MS; setSync('Re-syncing…', 'warn'); }
    else { audio.playbackRate = c.rate; setSync('In sync (' + (drift >= 0 ? '+' : '') + Math.round(drift) + ' ms)', 'good'); }
  }

  function setSync(text, cls) {
    el.sync.textContent = text;
    el.sync.className = 'radio-sync' + (cls ? ' ' + cls : '');
  }

  function updateMediaSession(t) {
    try {
      if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: 'Hoster Radio' });
      }
    } catch (e) { /* optional */ }
  }

  audio.addEventListener('loadedmetadata', function () {
    // The server reads song lengths from the files; only when it could not, a listener may report it.
    var t = snap && snap.track;
    if (t && t.id === trackId && t.durationMs == null && isFinite(audio.duration) && !reported[t.id]) {
      reported[t.id] = true;
      post('duration', { id: t.id, seconds: audio.duration }).catch(function () {});
    }
  });
  audio.addEventListener('error', function () {
    if (tuned && trackId !== null) setSync("This browser can't play that file type. The station will move on.", 'warn');
  });

  // ── drawing ────────────────────────────────────────────────────────────────────────
  function render() {
    var live = !!snap && snap.status === 'playing';
    el.btn.classList.toggle('live', live);
    el.dot.classList.toggle('live', live);
    el.panelDot.classList.toggle('live', live);
    if (!panelOpen) return;

    el.status.textContent = !snap ? 'Connecting…' : live ? 'Live now' : snap.status === 'paused' ? 'Paused by the host' : 'Off air';
    el.status.className = 'radio-status' + (live ? ' live' : '');
    el.track.textContent = snap && snap.track ? snap.track.title : 'Nothing playing';
    el.note.textContent = snap ? (snap.allowGuestAdd ? 'Anyone here can add songs.' : 'Only the host can add songs.') : '';

    if (snap && snap.version !== drawnVersion) { // rebuild the list only when the station changed
      drawnVersion = snap.version;
      while (el.queue.firstChild) el.queue.removeChild(el.queue.firstChild);
      if (!snap.queue.length) {
        var empty = doc.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'The queue is empty';
        el.queue.appendChild(empty);
      }
      snap.queue.forEach(function (q, i) {
        var li = doc.createElement('li');
        li.className = i === snap.index ? 'current' : '';
        var name = doc.createElement('span'); name.textContent = q.title;
        var dur = doc.createElement('span'); dur.className = 'dur'; dur.textContent = q.durationMs ? fmt(q.durationMs) : '';
        li.appendChild(name); li.appendChild(dur);
        el.queue.appendChild(li);
      });
    }
    progress();
  }

  function progress() {
    if (!panelOpen || !snap) return;
    var pos = snap.status === 'stopped' ? 0 : stationNow();
    if (pos === null) pos = snap.positionMs;
    var dur = snap.track && snap.track.durationMs;
    if (dur) pos = Math.min(pos, dur);
    el.pos.textContent = fmt(pos);
    el.dur.textContent = dur ? fmt(dur) : '';
    el.bar.style.width = dur ? Math.max(0, Math.min(100, (pos / dur) * 100)) + '%' : '0%';
  }

  function renderTune() {
    el.tune.textContent = tuned ? 'Tune out' : 'Tune in';
    el.tune.className = 'radio-tune' + (tuned ? ' on' : '');
  }

  // ── interaction ────────────────────────────────────────────────────────────────────
  function open() {
    panelOpen = true;
    el.panel.classList.remove('hidden');
    drawnVersion = -1;
    render();
    poll();
  }
  function closePanel() { panelOpen = false; el.panel.classList.add('hidden'); }

  el.btn.addEventListener('click', open);
  el.close.addEventListener('click', closePanel);
  el.panel.addEventListener('click', function (e) { if (e.target === el.panel) closePanel(); });
  doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panelOpen) closePanel(); });

  el.tune.addEventListener('click', function () {
    tuned = !tuned;
    if (tuned) {
      // inside the tap: unlock audio, then let the sync loop take over
      audio.src = SILENT;
      var p = audio.play();
      if (p && p.catch) p.catch(function () {});
      trackId = null;
      setSync('Syncing…');
      poll();
    } else {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      trackId = null;
      setSync('');
    }
    renderTune();
  });

  el.vol.addEventListener('input', function () {
    audio.volume = Math.max(0, Math.min(1, Number(el.vol.value)));
    try { localStorage.setItem('hoster_radio_vol', String(audio.volume)); } catch (e) { /* private mode */ }
  });
  try {
    var saved = Number(localStorage.getItem('hoster_radio_vol'));
    if (isFinite(saved) && localStorage.getItem('hoster_radio_vol') !== null) { audio.volume = Math.max(0, Math.min(1, saved)); el.vol.value = String(audio.volume); }
  } catch (e) { /* ignore */ }

  function setDelay(v, persist) {
    var n = Math.round(Number(v) / 10) * 10;
    delayMs = isFinite(n) ? Math.max(0, Math.min(600, n)) : 0;
    if (el.delay) el.delay.value = String(delayMs);
    if (el.delayVal) el.delayVal.textContent = delayMs + ' ms';
    holdUntil = 0; // re-aim right away
    if (persist) { try { localStorage.setItem('hoster_radio_delay', String(delayMs)); } catch (e) { /* private mode */ } }
  }
  if (el.delay) {
    el.delay.addEventListener('input', function () { setDelay(el.delay.value, true); if (tuned) apply(); });
    try { setDelay(localStorage.getItem('hoster_radio_delay') || 0, false); } catch (e) { setDelay(0, false); }
  }

  function addPath(path) {
    return post('add', { path: path }).then(function (r) {
      if (r.status === 403) { toast('The host has not allowed guests to add songs.'); return; }
      if (!r.ok) { toast('Could not add that to the radio.'); return; }
      return r.json().then(function (j) { toast('Added ' + Number(j.added) + ' song' + (j.added === 1 ? '' : 's') + ' to the radio'); poll(); });
    }).catch(function () { toast('Could not add that to the radio.'); });
  }
  el.addFolder.addEventListener('click', function () {
    var p = typeof state !== 'undefined' ? state.currentPath || '/' : '/';
    addPath(p.charAt(0) === '/' ? p : '/' + p);
  });
  // "Add to Radio" entries in the file preview menu
  doc.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a.radio-add');
    if (!a) return;
    e.preventDefault();
    addPath(decodeURIComponent(a.dataset.path || ''));
  });

  setInterval(function () { if (tuned) apply(); progress(); }, TICK_MS);
  renderTune();
  loop();

  // exposed for tests / debugging only
  window.__hosterRadio = { poll: poll, apply: apply, get audio() { return audio; }, get tuned() { return tuned; } };
})();
