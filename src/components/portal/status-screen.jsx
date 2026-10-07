"use client";

import * as React from "react";
import { ArrowLeftIcon, CompassIcon, LayoutDashboardIcon, LogInIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ROLE_ROUTES, readAuthContext } from "@/app/login/auth-context";

/**
 * A full-page notice in the portals' style: the 404 page and the error
 * boundary (src/app/not-found.js, src/app/error.js). The way out goes to the
 * signed-in person's own portal when the browser still holds a sign-in, and
 * to /login otherwise.
 */
export function StatusScreen({ icon: Icon, code, title, description, primary, digest }) {
  const [home, setHome] = React.useState(null);

  React.useEffect(() => {
    const role = readAuthContext()?.role;
    setHome(ROLE_ROUTES[role] || null);
  }, []);

  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-background px-4 py-8"
      style={{
        backgroundImage:
          "radial-gradient(circle at 100% 0%, color-mix(in oklab, var(--brand-gold) 16%, transparent), transparent 45%), radial-gradient(circle at 0% 100%, color-mix(in oklab, var(--brand-green) 12%, transparent), transparent 50%)",
      }}
    >
      <Card className="w-full max-w-md gap-5 overflow-hidden pt-0 shadow-lg">
        <div aria-hidden="true" className="h-1.5 bg-brand-gold" />
        <CardHeader className="space-y-4">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- static public asset */}
            <img src="/legacy/assets/logo-160.png" alt="Shepherd Angels Christian School seal" width={44} height={44} className="size-11 rounded-full" />
            <div className="leading-tight">
              <p className="font-semibold">SACS Payroll</p>
              <p className="text-xs text-muted-foreground">Shepherd Angels Christian School</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            {Icon ? (
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon className="size-5" aria-hidden="true" />
              </span>
            ) : null}
            <div className="space-y-1.5">
              {code ? <p className="text-xs font-semibold tracking-wider text-gold-text uppercase">{code}</p> : null}
              <CardTitle className="text-xl">
                <h1>{title}</h1>
              </CardTitle>
              <CardDescription className="leading-relaxed">{description}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            {primary}
            {home ? (
              <Button asChild variant={primary ? "outline" : "default"} className="flex-1">
                <a href={home}><LayoutDashboardIcon aria-hidden="true" />Back to my portal</a>
              </Button>
            ) : (
              <Button asChild variant={primary ? "outline" : "default"} className="flex-1">
                <a href="/login"><LogInIcon aria-hidden="true" />Go to sign in</a>
              </Button>
            )}
          </div>
          <Button variant="link" size="sm" className="h-auto px-0 text-muted-foreground" onClick={() => window.history.back()}>
            <ArrowLeftIcon aria-hidden="true" />Go back
          </Button>
        </CardContent>
        {digest ? (
          // The digest is the only detail safe to show: it finds the error in the
          // server logs without revealing the message or stack.
          <CardFooter className="border-t pt-4">
            <p className="font-mono text-xs break-all text-muted-foreground">Reference: {digest}</p>
          </CardFooter>
        ) : null}
      </Card>
    </main>
  );
}

export function NotFoundScreen() {
  return (
    <StatusScreen
      icon={CompassIcon}
      code="Error 404"
      title="Page not found"
      description="That page does not exist, or you signed out before reaching it. Sign in and your portal will open on its own dashboard."
    />
  );
}

export function ErrorScreen({ error, reset }) {
  return (
    <StatusScreen
      icon={TriangleAlertIcon}
      code="Something went wrong"
      title="This screen could not be loaded"
      description="Your data has not been changed. Try again, and if it keeps happening, contact your system administrator."
      primary={<Button className="flex-1" onClick={() => reset()}><RotateCcwIcon aria-hidden="true" />Try again</Button>}
      digest={error?.digest}
    />
  );
}
