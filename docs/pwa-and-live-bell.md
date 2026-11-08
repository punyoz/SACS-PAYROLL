# Home-screen app (PWA) and the live notification bell

Alpha test D1 and D2, 2026-11-09.

## Home-screen app (PWA)

What was added:

- `src/app/manifest.js`, served at `/manifest.webmanifest`. It sets the name "SACS Payroll", opens in its own window (`standalone`), uses the green theme `#1B5E3C`, and has icons in `public/icons` (192, 512 and a maskable 512, all made from the school seal).
- `public/sw.js`, the service worker. It is registered in production builds only (`src/components/portal/service-worker.jsx`).
  - Cached: only the public app shell. That is the fingerprinted build files (`/_next/static/`), the brand images, the icons and the offline page.
  - Never cached: anything under `/api/` (payroll, payslips, attendance, accounts, notifications) and any page HTML. These always come from the network, so no payroll data is stored on the phone.
  - API responses are also sent with `Cache-Control: no-store` (`src/proxy.js`).
- `public/offline.html`. It shows when a page is opened with no connection.
- An RFID terminal that was already open keeps its own offline tap queue, as before.

How to install:

- **Android (Chrome):** open the site, then tap ⋮ and **Add to Home screen** (or **Install app**). It opens full screen with the SACS icon.
- **iPhone / iPad (Safari):** open the site, tap **Share**, then **Add to Home Screen**. iOS uses the Apple touch icon (`src/app/apple-icon.png`) and `appleWebApp` in `src/app/layout.js`.
  - The installed app keeps its own sign-in, separate from Safari's.
  - iOS may clear an unused home-screen app's storage after a few weeks. Nothing important is lost, because no data is kept on the device.
- A **desktop browser** (Chrome / Edge) shows an install icon in the address bar.

Updating: a new deploy changes the build file names. The worker fetches the new ones, and the old cache is removed when the new worker takes over (`sacs-shell-v1`; raise the number if the shell list changes).

## Live notification bell

Before, the bell read `GET /api/notifications` once a minute. Now, when a new notification is saved:

1. A database trigger (`notifications_live_ping`, migration `20261109040000_live_notification_bell.sql`) sends a Supabase Realtime broadcast called **ping** to the recipient's own channel, `bell-<random topic>`.
2. The bell, subscribed to that channel, reloads at once through `GET /api/notifications`.

Security:

- **The ping carries nothing.** It has no title, body, amount, name or id. Roles, branches and salary rules stay enforced by the API, which only returns the signed-in account's own notifications.
- **Each account has a random 128-bit topic** (`public.notification_channels`). Browsers cannot read that table (RLS on, no grants). The topic is given only to the signed-in user, by the API.
- The browser uses the public anon key, which can reach no table (every table refuses anon / authenticated).
- If Realtime is down, the trigger ignores the error and the bell still reloads every minute.
- The Content-Security-Policy allows a websocket to this Supabase project only (`next.config.mjs`).

Measured on the local stack: the ping arrives about 0.1 s after the notification is saved.

Some existing notification texts include amounts, for example a filed loan's principal or an overridden payslip's net. These are shown only to the authorized recipient (HR / the Accountant), through the API. They never travel over the socket.

## Push notifications (not built)

Push notifications were not built, per the decision of 2026-11-09. If they are wanted later:

- **What it needs:**
  - VAPID keys (one key pair, kept in the server environment);
  - a `push_subscriptions` table (one row per device, never readable by browsers);
  - a `push` handler in `public/sw.js`;
  - a server step that sends a Web Push message when a notification is saved. The message would say only "You have a new notification", with no amounts.
- **iPhone:** Web Push works only for a site added to the Home Screen, on iOS 16.4 or later, and only after the user allows it from a button tap.
- **Cost:** Web Push itself is free (Google, Apple and Mozilla push services). The only cost is the server work to send each message, which Vercel's and Supabase's current plans already cover at the school's size. A third-party service (for example OneSignal or Firebase) is free at this size too, but it would add an outside company holding device tokens.
