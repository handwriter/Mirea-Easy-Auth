'use strict';

// ── Single loopback redirect URI for all platforms ────────────────────────────
// launchWebAuthFlow отклоняет http:// redirect URI в Яндекс Браузере («Authorization
// page could not be loaded») и возвращает «redirect_uri not allowed» в Firefox.
// Вместо этого используем tabs-based OAuth flow для всех браузеров:
// открываем вкладку, перехватываем переход на http://127.0.0.1/ через tabs.onUpdated.
// Google принимает 127.0.0.1 через исключение для loopback-адресов.
const REDIRECT_URI = 'http://127.0.0.1/';

// ── Cross-browser tabs API (Promise-based) ────────────────────────────────────
const _tabs = (() => {
  // Firefox: browser.tabs — Promise-based
  if (typeof browser !== 'undefined' && browser.tabs) return browser.tabs;
  // Chrome / Yandex / Edge: chrome.tabs — callback-based, wrap in Promises
  return {
    create: (opts) => new Promise((res, rej) =>
      chrome.tabs.create(opts, tab => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else res(tab);
      })
    ),
    remove: (id) => new Promise(res => chrome.tabs.remove(id, () => res())),
    onUpdated: chrome.tabs.onUpdated,
    onRemoved: chrome.tabs.onRemoved,
  };
})();

const LOG = (...args) => console.log('[MireaEasyAuth BG]', ...args);
const ERR = (...args) => console.error('[MireaEasyAuth BG]', ...args);

LOG('Service worker started');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  LOG('Message received:', message.type);

  if (message.type === 'CHECK_EMAIL') {
    handleCheckEmail(message.since)
      .then(result => { LOG('CHECK_EMAIL response:', JSON.stringify(result)); sendResponse(result); })
      .catch(e => { ERR('CHECK_EMAIL error:', e.message); sendResponse({ error: String(e.message) }); });
    return true;
  }

  if (message.type === 'SIGN_IN') {
    handleSignIn(message.clientId)
      .then(result => { LOG('SIGN_IN response:', JSON.stringify(result)); sendResponse(result); })
      .catch(e => { ERR('SIGN_IN error:', e.message); sendResponse({ error: String(e.message) }); });
    return true;
  }

  return false;
});

// ── Main handler ──────────────────────────────────────────────────────────────

async function handleCheckEmail(since) {
  const settings = await getStorage(['enabled', 'clientId', 'gmailToken', 'gmailTokenExpiry', 'gmailProfile']);
  LOG('Settings loaded:', JSON.stringify({
    enabled: settings.enabled,
    hasClientId: !!settings.clientId,
    hasToken: !!settings.gmailToken,
    tokenExpiry: settings.gmailTokenExpiry,
    profile: settings.gmailProfile,
  }));

  if (settings.enabled === false) return { error: 'disabled' };
  if (!settings.clientId)        return { error: 'not_configured' };
  if (!settings.gmailToken)      return { error: 'not_signed_in' };

  // Tabs-based flow не поддерживает тихое обновление токена в фоне.
  // Если токен истёк — сообщаем пользователю войти заново через попап.
  if (!settings.gmailTokenExpiry || Date.now() > settings.gmailTokenExpiry - 60_000) {
    LOG('Token expired or close to expiry');
    await setStorage({ gmailToken: null, gmailTokenExpiry: null });
    return { error: 'token_expired' };
  }

  try {
    LOG('Calling Gmail API, since:', since);
    const code = await searchGmailCode(settings.gmailToken, since);
    LOG('Gmail search result:', code);
    return code ? { code } : { error: 'not_found' };
  } catch (e) {
    ERR('Gmail API error:', e.message);
    if (e.message === 'token_expired') {
      await setStorage({ gmailToken: null, gmailTokenExpiry: null });
      return { error: 'token_expired' };
    }
    throw e;
  }
}

// ── Gmail API ─────────────────────────────────────────────────────────────────

async function searchGmailCode(token, since) {
  const query = 'from:sso@mirea.ru newer_than:2h';
  const url =
    'https://gmail.googleapis.com/gmail/v1/users/me/messages' +
    '?q=' + encodeURIComponent(query) +
    '&maxResults=10';

  LOG('Gmail list request:', url);
  const listRes = await gmailFetch(url, token);
  LOG('Gmail list response:', JSON.stringify(listRes));

  if (!listRes.messages || listRes.messages.length === 0) {
    LOG('No messages found matching query');
    return null;
  }

  const sinceMs = since ? new Date(since).getTime() : Date.now() - 120_000;
  LOG('Filtering messages newer than:', new Date(sinceMs).toISOString());

  for (const { id } of listRes.messages) {
    const msgUrl =
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id +
      '?format=metadata&metadataHeaders=Subject&metadataHeaders=Date';

    const msg = await gmailFetch(msgUrl, token);
    const internalDate = parseInt(msg.internalDate || '0', 10);
    const headers = (msg.payload && msg.payload.headers) || [];
    const subject = (headers.find(h => h.name === 'Subject') || {}).value || '';

    LOG('Message id:', id, '| internalDate:', new Date(internalDate).toISOString(), '| subject:', subject);

    if (internalDate < sinceMs) {
      LOG('Message too old, skipping');
      continue;
    }

    const code = extractCode(subject);
    LOG('Extracted code:', code);
    if (code) return code;
  }

  return null;
}

