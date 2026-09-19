'use client';

/**
 * Route-level error boundary.
 *
 * Without this file a thrown error in any page or layout below the root showed
 * the bare Next.js error screen — white background, stack trace in development,
 * an unstyled "something went wrong" in production. Neither belongs in front of
 * a payroll user.
 *
 * Styling is inline and mirrors the portal palette (see public/legacy/css/
 * theme.css and src/app/reset-password/page.js), because globals.css is the
 * only stylesheet guaranteed to have loaded at this point.
 */

const S = {
  page: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0D1B2A',
    fontFamily: 'DM Sans, system-ui, sans-serif',
    padding: '24px',
  },
  card: {
    background: '#142232',
    border: '1px solid #1E3448',
    borderRadius: '16px',
    padding: '32px',
    width: '100%',
    maxWidth: '440px',
  },
  brand: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '24px' },
  brandIcon: {
    width: '36px',
    height: '36px',
    borderRadius: '10px',
    background: '#F5A623',
    color: '#0D1B2A',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: '16px',
    flexShrink: 0,
  },
  brandName: { fontSize: '13px', fontWeight: 600, color: '#E6EEF8', lineHeight: 1.3 },
  brandSub: { fontSize: '11px', color: '#5A7A9A' },
  title: { fontSize: '20px', fontWeight: 700, color: '#E6EEF8', marginBottom: '6px' },
  sub: { fontSize: '13px', color: '#5A7A9A', marginBottom: '24px', lineHeight: 1.6 },
  row: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
  btn: {
    flex: '1 1 150px',
    minHeight: '44px',
    padding: '13px',
    background: '#F5A623',
    color: '#0D1B2A',
    border: 'none',
    borderRadius: '10px',
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  btnGhost: {
    flex: '1 1 150px',
    minHeight: '44px',
    padding: '13px',
    background: 'transparent',
    color: '#E6EEF8',
    border: '1px solid #1E3448',
    borderRadius: '10px',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'center',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  digest: {
    marginTop: '18px',
    fontSize: '11px',
    color: '#5A7A9A',
    fontFamily: 'DM Mono, ui-monospace, monospace',
    wordBreak: 'break-all',
  },
};

export default function ErrorBoundary({ error, reset }) {
  return (
    <div style={S.page}>
      <div style={S.card}>
        <div style={S.brand}>
          <div style={S.brandIcon}>S</div>
          <div>
            <div style={S.brandName}>SACS Payroll</div>
            <div style={S.brandSub}>Shepherd Angels Christian School</div>
          </div>
        </div>

        <h1 style={S.title}>Something went wrong</h1>
        <p style={S.sub}>
          This screen could not be loaded. Your data has not been changed. Try again, and
          if it keeps happening, contact your system administrator.
        </p>

        <div style={S.row}>
          <button type="button" style={S.btn} onClick={() => reset()}>
            Try again
          </button>
          <a href="/login" style={S.btnGhost}>
            Back to sign in
          </a>
        </div>

        {/* The digest is the only detail safe to show: it identifies the error in
            the server logs without revealing the message or stack to the user. */}
        {error?.digest ? <div style={S.digest}>Reference: {error.digest}</div> : null}
      </div>
    </div>
  );
}
