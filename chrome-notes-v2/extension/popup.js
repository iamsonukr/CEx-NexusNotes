/**
 * TabNotes — popup.js
 *
 * Flow:
 *  1. Open → read chrome.storage.sync for license metadata and chrome.storage.local for notes
 *  2a. No key          → show the free local plan
 *  2b. Key + online    → verify with Nexus → show app
 *  2c. Key + offline   → check 3-day grace → show app with banner
 *
 * Notes storage:
 *  - Always saved locally in chrome.storage.local first (instant)
 *  - Free plan is capped at 3 local pages
 *  - Licensed notes can sync to your backend API using licenseKey as Bearer token
 *  - Manual sync: "Save to Cloud" button
 *  - Auto-save: debounced 3s after last keystroke (if toggled on)
 *
 * Chrome MV3 compliant:
 *  ✓ No innerHTML / eval / remote scripts
 *  ✓ All DOM via createElement / textContent
 *  ✓ fetch() only to declared host_permissions
 *  ✓ No inline event handlers
 */
'use strict';

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════
const NEXUS_VERIFY = 'https://nexusbackend-ookk.onrender.com/api/subscriptions/verify';
const PRODUCT_ID   = '6a3c050b99374b9a8d0f5012';
const BUY_URL      = 'https://codersnexus.com/nexus-store/non-incididunt-excep#licensing';
const API_BASE     = 'https://your-tabnotes-api.com/api'; // replace with your deployed backend
const GRACE_MS     = 3 * 24 * 60 * 60 * 1000;
const DEBOUNCE_MS  = 3000; // 3s after last keystroke
const FREE_TAB_LIMIT = 3;

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════
let tabs          = [];
let activeId      = null;
let renamingTabId = null;
let ctxTabId      = null;
let theme         = 'dark';
let size          = 'medium';
let autoSave      = false;

// Timers
let localSaveTimer  = null; // debounce for chrome.storage.local
let cloudSaveTimer  = null; // debounce for cloud auto-save
let undoInterval    = null;
let undoStack       = null;
let undoCount       = 0;

// License
let licenseKey   = null;
let licenseData  = null;
let lastVerified = null;
let nexusUserId  = null;
let licenseState = 'free'; // 'free' | 'active' | 'grace'

// Cloud sync state
let cloudStatus = 'local'; // 'local' | 'saving' | 'synced' | 'error'

// ═══════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  await hydrateAll();
  applyPrefs();
  await checkLicense();
  bindAll();
});

async function hydrateAll() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get([
      'theme','size','autoSave',
      'licenseKey','licenseData','lastVerified','nexusUserId',
      'tabs','activeId',
    ]),
    chrome.storage.local.get(['tabs','activeId']),
  ]);

  theme        = syncData.theme        || 'dark';
  size         = syncData.size         || 'medium';
  autoSave     = syncData.autoSave     || false;
  licenseKey   = syncData.licenseKey   || null;
  licenseData  = syncData.licenseData  || null;
  lastVerified = syncData.lastVerified || null;
  nexusUserId  = syncData.nexusUserId  || null;

  const localTabs  = Array.isArray(localData.tabs) ? localData.tabs : null;
  const syncedTabs = Array.isArray(syncData.tabs) ? syncData.tabs : null;
  tabs     = localTabs || syncedTabs || [];
  activeId = localData.activeId || syncData.activeId || tabs.find(t => !t.hidden)?.id || null;

  if (!localTabs && syncedTabs) await saveNotesLocalNow();
  if (syncedTabs || syncData.activeId) await chrome.storage.sync.remove(['tabs','activeId']);
}

// ═══════════════════════════════════════════════════════════════════
// PREFS
// ═══════════════════════════════════════════════════════════════════
function applyPrefs() {
  document.body.dataset.theme = theme;
  document.body.dataset.size  = size;
  ['themeLight','themeDark'].forEach(id => $(id).classList.remove('active'));
  $(theme === 'light' ? 'themeLight' : 'themeDark').classList.add('active');
  ['sizeSmall','sizeMedium','sizeLarge'].forEach(id => $(id).classList.remove('active'));
  $({ small:'sizeSmall', medium:'sizeMedium', large:'sizeLarge' }[size]).classList.add('active');
  $('autoSaveToggle').checked = autoSave;
}

