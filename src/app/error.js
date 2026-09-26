'use client';

/**
 * Route-level error boundary.
 *
 * Without this file a thrown error in any page or layout below the root showed
 * the bare Next.js error screen — white background, stack trace in development,
 * an unstyled "something went wrong" in production. Neither belongs in front of
 * a payroll user.
 *
 * Styling is inline but every colour is a brand token from globals.css (the
 * same palette as public/legacy/css/theme.css), because globals.css is the
 * only stylesheet guaranteed to have loaded at this point.
 */

const S = {
  page: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg)',
    fontFamily: 'DM Sans, system-ui, sans-serif',
    padding: '24px',
  },
  card: {
    background: 'var(--bg2)',
    border: '1px solid var(--border)',
    borderTop: '4px solid var(--color-secondary)',
    borderRadius: '16px',
    padding: '32px',
    width: '100%',
    maxWidth: '440px',
  },
  brand: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '24px' },
  brandIcon: {
    width: '44px',
    height: '44px',
    objectFit: 'contain',
    flexShrink: 0,
  },
  brandName: { fontSize: '13px', fontWeight: 600, color: 'var(--t1)', lineHeight: 1.3 },
  brandSub: { fontSize: '11px', color: 'var(--t3)' },
  title: { fontSize: '20px', fontWeight: 700, color: 'var(--t1)', marginBottom: '6px' },
  sub: { fontSize: '13px', color: 'var(--t3)', marginBottom: '24px', lineHeight: 1.6 },
  row: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
  btn: {
    flex: '1 1 150px',
    minHeight: '44px',
    padding: '13px',
    background: 'var(--accent)',
    color: 'var(--on-accent)',
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
    color: 'var(--t1)',
    border: '1px solid var(--border)',
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
    color: 'var(--t3)',
    fontFamily: 'DM Mono, ui-monospace, monospace',
    wordBreak: 'break-all',
  },
};

export default function ErrorBoundary({ error, reset }) {
  return (
    <div style={S.page}>
      <div style={S.card}>
        <div style={S.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element -- static public asset; next/image adds nothing on an error screen */}
          <img src="/legacy/assets/logo-160.png" alt="Shepherd Angels Christian School seal" width={44} height={44} style={S.brandIcon} />
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
