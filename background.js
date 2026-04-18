'use strict';

// ── OAuth redirect URI (loopback, принимается Google без регистрации порта) ───
const REDIRECT_URI = 'http://127.0.0.1/';

// ── Cross-browser tabs API (Promise-based) ────────────────────────────────────
const _tabs = (() => {
  if (typeof browser !== 'undefined' && browser.tabs) return browser.tabs;
  return {
    create:    (opts) => new Promise((res, rej) =>
      chrome.tabs.create(opts, tab => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else res(tab);
      })
    ),
    remove:    (id)   => new Promise(res => chrome.tabs.remove(id, () => res())),
    onUpdated: chrome.tabs.onUpdated,
    onRemoved: chrome.tabs.onRemoved,
  };
})();

const LOG = (...args) => console.log('[MireaEasyAuth BG]', ...args);
const ERR = (...args) => console.error('[MireaEasyAuth BG]', ...args);

LOG('Service worker started');

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  LOG('Message received:', message.type);

  if (message.type === 'CHECK_EMAIL') {
    handleCheckEmail(message.since, message.codeId)
      .then(r  => { LOG('CHECK_EMAIL ok:', JSON.stringify(r)); sendResponse(r); })
      .catch(e => { ERR('CHECK_EMAIL err:', e.message);        sendResponse({ error: String(e.message) }); });
    return true;
  }

  if (message.type === 'DELETE_EMAIL') {
    handleDeleteEmail(message.messageId)
      .then(r  => { LOG('DELETE_EMAIL ok:', JSON.stringify(r)); sendResponse(r); })
      .catch(e => { ERR('DELETE_EMAIL err:', e.message);        sendResponse({ error: String(e.message) }); });
    return true;
  }

  if (message.type === 'SIGN_IN') {
    handleSignIn(message.clientId, message.clientSecret)
      .then(r  => { LOG('SIGN_IN ok:', JSON.stringify(r)); sendResponse(r); })
      .catch(e => { ERR('SIGN_IN err:', e.message);        sendResponse({ error: String(e.message) }); });
    return true;
  }

  return false;
});

// ── Check email ───────────────────────────────────────────────────────────────

async function handleCheckEmail(since, codeId) {
  const s = await getStorage(['enabled', 'clientId', 'clientSecret', 'gmailToken', 'gmailTokenExpiry', 'gmailRefreshToken']);

  if (s.enabled === false) return { error: 'disabled' };
  if (!s.clientId)         return { error: 'not_configured' };
  if (!s.gmailToken)       return { error: 'not_signed_in' };

  let token = s.gmailToken;

  // Тихое обновление токена когда он истёк (или истекает в ближайшие 60 сек)
  if (!s.gmailTokenExpiry || Date.now() > s.gmailTokenExpiry - 60_000) {
    if (!s.gmailRefreshToken || !s.clientSecret) {
      await setStorage({ gmailToken: null, gmailTokenExpiry: null });
      return { error: 'token_expired' };
    }
    try {
      LOG('Access token expired — silent refresh via refresh_token...');
      token = await refreshAccessToken(s.gmailRefreshToken, s.clientId, s.clientSecret);
      await setStorage({ gmailToken: token, gmailTokenExpiry: Date.now() + 3500 * 1000 });
      LOG('Silent refresh OK');
    } catch (e) {
      ERR('Silent refresh failed:', e.message);
      await setStorage({ gmailToken: null, gmailTokenExpiry: null, gmailRefreshToken: null });
      return { error: 'token_expired' };
    }
  }

  try {
    LOG('Calling Gmail API, since:', since, 'codeId:', codeId);
    const result = await searchGmailCode(token, since, codeId);
    LOG('Gmail search result:', result);
    return result ? { code: result.code, messageId: result.messageId } : { error: 'not_found' };
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

async function searchGmailCode(token, since, codeId) {
  const sinceMs = since ? new Date(since).getTime() : Date.now() - 120_000;
  const afterSec = Math.floor(sinceMs / 1000);

  const url =
    'https://gmail.googleapis.com/gmail/v1/users/me/messages' +
    '?q=' + encodeURIComponent('from:sso@mirea.ru after:' + afterSec) +
    '&maxResults=10';

  const listRes = await gmailFetch(url, token);
  if (!listRes.messages || listRes.messages.length === 0) return null;

  for (const { id } of listRes.messages) {
    const msg = await gmailFetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id +
      '?format=metadata&metadataHeaders=Subject', token
    );
    const internalDate = parseInt(msg.internalDate || '0', 10);
    if (internalDate < sinceMs) continue;

    const subject = ((msg.payload?.headers || []).find(h => h.name === 'Subject') || {}).value || '';
    LOG('id:', id, 'date:', new Date(internalDate).toISOString(), 'subj:', subject);

    if (codeId && !subject.includes(codeId)) {
      LOG('codeId', codeId, 'not found in subject, skipping');
      continue;
    }

    const code = extractCode(subject);
    if (code) return { code, messageId: id };
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

function extractCode(subject) {
  const m1 = subject.match(/(\d{6})\s*[–—\-]\s*ваш код/u);
  if (m1) return m1[1];
  const m2 = subject.match(/\b(\d{6})\b/);
  return m2 ? m2[1] : null;
}

// ── Delete email ─────────────────────────────────────────────────────────────

async function handleDeleteEmail(messageId) {
  const s = await getStorage(['gmailToken', 'gmailTokenExpiry', 'gmailRefreshToken', 'clientId', 'clientSecret']);
  let token = s.gmailToken;

  if (!token) return { error: 'not_signed_in' };

  if (!s.gmailTokenExpiry || Date.now() > s.gmailTokenExpiry - 60_000) {
    if (!s.gmailRefreshToken || !s.clientSecret) return { error: 'token_expired' };
    try {
      token = await refreshAccessToken(s.gmailRefreshToken, s.clientId, s.clientSecret);
      await setStorage({ gmailToken: token, gmailTokenExpiry: Date.now() + 3500 * 1000 });
    } catch (e) {
      return { error: 'token_expired' };
    }
  }

  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + messageId + '/trash',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token } }
  );
  LOG('TRASH message', messageId, 'HTTP', res.status);
  if (res.ok) return { ok: true };
  throw new Error('gmail_trash_error:' + res.status);
}

