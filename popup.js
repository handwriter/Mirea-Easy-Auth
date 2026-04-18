'use strict';

// ── Дефолтные OAuth credentials (Desktop app, client_secret не конфиденциален) ─
// Пользователь может заменить их своими в полях ниже.
const DEFAULT_CLIENT_ID     = '290262895166-2cir7hbf8i30l6md6qtemta6pa9fc28a.apps.googleusercontent.com';
const DEFAULT_CLIENT_SECRET = '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';

const $ = id => document.getElementById(id);

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
chrome.storage.local.get(['clientId', 'clientSecret', 'enabled', 'autoSkip', 'gmailProfile'], data => {
  $('clientId').value     = data.clientId     || DEFAULT_CLIENT_ID;
  $('clientSecret').value = data.clientSecret || DEFAULT_CLIENT_SECRET;
  $('enabled').checked  = data.enabled  !== false;
  $('autoSkip').checked = data.autoSkip !== false;
  data.gmailProfile ? showSignedIn(data.gmailProfile) : showSignedOut();
});

// ── Toggles ───────────────────────────────────────────────────────────────────
$('enabled').addEventListener('change',  () => chrome.storage.local.set({ enabled:   $('enabled').checked }));
$('autoSkip').addEventListener('change', () => chrome.storage.local.set({ autoSkip: $('autoSkip').checked }));

// ── Sign in ───────────────────────────────────────────────────────────────────
$('btnSignIn').addEventListener('click', () => {
  const clientId     = $('clientId').value.trim();
  const clientSecret = $('clientSecret').value.trim();
  if (!clientId)     { showStatus('Введите Client ID', 'err');     return; }
  if (!clientSecret) { showStatus('Введите Client Secret', 'err'); return; }

  chrome.storage.local.set({ clientId, clientSecret });
  showStatus('Открываю авторизацию…', 'info');
  $('btnSignIn').disabled = true;

  chrome.runtime.sendMessage({ type: 'SIGN_IN', clientId, clientSecret }, response => {
    $('btnSignIn').disabled = false;

    if (chrome.runtime.lastError) {
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
  chrome.storage.local.remove(['gmailProfile', 'gmailToken', 'gmailTokenExpiry', 'gmailRefreshToken']);
  showSignedOut();
  showStatus('Вы вышли из аккаунта', 'info');
});
