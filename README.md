# Two of Us Habits

A shared habit tracker for two people. It's a single web page backed by Firebase (Google's free tier): Google sign-in, live sync between both phones, offline support, and it installs on your Home Screen like an app.

You'll need about 15 minutes, a Google account, and a computer for the one-time setup.

---

## 1. Create a Firebase project

1. Go to <https://console.firebase.google.com> and click **Create a project**.
2. Name it, for example `two-of-us-habits`. Google Analytics isn't needed, so you can turn it off.
3. Stay on the free **Spark** plan. Two people will never come close to its limits.

## 2. Turn on Google sign-in

1. In the left menu: **Build → Authentication → Get started**.
2. Under **Sign-in method**, choose **Google**, switch it on, pick a support email, and **Save**.

## 3. Create the database

1. **Build → Firestore Database → Create database**.
2. Pick the location closest to you from the list (a Middle East or Europe region works well from the UAE).
3. Choose **Start in production mode**. The real security rules get uploaded in step 6.

## 4. Register the web app and copy its settings

1. Click the ⚙️ next to **Project Overview → Project settings**.
2. Under **Your apps**, click the **</>** (Web) icon. Name it `Two of Us` and leave "Firebase Hosting" unticked here (it's set up in step 5). Click **Register app**.
3. You'll see a `firebaseConfig = { ... }` block. Copy the values into `docs/firebase-config.js`, replacing the placeholders:

```js
window.FIREBASE_CONFIG = {
  apiKey: "AIza...",
  authDomain: "two-of-us-habits.firebaseapp.com",
  projectId: "two-of-us-habits",
  storageBucket: "two-of-us-habits.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc123"
};
```

These values are safe to publish. They only identify your project. What protects your data is the sign-in plus the security rules in `firestore.rules`.

## 5. Install the Firebase tools (one time)

You need [Node.js](https://nodejs.org) (the LTS version). Then, in a terminal:

```bash
npm install -g firebase-tools
firebase login
```

## 6. Deploy

From this folder (the one with `firebase.json`):

```bash
firebase use --add          # pick your project, call the alias "default"
firebase deploy             # uploads the app and the security rules
```

When it finishes, it prints your app's address, for example **https://two-of-us-habits.web.app**. That's your app.

## 7. Start using it together

1. **Rasheed:** open the address on your phone and tap **Continue with Google**. Your board is created.
2. Add a few habits with **+**.
3. On Today, tap **Share invite link** (it's also in the ☰ menu) and send it to your wife.
4. **Your wife:** opens the link, signs in with Google, and she's on the same board. Shared ("Us") habits show up for her straight away.

### Put it on your Home Screen

- **iPhone (Safari):** tap Share → **Add to Home Screen**.
- **Android (Chrome):** tap ⋮ → **Install app** (or **Add to Home screen**).

It then opens full-screen like a normal app and works offline. Check-ins made offline sync when you're back online.

---

## Updating the app later

Edit `docs/index.html`, then run `firebase deploy --only hosting`. Phones pick up the new version the next time the app is opened.

## Using your own domain (optional)

In Firebase: **Hosting → Add custom domain**, and follow the DNS steps. If you do, also add the domain under **Authentication → Settings → Authorized domains**, or Google sign-in won't work there.

## Hosting somewhere else (optional)

The `docs/` folder is a plain static site, so Netlify, Vercel, Cloudflare Pages or GitHub Pages work too. Two things to do if you go that way:

1. Still upload the rules once: `firebase deploy --only firestore:rules`.
2. Add your site's domain under **Authentication → Settings → Authorized domains**.

## How the data is organised

```
users/{uid}                     → which board you belong to
households/{boardId}            → members (max 2)
households/{boardId}/habits     → the habits
households/{boardId}/progress/{uid}  → each person's check-ins, rest days, settings
households/{boardId}/nudges/{uid}    → latest nudge for each person
households/{boardId}/settings/jar    → the reward jar
```

The invite link contains the board's random id. Anyone with the link can join while the board has fewer than two members, so only send it to your wife. Once you're both in, the board is full and the link stops working for anyone else.

## Troubleshooting

- **"This domain is not authorized" when signing in:** add the domain under Authentication → Settings → Authorized domains.
- **Sign-in popup doesn't appear on iPhone:** the app falls back to a full-page redirect automatically. If it still fails, open the site in Safari (not inside another app's built-in browser).
- **"Missing or insufficient permissions":** the rules weren't deployed. Run `firebase deploy --only firestore:rules`.
- **Demo mode banner:** `firebase-config.js` still has the placeholder values.

## Notifications

Reminders, nudges and partner progress are sent by a small free Cloudflare Worker (`notify/worker.js`), deployed as
`two-of-us-notify` with a KV namespace bound as `KV` and a cron trigger every 15 minutes. It needs no secrets: it checks
callers with their Firebase sign-in token and creates its own push keys on first run. To update it, paste the new
`notify/worker.js` into the worker's code editor in the Cloudflare dashboard and deploy.

On iPhone, notifications only work when the app is opened from the Home Screen (iOS 16.4 or later).