// ── Sign in ───────────────────────────────────────────────────────────────────

async function handleSignIn(clientId, clientSecret) {
  const tokens  = await doOAuthFlow(clientId, clientSecret);
  const profile = await fetchGmailProfile(tokens.access_token);
  await setStorage({
    gmailProfile:      profile,
    gmailToken:        tokens.access_token,
    gmailTokenExpiry:  Date.now() + (tokens.expires_in ?? 3500) * 1000,
    gmailRefreshToken: tokens.refresh_token ?? null,
  });
  return { profile };
}

// ── OAuth: Authorization Code + PKCE ─────────────────────────────────────────
// Преимущество перед implicit flow: Google возвращает refresh_token,
// который позволяет тихо обновлять access_token без участия пользователя.

async function doOAuthFlow(clientId, clientSecret) {
  const { verifier, challenge } = await generatePKCE();

  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth' +
    '?client_id='             + encodeURIComponent(clientId) +
    '&redirect_uri='          + encodeURIComponent(REDIRECT_URI) +
    '&response_type=code' +
    '&scope='                 + encodeURIComponent('https://www.googleapis.com/auth/gmail.modify email profile') +
    '&code_challenge='        + challenge +
    '&code_challenge_method=S256' +
    '&access_type=offline' +   // запросить refresh_token
    '&prompt=consent';         // всегда возвращать refresh_token (даже при повторном входе)

  LOG('doOAuthFlow PKCE, redirectUri=' + REDIRECT_URI);
  const redirectUrl = await oAuthWithTabs(authUrl, REDIRECT_URI);

  const params = new URL(redirectUrl).searchParams;
  const error  = params.get('error');
  const code   = params.get('code');

  if (error) throw new Error('oauth_error: ' + error);
  if (!code) throw new Error('Код авторизации не получен');

  return exchangeCodeForTokens(code, verifier, clientId, clientSecret);
}

// PKCE helpers
async function generatePKCE() {
  const array    = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = base64url(array);
  const digest   = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

function base64url(buf) {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Обмен кода на токены
async function exchangeCodeForTokens(code, verifier, clientId, clientSecret) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('token_exchange_failed: ' + (err.error_description || err.error || res.status));
  }
  const data = await res.json();
  LOG('Token exchange OK, has refresh_token:', !!data.refresh_token);
  return data; // { access_token, refresh_token, expires_in, ... }
}

// Тихое обновление access token через refresh token
async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('refresh_failed: ' + (err.error_description || err.error || res.status));
  }
  const data = await res.json();
  return data.access_token;
}

// ── Tabs-based OAuth window ───────────────────────────────────────────────────

function oAuthWithTabs(authUrl, redirectUri) {
  return new Promise((resolve, reject) => {
    let authTabId = null;

    function cleanup(removeTab = true) {
      _tabs.onUpdated.removeListener(onUpdated);
      _tabs.onRemoved.removeListener(onRemoved);
      if (removeTab && authTabId !== null) {
        const id = authTabId;
        authTabId = null;
        _tabs.remove(id).catch?.(() => {});
      }
    }

    function onUpdated(tabId, changeInfo) {
      if (tabId !== authTabId || !changeInfo.url) return;
      const url = changeInfo.url;
      // Auth code flow: редирект содержит ?code= или ?error= в query string
      if (url.startsWith(redirectUri) && (url.includes('code=') || url.includes('error='))) {
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
    }).catch(e => { cleanup(false); reject(e); });

    setTimeout(() => {
      cleanup(true);
      reject(new Error('Время авторизации истекло (5 мин)'));
    }, 300_000);
  });
}

// ── Profile & storage ─────────────────────────────────────────────────────────

async function fetchGmailProfile(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('Не удалось получить профиль: HTTP ' + res.status);
  return res.json();
}

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setStorage(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}