async function gmailFetch(url, token) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  LOG('HTTP', res.status, url);
  if (res.status === 401) throw new Error('token_expired');
  if (!res.ok) throw new Error('gmail_api_error:' + res.status);
  return res.json();
}

// ── Code extraction ───────────────────────────────────────────────────────────

function extractCode(subject) {
  const m1 = subject.match(/(\d{6})\s*[–—\-]\s*ваш код/u);
  if (m1) return m1[1];
  const m2 = subject.match(/\b(\d{6})\b/);
  return m2 ? m2[1] : null;
}

// ── Sign in (called from popup via message) ───────────────────────────────────

async function handleSignIn(clientId) {
  const token = await doOAuthFlow(clientId);
  const profile = await fetchGmailProfile(token);
  await setStorage({
    gmailProfile: profile,
    gmailToken: token,
    gmailTokenExpiry: Date.now() + 3500 * 1000,
  });
  return { profile };
}

// ── OAuth flow (tabs-based, all platforms) ────────────────────────────────────

async function doOAuthFlow(clientId) {
  const scope = 'https://www.googleapis.com/auth/gmail.readonly email profile';
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth' +
    '?client_id=' + encodeURIComponent(clientId) +
    '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
    '&response_type=token' +
    '&scope=' + encodeURIComponent(scope) +
    '&prompt=select_account';

  LOG('doOAuthFlow via tabs, redirectUri=' + REDIRECT_URI);

  const redirectUrl = await oAuthWithTabs(authUrl, REDIRECT_URI);
  LOG('Redirect URL received (truncated):', redirectUrl.split('#')[0] + '#...');

  // Google возвращает токен в хеш-фрагменте: http://127.0.0.1/#access_token=...
  // Заменяем # на ? чтобы URLSearchParams мог разобрать параметры.
  const params = new URLSearchParams(new URL(redirectUrl.replace('#', '?')).search);
  const token = params.get('access_token');
  if (!token) throw new Error('Токен не получен в redirect URL');
  return token;
}

// Открывает вкладку с OAuth-страницей Google и ждёт перехода на REDIRECT_URI.
// Работает во всех браузерах: Chrome, Яндекс, Firefox Desktop, Firefox Android.
function oAuthWithTabs(authUrl, redirectUri) {
  return new Promise((resolve, reject) => {
    let authTabId = null;

    function cleanup(removeTab = true) {
      _tabs.onUpdated.removeListener(onUpdated);
      _tabs.onRemoved.removeListener(onRemoved);
      if (removeTab && authTabId !== null) {
        const id = authTabId;
        authTabId = null;
        _tabs.remove(id).catch ? _tabs.remove(id).catch(() => {}) : _tabs.remove(id);
      }
    }

    function onUpdated(tabId, changeInfo) {
      if (tabId !== authTabId) return;
      const url = changeInfo.url;
      if (!url) return;
      LOG('Tab updated url:', url.split('#')[0]);
      // Перехватываем переход на наш redirect URI
      if (url.startsWith(redirectUri) || url.includes('access_token=')) {
        cleanup(true);
        resolve(url);
      }
    }

    function onRemoved(tabId) {
      if (tabId !== authTabId) return;
      authTabId = null;
      cleanup(false);
      reject(new Error('Авторизация отменена'));
    }

    _tabs.onUpdated.addListener(onUpdated);
    _tabs.onRemoved.addListener(onRemoved);

    _tabs.create({ url: authUrl }).then(tab => {
      authTabId = tab.id;
      LOG('Opened OAuth tab id=' + authTabId);
    }).catch(e => {
      cleanup(false);
      reject(e);
    });

    // Таймаут 5 минут
    setTimeout(() => {
      cleanup(true);
      reject(new Error('Время авторизации истекло (5 мин)'));
    }, 300_000);
  });
}

async function fetchGmailProfile(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('Не удалось получить профиль: HTTP ' + res.status);
  return res.json();
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setStorage(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}
