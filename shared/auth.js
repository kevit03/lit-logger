// Accounts for LIT.
//
// Two kinds of account, so entries stay separate per person:
//   provider 'google'  real Google sign-in, available once the owner configures
//                      an OAuth client (see WEB_CLIENT_ID and the README).
//   provider 'local'   a profile kept on this computer only. No Google, no
//                      password, no server; just a name that keys the data.
const TrackerAuth = (() => {
  const AUTH_KEY = 'pt_auth_user';

  // chrome.storage.sync carries the signed-in account across devices; falls
  // back to local (and then a localStorage shim) when sync is unavailable.
  function getStorageArea() {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      if (chrome.storage.sync) return chrome.storage.sync;
      if (chrome.storage.local) return chrome.storage.local;
    }
    return {
      get: (keys, cb) => {
        const res = {};
        keys.forEach(k => {
          const val = localStorage.getItem(k);
          if (val) {
            try { res[k] = JSON.parse(val); } catch (e) { res[k] = val; }
          }
        });
        cb(res);
      },
      set: (items, cb) => {
        Object.entries(items).forEach(([k, v]) => {
          localStorage.setItem(k, JSON.stringify(v));
        });
        if (cb) cb();
      }
    };
  }

  // A device upgrading from a local-only build still has its session sitting
  // in chrome.storage.local; sync starts out empty until this runs once. Only
  // copies when sync has nothing yet, so it never clobbers a session another
  // device already synced in.
  let authMigrated = false;
  async function migrateFromLocalIfNeeded() {
    if (authMigrated) return;
    authMigrated = true;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync || !chrome.storage.local) return;
    try {
      const syncResult = await new Promise(r => chrome.storage.sync.get([AUTH_KEY], r));
      if (syncResult && syncResult[AUTH_KEY] !== undefined) return;
      const localResult = await new Promise(r => chrome.storage.local.get([AUTH_KEY], r));
      if (localResult && localResult[AUTH_KEY] !== undefined) {
        await new Promise(r => chrome.storage.sync.set({ [AUTH_KEY]: localResult[AUTH_KEY] }, r));
      }
    } catch (e) {
      // Best effort: sync simply starts signed out if this fails.
    }
  }

  // Google's userinfo endpoint doubles as the token validity check: a 401
  // means the cached token has expired or been revoked.
  const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
  const OAUTH_SCOPES = ['openid', 'email', 'profile'];

  // Google sign-in is off until the owner configures an OAuth client. Two ways,
  // either is enough (README, "Turning on Google sign-in"):
  //
  //   1. An "oauth2" block in manifest.json with a Chrome Extension client ID.
  //      Uses chrome.identity.getAuthToken: the account Chrome is signed into,
  //      no extra window. Chrome only.
  //   2. WEB_CLIENT_ID below, a "Web application" client whose redirect URI is
  //      https://<extension-id>.chromiumapp.org/. Uses launchWebAuthFlow: a
  //      Google sign-in window, any account, works in Edge and Brave too.
  //
  // Without either, there is no Google sign-in at all. The fallback is a
  // local profile kept on this computer, and it says so.
  let WEB_CLIENT_ID = '';

  function hasIdentityApi() {
    return typeof chrome !== 'undefined' && !!chrome.identity && typeof chrome.identity.getAuthToken === 'function';
  }

  function manifestClientId() {
    try {
      const m = chrome.runtime.getManifest();
      const id = m && m.oauth2 && m.oauth2.client_id;
      return typeof id === 'string' && /\.apps\.googleusercontent\.com$/.test(id.trim()) ? id.trim() : '';
    } catch (e) {
      return '';
    }
  }

  // 'chrome' (getAuthToken), 'web' (launchWebAuthFlow), or '' (not set up).
  function oauthMethod() {
    if (typeof chrome === 'undefined' || !chrome.identity) return '';
    if (manifestClientId() && hasIdentityApi()) return 'chrome';
    if (WEB_CLIENT_ID && typeof chrome.identity.launchWebAuthFlow === 'function') return 'web';
    return '';
  }

  function getAuthToken(interactive) {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: !!interactive }, t => {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          // Newer Chrome resolves an object ({ token }), older a string.
          resolve((t && typeof t === 'object' ? t.token : t) || null);
        }
      });
    });
  }

  function webAuthUrl(interactive) {
    const redirect = chrome.identity.getRedirectURL();
    const params = new URLSearchParams({
      client_id: WEB_CLIENT_ID,
      response_type: 'token',
      redirect_uri: redirect,
      scope: OAUTH_SCOPES.join(' '),
      include_granted_scopes: 'true',
      prompt: interactive ? 'select_account' : 'none'
    });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  }

  // Implicit flow: the access token comes back in the redirect's fragment.
  function launchWebAuth(interactive) {
    return new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url: webAuthUrl(interactive), interactive: !!interactive }, responseUrl => {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const hash = String(responseUrl || '').split('#')[1] || '';
        const params = new URLSearchParams(hash);
        if (params.get('error')) {
          reject(new Error(params.get('error')));
          return;
        }
        resolve(params.get('access_token') || null);
      });
    });
  }

  function requestToken(interactive, method) {
    const how = method || oauthMethod();
    if (how === 'chrome') return getAuthToken(interactive);
    if (how === 'web') return launchWebAuth(interactive);
    return Promise.reject(new Error('Google sign-in is not set up in this build.'));
  }

  function removeCachedToken(token) {
    return new Promise(resolve => {
      if (!token || !hasIdentityApi() || typeof chrome.identity.removeCachedAuthToken !== 'function') {
        resolve();
        return;
      }
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
  }

  // Resolves the Google profile, or null when the token is rejected (401).
  // Any other failure throws, so a network blip is never mistaken for expiry.
  async function fetchProfile(token) {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error('Google userinfo request failed with HTTP ' + res.status);
    return res.json();
  }

  function profileToUser(info, token, method) {
    return {
      email: info.email,
      name: info.name || info.email.split('@')[0],
      picture: info.picture || '',
      token,
      provider: 'google',
      method: method || 'chrome'
    };
  }

  // A local profile is keyed like an account so entries stay separate, but
  // nothing about it touches Google. A plain name becomes "<name>@local".
  const LOCAL_DOMAIN = 'local';

  function localKeyFor(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (text.includes('@')) return /^[^@\s]+@[^@\s]+$/.test(text) ? text.toLowerCase() : '';
    const slug = text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return slug ? slug + '@' + LOCAL_DOMAIN : '';
  }

  // Kept as EMAIL_REQUIRED so existing callers keep working; the message is
  // honest about what the fallback is.
  function emailRequiredError() {
    const err = new Error('Google sign-in is not set up in this build. Use a profile on this computer instead.');
    err.code = 'EMAIL_REQUIRED';
    err.mode = 'local';
    return err;
  }

  return {
    async getCurrentUser() {
      await migrateFromLocalIfNeeded();
      return new Promise(resolve => {
        getStorageArea().get([AUTH_KEY], result => {
          resolve(result[AUTH_KEY] || null);
        });
      });
    },

    // 'google' when a real Google sign-in is configured, otherwise 'local'.
    // The popup uses this to label the button honestly.
    signInMode() {
      return oauthMethod() ? 'google' : 'local';
    },

    isGoogleConfigured() {
      return !!oauthMethod();
    },

    // A profile on this computer only. Accepts an email or a plain name; data
    // is kept separately per profile. Nothing is sent anywhere.
    async signInLocal(rawNameOrEmail) {
      const key = localKeyFor(rawNameOrEmail);
      if (!key) throw new Error('Enter a name or email for this profile');
      const label = String(rawNameOrEmail).trim();
      const user = {
        email: key,
        name: label.includes('@') ? label.split('@')[0] : label,
        provider: 'local'
      };
      await this.setUser(user);
      return user;
    },

    // Older name for the local profile path, kept for callers that collect an
    // email. It does not sign into Google; the profile is local.
    async signInWithEmail(rawEmail) {
      const email = (rawEmail || '').trim();
      if (!email || !email.includes('@')) {
        throw new Error('Valid email required for sign-in');
      }
      return this.signInLocal(email);
    },

    // Real Google sign-in when configured. Otherwise: options.allowPrompt ===
    // false throws EMAIL_REQUIRED so the caller can offer a local profile
    // with its own dialog; without it, window.prompt asks for a profile name.
    async signInWithGoogle(customEmail, options) {
      const opts = options || {};

      // An explicit email is a request for the local path: the caller has
      // already collected it, so do not raise a Google window.
      if (customEmail) return this.signInWithEmail(customEmail);

      const method = oauthMethod();
      if (method) {
        let token = await requestToken(true, method);
        let info = token ? await fetchProfile(token) : null;
        if (token && !info) {
          // A stale cached token. Evict it and ask again so the user is not
          // left signed in against a dead session.
          await removeCachedToken(token);
          token = await requestToken(true, method);
          info = token ? await fetchProfile(token) : null;
        }
        if (info && info.email) {
          const user = profileToUser(info, token, method);
          await this.setUser(user);
          return user;
        }
        throw new Error('Google did not return an account. Try again.');
      }

      if (opts.allowPrompt === false) throw emailRequiredError();
      const raw = typeof prompt === 'function'
        ? prompt('Google sign-in is not set up in this build. Name a profile for this computer (for example, your first name):')
        : '';
      return this.signInLocal(raw);
    },

    // Quick validity check for a stored Google session, meant for popup open.
    // A local profile has no token and is returned as-is. On a 401 the cached
    // token is evicted and Google is asked again interactively; if that is
    // declined, the account is kept (its entries are still scoped to the
    // email) but the dead token is dropped and sessionExpired is set.
    async ensureValidSession() {
      const user = await this.getCurrentUser();
      if (!user || !user.token) return user;

      let info;
      try {
        info = await fetchProfile(user.token);
      } catch (err) {
        // Offline or Google unreachable is not evidence of expiry; leave it.
        return user;
      }
      if (info) return user;

      // Confirmed expired. A rejected re-prompt here means the user declined,
      // which must not be confused with the network guard above.
      await removeCachedToken(user.token);
      const method = oauthMethod();
      let token = null;
      if (method) {
        try {
          token = await requestToken(true, method);
          info = token ? await fetchProfile(token) : null;
        } catch (err) {
          info = null;
        }
      }
      if (info && info.email) {
        const refreshed = profileToUser(info, token, method);
        await this.setUser(refreshed);
        return refreshed;
      }

      const kept = Object.assign({}, user, { sessionExpired: true });
      delete kept.token;
      await this.setUser(kept);
      return kept;
    },

    async setUser(user) {
      if (user && user.email) {
        user.email = user.email.toLowerCase().trim();
      }
      return new Promise(resolve => {
        getStorageArea().set({ [AUTH_KEY]: user }, () => {
          resolve(user);
        });
      });
    },

    async signOut() {
      const user = await this.getCurrentUser();
      if (user && user.token && typeof chrome !== 'undefined' && chrome.identity && chrome.identity.removeCachedAuthToken) {
        chrome.identity.removeCachedAuthToken({ token: user.token }, () => {});
      }
      return new Promise(resolve => {
        getStorageArea().set({ [AUTH_KEY]: null }, () => {
          resolve(true);
        });
      });
    },

    // Test seam for the launchWebAuthFlow path.
    _setWebClientId(id) {
      WEB_CLIENT_ID = typeof id === 'string' ? id : '';
    },

    _localKeyFor: localKeyFor,

    onAuthChanged(cb) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if ((area === 'sync' || area === 'local') && changes[AUTH_KEY]) {
            cb(changes[AUTH_KEY].newValue || null);
          }
        });
      }
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrackerAuth;
}
