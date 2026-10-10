# Hosting: where to run the app for free (commercial use)

Researched Oct 10, 2026. Plans change: re-check each provider's current
terms before signing up.

## What this app needs from a host

- **Next.js 16.3** with `src/proxy.js` on the **Node.js runtime** (it uses
  `node:crypto` and checks the session in the database on every request).
- **Outbound SMTP on port 465 or 587** for the Gmail sign-in codes
  (Nodemailer).
- **Close to the database** (Supabase, Mumbai `ap-south-1`): every API call
  makes several database round trips, and the portals send a session check
  every 10 seconds, so a far-away server makes every screen slow.
- **Always on**: the RFID terminals tap all day; a host that sleeps when idle
  makes the first tap after a pause wait for a cold start.
- Commercial use allowed (a school's payroll counts as commercial).

## Comparison

| Host (free plan) | Commercial use | Next 16 + Node `proxy.js` | Gmail SMTP | Near Mumbai | Always on | Verdict |
|---|---|---|---|---|---|---|
| **Vercel Hobby** | **No** (personal, non-commercial only) | Yes (native) | Yes | Yes (`bom1`) | Yes | Testing only (your decision) |
| **Netlify Free** | Yes (per Netlify staff) | Yes, via its OpenNext adapter (Node middleware: no filesystem, no C++ add-ons; this app uses neither) | Yes | **No**: free sites' functions run in Ohio; region choice is Pro+ | Serverless | Works, but slow from Ohio, and the 300 monthly credits (2 per 10k requests, 15 per deploy) are likely to run out with the 10-second heartbeats, which **pauses the site** |
| **Render Free** | Not stated; Render says not for production | Yes (`next start`) | **No**: free services block ports 25, 465 and 587 | Singapore | **No**: sleeps after 15 min idle, ~1 min wake | Not suitable (no sign-in codes) |
| **Cloudflare Workers (OpenNext)** | Yes | Node `proxy.js` support is new; open bugs, one triggered by `@sentry/nextjs` | Nodemailer SMTP has known problems on Workers | Edge | Yes | Not suitable without rewrites |
| **Google Cloud Run** | Yes | Yes (container) | Yes | Free allowance counts in US regions only | Scales to zero (cold starts) | Possible but slow (US) or not free (Asia) |
| **Oracle Cloud Always Free (Arm VM)** | Not prohibited; no SLA, no support | Yes (plain `next start`) | Port 25 blocked; **587 must be tested** (step 6) | Yes, if the home region is Mumbai (or Hyderabad / Singapore) | Yes (a real server) | **Recommended** |
| School PC + Cloudflare Tunnel | Yes | Yes | Yes | Depends on the school's line | Only while that PC and line are up | Fallback |

## Recommendation: Oracle Cloud Always Free VM in Mumbai

A small always-on Linux server (2 Arm cores, 12 GB RAM, free for the life of
the account) in the same city as the database, running `next start` behind
Caddy for HTTPS. Two conditions:

1. **Upgrade the account to Pay-As-You-Go** (a card is required). Oracle
   stops idle Always Free servers on unpaid accounts (CPU, memory and
   network all under 20% for 7 days, which a school app can easily be).
   On Pay-As-You-Go, Always Free resources stay free; set a budget alert
   of $1 so any charge is noticed.
2. **The home region is chosen at sign-up and can never change.** Choose
   **India West (Mumbai)** if the sign-up page marks it Always Free
   eligible; otherwise Hyderabad, then Singapore.

No SLA and no Oracle support: keep the backups in
[backup-and-restore.md](backup-and-restore.md) and the uptime monitor.

### Step by step

Commands are for Ubuntu 24.04 on the VM. `payroll.<school-domain>` is your
domain.

1. **Account.** Sign up at oracle.com/cloud/free with the school's e-mail;
   home region Mumbai (see above). Then Billing → **Upgrade to Pay As You
   Go**, and Billing → Budgets → a $1 monthly budget with an e-mail alert.
2. **Server.** Compute → Instances → Create: image **Ubuntu 24.04**, shape
   **VM.Standard.A1.Flex** with **2 OCPU / 12 GB**, add your SSH public key,
   assign a public IPv4. (If it says "out of capacity", try another
   availability domain or retry later.) Networking → the instance's VCN →
   Security List → add ingress rules for TCP **80** and **443** from
   `0.0.0.0/0`. Reserve the public IP (Networking → Reserved Public IPs) so
   it never changes.
3. **DNS.** At your domain registrar: an **A record** `payroll` → that IP.
4. **Base setup** (SSH in as `ubuntu`):

   ```bash
   sudo apt update && sudo apt -y full-upgrade
   sudo apt -y install git unattended-upgrades netfilter-persistent
   # Oracle's Ubuntu image blocks 80/443 in iptables as well as in the security list
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   # Node.js 24
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt -y install nodejs
   node -v
   ```

5. **Caddy** (HTTPS certificates are automatic):

   ```bash
   sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt -y install caddy
   printf 'payroll.<school-domain> {\n\treverse_proxy 127.0.0.1:3000\n}\n' | sudo tee /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```

6. **Check Gmail SMTP is reachable** (the whole sign-in depends on it):

   ```bash
   nc -vz smtp.gmail.com 465 ; nc -vz smtp.gmail.com 587
   ```

   One must say "succeeded". If both time out, ask Oracle (Support → service
   limit request) to allow outbound 587, or use the Netlify / school-PC
   option instead.

7. **App and its secrets:**

   ```bash
   sudo useradd --system --create-home --home-dir /opt/sacs payroll
   sudo -u payroll git clone https://github.com/punyoz/SACS-PAYROLL.git /opt/sacs/app
   sudo install -m 600 -o payroll /dev/null /etc/sacs-payroll.env
   sudo nano /etc/sacs-payroll.env     # the HOST variables from .env.example, one per line
   ```

   Put in it `NODE_ENV=production`, `PORT=3000` and every "HOST: required"
   variable from `.env.example` (and the Sentry ones if used). Never the
   `SEED_*` passwords or `USE_MAILTM`. If the repository is private, clone
   with a GitHub deploy key or token.

8. **Build:**

   ```bash
   cd /opt/sacs/app
   sudo -u payroll bash -c 'set -a; . /etc/sacs-payroll.env; set +a; npm ci && npm run build'
   ```

   (`NEXT_PUBLIC_*` values are built into the browser code, so the build
   reads the same file.)

9. **Run it as a service** that restarts on failure and on reboot:

   ```bash
   sudo tee /etc/systemd/system/sacs-payroll.service >/dev/null <<'UNIT'
   [Unit]
   Description=SACS Payroll (Next.js)
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=payroll
   WorkingDirectory=/opt/sacs/app
   EnvironmentFile=/etc/sacs-payroll.env
   ExecStart=/usr/bin/npm start -- -p 3000 -H 127.0.0.1
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   UNIT
   sudo systemctl daemon-reload
   sudo systemctl enable --now sacs-payroll
   curl -s http://127.0.0.1:3000/api/health     # {"ok":true}
   ```

10. **Supabase** → Authentication → URL Configuration → Site URL =
    `https://payroll.<school-domain>`.
11. Open `https://payroll.<school-domain>/login` and run the smoke test in
    [go-live.md](go-live.md) section 5. Point the uptime monitor and the
    `HEALTH_URL` keep-alive variable at `https://payroll.<school-domain>/api/health`.

### Updating to a new version

```bash
cd /opt/sacs/app
sudo -u payroll git fetch --tags && sudo -u payroll git checkout v1.0.1   # the release tag
sudo -u payroll bash -c 'set -a; . /etc/sacs-payroll.env; set +a; npm ci && npm run build'
sudo systemctl restart sacs-payroll
```

The site is down for the few seconds of the restart. Do it outside school
hours.

### Rollback

Check out the previous tag, rebuild and restart (same three commands with
the old tag). Database changes are rolled back from a backup, never by the
app (backup-and-restore.md).

### Keep the server healthy

- Security updates install themselves (`unattended-upgrades`); reboot once a
  month after hours: `sudo reboot` (the service starts by itself).
- Logs: `journalctl -u sacs-payroll -n 200` (app), `journalctl -u caddy` (HTTPS).
- SSH only with keys (Oracle's default); do not open other ports.

## Fallback: a school PC with Cloudflare Tunnel

If Oracle sign-up fails (card verification) or port 587 stays blocked: a PC
or mini-PC at the main branch that is always on, on a UPS, running the app
with Node.js 24 as above (Windows: `npm run build` then `npm start` as a
scheduled task at startup), published with a free **Cloudflare Tunnel**
(`cloudflared`, no open ports needed, HTTPS included). It is only as
available as that PC, its power and its internet line.

## Moving off Vercel later

Nothing in the code depends on Vercel. Vercel Analytics and Speed Insights
load only when the `VERCEL` variable is set (src/app/layout.js), so they
stay quiet on any other host.
