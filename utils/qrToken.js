import crypto from 'crypto';

const getQrSecret = () => process.env.QR_SECRET || process.env.JWT_SECRET || 'oditech_smart_qr_super_secret_key_2026';

/**
 * Generate a cryptographically signed QR token.
 * Defaults to PERMANENT (never expires), or supports custom rotation in seconds.
 * @param {string|number} expiry 'permanent' (default) or seconds (e.g. 60)
 * @returns {object} { token, isPermanent, expiresAt, expiresInSeconds }
 */
export const generateSignedQrToken = (expiry = 'permanent') => {
  const isPermanent = expiry === 'permanent' || expiry === 0 || expiry === '0' || !expiry;
  const now = Date.now();
  const expiresAt = isPermanent ? null : now + (Number(expiry) || 60) * 1000;
  const nonce = crypto.randomBytes(16).toString('hex');

  const payload = {
    purpose: 'ODITECH_OFFICE_QR_ATTENDANCE',
    iat: now,
    exp: expiresAt,
    isPermanent,
    nonce
  };

  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', getQrSecret())
    .update(payloadBase64)
    .digest('base64url');

  const token = `${payloadBase64}.${signature}`;

  return {
    token,
    isPermanent,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    expiresInSeconds: isPermanent ? null : (Number(expiry) || 60)
  };
};

/**
 * Validate a signed QR token.
 * Checks HMAC signature and expiration window (only for expiring tokens).
 * Permanent tokens never expire.
 * @param {string} token
 * @returns {object} { valid: boolean, error?: string, message?: string, payload?: object }
 */
export const verifySignedQrToken = (token) => {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'MISSING_TOKEN', message: 'No QR token provided' };
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, error: 'MALFORMED_TOKEN', message: 'Invalid QR token format' };
  }

  const [payloadBase64, signature] = parts;
  const expectedSignature = crypto
    .createHmac('sha256', getQrSecret())
    .update(payloadBase64)
    .digest('base64url');

  // Constant-time comparison to prevent timing attacks
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return { valid: false, error: 'INVALID_SIGNATURE', message: 'Invalid or forged QR Code token' };
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'));
    if (payload.purpose !== 'ODITECH_OFFICE_QR_ATTENDANCE') {
      return { valid: false, error: 'INVALID_PURPOSE', message: 'Unauthorized QR token type' };
    }

    const now = Date.now();
    // Only check expiration if token is NOT permanent and has an exp field
    if (!payload.isPermanent && payload.exp && now > payload.exp + 5000) {
      return { valid: false, error: 'QR_EXPIRED', message: 'QR Code has expired. Please scan the current code displayed on the screen.' };
    }

    return { valid: true, payload };
  } catch (err) {
    return { valid: false, error: 'PARSE_ERROR', message: 'Failed to decode QR token payload' };
  }
};

/**
 * Generate a high-entropy crypto token for persistent mobile device binding.
 * @returns {string} 64-char hex string
 */
export const generateDeviceCredential = () => {
  return crypto.randomBytes(32).toString('hex');
};

/**
 * Hash device token using SHA-256 for secure storage.
 * @param {string} deviceToken
 * @returns {string} SHA-256 hex string
 */
export const hashDeviceCredential = (deviceToken) => {
  if (!deviceToken) return '';
  return crypto.createHash('sha256').update(String(deviceToken).trim()).digest('hex');
};

/**
 * Determine formal greeting based on current Asia/Kolkata hour:
 * 05:00 AM – 11:59 AM: GOOD MORNING
 * 12:00 PM – 04:59 PM: GOOD AFTERNOON
 * 05:00 PM – 08:59 PM: GOOD EVENING
 * 09:00 PM – 04:59 AM: WELCOME
 */
export const getGreetingIST = (dateObj = new Date()) => {
  const tzStr = dateObj.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const localDate = new Date(tzStr);
  const hour = localDate.getHours();

  if (hour >= 5 && hour < 12) {
    return 'GOOD MORNING';
  } else if (hour >= 12 && hour < 17) {
    return 'GOOD AFTERNOON';
  } else if (hour >= 17 && hour < 21) {
    return 'GOOD EVENING';
  } else {
    return 'WELCOME';
  }
};
