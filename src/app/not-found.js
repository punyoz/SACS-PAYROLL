/**
 * 404 page. Previously an unknown path fell through to the default Next.js
 * "This page could not be found" screen, which is white and carries none of
 * the portal's styling.
 *
 * Uses the shared classes in globals.css so it stays in step with the rest of
 * the App Router pages rather than carrying its own palette.
 */

export const metadata = {
  title: "Page not found — SACS Payroll",
};

export default function NotFound() {
  return (
    <main
      className="container"
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <section className="card" style={{ maxWidth: "440px", width: "100%" }}>
        {/* Same seal and wordmark as the error screens (src/app/error.js). */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "18px" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- static public asset */}
          <img src="/legacy/assets/logo-160.png" alt="Shepherd Angels Christian School seal" width={44} height={44} />
          <div>
            <div style={{ fontWeight: 700 }}>SACS Payroll</div>
            <div className="muted" style={{ fontSize: "12px" }}>Shepherd Angels Christian School</div>
          </div>
        </div>
        <h2 style={{ marginBottom: "6px" }}>Page not found</h2>
        <p className="muted" style={{ marginBottom: "20px", lineHeight: 1.6 }}>
          That page does not exist, or you signed out before reaching it. Sign in and
          your portal will open on its own dashboard.
        </p>
        <a
          href="/login"
          className="linkCard"
          style={{
            textAlign: "center",
            minHeight: "44px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 600,
          }}
        >
          Go to sign in
        </a>
      </section>
    </main>
  );
}
