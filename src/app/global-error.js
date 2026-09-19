'use client';

/**
 * Last-resort boundary for failures in the root layout itself, which error.js
 * cannot catch. It has to render its own <html> and <body>, because the root
 * layout is exactly what failed — so globals.css may never have been applied
 * and every style here must be inline.
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
          background: '#0D1B2A',
          color: '#E6EEF8',
          fontFamily: 'DM Sans, system-ui, sans-serif',
          padding: '24px',
        }}
      >
        <div
          style={{
            background: '#142232',
            border: '1px solid #1E3448',
            borderRadius: '16px',
            padding: '32px',
            width: '100%',
            maxWidth: '440px',
          }}
        >
          <h1 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 6px' }}>
            SACS Payroll is unavailable
          </h1>
          <p style={{ fontSize: '13px', color: '#5A7A9A', lineHeight: 1.6, margin: '0 0 24px' }}>
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
              background: '#F5A623',
              color: '#0D1B2A',
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
                color: '#5A7A9A',
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
