// Watches a page the whole time: console errors and warnings, uncaught
// exceptions, crashes, failed or slow requests (app API and Supabase), and
// 404 pages. A test fails at the end if anything unexpected was seen.

const SLOW_MS = 5000;

// Noise that is not an app defect.
const IGNORE_CONSOLE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /\[HMR\]/i,
  /webpack-hmr|turbopack-hmr|_next\/webpack-hmr/i,
  /Failed to load resource: net::ERR_ABORTED/i,
  // The browser's own line for a response the test asked for on purpose; the
  // response itself is checked (and expected or not) below.
  /Failed to load resource: the server responded with a status of (401|403|404|409|422|429)/i,
];

export class Monitor {
  constructor() {
    this.issues = [];
    this.warnings = [];
    this.allowed = [];
    this.where = "";
    this.pending = new Map();
  }

  /** Label issues with what was being tested. */
  at(where) { this.where = where; }

  /**
   * Allow failures the test provokes on purpose, e.g. a 403 from a blocked
   * URL. Each matcher is a RegExp tested against "STATUS METHOD /path".
   */
  allow(...patterns) { this.allowed.push(...patterns); }

  clearAllowed() { this.allowed = []; }

  isAllowed(text) { return this.allowed.some((re) => re.test(text)); }

  add(kind, text) {
    if (this.isAllowed(text)) return;
    this.issues.push({ where: this.where, kind, text: String(text).slice(0, 500) });
  }

  attach(page) {
    page.on("console", (msg) => {
      const text = msg.text();
      if (IGNORE_CONSOLE.some((re) => re.test(text))) return;
      if (msg.type() === "error") this.add("console.error", text);
      else if (msg.type() === "warning") this.warnings.push({ where: this.where, text: text.slice(0, 300) });
    });
    page.on("pageerror", (err) => this.add("uncaught", `${err.name}: ${err.message}`));
    page.on("crash", () => this.add("crash", "page crashed"));
    page.on("request", (req) => this.pending.set(req, Date.now()));
    page.on("requestfailed", (req) => {
      this.pending.delete(req);
      const failure = req.failure()?.errorText || "";
      // Navigations and closed streams cancel requests on purpose.
      if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure)) return;
      if (!isAppRequest(req.url())) return;
      this.add("request-failed", `${req.method()} ${shortUrl(req.url())} ${failure}`);
    });
    page.on("response", (res) => {
      const req = res.request();
      const started = this.pending.get(req);
      this.pending.delete(req);
      const url = res.url();
      if (!isAppRequest(url)) return;
      const line = `${res.status()} ${req.method()} ${shortUrl(url)}`;
      if (res.status() >= 400) this.add("http", line);
      if (started && Date.now() - started > SLOW_MS && !/\/stream/.test(url)) {
        this.warnings.push({ where: this.where, text: `slow ${Date.now() - started}ms ${line}` });
      }
    });
  }

  summary() {
    return this.issues.map((i) => `[${i.where}] ${i.kind}: ${i.text}`).join("\n");
  }
}

export function isAppRequest(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)
    && !/\/_next\/(static|webpack-hmr)|__nextjs|\.hot-update\.|favicon/.test(url);
}

export function shortUrl(url) {
  return url.replace(/^https?:\/\/[^/]+/, "").slice(0, 200);
}
