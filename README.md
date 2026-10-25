# Kitchen Cabinet

A phone app for what's in your fridge, freezer and pantry. Add things by hand or from a photo of a receipt, see what to use first, get recipe ideas from what you already have, plan the week's meals and keep a shopping list. It installs to the home screen and works offline.

It's a static web app: no build step, no server of its own. Data syncs through Firebase (free tier), and the Claude features call the Anthropic API directly from the phone with the user's own API key.

## Setting it up

### 1. Firebase (sync and sign-in)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a project (Google Analytics can stay off).
2. **Build → Authentication → Get started → Sign-in method → Email/Password**: turn on the first switch and save.
3. **Build → Firestore Database → Create database**: pick a location near you and start in **production mode**.
4. In Firestore, open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), and **Publish**.
5. **Project settings** (gear icon) **→ General → Your apps → Web (`</>`)**: register an app (no Firebase Hosting needed) and copy the `firebaseConfig` object into [`config.js`](config.js).
6. **Authentication → Settings → Authorized domains**: add the domain the app is served from (this copy lives at `elliotgross.com`; a plain GitHub Pages site would be `<username>.github.io`).
7. Optional, once your account exists: **Authentication → Settings → User actions**, turn off **Enable create (sign-up)** so nobody else can make accounts on your project.

Until `config.js` has a config, the app keeps data on the device it's opened on. Anything added that way moves into your account the first time you sign in.

### 2. Claude (optional)

Photo reading, use-by estimates, recipe ideas and meal planning need an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys). Add credit under Billing, and consider a monthly spend limit under Limits. In the app, open **Settings**, paste the key, and tap **Test key**.

The key is kept in the browser's local storage on that device and sent only to `api.anthropic.com`. Requests use `claude-opus-5-5` with server-side refusal fallbacks turned on.

### 3. Put it on your phone

Open the app's URL in Safari, tap **Share → Add to Home Screen**, then open it from the home screen. The home-screen app has its own storage, separate from Safari, so sign in and add your API key inside it.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Markup and styles |
| `app.js` | The app: storage, sign-in, Claude calls, all four tabs |
| `config.js` | Firebase web config (not a secret; access is enforced by sign-in and the rules) |
| `firestore.rules` | Each signed-in user can read and write only `users/<their uid>/` |
| `sw.js` | Service worker for offline use |
| `manifest.webmanifest`, `icons/` | Home-screen install metadata and icons |

To run it locally, serve the folder with any static server, for example `python3 -m http.server`.
