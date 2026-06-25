'use strict';

const NEXUS_VERIFY  = 'https://nexusbackend-ookk.onrender.com/api/subscriptions/verify';
const PRODUCT_ID    = '6a19a6a0d0ee1110ebcbc131';
const GRACE_MS      = 3 * 24 * 60 * 60 * 1000; // 3 days

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('licenseCheck', { periodInMinutes: 24 * 60 });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'licenseCheck') silentReVerify();
});

async function silentReVerify() {
  const { licenseKey } = await chrome.storage.sync.get('licenseKey');
  if (!licenseKey) return;

  try {
    const res  = await fetch(NEXUS_VERIFY, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ productId: PRODUCT_ID, licenseKey }),
    });
    const data = await res.json();

    if (data.success && data.valid && data.hasAccess) {
      await chrome.storage.sync.set({ lastVerified: Date.now() });
    } else if (res.status >= 400 && res.status < 500) {
      // Explicitly revoked — clear everything
      await chrome.storage.sync.remove(['licenseKey','licenseData','lastVerified','nexusUserId']);
    }
  } catch {
    // Offline — check grace period
    const { lastVerified } = await chrome.storage.sync.get('lastVerified');
    if (lastVerified && (Date.now() - lastVerified) > GRACE_MS) {
      await chrome.storage.sync.remove(['licenseKey','licenseData','lastVerified','nexusUserId']);
    }
  }
}
