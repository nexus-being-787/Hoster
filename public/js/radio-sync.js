/*
 * Hoster Radio — keeping many devices on the same moment of the same song.
 * Pure functions (no DOM, no network): unit-tested in test/radio-sync.test.js.
 *
 * The server publishes, with every state snapshot:  serverNow  (its clock when it answered) and
 * positionMs  (how far into the song the station is at that instant).
 * A listener's own clock is some unknown number of ms away from the server's, so:
 *   1. clockOffset()   estimates  serverClock − localClock  from request/response timestamps (NTP-style),
 *   2. targetMs()      turns a snapshot + the local clock into "where we should be right now",
 *   3. correction()    nudges the <audio> element there: a tiny playback-rate change for small drift
 *                      (inaudible), a hard seek only when we are clearly off.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HosterRadioSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var SEEK_THRESHOLD_MS = 400; // further off than this → jump
  var DEAD_ZONE_MS = 30; // closer than this → leave the audio alone
  var MAX_RATE_DELTA = 0.05; // never speed up/slow down by more than 5 %
  var RATE_GAIN_MS = 3000; // drift of 3 s would ask for a 100 % change (clamped) → gentle for small drift

  /**
   * @param {{t0:number,t1:number,serverNow:number}[]} samples  t0 = local time the request left,
   *        t1 = local time the reply arrived, serverNow = server clock inside the reply.
   * @returns {number|null} ms to ADD to the local clock to get server time
   * Assuming the reply took as long to come back as the request took to go, the server stamped its clock
   * at the midpoint (t0+t1)/2. Samples with the shortest round trip are the least uncertain, so we keep
   * the best third and take the median of their offsets (robust against a single odd sample).
   */
  function clockOffset(samples) {
    if (!samples || !samples.length) return null;
    var best = samples.slice().sort(function (a, b) { return (a.t1 - a.t0) - (b.t1 - b.t0); })
      .slice(0, Math.max(1, Math.ceil(samples.length / 3)));
    var offsets = best.map(function (s) { return s.serverNow - (s.t0 + s.t1) / 2; }).sort(function (a, b) { return a - b; });
    return offsets[Math.floor(offsets.length / 2)];
  }

  /** Where in the current song the station is *right now*, as this listener should hear it. */
  function targetMs(snapshot, localNow, offset) {
    if (snapshot.status !== 'playing') return snapshot.positionMs; // paused: everybody holds the same spot
    return snapshot.positionMs + (localNow + offset - snapshot.serverNow);
  }

  /**
   * @param {number} currentMs  audio.currentTime * 1000
   * @param {number} target     from targetMs()
   * @returns {{action:'none'|'rate'|'seek', rate:number, seekToMs?:number}}
   */
  function correction(currentMs, target) {
    var drift = currentMs - target; // > 0: we are ahead of the station
    var abs = Math.abs(drift);
    if (abs > SEEK_THRESHOLD_MS) return { action: 'seek', rate: 1, seekToMs: Math.max(0, target) };
    if (abs > DEAD_ZONE_MS) {
      var rate = 1 - drift / RATE_GAIN_MS;
      rate = Math.min(1 + MAX_RATE_DELTA, Math.max(1 - MAX_RATE_DELTA, rate));
      return { action: 'rate', rate: rate };
    }
    return { action: 'none', rate: 1 };
  }

  /** Keep a sliding window of the most recent samples. */
  function addSample(samples, sample, max) {
    var out = samples.concat([sample]);
    return out.length > (max || 12) ? out.slice(out.length - (max || 12)) : out;
  }

  return { clockOffset: clockOffset, targetMs: targetMs, correction: correction, addSample: addSample,
           SEEK_THRESHOLD_MS: SEEK_THRESHOLD_MS, DEAD_ZONE_MS: DEAD_ZONE_MS };
});
