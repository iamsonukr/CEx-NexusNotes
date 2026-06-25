'use strict';
const mongoose = require('mongoose');

/**
 * One document per user.
 * Identified by nexusUserId (from the Nexus verify API response).
 * The licenseKey is stored for quick lookup + re-validation checks.
 * tabs[] is the full notes array — last-write-wins on every PUT.
 */
const tabSchema = new mongoose.Schema({
  id:        { type: String, required: true },
  name:      { type: String, default: 'Untitled', maxlength: 200 },
  content:   { type: String, default: '', maxlength: 100_000 },
  hidden:    { type: Boolean, default: false },
  updatedAt: { type: Number, default: Date.now },
}, { _id: false });

const userNotesSchema = new mongoose.Schema({
  nexusUserId: { type: String, required: true, unique: true, index: true },
  licenseKey:  { type: String, required: true, index: true },
  tabs:        { type: [tabSchema], default: [] },

  // Cache the Nexus verify response so we don't hit Nexus on every API call
  licenseValid:      { type: Boolean, default: true },
  licenseExpiresAt:  { type: Date,    default: null },
  licenseLastCheck:  { type: Date,    default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: false });

userNotesSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('UserNotes', userNotesSchema);
