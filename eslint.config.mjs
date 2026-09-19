import nextVitals from "eslint-config-next/core-web-vitals";

/** Globals every browser script may assume. */
const browserGlobals = {
  console: "readonly",
  document: "readonly",
  window: "readonly",
  navigator: "readonly",
  location: "readonly",
  history: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  fetch: "readonly",
  alert: "readonly",
  confirm: "readonly",
  prompt: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  FormData: "readonly",
  FileReader: "readonly",
  Blob: "readonly",
  File: "readonly",
  Image: "readonly",
  Intl: "readonly",
  Event: "readonly",
  CustomEvent: "readonly",
  MutationObserver: "readonly",
  IntersectionObserver: "readonly",
  ResizeObserver: "readonly",
  AbortController: "readonly",
  Request: "readonly",
  Response: "readonly",
  Headers: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  atob: "readonly",
  btoa: "readonly",
  structuredClone: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  queueMicrotask: "readonly",
  getComputedStyle: "readonly",
  matchMedia: "readonly",
  crypto: "readonly",
  performance: "readonly",
  HTMLElement: "readonly",
  Node: "readonly",
};

const config = [
  ...nextVitals,
  {
    // no-undef is off in the Next preset, which is why two route handlers
    // shipped calling sanitizeError() without importing it — a ReferenceError
    // raised inside the catch block that was meant to report the error.
    // Turning it on catches that class of bug at lint time.
    files: ["src/**/*.{js,mjs}", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        URL: "readonly",
        Request: "readonly",
        Response: "readonly",
        Buffer: "readonly",
        Intl: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        structuredClone: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
    },
  },
  {
    // The legacy portals are the code that needs no-undef most and had it
    // least. They are classic (non-module) scripts sharing one global scope —
    // app.js defines helpers that hr.js, admin.js and the rest call by bare
    // name — so a typo or a helper that moved file is a ReferenceError that
    // only shows up when a user clicks the thing.
    //
    // Cross-file globals are declared below rather than being switched off,
    // so calling something that exists in no file is still an error.
    files: ["public/legacy/js/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...browserGlobals,

        // ── defined in app.js, used by every portal script ──
        escapeHtml: "readonly",
        formatHours: "readonly",
        formatDigitGroups: "readonly",
        digitsOnly: "readonly",
        DIGIT_FIELD_SPECS: "readonly",
        bindDigitFieldsIn: "readonly",
        populateDigitFieldsIn: "readonly",
        enforceNumericInputs: "readonly",
        splitFullName: "readonly",
        printDocument: "readonly",
        submitAccountPasswordChange: "readonly",
        getLegacyAuthContext: "readonly",
        persistRolePageState: "readonly",
        getPersistedRolePageState: "readonly",
        attachSidebarSpotlight: "readonly",
        fetchBranchesCached: "readonly",
        invalidateBranchesCache: "readonly",
        fetchDashboardCached: "readonly",
        invalidateDashboardCache: "readonly",
        formatDateTime: "readonly",
        formatDateOnly: "readonly",
        formatTimeOnly: "readonly",
        formatMoney: "readonly",
        fmtPesoShort: "readonly",
        getInitials: "readonly",
        getAvatarColor: "readonly",
        getAuthContext: "readonly",
        setAuthContext: "readonly",
        skeletonRows: "readonly",
        skeletonCards: "readonly",
        createPaginator: "readonly",
        pushNotification: "readonly",
        confirmDestructiveAction: "readonly",
        confirmApproveAction: "readonly",
        openProofDocument: "readonly",
        showProofError: "readonly",
        openSettingsModal: "readonly",
        closeSettingsModal: "readonly",
        applyTheme: "readonly",
        logout: "readonly",
        login: "readonly",
        debounce: "readonly",
        toggleLoginPasswordVisibility: "readonly",
        lockBodyScroll: "readonly",

        // ── per-portal nav handlers, referenced from the RBAC-built sidebar ──
        adminNav: "readonly",
        saNav: "readonly",
        hrNav: "readonly",
        acctNav: "readonly",

        // ── defined in a portal script and called back from app.js ──
        // app.js loads first, so each of these call sites is guarded with a
        // `typeof x === 'function'` check (app.js:444, 1016-1018). They are
        // declared here so no-undef still catches a genuine typo in the name.
        composeFullName: "readonly",      // admin.js
        applyEmployeeIdentity: "readonly", // employee.js
        loadMyLeaveRequests: "readonly",   // employee.js
        renderPayslipOptions: "readonly",  // accountant.js
      },
    },
    rules: {
      "no-undef": "error",
    },
  },
];

export default config;