function setTheme(t) {
  theme = t;
  document.body.dataset.theme = t;
  ['themeLight','themeDark'].forEach(id => $(id).classList.remove('active'));
  $(t === 'light' ? 'themeLight' : 'themeDark').classList.add('active');
  chrome.storage.sync.set({ theme: t });
}

function setSize(s) {
  size = s;
  document.body.dataset.size = s;
  ['sizeSmall','sizeMedium','sizeLarge'].forEach(id => $(id).classList.remove('active'));
  $({ small:'sizeSmall', medium:'sizeMedium', large:'sizeLarge' }[s]).classList.add('active');
  chrome.storage.sync.set({ size: s });
}

function setAutoSave(val) {
  if (val && !canUseCloud()) {
    $('autoSaveToggle').checked = false;
    toast('Activate a license to use cloud auto-save.');
    return;
  }
  autoSave = val;
  chrome.storage.sync.set({ autoSave: val });
  if (!val) clearTimeout(cloudSaveTimer);
}

// ═══════════════════════════════════════════════════════════════════
// LICENSE CHECK
// ═══════════════════════════════════════════════════════════════════
async function checkLicense() {
  if (!licenseKey) {
    licenseState = 'free';
    showApp();
    return;
  }

  try {
    const res  = await fetch(NEXUS_VERIFY, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ productId: PRODUCT_ID, licenseKey }),
    });
    const data = await res.json();

    if (data.success && data.valid && data.hasAccess) {
      licenseData  = data;
      nexusUserId  = data.user?.id || null;
      lastVerified = Date.now();
      licenseState = 'active';
      await chrome.storage.sync.set({ licenseData, nexusUserId, lastVerified });
      showApp();
    } else {
      await clearLicense();
      showApp();
    }
  } catch {
    if (lastVerified && (Date.now() - lastVerified) <= GRACE_MS) {
      licenseState = 'grace';
      showApp();
    } else {
      await clearLicense();
      showApp();
    }
  }
}

async function clearLicense() {
  licenseKey = null; licenseData = null; lastVerified = null; nexusUserId = null;
  licenseState = 'free';
  await chrome.storage.sync.remove(['licenseKey','licenseData','lastVerified','nexusUserId']);
}

// ═══════════════════════════════════════════════════════════════════
// SHOW / HIDE SECTIONS
// ═══════════════════════════════════════════════════════════════════
function showGate() {
  $('licenseGate').classList.add('show');
  ['tabBar','hiddenTray','editorWrap','footer'].forEach(id => $(id).style.display = 'none');
  $('graceBanner').classList.remove('show');
  $('freeBanner').classList.remove('show');
  updateLicBadge();
  updateSettingsLicSection();
}

function showApp() {
  $('licenseGate').classList.remove('show');
  $('tabBar').style.display     = 'flex';
  $('hiddenTray').style.display = '';
  $('editorWrap').style.display = 'flex';
  $('footer').style.display     = 'flex';

  const inGrace = licenseState === 'grace';
  const inFree  = licenseState === 'free';
  if (inGrace) {
    const ms       = GRACE_MS - (Date.now() - lastVerified);
    const daysLeft = Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
    $('graceDaysLeft').textContent = daysLeft;
    $('graceBanner').classList.add('show');
  } else {
    $('graceBanner').classList.remove('show');
  }
  $('freeBanner').classList.toggle('show', inFree);

  if (!canUseCloud()) {
    $('syncBtn').disabled = true;
    $('syncBtn').title = inGrace ? 'Cloud sync unavailable in offline mode' : 'Cloud sync requires a license';
    if (autoSave) {
      autoSave = false;
      chrome.storage.sync.set({ autoSave: false });
      clearTimeout(cloudSaveTimer);
    }
  } else {
    $('syncBtn').disabled = false;
    $('syncBtn').title = 'Save notes to cloud';
  }
  $('autoSaveToggle').checked = autoSave;
  $('autoSaveToggle').disabled = !canUseCloud();

  updateLicBadge();
  updateSettingsLicSection();
  renderTabs();
  renderHiddenTray();
  renderEditor();
  updateCloudStatus('local');
}

// ── License badge ──────────────────────────────────────────────────
function updateLicBadge() {
  const badge = $('licBadge');
  const text  = $('licBadgeText');
  badge.className = `lic-badge ${licenseState}`;

  if (licenseState === 'active') {
    text.textContent = licenseData?.user?.firstName || 'Licensed';
    badge.removeAttribute('role');
    badge.removeAttribute('tabindex');
  } else if (licenseState === 'grace') {
    text.textContent = 'Offline mode';
    badge.removeAttribute('role');
    badge.removeAttribute('tabindex');
  } else {
    text.textContent = 'Free';
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');
  }
}

