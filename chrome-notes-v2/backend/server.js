'use strict';
require('dotenv').config({ quiet: true });

const express  = require('express');
const mongoose = require('mongoose');
const helmet   = require('helmet');
const cors     = require('cors');
const morgan   = require('morgan');
const rLimit   = require('express-rate-limit');

const notesRoutes = require('./routes/notes');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MongoDB ────────────────────────────────────────────────────────
function describeMongoUri(uri) {
  try {
    const parsed = new URL(uri);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname || ''}`;
  } catch (_err) {
    return 'invalid MongoDB URI';
  }
}

async function connectMongo() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing from .env');
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS:          45000,
    });
    console.log('✓ MongoDB connected');
  } catch (err) {
    const target = describeMongoUri(process.env.MONGODB_URI);
    throw new Error(`${err.message} (${target}). Check that your Atlas connection string host is exact and includes a database name, e.g. /tabnotes.`);
  }
}

// ── Security headers ───────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      objectSrc:  ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// ── CORS ───────────────────────────────────────────────────────────
// Only your Chrome extension can call this API
const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin (curl/Postman in dev) and chrome-extension:// origins
    if (!origin || process.env.NODE_ENV !== 'production') return cb(null, true);
    const ok = allowed.some(o => origin.startsWith(o));
    ok ? cb(null, true) : cb(new Error(`CORS blocked: ${origin}`));
  },
  methods:        ['GET', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge:         86400,
}));

// ── Body parsing ───────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' })); // 5MB covers ~200 notes at 100KB each edge case
app.use(express.urlencoded({ extended: false }));

// ── Logging ────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ── Global rate limiter ────────────────────────────────────────────
app.use(rLimit({
  windowMs: 15 * 60 * 1000,
  max:      300,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { message: 'Too many requests.' },
}));

// ── Health check ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── Routes ─────────────────────────────────────────────────────────
app.use('/api/notes', notesRoutes);

// ── 404 ────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ message: 'Not found' }));

// ── Error handler ──────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const msg = process.env.NODE_ENV === 'production' ? 'Server error' : err.message;
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({ message: msg });
});

// ── Start ──────────────────────────────────────────────────────────
async function start() {
  try {
    await connectMongo();
    app.listen(PORT, () => {
      console.log(`✓ TabNotes API on :${PORT} [${process.env.NODE_ENV || 'development'}]`);
    });
  } catch (err) {
    console.error('✗ Startup:', err.message);
    process.exit(1);
  }
}

start();

module.exports = app;
