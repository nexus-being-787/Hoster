/*
 * Builds the links handed to external players (VLC / MX Player).
 * Pure functions, no DOM — unit-tested in test/links.test.js.
 *
 * Rules:
 *  - a short-lived token bound to the path (t / pt) is used, so the PIN never ends up in a link
 *    that is copied, shared, or logged by another app;
 *  - the PIN is only a last resort, when the token could not be fetched.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HosterLinks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var enc = encodeURIComponent;

  function authQuery(token, pin) {
    if (token) return '&t=' + enc(token);
    if (pin) return '&pin=' + enc(pin);
    return '';
  }

  /**
   * @param {object} o
   * @param {string} o.path        shared-folder path of the file or folder
   * @param {string} o.protocol    'http' | 'https'
   * @param {string} o.host        'ip:port' as reached right now
   * @param {boolean} [o.folder]   play the whole folder as a playlist
   * @param {string} [o.kind]      'audio' | 'video' (single files, Android intent type)
   * @param {string} [o.player]    'vlc' (default) | 'mx'
   * @param {string} [o.t]         stream token for this file
   * @param {string} [o.pt]        playlist token for this file/folder
   * @param {string} [o.pin]       last-resort fallback only
   * @returns {{target:string, httpUrl:string, vlcUrl:string, intentUrl:string}}
   */
  function build(o) {
    var target = o.folder
      ? '/files/playlist.m3u?path=' + enc(o.path) + authQuery(o.pt, o.pin)
      : '/files/stream?path=' + enc(o.path) + authQuery(o.t, o.pin);
    var httpUrl = o.protocol + '://' + o.host + target;
    var pkg = o.player === 'mx' ? 'com.mxtech.videoplayer.ad' : 'org.videolan.vlc';
    var type = o.folder ? 'audio/x-mpegurl' : (o.kind || 'audio') + '/*';
    return {
      target: target,
      httpUrl: httpUrl,
      vlcUrl: 'vlc://' + httpUrl,
      intentUrl: 'intent://' + o.host + target + '#Intent;package=' + pkg + ';type=' + type + ';scheme=' + o.protocol + ';end',
    };
  }

  return { build: build };
});