function updateSettingsLicSection() {
  const section = $('sLicSection');
  const activateBtn = $('sLicActivate');
  const removeBtn = $('sLicRemove');
  section.style.display = 'block';

  if (licenseState === 'active' || licenseState === 'grace') {
    const user = licenseData?.user;
    $('sLicName').textContent = user ? `${user.fullName || user.firstName || 'Licensed'} (${user.email || 'verified'})` : 'Licensed';
    const parts = licenseKey ? licenseKey.split('-') : [];
    $('sLicKey').textContent = parts.map((p, i) => i < parts.length - 1 ? '••••' : p).join('-');
    activateBtn.style.display = 'none';
    removeBtn.style.display = 'block';
  } else {
    $('sLicName').textContent = `Free plan: ${tabs.length}/${FREE_TAB_LIMIT} local pages`;
    $('sLicKey').textContent = 'Cloud sync is off until you activate a license.';
    activateBtn.style.display = 'block';
    removeBtn.style.display = 'none';
  }
}

function canUseCloud() {
  return !!licenseKey && licenseState === 'active';
}

function isFreePlan() {
  return licenseState === 'free';
}

function canAddTab() {
  return !isFreePlan() || tabs.length < FREE_TAB_LIMIT;
}

function openActivateGate() {
  switchGateTab('activate');
  $('settingsPanel').classList.remove('open');
  showGate();
}

function updateFreeLimitUI() {
  const addBtn = $('addTabBtn');
  if (addBtn) {
    const atLimit = isFreePlan() && tabs.length >= FREE_TAB_LIMIT;
    addBtn.disabled = atLimit;
    addBtn.title = atLimit ? `Free plan allows up to ${FREE_TAB_LIMIT} pages. Activate for unlimited pages.` : 'New tab';
  }
  const count = $('freePageCount');
  if (count) count.textContent = tabs.length.toLocaleString();
  if (isFreePlan() && $('sLicName')) {
    $('sLicName').textContent = `Free plan: ${tabs.length}/${FREE_TAB_LIMIT} local pages`;
  }
}

// ── Cloud status indicator ──────────────────────────────────────────
function updateCloudStatus(status, msg) {
  cloudStatus = status;
  const dot  = $('statusDot');
  const text = $('statusText');
  dot.className = `status-dot ${status}`;
  const labels = {
    local:  'Saved locally',
    saving: 'Saving to cloud…',
    synced: 'Synced to cloud',
    error:  msg || 'Sync failed',
  };
  text.textContent = labels[status] || 'Saved locally';
}

// ═══════════════════════════════════════════════════════════════════
// LICENSE GATE UI
// ═══════════════════════════════════════════════════════════════════
function switchGateTab(tab) {
  $('panelActivate').classList.toggle('show', tab === 'activate');
  $('panelBuy').classList.toggle('show',      tab === 'buy');
  $('tabActivate').classList.toggle('active', tab === 'activate');
  $('tabBuy').classList.toggle('active',      tab === 'buy');
}

async function doActivate() {
  const rawKey = $('licKeyInput').value.trim().toUpperCase();
  const errEl  = $('licKeyErr');
  const inp    = $('licKeyInput');
  const btn    = $('activateBtn');

  errEl.textContent = '';
  inp.classList.remove('err', 'ok');

  if (!rawKey) {
    errEl.textContent = 'Please enter your license key.';
    inp.classList.add('err'); return;
  }
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(rawKey)) {
    errEl.textContent = 'Format must be XXXX-XXXX-XXXX-XXXX.';
    inp.classList.add('err'); return;
  }

  setBusy(btn, true, 'Verifying…');

  try {
    const res  = await fetch(NEXUS_VERIFY, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ productId: PRODUCT_ID, licenseKey: rawKey }),
    });
    const data = await res.json();

    if (data.success && data.valid && data.hasAccess) {
      licenseKey   = rawKey;
      licenseData  = data;
      nexusUserId  = data.user?.id || null;
      lastVerified = Date.now();
      licenseState = 'active';

      await chrome.storage.sync.set({ licenseKey, licenseData, nexusUserId, lastVerified });

      inp.classList.add('ok');
      inp.value = '';

      // Load notes from cloud first, then show app
      await loadNotesFromCloud();
      setTimeout(() => {
        showApp();
        toast(`Welcome, ${data.user?.firstName || 'there'}! TabNotes activated.`);
      }, 400);

    } else {
      errEl.textContent = data.message || 'Invalid or expired license key.';
      inp.classList.add('err');
    }
  } catch {
    errEl.textContent = 'Could not reach the license server. Check your connection.';
    inp.classList.add('err');
  } finally {
    setBusy(btn, false, 'Activate');
  }
}

