// Accounts: real Google sign-in once an OAuth client is configured, an honest
// local profile otherwise, session renewal, and token eviction.
const assert = require('assert');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');

const CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';

// options.oauth2: true pairs a Chrome Extension client in the manifest.
function getFreshAuth(initialStore = {}, options = {}) {
  const mock = installMockChrome(initialStore);
  mock.runtime.getManifest = () => (options.oauth2 ? { oauth2: { client_id: CLIENT_ID, scopes: ['openid', 'email', 'profile'] } } : {});
  delete require.cache[require.resolve('../shared/auth')];
  const TrackerAuth = require('../shared/auth');
  global.TrackerAuth = TrackerAuth;
  return { mock, TrackerAuth };
}

async function run() {
  console.log('--- Running test/auth.test.js ---');

  // 1. Initial State
  {
    const { TrackerAuth } = getFreshAuth();
    const user = await TrackerAuth.getCurrentUser();
    assert.strictEqual(user, null, 'Initial user should be null');

    console.log('[PASS] Initial unauthenticated state');
    delete global.TrackerAuth;
    uninstallMockChrome();
  }

  // 2. Direct Email Sign-In and Normalization
  {
    const { TrackerAuth } = getFreshAuth();

    // Uppercase email with whitespace
    const signedIn = await TrackerAuth.signInWithGoogle('  John.Doe@EXAMPLE.COM  ');
    assert.ok(signedIn);
    assert.strictEqual(signedIn.email, 'john.doe@example.com', 'Email must be trimmed and lowercased');
    assert.strictEqual(signedIn.provider, 'local', 'an email typed in is a local profile, not a Google sign-in');

    // Retrieve current user
    const current = await TrackerAuth.getCurrentUser();
    assert.deepStrictEqual(current, signedIn);

    // Invalid email rejection
    await assert.rejects(async () => {
      await TrackerAuth.signInWithGoogle('invalid-email-no-at');
    }, /Valid email required/);

    await assert.rejects(async () => {
      await TrackerAuth.signInWithGoogle('   ');
    }, /Valid email required/);

    console.log('[PASS] Local profile from an email: normalized and labeled local');
    delete global.TrackerAuth;
    uninstallMockChrome();
  }

  // 3. OAuth Identity Sign-In Flow with UserInfo
  {
    const { mock, TrackerAuth } = getFreshAuth({}, { oauth2: true });

    // Mock global fetch for Google UserInfo API
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          json: async () => ({
            email: 'Alice.Smith@Gmail.Com',
            name: 'Alice Smith',
            picture: 'https://example.com/alice.jpg'
          })
        };
      }
      return { ok: false, status: 404 };
    };

    try {
      mock.identity.tokenToReturn = 'valid-google-oauth-token-999';
      const user = await TrackerAuth.signInWithGoogle();
      assert.ok(user);
      assert.strictEqual(user.email, 'alice.smith@gmail.com');
      assert.strictEqual(user.name, 'Alice Smith');
      assert.strictEqual(user.picture, 'https://example.com/alice.jpg');
      assert.strictEqual(user.token, 'valid-google-oauth-token-999');
      assert.strictEqual(user.provider, 'google');
      assert.strictEqual(user.method, 'chrome');
      assert.strictEqual(TrackerAuth.signInMode(), 'google', 'a paired manifest turns Google sign-in on');

      const currentUser = await TrackerAuth.getCurrentUser();
      assert.strictEqual(currentUser.email, 'alice.smith@gmail.com');
    } finally {
      global.fetch = originalFetch;
    }

    console.log('[PASS] OAuth Identity sign-in flow');
    delete global.TrackerAuth;
    uninstallMockChrome();
  }

  // 3b. A stale cached token (401 from userinfo) is evicted and re-requested
  {
    const { mock, TrackerAuth } = getFreshAuth({}, { oauth2: true });
    const originalFetch = global.fetch;
    const seenTokens = [];
    global.fetch = async (url, opts) => {
      const token = opts.headers.Authorization.replace('Bearer ', '');
      seenTokens.push(token);
      if (token === 'stale-token-1') return { ok: false, status: 401 };
      return { ok: true, status: 200, json: async () => ({ email: 'bob@gmail.com', name: 'Bob' }) };
    };

    try {
      mock.identity.tokenToReturn = 'stale-token-1';
      // The second getAuthToken call must hand back a fresh token.
      const originalGet = mock.identity.getAuthToken.bind(mock.identity);
      let calls = 0;
      mock.identity.getAuthToken = (details, cb) => {
        calls++;
        if (calls === 2) mock.identity.tokenToReturn = 'fresh-token-2';
        return originalGet(details, cb);
      };

      const user = await TrackerAuth.signInWithGoogle();
      assert.deepStrictEqual(seenTokens, ['stale-token-1', 'fresh-token-2'], 'Must validate the stale token, then the fresh one');
      assert.strictEqual(user.token, 'fresh-token-2', 'User must carry the fresh token');
      assert.strictEqual(mock.identity.cachedTokens.has('stale-token-1'), false, 'Stale token must be evicted from the cache');
      assert.strictEqual(calls, 2, 'Exactly one interactive re-prompt after a 401');
    } finally {
      global.fetch = originalFetch;
    }

    console.log('[PASS] Stale cached OAuth token is evicted and refreshed');
    delete global.TrackerAuth;
    uninstallMockChrome();
  }

  // 3c. ensureValidSession refreshes an expired stored session
  {
    const { mock, TrackerAuth } = getFreshAuth({}, { oauth2: true });
    await TrackerAuth.setUser({ email: 'carol@gmail.com', name: 'Carol', token: 'expired-token', provider: 'google' });

    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const token = opts.headers.Authorization.replace('Bearer ', '');
      if (token === 'expired-token') return { ok: false, status: 401 };
      return { ok: true, status: 200, json: async () => ({ email: 'carol@gmail.com', name: 'Carol Jones' }) };
    };

    try {
      mock.identity.tokenToReturn = 'renewed-token';
      const user = await TrackerAuth.ensureValidSession();
      assert.strictEqual(user.token, 'renewed-token', 'Session must be renewed with the fresh token');
      assert.strictEqual(user.name, 'Carol Jones', 'Profile must be refreshed alongside the token');
      assert.strictEqual(user.sessionExpired, undefined);
      assert.strictEqual(mock.identity.cachedTokens.has('expired-token'), false, 'Expired token must be evicted');
      const stored = await TrackerAuth.getCurrentUser();
      assert.strictEqual(stored.token, 'renewed-token', 'Renewed session must be persisted');
    } finally {
      global.fetch = originalFetch;
    }

    console.log('[PASS] ensureValidSession renews an expired OAuth session');
    delete global.TrackerAuth;
    uninstallMockChrome();
  }

  // 3d. ensureValidSession keeps the account but drops a dead token when
  //     the user declines to re-authenticate
  {
    const { mock, TrackerAuth } = getFreshAuth({}, { oauth2: true });
    await TrackerAuth.setUser({ email: 'dave@gmail.com', name: 'Dave', token: 'dead-token', provider: 'google' });

    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 401 });
    try {
      mock.identity.shouldFail = true;
      mock.identity.failureMessage = 'The user did not approve access.';
      const user = await TrackerAuth.ensureValidSession();
      assert.strictEqual(user.email, 'dave@gmail.com', 'Account must survive a declined re-auth');
      assert.strictEqual(user.token, undefined, 'Dead token must not be kept');
      assert.strictEqual(user.sessionExpired, true, 'UI must be told the session expired');
    } finally {
      global.fetch = originalFetch;
    }

    console.log('[PASS] Declined re-auth keeps the account and drops the dead token');
    delete global.TrackerAuth;
    uninstallMockChrome();
  }

  // 3e. Network failure is not expiry: the session is left untouched
  {
    const { TrackerAuth } = getFreshAuth();
    const original = { email: 'erin@gmail.com', name: 'Erin', token: 'fine-token', provider: 'google' };
    await TrackerAuth.setUser(original);

    const originalFetch = global.fetch;
    global.fetch = async () => { throw new TypeError('Failed to fetch'); };
    try {
      const user = await TrackerAuth.ensureValidSession();
      assert.strictEqual(user.token, 'fine-token', 'Offline must not evict a token');
      assert.strictEqual(user.sessionExpired, undefined);
    } finally {
      global.fetch = originalFetch;
    }

    console.log('[PASS] Offline validation leaves the session untouched');
    delete global.TrackerAuth;
    uninstallMockChrome();
  }

  // 3f. Unpaired build: no Google window is attempted at all;
  //     allowPrompt:false surfaces EMAIL_REQUIRED (mode 'local') instead of
  //     window.prompt, and an explicit email skips Identity entirely
  {
    const { mock, TrackerAuth } = getFreshAuth();
    let identityCalls = 0;
    mock.identity.getAuthToken = () => { identityCalls++; };
    assert.strictEqual(TrackerAuth.signInMode(), 'local');
    assert.strictEqual(TrackerAuth.isGoogleConfigured(), false);

    await assert.rejects(
      () => TrackerAuth.signInWithGoogle(undefined, { allowPrompt: false }),
      err => err.code === 'EMAIL_REQUIRED' && err.mode === 'local' && /this computer/.test(err.message)
    );
    assert.strictEqual(identityCalls, 0, 'an unpaired build never opens a Google prompt that cannot work');

    const user = await TrackerAuth.signInWithGoogle('Frank@Example.com');
    assert.strictEqual(user.email, 'frank@example.com');
    assert.strictEqual(mock.identity.cachedTokens.size, 0, 'An explicit email must not trigger an Identity prompt');

    console.log('[PASS] Unpaired build surfaces EMAIL_REQUIRED and honors explicit email');
    delete global.TrackerAuth;
    uninstallMockChrome();
  }

  // 3g. Local profile by name: keyed per name, never a Google identity
  {
    const { TrackerAuth } = getFreshAuth();
    const user = await TrackerAuth.signInLocal('  Sam Rivera ');
    assert.strictEqual(user.email, 'sam-rivera@local');
    assert.strictEqual(user.name, 'Sam Rivera');
    assert.strictEqual(user.provider, 'local');
    assert.strictEqual(user.token, undefined);
    assert.strictEqual(TrackerAuth._localKeyFor('a@b'), 'a@b');
    assert.strictEqual(TrackerAuth._localKeyFor('bad@'), '');
    await assert.rejects(() => TrackerAuth.signInLocal('   '), /name or email/);
    assert.deepStrictEqual(await TrackerAuth.ensureValidSession(), user, 'a local profile needs no validation');
    console.log('[PASS] Local profile by name is keyed per name and labeled local');
    delete global.TrackerAuth;
    uninstallMockChrome();
  }

  // 3h. Web client configured: launchWebAuthFlow with the implicit flow
  {
    const { mock, TrackerAuth } = getFreshAuth();
    TrackerAuth._setWebClientId('999-web.apps.googleusercontent.com');
    mock.identity.getRedirectURL = () => 'https://job-tracker-mock-extension-id.chromiumapp.org/';
    let launched = null;
    mock.identity.launchWebAuthFlow = (details, cb) => {
      launched = details;
      process.nextTick(() => cb('https://job-tracker-mock-extension-id.chromiumapp.org/#access_token=web-token-1&token_type=Bearer&expires_in=3599'));
    };
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      assert.strictEqual(opts.headers.Authorization, 'Bearer web-token-1');
      return { ok: true, status: 200, json: async () => ({ email: 'Gail@Gmail.com', name: 'Gail' }) };
    };
    try {
      assert.strictEqual(TrackerAuth.signInMode(), 'google');
      const user = await TrackerAuth.signInWithGoogle(undefined, { allowPrompt: false });
      const url = new URL(launched.url);
      assert.strictEqual(url.hostname, 'accounts.google.com');
      assert.strictEqual(url.searchParams.get('client_id'), '999-web.apps.googleusercontent.com');
      assert.strictEqual(url.searchParams.get('response_type'), 'token');
      assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://job-tracker-mock-extension-id.chromiumapp.org/');
      assert.strictEqual(launched.interactive, true);
      assert.strictEqual(user.email, 'gail@gmail.com');
      assert.strictEqual(user.method, 'web');
      assert.strictEqual(user.token, 'web-token-1');
    } finally {
      global.fetch = originalFetch;
    }

    // The user closes the Google window: an error, never a silent fallback.
    mock.identity.launchWebAuthFlow = (details, cb) => {
      mock.runtime.lastError = { message: 'The user did not approve access.' };
      cb(undefined);
      mock.runtime.lastError = null;
    };
    await assert.rejects(() => TrackerAuth.signInWithGoogle(undefined, { allowPrompt: false }), /did not approve/);
    console.log('[PASS] Web OAuth client: launchWebAuthFlow implicit flow, and a closed window is an error');
    delete global.TrackerAuth;
    uninstallMockChrome();
  }

  // 4. Sign Out and Token Eviction
  {
    const { mock, TrackerAuth } = getFreshAuth();

    const token = 'oauth-token-to-evict-456';
    await TrackerAuth.setUser({
      email: 'bob@example.com',
      name: 'Bob',
      token
    });

    mock.identity.cachedTokens.add(token);
    assert.strictEqual(mock.identity.cachedTokens.has(token), true);

    const signoutResult = await TrackerAuth.signOut();
    assert.strictEqual(signoutResult, true);

    const userAfter = await TrackerAuth.getCurrentUser();
    assert.strictEqual(userAfter, null, 'User should be null after sign out');
    assert.strictEqual(mock.identity.cachedTokens.has(token), false, 'Cached token must be evicted on signOut');

    console.log('[PASS] Sign out and token eviction');
    delete global.TrackerAuth;
    uninstallMockChrome();
  }

  // 5. Auth State Event Broadcasting
  {
    const { TrackerAuth } = getFreshAuth();

    let eventCount = 0;
    let lastEventUser = undefined;

    TrackerAuth.onAuthChanged(newUser => {
      eventCount++;
      lastEventUser = newUser;
    });

    await TrackerAuth.setUser({ email: 'charlie@example.com', name: 'Charlie' });
    // Allow event tick
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(eventCount, 1);
    assert.strictEqual(lastEventUser.email, 'charlie@example.com');

    await TrackerAuth.signOut();
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(eventCount, 2);
    assert.strictEqual(lastEventUser, null);

    console.log('[PASS] Auth state change event broadcasting');
    delete global.TrackerAuth;
    uninstallMockChrome();
  }

  console.log('--- test/auth.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
