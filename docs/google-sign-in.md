# Turning on Google sign-in

`shared/auth.js` supports two OAuth setups. Pick one. Until one is configured, sign-in offers only the local profile, and no Google window is ever opened.

First, give the extension a stable ID. Unpacked extensions get an ID from their folder path, and OAuth clients are tied to an ID.

1. Load the extension once, open `chrome://extensions`, and note the ID. To keep it stable across machines, pack the extension once (**Pack extension**), take the public key from the `.pem` (or from the Chrome Web Store dashboard after uploading), and add it to `manifest.json` as `"key": "<base64 public key>"`.

**Option A: Chrome's built-in sign-in (recommended for Chrome).** Uses the Google account Chrome is signed into, with no extra window.

2. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project. Under **APIs & Services > OAuth consent screen**, set it up (External, app name "LIT", your support email) and add the scopes `openid`, `email`, `profile`. While the app is in Testing, add yourself as a test user.
3. Under **APIs & Services > Credentials**, choose **Create credentials > OAuth client ID**, application type **Chrome Extension**, and paste the extension ID as the Item ID.
4. Add this block to `manifest.json` with the client ID you were given:

   ```json
   "oauth2": {
     "client_id": "1234567890-abc123.apps.googleusercontent.com",
     "scopes": ["openid", "email", "profile"]
   }
   ```

5. Reload the extension. The popup's sign-in now opens Google's account chooser.

**Option B: Google's web sign-in window.** Works in Chrome, Edge, and Brave, with any Google account.

2. Same consent screen as above.
3. Create an OAuth client ID of type **Web application** and add the authorized redirect URI `https://<extension-id>.chromiumapp.org/`.
4. Put the client ID in `WEB_CLIENT_ID` at the top of `shared/auth.js` (no manifest change needed).
5. Reload the extension.

Do not add an `oauth2` block with a placeholder ID. Chrome's sign-in fails harder with a fake client than with none, and the manifest test rejects one.