async function doRemoveLicense() {
  if (!confirm('Remove your license key?\n\nYour notes stay saved locally. Cloud sync will stop until you activate again.')) return;
  await clearLicense();
  autoSave = false;
  await chrome.storage.sync.set({ autoSave: false });
  $('settingsPanel').classList.remove('open');
  showApp();
  toast('License removed. Free local mode is active.');
}

// ═══════════════════════════════════════════════════════════════════
// CLOUD SYNC — notes API
// ═══════════════════════════════════════════════════════════════════
function apiHeaders() {
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${licenseKey}`,
  };
}

// Load all notes from cloud → merge into local tabs
async function loadNotesFromCloud() {
  if (!canUseCloud()) return;
  try {
    const res = await fetch(`${API_BASE}/notes`, { headers: apiHeaders() });
    if (!res.ok) return;
    const cloudTabs = await res.json(); // array of {id, name, content, hidden, updatedAt}
    if (Array.isArray(cloudTabs) && cloudTabs.length > 0) {
      tabs = mergeTabs(tabs, cloudTabs);
      activeId = tabs.find(t => t.id === activeId && !t.hidden)?.id || tabs.find(t => !t.hidden)?.id || null;
      await saveNotesLocalNow();
    }
  } catch { /* offline — use local */ }
}

function mergeTabs(localTabs, cloudTabs) {
  const byId = new Map();
  [...cloudTabs, ...localTabs].forEach(tab => {
    if (!tab || !tab.id) return;
    const existing = byId.get(tab.id);
    if (!existing || Number(tab.updatedAt || 0) >= Number(existing.updatedAt || 0)) byId.set(tab.id, tab);
  });
  return [...byId.values()];
}

// Push all tabs to cloud (called on manual save or debounced auto-save)
async function syncToCloud() {
  if (!canUseCloud()) {
    updateCloudStatus('local');
    toast('Activate a license to save to cloud.');
    return;
  }
  updateCloudStatus('saving');
  try {
    const res = await fetch(`${API_BASE}/notes`, {
      method:  'PUT',
      headers: apiHeaders(),
      body:    JSON.stringify({ tabs }),
    });
    if (res.ok) {
      updateCloudStatus('synced');
    } else {
      const d = await res.json().catch(() => ({}));
      updateCloudStatus('error', d.message || `Error ${res.status}`);
    }
  } catch {
    updateCloudStatus('error', 'Offline — saved locally');
  }
}

// ═══════════════════════════════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════════════════════════════

// Always save locally immediately, then handle cloud when licensed.
async function saveNotesLocalNow() {
  await chrome.storage.local.set({ tabs, activeId });
}

function scheduleLocalSave() {
  clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => {
    saveNotesLocalNow();
  }, 400); // local save: 400ms debounce
}

// Cloud auto-save: 3s debounce after last keystroke
function scheduleCloudSave() {
  if (!autoSave || !canUseCloud()) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => syncToCloud(), DEBOUNCE_MS);
}

// ═══════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════
function renderTabs() {
  if (renamingTabId !== null) return;
  const bar    = $('tabBar');
  const addBtn = $('addTabBtn');
  bar.querySelectorAll('.tab').forEach(n => n.remove());

  tabs.filter(t => !t.hidden).forEach(tab => {
    const wrapper = el('div', { class: tab.id === activeId ? 'tab active' : 'tab' });
    wrapper.dataset.id = tab.id;

    const label = el('span', { class: 'tab-label' });
    label.textContent = tab.name;

    const actions = el('div', { class: 'tab-actions' });
    const hideBtn = el('button', { class:'tab-act hide-btn', type:'button', title:'Hide (keeps note)' });
    hideBtn.textContent = '↙';
    hideBtn.addEventListener('click', e => { e.stopPropagation(); doHideTab(tab.id); });

    const delBtn = el('button', { class:'tab-act del-btn', type:'button', title:'Delete note' });
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', e => { e.stopPropagation(); doDeleteTab(tab.id); });

    actions.append(hideBtn, delBtn);

    wrapper.addEventListener('click', e => {
      if (actions.contains(e.target)) return;
      if (tab.id !== activeId) switchTab(tab.id);
    });
    label.addEventListener('dblclick', e => {
      e.stopPropagation(); e.preventDefault();
      beginRename(wrapper, tab);
    });
    wrapper.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      openCtxMenu(tab.id, e.clientX, e.clientY);
    });

    wrapper.append(label, actions);
    bar.insertBefore(wrapper, addBtn);
  });
  updateFreeLimitUI();
}

function renderHiddenTray() {
  const tray   = $('hiddenTray');
  const hidden = tabs.filter(t => t.hidden);
  tray.querySelectorAll('.tray-pill').forEach(n => n.remove());
  if (!hidden.length) { tray.classList.remove('has-items'); return; }
  tray.classList.add('has-items');
  hidden.forEach(tab => {
    const pill = el('div', { class:'tray-pill', title:`Restore "${tab.name}"` });
    const dot  = el('span', { class:'tray-pill-dot' });
    const name = el('span'); name.textContent = tab.name;
    const del  = el('button', { class:'tray-pill-del', type:'button', title:'Delete' });
    del.textContent = '×';
    del.addEventListener('click',  e => { e.stopPropagation(); doDeleteTab(tab.id); });
    pill.addEventListener('click', e => { if (e.target === del) return; restoreTab(tab.id); });
    pill.append(dot, name, del);
    tray.appendChild(pill);
  });
}

function renderEditor() {
  const tab    = activeTab();
  const hasTab = !!tab && !tab.hidden;
  $('emptyState').style.display   = hasTab ? 'none' : 'flex';
  $('toolbar').style.display      = hasTab ? 'flex' : 'none';
  $('noteTextarea').style.display = hasTab ? 'flex' : 'none';
  if (!hasTab) return;
  const ta = $('noteTextarea');
  ta.value = tab.content || '';
  updateCharCount(tab.content || '');
}

function updateCharCount(text) {
  $('charCount').textContent = `${text.length.toLocaleString()} chars`;
}

// ═══════════════════════════════════════════════════════════════════
// BIND ALL
// ═══════════════════════════════════════════════════════════════════
function bindAll() {
  // Gate
  $('tabActivate').addEventListener('click', () => switchGateTab('activate'));
  $('tabBuy').addEventListener('click',      () => switchGateTab('buy'));
  $('activateBtn').addEventListener('click', doActivate);
  $('continueFreeBtn').addEventListener('click', showApp);
  $('buyBtn').addEventListener('click', () => chrome.tabs.create({ url: BUY_URL, active: true }));
  $('licKeyInput').addEventListener('keydown', e => { if (e.key === 'Enter') doActivate(); });
  // Auto-format key input: XXXX-XXXX-XXXX-XXXX
  $('licKeyInput').addEventListener('input', e => {
    let v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v.length > 4)  v = v.slice(0,4)  + '-' + v.slice(4);
    if (v.length > 9)  v = v.slice(0,9)  + '-' + v.slice(9);
    if (v.length > 14) v = v.slice(0,14) + '-' + v.slice(14);
    e.target.value = v.slice(0, 19);
  });
  $('licBadge').addEventListener('click', () => { if (isFreePlan()) openActivateGate(); });
  $('licBadge').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && isFreePlan()) {
      e.preventDefault(); openActivateGate();
    }
  });

  // Settings
  $('settingsBtn').addEventListener('click', e => { e.stopPropagation(); $('settingsPanel').classList.toggle('open'); });
  document.addEventListener('click', e => {
    if (!$('settingsPanel').contains(e.target) && e.target !== $('settingsBtn'))
      $('settingsPanel').classList.remove('open');
    if (!$('ctxMenu').contains(e.target)) closeCtxMenu();
  });
  $('themeLight').addEventListener('click', () => setTheme('light'));
  $('themeDark').addEventListener('click',  () => setTheme('dark'));
  $('sizeSmall').addEventListener('click',  () => setSize('small'));
  $('sizeMedium').addEventListener('click', () => setSize('medium'));
  $('sizeLarge').addEventListener('click',  () => setSize('large'));
  $('autoSaveToggle').addEventListener('change', e => setAutoSave(e.target.checked));
  $('sLicActivate').addEventListener('click', openActivateGate);
  $('sLicRemove').addEventListener('click', doRemoveLicense);

  // Popout
  $('popoutBtn').addEventListener('click', () => {
    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'), type: 'popup',
      width: 440, height: 620, top: 60, left: window.screen.availWidth - 460,
    });
  });

  // Tab bar
  $('addTabBtn').addEventListener('click', addTab);

  // Editor
  const ta = $('noteTextarea');
  ta.addEventListener('input', () => {
    const tab = activeTab(); if (!tab) return;
    tab.content   = ta.value;
    tab.updatedAt = Date.now();
    updateCharCount(ta.value);
    // If we had a synced state, mark it as local now (unsaved changes)
    if (cloudStatus === 'synced') updateCloudStatus('local');
    scheduleLocalSave();
    scheduleCloudSave(); // only fires if autoSave is on
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart, end = ta.selectionEnd;
      ta.value = ta.value.slice(0,s) + '  ' + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = s + 2;
    }
  });
  $('toolbar').querySelectorAll('.tool-btn[data-fmt]').forEach(btn =>
    btn.addEventListener('click', () => applyFormat(ta, btn.dataset.fmt))
  );

  // Footer
  $('exportBtn').addEventListener('click', exportNote);
  $('syncBtn').addEventListener('click',   () => syncToCloud());

  // Context menu
  $('ctxRename').addEventListener('click', () => {
    const w = $('tabBar').querySelector(`.tab[data-id="${ctxTabId}"]`);
    const t = tabs.find(x => x.id === ctxTabId);
    if (w && t) { if (ctxTabId !== activeId) switchTab(ctxTabId); beginRename(w, t); }
    closeCtxMenu();
  });
  $('ctxHide').addEventListener('click',   () => { doHideTab(ctxTabId);   closeCtxMenu(); });
  $('ctxDelete').addEventListener('click', () => { doDeleteTab(ctxTabId); closeCtxMenu(); });

  // Undo
  $('undoBtn').addEventListener('click', doUndo);
}

// ═══════════════════════════════════════════════════════════════════
// TAB MANAGEMENT
// ═══════════════════════════════════════════════════════════════════
const uid       = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const activeTab = () => tabs.find(t => t.id === activeId) || null;

function addTab() {
  if (!canAddTab()) {
    toast(`Free plan allows up to ${FREE_TAB_LIMIT} pages. Activate for unlimited pages.`);
    openActivateGate();
    return;
  }

  const id  = uid();
  const tab = { id, name:'New Tab', content:'', updatedAt: Date.now() };
  tabs.push(tab);
  activeId = id;
  scheduleLocalSave();
  renderTabs(); renderHiddenTray(); renderEditor();
  const wrapper = $('tabBar').querySelector(`.tab[data-id="${id}"]`);
  if (wrapper) beginRename(wrapper, tab);
}

function switchTab(id) {
  const ta  = $('noteTextarea'), cur = activeTab();
  if (cur && ta) { cur.content = ta.value; cur.updatedAt = Date.now(); }
  activeId = id;
  scheduleLocalSave();
  renderTabs(); renderEditor();
}

function doHideTab(id) {
  const tab = tabs.find(t => t.id === id); if (!tab) return;
  tab.hidden = true;
  if (activeId === id) activeId = tabs.find(t => !t.hidden)?.id || null;
  scheduleLocalSave(); scheduleCloudSave();
  renderTabs(); renderHiddenTray(); renderEditor();
  toast(`"${tab.name}" hidden`);
}

function restoreTab(id) {
  const tab = tabs.find(t => t.id === id); if (!tab) return;
  tab.hidden = false; activeId = id;
  scheduleLocalSave(); scheduleCloudSave();
  renderTabs(); renderHiddenTray(); renderEditor();
  toast(`"${tab.name}" restored`);
}

function doDeleteTab(id) {
  const idx = tabs.findIndex(t => t.id === id); if (idx === -1) return;
  cancelUndo();
  if (renamingTabId === id) renamingTabId = null;
  const tab = tabs[idx];
  tabs.splice(idx, 1);
  if (activeId === id) activeId = tabs.find(t => !t.hidden)?.id || null;
  scheduleLocalSave(); scheduleCloudSave();
  renderTabs(); renderHiddenTray(); renderEditor();

  // 5-second undo window
  undoStack = { tab, idx };
  undoCount = 5;
  $('undoMsg').textContent   = `"${tab.name}" deleted`;
  $('undoTimer').textContent = undoCount;
  $('undoToast').classList.add('show');
  undoInterval = setInterval(() => {
    undoCount--;
    $('undoTimer').textContent = undoCount;
    if (undoCount <= 0) cancelUndo();
  }, 1000);
}

function doUndo() {
  if (!undoStack) return;
  const { tab, idx } = undoStack;
  tabs.splice(Math.min(idx, tabs.length), 0, tab);
  activeId = tab.id;
  cancelUndo();
  scheduleLocalSave(); scheduleCloudSave();
  renderTabs(); renderHiddenTray(); renderEditor();
  toast(`"${tab.name}" restored`);
}

function cancelUndo() {
  clearInterval(undoInterval); undoInterval = null;
  $('undoToast').classList.remove('show');
  undoStack = null;
}

// ── Rename ─────────────────────────────────────────────────────────
function beginRename(wrapper, tab) {
  if (renamingTabId === tab.id) return;
  if (renamingTabId !== null) commitRename();
  renamingTabId = tab.id;
  const label = wrapper.querySelector('.tab-label'); if (!label) return;
  const input = el('input', { class:'tab-rename-input', type:'text', maxlength:'32' });
  input.value = tab.name;
  wrapper.replaceChild(input, label);
  input.focus(); input.select();
  const done = () => commitRename(input, tab, wrapper);
  input.addEventListener('blur', done);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = tab.name; input.blur(); }
  });
  input.addEventListener('click',     e => e.stopPropagation());
  input.addEventListener('mousedown', e => e.stopPropagation());
}

function commitRename(input, tab, wrapper) {
  renamingTabId = null;
  if (!input || !tab || !wrapper) { renderTabs(); return; }
  const newName = input.value.trim() || 'Untitled';
  tab.name = newName; tab.updatedAt = Date.now();
  scheduleLocalSave(); scheduleCloudSave();
  const label = el('span', { class:'tab-label' });
  label.textContent = newName;
  label.addEventListener('dblclick', e => {
    e.stopPropagation(); e.preventDefault(); beginRename(wrapper, tab);
  });
  if (wrapper.contains(input)) wrapper.replaceChild(label, input);
}

// ── Context menu ────────────────────────────────────────────────────
function openCtxMenu(id, x, y) {
  ctxTabId = id;
  const m = $('ctxMenu');
  m.style.left = x + 'px'; m.style.top = y + 'px';
  m.classList.add('open');
}
function closeCtxMenu() { $('ctxMenu').classList.remove('open'); ctxTabId = null; }

// ═══════════════════════════════════════════════════════════════════
// EDITOR ACTIONS
// ═══════════════════════════════════════════════════════════════════
function applyFormat(ta, fmt) {
  const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e);
  const m = {
    bold:['**','**'], italic:['_','_'], underline:['<u>','</u>'], code:['`','`'],
    h1:['# ',''], h2:['## ',''], ul:['- ',''], hr:['\n---\n',''],
  };
  if (!m[fmt]) return;
  const [pre, suf] = m[fmt], ins = pre + sel + suf;
  ta.value = ta.value.slice(0,s) + ins + ta.value.slice(e);
  ta.selectionStart = s; ta.selectionEnd = s + ins.length;
  ta.focus(); ta.dispatchEvent(new Event('input'));
}

function exportNote() {
  const tab = activeTab(); if (!tab) return;
  const blob = new Blob([tab.content || ''], { type:'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = el('a');
  a.href     = url;
  a.download = (tab.name.replace(/[^a-z0-9_\- ]/gi, '_') || 'note') + '.txt';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════
function $(id) { return document.getElementById(id); }

function clearChildren(n) { while (n.firstChild) n.removeChild(n.firstChild); }

function el(tag, attrs = {}) {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') n.className = v; else n.setAttribute(k, v);
  });
  return n;
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  clearChildren(btn);
  if (busy) {
    btn.appendChild(el('span', { class:'spin' }));
    btn.appendChild(document.createTextNode(' ' + label));
  } else {
    btn.textContent = label;
  }
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
