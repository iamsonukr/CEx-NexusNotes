'use strict';
const router      = require('express').Router();
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const licenseAuth = require('../middleware/licenseAuth');
const UserNotes   = require('../models/UserNotes');

// Rate limit: 60 requests per minute per license key
const notesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: req => req.headers['authorization'] || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down.' },
});

// All routes require a valid license key
router.use(licenseAuth);
router.use(notesLimiter);

// ── GET /api/notes — return all tabs for this user ─────────────────
router.get('/', async (req, res) => {
  try {
    res.json(req.userNotes.tabs || []);
  } catch (err) {
    console.error('[GET /notes]', err.message);
    res.status(500).json({ message: 'Could not load notes.' });
  }
});

// ── PUT /api/notes — replace all tabs (last-write-wins) ────────────
router.put('/', async (req, res) => {
  const { tabs } = req.body;

  if (!Array.isArray(tabs)) {
    return res.status(422).json({ message: 'tabs must be an array.' });
  }

  // Validate and sanitize each tab
  const MAX_TABS    = 200;
  const MAX_CONTENT = 100_000;
  const MAX_NAME    = 200;

  if (tabs.length > MAX_TABS) {
    return res.status(422).json({ message: `Maximum ${MAX_TABS} tabs allowed.` });
  }

  const sanitized = tabs.map(t => ({
    id:        String(t.id       || '').slice(0, 32),
    name:      String(t.name     || 'Untitled').slice(0, MAX_NAME),
    content:   String(t.content  || '').slice(0, MAX_CONTENT),
    hidden:    Boolean(t.hidden),
    updatedAt: Number(t.updatedAt) || Date.now(),
  })).filter(t => t.id); // drop any tab without an id

  try {
    req.userNotes.tabs      = sanitized;
    req.userNotes.updatedAt = new Date();
    await req.userNotes.save();
    res.json({ saved: true, count: sanitized.length });
  } catch (err) {
    console.error('[PUT /notes]', err.message);
    res.status(500).json({ message: 'Could not save notes.' });
  }
});

module.exports = router;
