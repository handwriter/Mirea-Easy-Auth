'use strict';

const LOG = (...args) => console.log('[MireaEasyAuth]', ...args);
const ERR = (...args) => console.error('[MireaEasyAuth]', ...args);

LOG('Content script loaded. URL:', location.href);
LOG('document.readyState:', document.readyState);
LOG('document.body exists:', !!document.body);

// Page 1: email code entry
waitForElement('#emailCode', 10000).then(emailInput => {
  if (emailInput) {
    LOG('#emailCode found, starting email-code flow');
    init(emailInput);
  }
});

// Page 2: MAX messenger skip page
waitForElement('#kc-max-otp-buttons-form', 10000).then(form => {
  if (form) {
    LOG('#kc-max-otp-buttons-form found, checking autoSkip setting...');
    chrome.storage.local.get(['enabled', 'autoSkip'], data => {
      if (data.enabled === false) return LOG('Extension disabled, skip skipping');
      if (data.autoSkip === false) return LOG('autoSkip is off, doing nothing');

      const skipBtn = form.querySelector('input[name="skip"][type="submit"]');
      LOG('Skip button found:', !!skipBtn);
      if (skipBtn) {
        LOG('Clicking "Пропустить"...');
        skipBtn.click();
      }
    });
  }
});

function waitForElement(selector, timeoutMs) {
  return new Promise(resolve => {
    const existing = document.querySelector(selector);
    if (existing) {
      LOG('waitForElement: found immediately');
      return resolve(existing);
    }

    LOG('waitForElement: element not yet in DOM, starting MutationObserver...');

    const root = document.body || document.documentElement;
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        LOG('waitForElement: MutationObserver found', selector);
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(root, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      LOG('waitForElement: timed out after', timeoutMs, 'ms');
      resolve(null);
    }, timeoutMs);
  });
}

function init(emailInput) {
  LOG('init() started');

  const POLL_INTERVAL_MS = 3000;
  const TIMEOUT_MS = 90000;
  const startTime = new Date().toISOString();
  LOG('startTime:', startTime);

  let pollTimer = null;
  let elapsed = 0;
  let done = false;

  const overlay = createOverlay();
  document.body.appendChild(overlay);
  LOG('Overlay appended to DOM');

  setStatus('Ожидание кода из письма…', 'waiting');
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);

  function poll() {
    if (done) return;

    elapsed += POLL_INTERVAL_MS;
    if (elapsed > TIMEOUT_MS) {
      clearInterval(pollTimer);
      setStatus('Время ожидания истекло. Введите код вручную.', 'error');
      return;
    }

    LOG('Sending CHECK_EMAIL to background, since:', startTime);

    chrome.runtime.sendMessage({ type: 'CHECK_EMAIL', since: startTime }, response => {
      if (done) return;

      if (chrome.runtime.lastError) {
        ERR('sendMessage error:', chrome.runtime.lastError.message);
        return;
      }

      LOG('Response from background:', JSON.stringify(response));

      if (!response) {
        ERR('Response is null/undefined');
        return;
      }

      if (response.error) {
        if (response.error === 'disabled') {
          clearInterval(pollTimer);
          overlay.remove();
          return;
        }
        if (response.error === 'not_configured') {
          clearInterval(pollTimer);
          setStatus('Укажите Client ID в расширении MireaEasyAuth', 'error');
          return;
        }
        if (response.error === 'not_signed_in') {
          clearInterval(pollTimer);
          setStatus('Войдите в Gmail в расширении MireaEasyAuth', 'error');
          return;
        }
        if (response.error === 'token_expired') {
          clearInterval(pollTimer);
          setStatus('Сессия Gmail истекла — войдите снова в попапе расширения', 'error');
          return;
        }
        if (response.error === 'not_found') {
          LOG('Email not found yet, will retry in', POLL_INTERVAL_MS, 'ms');
          return;
        }
        ERR('Unknown error from background:', response.error);
        return;
      }

      if (response.code) {
        done = true;
        clearInterval(pollTimer);
        LOG('Code received:', response.code);
        fillCode(response.code);
      }
    });
  }

  function fillCode(code) {
    setStatus('Код получен: ' + code + '. Отправка…', 'success');

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(emailInput, code);
    emailInput.dispatchEvent(new Event('input', { bubbles: true }));
    emailInput.dispatchEvent(new Event('change', { bubbles: true }));
    LOG('Code filled into #emailCode');

    setTimeout(() => {
      const form = document.getElementById('kc-otp-login-form');
      LOG('Form found:', !!form);
      if (form) {
        const submitBtn = form.querySelector('button[type="submit"]');
        LOG('Submit button found:', !!submitBtn);
        if (submitBtn) {
          submitBtn.click();
        } else {
          form.submit();
        }
      }
      setTimeout(() => overlay.remove(), 1500);
    }, 600);
  }

  function createOverlay() {
    const el = document.createElement('div');
    el.id = 'mirea-easy-auth-overlay';
    el.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 99999;
      background: #003087; color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; padding: 10px 16px; border-radius: 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      display: flex; align-items: center; gap: 10px; max-width: 280px;
      transition: background 0.3s;
    `;
    el.innerHTML = `
      <span id="mirea-auth-spinner" style="
        width:14px;height:14px;border:2px solid rgba(255,255,255,0.4);
        border-top-color:#fff;border-radius:50%;
        animation:mirea-spin 0.8s linear infinite;flex-shrink:0;
      "></span>
      <span id="mirea-auth-text"></span>
      <style>@keyframes mirea-spin{to{transform:rotate(360deg)}}</style>
    `;
    return el;
  }

  function setStatus(text, state) {
    const textEl = overlay.querySelector('#mirea-auth-text');
    const spinner = overlay.querySelector('#mirea-auth-spinner');
    if (textEl) textEl.textContent = text;
    if (state === 'success') {
      overlay.style.background = '#1e7e34';
      if (spinner) spinner.style.display = 'none';
    } else if (state === 'error') {
      overlay.style.background = '#c62828';
      if (spinner) spinner.style.display = 'none';
    } else {
      overlay.style.background = '#003087';
      if (spinner) spinner.style.display = '';
    }
  }
}
