'use strict';
const UserNotes  = require('../models/UserNotes');

const NEXUS_VERIFY  = 'https://nexusbackend-ookk.onrender.com/api/subscriptions/verify';
const PRODUCT_ID    = '6a3c050b99374b9a8d0f5012';
const CACHE_MS      = 24 * 60 * 60 * 1000; // re-verify once per 24 hours

/**
 * License key middleware.
 *
 * Reads: Authorization: Bearer <licenseKey>
 *
 * Strategy (avoids hitting Nexus on every request):
 *  1. Extract key from header
 *  2. Find UserNotes doc for this key
 *  3. If found AND last check < 24h → trust cache, attach user, next()
 *  4. If not found OR cache stale  → call Nexus verify
 *     - Valid   → upsert UserNotes, next()
 *     - Invalid → 401
 *  5. Attach req.userNotes for route handlers to use
 */
module.exports = async function licenseAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'License key required. Include Authorization: Bearer <key>' });
  }

  const licenseKey = header.slice(7).trim();
  if (!licenseKey) {
    return res.status(401).json({ message: 'License key is empty.' });
  }

  try {
    // ── 1. Check cache ──────────────────────────────────────────────
    const existing = await UserNotes.findOne({ licenseKey });

    if (existing && existing.licenseLastCheck) {
      const age = Date.now() - existing.licenseLastCheck.getTime();
      if (age < CACHE_MS && existing.licenseValid) {
        // Cache is fresh and valid — skip Nexus call
        req.userNotes  = existing;
        req.nexusUserId = existing.nexusUserId;
        return next();
      }
    }

    // ── 2. Verify with Nexus ────────────────────────────────────────
    let nexusRes, nexusData;
    try {
      nexusRes  = await fetch(NEXUS_VERIFY, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ productId: PRODUCT_ID, licenseKey }),
      });
      nexusData = await nexusRes.json();
    } catch {
      // Nexus unreachable — fall back to cache if exists
      if (existing && existing.licenseValid) {
        req.userNotes   = existing;
        req.nexusUserId = existing.nexusUserId;
        return next();
      }
      return res.status(503).json({ message: 'License server unreachable. Try again shortly.' });
    }

    if (!nexusData.success || !nexusData.valid || !nexusData.hasAccess) {
      // Key is invalid or subscription ended
      if (existing) {
        existing.licenseValid      = false;
        existing.licenseLastCheck  = new Date();
        await existing.save();
      }
      return res.status(401).json({
        message: nexusData.message || 'License key is invalid or subscription has ended.',
      });
    }

    // ── 3. Valid — upsert UserNotes ─────────────────────────────────
    const nexusUserId   = nexusData.user?.id;
    const expiresAt     = nexusData.subscription?.endDate
      ? new Date(nexusData.subscription.endDate)
      : null;

    const userNotes = await UserNotes.findOneAndUpdate(
      { licenseKey },
      {
        $set: {
          licenseKey,
          nexusUserId,
          licenseValid:     true,
          licenseExpiresAt: expiresAt,
          licenseLastCheck: new Date(),
        },
        $setOnInsert: { tabs: [], createdAt: new Date() },
      },
      { upsert: true, new: true }
    );

    req.userNotes   = userNotes;
    req.nexusUserId = nexusUserId;
    next();

  } catch (err) {
    console.error('[licenseAuth] Error:', err.message);
    res.status(500).json({ message: 'Server error during license verification.' });
  }
};
