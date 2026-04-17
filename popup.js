'use strict';

// ── Single loopback redirect URI for all platforms ────────────────────────────
const REDIRECT_URI = 'http://127.0.0.1/';

const $ = id => document.getElementById(id);

$('redirectUriHint').textContent = REDIRECT_URI;

// ── Status ────────────────────────────────────────────────────────────────────
function showStatus(msg, type = 'info') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + type;
  if (type !== 'info') setTimeout(() => { el.className = 'status'; }, 4000);
}

// ── UI state ──────────────────────────────────────────────────────────────────
function showSignedIn(profile) {
  $('accountCard').style.display = 'flex';
  $('toggleRow').style.display = 'flex';
  $('skipToggleRow').style.display = 'flex';
  $('btnSignOut').style.display = '';
  $('signinBlock').style.display = 'none';
  $('accountName').textContent = profile.name || profile.email;
  $('accountEmail').textContent = profile.email;
  $('accountInitial').textContent = (profile.name || profile.email || '?')[0].toUpperCase();
}

function showSignedOut() {
  $('accountCard').style.display = 'none';
  $('toggleRow').style.display = 'none';
  $('skipToggleRow').style.display = 'none';
  $('btnSignOut').style.display = 'none';
  $('signinBlock').style.display = 'flex';
}

// ── Load saved state ──────────────────────────────────────────────────────────
chrome.storage.local.get(['clientId', 'enabled', 'autoSkip', 'gmailProfile'], data => {
  if (data.clientId) $('clientId').value = data.clientId;
  $('enabled').checked = data.enabled !== false;
  $('autoSkip').checked = data.autoSkip !== false;
  data.gmailProfile ? showSignedIn(data.gmailProfile) : showSignedOut();
});

// ── Toggles ───────────────────────────────────────────────────────────────────
$('enabled').addEventListener('change', () => chrome.storage.local.set({ enabled: $('enabled').checked }));
$('autoSkip').addEventListener('change', () => chrome.storage.local.set({ autoSkip: $('autoSkip').checked }));

// ── Sign in ───────────────────────────────────────────────────────────────────
// OAuth flow runs in background.js so it survives popup close in Firefox.
$('btnSignIn').addEventListener('click', () => {
  const clientId = $('clientId').value.trim();
  if (!clientId) { showStatus('Введите Client ID', 'err'); return; }

  chrome.storage.local.set({ clientId });
  showStatus('Открываю авторизацию…', 'info');
  $('btnSignIn').disabled = true;

  chrome.runtime.sendMessage({ type: 'SIGN_IN', clientId }, response => {
    $('btnSignIn').disabled = false;

    // If popup was closed during OAuth and just reopened, sendMessage callback
    // may not fire. On next open, storage load above will restore state.
    if (chrome.runtime.lastError) {
      // Check storage in case sign-in succeeded while popup was closed
      chrome.storage.local.get(['gmailProfile'], data => {
        if (data.gmailProfile) { showSignedIn(data.gmailProfile); showStatus('Авторизация успешна!', 'ok'); }
        else showStatus('Ошибка связи с фоном расширения', 'err');
      });
      return;
    }

    if (!response || response.error) {
      showStatus('Ошибка: ' + (response?.error || 'нет ответа'), 'err');
      return;
    }

    showSignedIn(response.profile);
    showStatus('Авторизация успешна!', 'ok');
  });
});

// ── Sign out ──────────────────────────────────────────────────────────────────
$('btnSignOut').addEventListener('click', () => {
  chrome.storage.local.remove(['gmailProfile', 'gmailToken', 'gmailTokenExpiry']);
  showSignedOut();
  showStatus('Вы вышли из аккаунта', 'info');
});
