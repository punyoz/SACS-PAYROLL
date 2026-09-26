'use client';

/**
 * Last-resort boundary for failures in the root layout itself, which error.js
 * cannot catch. It has to render its own <html> and <body>, because the root
 * layout is exactly what failed — so globals.css may never have been applied
 * and every style here must be inline. The colours are therefore literal
 * copies of the brand tokens (public/legacy/css/theme.css): primary green
 * #1B5E3C, gold #C9A227, white #FFFFFF, text #1A1A1A, gray #5E6470.
 */

export default function GlobalError({ error, reset }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#F6F7F3',
          color: '#1A1A1A',
          fontFamily: 'DM Sans, system-ui, sans-serif',
          padding: '24px',
        }}
      >
        <div
          style={{
            background: '#FFFFFF',
            border: '1px solid #E0D5AE',
            borderTop: '4px solid #C9A227',
            borderRadius: '16px',
            padding: '32px',
            width: '100%',
            maxWidth: '440px',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- static public asset; the app shell has failed */}
          <img
            src="/legacy/assets/logo-160.png"
            alt="Shepherd Angels Christian School seal"
            width={56}
            height={56}
            style={{ display: 'block', objectFit: 'contain', marginBottom: '16px' }}
          />
          <h1 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 6px' }}>
            SACS Payroll is unavailable
          </h1>
          <p style={{ fontSize: '13px', color: '#5E6470', lineHeight: 1.6, margin: '0 0 24px' }}>
            The application failed to start. Your data has not been changed. Please try
            again, or contact your system administrator if this continues.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              width: '100%',
              minHeight: '44px',
              padding: '13px',
              background: '#1B5E3C',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: '10px',
              fontSize: '14px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error?.digest ? (
            <div
              style={{
                marginTop: '18px',
                fontSize: '11px',
                color: '#5E6470',
                fontFamily: 'DM Mono, ui-monospace, monospace',
                wordBreak: 'break-all',
              }}
            >
              Reference: {error.digest}
            </div>
          ) : null}
        </div>
      </body>
    </html>
  );
}
