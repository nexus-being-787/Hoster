const crypto = require('crypto');

/**
 * Validate a user-supplied PIN against the stored PIN.
 * Uses timing-safe comparison to prevent timing attacks.
 */
function validatePin(supplied, stored) {
  if (!supplied || !stored) return false;
  const a = Buffer.from(String(supplied).trim());
  const b = Buffer.from(String(stored).trim());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Generate a random 4-digit PIN
 */
function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

module.exports = { validatePin, generatePin };
