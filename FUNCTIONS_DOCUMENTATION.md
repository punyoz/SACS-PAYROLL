# SACS Payroll System: Functions Documentation

**Project:** A web-based payroll management system with RFID-based attendance monitoring
**Documented on:** October 22, 2026 (branch `ehdd`, commit `9e3f6fb`). **Corrected on:** October 29, 2026: entries for code removed since then (RFID terminal management, removed 2026-10-27, and the unused helpers deleted in the 2026-10-29 cleanup) were taken out or rewritten. Features added after October 22 (year-end tax annualization, payroll corrections, salary changes, adjustment approvals) are not yet described here.
**Built with:** Next.js (React) web pages and API routes, a Supabase (PostgreSQL) database, and an RFID card kiosk page.

## How to read this document

- **Organised by page.** Each portal (Login, RFID Terminal, Employee, HR, Accountant, Admin and Super Admin) has its own section. Features shared by several portals (attendance tools, employee management, schedules, tenure, the payroll engine) get their own sections and are listed once.
- **Columns:** Function · File · Purpose · Inputs · Output · Trigger · Uses (database tables / other functions) · Real-world example. A "—" means "none" or "no special example".
- **Grouped names:** When several tiny functions do closely related jobs, they share one row, separated by " / " (for example, `formatPeso` / `formatPesoShort`).
- **Button and form handlers:** Inline handlers in the page markup (`onClick`, `onSubmit`, `onChange`) usually just call a named function. They are listed under the function they call, and the Trigger column names the button or form.
- **Server vs. browser:** "API route" functions run on the server when a page calls an address under `/api/...`. Page and component functions run in the user's browser.
- **Database functions** (Section 15) live inside PostgreSQL. They enforce the rules even if someone bypasses the web pages.
- **Needs review** marks anything whose purpose could not be confirmed from the code.
- **Not included:** automated test code (`tests/`, `e2e/`). It checks the system but is not part of it. Configuration files are listed in Section 13.4, but they define no functions.
- **About the app:** there are 9 page entry files (`page.js`), 72 API route files and 344 JavaScript source files under `src/`. There are also 8 script and Edge Function files and 116 database migration files (counts as of October 29, 2026).

## Summary

| # | Page / Section | Number of functions | Short description of the page |
|---|---|---|---|
| 1 | Login & Account Security | 201 | Sign-in page with the emailed 6-digit code, forgot password, sessions, one-session-per-account, attempt limits and the permission guard used by every server route. |
| 2 | RFID Terminal (Time In / Time Out) | 134 | The kiosk page where employees tap their RFID card. It records Time In and Time Out, ignores repeat taps, queues taps while offline and runs the nightly close. Also covers RFID card management (registered terminals were removed on October 27, 2026). |
| 3 | Employee Portal | 86 | The employee's own Dashboard, Attendance, Timesheet, Payslips, Leave and Profile pages. |
| 4 | HR Portal | 156 | HR Dashboard, Employee (User) Management, Transfers, Attendance Monitoring, Leave Approval, AWOL cases, Payroll Approval, Payroll Records and Reports. |
| 5 | Attendance Monitoring Tools | 71 | Attendance corrections, overtime, holidays, the status board and employee attendance records. Used by HR, Admin and Super Admin. |
| 6 | Employee Management (server and rules) | 97 | Creating, importing, editing, transferring and archiving employee accounts, plus staff IDs, name rules and licensed teachers. |
| 7 | Work Schedules & Early Bird | 49 | Work schedules per employee, school level and branch, and the monthly Early Bird incentive winner. |
| 8 | Tenure Pay Protection | 51 | Protects the pay of long-serving employees by waiving certain deductions. |
| 9 | Accountant Portal (Payroll) | 232 | Process Payroll, Records, Payslips, Loans, Incentives, Cash Advances, 13th Month, Subsidies, Final Pay, Monitoring and Reports. |
| 10 | Payroll Computation Engine | 214 | Salary, attendance deductions, overtime, holiday pay, SSS, PhilHealth, Pag-IBIG, withholding tax, loans, 13th month, final pay, payslip PDF, BIR 2316 and alphalist, and the live preview the Accountant sees. |
| 11 | Admin Portal (Branch Management) | 98 | The branch admin's dashboard, attendance, recommendations, reports to HR, announcements, payroll summary, branch reports and RFID. |
| 12 | Super Admin Portal (Settings) | 161 | System dashboard, Admin and HR accounts, branches, roles, maintenance, system configuration (rates, tax, pay calendar), audit logs and backups. |
| 13 | Roles, System Health, Scripts and UI Building Blocks | 230 | The permission matrix, health check, developer and maintenance scripts, configuration files and 161 standard screen pieces (buttons, dialogs, tables). |
| 14 | Shared Portal Framework | 222 | The sidebar, top bar, session check, notifications, account dialogs, data table, server calls, formatting and export helpers used by every page. |
| 15 | Database Functions & Triggers | 138 | Rules inside the database: attendance status, payroll commit and approval, RFID card rules, encryption, sign-in security and scheduled nightly jobs. |
| 16 | Appendix: Inner Helpers | 85 | Small helper functions written inside bigger functions. |
| | **Total** | **2,225** | |

*How the count was made:* every function name in the first column of each table was counted (grouped rows count each name), plus each UI component in Section 13.5. A few names, such as `cell` and `filtered`, exist separately in more than one file and are counted once per file.

---

## 1. Login & Account Security

**Web address:** `/login` (the home page `/` sends everyone here).
**Who uses it:** Everyone: Super Admin, Admin, HR, Accountant and Employee.
**What the page does:** The user types a username or email and a password. The system then emails a 6-digit code (OTP), and the user types it to finish signing in. The page also has a "Forgot password?" dialog. This section also covers the behind-the-scenes code that keeps a signed-in session safe: the session cookie, one-sign-in-per-account, attempt limits, the password rules and the code emails.

### 1.1 Sign-in screen (what the user sees)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `HomePage` | src/app/page.js | Sends anyone who opens the bare site address to the sign-in page. | none | Redirect to `/login` | Opening the site's main address | Next.js `redirect` | A teacher types the site address and lands on the sign-in page. |
| `RootLayout` | src/app/layout.js | The outer frame of every page; adds Vercel analytics only when the site runs on Vercel. | `children` (the page) | The HTML page shell | Every page load | Vercel `Analytics`, `SpeedInsights` | Wraps every page of the system. |
| `LoginLayout` | src/app/login/layout.js | Frame for the sign-in page: loads the fonts, the light/dark theme and pop-up messages. | `children` | Page wrapper | Opening `/login` | `ThemeScope`, `Toaster` | Gives the sign-in page its fonts and pop-up notices. |
| `LoginPage` | src/app/login/page.js | Shows the sign-in screen. | none | The `LoginScreen` component | Opening `/login` | `LoginScreen` | Opening the sign-in page. |
| `LoginScreen` | src/app/login/login-screen.jsx | Main sign-in screen. Switches between the password step and the emailed-code step, and opens the reset-password dialog. | none | The sign-in screen | Page load | `PasswordStep`, `CodeStep`, `ResetPasswordDialog`, `GreenAuthLayout` | The screen everyone sees before entering the system. |
| (page-load effect inside `LoginScreen`) | src/app/login/login-screen.jsx | Shows why the user was signed out (for example, they signed in on another device). If the browser still has a live session, it goes straight to the user's portal. | URL `?reason=`, saved sign-in details | Notice message, or a redirect to the portal | Page load | `readAuthContext`, `clearAuthContext`, `GET /api/rbac/me` | An HR officer whose session timed out sees "Your session has expired. Please sign in again." |
| `onPageShow` | src/app/login/login-screen.jsx | If the browser's Back button brings back the sign-in page while the user is still signed in, it moves them to their portal. | browser `pageshow` event | Redirect | Browser Back/Forward | `GET /api/rbac/me` | An Accountant presses Back after signing in and is returned to the Accountant portal. |
| `onOtpRequired` | src/app/login/login-screen.jsx | Moves the screen to the "Check your email" step and remembers when the code was sent. | masked email, seconds until a resend is allowed | Updates the screen | The server replies that a code is needed | `setStep` | After a correct password, the screen changes to "Enter the 6-digit code". |
| `backToPassword` | src/app/login/login-screen.jsx | Returns from the code step to the password step. | none | Screen change | "Different account" button, or a lockout | — | A user who typed the wrong account clicks "Different account". |
| `onResent` | src/app/login/login-screen.jsx | Restarts the code's 5-minute countdown after a new code is sent. | none | Updates the timer | After "Resend code" succeeds | — | The countdown restarts at 5:00 after a resend. |
| `postJson` | src/app/login/login-screen.jsx | Sends data to a server address and reads the reply. | URL, data | Server response and its data | Called by the sign-in steps | `fetch` | Used whenever the sign-in screen talks to the server. |
| `useCountdown` | src/app/login/login-screen.jsx | Counts down the seconds to a set time, ticking once per second. | target time | Seconds left | Code step on screen | `setInterval` | Shows "Resend code (42s)". |
| `formatClock` | src/app/login/login-screen.jsx | Turns seconds into minutes:seconds. | seconds | Text such as "4:05" | Each countdown tick | — | Shows "Code expires in 4:05". |
| `GreenAuthLayout` | src/app/login/login-screen.jsx | The green background, seal and footer around the sign-in and first-password screens. | `children`, `footnote` | Page layout | Screen display | `ThemeToggle` | The green background around the sign-in card. |
| `PasswordStep` | src/app/login/login-screen.jsx | The username/email and password form, with a show/hide password button. | `notice`, `onOtpRequired`, `onForgot` | Sign-in form | Screen display | `submit` | Step 1 of signing in. |
| `submit` (in `PasswordStep`) | src/app/login/login-screen.jsx | Checks that both boxes are filled, then sends the username and password to the server. It goes to the code step, or opens the portal. | username/email, password | Error message, code step, or the portal | "Sign in" button / Enter key (form submit) | `postJson("/api/legacy-auth/login")`, `saveAuthContext` | An employee types "juan@school.edu" and their password, then clicks Sign in. |
| `CodeStep` | src/app/login/login-screen.jsx | The "Check your email" screen with six code boxes, an expiry timer and a resend button. | masked email, sent time, resend wait, `onBack`, `onResent` | Code form | Server asks for a code | `verify`, `resend`, `readTestInbox` | Step 2 of signing in. |
| (mail.tm check effect in `CodeStep`) | src/app/login/login-screen.jsx | Asks the server whether the developer test inbox is switched on, to show or hide the test-inbox button. | none | Shows or hides the button | Code step opens | `GET /api/dev/mailtm` | Only appears on a developer's computer. |
| `verify` (in `CodeStep`) | src/app/login/login-screen.jsx | Sends the 6-digit code to the server. On success it saves the user's details and opens their portal. | 6-digit code | Opens the portal, or shows an error | Typing the 6th digit, or the "Verify & sign in" button | `postJson("/api/legacy-auth/verify-login-otp")`, `saveAuthContext` | A teacher types 482913 from their email and enters the Employee portal. |
| `resend` (in `CodeStep`) | src/app/login/login-screen.jsx | Asks the server to email a new code and restarts the countdown. | none | New code is emailed | "Resend code" button | `postJson("/api/legacy-auth/resend-login-otp")` | The code email never arrived, so the user clicks Resend after 60 seconds. |
| `readTestInbox` | src/app/login/login-screen.jsx | Developer only: reads the code from a mail.tm test inbox and fills it in. | none | Code filled in | "Read code from test inbox" button | `POST /api/dev/mailtm` | A developer testing sign-in without a real mailbox. |

### 1.2 Saved sign-in details (browser)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `toTitleCase` | src/app/login/auth-context.js | Capitalizes the first letter of each word. | text | Text such as "Juan Dela Cruz" | Called by `inferNameFromIdentity` | — | "juan dela cruz" becomes "Juan Dela Cruz". |
| `inferNameFromIdentity` | src/app/login/auth-context.js | Guesses a display name from an email when no name is on file. | email or username | Name | Called by `buildAuthContext` | `toTitleCase` | "maria.santos@school.edu" becomes "Maria Santos". |
| `text` | src/app/login/auth-context.js | Turns any value into trimmed text (empty if missing). | value | Text | Called by `buildAuthContext` | — | Cleans each profile field. |
| `buildAuthContext` | src/app/login/auth-context.js | Builds the display details (name, role, IDs, branch, "must change password") from the server's sign-in reply. | sign-in reply, role, typed identity | Details object | Called by `saveAuthContext` | `text`, `inferNameFromIdentity` | Prepares the name shown in the portal header. |
| `saveAuthContext` | src/app/login/auth-context.js | Saves those display details in the browser for the portals to read. | sign-in reply, role, identity | none (saved to browser storage) | Successful sign-in, code check or password reset | `buildAuthContext`, `localStorage` | After sign-in, the portal header knows to show "Maria Santos". |
| `readAuthContext` | src/app/login/auth-context.js | Reads the saved display details back. | none | Details object, or nothing | Portal or sign-in page load | `localStorage` | A portal reads the user's name on load. |
| `clearAuthContext` | src/app/login/auth-context.js | Deletes the saved display details. | none | none | Sign-out, or a session that ended | `localStorage` | Clicking Sign out removes the saved name. |
| `evaluatePasswordShape` | src/app/login/auth-context.js | Checks a new password against the visible checklist: at least 8 characters, letters and numbers, an uppercase letter, a symbol, no spaces, and both boxes match. | new password, confirmation | A yes/no for each rule | Typing in a new-password box | — | The ticks turn green as the user types "Sacs2026!". |

### 1.3 Forgot-password dialog

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `ResetPasswordDialog` | src/app/login/reset-password-dialog.jsx | A 3-step dialog: (1) Employee ID or email, (2) the emailed code, (3) the new password. | `open`, `onOpenChange` | Dialog | "Forgot password?" link | `send`, `verify`, `reset`, `submit` | An employee who forgot their password resets it from the sign-in page. |
| (open effect in `ResetPasswordDialog`) | src/app/login/reset-password-dialog.jsx | Clears the dialog back to step 1 every time it opens. | `open` | Cleared form | Dialog opens | — | Reopening the dialog starts fresh. |
| `post` | src/app/login/reset-password-dialog.jsx | Sends one step of the reset to the server. | data with `action` | Response and data | Called by `send`, `verify`, `reset` | `POST /api/legacy-auth/reset-password` | Every reset step uses it. |
| `PasswordField` | src/app/login/reset-password-dialog.jsx | A password box with a show/hide button. | id, label, value, `onChange` | Input box | Step 3 display | — | The "New password" box. |
| `restart` | src/app/login/reset-password-dialog.jsx | Sends the dialog back to step 1 with a message (for example, the code expired). | message | Dialog reset | Code expired or locked | — | After 5 wrong codes: "Request a new code." |
| `send` | src/app/login/reset-password-dialog.jsx | Asks the server to email a reset code to the account's registered email. | Employee ID or email | Moves to the code step | "Send code" / "Resend code" | `post({action:"send"})` | A teacher types "SACS-001" and a code is emailed. |
| `verify` | src/app/login/reset-password-dialog.jsx | Checks the reset code. | 6-digit code | Moves to the password step, or shows an error | Typing the 6th digit / "Verify code" | `post({action:"verify"})` | The code matches and the new-password boxes appear. |
| `reset` | src/app/login/reset-password-dialog.jsx | Checks the password rules, then saves the new password. It signs the user in, or sends them back to the sign-in page. | new password, confirmation | Opens the portal, or reloads sign-in | "Reset password" button | `post({action:"reset"})`, `evaluatePasswordShape`, `saveAuthContext` | The employee sets "Angel2026!" and goes straight to their portal. |
| `submit` | src/app/login/reset-password-dialog.jsx | Runs the right step (send, verify or reset) when the form is submitted. | form event | Calls one step | Enter key / main button | `send`, `verify`, `reset` | Pressing Enter at any step. |

### 1.4 Sign-in and account API routes (server)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `resolveLoginEmail` | src/app/api/legacy-auth/login/route.js | Turns what the user typed into the email to check. Built-in usernames (for example "sacsadmin") map to their email. | typed username or email | Email, or empty | Called by `handleLogin` | `normalizeText`, `normalizeRoleEmail` | "sacshr" becomes the HR account's email. |
| `maskEmail` | src/app/api/legacy-auth/login/route.js | Hides most of an email for display. | email | Text such as "t***@school.edu" | Called by `handleLogin` | — | The code screen says the code went to "t***@school.edu". |
| `handleLogin` | src/app/api/legacy-auth/login/route.js | Step 1 of sign-in. Checks the attempt limits and the password, refuses archived or role-less accounts, decides whether a password change is required, then emails the 6-digit code. | `employeeId`/`username`, `password` | `{otp_required, masked_email}` plus a short-lived "pending sign-in" cookie, or an error | "Sign in" button | Supabase Auth `signInWithPassword`; `profiles` table; `checkLoginAllowed`, `loginRetryAfter`, `resolveLoginProfile`, `mustChangePassword`, `isPasswordExpired`, `sendEmailOtp`, `attachPendingLogin`, `completeLogin` | An Admin types the correct password and receives a code email. |
| `POST` (login) | src/app/api/legacy-auth/login/route.js | Runs `handleLogin` and turns any unexpected crash into a friendly message. | request | JSON reply | POST `/api/legacy-auth/login` | `handleLogin`, `sanitizeError` | Protects the sign-in from showing a blank error if the database is down. |
| `handleVerify` (login code) | src/app/api/legacy-auth/verify-login-otp/route.js | Step 2 of sign-in. Checks the emailed code (5 wrong tries at most), re-reads the account and its profile, then starts the real session. | `code`; the pending-sign-in cookie | Session cookie and portal address, or an error | Code entered | `readPendingLogin`, `checkVerifyAllowed`, `otpAllowed`, `verifyEmailOtp`, `resolveLoginProfile`, `completeLogin`; tables `auth_email_otps`, `profiles` | An HR officer types the correct code and enters the HR portal. |
| `POST` (verify code) | src/app/api/legacy-auth/verify-login-otp/route.js | Runs `handleVerify` safely. | request | JSON | POST `/api/legacy-auth/verify-login-otp` | `handleVerify` | — |
| `handleResend` | src/app/api/legacy-auth/resend-login-otp/route.js | Emails a fresh sign-in code (at most once per 60 seconds). The old code stops working. | the pending-sign-in cookie | Success, or "please wait" | "Resend code" button | `checkResendAllowed`, `sendEmailOtp`, `recordCodeSent`, `otpReset`, `attachPendingLogin` | The first email went to spam, so the user asks for another. |
| `POST` (resend) | src/app/api/legacy-auth/resend-login-otp/route.js | Runs `handleResend` safely. | request | JSON | POST `/api/legacy-auth/resend-login-otp` | `handleResend` | — |
| `POST` (logout) | src/app/api/legacy-auth/logout/route.js | Signs the user out by deleting the session cookie. | none | `{success:true}` | "Sign out" button | `clearSession` | A cashier finishes for the day and signs out. |
| `GET` (session) | src/app/api/legacy-auth/session/route.js | A heartbeat the portals call every few seconds to check that the session is still valid. | session cookie | `{authenticated, role}` or 401 | Timer in every portal | `readSession` | If the same account signs in on another computer, this check fails and the first browser signs out. |
| `clients` | src/app/api/legacy-auth/reset-password/route.js | Creates the two database connections the reset needs (admin and normal). | none | Two clients | Called by the reset steps | Supabase client | — |
| `fail` (reset) | src/app/api/legacy-auth/reset-password/route.js | Builds an error reply. | message, status, code | JSON error | Any failed reset step | — | "Too many incorrect attempts." |
| `resolveUser` | src/app/api/legacy-auth/reset-password/route.js | Finds the account by Employee ID or email. | admin client, identity | User, or nothing | Called by `handleSend`/`handleVerify` | `listUsersCached`, `findUserByIdentity` | Finds the account for "SACS-014". |
| `handleSend` | src/app/api/legacy-auth/reset-password/route.js | Reset step 1. Emails a reset code. It gives the same reply whether or not the account exists, so nobody can test which accounts exist. | `identity` | Generic "if the account exists..." reply and a step cookie | "Send code" | `checkResendAllowed`, `canResetPassword`, `sendEmailOtp`, `attachPasswordOtpState` | An employee asks for a reset code. |
| `handleVerify` (reset) | src/app/api/legacy-auth/reset-password/route.js | Reset step 2. Checks the reset code and, if correct, grants a 10-minute window to set a new password. | `code`; step cookie | "verified" reply and a grant cookie | "Verify code" | `readPasswordOtpState`, `verifyEmailOtp`, `otpFailure`, `passwordChangedMarker` | The code is correct and the password boxes unlock. |
| `handleReset` | src/app/api/legacy-auth/reset-password/route.js | Reset step 3. Checks the password rules and known-breach lists, and makes sure the password differs from the old one. Then it saves the password and signs the user in. | `password`, `confirm_password`; grant cookie | Session and portal address, or "sign in again" | "Reset password" | `validateNewPassword`, `breachedPasswordError`, Supabase `updateUserById`, `resolveLoginProfile`, `completeLogin` | The employee's new password is saved and they enter their portal. |
| `signInAgain` | src/app/api/legacy-auth/reset-password/route.js | Fallback reply: "password reset, please sign in" when an automatic sign-in isn't possible. | none | JSON | Inside `handleReset` | `clearPasswordOtpState` | — |
| `POST` (reset-password) | src/app/api/legacy-auth/reset-password/route.js | Sends each request to the right step (send, verify or reset). | `{action,...}` | JSON | Any reset request | `handleSend`, `handleVerify`, `handleReset` | — |
| `POST` (change-password) | src/app/api/legacy-auth/change-password/route.js | Changes the signed-in user's own password. Checks the current password and the rules, and the emailed-code grant (not needed on the first-sign-in change). | `current_password`, `new_password`, `confirm_password` | Success, with the "must change password" flag lifted | "Change password" in Account Settings, or the first-sign-in screen | `requirePermission`, `validateNewPassword`, `breachedPasswordError`, `readPasswordOtpState`, `reissueSession`; `profiles` table | A new teacher replaces the default password "DelaCruz10082004!" on first sign-in. |
| `fail` (change-password-otp) | src/app/api/legacy-auth/change-password-otp/route.js | Builds an error reply (never a 401, so the user isn't signed out). | message, status, code | JSON | Failed step | — | — |
| `sendCode` | src/app/api/legacy-auth/change-password-otp/route.js | Emails a password-change code, respecting the 60-second wait. | email, throttle key, user ID | nothing, or an error reply | Inside `POST` | `checkResendAllowed`, `sendEmailOtp`, `recordCodeSent`, `otpReset` | — |
| `POST` (change-password-otp) | src/app/api/legacy-auth/change-password-otp/route.js | The emailed-code steps of a voluntary password change: "start" (check the current password and email a code), "resend", and "verify". | `{action, current_password, code}` | Step cookie and message | Account Settings → Change password | `requirePermission`, `verifyEmailOtp`, `attachPasswordOtpState`, `maskEmail` | An Accountant changing their password must first enter the code sent to their email. |
| `GET` (update-profile) | src/app/api/legacy-auth/update-profile/route.js | Returns the user's own name, contact details, emergency contact and masked government numbers (for example "••••1234"). | session | Profile | Profile page load | `requirePermission`, `profiles` table, `maskedPii` | The Employee "My Profile" page loads the user's details. |
| `POST` (update-profile) | src/app/api/legacy-auth/update-profile/route.js | Saves the user's own name, mobile number, address and emergency contact, with format checks. Employees and Accountants cannot change their own government numbers. | name parts, `cp_number`, address, emergency contact, government numbers | Saved profile (masked) | "Save" in Edit Account | `requirePermission`, `validateNameParts`, `validateEmergencyContactUpdate`, Supabase `updateUserById`, `profiles` table | A teacher updates their mobile number to 09171234567. |
| `GET` (rbac/me) | src/app/api/rbac/me/route.js | Tells the portal who is signed in: role, branch, permissions, sidebar menu, allowed pages and the organization name. | session cookie | User and permission details | Every portal load | `readSession`, `resolveCurrentBranchId`, `buildMenu`, `allowedPagesFor`, `defaultPageFor`, `loadOrgName` | The HR portal builds its sidebar from this reply. |

### 1.5 Sign-in security helpers (server library)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `newSessionId` | src/lib/auth/active-session.js | Creates a new random ID for a sign-in. | none | Unique ID | Called by `completeLogin` | `crypto.randomUUID` | — |
| `registerActiveSession` | src/lib/auth/active-session.js | Records this sign-in as the account's only valid one, so any older sign-in elsewhere ends. | user ID, session ID | none (throws on failure) | Successful sign-in | Supabase Auth `app_metadata` | Signing in on the office PC ends the session on the home laptop. |
| `fetchEntry` | src/lib/auth/active-session.js | Reads the account's current session ID and whether it is archived. | client, user ID | Entry, or nothing | Called by `checkActiveSession` | Supabase Auth; `profiles.archived` | — |
| `judge` | src/lib/auth/active-session.js | Decides whether a cookie is the current sign-in, replaced, revoked or archived. | entry, session ID | Status word | Called by `checkActiveSession` | — | — |
| `revokeActiveSession` | src/lib/auth/active-session.js | Ends a user's sign-in on purpose (after their role or branch changes). | user ID | true/false | Admin changes a user's role or branch | Supabase Auth `app_metadata` | An Admin moved to another branch is signed out and must sign in again. |
| `checkActiveSession` | src/lib/auth/active-session.js | Checks (with a 5-second memory) whether a cookie still belongs to the account's active sign-in. | user ID, session ID | "current", "replaced", "revoked", "archived" or "unknown" | Every request, through the proxy | `fetchEntry`, `judge` | — |
| `isEnabled` | src/lib/auth/breached-password.js | Says whether the breached-password check is on. | environment setting | true/false | Called by `breachCount` | — | — |
| `breachCount` | src/lib/auth/breached-password.js | Asks the free "Have I Been Pwned" service how often a password appears in leaks. Only 5 characters of its hash are sent. | password | Number of times found (0 if none or the service is down) | Password change or reset | pwnedpasswords.com API | Refuses "Password1!" because it is in leaked lists. |
| `breachedPasswordError` | src/lib/auth/breached-password.js | Returns a refusal message if the password was leaked. | password | Message, or nothing | Password change or reset | `breachCount` | "This password has appeared in a known data breach." |
| `profileRefusal` | src/lib/auth/complete-login.js | Stops a sign-in when the account has no staff profile, or the profile cannot be read. | resolved profile | Error and status, or nothing | Sign-in | — | "This account has no staff profile yet... Contact HR." |
| `isArchivedProfile` | src/lib/auth/complete-login.js | Checks whether the account's profile is archived. | resolved profile | true/false | Sign-in | — | A resigned employee cannot sign in. |
| `isRoutableRole` | src/lib/auth/complete-login.js | Checks that a role is one of the five known portals. | role | true/false | Password reset auto sign-in | `ROLE_ROUTES` | — |
| `completeLogin` | src/lib/auth/complete-login.js | The last step of every sign-in. Registers the session as the only active one and issues the signed session cookie (with the idle timeout). | user ID, resolved profile, must-change flag | Reply with the session cookie and portal address | Code verified, or password reset | `profileRefusal`, `registerActiveSession`, `buildProfilePayload`, `loadSecuritySettings`, `attachSession` | — |
| `otpRowKey` | src/lib/auth/email-otp.js | Builds the storage key for a code, for example "login:<user id>". | purpose, user ID | Key text | Send or verify a code | — | — |
| `generateOtpCode` | src/lib/auth/email-otp.js | Makes a random 6-digit code (leading zeros kept). | none | Code such as "048213" | Sending a code | `crypto.randomInt` | — |
| `hashOtpCode` | src/lib/auth/email-otp.js | Scrambles the code so only its fingerprint is stored. | key, code | Hash | Send or verify | `sign` | — |
| `normalizeOtpInput` | src/lib/auth/email-otp.js | Removes spaces from a typed code. | text | Cleaned text | Code check | — | "482 913" becomes "482913". |
| `isOtpFormat` | src/lib/auth/email-otp.js | Checks that the code is exactly 6 digits. | code | true/false | Code check | — | — |
| `sendEmailOtp` | src/lib/auth/email-otp.js | Creates a code, stores its fingerprint (valid 5 minutes, 5 tries, 60 seconds between sends) and emails it through Gmail. | purpose, user ID, email, name | ok, or an error with a wait time | Sign-in, reset, password change | database functions `auth_email_otp_issue`/`auth_email_otp_discard` (table `auth_email_otps`); `buildOtpEmail`, `sendMail`, `loadOrgName` | The sign-in code email arrives in the teacher's Gmail. |
| `verifyEmailOtp` | src/lib/auth/email-otp.js | Checks a typed code against the stored fingerprint. A code works only once. | purpose, user ID, code | "ok", "invalid", "locked" or "expired" | Code entered | database function `auth_email_otp_verify` | — |
| `invalidateBranchCache` | src/lib/auth/live-branch.js | Forgets the remembered branch of a user (or of everyone). | user ID (optional) | none | After a branch change | — | — |
| `resolveCurrentBranchId` | src/lib/auth/live-branch.js | Reads a user's current branch from the database (remembered for 5 seconds), so a branch move takes effect without signing out. | user ID, fallback branch | Branch ID | Every guarded request | `profiles.branch_id` | An Admin moved from Antipolo to another branch sees the new branch's data on their next click. |
| `friendlyLoginError` | src/lib/auth/login-errors.js | Turns technical sign-in errors into plain messages. A wrong email and a wrong password give the same message. | Supabase error | Message | Failed sign-in | — | Shows "Incorrect email or password." |
| `requiresLoginOtp` | src/lib/auth/otp-policy.js | Says whether a role must enter an emailed code to sign in (currently every role). | role | true/false | Sign-in, password change | `OTP_REQUIRED_ROLES` | — |
| `sweep` (login throttle) | src/lib/auth/login-throttle.js | Clears old attempt counters so memory doesn't fill up. | counter map, time | none | After a failed attempt | — | — |
| `inspect` | src/lib/auth/login-throttle.js | Checks whether a counter has reached its limit and starts a 15-minute lockout. | counters, key, limits | blocked?, seconds to wait | Called by `checkLoginAllowed` | — | — |
| `clientAddressFrom` | src/lib/auth/login-throttle.js | Finds the caller's internet address from the request headers. | request | IP address | Sign-in, audit logging | — | Used to count attempts per computer. |
| `checkLoginAllowed` | src/lib/auth/login-throttle.js | Blocks sign-in after too many failures: per account (default 5, set by the Super Admin) and per IP address (30). | identity, address, max attempts | blocked?, wait time | Before checking a password | `inspect` | After 5 wrong passwords: "Try again in 15 minutes." |
| `bump` | src/lib/auth/login-throttle.js | Adds one to an attempt counter. | counters, key | none | Failed sign-in | — | — |
| `recordFailedLogin` | src/lib/auth/login-throttle.js | Counts a failed sign-in against the account and the IP address. | identity, address | none | Wrong password | `bump`, `sweep` | — |
| `recordSuccessfulLogin` | src/lib/auth/login-throttle.js | Clears the account's failure count after a correct password. | identity | none | Correct password | — | — |
| `resetLoginThrottle` | src/lib/auth/login-throttle.js | Clears all counters (used by automated tests). | none | none | Tests | — | — |
| `sweep` (OTP throttle) | src/lib/auth/otp-throttle.js | Trims old code counters. | map, test | none | Internal | — | — |
| `normalizeKey` (OTP throttle) | src/lib/auth/otp-throttle.js | Cleans a counter key. | user ID | Text | Internal | — | — |
| `checkVerifyAllowed` | src/lib/auth/otp-throttle.js | Checks whether more code guesses are allowed (5 maximum). | key | allowed?, tries left | Before checking a code | — | — |
| `recordVerifyFailure` | src/lib/auth/otp-throttle.js | Counts a wrong code. | key | allowed?, tries left | Wrong code | — | After the 5th wrong code the user must start again. |
| `resetVerifyAttempts` | src/lib/auth/otp-throttle.js | Clears the wrong-code count. | key | none | Correct code | — | — |
| `checkResendAllowed` | src/lib/auth/otp-throttle.js | Enforces the 60-second wait between code emails. | key, time, wait length | allowed?, seconds left | "Resend code" | — | — |
| `recordCodeSent` | src/lib/auth/otp-throttle.js | Starts the 60-second wait and resets the wrong-code count. | key | none | Code emailed | — | — |
| `passwordChangeThrottleKey` | src/lib/auth/otp-throttle.js | Makes a separate counter key for password-change codes. | user ID | Key | Password change | — | — |
| `resetOtpThrottle` | src/lib/auth/otp-throttle.js | Clears all code counters (tests). | none | none | Tests | — | — |
| `normalizeKey`, `loginIdentityKey`, `loginAddressKey`, `otpKey` | src/lib/auth/persistent-throttle.js | Build the database keys for the attempt counters. | identity / address / key | Key text | Internal | — | — |
| `persistentRetryAfter` | src/lib/auth/persistent-throttle.js | Asks the database how long a key must wait (shared across all server copies). | key, max, lockout | Seconds (0 = allowed) | Sign-in, code check | database function `auth_throttle_check` (table `auth_throttle`) | — |
| `persistentFailure` | src/lib/auth/persistent-throttle.js | Records a failed attempt in the database. | keys, window | none | Failed attempt | `auth_throttle_fail` | — |
| `persistentClear` | src/lib/auth/persistent-throttle.js | Clears a database counter. | key | none | Success | `auth_throttle_clear` | — |
| `loginRetryAfter` | src/lib/auth/persistent-throttle.js | Database version of the sign-in lockout (per account and per IP). | identity, address, max | Seconds | Sign-in | `persistentRetryAfter` | — |
| `recordLoginFailure` / `recordLoginSuccess` | src/lib/auth/persistent-throttle.js | Count a failed sign-in / clear the count after success, in the database. | identity, address | none | Sign-in result | `persistentFailure`, `persistentClear` | — |
| `otpAllowed` / `otpFailure` / `otpReset` | src/lib/auth/persistent-throttle.js | Database version of the 5-wrong-codes limit: check, count a wrong code, reset. | key | allowed? / none | Code steps | `persistentRetryAfter`, `persistentFailure`, `persistentClear` | — |
| `flowConfig` | src/lib/auth/password-otp.js | Picks the cookie name for the "reset" or "change" flow. | flow | Settings | Internal | — | — |
| `cookieOptions` (password OTP) | src/lib/auth/password-otp.js | Security settings for the step cookie. | lifetime | Options | Internal | — | — |
| `attachPasswordOtpState` | src/lib/auth/password-otp.js | Saves which step the user reached ("otp" or "verified") in a signed cookie. | response, flow, claims | Response | Reset or change steps | `sign`, `base64UrlEncode` | — |
| `clearPasswordOtpState` | src/lib/auth/password-otp.js | Deletes the step cookie. | response, flow | Response | Finished or failed flow | — | — |
| `readPasswordOtpState` | src/lib/auth/password-otp.js | Reads and checks the step cookie (signature, purpose, expiry). | request, flow | Claims, or nothing | Verify or reset step | `sign`, `safeEqual` | — |
| `passwordChangedMarker` | src/lib/auth/password-otp.js | Gets the time the password was last changed, so one verification can change the password only once. | user | Text | Verify or reset | — | — |
| `resetThrottleKey` | src/lib/auth/password-otp.js | Counter key for a reset, based on what was typed. | identity | Key | Reset | — | — |
| `findUserByIdentity` | src/lib/auth/password-otp.js | Finds an account by Employee ID or email. | users, identity | User | Reset | — | — |
| `canResetPassword` | src/lib/auth/password-otp.js | Checks that the account has an email, is not archived and has a role. | user | true/false | Reset | `requiresLoginOtp` | — |
| `maskEmail` | src/lib/auth/password-otp.js | Hides most of an email. | email | "t***@school.edu" | Password-change message | — | — |
| `toTitleCaseWords` | src/lib/auth/password-policy.js | Capitalizes the words of a name. | text | Text | Building a default password | — | — |
| `formatDateForPassword` | src/lib/auth/password-policy.js | Changes a birth date from YYYY-MM-DD to MMDDYYYY. | date | Text | Default password | — | 2004-10-08 becomes 10082004. |
| `buildDefaultPassword` | src/lib/auth/password-policy.js | Builds a new account's first password: last name + birth date + "!". | last name, birth date | Password | Creating an account | `formatDateForPassword` | Dela Cruz, born 2004-10-08, gets "DelaCruz10082004!". |
| `lastNameCandidates` | src/lib/auth/password-policy.js | Lists the possible last-name forms from a full name. | full name | List | Internal | — | — |
| `isDefaultPassword` | src/lib/auth/password-policy.js | Checks whether a password is still the default pattern for this person. | password, name, birth date | true/false | Sign-in, password change | `lastNameCandidates` | — |
| `hashingKey` | src/lib/auth/password-policy.js | Gets the secret used to fingerprint first-time passwords. | environment | Key | Internal | — | — |
| `hashTemporaryPassword` | src/lib/auth/password-policy.js | Fingerprints an issued first-time password so it can be recognized later. | password | Hash | Account creation, password reset by an admin | `hashingKey` | — |
| `matchesTemporaryPassword` | src/lib/auth/password-policy.js | Checks whether a password equals the issued first-time one. | password, app metadata | true/false | Sign-in | `hashTemporaryPassword` | — |
| `mustChangePassword` | src/lib/auth/password-policy.js | Decides at sign-in whether the user must replace their password first. | password, user, name | true/false | Sign-in | `matchesTemporaryPassword`, `isDefaultPassword` | A new employee is forced to the change-password screen. |
| `validateNewPassword` | src/lib/auth/password-policy.js | Checks a chosen password: minimum length (set by the Super Admin), 72 maximum, no spaces, letters and numbers, an uppercase letter, a symbol, not the old password, not the default. | new password, options | Error message, or nothing | Change or reset | `isDefaultPassword` | Refuses "sacs1234" because it has no uppercase letter. |
| `createPendingLoginToken` | src/lib/auth/pending-login.js | Makes the signed 10-minute "password OK, waiting for the code" token. | user ID, email, must-change flag | Token | Password step | `sign` | — |
| `verifyPendingLoginToken` | src/lib/auth/pending-login.js | Checks that token's signature, purpose and expiry. | token | Claims, or nothing | Code step | `sign`, `safeEqual` | — |
| `cookieOptions` (pending) | src/lib/auth/pending-login.js | Cookie security settings. | lifetime | Options | Internal | — | — |
| `attachPendingLogin` / `clearPendingLogin` | src/lib/auth/pending-login.js | Set or delete the pending-sign-in cookie. | response, claims | Response | Password step / code done | `createPendingLoginToken` | — |
| `readPendingLogin` | src/lib/auth/pending-login.js | Reads the pending-sign-in cookie from a request. | request | Claims, or nothing | Code, resend, dev inbox | `verifyPendingLoginToken` | — |
| `toTitleCaseWords`, `inferNameFromEmail` | src/lib/auth/resolve-profile-claims.js | Capitalize a name / guess a name from an email. | text | Name | Internal | — | — |
| `normalizePositionForRole` | src/lib/auth/resolve-profile-claims.js | Picks a default position label ("Accountant" or "Employee"). | position, role | Label | Internal | `normalizeRole` | — |
| `resolveLoginProfile` | src/lib/auth/resolve-profile-claims.js | Reads the account's profile (role, branch, name, IDs, staff ID) from the database for sign-in. | URL, key, user, role | Resolved details | Sign-in, code check, reset | `profiles` table, `maskedPii` | — |
| `buildProfilePayload` | src/lib/auth/resolve-profile-claims.js | Shapes the profile details sent back to the browser after sign-in. | resolved details, must-change flag | Profile object | `completeLogin` | `maskedPii` | — |
| `normalizeSecuritySettings` | src/lib/auth/security-settings.js | Cleans the Super Admin's security settings and keeps each within its allowed range. | raw values | Settings | Loading settings | — | Session timeout limited to 5–480 minutes. |
| `loadSecuritySettings` | src/lib/auth/security-settings.js | Reads the security settings (session timeout, maximum login attempts, minimum password length, password expiry), remembered for 1 minute. | database client (optional) | Settings | Sign-in, every request renewal | `system_config` table | — |
| `invalidateSecuritySettings` | src/lib/auth/security-settings.js | Forgets the remembered settings after the Super Admin saves new ones. | none | none | Saving settings | — | — |
| `isPasswordExpired` | src/lib/auth/security-settings.js | Checks whether the password is older than the expiry days. | user, days | true/false | Sign-in | — | With a 90-day expiry, a 100-day-old password must be changed. |
| `applyTrustedProfile` | src/lib/auth/users-cache.js | Replaces editable account fields with the trusted database values (role, branch, archived, salary, RFID card). | user, profile row | User | Account listing | — | — |
| `getTrustedUserById` | src/lib/auth/users-cache.js | Reads one account with its trusted values. | client, ID | User | Single-account decisions | `profiles` table | — |
| `withTrustedProfiles` | src/lib/auth/users-cache.js | Applies trusted values to a whole list of accounts. | client, users | Users | Internal | `fetchAllRows`, `profiles` | — |
| `invalidateUsersCache` | src/lib/auth/users-cache.js | Forgets the remembered account list after any change. | none | none | Account created, edited or deleted | — | — |
| `listAllAuthUsers` | src/lib/auth/users-cache.js | Reads every account page by page (1,000 per page). | client | All users | Internal | Supabase Auth `listUsers` | — |
| `listUsersCached` | src/lib/auth/users-cache.js | Returns all accounts, remembered for 10 seconds, so a burst of requests causes only one lookup. | client | `{users}` | Many routes | `listAllAuthUsers`, `withTrustedProfiles` | — |

### 1.6 Session cookie, permission guard and request gatekeeper

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `sessionTimes` | src/lib/rbac/session.js | Works out when a session ends: idle timeout from now, but never more than 8 hours after sign-in. | claims | now, sign-in time, idle, expiry | Making a session | — | — |
| `signingKey` | src/lib/rbac/session.js | Gets the secret key used to sign cookies. | environment | Key | Internal | — | — |
| `base64UrlEncode` / `base64UrlDecode` | src/lib/rbac/session.js | Encode and decode cookie contents. | text | Text | Internal | — | — |
| `sign` | src/lib/rbac/session.js | Creates a tamper-proof signature (HMAC-SHA256). | text | Signature | All signed cookies, OTP fingerprints | `signingKey` | — |
| `safeEqual` | src/lib/rbac/session.js | Compares two secrets safely (timing-safe). | a, b | true/false | Checking a signature | — | — |
| `createSessionToken` | src/lib/rbac/session.js | Builds the signed session token (user, role, branch, name, session ID, must-change flag, times). | claims | Token | Sign-in | `sessionTimes`, `sign` | — |
| `verifySessionToken` | src/lib/rbac/session.js | Checks the session token's signature and expiry. | token | Claims, or nothing | Every request | `sign`, `safeEqual` | — |
| `sessionCookieOptions` | src/lib/rbac/session.js | Cookie security settings (HttpOnly, SameSite). | lifetime | Options | Internal | — | — |
| `attachSession` | src/lib/rbac/session.js | Puts the session cookie on a reply. | response, claims | Response | Sign-in | `createSessionToken` | — |
| `reissueSession` | src/lib/rbac/session.js | Renews the cookie with some details changed, without a new sign-in. | response, session, changes | Response | Password changed, activity renewal | `attachSession` | After changing the default password, the user stays signed in. |
| `clearSession` | src/lib/rbac/session.js | Deletes the session cookie. | response | Response | Sign-out, ended session | — | — |
| `readSession` | src/lib/rbac/session.js | Reads and checks the session cookie from a request. | request | Session, or nothing | Every protected request | `verifySessionToken` | — |
| `deny` | src/lib/rbac/guard.js | Builds a refusal reply. | message, status | JSON | Internal | — | — |
| `requirePermission` | src/lib/rbac/guard.js | The main security check in every API route. Is the user signed in, is the role allowed to do this action on this module, and which branch is the user limited to? | request, module, action | Guard result (role, user, branch, scope) or a refusal | Start of every API route | `readSession`, `readKioskSession`, `can`, `resolveCurrentBranchId`, `scopeFor` | An Employee who calls the payroll-processing address is refused with "You do not have permission". |
| `denyForeignBranch` | src/lib/rbac/guard.js | Refuses access to a record from another branch. | guard, record's branch | Refusal, or nothing | Routes reading or editing one record | — | An Antipolo Admin cannot edit a Marikina employee. |
| `denyRoleEscalation` | src/lib/rbac/guard.js | Refuses managing an account of an equal or higher role. | guard, target role | Refusal, or nothing | Account management | `canManageRole` | An Admin cannot edit a Super Admin account. |
| `denySelfScopeList` | src/lib/rbac/guard.js | Stops "own records only" users from listing other people's records. | guard | Refusal, or nothing | Listing routes | — | — |
| `scopeListToBranch` | src/lib/rbac/guard.js | Filters a list down to the user's branch. | rows, guard | Rows | Listing routes | — | — |
| `resolveTargetEmail` / `resolveTargetUserId` | src/lib/rbac/guard.js | Decides whose records to act on. "Own records only" users always get their own. | guard, requested email/ID | Email / ID | Self-service routes | — | An employee can only download their own payslips. |
| `proxy` | src/proxy.js | Runs first on every page and API request. Applies the security rules and adds "do not cache" headers. | request | Response | Every request | `route`, `withNoStore` | Pressing Back after sign-out cannot show cached payroll data. |
| `route` | src/proxy.js | The gatekeeper rules. It blocks cross-site calls, lets public addresses through, and redirects signed-in users away from `/login`. It also guards the RFID terminal and portals by role, checks the active session, forces the default-password change, and checks module permission. | request | Continue, redirect or refusal | Every request | `readSession`, `sessionRejection`, `can`, `readKioskSession`, `kioskRefusal`, `moduleForPath`, `actionForRequest` | An HR user who types `/accountant` is sent back to `/hr`. |
| `moduleForPath` | src/proxy.js | Finds which permission module an API address belongs to (longest match wins). | path | Module | Internal | `API_MODULES` | `/api/accountant/payroll` maps to "process_payroll". |
| `actionForRequest` | src/proxy.js | Maps the request type (GET, POST and so on) to read, create, update or delete. | path, method | Action | Internal | — | — |
| `isBranchLabelRead` | src/proxy.js | Lets any signed-in user read the branch list (names only). | path, method | true/false | Internal | — | — |
| `sessionRejection` | src/proxy.js | Says whether a session must be ended: expired, replaced, revoked or archived. | session | Rejection, or nothing | Internal | `checkActiveSession` | — |
| `isActivity` | src/proxy.js | Separates real user actions from background checks, so background checks don't keep an idle session alive. | request, path | true/false | Internal | — | — |
| `withRenewedSession` | src/proxy.js | Extends the idle timeout when the user is active (at most once a minute, never past 8 hours). | request, response, session, path | Response | Internal | `loadSecuritySettings`, `reissueSession` | — |
| `isCrossSiteApiRequest` | src/proxy.js | Spots API calls coming from other websites. | request, path | true/false | Internal | — | — |
| `withNoStore` | src/proxy.js | Adds "do not cache" headers. | response, path | Response | Every reply | — | — |

### 1.7 Code emails

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `MailNotConfiguredError` | src/lib/mail/gmail.js | The error raised when the Gmail account settings are missing. | none | Error | Sending mail without settings | — | — |
| `credentials` | src/lib/mail/gmail.js | Reads the Gmail address and app password from settings. | environment | Credentials, or nothing | Internal | — | — |
| `isMailConfigured` | src/lib/mail/gmail.js | Says whether email can be sent. | none | true/false | Health checks | `credentials` | — |
| `transporter` | src/lib/mail/gmail.js | Creates (and remembers) the Gmail mail sender. | none | Mail sender | Internal | Nodemailer | — |
| `sendMail` | src/lib/mail/gmail.js | Sends one email through Gmail. | to, subject, HTML, text, attachments | Send result | Code emails, payslip emails | `transporter` | Delivers the 6-digit sign-in code. |
| `resetMailTransport` | src/lib/mail/gmail.js | Forgets the remembered mail sender (tests). | none | none | Tests | — | — |
| `escapeHtml` | src/lib/mail/otp-email.js | Makes text safe to put inside an email. | text | Safe text | Internal | — | — |
| `logoAttachment` | src/lib/mail/otp-email.js | Attaches the school seal image to the email. | none | Attachment, or nothing | Internal | `public/brand/logo-160.png` | — |
| `buildOtpEmail` | src/lib/mail/otp-email.js | Builds the green-and-gold code email (subject, HTML and plain text) for sign-in, reset or password change. | code, purpose, minutes, name, organization name | Subject, HTML, text, attachments | Sending a code | `escapeHtml`, `logoAttachment`, `systemName` | "Your SACS Payroll sign-in code" with the code in large digits. |
## 2. RFID Terminal (Time In / Time Out kiosk)

**Web address:** `/rfid-terminal`
**Who uses it:** HR, a branch Admin or the Super Admin opens it on a computer at the school entrance. Employees then tap their RFID cards on it.
**What the page does:** A full-screen kiosk. An authorized staff member unlocks it with their password (there is no terminal to choose since October 27, 2026: a branch Admin's kiosk takes only its own branch's cards; HR's and the Super Admin's take every branch's). After that, every card tap records the employee's attendance. The first tap of the day is Time In, and the latest tap is Time Out. The kiosk shows green (accepted), red (refused) or amber (already recorded, or saved while offline). If the internet drops, taps are saved on the screen and sent automatically later. Leaving the kiosk also needs the password.

This section also covers the server code that processes a tap, the attendance rules engine, and RFID card registration.

### 2.1 Kiosk screen (browser)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `RfidTerminalLayout` | src/app/rfid-terminal/layout.js | Frame for the kiosk page. | `children` | Layout | Opening `/rfid-terminal` | `PortalLayout` | — |
| `RfidTerminalPage` | src/app/rfid-terminal/page.js | Shows the kiosk. | none | `RfidTerminal` | Opening `/rfid-terminal` | `RfidTerminal` | HR opens the RFID Terminal from the HR portal. |
| `RfidTerminal` | src/app/rfid-terminal/rfid-terminal.jsx | The whole kiosk: lock screen, clock, tap circle, offline queue and exit dialog. | none | Kiosk screen | Page load | All functions below | The screen at the main gate that teachers tap each morning. |
| `readPending` | src/app/rfid-terminal/rfid-terminal.jsx | Reads the taps saved on this computer while offline. | none | List of saved taps | Offline queue checks | browser `localStorage` | — |
| `writePending` | src/app/rfid-terminal/rfid-terminal.jsx | Saves the offline tap list (keeps the last 500). | list | none | A tap saved or sent | `localStorage` | — |
| `manilaClock` / `manilaDate` | src/app/rfid-terminal/rfid-terminal.jsx | The current Philippine time and date for the kiosk header. | none | "07:52:10 AM" / "Monday, October 19, 2026" | Every second | — | The big clock on the kiosk. |
| `Brand` | src/app/rfid-terminal/rfid-terminal.jsx | School seal and "RFID Attendance Terminal" title. | `inverse` | Header block | Screen display | — | — |
| `initials` | src/app/rfid-terminal/rfid-terminal.jsx | Makes initials from a name for the round badge. | name | "MS" | Accepted tap | — | Maria Santos shows "MS". |
| `manilaTime` | src/app/rfid-terminal/rfid-terminal.jsx | Formats a tap time in Philippine time. | ISO time | "7:52 AM" | Accepted tap | — | — |
| (start-up effect) | src/app/rfid-terminal/rfid-terminal.jsx | Checks that the signed-in person may run a kiosk (HR, Admin, Super Admin) and shows whose password unlocks it. | none | Lock screen ready | Page load | `GET /api/rbac/me`, `hardNavigate` | An Employee who opens the address is sent to sign-in. |
| (clock effect) | src/app/rfid-terminal/rfid-terminal.jsx | Updates the clock every second and counts the saved taps. | none | Clock | Page load | `manilaClock`, `refreshPending` | — |
| `refreshPending` | src/app/rfid-terminal/rfid-terminal.jsx | Updates the "N taps waiting to send" count. | none | Count | After saving or sending | `readPending` | — |
| `focusScan` | src/app/rfid-terminal/rfid-terminal.jsx | Keeps the cursor in the hidden card-number box, so the card reader's typing always lands there. | none | none | Every 1.5 seconds, clicks, after each tap | — | Even if someone clicks elsewhere, the next card tap still registers. |
| `showLight` | src/app/rfid-terminal/rfid-terminal.jsx | Shows the coloured result (green, red or amber), with the name, time and "Time In"/"Time Out", then goes back to idle. | state, text, duration, person | Screen change | After each tap | — | "Maria Santos · Time In · 7:52 AM" in green. |
| `lockAgain` | src/app/rfid-terminal/rfid-terminal.jsx | Locks the kiosk when the server says its session ended (the account that unlocked it was archived or its role changed). | message | Lock screen | Server reply 401 | — | The Admin who unlocked it is archived, and the gate screen locks within seconds. |
| `sendTap` | src/app/rfid-terminal/rfid-terminal.jsx | Sends one card number to the server (gives up after 10 seconds), with the original tap time if it was saved offline. | card code, offline time | Server response | A tap or a queued resend | `POST /api/admin/attendance` (kiosk header) | — |
| `keepForLater` | src/app/rfid-terminal/rfid-terminal.jsx | Saves a tap that couldn't be sent. | code, tap time | none | Network or server error | `writePending` | The internet is down at 7:30 AM, so taps are kept on the computer. |
| `flushPending` | src/app/rfid-terminal/rfid-terminal.jsx | Sends saved offline taps one by one, oldest first, until the list is empty or the network fails again. | none | none | Every 20 seconds, when the internet returns, after each tap, on unlock | `sendTap`, `readPending`, `writePending` | At 7:45 the internet returns and the 12 saved taps are recorded with their real times. |
| `submitScan` | src/app/rfid-terminal/rfid-terminal.jsx | Processes one tap. It queues taps that arrive while one is in progress, sends it, and shows accepted, already recorded, refused (with the reason: unknown card, inactive card, wrong branch, on leave, too early) or saved offline. | card code, tap time | Coloured result | Card tapped (reader types the number) | `sendTap`, `showLight`, `keepForLater`, `flushPending`, `lockAgain` | A teacher taps their card at 7:52 AM and sees "Time In". |
| (unlocked-mode effect) | src/app/rfid-terminal/rfid-terminal.jsx | While unlocked: refocuses the scan box, keeps the session alive every 4 minutes, retries saved taps every 20 seconds, and watches the internet going on or off. | none | Timers and listeners | Kiosk unlocked | `focusScan`, `flushPending`, `GET /api/legacy-auth/session` | — |
| `verifyPassword` | src/app/rfid-terminal/rfid-terminal.jsx | Checks the staff member's password to unlock or to exit. | password, purpose ("unlock"/"exit") | true/false | "Unlock terminal" / "Exit" | `POST /api/admin/attendance/verify-password` | — |
| `unlock` | src/app/rfid-terminal/rfid-terminal.jsx | Unlock form: needs the password, then opens the tap screen. | form event | Kiosk unlocked | "Unlock terminal" button (form submit) | `verifyPassword`, `flushPending` | At 6:00 AM HR unlocks the main-gate kiosk. |
| `exit` | src/app/rfid-terminal/rfid-terminal.jsx | Exit form: checks the password, then returns to the staff member's portal. | form event | Back to the portal | "Exit" in the exit dialog | `verifyPassword`, `hardNavigate` | At 6:00 PM the Admin closes the kiosk. |
| `onScanChange` | src/app/rfid-terminal/rfid-terminal.jsx | Keeps only digits from the reader. When 6 or more digits arrive and typing stops for 0.4 seconds, it submits the tap. | input change | Calls `submitScan` | Card reader typing | `submitScan` | A reader that sends no Enter key still records the tap. |
| `onScanKeyDown` | src/app/rfid-terminal/rfid-terminal.jsx | Submits the card number when the reader sends Enter. | key event | Calls `submitScan` | Card reader "Enter" | `submitScan` | — |
| (exit button / dialog close handlers) | src/app/rfid-terminal/rfid-terminal.jsx | Open the exit dialog with empty fields; after closing it, put the cursor back in the scan box. | click | Dialog open/close | "Exit terminal" button | `focusScan` | — |

### 2.2 Tap processing on the server (attendance API)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `checkLockout` | src/app/api/admin/attendance/verify-password/route.js | Blocks password checks for 5 minutes after 5 wrong tries. | user ID | locked?, wait | Kiosk unlock or exit | — | — |
| `recordFailure` / `recordSuccess` | src/app/api/admin/attendance/verify-password/route.js | Count a wrong kiosk password / clear the count. | user ID | none | Password check | — | — |
| `POST` (verify-password) | src/app/api/admin/attendance/verify-password/route.js | Checks the staff member's own password. On "unlock" it issues a kiosk-only cookie tied to the Admin's own branch (HR and Super Admin: every branch). On "exit" it removes that cookie. | `password`, `purpose` | `{valid, kiosk}` | Kiosk unlock or exit | Supabase `signInWithPassword`; `branches` table; `attachKioskSession`, `clearKioskSession` | An Admin's Marikina kiosk refuses an Antipolo employee's card. |
| `getDateLabel` | src/app/api/admin/attendance/route.js | Today's date in words (Manila). | date | "October 19, 2026" | Monitoring view | — | — |
| `buildEmployeeId` | src/app/api/admin/attendance/route.js | Builds a fallback ID such as SACS-001 when an account has none. | count | ID | Listing employees | — | — |
| `parseEmployeeIdNumber` | src/app/api/admin/attendance/route.js | Reads the number in "SACS-014" for sorting. | ID | 14 | Sorting | — | — |
| `toIso` | src/app/api/admin/attendance/route.js | Converts a date to standard text form. | value | ISO text | Internal | — | — |
| `calculateHours` | src/app/api/admin/attendance/route.js | Hours between Time In and Time Out, rounded to 2 decimals. | time in, time out | Hours | Shaping rows | — | 7:30 AM to 4:45 PM = 9.25 hours. |
| `normalizeAttendanceStatus` (local) | src/app/api/admin/attendance/route.js | Cleans a status word to an official status. | value | Status | Internal | `normalizeEngineStatus` | — |
| `shapeEmployee` | src/app/api/admin/attendance/route.js | Builds the employee details a tap needs (name, card, branch, status). | user, profile | Employee | Listing employees | — | — |
| `fetchEmployees` | src/app/api/admin/attendance/route.js | Lists all active Employees and Accountants with their RFID card numbers, sorted by ID. | database client | Employees | Every tap and monitoring view | `listUsersCached`, `profiles` table | — |
| `mapAttendanceRow` | src/app/api/admin/attendance/route.js | Shapes one attendance record for the screen. | database row | Record | Internal | `calculateHours` | — |
| `fetchAttendanceRows` | src/app/api/admin/attendance/route.js | Today's records, one per employee, with "Absent" (or "Holiday") rows added for those who haven't tapped. | client, employees, date | Rows | Monitoring view | `attendance_logs` table, `collapseDailyTaps`, `readHolidayMap`, `isDayOff` | — |
| `buildAttendancePayload` | src/app/api/admin/attendance/route.js | Counts Present, Late, Absent, Incomplete and On Leave for today's summary cards. | rows, date | Summary and list | Monitoring view | `attendanceBucket` | "Present 42 · Late 3 · Absent 5" |
| `getAttendancePanels` | src/app/api/admin/attendance/route.js | Today's summary counts only (used by dashboards). | client, employees | Panel counts | Dashboard load | `fetchAttendanceRows`, `buildAttendancePayload` | — |
| `resolveEmployeeByRfid` | src/app/api/admin/attendance/route.js | Finds whose card was tapped. Manual entry may also use the Employee ID. | code, employees | Employee, or nothing | Each tap | — | Card 0012345678 belongs to Maria Santos. |
| `isLateInManila` | src/app/api/admin/attendance/route.js | Decides whether a Time In is late under the employee's schedule (default 8:00 AM). | time, schedule | true/false | First tap of the day | `isLateForPolicy` | — |
| `isDuplicateKeyError` | src/app/api/admin/attendance/route.js | Spots a "record already exists" database error so it can retry. | error | true/false | Internal | — | — |
| `changeAnnotation` | src/app/api/admin/attendance/route.js | Stamps who changed a record and how, for the attendance history. | actor, source | Fields | Every attendance write | `attendance_logs_history` (via a database trigger) | — |
| `readDayTaps` | src/app/api/admin/attendance/route.js | Reads an employee's raw taps for a day. | client, employee, date | Tap times | Each tap | `attendance_taps` table | — |
| `tooEarlyTimeIn` | src/app/api/admin/attendance/route.js | Refuses a Time In more than 3 hours before the employee's shift starts. | client, employee, date, time, schedule | Times, or nothing | First tap of the day | `attendance_logs` table | A 7:00 AM-shift teacher tapping at 3:30 AM is refused with "Too early to time in". |
| `persistScanToTable` | src/app/api/admin/attendance/route.js | Applies the tap to the employee's day. The first tap creates the record (Time In, Late or On Time). Later taps move the Time Out to the latest tap. On a day HR already corrected, the tap is only flagged for review. | client, employee, date, time, card, schedule, actor | Saved record and tap type | Each accepted tap | `attendance_logs`, `planTap`, `hoursBetween`, `isLateInManila`, `changeAnnotation` | Morning tap = Time In 7:52; afternoon tap at 5:05 = Time Out. |
| `offlineTapTime` | src/app/api/admin/attendance/route.js | Checks a saved-offline tap's time: no more than 1 day old and not in the future. | time | Usable time, or an error | Offline taps resent | — | A tap saved 2 days ago is refused: "Ask HR to correct the day." |
| `manilaDateTime` | src/app/api/admin/attendance/route.js | Formats a date and time in Manila time for messages. | date | "Oct 3, 2026, 7:52 AM" | Refused offline tap | — | — |
| `findRepeat` | src/app/api/admin/attendance/route.js | Spots a tap within 5 minutes of one already recorded (card held too long, or tapped twice). | client, employee, date, time | Earlier tap, or nothing | Each tap | `attendance_logs`, `readDayTaps`, `findRepeatedTap` | Tapping twice in 10 seconds shows "Already recorded". |
| `unmatchedCardReason` | src/app/api/admin/attendance/route.js | Explains why a card didn't match: inactive employee, deactivated or lost card, or an unregistered card. | client, code | Reason and code | Unknown card | `profiles`, `rfid_cards` tables | "Card not recognized." |
| `GET` (attendance) | src/app/api/admin/attendance/route.js | Today's live attendance for the caller's branch (all branches for HR and Super Admin), with summary counts. Records an audit entry. | session | Summary and records | Attendance monitoring page load | `fetchEmployees`, `fetchAttendanceRows`, `buildAttendancePayload`, `annotateAttendanceRows`, `appendAuditLog` | The Admin dashboard shows who has tapped today. |
| `POST` (attendance tap) | src/app/api/admin/attendance/route.js | Records one RFID tap (or a manual entry from the portal). Refuses offline taps that are too old, unknown or inactive cards, inactive or separated employees, wrong-branch cards, employees on approved leave and too-early taps. Ignores repeats. Stores the raw tap, updates the day and logs everything. | `rfid_code`, `device`, `offline_tapped_at`, `manual_entry` | Result: time_in, time_out, duplicate, or a refusal with a reason | Card tap at the kiosk | `resolveEmployeeByRfid`, `isEmployeeOnLeave`, `getEmployeeAttendancePolicy`, `findRepeat`, `tooEarlyTimeIn`, `recordRawTap`, `persistScanToTable`, `recordRefusedTap`, `recordBlockedTap`, `appendAuditLog`; database function `rfid_terminal_touch` | A teacher on approved sick leave taps in and the kiosk says "You are on leave today." |
| `refuse` (inside `POST`) | src/app/api/admin/attendance/route.js | Stores a refused tap with its reason and writes an audit entry. | employee, reason, status, message | Error reply | Any refused tap | `recordRefusedTap`, `appendAuditLog` | — |

### 2.3 Attendance rules engine (shared library)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `toTime` | src/lib/attendance/taps.js | Turns a date into a number for comparing. | value | Milliseconds | Internal | — | — |
| `hoursBetween` | src/lib/attendance/taps.js | Hours worked between two times, rounded to 2 decimals. | start, end | Hours | Time Out recorded | `toTime` | 8:00 to 17:00 = 9.00. |
| `tapTimes` | src/lib/attendance/taps.js | The tap times stored in one record. | row | Times | Internal | — | — |
| `collapseGroup` | src/lib/attendance/taps.js | Combines several records for one person and day into one (earliest = Time In, latest = Time Out). | rows | One record | Internal | `tapTimes`, `hoursBetween` | — |
| `collapseDailyTaps` | src/lib/attendance/taps.js | Makes sure each employee shows only one record per day. | rows, key functions | Rows | Attendance lists, payroll | `collapseGroup` | — |
| `firstAndLastTap` | src/lib/attendance/taps.js | From a list of taps, finds the first (Time In) and the last (Time Out). | times | Time in, time out, count | Tap processing, raw-tap rebuild | — | — |
| `findRepeatedTap` | src/lib/attendance/taps.js | Finds an earlier tap within 5 minutes of this one. | day rows, raw taps, time | Earlier tap time, or nothing | Each tap | — | — |
| `planTap` | src/lib/attendance/taps.js | Decides what a new tap does: Time In, move the Time Out, or (on an HR-corrected day) flag for review only. | day rows, time, raw taps | Action | Each tap | `firstAndLastTap` | — |
| `maskCardCode` | src/lib/attendance/raw-taps.js | Hides most of a card number ("••••5678"). | code | Masked text | Logs and messages | — | — |
| `tapDevice` | src/lib/attendance/raw-taps.js | Records which device a tap came from (the kiosk's name, or "Manual entry (portal)"). | body, manual flag | Label | Each tap | — | — |
| `recordRawTap` | src/lib/attendance/raw-taps.js | Permanently stores every accepted tap (never edited). | client, tap details | true/false | Each accepted tap | `attendance_taps` table | — |
| `readRawTaps` | src/lib/attendance/raw-taps.js | Reads one employee's raw taps for a date range. | client, employee, from, to | Taps | Employee attendance record view | `attendance_taps` table | HR checks every tap Maria made on October 3. |
| `recordRefusedTap` | src/lib/attendance/raw-taps.js | Stores a refused tap and its reason for HR to review. | client, details | none | Refused tap | `attendance_blocked_taps` table | — |
| `shapeLeave` | src/lib/attendance/leave.js | Cleans a leave record (type, paid or unpaid, dates, approver). | row | Leave | Internal | — | — |
| `isEmployeeOnLeave` | src/lib/attendance/leave.js | Checks whether an employee has approved leave on a date. | client, employee, date | Leave, or nothing | Each tap | database function `attendance_approved_leave`; `leave_requests` table | — |
| `readApprovedLeave` | src/lib/attendance/leave.js | Loads approved leave for a range and returns a quick "is this person on leave this day?" lookup. | client, employees, from, to | Lookup function | Attendance calendars and tables | `leave_requests`, `fetchAllIn` | — |
| `readBlockedTaps` | src/lib/attendance/leave.js | Lists refused taps for a date range (by employees and/or branch). | client, filters | Refused taps | Attendance review pages | `attendance_blocked_taps` | HR sees "Unregistered RFID card ••••5678" at the Main Gate. |
| `recordBlockedTap` | src/lib/attendance/leave.js | Stores a tap refused because the employee is on leave. | client, details | none | Tap during leave | `attendance_blocked_taps` | — |
| `attendanceSectionForBranch` | src/lib/attendance/policy.js | Name of the settings section that holds a branch's schedule. | branch ID | "attendance:<id>" | Internal | — | — |
| `timeToMinutes` | src/lib/attendance/policy.js | "08:30" becomes 510 minutes after midnight. | text | Minutes | Internal | — | — |
| `cleanValue` | src/lib/attendance/policy.js | Validates one schedule setting. | key, value | Clean value | Internal | `timeToMinutes` | — |
| `resolveAttendancePolicy` | src/lib/attendance/policy.js | Works out a branch's schedule: work start and end, grace minutes and required hours (the branch's own settings override the default). | config, branch | Schedule | Loading a schedule | `cleanValue` | — |
| `loadAttendanceConfig` | src/lib/attendance/policy.js | Reads the default and branch schedule settings. | client, branch IDs | Settings | Loading a schedule | `system_config` table | — |
| `getBranchAttendancePolicy` | src/lib/attendance/policy.js | Reads one branch's schedule. | client, branch | Schedule | Fallback schedule | `loadAttendanceConfig`, `resolveAttendancePolicy` | — |
| `formatPolicyTime12` | src/lib/attendance/policy.js | "16:30" becomes "04:30 PM". | time | Text | Timesheet display | `timeToMinutes` | — |
| `manilaMinutesOfDay` | src/lib/attendance/policy.js | The time of day in Manila, as minutes. | date | Minutes | Internal | — | — |
| `tardinessMinutes` | src/lib/attendance/policy.js | How many minutes after the start time someone timed in. | time in, schedule | Minutes | Late computation | `manilaMinutesOfDay` | Time In 8:20 with an 8:00 start = 20 minutes late. |
| `undertimeMinutes` | src/lib/attendance/policy.js | How many minutes before the end time someone left. | time out, schedule | Minutes | Undertime computation | `manilaMinutesOfDay` | Left 4:30 with a 5:00 end = 30 minutes undertime. |
| `isLateForPolicy` | src/lib/attendance/policy.js | Late only when past the grace period. | time in, schedule | true/false | First tap | `tardinessMinutes` | With 15 minutes' grace, 8:10 is On Time and 8:16 is Late. |
| `normalizeAttendanceStatus` | src/lib/attendance/status.js | Returns the official spelling of a status ("Present" is read as "On Time"). | value, fallback | Status | Everywhere statuses are shown | — | — |
| `isAttendedStatus` | src/lib/attendance/status.js | Whether a status counts as a day worked. | status | true/false | Present-day totals | — | — |
| `isUnresolvedStatus` | src/lib/attendance/status.js | Whether the record is Incomplete or Pending Correction (kept out of payroll until resolved). | status | true/false | Payroll checks | — | — |
| `isCorrectableStatus` | src/lib/attendance/status.js | Whether an employee may ask to correct this record (Incomplete, Undertime, Half Day). | status | true/false | "Request correction" button | — | — |
| `attendanceBucket` | src/lib/attendance/status.js | Groups a status into present, late, absent, leave, holiday or unresolved for the counts. | status | Bucket | Dashboards and reports | — | — |
| `annotateAttendanceRows` | src/lib/attendance/annotate.js | Adds extra labels to attendance rows: Employee ID, branch name, the last approved correction and "tapped after correction" flags. | client, rows | Labelled rows | Attendance lists | `profiles`, `branches`, `attendance_corrections`, `attendance_logs` | — |
| `isValidDateKey` | src/lib/attendance/holidays.js | Checks for a real calendar date. | text | true/false | Holiday form | — | — |
| `cutoffMinutes` | src/lib/attendance/holidays.js | "13:00" becomes minutes. | text | Minutes | Half-day suspension | — | — |
| `validateHolidayInput` | src/lib/attendance/holidays.js | Checks a new holiday: a date, a name (up to 100 characters), a type (Regular, Special or Suspension) and the day part. Only a suspension may be half a day, with a cut-off time. | holiday fields | Error, or nothing | Saving a holiday | `isValidDateKey`, `cutoffMinutes` | — |
| `describeDayPart` | src/lib/attendance/holidays.js | Describes a half-day suspension. | holiday | "Work suspended from 1:00 PM" | Holiday lists | `cutoffMinutes` | — |
| `readHolidayMap` | src/lib/attendance/holidays.js | Loads the holidays between two dates. | client, start, end | Date-to-holiday lookup | Attendance and payroll | `attendance_holidays` table | — |
| `isDayOff` | src/lib/attendance/holidays.js | Whether a holiday covers the whole day. | holiday | true/false | Marking Absent vs Holiday | — | On Rizal Day nobody is marked Absent. |
| `isWeekend` | src/lib/attendance/not-tapped.js | Saturday or Sunday check. | date | true/false | Internal | — | — |
| `isHoliday` | src/lib/attendance/not-tapped.js | Whether a date is a whole-day holiday. | client, date | true/false | Internal | `attendance_holidays` | — |
| `listNotTapped` | src/lib/attendance/not-tapped.js | Lists active employees who haven't tapped on a working day (excluding people on leave and those not yet hired) as "Absent" rows to display. | client, date, already-logged IDs | Absent rows | Attendance lists | `profiles`, `leave_requests` | At 10 AM the Admin sees which teachers haven't arrived. |
| `levelLabel` | src/lib/attendance/work-schedules.js | Turns a level code into words (for example "grade_school" becomes "Grade School"). | value | Label | Schedule screens | — | — |
| `minutesToHHMM` | src/lib/attendance/work-schedules.js | 480 becomes "08:00". | minutes | Text | Internal | — | — |
| `describeWorkingDays` | src/lib/attendance/work-schedules.js | Describes the working days ("Mon–Fri", "Mon, Wed, Fri"). | day numbers | Text | Schedule lists | — | — |
| `isOffDay` | src/lib/attendance/work-schedules.js | Whether a date is not a working day for a schedule (default Mon–Fri). | date, working days | true/false | Absences, payroll | — | — |
| `validateScheduleInput` | src/lib/attendance/work-schedules.js | Checks a work schedule: a name, a start before the end, 0–120 minutes of grace, hours that fit the shift, and at least one working day. | form data | Clean schedule, or an error | Saving a schedule | `timeToMinutes`, `minutesToHHMM` | Refuses an 8-hour requirement on a 7:00–12:00 shift. |
| `scheduleRowToPolicy` | src/lib/attendance/work-schedules.js | Converts a database schedule row into the schedule format the app uses. | row, branch | Schedule | Internal | `minutesToHHMM` | — |
| `getEmployeeAttendancePolicy` | src/lib/attendance/work-schedules.js | The schedule one employee works on one day (own schedule, then level, then branch, then default). | client, employee, branch, date | Schedule | Each tap | database function `attendance_schedule_for`; `getBranchAttendancePolicy` | A preschool teacher's 7:30–12:00 shift is used to judge lateness. |
| `loadEmployeeScheduleDays` | src/lib/attendance/work-schedules.js | One employee's schedule for every day of a range (in 62-day chunks), with branch fallbacks. | client, employee, branch, from, to | Date-to-schedule lookup | Payroll and timesheets | database function `attendance_schedules_between`; `loadAttendanceConfig`, `resolveAttendancePolicy` | — |

### 2.4 RFID kiosk session (server library)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `createKioskToken` | src/lib/auth/kiosk-session.js | Builds the signed kiosk token (who unlocked it and the kiosk's branch; its terminal fields stay empty since October 27, 2026), valid for 16 hours. | user, role, branch, terminal | Token | Kiosk unlocked | `sign`, `base64UrlEncode` | — |
| `verifyKioskToken` | src/lib/auth/kiosk-session.js | Checks the kiosk token (signature, role, expiry). | token | Claims, or nothing | Each tap | `sign`, `safeEqual` | — |
| `kioskCookieOptions` | src/lib/auth/kiosk-session.js | Cookie settings. The cookie is only sent to the attendance tap address. | lifetime | Options | Internal | — | — |
| `attachKioskSession` / `clearKioskSession` | src/lib/auth/kiosk-session.js | Set or remove the kiosk cookie. | response, session, terminal | Response | Unlock / exit | `createKioskToken` | — |
| `isKioskTapRequest` | src/lib/auth/kiosk-session.js | Whether a request is a kiosk tap (the only thing a kiosk may do). | request | true/false | Each request | — | — |
| `readKioskSession` | src/lib/auth/kiosk-session.js | Reads the kiosk cookie from a tap request. | request | Claims, or nothing | Each tap | `verifyKioskToken` | — |
| `kioskRefusal` | src/lib/auth/kiosk-session.js | Checks live (every 5 seconds) whether the person who unlocked the kiosk is still active with the same role. | kiosk claims | Reason, or nothing | Each tap (proxy) | `profiles` table | If the Admin who unlocked it is archived, the kiosk locks. |

### 2.5 RFID cards management (panel shown in the HR, Admin and Super Admin portals)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `maskUid` | src/lib/rfid/cards.js | Shows only a card's last 4 digits ("••••••5678"). | number | Masked text | Card lists | — | — |
| `isCardUid` | src/lib/rfid/cards.js | Checks a card number: 1 to 16 digits. | value | true/false | Register or replace | — | — |
| `describeRfidError` | src/lib/rfid/cards.js | Turns database refusals into plain messages and status codes. | error | Status, message, code | A failed card action | — | "That card is already registered to another employee." |
| `refused` (cards route) | src/app/api/rfid/cards/route.js | Sends back a database refusal as a plain error. | error | JSON | Failed action | `describeRfidError` | — |
| `peopleInReach` | src/app/api/rfid/cards/route.js | Employees and Accountants the caller may give cards to (an Admin: own branch only). | client, guard | People | Card list | `profiles` table | — |
| `GET` (cards) | src/app/api/rfid/cards/route.js | Lists cards (masked), the card history, the employees (marked if they already have an active card) and the branches. | session | Cards, events, employees | RFID Cards panel load | `rfid_cards`, `rfid_card_events`, `branches`, `profiles` | — |
| `POST` (cards) | src/app/api/rfid/cards/route.js | Registers a new card to an employee. | `employee_id`, `uid`, `reason` | New card | "Register card" | database function `rfid_card_register`; `appendAuditLog`, `invalidateUsersCache` | HR gives a new teacher card 0012345678. |
| `PATCH` (cards) | src/app/api/rfid/cards/route.js | Replaces a card (optionally marking the old one lost), deactivates, marks lost or reactivates it, with a reason. | `action`, `card_id`, `new_uid`, `reason`, `lost` | Updated card | Replace / Deactivate / Lost / Reactivate buttons | database functions `rfid_card_replace`, `rfid_card_set_status`; `appendAuditLog` | A lost card is marked Lost so it can never record attendance again. |
| `RfidCardsPanel` | src/components/portal/rfid/rfid-cards-panel.jsx | The RFID Cards screen: status tabs, a branch filter, the card table, the history table, and the register, replace, status and history dialogs plus bulk entry. | `refreshKey` | Panel | Opening RFID Cards | `load`, `open`, `submit`, `BulkLinesDialog`, `DataTable` | — |
| `load` (cards panel) | src/components/portal/rfid/rfid-cards-panel.jsx | Loads the cards from the server. | none | Table data | Page load, "Refresh", after saving | `GET /api/rfid/cards` | — |
| `count` | src/components/portal/rfid/rfid-cards-panel.jsx | Counts cards with one status for the summary tiles. | status | Number | Display | — | "Active 120 · Lost 2" |
| `open` (cards panel) | src/components/portal/rfid/rfid-cards-panel.jsx | Opens a dialog (register, replace, deactivate, lost, reactivate or history) and puts the cursor in the card-number box. | kind, card | Dialog | Register card / Replace / Deactivate / Lost / Reactivate / History buttons | — | — |
| `submit` (cards panel) | src/components/portal/rfid/rfid-cards-panel.jsx | Checks the dialog (employee chosen, card number digits, reason of at least 5 characters) and saves it. | form event | Success message and reload | Dialog submit | `POST`/`PATCH /api/rfid/cards`, `notify` | HR taps the new card on a desk reader and it is registered. |
| (bulk `parseLine`, `run`, `onDone` handlers) | src/components/portal/rfid/rfid-cards-panel.jsx | Bulk register or replace. Each pasted line "SACS-0101, 1234567890" is checked (known employee, 1–16 digits, has or lacks an active card), then saved one by one, then the list reloads. | pasted lines | Per-line report | "Many cards" dialog | `BulkLinesDialog`, `/api/rfid/cards` | Registering 40 cards for new hires at once. |

### 2.6 Nightly attendance close (background job)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `manilaDateKey` | supabase/functions/attendance-nightly/index.ts | Today's date (YYYY-MM-DD) in Manila time. | date | Text | Internal | — | — |
| `isDateKey` | supabase/functions/attendance-nightly/index.ts | Checks the date format. | value | true/false | Internal | — | — |
| (Edge Function handler `Deno.serve`) | supabase/functions/attendance-nightly/index.ts | On-demand "close the days" job (the nightly run uses pg_cron directly). A Time In with no Time Out becomes Incomplete, and an active employee with no tap and no leave on a working day gets an Absent record. The default range is the last 7 days. Needs the service key. | optional `{from, to}` | Result | Manual call by a developer or admin | database function `attendance_close_days` | After a server outage, the admin re-closes October 1–7 so absences are recorded. |
## 3. Employee Portal (Dashboard, Attendance, Timesheet, Payslips, Leave, Profile)

**Web address:** `/employee`
**Who uses it:** Teachers and other staff with the Employee role. Accountants also have an employee record.
**What the pages do:**
- **Dashboard:** a greeting, this month's Present, Late, Absent and On Leave counts, basic salary, an attendance donut chart, a recent net-pay chart, branch announcements and quick links.
- **Attendance:** a colour-coded month calendar, today's Time In and Time Out, all records this month, and "This pay period" with a **Request correction** button.
- **Timesheet:** pick a date range to see shift times, taps, tardiness, undertime and leave, then copy or export it.
- **Payslips:** the latest payslip with a full earnings and deductions breakdown, older payslips, and the yearly BIR 2316 download.
- **Leave:** file a leave request (with a proof file), see the leave balance (15 paid days a year) and follow its approval.
- **Profile:** personal, employment, emergency-contact and masked government-ID details, with Edit Account.

### 3.1 Portal shell and data

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `EmployeeLayout` | src/app/employee/layout.js | Frame for the Employee portal. | `children` | Layout | Opening `/employee` | `PortalLayout` | — |
| `EmployeePage` | src/app/employee/page.js | Shows the Employee portal. | none | `EmployeePortal` | Opening `/employee` | `EmployeePortal` | A teacher signs in and lands here. |
| `EmployeePortal` | src/app/employee/employee-portal.jsx | Wraps the pages in the employee session (with the forced password screen). | none | Portal | Page load | `PortalSessionProvider`, `PasswordGate` | — |
| `EmployeeScreens` | src/app/employee/employee-portal.jsx | Builds the sidebar (Dashboard, Attendance, Timesheet, Payslips, Leave, Profile), loads the shared data and shows the chosen page. | none | Page | Page load, sidebar clicks | `usePersistedPage`, `useEmployeeStats`, `usePayslips`, `useLeaveRequests`, `AppShell` | — |
| `refresh` | src/app/employee/employee-portal.jsx | Reloads every section's data. | none | none | Refresh button in the top bar | — | — |
| (`summary` memo) | src/app/employee/employee-portal.jsx | Builds the bell summary: "This month: 18 present · 1 late · 0 absent" and the number of pending leave requests. | stats, leave | Summary lines | Data loads | `isPendingRequest` | — |
| `useEmployeeStats` | src/app/employee/use-employee-data.js | Loads this month's attendance counts, calendar records, today's log, upcoming leave and the next holiday. Reloads every 30 seconds while the tab is open. | email, `refreshKey` | data, loading, error, `reload` | Page load, every 30 seconds, Refresh | `GET /api/employee/stats` | After tapping in at the gate, the teacher's dashboard shows today's Time In within 30 seconds. |
| `usePayslips` | src/app/employee/use-employee-data.js | Loads the employee's released payslips, newest first. | email, `refreshKey` | List, `reload` | Page load, Refresh | `GET /api/employee/payslips` | — |
| `notifyLeaveDecisions` | src/app/employee/use-employee-data.js | Remembers each leave request's last status in the browser, and pops up "Your leave request was approved." (or "cancelled") the first time a change is seen within 7 days. | requests, details, `notify` | Pop-ups | After leave requests load | `localStorage` | A teacher signs in Monday and sees "Your leave request was approved." |
| `useLeaveRequests` | src/app/employee/use-employee-data.js | Loads the employee's leave requests and leave balance. | details, `notify`, `refreshKey` | Requests, balance, `reload` | Page load, Refresh, after filing | `GET /api/employee/leave-requests`, `notifyLeaveDecisions` | — |

### 3.2 Dashboard page

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `identityLine` | src/app/employee/dashboard-page.jsx | Builds "Employee · Teaching Staff · SACS-014" under the name. | details | Text | Dashboard display | — | — |
| `nextHolidayText` | src/app/employee/dashboard-page.jsx | "Bonifacio Day · Mon, Nov 30" (or "Today"). | holiday, today | Text | Dashboard display | — | — |
| `AttendanceDonut` | src/app/employee/dashboard-page.jsx | Donut chart of this month's days by status, with the total in the middle. | data, loading, error, `onRetry` | Chart | Dashboard load | recharts `PieChart` | 18 present, 1 late, 1 on leave = 20 days. |
| `NetPayChart` | src/app/employee/dashboard-page.jsx | Bar chart of the last 6 payslips' net pay. | payslips | Chart | Dashboard load | recharts `BarChart`, `formatPeso` | — |
| `DashboardPage` | src/app/employee/dashboard-page.jsx | The whole dashboard: green greeting card, upcoming leave and holiday, announcements, 5 summary tiles, 2 charts and 4 quick-access buttons. | stats, payslips, `onNavigate` | Page | Sidebar → Dashboard | `StatCard`, `BranchAnnouncementsCard`, `AttendanceDonut`, `NetPayChart` | — |
| (quick-access button `onClick`) | src/app/employee/dashboard-page.jsx | Opens Attendance, Timesheet, Payslips or Leave. | page ID | Page change | Clicking a quick-access card | `onNavigate` | — |

### 3.3 Attendance page

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `MonthCalendar` | src/app/employee/attendance-page.jsx | Month calendar coloured by status (green present, amber late, red absent, blue leave, gold holiday), with today ringed and a tooltip per day. | stats data | Calendar | Attendance page load | `attendanceBucket`, `leaveSummary` | October 12 shows red "Absent". |
| (leave day `onClick` / `onKeyDown`) | src/app/employee/attendance-page.jsx | Clicking a leave day shows a pop-up with the leave type, dates, pay and approver. | day | Pop-up | Click or Enter on a blue day | `toast.info`, `leaveSummary` | — |
| `TodayLog` | src/app/employee/attendance-page.jsx | Today's Time In, Time Out and status. | today's record | Panel | Page load | `formatPhTime`, `AttendanceBadge` | "Time in 07:52 AM · Time out — · On Time". |
| `CorrectionDialog` | src/app/employee/attendance-page.jsx | "Request correction" form: the corrected Time Out and a reason (at least 5 characters). | record, callbacks | Dialog | "Request correction" button | — | — |
| `submit` (correction) | src/app/employee/attendance-page.jsx | Checks the form, then sends the correction request for HR or Admin review. The day shows "Pending Correction". | time, reason | Pop-up "Correction Requested" | "Submit request" | `POST /api/attendance/corrections` | A teacher forgot to tap out at 5:00 PM and requests a 5:00 PM Time Out. |
| `PayPeriodCard` | src/app/employee/attendance-page.jsx | Lists this pay period's records. Incomplete, Undertime and Half Day rows get a "Request correction" button. | `refreshKey` | Card | Page load | `GET /api/attendance/logs`, `CorrectionDialog` | — |
| `load` (pay period) | src/app/employee/attendance-page.jsx | Loads this pay period's records. | none | Rows | Page load, after a request | `GET /api/attendance/logs` | — |
| `AttendancePage` | src/app/employee/attendance-page.jsx | Puts the calendar, today's log, the month's records and the pay-period card together. | stats, `refreshKey` | Page | Sidebar → Attendance | `MonthCalendar`, `TodayLog`, `DataTable`, `PayPeriodCard` | — |

### 3.4 Timesheet page

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `rowCells` | src/app/employee/timesheet-page.jsx | One timesheet row as a list of cells for copy and export. | row | Cell list | Copy or export | — | — |
| `TimesheetPage` | src/app/employee/timesheet-page.jsx | Date-range timesheet: start and end pickers, a Generate button, and a table with rest days, holidays and leave marked. | none | Page | Sidebar → Timesheet | `generate`, `copy`, `exportCsv`, `DataTable` | — |
| `generate` | src/app/employee/timesheet-page.jsx | Checks the dates (both required, end not before start), then loads the timesheet. | start, end | Table rows | "Generate" (form submit) | `GET /api/employee/timesheet` | A teacher checks October 1–15 before payday. |
| `copy` | src/app/employee/timesheet-page.jsx | Copies the visible rows (tab-separated) to the clipboard. | rows | Pop-up "Copied" | "Copy" button | clipboard | Pasting the timesheet into an email. |
| `exportCsv` | src/app/employee/timesheet-page.jsx | Downloads the visible rows as a formula-safe CSV that opens in Excel. | rows | File `timesheet_<name>_<start>_<end>.csv` | "Excel" button | browser download | — |

### 3.5 Payslips page

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `holidayRows` | src/app/employee/payslips-page.jsx | One indented line per holiday worked. | holiday lines | Rows | Building a payslip | `holidayLineLabel` | "Bonifacio Day, Nov 30 (8 h) + ₱ 550.00". |
| `semiMonthlyRows` | src/app/employee/payslips-page.jsx | Payslip lines for the semi-monthly format. The 1st half is half the monthly salary with no deductions. The 2nd half settles absences, leave, incentives, overtime, holiday pay, subsidy, SSS, PhilHealth, Pag-IBIG, tax and loans, minus what the 1st half paid. | monthly data, holiday lines | Rows | Payslip display | `formatPeso` | 2nd half: Monthly Net ₱ 24,500 − Paid in 1st half ₱ 12,500 = ₱ 12,000. |
| `cutoffRows` | src/app/employee/payslips-page.jsx | Payslip lines for the per-cutoff format: each earning and deduction on its own line, gross, total deductions, and a carry-over to next month. | cutoff data, holiday lines | Rows | Payslip display | `holidayRows` | — |
| `payslipRows` | src/app/employee/payslips-page.jsx | Picks the right format (cutoff, semi-monthly or the older detailed or simple one) and builds the lines. | payslip | Rows | Payslip display | `cutoffRows`, `semiMonthlyRows` | — |
| `PayslipCard` | src/app/employee/payslips-page.jsx | The payslip itself: school header, payslip number, Early Bird winner badge, the lines and the net pay. | payslip | Card | Payslips page, "View" | `payslipRows` | — |
| `PayslipsPage` | src/app/employee/payslips-page.jsx | Shows the selected payslip, the list of all payslips with "View" buttons, and the "My BIR 2316" card. | payslips | Page | Sidebar → Payslips | `PayslipCard`, `DataTable`, `MyBir2316Card` | — |
| (View button `onClick`) | src/app/employee/payslips-page.jsx | Shows an older payslip. | index | Selected payslip | "View" in the list | — | Viewing the September 16–30 payslip. |
| `download` | src/components/portal/bir-forms.jsx | Downloads a file from the server (keeping the server's file name). | URL, fallback name | File download | BIR download buttons | `apiFetch` | — |
| `useDownloader` | src/components/portal/bir-forms.jsx | Runs a download with a spinner and shows "Download Failed" on errors. | key, URL, name | Busy state | Download buttons | `download`, `notify` | — |
| `MyBir2316Card` | src/components/portal/bir-forms.jsx | Lists the finished years and downloads the employee's own BIR 2316 PDF for each. | none | Card | Payslips page | `GET /api/employee/bir-2316` | In January 2027 a teacher downloads their 2026 BIR 2316 for a bank loan. |

### 3.6 Leave page

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `readAsDataUrl` | src/app/employee/leave-page.jsx | Reads the chosen proof file so it can be sent. | file | Data text | Submitting with proof | `FileReader` | — |
| `LeaveRequestForm` | src/app/employee/leave-page.jsx | The leave form: type (Sick, Vacation, Emergency, Maternity, Paternity), with or without pay, dates (at least 7 days ahead), a reason, and an optional proof (PDF, PNG or JPEG under 2 MB). | `onSubmitted` | Form | Leave page | `earliestLeaveStart`, `DatePicker` | — |
| `onSubmit` (leave) | src/app/employee/leave-page.jsx | Sends the leave request and clears the form. | form values | Pop-up "Leave Request Submitted" | "Submit leave request" | `POST /api/employee/leave-requests` | A teacher files Vacation Leave for Nov 23–24 on Nov 10. |
| `days` | src/app/employee/leave-page.jsx | "1 day" / "3 days". | number | Text | Balance display | — | — |
| `LeaveBalance` | src/app/employee/leave-page.jsx | Leave-with-pay used out of 15, with a progress bar and the days without pay. | balance | Card | Leave page | `Progress` | "Used 4 of 15 days · 11 remaining". |
| `LeavePage` | src/app/employee/leave-page.jsx | Form, balance and the list of the employee's requests with their status. | leave data | Page | Sidebar → Leave | `LeaveRequestForm`, `LeaveBalance`, `DataTable` | — |

### 3.7 Profile page

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `Section` | src/app/employee/profile-page.jsx | A titled card. | icon, title | Card | Display | — | — |
| `ProfilePage` | src/app/employee/profile-page.jsx | Shows personal, employment, emergency-contact and government-ID details (IDs masked), and refreshes the emergency contact on load. | none | Page | Sidebar → Profile | `GET /api/legacy-auth/update-profile`, `InfoList`, `useAccountDialogs` | — |
| (Edit account `onClick`) | src/app/employee/profile-page.jsx | Opens the Edit Account dialog. | none | Dialog | "Edit account" button | `open("profile")` | — |

### 3.8 Employee API routes (server)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `getCurrentPhilippineMonth` | src/app/api/employee/stats/route.js | This month's first day, next month's first day, today and "October 2026" (Manila). | none | Dates | Stats request | — | — |
| `formatPeso` (stats) | src/app/api/employee/stats/route.js | "₱ 25,000" (or nothing for 0). | amount | Text | Stats request | — | — |
| `GET` (employee stats) | src/app/api/employee/stats/route.js | The employee's month: Present, Late, Absent and On Leave counts, a calendar record per day, today's taps, the next approved leave, the month's holidays, the next holiday and basic salary. Employees can only see their own. | email (own) | Stats | Dashboard / Attendance load, every 30 seconds | `attendance_logs`, `leave_requests`, `attendance_holidays`; `collapseDailyTaps`, `attendanceBucket`, `readApprovedLeave`, `readHolidayMap` | — |
| `toAmount` | src/app/api/employee/payslips/route.js | Rounds to 2 decimals. | value | Number | Internal | — | — |
| `payPeriodToLabel` | src/app/api/employee/payslips/route.js | "2026-10" becomes "October 2026" (other labels unchanged). | period | Text | Internal | — | — |
| `colMissing` | src/app/api/employee/payslips/route.js | Detects an older database without a column, so the query can be retried without it. | error, column | true/false | Internal | — | — |
| `mapEntryToPayslip` | src/app/api/employee/payslips/route.js | Turns a stored payroll entry into payslip fields: earnings, every deduction, incentives, net pay (rounded down), monthly or cutoff detail and holiday lines. | database row | Payslip | Payslip listing | `floorNetPay`, `holidayPayLines` | — |
| `mapRecordToPayslip` | src/app/api/employee/payslips/route.js | Turns an older summary payroll record into a simple payslip. | record | Payslip | Fallback listing | `floorNetPay` | — |
| `approvedRunIds` / `onlyReleased` / `approvedRunLabels` | src/app/api/employee/payslips/route.js | Show only payslips whose branch payroll run HR has approved (from October 1, 2026). | rows | Filtered rows | Payslip listing | `payroll_runs` table, `payslipVisible`, `requiresApproval` | A payslip still "Pending HR Approval" is hidden from the teacher. |
| `fetchPayslipsForUser` | src/app/api/employee/payslips/route.js | Reads up to 50 of the user's payslips (excluding drafts) and keeps only the released ones. | client, user ID | Payslips | Payslip listing | `payroll_entries`, `payroll_records` | — |
| `GET` (employee payslips) | src/app/api/employee/payslips/route.js | The signed-in employee's released payslips. | email (own) | `{payslips}` | Payslips page load | `requirePermission`, `listUsersCached`, `fetchPayslipsForUser` | — |
| `GET` (employee BIR 2316) | src/app/api/employee/bir-2316/route.js | Without a year: lists the finished years that have paid payslips. With a year: builds and downloads the employee's own BIR 2316 PDF (only for ended years) and logs it. | `year` | Years, or a PDF | "My BIR 2316" buttons | `birYears`, `loadBirYear`, `build2316Pdf`, `appendAuditLog` | — |
| `getDayName` / `getDayOfWeek` / `formatTime12` | src/app/api/employee/timesheet/route.js | "Monday" / 0–6 / "08:05 AM" for timesheet rows. | date | Text / number | Internal | — | — |
| `calcTardiness` / `calcUndertime` | src/app/api/employee/timesheet/route.js | Minutes late / minutes left early, by the day's schedule (default 8:00–5:00). | time, schedule | Minutes | Each timesheet day | `tardinessMinutes`, `undertimeMinutes` | — |
| `generateDateRange` | src/app/api/employee/timesheet/route.js | Every date between start and end. | start, end | Dates | Internal | — | — |
| `getShiftInfo` | src/app/api/employee/timesheet/route.js | Decides a day's shift: rest day, holiday, a half-day suspension (shortened shift and required hours), or a regular shift with the employee's schedule times. | date, schedule, holidays | Shift info | Each timesheet day | `isOffDay`, `cutoffMinutes`, `formatPolicyTime12`, `describeDayPart` | On a 1:00 PM suspension, required hours drop from 8 to 5. |
| `GET` (employee timesheet) | src/app/api/employee/timesheet/route.js | Builds a row for every day in the range (up to 366 days): shift, taps, required hours, tardiness, undertime and leave with pay. | email, `start_date`, `end_date` | Records | "Generate" on the Timesheet page | `attendance_logs`, `leave_requests`; `loadEmployeeScheduleDays`, `loadAttendanceConfig`, `readHolidayMap`, `collapseDailyTaps` | — |
| `currentBranchOf` | src/app/api/employee/leave-requests/route.js | The employee's current branch. | employee ID | Branch ID | Branch check | `profiles` table | — |
| `GET` (employee leave requests) | src/app/api/employee/leave-requests/route.js | The employee's leave requests and leave balance (others need a matching branch). | `employee_id` | Requests, balance | Leave page load | `readAllLeaveRequests`, `summarizeLeaveBalance` | — |
| `POST` (employee leave request) | src/app/api/employee/leave-requests/route.js | Files a leave request. Checks the required fields, date format, lengths, the 7-day advance rule, the proof file and duplicate pending requests, saves it as "pending", then notifies every HR account. | type, pay status, dates, reason, `proof_url` | Saved request (201) | "Submit leave request" | `validateProofUrl`, `meetsAdvanceRule`, `insertLeaveRequest`, `notify`, `hrAccountIds`; `leave_requests`, `notifications` | HR's bell shows "Leave request · Maria Santos". |
| `earliestLeaveStart` / `meetsAdvanceRule` | src/lib/leave-requests/advance-rule.js | The earliest allowed leave start (filing date + 7 days) / whether a start date respects it. | dates | Date / true-false | Leave form and server | `manilaDateKey` | Filed Oct 13: earliest start Oct 20. |
| `validateProofUrl` | src/lib/leave-requests/proof.js | Accepts only a PDF, PNG or JPEG proof under 2 MB. | proof data | ok or error | Filing leave | — | A 3 MB photo is refused: "Proof file must be less than 2MB." |
| `normalizeLeaveRequest` | src/lib/leave-requests/store.js | Cleans a leave request record into a standard shape. | row | Request | Reading or saving leave | — | — |
| `readAllLeaveRequests` | src/lib/leave-requests/store.js | Reads leave requests with optional filters (status, employee, branch, ID, date overlap, submitted since), all pages. | filters | Requests | Leave pages, payroll | `leave_requests` table, `fetchAllRows` | — |
| `insertLeaveRequest` | src/lib/leave-requests/store.js | Saves a new leave request. | request | Saved request | Filing leave | `leave_requests` table | — |
| `countLeaveDays` | src/lib/leave-requests/store.js | Days from start to end, inclusive. | start, end | Number | Balance | — | Nov 23–24 = 2 days. |
| `summarizeLeaveBalance` | src/lib/leave-requests/store.js | This year's approved paid days used, the remaining days (out of 15) and the unpaid days used. | requests, employee, year | Balance | Leave page | `countLeaveDays` | — |
| `GET` (attendance logs) | src/app/api/attendance/logs/route.js | The attendance status board for a range (default: the current pay period, up to 62 days). It closes past days first, adds today's "not yet tapped" rows, pending corrections, leave details, holiday names and refused taps. Employees see only their own records, with "can request correction" flags. | `from`, `to`, `period`, `status`, `branch_id` | Logs, counts, refused taps | Attendance pages (all roles) | database function `attendance_close_days`; `attendance_logs`, `attendance_corrections`, `profiles`; `listNotTapped`, `annotateAttendanceRows`, `readApprovedLeave`, `readBlockedTaps`, `readHolidayMap` | — |
| `resolveRange` | src/app/api/attendance/logs/route.js | Reads the from/to dates or a pay-period label (default: the current period). | URL | Range | Internal | `periodFromLabel`, `periodForDateKey` | — |
| `GET` (notifications) | src/app/api/notifications/route.js | The user's last 30 saved notifications and the unread count. | session | List, unread count | Bell, every 60 seconds | `notifications` table | — |
| `PATCH` (notifications) | src/app/api/notifications/route.js | Marks the user's notifications (all, or chosen IDs) as read. | `ids` (optional) | Success | Opening the bell | `notifications` table, `forEachInChunk` | — |
## 4. HR Portal (Dashboard, Employee Management, Transfers, Attendance, Leave, AWOL, Payroll Approval, Payroll Records, Reports)

**Web address:** `/hr`
**Who uses it:** The Human Resources officer, who covers every branch.
**What the pages do:**
- **HR Dashboard:** employee totals, present, absent and late today, a staff chart, pending leave, license alerts, upcoming holidays and recent activity.
- **User Management (Employee Management):** add, edit, archive, restore and separate Employee and Accountant accounts and their 201 records. Also CSV import and export, and bulk offboarding.
- **Transfer Requests:** see each employee's branch, assign or transfer employees (immediately, or after the branch Admins endorse it), move many at once, and view the transfer history.
- **Tenure Pay Protection, Work Schedules, RFID Cards, Branch Requests, Subsidy Approvals:** shared tools described in their own sections (5, 6, 2.5, 11 and 9).
- **Attendance Monitoring:** daily or all records grouped by branch, an Export CSV button and declared suspensions (for example, a typhoon).
- **Leave Approval:** approve or reject pending leave (with the branch Admin's recommendation and the proof file), cancel approved leave, and view the history.
- **AWOL Cases:** confirm unexcused absences, record the 1st and 2nd notices and the employee's reply, then separate the employee or close the case.
- **Payroll Approval:** review each branch's submitted payroll run (every employee's computation), then approve it (payslips released) or reject it with a reason. Export to Excel or PDF.
- **Payroll Records:** every processed payslip, read-only, with print, PDF download and BIR forms.
- **HR Reports:** an attendance summary or an employee records report, grouped by branch, with a chart and CSV export.

### 4.1 Portal shell

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `HrLayout` / `HrPage` | src/app/hr/layout.js, src/app/hr/page.js | Frame and entry of the HR portal. | `children` | Portal | Opening `/hr` | `PortalLayout`, `HrPortal` | — |
| `HrPortal` | src/app/hr/hr-portal.jsx | Wraps the HR pages in the HR session (with the forced password screen). | none | Portal | Page load | `PortalSessionProvider`, `PasswordGate` | — |
| `HrScreens` | src/app/hr/hr-portal.jsx | Builds the HR sidebar (16 pages), checks permission for each page, shows the "waiting runs" badge on Payroll Approval, and shows the chosen page. | none | Page | Page load, sidebar clicks | `usePersistedPage`, `useEmployeeRecordPage`, `usePendingRunCount`, `AppShell`, `AttendanceActionsProvider` | — |
| `allowed` | src/app/hr/hr-portal.jsx | Checks that HR's permissions allow a page (otherwise the Dashboard shows). | page ID | true/false | Navigation | `can` | — |
| `refresh` | src/app/hr/hr-portal.jsx | Reloads the current page's data. | none | none | Top-bar Refresh | — | — |

### 4.2 HR Dashboard

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `timeOnly` | src/app/hr/dashboard-page.jsx | "08:05 AM" from a time. | time | Text | Recent activity list | — | — |
| `DashboardPage` (HR) | src/app/hr/dashboard-page.jsx | Loads and shows total employees, present/absent/late today, a Teaching vs Non-Teaching chart, pending leave with "Review now", license alerts, upcoming holidays and the last 10 taps. It also fills the bell summary. | `refreshKey`, `onNavigate`, `onSummary` | Page | Sidebar → Dashboard | `GET /api/hr/dashboard`, `StatCard`, `LicenseAlertsCard`, `UpcomingHolidaysCard` | HR sees "3 leave requests awaiting your decision". |
| (View employees / View attendance / Review now / View all `onClick`) | src/app/hr/dashboard-page.jsx | Jump to User Management, Attendance or Leave Approval. | page | Page change | Dashboard buttons | `onNavigate` | — |
| `LicenseAlertsCard` | src/app/hr/license-alerts-card.jsx | Lists licensed teachers whose PRC license is expiring or has expired, with Open and Acknowledge buttons. Hidden when there are none. | `refreshKey`, `onNavigate` | Card | Dashboard load | `GET /api/hr/teacher-license` | "Ana Reyes — License expires Nov 30, 2026". |
| `load` / `acknowledge` (license alerts) | src/app/hr/license-alerts-card.jsx | Load the alerts / clear one alert. | alert | Updated list, pop-up | Page load / "Acknowledge" | `POST /api/hr/teacher-license {action:"acknowledge_alert"}` | — |

### 4.3 User Management (Employee Management)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `useBranches` | src/app/hr/employees-page.jsx | Loads the list of branches (retries up to 3 times). | `refreshKey` | Branches | Page load | `GET /api/admin/branches` | — |
| `EmployeesPage` | src/app/hr/employees-page.jsx | The staff list with tabs (All, Teaching, Non-Teaching, Archived), a branch filter, license badges, search and an Edit button per row. Includes Export CSV, Import CSV, Offboard many and Add employee. | `refreshKey` | Page | Sidebar → User Management | `load`, `EmployeeFormDialog`, `EmployeeImportDialog`, `BulkLinesDialog`, `DataTable` | — |
| `load` (employees) | src/app/hr/employees-page.jsx | Loads all employees, archived ones included. | none | List | Page load, after saves | `GET /api/hr/employees?archived=true` | — |
| (license effect) | src/app/hr/employees-page.jsx | Loads each teacher's license status for the License column. | none | Status map | Page load | `GET /api/hr/teacher-license` | — |
| `branchName` | src/app/hr/employees-page.jsx | Branch name for a branch ID. | ID | Name | Table display | — | — |
| `exportList` | src/app/hr/employees-page.jsx | Downloads the visible staff list as CSV. | rows | CSV file | "Export CSV" | `downloadCsv` | HR sends the Antipolo staff list to the principal. |
| (Offboard many `parseLine` / `run` / `onDone`) | src/app/hr/employees-page.jsx | Bulk separation. Each line "SACS-0101, 2026-10-31" is checked (known, not already separated, valid date) and then separated with the chosen reason. | pasted lines, reason, note | Report | "Offboard many" dialog | `PATCH /api/hr/employees {action:"separate"}` | End-of-school-year contract endings for 12 teachers. |
| `positionForRole` | src/app/hr/employee-form-dialog.jsx | Position label from the role ("Accountant" or "Employee"). | role | Label | Role change | — | — |
| `parseDate` / `yearsBetween` / `pick` | src/app/hr/employee-form-dialog.jsx | Read a date / age in years / match a dropdown option. | values | Date / number / option | Form checks | — | — |
| `emptyValues` / `valuesFromEmployee` | src/app/hr/employee-form-dialog.jsx | A blank form / a form filled from an existing employee. | employee | Form values | Dialog opens | `formatDigitField` | — |
| `validate` | src/app/hr/employee-form-dialog.jsx | Checks the 201 form: required fields, name characters, email, age at least 15, hire date after the 15th birthday, salary up to ₱9,999,999.99, address, mobile 09xxxxxxxxx, SSS 10, PhilHealth 12, Pag-IBIG 12, TIN 9 or 12 digits, and a complete emergency contact with a different number. | values, mode | Errors, or a clean payload | "Create employee" / "Save changes" | — | Refuses an SSS number with 9 digits. |
| `Section` | src/app/hr/employee-form-dialog.jsx | Section heading inside the form. | text | Heading | Display | — | — |
| `EmployeeFormDialog` | src/app/hr/employee-form-dialog.jsx | Add Employee / Edit Employee dialog with the license section (Teaching staff), Archive/Restore and Separate buttons. | mode, employee, branches, callbacks | Dialog | "Add employee" / "Edit" | `validate`, `LicenseSection`, `SeparateEmployeeDialog`, `useConfirm` | — |
| `set` / `setName` | src/app/hr/employee-form-dialog.jsx | Update a field (clear its error, and set the position when the role changes) / update a name field, removing disallowed characters. | key, value | none | Typing | `cleanNameInput` | — |
| `submit` (employee form) | src/app/hr/employee-form-dialog.jsx | Creates a new employee (asking "Create anyway?" on a possible duplicate) or saves the edit (refused if someone else changed the record meanwhile). | form | Pop-up "Employee Created" / "Employee Updated" | Form submit | `POST /api/admin/employees`, `PATCH /api/hr/employees` | A new Grade 3 teacher gets ID SACS-0142 and must change her default password on first sign-in. |
| `toggleArchive` | src/app/hr/employee-form-dialog.jsx | Archives the employee after confirmation (they can no longer sign in or tap, and history is kept), or restores them. | employee | Pop-up | "Archive employee" / "Restore employee" | `PATCH /api/admin/employees {action}` | — |
| `field` / `aria` / `text` / `name` / `digits` / `readOnly` / `select` / `date` | src/app/hr/employee-form-dialog.jsx | Small builders for the form's labelled boxes, dropdowns and date pickers. | key, options | Form controls | Display | `DatePicker`, `formatDigitField` | — |
| `SeparateEmployeeDialog` | src/app/hr/separate-employee-dialog.jsx | Separate an employee: last day, reason (Resigned, End of contract, Retired, Terminated, Deceased, Other) and a note (required for Terminated or Other). | employee, callbacks | Dialog | "Separate…" in Edit Employee | `save` | — |
| `save` (separate) | src/app/hr/separate-employee-dialog.jsx | Saves the separation. The Accountant then settles the pay through Final Pay. | last day, reason, note | Pop-up "Employee Separated" | "Separate" | `PATCH /api/hr/employees {action:"separate"}` | A teacher resigns effective October 31. |
| `downloadTemplate` | src/app/hr/employee-import-dialog.jsx | Downloads the blank CSV template for importing employees. | none | CSV file | "Download template" | — | — |
| `EmployeeImportDialog` | src/app/hr/employee-import-dialog.jsx | Import many new employees from a CSV: check the file first (nothing is created), then import the valid rows in batches with a progress bar, then download a report. | `open`, callbacks | Dialog | "Import CSV" | `pick`, `check`, `runImport`, `downloadReport` | Importing 35 new hires for June. |
| `pick` | src/app/hr/employee-import-dialog.jsx | Reads the chosen CSV and reports missing columns, no rows or too many rows. | file | Parsed rows | Choosing a file | `readImportFile` | — |
| `check` | src/app/hr/employee-import-dialog.jsx | Dry run: the server checks every row without creating anything. | rows | Per-row results | "Check file" | `POST /api/admin/employees/import {dry_run:true}` | — |
| `runImport` | src/app/hr/employee-import-dialog.jsx | Creates the rows that passed, in batches, then shows "N employees created". | rows | Results | "Import N employees" | `POST /api/admin/employees/import` | — |
| `downloadReport` (import) | src/app/hr/employee-import-dialog.jsx | CSV report of each line: created or refused, and why. | results | CSV file | "Download report" | `downloadCsv` | — |

### 4.4 Transfer Requests (Branch Management for employees)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `fmt` | src/app/hr/transfers-page.jsx | Date and time text. | date | Text | Tables | — | — |
| `TransferDialog` | src/app/hr/transfers-page.jsx | Assign a branch to an unassigned employee, or transfer to another active branch, with remarks. Optionally ask both branch Admins to endorse it first. | employee, branches, callbacks | Dialog | "Assign" / "Transfer" buttons | `submit`, `useConfirm` | — |
| `submit` (transfer) | src/app/hr/transfers-page.jsx | Confirms, then moves the employee now, or creates a request waiting for the Admins' endorsement. | destination, remarks, wait flag | Pop-up "Employee Transferred" / "Endorsement Requested" | Dialog submit | `POST /api/admin/transfer-requests` | Moving a teacher from Main Campus to the Marikina branch. |
| `TransfersPage` | src/app/hr/transfers-page.jsx | Branch tiles with counts, the employee list grouped by branch, Move many, and the transfer history with the Admins' endorsements and Approve/Reject buttons. | `refreshKey` | Page | Sidebar → Transfer Requests | `load`, `loadEndorsements`, `decideTransfer`, `BranchGroupedTable`, `DataTable` | — |
| `loadEndorsements` | src/app/hr/transfers-page.jsx | Loads the branch Admins' endorsements for transfers. | none | Map | Page load | `GET /api/hr/branch-requests?kind=transfer_endorsement` | — |
| `load` (transfers) | src/app/hr/transfers-page.jsx | Loads the employee branch list and the transfer history. | none | Lists | Page load, Refresh, after changes | `GET /api/admin/branch-employees`, `GET /api/admin/transfer-requests` | — |
| `countFor` / `rank` / `branchCell` | src/app/hr/transfers-page.jsx | Count per branch / sort order / the coloured branch badge. | branch / employee | Number / badge | Display | — | — |
| `decideTransfer` | src/app/hr/transfers-page.jsx | Approves (the employee moves now) or rejects a pending transfer, after confirmation. | request, action | Pop-up | "Approve" / "Reject" in history | `PATCH /api/admin/transfer-requests` | — |
| (Move many `parseLine` / `run` / `onDone`) | src/app/hr/transfers-page.jsx | Bulk move: one Employee ID per line, all to one branch with remarks. | IDs, branch, remarks | Report | "Move many" | `POST /api/admin/transfer-requests` | Merging East Campus staff into Main Campus. |

### 4.5 Attendance Monitoring (HR)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `localDateKey` / `timeOnly` / `suspensionDate` | src/app/hr/attendance-page.jsx | Today's date / "08:05 AM" / "Mon, Oct 19, 2026". | date | Text | Display | — | — |
| `SuspensionsCard` | src/app/hr/attendance-page.jsx | Declare a work suspension (whole day, morning or afternoon, with a time) and list upcoming ones with a Remove button. | `onChanged`, `refreshKey` | Card | Attendance page | `load`, `add`, `remove` | Typhoon Kristine: whole-day suspension on Oct 24. |
| `load` (suspensions) | src/app/hr/attendance-page.jsx | Loads upcoming suspensions. | none | List | Page load | `GET /api/admin/holidays?upcoming=20` | — |
| `add` (suspension) | src/app/hr/attendance-page.jsx | Checks the form and saves the suspension. Attendance for that day is re-marked automatically. | date, reason, part, time | Pop-up "Suspension Added" | "Add suspension" | `POST /api/admin/holidays` | — |
| `remove` (suspension) | src/app/hr/attendance-page.jsx | Removes a future suspension (or one added today) after confirmation. | date | Message | "Remove" | `DELETE /api/admin/holidays?date=` | — |
| `AttendancePage` (HR) | src/app/hr/attendance-page.jsx | Present, Late and Absent tiles, suspensions, and the attendance table for a chosen date or "View all records", grouped by branch with collapsible groups and an employee search. | `refreshKey` | Page | Sidebar → Attendance | `load`, `exportCsv`, `GroupedAttendanceTable`, `AttendanceStatusBoard` | — |
| `load` (HR attendance) | src/app/hr/attendance-page.jsx | Loads the chosen day or all records (ignoring outdated replies). | view | Logs, summary | Page load, date change | `GET /api/hr/attendance` | — |
| (`log` memo) | src/app/hr/attendance-page.jsx | One row per employee per day, filtered by search, sorted and counted by branch and day. | logs, search | Grouped rows | Data or search change | `oneRowPerDay`, `branchContext`, `sortByBranchDay`, `branchCounts`, `countBy` | — |
| `exportCsv` (HR attendance) | src/app/hr/attendance-page.jsx | Downloads the loaded records as CSV (name, type, date, in, out, hours, status). | logs | CSV file | "Export CSV" | `downloadCsv` | — |
| (group `onToggle`) | src/app/hr/attendance-page.jsx | Collapses or expands one branch group. | branch | none | Clicking a branch heading | — | — |

### 4.6 Leave Approval

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `localDateKey` / `range` | src/app/hr/leaves-page.jsx | Today's date / a request's days, dates and proof. | request | Values | Display | — | — |
| `AdminRecommendation` | src/app/hr/leaves-page.jsx | Shows the branch Admin's recommendation (HR still decides). | recommendation | Badge | Leave cards and table | — | "Branch Admin: Recommended". |
| `LeavesPage` | src/app/hr/leaves-page.jsx | Pending request cards (type, pay, days, reason, proof, Approve/Reject) and the leave history table with Cancel for approved leave that hasn't ended. | `refreshKey` | Page | Sidebar → Leave Approval | `load`, `loadRecs`, `decide`, `cancelLeave`, `useProofViewer` | — |
| `loadRecs` / `load` (leaves) | src/app/hr/leaves-page.jsx | Load the Admins' recommendations / the pending and history lists. | none | Data | Page load | `GET /api/hr/branch-requests?kind=leave_endorsement`, `GET /api/hr/leave-requests?status=all` | — |
| `decide` (leave) | src/app/hr/leaves-page.jsx | Approves or rejects after confirmation, and warns about days that already have a tap (left as recorded). | request, action | Pop-ups | "Approve" / "Reject" | `PATCH /api/hr/leave-requests` | HR approves 2 days of sick leave; those days become "On Leave". |
| `cancelLeave` | src/app/hr/leaves-page.jsx | Cancels an approved leave after confirmation. Its On Leave days are released, so the employee can tap again. | request | Pop-up "Leave Cancelled" | "Cancel" in history | `PATCH /api/hr/leave-requests {action:"cancel"}` | A teacher cut her vacation short and comes back early. |

### 4.7 AWOL Cases

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `plusDays` | src/app/hr/awol-cases-page.jsx | Adds days to a date. | date, n | Date | Default reply dates | — | — |
| `AwolCasesPage` | src/app/hr/awol-cases-page.jsx | AWOL list (open, closed or all), summary tiles, and the step buttons: Confirm AWOL → Send 1st notice → Send 2nd notice → Separate, plus Reply and Close. | `refreshKey` | Page | Sidebar → AWOL Cases | `load`, `open`, `submit` | — |
| `load` (AWOL) | src/app/hr/awol-cases-page.jsx | Loads the cases. | none | Data | Page load, Refresh | `GET /api/hr/awol-cases` | — |
| `open` (AWOL) | src/app/hr/awol-cases-page.jsx | Opens the dialog for a step with sensible default dates (reply due 5 days later). | action, case | Dialog | Step buttons / "Open case" | — | — |
| `submit` (AWOL) | src/app/hr/awol-cases-page.jsx | Saves the step: open a case, confirm (pay held), 1st or 2nd notice, the employee's reply, separate, or close (status Active, pay released). | dialog values | Pop-up | "Save" | `POST`/`PATCH /api/hr/awol-cases` | After 3 unexcused absences, HR confirms AWOL and sends a Return-to-Work Order. |
| `fieldFor` | src/app/hr/awol-cases-page.jsx | Labelled field builder. | id, label, control | Field | Display | — | — |

### 4.8 Payroll Approval

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `RunStatusBadge` / `cutoffLabel` | src/app/hr/payroll-approval-page.jsx | Run status badge / "1st cutoff (1–15)" or "2nd cutoff (16–end)". | run | Badge / text | Display | `RUN_STATUS_LABELS` | — |
| `DecisionDialog` | src/app/hr/payroll-approval-page.jsx | Approve (one or many runs; payslips released and locked) or reject (a reason of at least 5 characters, sent back to the Accountant), with the totals. | decision, callbacks | Dialog | Approve / Reject buttons | `submit` | — |
| `submit` (decision) | src/app/hr/payroll-approval-page.jsx | Sends the approval or rejection and reports runs that could not be approved. | remarks | Pop-up "Payroll Approved" / "Payroll Rejected" | Dialog button | `PATCH /api/hr/payroll-runs` | HR approves all 4 branches' Oct 1–15 payroll at once. |
| `lineHow` | src/app/hr/payroll-approval-page.jsx | Explains a computed line ("3 days × ₱ 550.00 · Oct 7"). | line | Text | Breakdown | `money`, `shortDate` | — |
| `Breakdown` | src/app/hr/payroll-approval-page.jsx | One employee's computation: earnings, deductions, attendance days and minutes, rates, attendance window and taxable income. | item, first-cutoff flag | Panel | Expanding a row | `lineHow` | — |
| `RunDetail` | src/app/hr/payroll-approval-page.jsx | One branch's run: totals, the Early Bird winner, an employee table (flagged rows highlighted, expandable), the action history, and Print, Excel, PDF, Approve and Reject buttons. | run ID, callbacks | Page | "Review" / "View run" | `load`, `toggle`, `useLivePayrollRuns`, `DecisionDialog` | — |
| `load` / `toggle` / `sum` / `exportUrl` (run detail) | src/app/hr/payroll-approval-page.jsx | Load the run / expand a row / total a column / build the Excel or PDF download address. | run ID | Data / URL | Page load, clicks | `GET /api/hr/payroll-runs?run_id=` | — |
| (Print `onClick`) | src/app/hr/payroll-approval-page.jsx | Prints the run page. | none | Print dialog | "Print" | `window.print` | — |
| `PayrollApprovalPage` | src/app/hr/payroll-approval-page.jsx | Tabs (Pending, Paid, Rejected, All, History), branch and period filters, search (300 ms delay), a run list with select-all, and "Approve selected". Updates live when a run changes. | `refreshKey`, `onChanged` | Page | Sidebar → Payroll Approval | `load`, `useLivePayrollRuns`, `RunDetail`, `DecisionDialog` | — |
| `load` (runs) / `toggle` (select) | src/app/hr/payroll-approval-page.jsx | Load the list for the tab and filters / tick or untick a run. | filters / run | Data / selection | Tab or filter change, checkbox | `GET /api/hr/payroll-runs` | — |

### 4.9 Payroll Records and HR Reports

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `PayrollRecordsPage` | src/app/hr/payroll-records-page.jsx | Every branch's processed payslips (paged on the server), with period and branch filters, total tiles, a View button per payslip and the BIR forms card. | `refreshKey` | Page | Sidebar → Payroll Records | `load`, `view`, `downloadPdf`, `PayslipDocument`, `BirFormsCard` | — |
| `load` / `onPaging` / `choosePeriod` / `chooseBranch` | src/app/hr/payroll-records-page.jsx | Load a page of records / change the page or search / change the period or branch filter. | filters | Data | Filters, pager | `GET /api/hr/payroll-records` | — |
| `view` | src/app/hr/payroll-records-page.jsx | Opens one payslip exactly as the Accountant sees it. | entry ID | Payslip view | "View" | `GET /api/hr/payroll-records?entry_id=` | — |
| `downloadPdf` (records) | src/app/hr/payroll-records-page.jsx | Downloads the open payslip as a PDF. | entry ID | PDF file | "Download PDF" | `GET /api/hr/payroll-records?format=pdf` | HR emails a teacher a copy of her August payslip. |
| (Print `onClick`) | src/app/hr/payroll-records-page.jsx | Prints the open payslip. | none | Print dialog | "Print" | `window.print` | — |
| `localDateKey` / `sortByBranch` | src/app/hr/reports-page.jsx | Today's date / sort by branch (Unassigned last), then by name. | records | Sorted list | Report display | — | — |
| `ReportsPage` | src/app/hr/reports-page.jsx | Choose Attendance (date range) or Employee records, generate, then see tiles, a per-branch chart and a branch-grouped table with Export CSV. | none | Page | Sidebar → HR Reports | `generate`, `exportCsv`, `BranchGroupedTable` | — |
| `generate` (HR report) | src/app/hr/reports-page.jsx | Loads the chosen report. | type, from, to | Rows | "Generate" | `GET /api/hr/reports` | Monthly attendance report for the school board. |
| `exportCsv` (HR report) | src/app/hr/reports-page.jsx | Downloads the report as CSV. | rows | CSV file | "Export CSV" | `downloadCsv` | — |
| `sum` / (`byBranch` memo) | src/app/hr/reports-page.jsx | Add up a column / totals per branch for the chart. | rows | Numbers | Report display | — | — |

### 4.10 HR API routes (server)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `GET` (HR dashboard) | src/app/api/hr/dashboard/route.js | Totals for the dashboard: employees (teaching and non-teaching), present, late and absent today, pending leave and the 10 latest taps. | session | Figures | Dashboard load | `listUsersCached`, `profiles`, `attendance_logs`, `readAllLeaveRequests`, `collapseDailyTaps`, `attendanceBucket` | — |
| `getDateLabel` (HR attendance) | src/app/api/hr/attendance/route.js | "October 19, 2026". | date | Text | Internal | — | — |
| `GET` (HR attendance) | src/app/api/hr/attendance/route.js | Attendance for one date (closing past days first and adding "not yet tapped" rows for today) or the last 500 records, with summary counts. | `date`, `view` | Logs, summary | Attendance page | database function `attendance_close_days`; `attendance_logs`, `profiles`; `listNotTapped`, `annotateAttendanceRows` | — |
| `GET` (HR reports) | src/app/api/hr/reports/route.js | Attendance report (present, late, absent, leave and hours per employee for a range) or employee records report (with active and archived counts), each with branch names. | `type`, `from`, `to` | Records | "Generate" | `attendance_logs`, `branches`, `profiles`, `listUsersCached` | — |
| `GET` (HR leave requests) | src/app/api/hr/leave-requests/route.js | Pending leave requests and the last year's history (own branch for Admins). | `status` | Pending, history | Leave Approval load | `readAllLeaveRequests` | — |
| `PATCH` (HR leave requests) | src/app/api/hr/leave-requests/route.js | Approve or reject a pending request (blocking overlaps with approved leave, and refusing if someone else already decided), or cancel an approved, unfinished leave. Notifies the employee and the endorsing Admins, logs it, and syncs attendance. | `id`, `action` | New status, attendance conflicts | Approve / Reject / Cancel | `updateLeaveRequestStatus`, `findOverlappingApprovedLeave`, `cancelApprovedLeaveRequest`, `syncLeaveAttendance`, `notify`, `notifyEndorsers`, `appendAuditLog` | — |
| `toTitleCaseWords` / `nameParts` / `composeFullName` | src/app/api/hr/employees/route.js | Capitalize name parts / build first, middle, last and suffix / join into a full name. | record | Name parts / full name | Editing an employee | `normalizeSuffix` | — |
| `shapeEmployee` (HR) | src/app/api/hr/employees/route.js | Builds the employee record shown in User Management. | user, profile | Employee | Listing | — | — |
| `GET` (HR employees) | src/app/api/hr/employees/route.js | Lists Employee and Accountant records (optionally including archived), branch-limited, with decrypted government IDs for HR. | `archived` | Employees | User Management load | `listUsersCached`, `profiles`, `fetchProfilesPii`, `scopeListToBranch` | — |
| `PATCH` (HR employees) | src/app/api/hr/employees/route.js | Either separates an employee (checks the date, reason and hire date, then logs it), or updates the 201 record. It refuses stale edits, keeps the AWOL and Separated statuses, validates everything, and updates both the login account and the profile. | `id`, fields or `action:"separate"` | Success | "Save changes" / "Separate" | `getTrustedUserById`, `validateEmployeeRecord`, `validateEmergencyContactUpdate`, `separateEmployee`, `validateSeparation`, Supabase `updateUserById`, `profiles`, `appendAuditLog` | — |
| `GET` (AWOL cases) | src/app/api/hr/awol-cases/route.js | Open cases and the last 60 days of closed ones, with each case's counted absence days, active staff for opening a case, and summary counts. | session | Cases, people, summary | AWOL page load | `employee_awol_cases`, `attendance_logs`; `loadPayrollStaff`, `shapeCase`, `addDays` | — |
| `POST` (AWOL cases) | src/app/api/hr/awol-cases/route.js | Opens a case manually (first absence not in the future, last present before it, one open case per person). | `employee_id`, dates, notes | Case ID | "Open case" | `employee_awol_cases`, `appendAuditLog` | — |
| `PATCH` (AWOL cases) | src/app/api/hr/awol-cases/route.js | Moves a case to its next step (HR only): confirm (status AWOL), 1st and 2nd notice (reply at least 5 days later), record the reply, separate (grounds of at least 10 characters), or close (false alarm, returned or excused). | `case_id`, `action`, details | Success | Step dialogs | `canTransition`, `setEmployeeStatus`, `employee_awol_cases`, `appendAuditLog` | — |
| `loadDecisionHistory` | src/app/api/hr/payroll-runs/route.js | Every approve or reject decision, with the submission it answered, filtered and searched. | client, guard, filters | Rows | History tab | `payroll_run_summaries`, `payroll_approval_history` | — |
| `scopeRuns` | src/app/api/hr/payroll-runs/route.js | Limits run queries to the user's branch unless they see every branch. | query, guard | Query | Internal | — | — |
| `shapeItem` | src/app/api/hr/payroll-runs/route.js | Cleans one employee's row in a run (pay figures, attendance counts, flags, breakdown). | row | Item | Run detail | — | — |
| `loadRunDetail` | src/app/api/hr/payroll-runs/route.js | One run with its items (from the submitted snapshot), totals, history and the Early Bird winner (name hidden for other branches). | client, guard, run ID | Detail | Opening a run | `payroll_run_summaries`, `payroll_run_items`, `payroll_approval_history`, `early_bird_winners`, `runTotals`, `shapeWinner` | — |
| `exportFile` / `sum` | src/app/api/hr/payroll-runs/route.js | Builds an Excel workbook (Payroll, Lines and Summary sheets) or a landscape PDF of the run / totals a column. | detail, format | File | "Excel" / "PDF" in run detail | `buildXlsx`, `buildTablePdf`, `money` | HR prints the Marikina branch payroll for signatures. |
| `GET` (payroll runs) | src/app/api/hr/payroll-runs/route.js | The pending count (sidebar badge), one run (or its export), the decision history, or the run list by status, branch, period and search. | `count`, `run_id`, `format`, `status`, `branch_id`, `period`, `q`, `view` | Runs, detail or file | Payroll Approval page | functions above | — |
| `notifyPayslipsReleased` | src/app/api/hr/payroll-runs/route.js | Sends "Your payslip is ready" to every employee in an approved run. | client, run ID | none | After approval | `payroll_runs`, `payroll_run_items`, `notify` | Teachers get a bell notice that their Oct 1–15 payslip is ready. |
| `PATCH` (payroll runs) | src/app/api/hr/payroll-runs/route.js | HR only: reject one run (reason required), or approve up to 50 runs, then notify the employees. | `action`, `run_id(s)`, `remarks` | Results | Approve / Reject | database functions `approve_payroll_run`, `reject_payroll_run`; `describeRunError`, `shapeRun` | — |
| `GET` (payroll-runs stream) | src/app/api/hr/payroll-runs/stream/route.js | A live connection (Server-Sent Events) that tells the page whenever a payroll run changes (own branch only), with a heartbeat every 25 seconds, for up to 4 minutes. | session | Event stream | Payroll Approval page open | Supabase Realtime on `payroll_runs` | HR's list updates the moment the Accountant submits. |
| `amount` / `normalizeEntry` / `searchTerm` / `listQuery` | src/app/api/hr/payroll-records/route.js | Round money / read a stored payroll entry / make search text safe / build the filtered and paged query. | values | Values / query | Internal | `payroll_entries` | — |
| `GET` (HR payroll records) | src/app/api/hr/payroll-records/route.js | One payslip (as details or a PDF), or a page of processed payslips with grand totals, periods, branches and each run's status. | `entry_id`, `format`, `period`, `branch`, `q`, `page`, `page_size` | Records, payslip or PDF | Payroll Records page | `payroll_entries`, `payroll_runs`, `branches`, database function `payroll_entries_totals`; `buildPayslipDetails`, `buildPayslipPdf`, `loadOrgName` | — |
| `allowedKinds` | src/app/api/hr/branch-requests/route.js | Which branch-Admin request kinds the role may handle (HR: all; Super Admin: RFID issues only). | role | Kinds | Internal | `REQUEST_KINDS` | — |
| `GET` (branch requests) | src/app/api/hr/branch-requests/route.js | Lists the branch Admins' requests by kind, status and branch. | `kind`, `status`, `branch_id` | Requests | Branch Requests, Leave and Transfer pages | `branch_admin_requests`, `branches`, `shapeRequest` | — |
| `PATCH` (branch requests) | src/app/api/hr/branch-requests/route.js | Decides a pending request with a remark. An approved incentive recommendation is added to payroll. Notifies the Admin and logs it. | `id`, `decision`, `note` | Updated request | Decide buttons | `branch_admin_requests`, `payroll_monthly_incentives`, `historyEntry`, `notify`, `appendAuditLog` | HR approves a ₱ 1,000 incentive an Admin recommended for a teacher. |
| `dbError` / `warningDays` / `shape` (license) | src/app/api/hr/teacher-license/route.js | Plain database error / the license expiry warning days (default 60) / one teacher's license row. | — | — | Internal | `system_config` | — |
| `GET` (teacher license) | src/app/api/hr/teacher-license/route.js | One teacher's license (with change history), all teachers' license statuses with open alerts, or (HR only) the uploaded PRC ID document. | `employee_id`, `document_id` | Teachers, alerts, history | License sections, dashboard | `profiles`, `employee_license_alerts`, `employee_license_documents`, `payroll_setting_changes`; `licenseStatus`, `maskedLicense` | — |
| `POST` (teacher license) | src/app/api/hr/teacher-license/route.js | HR only: acknowledge an alert, or turn on, update, verify or turn off a teacher's license (with the PRC number, expiry and optional PRC ID upload), logged. | `action`, details | Success | License section buttons | `validateLicenseChange`, `validateProofUrl`, `employee_license_changes`, `employee_license_documents`, `appendAuditLog` | HR verifies a teacher's PRC license, so the licensed-teacher subsidy can start. |
## 5. Attendance Monitoring Tools: Corrections, Overtime, Holidays (shared by HR, Admin and Super Admin)

**Where it appears:** the Attendance pages of the HR, Admin and Super Admin portals, and the "Individual Employee Attendance Record" sub-page.
**What it does:** the attendance status board for a pay period. It has tabs for all records, the Incomplete queue, employees' correction requests, overtime to approve and refused RFID taps. It also has the correction dialogs (correct any record, review a request, resolve an Incomplete day, approve overtime, view raw taps and correction history), one employee's full attendance record, and holidays and suspensions.

### 5.1 Attendance dialogs

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `useAttendanceActions` | src/components/portal/attendance/dialogs.jsx | Lets any attendance table open a dialog or an employee's record, and know when data changed. | none | Actions | Attendance pages | — | — |
| `AttendanceActionsProvider` | src/components/portal/attendance/dialogs.jsx | Holds the six attendance dialogs and a "changed" counter that makes the tables reload after a save. | `onOpenEmployee` | Context with dialogs | HR, Admin and Super Admin portals | all dialogs below | — |
| `changed` / `open` / `close` | src/components/portal/attendance/dialogs.jsx | Mark data changed / open a dialog for a record / close it. | kind, row | none | Buttons in tables | — | — |
| `Field` / `Summary` | src/components/portal/attendance/dialogs.jsx | Labelled field with an error line / grey summary box at the top of a dialog. | children | Elements | Display | — | — |
| `ActionDialog` | src/components/portal/attendance/dialogs.jsx | A dialog whose buttons run a save. Buttons are disabled while saving, errors show inline, and it closes on success. | title, summary, actions | Dialog | Every attendance dialog | — | — |
| `run` (in `ActionDialog`) | src/components/portal/attendance/dialogs.jsx | Runs one button's action and handles busy, error and close. | action | none | Dialog button | — | — |
| `useFieldErrors` / `check` | src/components/portal/attendance/dialogs.jsx | Keep the field errors and stop with "Fill in the highlighted fields." | errors | none | Saving | — | — |
| `usePayrollNotice` | src/components/portal/attendance/dialogs.jsx | Warns when a corrected day belongs to an already-final payslip (it won't change by itself). | server reply | Pop-up "Final Payslip Not Updated" | After a correction | `notify` | — |
| `needsFor` | src/components/portal/attendance/dialogs.jsx | Which times a correction type needs (time in, time out, or both). | type | Flags | Correct dialog | — | — |
| `CorrectRecordDialog` | src/components/portal/attendance/dialogs.jsx | HR or Admin corrects any day: fix the time in, the time out, both, or "mark as present" (worked but didn't tap). A reason is required. | record | Dialog | "Correct" button | `save` | — |
| `save` (correct record) | src/components/portal/attendance/dialogs.jsx | Checks the times (time in before time out, not in the future, not unchanged) and the reason, then saves. The day becomes "Corrected". | type, times, note | Pop-up "Attendance Corrected" | "Save correction" | `PATCH /api/attendance/corrections {action:"correct_record"}` | A teacher's accidental 9:15 tap is corrected to 7:50, confirmed by the branch logbook. |
| `ReviewCorrectionDialog` / `decide` | src/components/portal/attendance/dialogs.jsx | Approve an employee's correction request (the time out is replaced and the day marked Corrected), or reject it and set the day to Incomplete, Absent or Half Day. | request, resolution, note | Pop-up | "Review" → Approve / Reject | `PATCH /api/attendance/corrections {correction_id, decision}` | — |
| `ResolveDialog` / `save` (resolve) | src/components/portal/attendance/dialogs.jsx | Resolve an Incomplete day nobody asked about: record the time out, or mark Absent or Half Day (a reason is required). | record, resolution, time, note | Pop-up "Record Resolved" | "Resolve" in the Incomplete tab | `PATCH /api/attendance/corrections {action:"resolve"}` | The Admin confirms from the guard's logbook that a teacher left at 4:30 PM. |
| `OvertimeDialog` / `decide` (overtime) | src/components/portal/attendance/dialogs.jsx | Approve some or all of the overtime minutes (1 up to the maximum), or reject it. | record, minutes, note | Pop-up "Overtime Approved" / "Rejected" | "Review" / "Change" in the Overtime tab | `PATCH /api/attendance/overtime` | Approving 90 minutes for a teacher who stayed for the school program. |
| `TapsDialog` | src/components/portal/attendance/dialogs.jsx | Shows every raw tap of the day (first = Time In, last = Time Out), the reader used, and taps made after a correction. | record | Dialog | "View taps" | — | — |
| `correctionKind` | src/components/portal/attendance/dialogs.jsx | Describes a correction in words ("Time out corrected", "Marked present"…). | correction | Text | History | — | — |
| `HistoryDialog` | src/components/portal/attendance/dialogs.jsx | The day's correction history: before and after times, hours, who did it and when. | record | Dialog | "Correction history" link | `workedMinutes`, `hoursMinutes` | — |

### 5.2 Status board, grouped table and employee record

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `AttendanceStatusBoard` | src/components/portal/attendance/status-board.jsx | The board for one pay period (current plus the last 5). Tabs: All, Incomplete, Correction requests, Overtime, Refused taps. Status chips, a day picker, a branch filter, search and collapsible branch groups. | `branchFilter`, `refreshKey`, `initialTab` | Card | Attendance pages | `load`, `GroupedAttendanceTable`, `recordColumns` | — |
| (branch list effect) | src/components/portal/attendance/status-board.jsx | Loads branch names for the filter and the headings. | none | Branch map | Board load | `GET /api/admin/branches` | — |
| `load` (status board) | src/components/portal/attendance/status-board.jsx | Loads the period's records, pending correction requests and overtime together. | period | Data | Board load, period change, after dialogs | `GET /api/attendance/logs`, `/api/attendance/corrections?status=pending`, `/api/attendance/overtime` | — |
| `inBranch` | src/components/portal/attendance/status-board.jsx | Filters rows by the chosen branch and the search text. | row | true/false | Filtering | `rowBranchId`, `matchesEmployee` | — |
| (status chip `onClick`) | src/components/portal/attendance/status-board.jsx | Shows only one status (click again to show all). | status | Filter | Clicking a chip such as "Late 4" | — | — |
| `IncompleteActions` | src/components/portal/attendance/status-board.jsx | "Resolve" button for an Incomplete day (or a note if a request is pending). | record | Button | Incomplete tab | `open("resolve")` | — |
| `CorrectionActions` | src/components/portal/attendance/status-board.jsx | "Review" button for a correction request. | request, logs | Button | Correction requests tab | `open("review")` | — |
| `OvertimeDecision` / `OvertimeAction` | src/components/portal/attendance/status-board.jsx | Shows the overtime decision (Waiting, Approved N min, Rejected) / a Review or Change button (locked once payroll is processed). | overtime row | Badge / button | Overtime tab | `open("overtime")` | — |
| `GroupedAttendanceTable` | src/components/portal/attendance/grouped-table.jsx | Attendance table with collapsible branch headings and day headings (counts and status breakdown), 20 rows per page. | columns, rows, grouping | Table | Attendance pages | `dayHeading`, `branchHeading` | "Antipolo Main · Oct 19: 42 employees · 38 On Time · 4 Late". |
| `dayHeading` / `branchHeading` | src/components/portal/attendance/grouped-table.jsx | Build a day heading (with "Today") / a clickable branch heading with counts. | key, branch | Heading row | Display | `statusBreakdown`, `branchLabel` | — |
| `EmployeeSearch` | src/components/portal/attendance/grouped-table.jsx | The employee search box. | value, `onChange` | Input | Attendance pages | — | — |
| `EmployeeCell` | src/components/portal/attendance/grouped-table.jsx | The employee's name (a link to their record) with their ID and type. | row | Cell | Tables | `openEmployee` | — |
| `StatusCell` | src/components/portal/attendance/grouped-table.jsx | The status badge plus a holiday name, "No tap yet", leave details, corrected-by and a "new tap after correction" warning. | row | Cell | Tables | `AttendanceBadge`, `leaveSummary` | — |
| `RecordActions` | src/components/portal/attendance/grouped-table.jsx | "Correct" and "View records" buttons. | row | Buttons | Tables | `open("correct")`, `openEmployee` | — |
| `recordColumns` | src/components/portal/attendance/grouped-table.jsx | The standard columns: Employee, Date, Time in, Time out, Hours, Late, Undertime, Status and Action. | options | Columns | Tables | — | — |
| `Remarks` | src/components/portal/attendance/employee-record.jsx | The remarks column of one employee's record (no tap yet, leave, pending request, corrected by, links to history and taps). | row, name | Cell | Employee record | `open("history")`, `open("taps")` | — |
| `EmployeeAttendanceRecord` | src/components/portal/attendance/employee-record.jsx | One employee's attendance page: profile card (ID, branch, schedule, masked RFID card), a range (this week, this month, last month, custom), a status filter, 7 summary tiles and a month-grouped table. | employee ID, `onBack` | Page | Clicking an employee's name / "View records" | `load`, `apply`, `RecordActions`, `Remarks` | HR reviews Maria Santos's September: 20 present, 1 late, 2 leave days. |
| `load` (employee record) | src/components/portal/attendance/employee-record.jsx | Loads the record for the range. | ID, from, to | Data | Page load, range change, after dialogs | `GET /api/attendance/employee/:id` | — |
| `apply` | src/components/portal/attendance/employee-record.jsx | Checks and applies a custom date range. | from, to | Range | "Apply" | — | — |
| `sum` (employee record) | src/components/portal/attendance/employee-record.jsx | Adds up minutes for the summary tiles. | rows, field | Number | Display | — | — |

### 5.3 Attendance API routes (server)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `rpcFailure` | src/app/api/attendance/corrections/route.js | Turns database refusals into plain messages ("A correction for this record is already waiting for review."). | error | JSON | Failed correction | — | — |
| `branchEmployeeIds` | src/app/api/attendance/corrections/route.js | IDs of the employees in a branch. | client, branch | IDs | Branch checks | `profiles` table | — |
| `GET` (corrections) | src/app/api/attendance/corrections/route.js | Correction requests by status (own only for employees, own branch for Admins). | `status` | Requests | Status board | `attendance_corrections` | — |
| `POST` (corrections) | src/app/api/attendance/corrections/route.js | An employee requests a corrected Time Out for one of their own records (reason of 5–500 characters). | `log_id`, `corrected_time`, `reason` | Request | Employee "Submit request" | database function `attendance_request_correction`; `appendAuditLog` | — |
| `handleResolve` | src/app/api/attendance/corrections/route.js | Resolves an Incomplete record (time out, Absent or Half Day). Not allowed on your own record or another branch's. | `log_id`, `resolution`, `time_out`, `note` | Correction, payroll notice | "Resolve" | database function `attendance_resolve_record`; `correctionPayrollNotice`, `appendAuditLog` | — |
| `handleCorrectAbsence` | src/app/api/attendance/corrections/route.js | Records the real time in and out for a day marked Absent (the employee worked but didn't tap). | employee, date, times, note | Correction | Correct-absence action | database function `attendance_correct_absence` | — |
| `handleCorrectRecord` | src/app/api/attendance/corrections/route.js | Corrects any record (time in, time out, both, or present), keeping the old and new values in the audit log. | log or employee/date, type, times, note | Correction, old/new values | "Save correction" | database function `attendance_correct_record`; `appendAuditLog`, `correctionPayrollNotice` | — |
| `PATCH` (corrections) | src/app/api/attendance/corrections/route.js | Sends the request to resolve, correct-absence or correct-record, or approves or rejects an employee's request (not your own, not another branch's). | `action` or `correction_id`+`decision` | Result | Correction dialogs | database function `attendance_review_correction`; handlers above | — |
| `maskRfid` | src/app/api/attendance/employee/[id]/route.js | Hides most of the card number. | UID | Masked text | Employee record | — | — |
| `GET` (employee record) | src/app/api/attendance/employee/[id]/route.js | One employee's records for up to 400 days: closes the days, then adds the schedule, leave details, correction history, raw taps, after-correction flags and today's placeholder. Branch-limited. | `id`, `from`, `to` | Employee, logs | Employee record page | database function `attendance_close_days`; `profiles`, `branches`, `attendance_logs`, `attendance_corrections`; `getEmployeeAttendancePolicy`, `readApprovedLeave`, `readRawTaps`, `listNotTapped` | — |
| `resolveRange` (overtime) | src/app/api/attendance/overtime/route.js | The from/to dates or a pay period. | URL | Range | Internal | `periodFromLabel`, `periodForDateKey` | — |
| `overtimeMinutes` | src/app/api/attendance/overtime/route.js | Whole minutes worked after the scheduled end of the shift. | record, schedule | Minutes | Overtime list and decision | — | Shift ends 5:00 PM, tapped out 6:40 PM = 100 minutes. |
| `policiesFor` | src/app/api/attendance/overtime/route.js | Loads the branch schedules, using each day's own shift end when known. | client, branches | Lookup function | Internal | `loadAttendanceConfig`, `resolveAttendancePolicy` | — |
| `paidPeriods` | src/app/api/attendance/overtime/route.js | Which employee pay periods are already paid (so their overtime is locked). | client, IDs | Set | Internal | `payroll_entries` | — |
| `GET` (overtime) | src/app/api/attendance/overtime/route.js | Lists days with at least 30 minutes after the shift end, with any decision and a "locked" flag. | `period` or `from`/`to`, `branch_id` | Overtime list | Status board Overtime tab | `attendance_logs`, `attendance_overtime_approvals` | — |
| `PATCH` (overtime) | src/app/api/attendance/overtime/route.js | Approves N minutes (1 up to the maximum) or rejects a day's overtime, unless that pay period is already processed. | `log_id`, `decision`, `approved_minutes`, `note` | Approval | Overtime dialog | `attendance_overtime_approvals` (upsert), `appendAuditLog` | — |
| `yearFrom` / `shape` (holidays) | src/app/api/admin/holidays/route.js | The year asked for (default this year) / a holiday row with type and part-of-day labels. | URL / row | Year / row | Internal | `describeDayPart` | — |
| `writeAccess` | src/app/api/admin/holidays/route.js | Who may change what: the Super Admin all holiday types, HR suspensions only. | guard, action | "all", "suspension" or none | Internal | `can`, `scopeFor` | — |
| `manilaDayOf` / `applyToDay` | src/app/api/admin/holidays/route.js | Manila date of a timestamp / re-mark that day's attendance after a holiday change (past or present days). | date | Date / count | After add or remove | database function `attendance_apply_holiday` | — |
| `GET` (holidays) | src/app/api/admin/holidays/route.js | The next N holidays, or a whole year's holidays, plus what the user may manage. | `upcoming`, `year` | Holidays | Dashboards, Holidays settings | `attendance_holidays` | — |
| `handleGenerate` | src/app/api/admin/holidays/route.js | Super Admin only: fills a year with the holidays fixed by law plus Holy Week. | `year` | Number added | "Generate" in Holidays settings | database function `attendance_seed_holidays`; `appendAuditLog` | Generating all 2027 holidays in one click. |
| `POST` (holidays) | src/app/api/admin/holidays/route.js | Adds a holiday or suspension (HR: suspensions, today or later) after validation, refusing duplicates, then re-marks that day's attendance. | date, name, type, part, cutoff (or `action:"generate"`) | Holiday, re-marked count | "Add holiday" / "Add suspension" | `validateHolidayInput`, `attendance_holidays`, `applyToDay`, `appendAuditLog` | — |
| `DELETE` (holidays) | src/app/api/admin/holidays/route.js | Removes a future holiday or suspension (or one added today for today). Started ones are kept because payroll was judged on them. | `date` | Success | "Remove" | `attendance_holidays`, `applyToDay`, `appendAuditLog` | — |
## 6. Employee Management: server side and rules (used by HR, Admin and Super Admin)

**Where it appears:** behind HR → User Management and Transfer Requests, Admin → Branch Employees, and the Super Admin branch assignment.
**What it does:** creates employee accounts (with an automatic SACS-### Employee ID and a default password), edits, archives and restores them, imports them from CSV, moves employees between branches (immediately or after endorsement), separates employees, and manages licensed-teacher records and AWOL status changes. It also holds the validation rules for every employee field.

### 6.1 Employee account API routes

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `buildEmployeeId` / `parseEmployeeIdNumber` / `generateUniqueEmployeeId` | src/app/api/admin/employees/route.js | Build "SACS-001" / read the number from an ID / pick the next unused SACS-### after the highest one. | count / ID / employees | ID / number | Creating an employee | — | The 142nd hire gets SACS-142. |
| `normalizePositionForRole` | src/app/api/admin/employees/route.js | Position label from the role (Accountant, HR Officer or Employee). | position, role | Label | Create or update | `normalizeRole` | — |
| `toTitleCaseWords` / `normalizeSuffix` / `stripAllowedSuffix` | src/app/api/admin/employees/route.js | Capitalize words / trim a suffix / remove "Jr.", "Sr." and so on before checking a name. | text | Text | Name handling | — | — |
| `buildFullNameFromParts` / `buildNamePartsFromBody` | src/app/api/admin/employees/route.js | Build the full name / the separate name columns from the form. | form body | Name | Create | — | — |
| `isValidEmployeeName` | src/app/api/admin/employees/route.js | Checks the full name contains only allowed characters. | name | true/false | Create or update | `isPersonName` | — |
| `shapeEmployee` (admin) | src/app/api/admin/employees/route.js | The employee record returned to the screens (government IDs masked). | user, profile | Employee | Listing, after saves | `maskedPii` | — |
| `fetchEmployeeBranch` | src/app/api/admin/employees/route.js | The employee's branch (from the profile, with a fallback to the login account). | client, ID | Branch ID | Update / archive | `profiles` | — |
| `fetchEmployees` (admin) | src/app/api/admin/employees/route.js | Lists Employee, Accountant and HR accounts with their profiles, sorted by name. | client | Employees | GET and create | `listUsersCached`, `profiles` | — |
| `GET` (admin employees) | src/app/api/admin/employees/route.js | Employee list limited to the user's branch. | session | Employees | Admin/HR employee lists | `fetchEmployees`, `scopeListToBranch` | — |
| `POST` (create employee) | src/app/api/admin/employees/route.js | Creates an employee. Checks the role and branch limits, validates the record and emergency contact, checks the branch is active, warns about a possible duplicate (same name and birth date), assigns the next SACS-### ID, and creates the login with the default password (LastName + MMDDYYYY + "!") marked "must change". Then saves the profile (retrying on an ID collision) and logs it. | employee form, `confirm_duplicate` | New employee (201) | "Create employee" / each import row | `validateEmployeeRecord`, `validateEmergencyContact`, `findLikelyDuplicates`, `buildDefaultPassword`, `hashTemporaryPassword`, Supabase `createUser`, `profiles`, `branches`, `appendAuditLog` | Adding a new Grade 1 teacher at the Marikina branch. |
| `PATCH` (update / archive / restore) | src/app/api/admin/employees/route.js | Archives, restores or updates an account (name, type, position, salary up to ₱9,999,999.99, status, contact, government IDs, optional new password). It refuses higher roles and other branches, and ends the user's session if their role changed. | `id`, `action`, fields | Employee | "Archive" / "Restore" / admin edits | `syncProfileArchive`, `revokeActiveSession`, Supabase `updateUserById`, `profiles`, `appendAuditLog` | Archiving a teacher who left: she can no longer sign in or tap. |
| `DELETE` (employee) | src/app/api/admin/employees/route.js | A "soft delete": archives the account and sets it Inactive. Nothing is erased. | `id` | Success | Delete action | `getTrustedUserById`, `profiles`, `appendAuditLog` | — |
| `POST` (employee import) | src/app/api/admin/employees/import/route.js | Checks (dry run, up to 500 rows) or creates (up to 20 per batch) employees from CSV rows. It checks the branch (known and active), the record, the emergency contact, emails already used or repeated in the file, and likely duplicates. Creation reuses the normal create route. Logged. | `rows`, `dry_run` | Per-line results | "Check file" / "Import" | `rowToEmployeeBody`, `validateEmployeeRecord`, `findLikelyDuplicates`, `POST /api/admin/employees`, `appendAuditLog` | — |
| `GET` (employee info, read-only) | src/app/api/admin/employee-info/route.js | A read-only employee directory (name, contact, branch, position, status, hire date), limited to the branch. | `limit` | Employees | Read-only employee views | `employee_info_view` | — |
| `fetchBranchMap` / `fetchAllBranchAssignments` | src/app/api/admin/branch-employees/route.js | All branches / every employee's current branch with the assigned date. | client | Maps | Branch assignment list | `branches`, `profiles`, `employee_branch_assignments` | — |
| `GET` (branch employees) | src/app/api/admin/branch-employees/route.js | Active Employees and Accountants with their branch and counts per branch (Admins: own branch plus unassigned). | session | Employees, summary | Transfer Requests, Branch Employees | functions above, `listUsersCached` | — |
| `POST` (assign branch) | src/app/api/admin/branch-employees/route.js | Assigns an account to a branch (the Super Admin assigns branch Admins only; HR and Super Admin accounts are never assigned) and ends that user's session so the new branch applies. | `user_id`, `branch_id` | Success | Branch assignment | `employee_branch_assignments`, `profiles`, `invalidateBranchCache`, `revokeActiveSession`, `appendAuditLog` | The Super Admin assigns a new Admin to the Antipolo branch. |
| `DELETE` (unassign branch) | src/app/api/admin/branch-employees/route.js | Removes an account from its branch and ends its session. | `user_id` | Success | Unassign action | same as above | — |
| `applyBranchMove` | src/app/api/admin/transfer-requests/route.js | Moves the employee to the new branch (only if still in the old one), updates the login account and ends their session. | client, employee, from, to | moved? | Approving or applying a transfer | `profiles`, Supabase `updateUserById`, `revokeActiveSession` | — |
| `GET` (transfer requests) | src/app/api/admin/transfer-requests/route.js | Transfer requests (all for HR; own branch or own requests for Admins), split into pending and history. | session | Requests | Transfer pages | `readAllTransferRequests` | — |
| `POST` (transfer request) | src/app/api/admin/transfer-requests/route.js | Creates a transfer. Refuses archived employees, inactive or same destinations, and a second pending request. HR applies it at once, unless they asked for the branch Admins' endorsement (then the Admins are notified). Logged. | `employee_id`, `to_branch_id`, `remarks`, `wait_for_endorsement` | Request, applied? | "Transfer now" / "Ask for endorsement" / Move many | `insertTransferRequest`, `applyBranchMove`, `updateTransferRequestStatus`, `notify`, `appendAuditLog` | — |
| `PATCH` (transfer request) | src/app/api/admin/transfer-requests/route.js | Approves (refused if the employee's branch changed meanwhile) or rejects a pending transfer, then notifies the endorsing Admins and logs it. | `id`, `action` | Updated request | Approve / Reject in history | `applyBranchMove`, `notifyEndorsers`, `appendAuditLog` | — |

### 6.2 Employee rules and helpers (library)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `normalizeTransferRequest` | src/lib/transfer-requests/store.js | Cleans a transfer row into a standard shape. | row | Request | Reading or saving | — | — |
| `readAllTransferRequests` | src/lib/transfer-requests/store.js | Reads the latest 200 transfers with the employee and branch names. | limit | Requests | Transfer pages | `transfer_requests`, `profiles`, `branches` | — |
| `getEmployeeCurrentBranch` | src/lib/transfer-requests/store.js | The employee's branch now. | ID | Branch ID | Transfers | `profiles` | — |
| `insertTransferRequest` / `updateTransferRequestStatus` | src/lib/transfer-requests/store.js | Save a new transfer / set it approved or rejected with the reviewer. | request / ID, status | Request | Transfers | `transfer_requests` | — |
| `syncProfileArchive` | src/lib/employees/archive.js | Copies an archive or restore onto the profile (with who and when). | client, ID, archived?, actor | Error, or nothing | Archive / restore | `profiles` | — |
| `parseCsv` | src/lib/employees/csv-import.js | Reads a CSV file correctly (quoted fields, commas and line breaks inside quotes, Excel's BOM). | text | Rows | CSV import | — | — |
| `readImportFile` | src/lib/employees/csv-import.js | Turns the CSV into rows keyed by template column, with line numbers, and lists unknown and missing columns. | text | Rows, unknown, missing | Choosing a CSV | `parseCsv` | — |
| `rowToEmployeeBody` | src/lib/employees/csv-import.js | Converts a CSV row into the Add-employee form data, matching the branch by name or ID. | values, branches | Form body, branch | Import | — | — |
| `importTemplateCsv` | src/lib/employees/csv-import.js | The blank CSV template header line. | none | Text | "Download template" | — | — |
| `key` / `findLikelyDuplicates` | src/lib/employees/duplicates.js | Finds existing accounts (archived included) with the same first and last name and the same birth date. | new record, users | Possible duplicates | Create / import | — | Re-hiring a former teacher shows "restore that record instead". |
| `collapseSpaces` / `normalizeEmergencyContact` | src/lib/employees/emergency-contact.js | Clean the emergency contact fields. | form | Contact | Saving accounts | `normalizeDigits` | — |
| `validateEmergencyContact` | src/lib/employees/emergency-contact.js | Checks the emergency contact: name, relationship from the list, address 5–200 characters, mobile 09xxxxxxxxx, different from the employee's own number. | contact, own number | Error, or nothing | Create / save | — | — |
| `isEmpty` / `validateEmergencyContactUpdate` | src/lib/employees/emergency-contact.js | For edits: an all-blank contact is fine only when none is on file yet; one on file can't be removed. | contact, number, has existing | Error, or nothing | Edit forms | `validateEmergencyContact` | — |
| `emergencyContactColumns` | src/lib/employees/emergency-contact.js | The database columns for a contact. | contact | Columns | Saving | — | — |
| `maskLast4` / `maskedPii` | src/lib/employees/pii.js | "••••7890" for each government ID from its last 4 digits. | last 4 / profile | Masked values | Every display of IDs | — | — |
| `fetchProfilesPii` | src/lib/employees/pii.js | Decrypts the full government IDs (only the server may do this). | client, IDs | Map of IDs | HR employee list, payroll, BIR | database function `get_profiles_pii` | — |
| `withoutPiiMetadata` | src/lib/employees/pii.js | Removes government IDs from login-account data (they live encrypted in profiles only). | metadata | Copy | Saving accounts | — | — |
| `pickOption` / `parseIsoDate` / `yearsBetween` | src/lib/employees/record.js | Match a dropdown value / read a date / age in years. | values | Values | Validation | — | — |
| `normalizeEmployeeFields` | src/lib/employees/record.js | Cleans every employee field (names, email lowercased, dropdowns, digits-only IDs). | form body | Record | Create / update / import | `normalizeDigits` | — |
| `isBlank` / `validateEmployeeRecord` | src/lib/employees/record.js | The server's 201-record rules: required fields, name characters, email, age 15+, hire date, salary limit, address, mobile and ID lengths. | record, mode | Error, or nothing | Create / update / import | — | — |
| `validateSeparation` | src/lib/employees/separation-rules.js | Checks a separation: a last day not before the hire date, a reason from the list, and grounds of at least 10 characters for Terminated or Other. | effective, reason, note | Error, or nothing | Separate | — | — |
| `separateEmployee` | src/lib/employees/separation.js | Sets the employee to Separated (logged) and deactivates their active RFID cards. | client, employee, details, guard | Error, or nothing | Separate | `setEmployeeStatus`, `rfid_cards`, database function `rfid_card_set_status` | A resigned teacher's card stops working on her last day. |
| `isStaffIdRole` / `formatStaffId` / `generateUniqueStaffId` | src/lib/employees/staff-id.js | Whether a role gets a STAFF-### ID / "STAFF-007" / the next unused STAFF number. | role / number / IDs | Values | Staff accounts | — | — |
| `fetchStaffIds` / `fetchStaffIdMap` / `assignStaffId` | src/lib/employees/staff-id.js | Read all staff IDs / a map by profile / give a profile a staff ID (retrying on collisions). | client, IDs | IDs / map / ID | Staff accounts | `profiles` | — |
| `pickOption` / `collapseSpaces` / `capitalizeWords` / `normalizeSuffix` | src/lib/employees/staff-record.js | Clean staff form values ("dela cruz" becomes "Dela Cruz"; "jr" becomes "Jr."). | text | Text | Staff forms | — | — |
| `composeFullName` / `splitFullName` / `normalizeNameParts` | src/lib/employees/staff-record.js | Join name parts / split a full name (surname particles like "dela" and "de los" handled) / clean name parts from a form. | name or parts | Name / parts | Profile and staff saves | — | "Juan Dela Cruz" splits into first "Juan", last "Dela Cruz". |
| `validateNameParts` / `validateStaffEmail` | src/lib/employees/staff-record.js | Check first/middle/last/suffix / check a staff email. | parts / email | Error, or nothing | Profile and staff saves | — | — |
| `normalizeStaffFields` / `parseDate` / `yearsBetween` / `validateStaffRecord` | src/lib/employees/staff-record.js | Clean and validate a Super Admin / Admin / HR account: required fields, role, branch for Admins, email, age 18+, hire date, mobile, address. | form | Record / error | Add Staff Account | — | — |
| `daysBetween` / `licenseStatus` | src/lib/employees/teacher-license.js | A licensed teacher's status: Not licensed, Pending verification, Eligible, Expiring (within the warning days) or Expired. | profile, today, warning days | Status, tone, days left, eligible | License displays | — | "Expiring in 45 days". |
| `maskedLicense` / `validateLicenseChange` | src/lib/employees/teacher-license.js | "••••3456" / checks a license change (reason; PRC number of 4–20 characters; expiry after today). | values | Text / error | License saves | — | — |
| `canTransition` / `addDays` / `isDateKey` | src/lib/awol/cases.js | Whether an AWOL step is allowed from the current stage / add days to a date / date format check. | action, stage / date | Values | AWOL steps | `TRANSITIONS` | — |
| `setEmployeeStatus` | src/lib/awol/cases.js | Changes an employee's status (Active, AWOL, Separated) in the profile and login account, and records the change with the reason. Pay hold follows the status automatically. | client, employee, status, reason, case, date, actor | Error, or nothing | AWOL steps, separation | `profiles`, `employee_status_changes`, Supabase `updateUserById` | — |
| `shapeCase` | src/lib/awol/cases.js | An AWOL case with the employee's name, ID, stage and outcome labels. | row, person | Case | AWOL list | — | — |

### 6.3 Licensed teacher panels

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `readFile` | src/components/portal/license-section.jsx | Reads the uploaded PRC ID file. | file | Data | Choosing a file | `FileReader` | — |
| `LicenseSection` | src/components/portal/license-section.jsx | The "Licensed teacher" switch inside HR's Edit Employee: PRC number (masked), expiry, ID file, verification, change history. Every change needs a reason. | employee ID | Section | Edit Employee (Teaching staff) | `load`, `send`, `saveDetails`, `ask`, `confirmPending`, `openDocument` | — |
| `load` / `reset` (license) | src/components/portal/license-section.jsx | Load the license / open or close the edit fields. | none / open? | none | Section load, buttons | `GET /api/hr/teacher-license?employee_id=` | — |
| `pickFile` | src/components/portal/license-section.jsx | Accepts a PDF, PNG or JPEG PRC ID up to 2 MB. | file | Form update | Choosing a file | `readFile` | — |
| `send` | src/components/portal/license-section.jsx | Saves a license action (turn on, update, verify or turn off) and explains when the subsidy starts or stops. | action, details | Pop-up | Save / Verify / Confirm | `POST /api/hr/teacher-license` | HR verifies the license on Oct 10, so the subsidy counts from October. |
| `saveDetails` | src/components/portal/license-section.jsx | Checks and saves new or changed license details (saving clears verification). | form | Save | "Save license" | `send` | — |
| `ask` / `confirmPending` | src/components/portal/license-section.jsx | Ask for a reason before verifying or turning off / then save. | action | Save | "Verify license" / switch off | `send` | — |
| `openDocument` | src/components/portal/license-section.jsx | Opens the uploaded PRC ID (HR only). | none | Viewer | "View" | `GET /api/hr/teacher-license?document_id=`, `useProofViewer` | — |
| `LicensedTeachersCard` | src/components/portal/licensed-teachers-card.jsx | Read-only list of licensed teachers (masked number, expiry, verifier, status) for Admin (own branch) and Super Admin. | `refreshKey` | Card | Admin / Super Admin pages | `GET /api/hr/teacher-license` | — |
## 7. Work Schedules and the Early Bird Incentive (HR, Super Admin, Admin view-only)

**Where it appears:** HR → Work Schedules, Super Admin → System Configuration → Attendance, and Admin (read-only for their branch).
**What it does:** creates named shift schedules (for example "Pre-school Teacher, 7:30–12:00"), each with a late grace period, required hours and working days, and assigns them to individual employees or to a whole level (Pre-school, Grade School and so on). Every change takes effect from a chosen date and is logged. It also sets the **Early Bird incentive**: one winner per pay period, the employee with the most time-ins at least N minutes before their own start time.

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `time12` / `shift` | src/components/portal/work-schedules.jsx | "13:30" becomes "1:30 PM" / "7:30 AM – 12:00 PM". | time / schedule | Text | Display | — | — |
| `WorkSchedulesPanel` | src/components/portal/work-schedules.jsx | The Work Schedules screen: schedule list (Edit/Delete), level schedules (Assign), and employees grouped by branch and level with the schedule each follows today. Tick boxes allow bulk "Assign schedule" and "Set level". | `refreshKey` | Panel | HR → Work Schedules / Super Admin config | `load`, `open`, `save`, `BranchLevelGroups` | HR gives all Grade School teachers a 7:00–4:00 schedule from Nov 3. |
| `load` (schedules) | src/components/portal/work-schedules.jsx | Loads the schedules, level assignments and employees. | none | Data | Page load, Refresh | `GET /api/admin/work-schedules` | — |
| `open` (schedules) | src/components/portal/work-schedules.jsx | Opens the dialog for a new or edited schedule, a deletion, a level assignment, an employee assignment or a level change. | kind, values | Dialog | Buttons | — | — |
| `submit` / `save` (schedules) | src/components/portal/work-schedules.jsx | Sends the right action (save_schedule, delete_schedule, assign to a level or employees, set_level) and reloads. | dialog values | Pop-up "Work Schedules" | Dialog "Save" / "Delete" | `POST /api/admin/work-schedules` | — |
| (working-day checkbox `onCheckedChange`) | src/components/portal/work-schedules.jsx | Adds or removes a weekday from the schedule. | day | Updated days | Ticking Mon–Sun | — | Adding Saturday for a weekend-class schedule. |
| `isMissing` / `addDays` | src/app/api/admin/work-schedules/route.js | Detects a missing database table / adds days to a date. | error / date | Values | Internal | — | — |
| `checkEffectiveDate` | src/app/api/admin/work-schedules/route.js | The effective date must be today or later (the past is never recalculated) and within a year. | date | Date, or an error | Every change | `manilaDateKey` | — |
| `byNewest` / `inForce` / `shortTime` / `shapeVersion` | src/app/api/admin/work-schedules/route.js | Sort newest first / the version in force on a date / "HH:MM" / one schedule version for display. | rows, date | Values | Internal | `describeWorkingDays` | — |
| `loadData` | src/app/api/admin/work-schedules/route.js | Reads every schedule version and assignment. | client | Versions, assignments | GET and POST | `work_schedules`, `work_schedule_assignments` | — |
| `buildProfiles` | src/app/api/admin/work-schedules/route.js | Builds each schedule with its current version, upcoming changes and history. | versions, today | Profiles | GET, save | `inForce` | — |
| `assignmentState` | src/app/api/admin/work-schedules/route.js | Current, upcoming and past assignments for one employee or level. | rows, today | State | GET | `inForce` | — |
| `loadEmployees` (schedules) | src/app/api/admin/work-schedules/route.js | Active paid staff (own branch for Admins). | client, guard | Employees | GET | `profiles` | — |
| `GET` (work schedules) | src/app/api/admin/work-schedules/route.js | Schedules, level assignments and, for each employee, the schedule they follow today (own → level → branch → default). | session | Data | Panel load | functions above, `loadAttendanceConfig`, `resolveAttendancePolicy` | — |
| `byWhom` / `audit` | src/app/api/admin/work-schedules/route.js | "by Maria Santos (HR)" / writes the schedule change to the audit log. | guard, details | none | Every change | `appendAuditLog` | — |
| `saveSchedule` | src/app/api/admin/work-schedules/route.js | Creates a schedule, or adds a new version from the effective date. Validates it and refuses duplicate names. | schedule form | Schedule | "Save" | `validateScheduleInput`, `work_schedules`, `audit` | — |
| `archiveSchedule` | src/app/api/admin/work-schedules/route.js | Deletes a schedule from a date (kept as history), refused while anyone still uses it. | key, date, note | Success | "Delete" | `work_schedules`, `audit` | — |
| `assign` | src/app/api/admin/work-schedules/route.js | Assigns a schedule (or the fallback) to a level, or to up to 500 employees, from a date. | target, schedule, date, note | Success | "Assign" dialogs | `work_schedule_assignments`, `audit` | — |
| `setLevel` | src/app/api/admin/work-schedules/route.js | Sets the level of up to 500 employees. | IDs, level | Success | "Set level" | `profiles`, `forEachInChunk`, `audit` | — |
| `POST` (work schedules) | src/app/api/admin/work-schedules/route.js | Sends each action to the right handler. | `action` | Result | Any schedule save | handlers above | — |
| `latestEarly` / `offsetLabel` | src/components/portal/early-bird-card.jsx | The latest "early" time for an 8:00 start ("7:45 AM") / "12 min early". | minutes | Text | Display | — | — |
| `EarlyBirdCard` | src/components/portal/early-bird-card.jsx | Early Bird settings (threshold minutes, amount, whether unexcused absences disqualify) and the winners of recent periods. | `refreshKey` | Card | HR → Work Schedules / Super Admin config | `load`, `save` | — |
| `load` / `save` (early bird) | src/components/portal/early-bird-card.jsx | Load the settings and winners / save new settings after confirmation. | form | Pop-up | Card load / "Save" | `GET`/`PATCH /api/admin/early-bird` | Setting a ₱500 Early Bird prize. |
| `permissions` (early bird) | src/app/api/admin/early-bird/route.js | Whether the user may change the settings and the amount. | guard | Flags | Internal | `can` | — |
| `GET` (early bird) | src/app/api/admin/early-bird/route.js | Settings and the last 24 winners (another branch's winner is shown without a name). | session | Settings, winners | Card load | `early_bird_winners`, `loadEarlyBirdSettings` | — |
| `PATCH` (early bird) | src/app/api/admin/early-bird/route.js | Saves the amount (₱0–₱1,000,000; 0 turns it off), the threshold (1–120 minutes) and the absence rule, with an audit entry showing before and after. | settings | New settings | "Save" | `system_config`, `appendAuditLog` | — |
| `parseEarlyBirdSettings` / `loadEarlyBirdSettings` | src/lib/payroll/early-bird.js | Read and clean the Early Bird settings. | rows | Settings | Payroll, card | `system_config` | — |
| `manilaMinutes` / `arrivalOffset` / `isEarlyTimeIn` | src/lib/payroll/early-bird.js | Time of day in minutes / how early or late a time-in was against the person's own start / whether it counts as early. | time, row | Values | Winner computation | — | Arriving 7:40 for an 8:00 start = −20 minutes, which counts as early with a 15-minute threshold. |
| `earlyBirdStats` | src/lib/payroll/early-bird.js | Per employee for a window: number of early time-ins, average arrival offset, late days and absences. | attendance rows, threshold, dates | Stats | Winner computation | `normalizeAttendanceStatus` | — |
| `compareNullable` / `pickEarlyBirdWinner` | src/lib/payroll/early-bird.js | Ranks the candidates: most early time-ins, then the earliest average, then the fewest lates, then the fewest absences (optionally excluding anyone with an unexcused absence). | candidates | Winner, ranking | Winner computation | — | — |
| `isMissing` / `loadCandidates` | src/lib/payroll/early-bird.js | Missing table check / everyone who can win (paid, active, pay not on hold). | client | Candidates | Winner computation | `profiles` | — |
| `readEarlyBirdWinner` / `shapeWinner` | src/lib/payroll/early-bird.js | Read a period's stored winner / shape it for payroll and screens. | client, period / row | Winner | Payroll, approval | `early_bird_winners` | — |
| `resolveEarlyBirdWinner` | src/lib/payroll/early-bird.js | The period's winner: the stored one if locked, otherwise computed from the attendance window and saved (top 5 ranking kept). | client, period, window, actor | Winner | Payroll generation | `early_bird_winners`, `attendance_logs` | — |
| `earlyBirdLine` | src/lib/payroll/early-bird.js | The winner's payslip line ("Early Bird Incentive: 9 early time-ins…"). | winner | Incentive line | Building the winner's payslip | `roundPeso` | — |
## 8. Tenure Pay Protection (HR, Admin, Super Admin)

**Where it appears:** HR → Tenure Pay Protection (the same panel appears for Admin and the Super Admin).
**What it does:** some long-serving employees have a contract clause saying their pay is not deducted for absences, lateness, holidays, suspensions or school breaks (summer and Christmas). This page sets the policy (minimum tenure, default 2 years, and which categories are covered), system-wide or per branch. It also sets the school break dates and lets HR **grant** or **revoke** the protection per employee from a date. Payroll then waives the covered deductions.

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `years` / `coveredLabel` | src/components/portal/tenure-protection.jsx | "2 yrs" / the list of covered categories in words. | number / policy | Text | Display | — | "Absence, Late, Summer break". |
| `PolicyFields` | src/components/portal/tenure-protection.jsx | The policy form: switched on/off, minimum tenure, and a switch per category. | value, `onChange` | Form fields | Policy cards and dialog | — | — |
| `policyForm` | src/components/portal/tenure-protection.jsx | Turns a saved policy into form values. | policy | Form | Editing | — | — |
| `TenureProtectionPanel` | src/components/portal/tenure-protection.jsx | The whole page: system-wide policy, per-branch policies, school breaks per school year, an employee table (All, Meets tenure, Granted, and a branch filter) with Grant/Revoke, and the grant history. | `refreshKey` | Panel | Sidebar → Tenure Pay Protection | `load`, `post`, `open`, `submitDialog` | — |
| `load` (tenure) | src/components/portal/tenure-protection.jsx | Loads policies, breaks, employees and grants. | none | Data | Page load | `GET /api/hr/tenure-protection` | — |
| (break forms effect) | src/components/portal/tenure-protection.jsx | Fills the summer and Christmas break forms for the chosen school year. | data, school year | Form values | School year change | — | — |
| `post` (tenure) | src/components/portal/tenure-protection.jsx | Sends one change and shows a success message or a warning (for example, "policy switched off"). | body, message, place | true/false | Every save | `POST /api/hr/tenure-protection` | — |
| `policyBody` / `open` / `submitDialog` | src/components/portal/tenure-protection.jsx | Builds the policy data / opens the grant, revoke or branch-policy dialog / saves it. | values | Save | Grant / Revoke / Customize / Edit buttons | `post` | HR grants protection to a 12-year veteran teacher from Nov 1. |
| (employees / counts memos) | src/components/portal/tenure-protection.jsx | Filters the employee table by tab and branch, and counts each tab. | data, tab, branch | Rows, counts | Tab and filter changes | — | — |
| `statusOf` | src/components/portal/tenure-protection.jsx | Badge: Protected, Granted from date, Granted with the policy off, Granted below tenure, Eligible not granted, or Not eligible. | employee | Badge | Table | — | — |
| (system policy Save / branch Follow-system / break Save / break Remove `onClick`) | src/components/portal/tenure-protection.jsx | Save the system-wide policy, set a branch back to the system policy, save a break period, or remove one. | form | Save | Buttons | `post` with `save_policy` / `save_break` / `archive_break` | Setting summer break as Apr 6 – Jun 5, 2027. |
| `addDays` / `checkFutureDate` | src/app/api/hr/tenure-protection/route.js | Add days / a date must be today or later and within a year (past payroll is never recalculated). | date | Date, or an error | Grant and revoke | — | — |
| `byWhom` / `audit` (tenure) | src/app/api/hr/tenure-protection/route.js | Who made the change / write it to the audit log. | guard, details | none | Every change | `appendAuditLog` | — |
| `loadBranches` / `loadEmployees` / `loadApplications` | src/app/api/hr/tenure-protection/route.js | Branches in reach / paid employees in reach / how often each grant was actually applied in payroll. | client, guard | Lists | GET | `branches`, `profiles`, `tenure_protection_applications` | — |
| `shapeGrant` / `shapeBreak` | src/app/api/hr/tenure-protection/route.js | A grant (with names and how much was waived) / a break period for display. | row | Object | GET | — | — |
| `GET` (tenure) | src/app/api/hr/tenure-protection/route.js | Everything the page shows: school years, categories, policies (system and per branch), breaks, each employee's tenure, eligibility date and protection status, and the grants. | session | Data | Page load | `loadTenureProtection`, `policyFor`, `meetsTenure`, `eligibleFrom`, `tenureYears`, `grantOn`, `openGrant` | — |
| `refuseSystemWide` | src/app/api/hr/tenure-protection/route.js | Only HR or the Super Admin may change the system-wide policy and the break dates. | guard | Refusal, or nothing | Policy or break save | — | — |
| `savePolicy` | src/app/api/hr/tenure-protection/route.js | Saves the system-wide policy or a branch's own policy (or sets the branch back to following the system one). An Admin can change only their own branch. | branch, policy | Policy | Policy saves | `validatePolicyInput`, `tenure_protection_policies`, `audit` | — |
| `saveBreak` / `archiveBreak` | src/app/api/hr/tenure-protection/route.js | Saves a school break (no overlaps, inside the school year) / removes one. | school year, kind, dates | Break | Break buttons | `validateBreakInput`, `breaksOverlap`, `school_break_periods`, `audit` | — |
| `scopedEmployee` | src/app/api/hr/tenure-protection/route.js | Finds a paid employee the user may manage. | client, guard, ID | Employee, or an error | Grant / revoke | `profiles` | — |
| `grant` | src/app/api/hr/tenure-protection/route.js | Grants protection from a date. It needs a hire date, the minimum tenure on that date, and no open grant. It warns if the branch policy is switched off. | employee, date, notes | Grant | Grant dialog | `meetsTenure`, `tenure_protection_grants`, `audit` | — |
| `revoke` | src/app/api/hr/tenure-protection/route.js | Ends a grant from a date. Payroll already worked out keeps the protection. | grant, date, notes | End date | Revoke dialog | `tenure_protection_grants`, `audit` | — |
| `POST` (tenure) | src/app/api/hr/tenure-protection/route.js | Sends each action (save_policy, save_break, archive_break, grant, revoke) to its handler. | `action` | Result | Every save | handlers above | — |
| `addMonths` / `daysBetween` / `tenureMonths` | src/lib/payroll/tenure-protection.js | Add months to a date (end-of-month safe) / days between dates / tenure in months. | values | Values | Internal | — | Feb 29, 2024 + 12 months = Feb 28, 2025. |
| `eligibleFrom` / `meetsTenure` / `tenureYears` | src/lib/payroll/tenure-protection.js | The first day with enough service / whether the employee has it on a date / years of service with one decimal. | hire date, date, years | Date / true-false / number | Page and payroll | `addMonths` | Hired 2024-06-01 with a 2-year rule: eligible from 2026-06-01. |
| `schoolYearOf` / `schoolYearSpan` / `schoolYearOptions` | src/lib/payroll/tenure-protection.js | The school year of a date (June start) / the dates its breaks may fall on / last, current and next school years. | date / school year | Values | Breaks | — | Oct 14, 2026 is in SY 2026-2027. |
| `shapePolicy` / `policyFor` | src/lib/payroll/tenure-protection.js | A policy as payroll uses it / the policy in force for a branch (own → system → defaults). | row / policies, branch | Policy | Page and payroll | — | — |
| `validatePolicyInput` / `validateBreakInput` | src/lib/payroll/tenure-protection.js | Check a policy (0–50 years) / a break (a known school year and kind, at most 120 days, inside the school year). | form | Clean value, or an error | Saves | — | — |
| `breakKindOn` / `breaksOverlap` | src/lib/payroll/tenure-protection.js | Which break a date falls in / whether two breaks share a day. | breaks, date | Kind / true-false | Payroll, saves | — | — |
| `grantOn` / `openGrant` | src/lib/payroll/tenure-protection.js | The grant in force on a date / the employee's open (not revoked) grant. | grants, employee, date | Grant | Page and payroll | — | — |
| `categoryFor` | src/lib/payroll/tenure-protection.js | Which category a deduction falls under (break, suspension, holiday, absence or late). | day info, type | Category | Payroll | — | — |
| `buildProtection` | src/lib/payroll/tenure-protection.js | Gives payroll a "is this deduction waived?" check for one employee and day. | employee, policies, grants, breaks, holiday lookup | Function, or nothing | Payroll computation | `grantOn`, `meetsTenure`, `categoryFor`, `breakKindOn` | A protected teacher absent on Oct 7 has no absence deduction. |
| `isMissingTable` / `loadTenureProtection` | src/lib/payroll/tenure-protection-store.js | Missing-table check / read the policies, grants (optionally for some employees) and breaks. | client, IDs | Data | Page and payroll | `tenure_protection_policies`, `tenure_protection_grants`, `school_break_periods` | — |
## 9. Accountant Portal: Payroll (Process Payroll, Records, Payslips, Loans, Incentives, Cash Advances, 13th Month, Subsidies, Final Pay, Monitoring, Reports)

**Web address:** `/accountant`
**Who uses it:** The school Accountant, limited to their branch.
**What the pages do:**
- **Dashboard:** this period's gross, deductions and net chart, a payslip status donut and recent activity.
- **Process Payroll:** the batch table, with every employee's computed basic, SSS, PhilHealth, Pag-IBIG, tax, absences, lates, undertime, half days, incentives, leave and net pay. Includes Generate (draft or final) per employee, "Process payroll for all", a single-entry form with a live computation summary, and "Submit for HR Approval" per branch.
- **Payroll Records / Payslips (Pay Record) / Payroll Monitoring:** history, printable payslips with PDF download, drafts to edit or withdraw, and post-approval corrections.
- **Loans, Incentives & Overload, Cash Advances, 13th Month Pay, Subsidies, Final Pay:** the extra pay items and deductions.
- **View Attendance:** read-only per-employee counts for the period, plus the branch Admins' overtime confirmations.
- **Payroll Reports:** summary, deductions, the school payroll sheet and holiday work, with BIR 2316 and the 1604-C alphalist.

### 9.1 Portal shell and shared payroll data

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `AccountantLayout` / `AccountantPage` | src/app/accountant/layout.js, page.js | Frame and entry of the Accountant portal. | `children` | Portal | Opening `/accountant` | `PortalLayout`, `AccountantPortal` | — |
| `AccountantPortal` | src/app/accountant/accountant-portal.jsx | Wraps the pages in the accountant session, the shared payroll data and the attendance dialogs. | none | Portal | Page load | `PortalSessionProvider`, `AccountantDataProvider` | — |
| `AccountantScreens` | src/app/accountant/accountant-portal.jsx | Picks the current page (permission-checked) and handles Refresh. | none | Page | Navigation | `usePersistedPage` | — |
| `Screens` | src/app/accountant/accountant-portal.jsx | Builds the sidebar and bell summary (saved drafts, current period) and shows the chosen page. | current page, navigate | Page | Navigation | `AppShell`, `useAccountant` | — |
| `RefreshBridge` | src/app/accountant/accountant-portal.jsx | Makes the top-bar Refresh also reload the shared payroll data. | `refreshKey` | none | Refresh | `useAccountant().load` | — |
| `useAccountant` | src/app/accountant/accountant-data.jsx | Gives every Accountant page the shared payroll data and actions. | none | Data and actions | Pages | — | — |
| `periodFromUrl` / `keepPeriodInUrl` | src/app/accountant/accountant-data.jsx | Remember the chosen pay period in the address. | period | Text / none | Load, period change | browser history | — |
| `historyFromUrl` / `keepHistoryInUrl` / `historyLabel` | src/app/accountant/accountant-data.jsx | Remember the history window (last 12 months or a year) / its label. | value | Text | History filter | — | — |
| `HistorySelect` | src/app/accountant/accountant-data.jsx | Dropdown: "Last 12 months" or a year. | none | Dropdown | Records, Monitoring, Reports | `useAccountant` | — |
| `AccountantDataProvider` | src/app/accountant/accountant-data.jsx | Loads all payroll data in one call and provides `setPeriod`, `setHistory`, `openPayslip` and `editDraft`. | `navigate` | Context | Portal load | `load` | — |
| `load` (accountant data) | src/app/accountant/accountant-data.jsx | Loads employees, records, drafts, attendance and leave summaries, the generation window, runs and the payslip for a period (ignoring outdated replies). | period, entry ID | Data | Page load, period change, after saves | `GET /api/accountant/payroll` | — |
| `chooseEntry` / `setPeriod` / `setHistory` / `openPayslip` / `editDraft` | src/app/accountant/accountant-data.jsx | Choose an entry / change the period / change the history window / open a payslip on Pay Record / edit a draft in Process Payroll. | ID / period | Navigation and reload | Buttons across pages | `load` | — |

### 9.2 Process Payroll

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `openIncompleteQueue` | src/app/accountant/process-page.jsx | Opens View Attendance on its Incomplete tab. | navigate | Page change | "View in attendance →" | `sessionStorage` | — |
| `clampSalary` | src/app/accountant/process-page.jsx | Keeps a typed salary to 7 digits and the ₱9,999,999.99 maximum. | text | Text | Typing the basic salary | — | — |
| `Banners` | src/app/accountant/process-page.jsx | Notices: payroll not ready, the generation window (when Generate opens, the pay date), employees whose pay is on hold, and how this half is settled (1st half, 2nd half, per-cutoff). | data | Alerts | Page load | — | "2nd half settles October: attendance Oct 16–Oct 30…" |
| `EarlyBirdBanner` | src/app/accountant/process-page.jsx | Shows the period's Early Bird winner and prize, or that no one qualifies yet. | early-bird data | Alert | Page load | — | — |
| `PayslipCell` | src/app/accountant/process-page.jsx | Per employee: Generate / Regenerate / Generate final, View, Reprocess (when HR rejected the run), or "locked" while the run is with HR. | data, employee | Buttons | Batch table | `onGenerate`, `onView` | — |
| `BatchCard` | src/app/accountant/process-page.jsx | The batch table for all employees, with editable SSS, PhilHealth, Pag-IBIG, tax and leave-without-pay (changes highlighted and needing a reason), each row's net, rows blocked by unresolved attendance, and "Process payroll for all". | navigate | Card | Process Payroll page | `batchRowBase`, `batchTaxDefault`, `batchRowNet`, `processAll`, `generate` | — |
| `setField` | src/app/accountant/process-page.jsx | Stores an edited cell. | employee, field, value | none | Typing in a cell | — | — |
| `processAll` | src/app/accountant/process-page.jsx | Processes Final payslips for every unblocked employee, after a reason for changed values and a confirmation. Reports which were skipped. | table values, reason | Pop-up "Batch Payroll Processed" | "Process payroll for all →" | `POST /api/accountant/payroll {action:"batch_submit"}` | Processing all 48 Antipolo employees for Oct 16–31. |
| `generate` (payslip) | src/app/accountant/process-page.jsx | Generates one employee's Draft (during the period) or Final payslip (after), or reprocesses a Final one. Asks before leaving out unresolved days. | employee, flags | Pop-up "Final/Draft Payslip Generated" | Generate / Reprocess buttons | `PATCH /api/accountant/payroll {action:"generate"}` | — |
| `amountLine` / `numberInput` | src/app/accountant/process-page.jsx | Small builders for a count with its peso amount / an editable number cell. | values | Elements | Batch table | — | — |
| `SummaryRow` | src/app/accountant/process-page.jsx | One line of the computation summary. | label, value | Row | Single entry | — | — |
| `SingleEntry` | src/app/accountant/process-page.jsx | The payroll entry form for one employee (or a saved draft): basic, contributions, tax, attendance counts, leave and perfect attendance, with a live summary (gross, deductions, incentives, net). Deviations need a reason. | navigate | Card | Process Payroll page | `computeSummary`, `formDeviations`, `submit` | — |
| `set` / `dates` / `contributionHint` (single entry) | src/app/accountant/process-page.jsx | Update a field / list dates / explain where a contribution comes from. | values | Values | Form | — | — |
| `submit` (single entry) | src/app/accountant/process-page.jsx | Processes the payroll (Final payslip) or saves it as a draft. | action | Pop-up | "Process payroll" / "Save as draft" | `POST /api/accountant/payroll {action:"submit"/"save_draft"}`, `submissionPayload` | — |
| `numberField` | src/app/accountant/process-page.jsx | Labelled number box builder. | id, label, key | Field | Form | — | — |
| `ProcessPage` | src/app/accountant/process-page.jsx | Puts the batch table and the single-entry form together. | navigate | Page | Sidebar → Process Payroll | `BatchCard`, `SingleEntry` | — |
| `RunApprovalPanel` | src/app/accountant/run-approval-panel.jsx | Each branch's payroll run for the period: status, counts, net, HR's rejection reason, and "Submit (or Resubmit) for HR Approval". | none | Card | Process Payroll page | `load`, `submit` | — |
| `load` / `submit` (run panel) | src/app/accountant/run-approval-panel.jsx | Load the runs / submit a branch's run after confirmation (it locks until HR decides). | period / run | Pop-up "Submitted for HR Approval" | Page load / Submit button | `GET`/`PATCH /api/accountant/payroll-runs` | — |
| `useLivePayrollRuns` | src/components/portal/use-live-payroll-runs.js | Reacts to run changes live (an event stream from the server), plus a check every minute and on window focus. | callback | none | Payroll Approval pages | `EventSource /api/hr/payroll-runs/stream` | — |
| `usePendingRunCount` | src/components/portal/use-live-payroll-runs.js | Keeps HR's "runs waiting" sidebar badge up to date. | enabled | Count | HR portal | `GET /api/hr/payroll-runs?count=1` | HR's sidebar shows "Payroll Approval (2)". |

### 9.3 Dashboard, Records, Pay Record, Monitoring, Attendance

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `bucket` | src/app/accountant/dashboard-page.jsx | Groups a record's status (Paid, Not submitted, Pending HR, Rejected) for the donut. | record | Key | Dashboard | `recordStatusMeta` | — |
| `DashboardPage` (accountant) | src/app/accountant/dashboard-page.jsx | Period totals bar chart, status donut, paid count and the 5 latest records. | `refreshKey`, `onNavigate` | Page | Sidebar → Dashboard | `useAccountant` | — |
| `RecordsPage` | src/app/accountant/records-page.jsx | All processed records (last 12 months or a year) with totals, a Payslip button and Correct (for approved payslips), plus the corrections list. | none | Page | Sidebar → Payroll Records | `CorrectionDialog`, `CorrectionsCard` | — |
| `portalPosition` | src/app/accountant/pay-record-page.jsx | "Accountant" or "Employee" for the payslip header. | position, role | Text | Payslip | — | — |
| `Row` / `Section` / `HolidayLines` | src/app/accountant/pay-record-page.jsx | Payslip building blocks: a line, a titled section, holiday lines. | values | Elements | Payslip | — | — |
| `Cutoff` / `SemiMonthly` / `Classic` | src/app/accountant/pay-record-page.jsx | The three payslip layouts: per-cutoff, semi-monthly (1st or 2nd half) and the original detailed one. | payslip | Payslip body | Payslip display | `money` | — |
| `PayslipDocument` | src/app/accountant/pay-record-page.jsx | The printable payslip (school header, employee, period, number, lines, net pay). Also shown read-only on HR's Payroll Records. | payslip | Payslip | Pay Record, HR records | layouts above | — |
| `PayRecordPage` | src/app/accountant/pay-record-page.jsx | Choose a processed payslip, then Generate, Print or Download PDF. | none | Page | Sidebar → Payslips | `downloadPdf`, `PayslipDocument` | The Accountant prints a teacher's payslip for signing. |
| `downloadPdf` (pay record) | src/app/accountant/pay-record-page.jsx | Downloads the payslip PDF. | entry ID | PDF | "Download PDF" | `GET /api/accountant/payroll?format=pdf` | — |
| `MonitoringPage` | src/app/accountant/monitoring-page.jsx | Records and drafts together, with status tabs, Edit and Cancel for drafts, and Payslip for processed ones. | none | Page | Sidebar → Payroll Monitoring | `cancelDraft`, `editDraft` | — |
| `cancelDraft` | src/app/accountant/monitoring-page.jsx | Withdraws a draft after confirmation. | entry ID | Pop-up "Draft Withdrawn" | "Cancel" | `PATCH /api/accountant/payroll {action:"cancel_draft"}` | — |
| `AttendancePage` (accountant) | src/app/accountant/attendance-page.jsx | Read-only attendance for payroll (present, late, absent, deduction days), the status board, and the Admins' overtime confirmations. | `refreshKey` | Page | Sidebar → View Attendance | `AttendanceStatusBoard` | — |

### 9.4 Payroll corrections, Reports, Incentives, Cash Advances, Loans, 13th Month, Final Pay, Subsidies

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `CorrectionDialog` / `save` | src/components/portal/payroll-corrections.jsx | The Accountant files a correction on an approved payslip (an extra payment or a deduction, optionally spread over several payrolls, with a reason), or fixes and resubmits a rejected one. | record or correction | Sent to HR | "Correct" / "Fix & resubmit" | `POST`/`PATCH /api/payroll/corrections` | Paying back ₱550 of a wrongly deducted absence on the next payslip. |
| `DecideDialog` / `decide` | src/components/portal/payroll-corrections.jsx | HR approves or rejects a pending correction (with a note). | correction, action | Saved | Approve / Reject | `PATCH /api/payroll/corrections` | — |
| `HistoryDialog` (corrections) | src/components/portal/payroll-corrections.jsx | Shows a correction's history. | row | Dialog | History icon | — | — |
| `CorrectionsCard` / `load` | src/components/portal/payroll-corrections.jsx | The corrections list (the Accountant's branch, or every branch for HR) with the right buttons per role. | `refreshKey` | Card | Records pages, HR approval | `GET /api/payroll/corrections` | — |
| `downloadQuotedCsv` / `sheetMoney` / `sheetNumber` | src/app/accountant/reports-page.jsx | Formula-safe quoted CSV download / money and number formats for the sheet ("-" for zero). | rows / value | File / text | Exports | — | — |
| `PayrollSheet` | src/app/accountant/reports-page.jsx | Lays out the school's payroll sheet: one table per branch with days, hours, rate, OT, other pay, cash advance, SSS, PhilHealth, Pag-IBIG, tax, late/undertime and net, plus totals. | sheet data | Table | Report type "Payroll sheet" | — | — |
| `ReportsPage` (accountant) | src/app/accountant/reports-page.jsx | Choose a report (Summary, Deductions, Payroll sheet, Holiday work), a period and a branch, then Generate, Export CSV or Print. Includes the BIR forms card. | none | Page | Sidebar → Payroll Reports | `generate`, `exportCsv`, `BirFormsCard` | — |
| `generate` / `exportCsv` (accountant reports) | src/app/accountant/reports-page.jsx | Build the chosen report (summary and deductions from the loaded records; sheet and holiday work from the server) / export it to CSV. | type, period, branch | Report / CSV | "Generate" / "Export CSV" | `GET /api/accountant/payroll?view=payroll_sheet|holiday_work` | The month-end payroll sheet for the principal's signature. |
| `HowItWorks` / `monthLabel` | src/app/accountant/incentives-page.jsx | An explanation box / "October 2026" from "2026-10". | rows / key | Element / text | Display | — | — |
| `deferredPayrollMonth` / `DeferredBadge` / `DeferredIncentivesNotice` | src/app/accountant/incentives-page.jsx | Which month's 2nd-half payroll pays an item (filed after the cutoff moves to next month) / its badge / Process Payroll's notice listing items moved to next month. | dates, cutoffs | Month / badge / notice | Incentives, Process Payroll | `GET /api/accountant/payroll?view=monthly_items` | An incentive filed Oct 29 is paid in November. |
| `EmployeeSelect` | src/app/accountant/incentives-page.jsx | Employee dropdown. | value, employees | Dropdown | Forms | — | — |
| `IncentivesPage` / `load` / `submit` / `remove` | src/app/accountant/incentives-page.jsx | List a month's incentives and overload hours / add one (amount, or hours for overload) / remove one not yet paid. | month / form / item | Pop-ups | Page load / "Add" / "Remove" | `GET ?view=monthly_items`, `POST add_monthly_item`, `PATCH archive_monthly_item` | Adding 6 overload hours for a teacher covering extra classes. |
| `startOptions` / `statusBadge` (cash advances) | src/app/accountant/cash-advances-page.jsx | Start-period choices / status badge. | none / advance | Options / badge | Form, list | — | — |
| `CashAdvancesPage` / `load` / `submit` / `setStatus` / `confirmCancel` | src/app/accountant/cash-advances-page.jsx | Older cash advances (new ones go under Loans): list with balances and repayments / add one / put on hold, resume or cancel (with a reason). | form / advance, status | Pop-ups | Page buttons | `GET ?view=cash_advances`, `POST add_cash_advance`, `PATCH set_cash_advance_status` | — |
| `startOptions` / `statusBadge` (loans) | src/app/accountant/loans-page.jsx | Start-period choices / loan status badge. | none / loan | Options / badge | Loans | — | — |
| `LoansPage` / `load` | src/app/accountant/loans-page.jsx | Loans (salary, cash advance, emergency, subsidy advance) with balances, repayments and actions. | `refreshKey` | Page | Sidebar → Loans | `GET /api/accountant/loans` | — |
| `submitLoan` | src/app/accountant/loans-page.jsx | Creates a loan (type, principal, interest, number of payrolls, amortization, date granted, start period, final-pay authorization). | form | Pop-up | "Add loan" | `POST /api/accountant/loans {action:"create_loan"}` | A ₱10,000 salary loan repaid over 10 payrolls of ₱1,000. |
| `submitAdvance` | src/app/accountant/loans-page.jsx | Processes a licensed-teacher subsidy advance (released when HR approves). | form | Pop-up | "Subsidy advance" | `POST {action:"create_subsidy_advance"}` | — |
| `openDialog` / `confirmDialog` / `resume` | src/app/accountant/loans-page.jsx | Suspend a loan / record a refused consent / convert an excess subsidy advance into a loan (signed consent) / resume a suspended loan. | loan, inputs | Pop-ups | Loan action buttons | `PATCH /api/accountant/loans {action}` | — |
| `ThirteenthMonthPage` / `load` / `processAll` | src/app/accountant/thirteenth-month-page.jsx | Each employee's 13th month for a year (the year's basic salary ÷ 12) / record the December payout. | year | Page / pop-up | Sidebar → 13th Month / "Process" | `GET ?view=thirteenth_month`, `PATCH process_13th_month` | Total basic ₱264,000 ÷ 12 = ₱22,000 13th month. |
| `FinalPayPage` / `load` / `open` / `save` | src/app/accountant/final-pay-page.jsx | Separated employees with their final-pay status and 30-day deadline / view one's computed breakdown / save and release it as a Final payslip. | person, release date | Page / pop-up | Sidebar → Final Pay / "Open" / "Save" | `GET`/`POST /api/accountant/final-pay` | A resigned teacher's last salary, pro-rated 13th month and loan balance are settled. |
| `ApprovalsPage` (Subsidies) | src/components/portal/approvals-page.jsx | Licensed-teacher subsidy items: the Accountant processes missed-month adjustments, advances and excess-advance settlements (and resubmits rejected ones); HR approves or rejects with a reason. With history. | `refreshKey` | Page | Accountant → Subsidies / HR → Subsidy Approvals | `load`, `open`, `submit`, `section` | — |
| `load` / `open` / `submit` / `section` (subsidies) | src/components/portal/approvals-page.jsx | Load the items / open a process or decide dialog / save it / build one list section. | values | Data / dialog / pop-up | Page buttons | `GET /api/admin/approvals`, `POST {action:"process"}`, `PATCH {action:"decide"}` | HR approves a teacher's missed-month subsidy adjustment. |

### 9.5 Accountant API routes (server)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `lateMark` / `ownPayslipMark` | src/app/api/accountant/payroll/route.js | Marks a payslip processed after its window closed / the Accountant's own payslip, so HR sees a flag. | window, guard | Mark | Processing | — | — |
| `isOwnPayroll` / `refuseOwnPayroll` | src/app/api/accountant/payroll/route.js | Nobody may adjust or add to their own pay (their own payslip is system-computed only). | guard, employee | true/false / refusal | Saves and items | — | The Accountant can't raise her own basic salary. |
| `parseEmployeeIdNumber` / `manilaToday` / `getPayPeriodRange` / `formatPeriodLabel` | src/app/api/accountant/payroll/route.js | ID number / today in Manila / the semi-monthly period of a date (1–15 or 16–end) / its label. | date | Values | Internal | — | Oct 20 is in "October 16-31, 2026". |
| `toAmount` / `normalizePositionForRole` / `isDuplicateKeyError` / `isInternalDbSchemaError` | src/app/api/accountant/payroll/route.js | Round money / position label / duplicate-record error / schema error check. | values | Values | Internal | — | — |
| `shapeEmployee` (payroll) | src/app/api/accountant/payroll/route.js | The employee details payroll needs (salary, branch, hire date and so on). | user, profile | Employee | Internal | — | — |
| `readPayrollHolds` / `payrollHoldMessage` / `refusePayrollHold` | src/app/api/accountant/payroll/route.js | Employees whose pay is held (AWOL or Separated) / the message / refusal to generate their payslip. | client, IDs / employee | Map / text / refusal | Processing | `profiles.payroll_hold` | An AWOL employee's payslip is not generated. |
| `fetchEmployees` (payroll) | src/app/api/accountant/payroll/route.js | The paid employees in the caller's branch with their holds. | client, guard | Employees | Every request | `listUsersCached`, `profiles` | — |
| `normalizePayrollEntry` / `computeTotals` | src/app/api/accountant/payroll/route.js | Clean a stored entry / compute every total from the inputs and rates: absences, late, undertime, half-day and unpaid-leave deductions, contributions, tax, incentives, gross and net. | entry / payroll | Entry / totals | Building payslips | `DEFAULT_RATES` | — |
| `lightRowToEntry` / `readPayrollEntries` | src/app/api/accountant/payroll/route.js | Read only the payroll entries a request needs (by employees, periods, IDs, status; light or full). | client, scope | Entries | Every request | `payroll_entries`, `fetchAllIn` | — |
| `periodLabelsBetween` / `historyLabels` / `historyYears` | src/app/api/accountant/payroll/route.js | Period labels in a range / the periods of "last 12 months" or a year / the years with runs. | dates / param | Labels / years | History lists | `payroll_runs` | — |
| `syncPayrollEntryToDb` / `deletePayrollEntryFromDb` | src/app/api/accountant/payroll/route.js | Save or delete a draft entry. | client, entry | Result | Drafts | `payroll_entries` | — |
| `buildRecordPayload` / `buildEntryPayload` | src/app/api/accountant/payroll/route.js | The database rows for a processed payslip. | entry | Rows | Commit | — | — |
| `commitPayrollEntries` / `describeCommitFailure` | src/app/api/accountant/payroll/route.js | Saves payslips all-or-nothing per employee (record, payslip number, entry and lines in one transaction) / explains a failure. | client, entries | Results | Processing | database function `payroll_commit_entries` | — |
| `resolveEntryStatus` / `normalizeAttendanceStatus` (payroll) / `expandDateRange` / `isLeaveWorkingDay` | src/app/api/accountant/payroll/route.js | Entry status / status label / every date in a range / whether a leave day is a working day. | values | Values | Internal | — | — |
| `buildLeaveContext` | src/app/api/accountant/payroll/route.js | Approved leave days per employee (with and without pay) in a period. | employees, dates, holidays | Leave map | Payroll context | `leave_requests` | — |
| `fetchAttendanceSummary` / `readPeriodAttendance` | src/app/api/accountant/payroll/route.js | Present, late, absent and deduction days per employee / the period's records (closing finished days first). | client, employees, dates | Summaries / rows | Payroll context | database function `attendance_close_days`; `attendance_logs` | — |
| `readApprovedOvertime` / `readHolidays` | src/app/api/accountant/payroll/route.js | Approved overtime minutes per record / the period's days off (regular, special, suspension). | client, dates | Maps | Payroll context | `attendance_overtime_approvals`, `attendance_holidays` | — |
| `newHireNote` / `notHiredRefusal` | src/app/api/accountant/payroll/route.js | A new hire's paid days note / why there is no payslip before the hire date. | hire info | Text | New hires | — | A teacher hired Oct 20 is paid for Oct 20–31 only. |
| `loadSemiMonthlyContext` / `loadPerHalfContext` / `loadCashAdvanceContext` | src/app/api/accountant/payroll/route.js | Load what each pay style needs: semi-monthly (which half, the 2nd half's window, tax table, 1st-half pay), per-half (fixed contributions, items, overload), and active cash advances with repayments. | client, employees, period | Context | Payroll context | `semi-monthly.js`, `school-sheet.js`, `cash-advance.js` libraries | — |
| `loadPeriodPayContext` | src/app/api/accountant/payroll/route.js | Everything payroll needs for one period per employee: the rates in force, the attendance from the logs, approved leave, holidays, approved overtime, the semi-monthly or per-half context, tenure protection and the Early Bird winner (optionally only up to a date). | client, employees, period | Context | GET, generate, process | `loadRateConfigs`, `resolveRates`, `readPeriodAttendance`, `buildLeaveContext`, `readHolidays`, `readApprovedOvertime`, `loadSemiMonthlyContext`, `loadPerHalfContext`, `loadTenureProtection`, `buildProtection`, `resolveEarlyBirdWinner` | — |
| `differs` / `pickAmount` / `rateSnapshot` | src/app/api/accountant/payroll/route.js | Value changed? / pick a typed or default amount / the rates used, saved on the payslip. | values | Values | Building | — | — |
| `buildFirstHalfPayroll` | src/app/api/accountant/payroll/route.js | 1st-half payslip: monthly salary ÷ 2 with no deductions (or per-cutoff: attendance only). | employee, context | Payroll | Generating a 1st half | — | ₱25,000 monthly gives ₱12,500 on Oct 1–15. |
| `applySecondHalfSettlement` | src/app/api/accountant/payroll/route.js | 2nd half: the month's net less what the 1st half paid (and any carried balance). | payroll, settlement | Payroll | Generating a 2nd half | — | — |
| `buildEmployeePayroll` | src/app/api/accountant/payroll/route.js | One employee's payroll for a period, computed on the server from the records. Typed overrides become recorded "deviations" with a reason. | employee, context, input | Payroll, blocking days, deviations | Every payslip | `computeTotals`, the payroll library | — |
| `cutoffBreakdown` | src/app/api/accountant/payroll/route.js | A per-cutoff payslip as lines: each earning and deduction, gross, total deductions and net. | payroll, half | Lines | Payslip display | — | — |
| `describeBlocking` / `describeMissingReason` | src/app/api/accountant/payroll/route.js | Messages for unresolved attendance days / a missing override reason. | lists | Text | Refusals | — | — |
| `recordAuditColumns` / `buildPayrollLineRows` / `mapEntryToRecord` / `compactHistoryRecord` | src/app/api/accountant/payroll/route.js | Audit columns on the payslip / the deduction and incentive line rows / an entry as a list row / a slimmed history row. | entry | Rows | Commit, lists | — | — |
| `loadRunStatuses` / `buildPayrollPanels` / `buildPayslipOptions` | src/app/api/accountant/payroll/route.js | Run status per branch and period / gross, deduction and net totals / payslip dropdown choices. | entries / records | Maps / totals / options | GET | `payroll_runs` | — |
| `periodWindow` / `refuseOutsideFinalWindow` / `addDayKey` | src/app/api/accountant/payroll/route.js | The generation window (when Generate opens, the pay date) / refuse a Final payslip outside it / add days. | client, period | Window / refusal | Processing | `generation-window.js`, `schedule.js` | — |
| `payslipStateFor` / `findPeriodRangeByLabel` / `getPeriodOptions` | src/app/api/accountant/payroll/route.js | An employee's payslip state for the buttons / the dates of a period label / the period dropdown. | entries / label | Values | GET | — | — |
| `handleThirteenthMonthView` / `handleProcessThirteenthMonth` | src/app/api/accountant/payroll/route.js | Each employee's 13th month for a year from their Final payslips / record the December payout. | year, IDs | Data / result | 13th Month page | `thirteenth-month.js`, `appendAuditLog` | — |
| `loadLockDayFor` / `resolveLockDayFor` / `resolveCutoffs` / `itemPayrollMonth` | src/app/api/accountant/payroll/route.js | The attendance cut-off days from the payslip schedule / which month pays an item. | client, configs | Functions | Monthly items, semi-monthly | `schedule.js` | — |
| `handleMonthlyItemsView` / `handleAddMonthlyItem` / `handleArchiveMonthlyItem` | src/app/api/accountant/payroll/route.js | List a month's incentives and overload / add one (not for yourself) / remove one never paid. | month / item | Data / result | Incentives page | `payroll_monthly_incentives`, `appendAuditLog` | — |
| `sheetName` / `handlePayrollSheetView` | src/app/api/accountant/payroll/route.js | "Benitez, Jane Marinel D." / the school payroll sheet for a period, one table per branch with totals and the approval block. | profile / period, branch | Sheet | Reports → Payroll sheet | `school-sheet.js`, `system_config` | — |
| `handleHolidayWorkView` | src/app/api/accountant/payroll/route.js | Every holiday worked (employee, day, hours, premium paid). | period | Rows | Reports → Holiday work | `holiday-lines.js` | — |
| `handleCashAdvancesView` / `handleAddCashAdvance` / `handleSetCashAdvanceStatus` | src/app/api/accountant/payroll/route.js | List cash advances with balances / add one / change its status (with a reason). | values | Data / result | Cash Advances page | `payroll_cash_advances`, `cash-advance.js`, `appendAuditLog` | — |
| `GET` (accountant payroll) | src/app/api/accountant/payroll/route.js | The whole payroll page for a period (or a view: 13th month, monthly items, payroll sheet, cash advances, holiday work, or a payslip PDF). | `period`, `entry_id`, `history`, `view`, `format` | Data or PDF | Every Accountant page load | functions above, `buildPayslipDetails`, `buildPayslipPdf` | — |
| `describeEarlyBird` | src/app/api/accountant/payroll/route.js | The Early Bird panel (another branch's winner shown without a name). | data, employees, guard | Panel | GET | — | — |
| `handleBatchSubmit` | src/app/api/accountant/payroll/route.js | "Process payroll for all": computes and commits every eligible employee's Final payslip (attendance always from the server) and reports the skipped ones. | entries, period, reason | Processed, skipped | Batch button | `loadPeriodPayContext`, `buildEmployeePayroll`, `commitPayrollEntries`, `appendAuditLog` | — |
| `POST` (accountant payroll) | src/app/api/accountant/payroll/route.js | Adds a monthly item or cash advance, runs the batch, or saves or submits one employee's payroll. Refuses locked runs, unready payroll, unresolved days and deviations without a reason. | `action`, payroll data | Result | Process Payroll forms | handlers above | — |
| `handleGenerate` | src/app/api/accountant/payroll/route.js | Generates one employee's payslip: a Draft during the period, or the Final one after it (until the pay date). Unresolved days need confirmation. `override_final` recomputes a Final payslip with a reason (the old one is archived, and the audit log keeps the old and new totals). It is a backend recovery path with no screen, for the Super Admin only (module `payroll_override`, October 29, 2026), and only for a payslip HR has approved; it runs in the database function `payroll_override_final`, which logs it in `payroll_final_overrides` and flags the records that used the old figures (`payroll_review_flags`). | employee, period, flags | Payslip | Generate / Reprocess | `loadPeriodPayContext`, `buildEmployeePayroll`, `commitPayrollEntries` | — |
| `PATCH` (accountant payroll) | src/app/api/accountant/payroll/route.js | Sends generate, override_final, archive_monthly_item, process_13th_month, set_cash_advance_status or cancel_draft to the right handler. | `action` | Result | Various buttons | handlers above | — |
| `dbError` / `subsidyRefused` / `money` / `advanceAvailable` | src/app/api/accountant/loans/route.js | Plain database refusals / subsidy refusals / peso text / how much a subsidy balance can still advance. | values | Values | Internal | — | — |
| `GET` (loans) | src/app/api/accountant/loans/route.js | Loans in reach with repayments, the people who can borrow, and open subsidy balances. | session | Loans | Loans page | `payroll_loans`, `payroll_loan_payments`, `payroll_subsidy_balances` | — |
| `findPerson` | src/app/api/accountant/loans/route.js | A borrower the caller may manage. | client, guard, ID | Person | POST | `loadPayrollStaff` | — |
| `POST` (loans) | src/app/api/accountant/loans/route.js | Creates a loan (deducted on the 16–end payslip until repaid), or a subsidy advance (released when HR approves). | `action`, loan fields | Loan | Add loan / Subsidy advance | `loans.js`, `payroll_loans`, database function `subsidy_request_process`, `appendAuditLog` | — |
| `PATCH` (loans) | src/app/api/accountant/loans/route.js | Suspends or resumes a loan, records a refused consent, or converts an excess subsidy advance into a loan (signed consent), for HR's decision. | `action`, details | Result | Loan actions | `payroll_loans`, database function `subsidy_request_process`, `appendAuditLog` | — |
| `finalPayLabel` / `addDays` / `isDate` / `expandDays` | src/app/api/accountant/final-pay/route.js | The final payslip label / date helpers. | dates | Values | Internal | — | — |
| `gather` | src/app/api/accountant/final-pay/route.js | Reads everything final pay needs for one separated employee: unpaid days, earnings, 13th month so far, subsidy, loans and contributions. | client, person | Inputs | Final pay | `profiles`, `attendance_logs`, `attendance_holidays`, `leave_requests`, `payroll_entries`, `payroll_loans`, `payroll_thirteenth_month`, `payroll_subsidy_balances`, `payroll_tax_brackets`, `payroll_exempt_benefits_paid`, `employee_awol_cases` | — |
| `separatedPeople` | src/app/api/accountant/final-pay/route.js | Separated employees in reach. | client, guard | People | GET | `loadPayrollStaff` | — |
| `GET` (final pay) | src/app/api/accountant/final-pay/route.js | Separated employees with status and the 30-day deadline, or one employee's computed breakdown (nothing saved). | `employee_id` | List or breakdown | Final Pay page | `computeFinalPay` | — |
| `POST` (final pay) | src/app/api/accountant/final-pay/route.js | Saves the final pay as a Final payslip (loan repayments in the same transaction), records the pro-rated 13th month, settles the subsidy balance and stamps the AWOL case. | `employee_id`, `release_on` | Result | "Save" | `commitPayrollEntries`, `computeFinalPay`, `appendAuditLog` | — |
| `visibleBranches` | src/app/api/accountant/payroll-runs/route.js | The branches the caller may submit for. | client, guard | Branches | Internal | `branches` | — |
| `GET` (accountant runs) | src/app/api/accountant/payroll-runs/route.js | Each branch's run for a period: status, HR's remarks, history and Final/Draft/missing counts. | `period` | Runs | Run panel | `run-service.js` | — |
| `PATCH` (accountant runs) | src/app/api/accountant/payroll-runs/route.js | Submits (or resubmits) a branch's run for HR approval, then locks it. | `branch_id`, `period` | Run | Submit button | `run-service.js` (database function `submit_payroll_run`) | — |
| `refused` / `GET` / `POST` / `PATCH` (payroll corrections) | src/app/api/payroll/corrections/route.js | List corrections (branch or all) / the Accountant files one / resubmit, or HR approves or rejects. All logged. | values | Results | Correction dialogs | `corrections.js` database functions, `appendAuditLog` | — |
| `maskTin` / `summary` / `file` | src/app/api/payroll/bir-forms/route.js | "••••1234" TIN / one employee's 2316 summary row / a download reply. | values | Values | Internal | — | — |
| `GET` (BIR forms) | src/app/api/payroll/bir-forms/route.js | The year's 2316 certificates (summary, TINs masked), a 2316 PDF (all or one employee), or the 1604-C alphalist as Excel or CSV. | `year`, `format`, `employee_id` | Data or file | BIR forms card | `loadBirYear`, `build2316Pdf`, `buildXlsx` | January filing of the alphalist with the BIR. |
| `money` / `refused` / `GET` / `POST` / `PATCH` (subsidies) | src/app/api/admin/approvals/route.js | Subsidy items: list (raising excess-advance items automatically, with history and the Accountant's open balances) / the Accountant processes / HR decides. | values | Results | Subsidies page | database functions `subsidy_requests_raise_excess`, `subsidy_request_process`, `subsidy_request_decide`; `payroll_subsidy_requests`, `payroll_subsidy_balances` | — |
## 10. Payroll Computation Engine (salary, deductions, overtime, tax, contributions, payslips, BIR)

**Where it runs:** on the server, behind Process Payroll, Pay Record, Final Pay, 13th Month, Payroll Approval and the BIR forms. The browser preview (`src/lib/portal/payroll-preview.js`) mirrors the same rules.
**What it does:** turns attendance into pay. It covers:
- **Deductions:** absences, lates (N lates = 1 absence), undertime, half days and leave without pay.
- **Earnings:** approved overtime, holiday pay, incentives, perfect attendance, Early Bird, the licensed-teacher subsidy and overload pay.
- **Contributions:** SSS, PhilHealth and Pag-IBIG.
- **Withholding tax:** from the BIR table.
- **Pay styles:** semi-monthly halves, per-cutoff or the school payroll sheet.
- **Loan and cash-advance repayments.**
- **Payslip outputs:** PDFs, 13th month, final pay and BIR 2316 / alphalist.

### 10.1 Money, periods, rates and statutory rules

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `roundPeso` | src/lib/payroll/money.js | Rounds to centavos (0 for non-numbers, never "−0"). | value | Number | Every peso computation | — | 1234.567 becomes 1234.57. |
| `toPesoAmount` / `floorNetPay` | src/lib/payroll/net-pay.js | Round to centavos / round and never go below zero (net pay). | value | Number | Net pay | — | A computed net of −₱120 is shown as ₱0.00. |
| `pad` / `daysInMonth` | src/lib/payroll/periods.js | Two-digit numbers / days in a month. | numbers | Values | Internal | — | — |
| `manilaDateKey` | src/lib/payroll/periods.js | Today's date in Manila (YYYY-MM-DD). | date | Text | Everywhere dates matter | — | — |
| `isDateKey` / `periodForDateKey` / `periodFromLabel` / `nextPeriod` / `dateKeysBetween` | src/lib/payroll/periods.js | Date format check / the semi-monthly period of a date (1–15 or 16–end) / a period from its label / the next period / all dates in a range. | date or label | Period / dates | Payroll, attendance | — | "September 16-30, 2026" gives Sep 16 to Sep 30. |
| `sameRef` / `newestFirst` | src/lib/payroll/rates.js | Compare rate scopes / sort newest version first. | rows | Values | Internal | — | — |
| `resolveRate` | src/lib/payroll/rates.js | The version of one rate in force on a period's first day for one employee (employee → position → branch → global). | configs, type, who, date | Rate | Payroll | — | — |
| `resolveRates` / `rateValues` | src/lib/payroll/rates.js | Every rate for an employee and period (a branch daily rate without its own hourly rate gets daily ÷ 8) / a plain value list. | configs, who, date | Rates | Payroll | `resolveRate` | Daily ₱600 gives hourly ₱75. |
| `loadRateConfigs` | src/lib/payroll/rates.js | Reads every rate version (payroll refuses to run if the rates can't be read). | client | Configs | Payroll | `payroll_rate_configs` | — |
| `rateHistory` / `validateRateInput` | src/lib/payroll/rates.js | A rate's version history ("₱100 (Jan 1 – Sep 25) → ₱110 (Sep 26 – present)") / checks a new version. | configs / form | History / error | Rate settings | — | — |
| `usesLegalRules` | src/lib/payroll/statutory.js | Whether a period uses the legal contribution and tax rules (from Oct 1, 2026). | period start | true/false | Payroll | — | — |
| `peso` / `num` | src/lib/payroll/statutory.js | Round / read a rate value. | values | Numbers | Internal | — | — |
| `sssMonthlySalaryCredit` | src/lib/payroll/statutory.js | The SSS salary credit: the salary rounded to its ₱500 bracket, kept between the minimum and maximum. | salary, rates | Credit | Contributions | — | ₱18,300 gives an MSC of ₱18,500. |
| `monthlyContributions` | src/lib/payroll/statutory.js | Monthly employee share: SSS (5% of the MSC), PhilHealth (2.5% of salary within ₱10,000–₱100,000), Pag-IBIG (2% of salary up to ₱10,000, so at most ₱200). | salary, rates | SSS, PhilHealth, Pag-IBIG | Payroll | `sssMonthlySalaryCredit` | ₱20,000 salary: SSS ₱1,000, PhilHealth ₱500, Pag-IBIG ₱200. |
| `periodContributions` | src/lib/payroll/statutory.js | Half of each monthly share (one semi-monthly payslip). | salary, rates | Amounts | Payroll | `monthlyContributions` | — |
| `withholdingTax` | src/lib/payroll/statutory.js | Withholding tax from the BIR semi-monthly table (TRAIN law, 2023 onward). | taxable, table | Tax | Payroll | `SEMI_MONTHLY_TAX_TABLE` | — |
| `taxableCompensation` | src/lib/payroll/statutory.js | Taxable pay: basic + overtime + holiday pay − attendance and unpaid-leave deductions − own SSS, PhilHealth and Pag-IBIG (never below zero). | figures | Amount | Tax | — | — |

### 10.2 Attendance to pay, semi-monthly, per-half sheet

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `peso` / `valueOf` / `configOf` / `dayKey` | src/lib/payroll/attendance-pay.js | Round / read a rate / which rate version / a record's date. | values | Values | Internal | — | — |
| `computeAttendancePay` | src/lib/payroll/attendance-pay.js | Turns one employee's attendance for a period into lines, each tied to its record. **Deductions:** Late (every N lates = 1 absence, optional per-minute charge), Undertime (minutes ÷ 60 × hourly), Half Day (% of daily), Absent (% of daily, not on leave or holidays; half on a half-day suspension). **Earnings:** approved Overtime (minutes ÷ 60 × hourly × (1 + premium %)), Holiday pay (premium % of daily, by hours worked up to 8), Perfect Attendance. Incomplete days are returned as "blocking", and tenure-protected days are waived. | records, leave days, rates, dates, overtime, holidays, protection | Deduction and earning lines, counts, blocking days | Payroll context | — | 3 lates with "3 late = 1 absent" and a ₱600 daily rate = ₱600 deducted. |
| `usesSemiMonthlyRules` / `halfOf` / `monthKeyOf` / `shiftMonth` / `daysInMonth` / `monthInfo` | src/lib/payroll/semi-monthly.js | Whether the semi-monthly rules apply / 1st or 2nd half / "2026-10" / move months / days in a month / both halves' labels. | dates | Values | Payroll | — | — |
| `lockDateKey` / `addDays` / `monthlyWindow` | src/lib/payroll/semi-monthly.js | The month's attendance lock date / add days / the days a month's 2nd half counts (with carry-over after the lock day). | month, lock day | Window | 2nd half | — | — |
| `usesCutoffAttendance` / `firstHalfWindow` / `secondHalfWindow` | src/lib/payroll/semi-monthly.js | Whether each cutoff deducts its own attendance / the 1st cutoff's days / the 2nd cutoff's days. | month, cutoffs | Windows | Per-cutoff payroll | — | — |
| `payrollMonthFor` | src/lib/payroll/semi-monthly.js | Which payroll month an item belongs to (filed after the cutoff moves to next month). | dates, lock day | Month | Incentives | — | — |
| `dailyRateFor` / `hourlyRateFor` / `overloadPayFor` | src/lib/payroll/semi-monthly.js | Daily rate from the monthly salary / hourly (daily ÷ 8) / overload pay for extra hours (with a premium). | salary, divisor / hours | Amounts | Payroll | — | ₱26,100 monthly with a 261-day divisor: ₱26,100 × 12 ÷ 261 = ₱1,200 a day. |
| `monthlyWithholdingTax` / `taxTableFromRows` / `resolveTaxTableRows` | src/lib/payroll/semi-monthly.js | Tax from the monthly table / build the table from saved brackets / the table version in force on a date. | taxable, rows | Tax / table | 2nd half | `payroll_tax_brackets` | — |
| `paidDaysBetween` / `hireProration` | src/lib/payroll/semi-monthly.js | Paid working days in a range (Mon–Fri, or Mon–Sat for 300+ day divisors) / a new hire's pay from the hire date (capped at normal pay). | dates, divisor / hire info | Days / pay | New hires | — | Hired Oct 20: paid 10 working days × daily rate. |
| `computeFirstHalf` / `computeSecondHalf` | src/lib/payroll/semi-monthly.js | 1st half = monthly salary ÷ 2 with nothing deducted / 2nd half = the whole month less the 1st half already paid. | salary and figures | Amounts | Semi-monthly payslips | — | ₱25,000: ₱12,500 on the 15th, the rest settled on the 30th. |
| `peso` / `monthStartOf` / `usesPerHalfRule` / `halfOfPeriod` | src/lib/payroll/school-sheet.js | Round / month start / whether the period is paid per half on its own attendance (the school's sheet) / which half. | values | Values | Per-half payroll | — | — |
| `monthlyContributionsFor` / `contributionsForHalf` | src/lib/payroll/school-sheet.js | Monthly contributions (fixed amounts or legal tables) / how much each half deducts (all on the 1st, all on the 2nd, or split). | salary, rates, settings | Amounts | Per-half payroll | `monthlyContributions` | — |
| `workingDaysIn` / `periodDaysFor` | src/lib/payroll/school-sheet.js | Weekdays that aren't holidays / days in a half on the sheet. | dates | Numbers | Per-half payroll | — | — |
| `sheetFigures` / `sheetRowFromEntry` / `sheetTotals` | src/lib/payroll/school-sheet.js | The school sheet's columns for one payslip (exact to the centavo) / a sheet row from a stored payslip / the totals row. | payslip | Row / totals | Payroll sheet report | — | — |

### 10.3 Loans, cash advances, subsidy, 13th month, final pay

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `interestAmount` / `totalPayable` / `suggestedAmortization` | src/lib/payroll/loans.js | Flat interest / principal + interest / total ÷ payrolls, rounded up so the last payment is never short. | principal, %, payrolls | Amounts | New loan | — | ₱10,000 at 5% over 10 payrolls = ₱1,050 each. |
| `nextSecondHalf` / `validateLoanInput` / `validateSubsidyAdvanceInput` | src/lib/payroll/loans.js | The next 16th / check a new loan / check a subsidy advance against what is available. | values | Date / error | Loan forms | — | — |
| `loanAppliesToPeriod` / `scheduleLoans` | src/lib/payroll/loans.js | Whether a loan is deducted this period / the repayments one 2nd-half payslip makes, oldest loan first (partial when pay is short). | loans, period, available pay | Repayments | 2nd-half payslips | — | — |
| `isMissingRelation` / `loadLoanContext` | src/lib/payroll/loans.js | Missing table check / active loans with balances for a period. | client, IDs, period | Loans | Payroll | `payroll_loans`, `payroll_loan_payments` | — |
| `payrollOf` / `repaidByAdvance` / `advanceBalance` / `appliesToPeriod` | src/lib/payroll/cash-advance.js | Read a payslip / how much each advance was repaid / remaining balance / whether a period deducts it. | entries, advance | Values | Cash advances | — | — |
| `scheduleCashAdvances` / `validateCashAdvanceInput` | src/lib/payroll/cash-advance.js | The installments one payslip deducts, oldest first / check a new advance. | advances, period / form | Installments / error | Payroll, form | `payroll_cash_advances` | — |
| `isMissingRelation` / `subsidyForPayslip` | src/lib/payroll/teacher-subsidy.js | Missing table check / what a 2nd-half payslip pays and taxes for the licensed-teacher subsidy (payout, approved adjustments, advance memos; tax by treatment, with the ₱90,000 exempt-benefits ceiling shared with the 13th month). | context, period | Subsidy figures | 2nd-half payslips | — | — |
| `loadSubsidyContext` | src/lib/payroll/teacher-subsidy.js | Everything the subsidy needs per employee for a period. | client, IDs, period | Map | Payroll | `payroll_subsidy_balances`, `payroll_subsidy_adjustments`, `payroll_exempt_benefits_paid` | — |
| `describeSubsidyError` / `describeDetails` / `shapeSubsidyRequest` / `decisionHistory` / `advanceAvailable` | src/lib/payroll/subsidy-requests.js | Plain refusal messages / one-line description / a request for screens / every decision, newest first / how much a balance can still advance. | rows | Values | Subsidies page | — | — |
| `basicEarnedFromPayroll` / `compute13thMonthFromEntries` | src/lib/payroll/thirteenth-month.js | Basic pay a payslip earned after unpaid absences / the year's total ÷ 12. | payslips, year | Amount | 13th Month page, final pay | `payroll_entries` | — |
| `addDays` / `isWeekend` / `paidDaysBetween` (final pay) | src/lib/payroll/final-pay.js | Date helpers / paid working days up to separation (a holiday is paid unless the working day before was an absence). | dates, absences | Days | Final pay | — | — |
| `computeFinalPay` | src/lib/payroll/final-pay.js | Final pay: unpaid salary up to separation + pro-rated 13th month + unpaid subsidy − contributions − tax − carry-over − loans (only with signed authority) − excess subsidy advances. Never below zero; what remains stays on the loan "for collection". | salary, rates, attendance, loans… | Breakdown | Final Pay page | — | A teacher separated Oct 22 receives Oct 16–22 pay plus her pro-rated 13th month, less her loan balance. |
| `payrollOf` / `attendanceSpanOf` / `finalizedAtOf` / `isFinal` | src/lib/payroll/final-payslips.js | Read a payslip / its attendance dates / when it became Final / is it Final. | entry | Values | Internal | — | — |
| `finalPayslipsCovering` / `finalPayslipNotice` / `correctionPayrollNotice` | src/lib/payroll/final-payslips.js | Final payslips that counted a day / the warning that a correction won't change them automatically. | client, employee, date | Notice | After attendance corrections | `payroll_entries` | — |
| `changed` / `attendanceChangesAfterFinal` | src/lib/payroll/final-payslips.js | Attendance changes made after each Final payslip, on days it counted. | client, entries | Map | Payroll checks | `attendance_logs_history` | — |

### 10.4 Windows, schedule, runs and approvals

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `addDays` / `formatDateKey` / `payDateFor` | src/lib/payroll/generation-window.js | Add days / "Oct 12, 2026" / the pay date for a period (from the Pay Calendar). | dates | Values | Generation window | — | — |
| `scheduledGenerationWindow` / `generationWindow` | src/lib/payroll/generation-window.js | When payslips can be generated: a Draft during the period, the Final from the generation day until the pay date, after which it is "closed". | period, schedule, calendar | Window state and message | Process Payroll | — | Before the period ends only a Draft can be made; after the pay date the window is closed. |
| `loadPayCalendar` | src/lib/payroll/generation-window.js | The Pay Calendar dates. | client | Dates | Window | `system_config` | — |
| `addDays` / `lastDayOfMonth` / `isWeekend` | src/lib/payroll/schedule.js | Date helpers. | dates | Values | Internal | — | — |
| `settingsFor` / `ruleFor` / `generationDateFor` | src/lib/payroll/schedule.js | The payslip-schedule settings in force / the weekend and holiday rule / the generation date of a period (moved off weekends and holidays per the rule). | period, settings | Values | Window, cut-offs | — | With the "previous working day" rule, a 15th that falls on a Sunday moves to Friday the 13th. |
| `createPayslipSchedule` / `isMissingRelation` / `loadPayslipSchedule` | src/lib/payroll/schedule.js | Build the schedule (generation days, cut-offs) / missing table check / load settings and holidays. | settings, holidays | Schedule | Payroll | `payroll_schedule_settings`, `attendance_holidays` | — |
| `requiresApproval` / `isLockedRun` / `isEditableRun` / `payslipVisible` | src/lib/payroll/runs.js | Periods from Oct 1, 2026 need HR approval / a run is locked when pending or approved / editable otherwise / an employee sees a payslip only once its run is approved. | label / run | true/false | Many screens | — | — |
| `previousSameCutoffLabel` / `attentionFlags` | src/lib/payroll/runs.js | Same cutoff of the previous month / flags HR should look at (negative net, no days worked, a big swing from last time). | values | Label / flags | Run snapshots | — | A net pay 40% lower than last month is flagged. |
| `shapeRunItem` / `runTotals` / `shapeRun` | src/lib/payroll/runs.js | One employee's snapshot row from a payslip / a run's totals / a run for screens. | entry / items / row | Objects | Runs | — | — |
| `loadRunsFor` / `lockedRunMessage` / `describeRunError` | src/lib/payroll/runs.js | The runs of these branches for a period / why a locked run can't change / database error to a message. | client / run / error | Values | Runs | `payroll_runs` | — |
| `expectedInRun` / `readEntries` / `describeBranchRuns` | src/lib/payroll/run-service.js | Who must be in a branch's run (paid, active, not held, hired by period end) / read entries / each branch's run with Final, Draft and missing counts. | staff, branch, period | Run info | Accountant run panel | `payroll_entries`, `payroll_run_summaries`, `payroll_approval_history` | — |
| `submitRun` | src/lib/payroll/run-service.js | Submits (or resubmits) a branch's run: every expected employee needs a Final payslip; the snapshot is built here and checked by the database. | client, guard, branch, period | Result | "Submit for HR Approval" | database functions `ensure_payroll_run`, `submit_payroll_run`; `payroll_entries`, `profiles` | — |
| `isMissingColumn` / `loadPayrollStaff` / `personLabel` / `actorName` | src/lib/payroll/staff.js | Missing column check / paid staff in the caller's reach / "Name (code)" / the actor's display name. | client, guard | Values | Many payroll routes | `profiles` | — |
| `describeCorrectionError` / `shapeCorrection` | src/lib/payroll/corrections.js | Plain refusal message / a correction for screens. | error / row | Values | Corrections | — | — |

### 10.5 Payslip details, PDF and BIR forms

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `payslipSeal` / `formatManilaDateTime` / `buildPayslipDetails` | src/lib/payroll/payslip-details.js | The school seal image / a date and time / everything a payslip shows, built from the stored entry (shared by Pay Record and HR records). | entry | Details | Payslip views and PDF | `public/brand/seal-payslip.jpg` | — |
| `textWidth` / `pdfText` / `jpegInfo` / `clip` | src/lib/payroll/payslip-pdf.js | Measure text / make text PDF-safe / read the seal JPEG's size / shorten text. | values | Values | PDF building | — | — |
| `holidayRows` / `cutoffRows` / `semiMonthlyRows` | src/lib/payroll/payslip-pdf.js | The payslip PDF's lines for holidays, per-cutoff and semi-monthly layouts. | payslip | Lines | PDF | — | — |
| `buildPayslipPdf` | src/lib/payroll/payslip-pdf.js | Creates the payslip PDF (school seal, header, lines, net pay), with no external library. | details, seal, org name | PDF bytes | "Download PDF" | functions above | — |
| `money` / `plural` / `buildAttendanceSummary` / `buildDeductionBasis` | src/lib/payroll/payslip-summary.js | "1,300.00" / "3 days" / the payslip's attendance summary / one line per deduction with how it was computed ("3 days × ₱600"). | figures | Text and lines | Payslips | — | — |
| `periodMonth` / `periodYear` | src/lib/payroll/bir-2316.js | Month and year of a period label. | label | Numbers | BIR | — | — |
| `annualTaxTable` / `annualTaxDue` | src/lib/payroll/bir-2316.js | The annual tax table from the monthly one / annual tax due. | table, taxable | Table / tax | 2316 | — | — |
| `payslipFigures` / `compute2316` | src/lib/payroll/bir-2316.js | One payslip's figures for the 2316 / an employee's whole-year 2316 (gross, non-taxable, taxable, tax due vs withheld, under- or over-withheld). | payslips, benefits, table | 2316 figures | BIR forms | — | — |
| `nameParts` / `alphalistRow` / `toCsv` | src/lib/payroll/bir-2316.js | "Last, First Middle" / one alphalist row / CSV text. | profile / row | Values | Alphalist | — | — |
| `clip` / `shortDate` / `drawCertificate` / `build2316Pdf` | src/lib/payroll/bir-2316-pdf.js | Draws BIR Form 2316 certificates as a PDF, one page per employee. | rows, employer, year | PDF bytes | 2316 downloads | `pdfText`, `textWidth` | — |
| `digits` / `formatTin` / `birEmployerErrors` / `birEmployerFrom` / `missingBirEmployerFields` | src/lib/payroll/bir-employer.js | Employer details for the BIR forms: format the TIN (000-000-000-00000), check values, read them from settings, list missing fields. | values | Values | BIR forms, settings | `system_config` (general) | — |
| `check` / `birYears` / `loadBirYear` | src/lib/payroll/bir-forms.js | Error check / years with paid payslips / everything one year's 2316s and alphalist need (by branch or employee). | client, year | Rows, employer, totals | BIR routes | `payroll_entries`, `payroll_runs`, `payroll_exempt_benefits_paid`, `payroll_tax_brackets`, `payroll_subsidy_balances`, `profiles`, `branches`, `system_config`; `compute2316` | — |

### 10.6 Holiday pay lines

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `nameFromNote` | src/lib/payroll/holiday-lines.js | Reads the holiday's name from a stored line note ("Bonifacio Day · 8 hrs" → "Bonifacio Day"). | note | Name | Internal | — | — |
| `holidayPayLines` | src/lib/payroll/holiday-lines.js | Lists every holiday a payslip paid for: date, name, type, hours and amount, oldest first. | payroll | Lines | Payslips, holiday-work report | `nameFromNote` | — |
| `shortHolidayDate` / `describeHolidayLine` | src/lib/payroll/holiday-lines.js | "Nov 30" / "Bonifacio Day, Nov 30 (8 h)". | date / line | Text | Payslip PDF, reports | — | — |

### 10.7 Payroll preview in the browser (`src/lib/portal/payroll-preview.js`)

The Process Payroll page shows a live preview of each figure while the Accountant types. The server always recomputes the final numbers.

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `toAmount` / `same` | src/lib/portal/payroll-preview.js | Round to centavos / whether two amounts are equal (within half a centavo). | values | Number / true-false | Everywhere in the preview | — | — |
| `money` / `moneyCompact` | src/lib/portal/payroll-preview.js | "₱ 12,345.00" / "₱ 12,345". | amount | Text | Payroll pages | — | — |
| `semiHalf` / `perCutoffFirst` | src/lib/portal/payroll-preview.js | Which half the period is ("first" or "second") / whether the 1st half deducts its own attendance. | page data | Values | Preview | — | — |
| `employeePayInfo` | src/lib/portal/payroll-preview.js | One employee's attendance row, rates and unit amounts (hourly, daily, half day, absent, perfect attendance). | data, employee ID | Info | Preview | — | — |
| `basicDefaultFor` / `semiExtras` / `earlyBirdWinnerPay` | src/lib/portal/payroll-preview.js | The default basic pay for the period / what a 2nd half adds and settles (incentives, overload, 1st-half paid, carry-in, subsidy) / the Early Bird prize if this employee won. | data, employee | Values | Preview | — | — |
| `computeAttendanceAmounts` / `price` | src/lib/portal/payroll-preview.js | Peso amounts for the shown absences, lates, undertime, half days and perfect attendance (the server's figure when unchanged, otherwise the unit rate × quantity). | info, quantities | Amounts | Typing in the form | — | Changing absences from 1 to 2 doubles the absence deduction. |
| `withholdingTax` (preview) | src/lib/portal/payroll-preview.js | Tax for the period from the table the server sent. | data, taxable | Tax | Preview | — | — |
| `usesLegalTables` / `contributionDefaults` / `earningsFor` / `taxDefaultFor` | src/lib/portal/payroll-preview.js | Whether legal tables apply / default SSS, PhilHealth and Pag-IBIG (none on a 1st half) / approved overtime and holiday pay / the default tax for the figures shown. | data, info, figures | Values | Preview | — | — |
| `describeBlockingDays` | src/lib/portal/payroll-preview.js | "2026-10-07 (Incomplete), …" for unresolved days. | list | Text | Blocked rows | — | — |
| `defaultForm` / `formFromDraft` / `lockFirstHalf` | src/lib/portal/payroll-preview.js | The form's starting values for an employee / values from a saved draft / clear what a 1st half may not deduct. | data, employee / draft | Form values | Choosing an employee or draft | — | — |
| `computeSummary` | src/lib/portal/payroll-preview.js | The full live computation summary: basic, contributions, tax, attendance deductions, unpaid leave, incentives, earnings, gross, loans and net (2nd half: less the 1st half paid). | data, employee, form | Summary | Every keystroke in the form | functions above | — |
| `formDeviations` | src/lib/portal/payroll-preview.js | Lists every value changed from the computed default ("SSS: 450 → 500"), which needs a reason. | data, employee, form | List | Saving | — | — |
| `submissionPayload` | src/lib/portal/payroll-preview.js | Builds the data sent to the server for one employee. | action, form, period | Request body | "Process payroll" / "Save as draft" | — | — |
| `batchRowNet` / `batchRowBase` / `batchTaxDefault` | src/lib/portal/payroll-preview.js | Net pay of one batch row / everything a batch row starts from / its default tax. | data, employee, values | Values | Batch table | — | — |
| `statusMeta` / `recordStatusMeta` | src/lib/portal/payroll-preview.js | Label and colour of a payslip status (Paid, Not submitted to HR, Pending HR Approval, Rejected by HR, On hold), using the run's status from Oct 1, 2026. | status / record | Label, tone | Records lists | `requiresApproval` | — |
| `dateLabel` / `shortDate` / `dateTime` | src/lib/portal/payroll-preview.js | "Oct 12, 2026" / "Oct 12" / "Oct 07, 2026, 08:01 AM". | date | Text | Payroll pages | — | — |
## 11. Admin Portal: Branch Management and Oversight (Branch Dashboard, Attendance, Recommendations, Reports to HR, Announcements, Payroll Summary, Branch Reports, RFID)

**Web address:** `/admin`
**Who uses it:** The branch Administrator (the branch head), limited to their own branch.
**What the pages do:** the Admin **recommends** and HR **decides**. The pages are:
- **Branch Dashboard** and **Branch Attendance:** view-only, with a "flag for HR" option on records.
- **Overtime & Substitute:** confirmations the Accountant reads before paying.
- **Leave Recommendations** and **Transfer Endorsements.**
- **Incentive Recommendations** and **Schedule Requests.**
- **Incident & AWOL Reports** and **RFID Issues**, sent to HR.
- **Announcements** for the branch's employees.
- **Payroll Summary:** branch totals only, never individual pay.
- **Branch Reports:** attendance rate, lateness and leave usage, with a PDF.
- **RFID Terminal & Cards:** open the RFID Terminal, manual scan and cards.

### 11.1 Portal and pages

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `AdminLayout` / `AdminPage` | src/app/admin/layout.js, page.js | Frame and entry of the Admin portal. | `children` | Portal | Opening `/admin` | `PortalLayout` | — |
| `AdminPortal` | src/app/admin/admin-portal.jsx | Wraps the pages in the admin session. | none | Portal | Page load | `PortalSessionProvider`, `PasswordGate` | — |
| `AdminScreens` | src/app/admin/admin-portal.jsx | Builds the sidebar (15 pages), checks permissions, records each page visit in the audit trail and shows the page. | none | Page | Navigation | `usePersistedPage`, `logAuditMovement`, `AppShell` | — |
| `allowed` / `refresh` (admin) | src/app/admin/admin-portal.jsx | Page permission check / reload. | page | true-false / none | Navigation, Refresh | `can` | — |
| `useBranchView` / `load` | src/app/admin/oversight-shared.jsx | Loads one oversight view (dashboard, attendance, leaves and so on) for the Admin's branch; the newest request wins. | view, params | Data | Every Admin page | `GET /api/admin/branch-oversight?view=` | — |
| `RequestStatus` / `HistoryButton` / `DecisionCell` / `FiledCell` | src/app/admin/oversight-shared.jsx | A request's status badge / its history dialog / HR's decision and remark / who filed it and when. | request | Elements | Request tables | — | — |
| `FileDialog` / `submit` / `field` | src/app/admin/oversight-shared.jsx | A form dialog for sending something to HR (employee, choice, date, number, text fields), optionally with Endorse / Do not endorse buttons. | fields, callbacks | Dialog | "Send to HR" buttons | `fileRequest` | — |
| `fileRequest` | src/app/admin/oversight-shared.jsx | Sends one request or endorsement to HR. | kind, details | Result | Dialog submit | `POST /api/admin/branch-oversight {action:"file"}` | — |
| `RequestsPage` | src/app/admin/oversight-shared.jsx | A standard "sent to HR" page: the filing button and dialog, plus every request of that kind with its status, decision and history. | kind, fields, labels | Page | Recommendation and report pages | `useBranchView`, `FileDialog` | — |
| `DashboardPage` (admin) | src/app/admin/dashboard-page.jsx | Branch dashboard: today's attendance, who hasn't tapped in, pending leave, headcount and recent activity. Fills the bell summary. | `refreshKey`, callbacks | Page | Sidebar → Branch Dashboard | `useBranchView("dashboard")` | At 8:15 the Admin sees 3 teachers not yet tapped in. |
| `monthStart` / `AttendancePage` (admin) | src/app/admin/attendance-page.jsx | Branch attendance for a date range (view-only), with a "Flag for HR" action on a record. | `refreshKey` | Page | Sidebar → Branch Attendance | `useBranchView("attendance")`, `fileRequest("attendance_flag")` | The Admin flags a suspicious 5:59 AM tap for HR to check. |
| `Recommendation` | src/app/admin/endorsement-pages.jsx | Shows the branch's recommendation on a record. | rec | Badge | Endorsement pages | — | — |
| `LeaveRecommendationsPage` | src/app/admin/endorsement-pages.jsx | Branch leave requests with "Endorse / Do not endorse" and a note (HR still decides). | `refreshKey` | Page | Sidebar → Leave Recommendations | `useBranchView("leaves")`, `fileRequest("leave_endorsement")` | — |
| `TransferEndorsementsPage` | src/app/admin/endorsement-pages.jsx | Transfers into and out of the branch, with Endorse / Do not endorse. | `refreshKey` | Page | Sidebar → Transfer Endorsements | `useBranchView("transfers")`, `fileRequest("transfer_endorsement")` | — |
| `IncidentReportsPage` | src/app/admin/requests-pages.jsx | Report an incident or no-show (it goes to HR's AWOL cases). | `refreshKey` | Page | Sidebar → Incident & AWOL Reports | `RequestsPage` kind `incident_report` | A teacher absent 3 days without notice is reported. |
| `ScheduleRequestsPage` | src/app/admin/requests-pages.jsx | Ask HR to change an employee's schedule or class load from a date. | `refreshKey` | Page | Sidebar → Schedule Requests | `RequestsPage` kind `schedule_request` | — |
| `RfidIssuesPage` | src/app/admin/requests-pages.jsx | Report a lost or broken card or a faulty reader. | `refreshKey` | Page | Sidebar → RFID Issues | `RequestsPage` kind `rfid_issue` | "Main gate reader not reading cards." |
| `OvertimeConfirmationsPage` | src/app/admin/requests-pages.jsx | Confirm overtime or substitute teaching (day, hours, covered for). | `refreshKey` | Page | Sidebar → Overtime & Substitute | `RequestsPage` kind `overtime_confirmation` | Confirming 2 hours of substitute teaching for a sick colleague. |
| `IncentiveEndorsementsPage` | src/app/admin/requests-pages.jsx | Recommend an incentive (₱) or overload (hours) for an employee; HR approves. | `refreshKey` | Page | Sidebar → Incentive Recommendations | `RequestsPage` kind `incentive_endorsement` | — |
| `PayrollSummaryPage` | src/app/admin/branch-pages.jsx | Total payroll cost of the branch per approved period (no individual pay). | `refreshKey` | Page | Sidebar → Payroll Summary | `useBranchView("payroll")` | — |
| `AnnouncementsPage` / `load` / `open` / `save` / `remove` | src/app/admin/branch-pages.jsx | Post, edit or remove (hidden, kept on file) branch announcements. | form | Page / pop-ups | Sidebar → Announcements | `GET`/`POST`/`PATCH /api/announcements` | "No classes on Friday for the faculty seminar." |
| `BranchAnnouncementsCard` | src/app/admin/branch-pages.jsx | Shows the branch's current announcements on the Employee dashboard. | `refreshKey` | Card | Employee dashboard | `GET /api/announcements` | — |
| `addDays` / `BranchReportsPage` / `downloadPdf` | src/app/admin/branch-reports-page.jsx | Branch report for a date range (attendance rate, lateness, leave usage) and its PDF download. | from, to | Page / PDF | Sidebar → Branch Reports | `GET /api/admin/branch-oversight?view=reports[&format=pdf]` | Monthly report for the school director. |
| `timeOnly` / `scanMessage` | src/app/admin/maintenance-page.jsx | "08:05 AM" / the message after a manual scan ("Time In recorded at…", "repeated tap ignored"…). | values | Text | Manual scan | — | — |
| `ScanCard` / `submit` / `onChange` | src/app/admin/maintenance-page.jsx | Manual RFID scan box (a card number or Employee ID) that records attendance from the portal. Auto-submits after 6+ digits and logs the scan. | code | Message | "Record scan" / typing | `POST /api/admin/attendance {manual_entry:true}`, `logAuditMovement` | The reader is broken, so the Admin types the employee's card number. |
| `MaintenancePage` | src/app/admin/maintenance-page.jsx | RFID page: open the RFID Terminal, manual scan and the cards panel (also used by the Super Admin). | options | Page | Sidebar → RFID Terminal & Cards | `RfidTerminalLauncher`, `ScanCard`, `RfidCardsPanel` | — |
| `formatAuditTime` / `Actor` | src/app/admin/audit-logs-page.jsx | Date and time of a log / who did it (name, role, IP). | log | Text / element | Audit page | — | — |
| `AuditLogsPage` / `load` / `exportCsv` | src/app/admin/audit-logs-page.jsx | Audit log viewer with module, action, search and date filters and CSV export (used by the Super Admin's Audit & Monitoring). | filters | Page / CSV | Audit page | `GET /api/admin/audit-logs`, `downloadCsv` | Checking who changed a teacher's salary. |
| `BranchRequestsReview` | src/components/portal/branch-requests-review.jsx | HR's list of the Admins' requests of some kinds, with Resolve / Approve / Reject (with a remark), or read-only. | kinds, title, readOnly, source | Card | HR → Branch Requests, AWOL, Accountant attendance | `GET /api/hr/branch-requests`, `PATCH` | HR resolves an RFID issue: "Replacement card issued." |
| `load` / `decide` (review) | src/components/portal/branch-requests-review.jsx | Load the requests / save HR's decision. | row, decision, note | Pop-up | Page load / decision buttons | `/api/hr/branch-requests` | — |

### 11.2 Admin API routes and helpers (server)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `isDateKey` / `actorName` / `addDays` / `formatDateKey` / `range` | src/app/api/admin/branch-oversight/route.js | Date and name helpers / the from–to range from the address. | values | Values | Internal | — | — |
| `branchRequests` / `attendanceLogs` / `branchLeaves` / `cutoffsFor` | src/app/api/admin/branch-oversight/route.js | Read the branch's requests, attendance, leave and the incentive cutoff of a month. | client, branch | Rows | Views | `branch_admin_requests`, `attendance_logs`, `leave_requests` | — |
| `dashboardView` / `attendanceView` / `leavesView` / `transfersView` / `payrollView` / `reportsView` | src/app/api/admin/branch-oversight/route.js | Build each Admin page's data (payroll: approved-run totals only; reports: attendance rate, lateness, leave usage). | client, branch, staff | View data | GET | `payroll_run_summaries`, `transfer_requests` and the tables above | — |
| `reportPdf` | src/app/api/admin/branch-oversight/route.js | The branch report as a PDF. | report, branch name | PDF | Branch Reports download | `buildTablePdf` | — |
| `GET` (branch oversight) | src/app/api/admin/branch-oversight/route.js | Sends each view (dashboard, attendance, leaves, transfers, payroll, reports, requests, employees, cutoffs), always the caller's branch. The Accountant may read overtime confirmations only. | `view`, filters | Data | Admin pages | functions above, `loadBranchStaff` | — |
| `bad` / `POST` (branch oversight) | src/app/api/admin/branch-oversight/route.js | Files a request or endorsement: attendance flag, leave or transfer endorsement, incident (which also opens an AWOL case for a no-show), schedule request, RFID issue, overtime confirmation, incentive recommendation. Each is checked against the branch; HR (and, for RFID issues, the Super Admin) is notified. | `kind`, employee, ref, decision, note, details | Request | "Send to HR" / Endorse | `branch_admin_requests`, `employee_awol_cases`, `historyEntry`, `notify`, `appendAuditLog` | — |
| `actorName` / `branchOf` / `validate` | src/app/api/announcements/route.js | Poster's name / the caller's branch / checks title, body and category. | values | Values | Announcements | — | — |
| `GET` / `POST` / `PATCH` (announcements) | src/app/api/announcements/route.js | List the branch's announcements (HR sees all, read-only) / post one (notifies every branch employee) / edit or remove one. | values | Announcements | Announcements pages | `branch_announcements`, `notify`, `branchEmployeeIds` | — |
| `GET` / `POST` (audit logs) | src/app/api/admin/audit-logs/route.js | Read audit entries with filters (own branch for Admins) / record a page visit or UI action. | filters / event | Logs / entry | Audit page / page visits | `listAuditLogs`, `appendAuditLog` | — |
| `statusLabel` / `historyEntry` / `shapeRequest` / `requestSummary` | src/lib/branch-requests.js | Status words / one history entry (who, role, when, note) / a request for screens / a one-line summary. | values | Values | Branch requests | `REQUEST_KINDS` | — |
| `loadBranchStaff` | src/lib/branch-requests-server.js | The branch's employees and accountants (names, codes and types only). | client, branch | People | Oversight | `profiles` | — |
| `notify` | src/lib/branch-requests-server.js | Saves bell notifications for a list of people (never fails the action). | client, recipients, message | none | Many routes | `notifications` | — |
| `idsOf` / `hrAccountIds` / `superAdminIds` / `branchEmployeeIds` | src/lib/branch-requests-server.js | IDs of all HR accounts / Super Admins / a branch's active employees. | client | IDs | Notifications | `profiles` | — |
| `notifyEndorsers` | src/lib/branch-requests-server.js | Tell the endorsing Admins HR's decision. | client, kind, IDs | none | HR leave and transfer decisions | `branch_admin_requests`, `notify` | — |
| `shapeLogRow` / `actorColumns` / `isSystemEventModule` | src/lib/audit/store.js | Shape an audit row / who did it (name, role, IP) from the guard / system event check. | values | Values | Audit | — | — |
| `applyFilters` / `buildSummary` | src/lib/audit/store.js | Filter logs in memory / count by status and module. | logs | Logs / summary | Audit list | — | — |
| `appendAuditLog` | src/lib/audit/store.js | Writes one audit entry (who, what module and action, which record, description, status, metadata). Used by almost every change in the system. | payload | Entry | Every important action | `audit_logs` | "Employee Maria Santos was updated by HR." |
| `auditSearchTerm` / `listAuditLogs` | src/lib/audit/store.js | A safe search word / the newest entries matching module, action, words and dates (filtered in the database). | options | Logs, summary | Audit pages | `audit_logs` | — |
## 12. Super Admin Portal (Dashboard, Admin & HR Accounts, Branch Management, Roles, System Maintenance, System Configuration / Settings, Audit & Monitoring, Backup & Recovery)

**Web address:** `/super-admin`
**Who uses it:** The system owner (the Super Admin), across all branches.
**What the pages do:**
- **SA Dashboard:** branch health, users, attendance and payroll overview, system health and database size.
- **Admin & HR Accounts:** create, edit, archive and restore Super Admin, Admin and HR logins.
- **Branch Management:** add, edit, close or delete branches, with an address picker for Philippine regions, provinces, cities and barangays.
- **Roles & Permissions:** the access matrix, read-only.
- **System Maintenance:** the RFID terminal, cards and the manual scan.
- **System Configuration (Settings), in tabs:**
  - General: organization name and BIR employer details.
  - Attendance: the default and per-branch schedules, plus employee work schedules.
  - Payroll: the payslip schedule, the licensed-teacher subsidy and payroll options.
  - Rates: effective-dated rates.
  - Tax & contributions: the tax table and per-employee contributions.
  - Holidays.
  - Security: session timeout, login attempts and password rules.
- **Audit & Monitoring:** every audit entry, with CSV export.
- **Backup & Recovery:** service status and CSV exports.

### 12.1 Portal and pages

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `SuperAdminLayout` / `SuperAdminPage` | src/app/super-admin/layout.js, page.js | Frame and entry of the Super Admin portal. | `children` | Portal | Opening `/super-admin` | `PortalLayout` | — |
| `SuperAdminPortal` / `SuperAdminScreens` | src/app/super-admin/super-admin-portal.jsx | Session wrapper / sidebar (9 pages), permission check and page display. | none | Portal | Page load, navigation | `PortalSessionProvider`, `AppShell` | — |
| `allowed` / `refresh` (SA) | src/app/super-admin/super-admin-portal.jsx | Page permission check / reload. | page | Values | Navigation | `can` | — |
| `databaseSizeRow` / `healthRows` / `HealthList` | src/app/super-admin/dashboard-page.jsx | Database size against the plan (amber from 350 MB, red at the 500 MB limit) / system health rows (tables, users, RFID) / the health list. | system data | Rows | Dashboard, Backup | — | "Database 362 MB of 500 MB" in amber. |
| `activityTone` / `activityTime` | src/app/super-admin/dashboard-page.jsx | Colour and time of an activity row. | row | Values | Dashboard | — | — |
| `DashboardPage` (SA) | src/app/super-admin/dashboard-page.jsx | Organization overview: employees, attendance today, payroll status, health, recent activity, bell summary. | `refreshKey`, callbacks | Page | Sidebar → SA Dashboard | `GET /api/admin/dashboard`, `GET /api/admin/system` | — |
| `lastLogin` / `AccountsPage` / `load` / `branchLabel` | src/app/super-admin/accounts-page.jsx | Last sign-in time / the staff accounts list with role, branch, status and Edit / Add buttons / load users and branches / branch label ("All Branches" for HR and Super Admin). | `refreshKey` | Page | Sidebar → Admin & HR Accounts | `GET /api/admin/users`, `GET /api/admin/branches` | — |
| `useStaffForm` / `reset` / `set` / `blur` | src/app/super-admin/staff-account-dialogs.jsx | Form state with live filtering and on-the-spot error messages for staff forms. | fields, options | Form state | Add/Edit staff dialogs | `cleanStaffField`, `checkStaffFields` | — |
| `SectionTitle` / `useFieldKit` / `branch` / `roleOptions` / `Feedback` / `focusFirstInvalid` | src/app/super-admin/staff-account-dialogs.jsx | Form building blocks: section heading, field builders, branch dropdown, role choices, a feedback line, jump to the first error. | values | Elements | Staff dialogs | — | — |
| `EditStaffDialog` / `save` / `toggleArchive` | src/app/super-admin/staff-account-dialogs.jsx | Edit a staff account (name, role, status, contact, emergency contact, optional new password; reassigning an Admin's branch) / archive or restore it. | user, branches | Dialog / pop-ups | "Edit" | `PATCH /api/admin/users`, `POST /api/admin/branch-employees` | Promoting an HR assistant to HR, or archiving a departed Admin. |
| `CreatedNotice` / `copy` | src/app/super-admin/staff-account-dialogs.jsx | After creating an account, shows the issued default password with a Copy button. | created account | Notice | After "Create" | clipboard | — |
| `AddStaffDialog` / `save` | src/app/super-admin/staff-account-dialogs.jsx | Create a Super Admin, Admin (with a branch) or HR account with a full record; a default password is issued and must be changed at first sign-in. | form | Created account | "Add staff account" | `POST /api/admin/staff-accounts` | Creating the Admin account for a newly opened branch. |
| `loadPhLocations` / `parseLocation` | src/app/super-admin/branches-page.jsx | Load the Philippine address lists on demand / split a saved branch address into region, province, city and barangay. | location text | Parts | Branch dialog | `src/lib/portal/ph-locations.js` (data only) | — |
| `BranchDialog` / `set` / `save` | src/app/super-admin/branches-page.jsx | Add or edit a branch (code, name, address picker, contact, status). | branch | Saved | "Add branch" / "Edit" | `POST`/`PATCH /api/admin/branches` | Adding "SACS Marikina" as a new branch. |
| `BranchesPage` / `load` | src/app/super-admin/branches-page.jsx | Branch list with employee counts, status and Add/Edit. | `refreshKey` | Page | Sidebar → Branch Management | `GET /api/admin/branches`, `GET /api/admin/dashboard` | — |
| `Access` / `RolesPage` | src/app/super-admin/roles-page.jsx | Read-only matrix of what each role can do in each module (a fixed table; the rules themselves are in `src/lib/rbac/permissions.js`). | none | Page | Sidebar → Roles & Permissions | — | — |
| `serviceRows` / `BackupPage` / `load` / `exportData` | src/app/super-admin/backup-page.jsx | Database and service status / exports of employees, all attendance or audit logs as CSV, and the recovery instructions. | type | Page / CSV | Sidebar → Backup & Recovery | `GET /api/admin/system`, `/api/hr/employees`, `/api/hr/attendance?view=all`, `/api/admin/audit-logs` | A monthly safety copy of the employee list. |
| `rateDisplay` / `rateDate` / `holidayDate` / `peso` / `taxFor` / `manilaToday` / `rateHistory` | src/app/super-admin/config-format.js | Display helpers for configuration: a rate's value text, dates, peso, a tax example, today, a rate's version history. | values | Text | Config tabs | — | — |
| `attendanceSection` / `initialValues` / `keyFromDate` / `dateFromKey` / `blankErrors` | src/app/super-admin/config-page.jsx | Settings section name / starting values / date conversions / empty error list. | values | Values | Config | — | — |
| `SettingInputs` / `SectionCard` / `SaveRow` | src/app/super-admin/config-page.jsx | A settings form, a titled card and a Save button with feedback. | fields | Elements | Config | — | — |
| `useSaveConfig` / `save` | src/app/super-admin/config-page.jsx | Saves one settings section. | section, fields | Updated config | Every config "Save" | `PATCH /api/admin/config` | — |
| `SimpleSection` / `change` / `save` | src/app/super-admin/config-page.jsx | General and Security settings (organization name; session timeout, max login attempts, minimum password length, password expiry). | config | Section | Config General / Security | `useSaveConfig` | Shortening the session timeout to 30 minutes. |
| `BirEmployerSection` | src/app/super-admin/config-page.jsx | BIR employer details (TIN, registered name, address) for the 2316 and alphalist. | config | Section | Config → General | `birEmployerErrors`, `useSaveConfig` | — |
| `AttendanceSection` / `resolve` | src/app/super-admin/config-page.jsx | Default and per-branch attendance schedules (start, end, grace, required hours). | config, branches | Section | Config → Attendance | `useSaveConfig` | A branch starting at 7:30 gets its own schedule. |
| `PayrollSection` | src/app/super-admin/config-page.jsx | Payroll options: the Pay Calendar (pay dates) and the payroll sheet header (school name, approver and title). | config | Section | Config → Payroll | `useSaveConfig` | — |
| `ConfigPage` / `load` / `onConfig` | src/app/super-admin/config-page.jsx | The configuration page with its 7 tabs. | `refreshKey` | Page | Sidebar → System Configuration | `GET /api/admin/config`, all sections | — |
| `History` / `valueError` | src/app/super-admin/rates-section.jsx | A rate's history list / checks a new value. | rate | Element / error | Rates tab | `rateHistory` | — |
| `RateDialog` / `set` / `save` | src/app/super-admin/rates-section.jsx | Add a new version of a rate (global, per branch, position or employee) from a date. | rate, value, date, note | Saved version | "Change" on a rate | `POST /api/admin/payroll-rates` | Raising the daily rate from ₱550 to ₱600 from Nov 1. |
| `RatesSection` / `load` | src/app/super-admin/rates-section.jsx | Every payroll rate with its current value, the next period's value and its history. | `refreshKey` | Section | Config → Rates | `GET /api/admin/payroll-rates` | — |
| `exampleFor` / `taxTableError` | src/app/super-admin/tax-section.jsx | A worked tax example for a bracket / checks the tax table rows. | rows | Text / error | Tax tab | `taxFor` | — |
| `TaxTableCard` / `save` | src/app/super-admin/tax-section.jsx | Edit the monthly withholding tax table and save it as a new version from a date. | rows, date, note | Version | "Save tax table" | `POST /api/admin/payroll-settings {kind:"tax_table"}` | — |
| `amountOf` / `ContributionDialog` / `save` | src/app/super-admin/tax-section.jsx | Set one employee's monthly SSS, PhilHealth and Pag-IBIG from a date (blank = default). | row, amounts | Version | "Edit" contribution | `POST /api/admin/payroll-settings {kind:"contribution"}` | — |
| `ContributionsCard` / `amountCell` | src/app/super-admin/tax-section.jsx | Each employee's monthly contributions (set or default). | data | Table | Tax tab | — | — |
| `PayrollSettingsSection` / `load` | src/app/super-admin/tax-section.jsx | Loads and shows the tax table and contributions. | `refreshKey` | Section | Config → Tax & contributions | `GET /api/admin/payroll-settings` | — |
| `manilaYear` / `typeTone` / `HolidaysSection` / `load` / `set` / `removable` | src/app/super-admin/holidays-section.jsx | This year / badge colour / the year's holidays list with add, generate and remove. | year | Section | Config → Holidays | `GET /api/admin/holidays?year=` | — |
| `add` / `generate` / `remove` (holidays) | src/app/super-admin/holidays-section.jsx | Add a holiday or suspension / fill the year with the legal holidays / remove a future one. | form / year / date | Pop-ups | Buttons | `POST`/`DELETE /api/admin/holidays` | Generating 2027 holidays in December. |
| `WEEKDAY` / `PayslipScheduleSection` / `load` / `body` / `save` | src/app/super-admin/payslip-schedule-section.jsx | Payslip schedule settings (generation days of each half, window days, weekend/holiday rules) with a live preview of the next periods' dates, saved as a version. | settings | Section | Config → Payroll | `GET`/`POST /api/admin/payslip-schedule` (preview, save) | — |
| `TeacherSubsidySection` / `load` / `save` / `saveWarning` | src/app/super-admin/teacher-subsidy-section.jsx | Licensed-teacher subsidy settings (amount, year, payout month, proration, advance limit, tax treatment), applying from the next subsidy year / license expiry warning days. | settings | Section | Config → Payroll | `GET`/`POST /api/admin/teacher-subsidy` | — |

### 12.2 Super Admin API routes (server)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `shapeUser` / `fetchUserBranch` / `fetchAllUsers` | src/app/api/admin/users/route.js | A staff account for the list / its branch / all accounts with profiles. | client | Users | Accounts page | `listUsersCached`, `profiles` | — |
| `GET` (users) | src/app/api/admin/users/route.js | Lists accounts in the caller's reach. | session | Users | Accounts page | `fetchAllUsers` | — |
| `PATCH` (users) | src/app/api/admin/users/route.js | Edits, archives or restores an account. Refuses archiving yourself or the last active Super Admin, checks role limits, emergency contact and password rules. | `id`, `action`, fields | Updated account | Edit / Archive / Restore | `denyRoleEscalation`, `validateNewPassword`, Supabase `updateUserById`, `profiles`, `appendAuditLog` | — |
| `POST` (staff accounts) | src/app/api/admin/staff-accounts/route.js | Creates a Super Admin, Admin or HR account with a full record, a STAFF-### ID and an issued default password (must change at first sign-in). | staff form | Account | "Create" | `validateStaffRecord`, `buildDefaultPassword`, `hashTemporaryPassword`, `assignStaffId`, Supabase `createUser`, `profiles`, `appendAuditLog` | — |
| `shapeBranch` / `GET` / `POST` / `PATCH` / `DELETE` (branches) | src/app/api/admin/branches/route.js | List branches (any signed-in user may read names) / add / edit / delete a branch, logged. | branch fields | Branches | Branch Management, dropdowns | `branches`, `appendAuditLog` | — |
| `isAllowedSection` / `rowsToConfig` / `GET` / `PATCH` (config) | src/app/api/admin/config/route.js | Read all settings / save one allowed section (general, payroll, security, attendance and per-branch attendance), refusing anything else; clears the remembered security settings and organization name. | section, fields | Config | Config page | `system_config`, `invalidateSecuritySettings`, `invalidateOrgName`, `appendAuditLog` | — |
| `latestFinalizedPeriod` / `earliestEffectiveDate` / `GET` / `POST` (payroll rates) | src/app/api/admin/payroll-rates/route.js | The latest paid period / the first allowed date for a new version / list every rate with history / add a new version (moved to the next period if it falls in a paid one; never edits or deletes). | rate, scope, value, date | Version | Rates tab | `payroll_rate_configs`, `payroll_entries`, `validateRateInput`, `appendAuditLog` | — |
| `peso` / `latestFinalizedPeriod` / `protectEffectiveDate` / `taxVersions` / `validateTaxRows` / `validateDate` / `listPayrollEmployees` | src/app/api/admin/payroll-settings/route.js | Helpers for the tax table and contribution versions (protect paid periods, validate rows and dates, list employees). | values | Values | Tax tab | `payroll_tax_brackets`, `payroll_contribution_amounts`, `profiles` | — |
| `GET` / `POST` (payroll settings) | src/app/api/admin/payroll-settings/route.js | The tax table in force with versions and every employee's contributions / save a new tax table or an employee's contributions as versions. | `kind`, values | Settings | Tax tab | functions above, `appendAuditLog` | — |
| `nextPeriodStarts` / `preview` / `parseInput` / `load` | src/app/api/admin/payslip-schedule/route.js | The next periods / their dates under some settings / clean the form / read the versions. | values | Values | Payslip schedule | `createPayslipSchedule`, `payroll_schedule_settings` | — |
| `GET` / `POST` (payslip schedule) | src/app/api/admin/payslip-schedule/route.js | Versions, next dates and history / preview or save a new version (the database refuses changes once a period's generation day has arrived; logged with the reason). | settings | Schedule | Payslip schedule section | `payroll_schedule_settings`, `payroll_setting_changes` | — |
| `peso` / `GET` / `POST` (teacher subsidy) | src/app/api/admin/teacher-subsidy/route.js | Subsidy settings versions, this year's totals and history / save a version for the next subsidy year, or the license warning days. | settings | Settings | Subsidy section | `payroll_subsidy_settings`, `payroll_setting_changes`, `system_config` | — |
| `parseEmployeeIdNumber` / `buildEmployeeId` / `normalizePositionForRole` / `shapeEmployee` / `fetchEmployees` | src/app/api/admin/dashboard/route.js | Employee helpers for the dashboard. | values | Employees | Dashboards | `listUsersCached`, `profiles` | — |
| `formatMonthYearLabel` / `buildRecentActivity` / `buildDashboardPayload` | src/app/api/admin/dashboard/route.js | "October 2026" / recent payroll and attendance activity / the dashboard totals. | data | Payload | Dashboards | `payroll_records`, `getAttendancePanels` | — |
| `GET` (admin dashboard) | src/app/api/admin/dashboard/route.js | Totals for the Super Admin dashboard and branch counts. | session | Dashboard | SA Dashboard, Branch Management | functions above | — |
| `GET` (branch reports) | src/app/api/admin/branch-reports/route.js | A read-only summary of attendance, headcount and payroll status for the caller's branch (all branches for the Super Admin). | session | Summary | Branch summaries | `branches`, `profiles`, `attendance_logs`, `payroll_records`, `payroll_entries` | — |
| `fetchSystemStats` / `fetchRfidDevices` / `checkTableExists` | src/app/api/admin/system/route.js | Account counts by role and RFID registration / employees' card numbers / whether core tables exist. | client | Stats | System pages | `listUsersCached`, `profiles` | — |
| `GET` / `PATCH` (system) | src/app/api/admin/system/route.js | System health: user and role counts, table status, database size, RFID list, the 10 latest security events / the old card-edit endpoint, which now answers "use RFID Cards". | session | Status | SA Dashboard, Backup | database function `system_database_size`, `listAuditLogs` | — |
## 13. Roles and Permissions, System Health, Developer Tools, Scripts and Configuration Files

**What this covers:** the single list of who may do what (roles and permissions), the sidebar menu builder, the public health check, the developer-only test inbox, the command-line maintenance scripts (backup, seeding, reset), the daily keep-alive job and the project configuration files.

### 13.1 Roles, permissions and menu (server library)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `full` / `view` / `none` | src/lib/rbac/permissions.js | Shorthands in the permission matrix: full create-read-update-delete / view only / no access, within a scope (all, branch, self). | scope | Permission entry | Building the matrix | — | — |
| `isKnownRole` | src/lib/rbac/permissions.js | Whether a role is one of super_admin, admin, hr, accountant or employee. | role | true/false | Session checks | — | — |
| `permissionFor` / `can` | src/lib/rbac/permissions.js | The permission of a role on a module / whether a role may do an action (read, create, update, delete) on a module. | role, module, action | Entry / true-false | Every request and menu | `ROLE_PERMISSIONS` | `can("employee","process_payroll","read")` is false. |
| `scopeFor` | src/lib/rbac/permissions.js | The reach of a role on a module: all, branch, self or none. | role, module | Scope | Guard | — | An Employee's attendance scope is "self". |
| `isBranchExempt` / `isBranchExemptFor` / `isBranchScoped` | src/lib/rbac/permissions.js | Whether a role sees every branch (overall / on one module) / whether its queries must be limited to a branch. | role, module | true/false | Guard | — | HR sees employee records of every branch. |
| `canManageRole` | src/lib/rbac/permissions.js | Whether one role may create, edit or archive accounts of another role. | actor role, target role | true/false | Account management | `MANAGEABLE_ROLES` | An Admin cannot manage a Super Admin. |
| `allowedModules` | src/lib/rbac/permissions.js | Every module a role can at least read. | role | Modules | Menu building | — | — |
| `assertNoHardDelete` | src/lib/rbac/permissions.js | Safety switch: always throws, so accounts and history records are archived, never destroyed. | entity name | Error | Any code path that would delete history | — | — |
| `iconFor` / `labelFor` / `sectionFor` | src/lib/rbac/menu.js | The icon, label and sidebar section of a module for a role. | module, role | Values | Menu building | — | — |
| `buildMenu` | src/lib/rbac/menu.js | The ordered sidebar menu a role may see. | role | Sections and items | `/api/rbac/me` | `allowedModules` | — |
| `defaultPageFor` / `allowedPagesFor` | src/lib/rbac/menu.js | The first page a portal opens / every page a role may open. | role | Page IDs | `/api/rbac/me` | `can` | — |

### 13.2 Health check and developer tools

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `GET` (health) | src/app/api/health/route.js | Public "is the system up?" check. Makes one tiny database read (which also keeps the free database from pausing) and returns only up or down. | none | Up/down | Uptime monitor, daily keep-alive job | `branches` read | The uptime monitor emails if the site is down. |
| (GitHub Actions job `keep-alive`) | .github/workflows/keep-alive.yml | Calls `/api/health` once a day (9:17 AM Manila), with retries, so the database isn't paused during school breaks. | `HEALTH_URL` variable | Ping | Daily schedule / manual run | `/api/health` | During the summer break the database stays active. |
| `notFound` / `GET` / `POST` (dev mail.tm) | src/app/api/dev/mailtm/route.js | Developer only (off in production): says whether the test inbox reader is on; creates an inbox, lists messages, or waits up to 45 seconds for the latest code. | `action`, address, since | Inbox / messages / code | Code screen's test button, developer tools | `mailtm.service.mjs`, `readPendingLogin` | — |
| `isMailtmEnabled` / `assertEnabled` / `sleep` | src/lib/mail/mailtm.service.mjs | Whether the mail.tm test service is allowed (USE_MAILTM=true and not production) / stop if not / wait. | none | Values | Dev tools | — | — |
| `readStore` / `writeStore` / `normalizeAddress` / `members` | src/lib/mail/mailtm.service.mjs | Read and write the saved test inboxes on this computer / clean an address / read a list reply. | values | Values | Internal | `.runtime/mailtm-inboxes.json` | — |
| `findInbox` / `listSavedInboxes` | src/lib/mail/mailtm.service.mjs | A saved inbox by address / all saved inbox addresses. | address | Inbox / list | Dev tools | — | — |
| `request` / `authorized` / `getDomains` / `getToken` | src/lib/mail/mailtm.service.mjs | Call the mail.tm service (with retries and token refresh) / available domains / an inbox's access token. | method, path | Response | Internal | mail.tm API | — |
| `createInbox` / `addInbox` / `deleteInbox` | src/lib/mail/mailtm.service.mjs | Create a test inbox / remember one made elsewhere / delete one. | prefix, address, password | Inbox | Dev tools | mail.tm API | A developer creates a test inbox for a sample teacher account. |
| `listMessages` / `readMessage` / `stripHtml` / `extractOtp` / `waitForOtp` | src/lib/mail/mailtm.service.mjs | Read messages / one message / strip HTML / find the 6-digit code / poll until a code arrives. | inbox, options | Messages / code | Dev sign-in testing | mail.tm API | — |

### 13.3 Command-line scripts (run by a developer or the system owner, not from a web page)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `main` | scripts/check-supabase-connection.mjs | Checks that the database and login service can be reached with the settings in `.env.local`. | environment | Pass/fail message | `node scripts/check-supabase-connection.mjs` | `profiles`, Supabase Auth | First check after setting up a new computer. |
| `buildProfile` / `profilesSupportsEmployeeId` / `runAdminSeed` / `runAnonSeed` / `main` | scripts/seed-auth-users.mjs | Creates (or updates) the starting accounts (Super Admin, Admin, HR, Accountant, Employee) and their profiles, with or without the admin key. | environment | Accounts | Setup | Supabase Auth, `profiles` | Preparing a demo database for the capstone defense. |
| `parse` / `projectRefOf` / `resetTarget` / `confirmationPhrase` / `liveRefs` / `resetRefusal` / `isConfirmed` | scripts/clean-reset-guard.mjs | Safety checks for the reset script: refuse the live project and production, and require the operator to type `RESET <target>` by hand. | URL, answer | Allowed? | Before a reset | — | — |
| `clearTable` / `cleanProfiles` / `deleteNonSeedAuthUsers` / `main` | scripts/clean-reset.mjs | Clears test data (payroll, attendance, leave, audit) and every account not in the seed list, on a non-live database only. | confirmation | Clean database | `npm` reset command | many tables, `clean-reset-guard.mjs` | Resetting a local test database between test runs. |
| `requireInbox` / `main` | scripts/mailtm-inbox.mjs | Command-line test inboxes: create, add, list, messages, otp, delete. | command arguments | Output | `npm run mailtm -- …` | `mailtm.service.mjs` | — |
| `listAllUsers` / `isAlreadyArchived` / `main` | scripts/purge-archived-employees.mjs | Makes the archived state of archived employee accounts consistent (it no longer hard-deletes, because history must be kept). | environment | Report | Maintenance | Supabase Auth, `profiles` | — |
| `run` / `dump` | scripts/backup/backup-db.mjs | Database backup: writes the roles, schema, data and migration-history files into `backups/<date>/` (needs Docker running). | environment | Backup files | `npm run db:backup` | Supabase CLI `db dump` (pg_dump) | A weekly backup before a major payroll run. |
| (SQL scripts — no functions) | scripts/backup/after-restore.sql, scripts/go-live/clear-test-data.sql, scripts/checks/*.sql | Plain SQL steps: after-restore fixes, go-live test-data clearing (with a dry run) and scenario checks run in a rolled-back transaction. They define no functions. | — | — | Run by hand in the SQL editor | — | — |

### 13.4 Configuration files (no functions)

`next.config.mjs`, `eslint.config.mjs`, `playwright.config.mjs`, `postcss.config.mjs`, `jsconfig.json`, `components.json`, `supabase/config.toml`, `.env.example`, `package.json` and `.vscode/*` hold settings only. None of them defines an application function, so they have no rows in this document.

### 13.5 UI building blocks (`src/components/ui`)

These are standard, reusable interface pieces (from the shadcn/ui library) used on every page. They only draw the screen; none of them reads or saves data.

| File | Components / functions it provides | What they are |
|---|---|---|
| src/components/ui/alert-dialog.jsx | `AlertDialog`, `AlertDialogTrigger`, `AlertDialogPortal`, `AlertDialogOverlay`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogFooter`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogMedia`, `AlertDialogAction`, `AlertDialogCancel` | The "Are you sure?" pop-up and its parts. |
| src/components/ui/alert.jsx | `Alert`, `AlertTitle`, `AlertDescription` | Coloured notice boxes. |
| src/components/ui/avatar.jsx | `Avatar`, `AvatarImage`, `AvatarFallback`, `AvatarBadge`, `AvatarGroup`, `AvatarGroupCount` | Round initials or picture. |
| src/components/ui/badge.jsx | `Badge` | Small label pill. |
| src/components/ui/button.jsx | `Button` | Every button. |
| src/components/ui/calendar.jsx | `Calendar`, `CalendarDayButton` | Month calendar for date pickers. |
| src/components/ui/card.jsx | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` | Content boxes. |
| src/components/ui/chart.jsx | `ChartContainer`, `ChartStyle`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, `ChartLegendContent`, `useChart`, `getPayloadConfigFromPayload` (`THEMES`, `ChartContext`) | Chart frame, colours, tooltips and legends for the dashboards' charts. |
| src/components/ui/checkbox.jsx | `Checkbox` | Tick box. |
| src/components/ui/dialog.jsx | `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogClose`, `DialogOverlay`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription` | Pop-up windows. |
| src/components/ui/dropdown-menu.jsx | `DropdownMenu`, `DropdownMenuPortal`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuGroup`, `DropdownMenuItem`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuLabel`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent` | Drop-down menus (the user menu, the bell). |
| src/components/ui/form.jsx | `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormDescription`, `FormMessage`, `useFormField` (`FormFieldContext`, `FormItemContext`) | Form fields with labels and error messages. |
| src/components/ui/input-otp.jsx | `InputOTP`, `InputOTPGroup`, `InputOTPSlot`, `InputOTPSeparator` | The 6-box code input on the sign-in screen. |
| src/components/ui/input.jsx | `Input` | Text box. |
| src/components/ui/label.jsx | `Label` | Field label. |
| src/components/ui/popover.jsx | `Popover`, `PopoverTrigger`, `PopoverContent`, `PopoverAnchor`, `PopoverHeader`, `PopoverTitle`, `PopoverDescription` | Small floating panels (the date picker). |
| src/components/ui/progress.jsx | `Progress` | Progress bar (imports, leave balance). |
| src/components/ui/select.jsx | `Select`, `SelectGroup`, `SelectValue`, `SelectTrigger`, `SelectContent`, `SelectLabel`, `SelectItem`, `SelectSeparator`, `SelectScrollUpButton`, `SelectScrollDownButton` | Dropdown choice boxes. |
| src/components/ui/separator.jsx | `Separator` | Dividing line. |
| src/components/ui/sheet.jsx | `Sheet`, `SheetTrigger`, `SheetClose`, `SheetPortal`, `SheetOverlay`, `SheetContent`, `SheetHeader`, `SheetFooter`, `SheetTitle`, `SheetDescription` | Slide-in panel (the sidebar on phones). |
| src/components/ui/sidebar.jsx | `SidebarProvider`, `Sidebar`, `SidebarTrigger`, `SidebarRail`, `SidebarInset`, `SidebarInput`, `SidebarHeader`, `SidebarFooter`, `SidebarSeparator`, `SidebarContent`, `SidebarGroup`, `SidebarGroupLabel`, `SidebarGroupAction`, `SidebarGroupContent`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarMenuAction`, `SidebarMenuBadge`, `SidebarMenuSkeleton`, `SidebarMenuSub`, `SidebarMenuSubItem`, `SidebarMenuSubButton`, `useSidebar` (`SidebarContext`); inside the provider: `setOpen`, `toggleSidebar`, `handleKeyDown` (Ctrl/Cmd+B opens or closes the sidebar; the state is remembered in a cookie) | The collapsible green sidebar of every portal. |
| src/components/ui/skeleton.jsx | `Skeleton` | Grey loading placeholder. |
| src/components/ui/sonner.jsx | `Toaster` | Pop-up message area. |
| src/components/ui/switch.jsx | `Switch` | On/off switch. |
| src/components/ui/table.jsx | `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableCell`, `TableCaption` | Table parts. |
| src/components/ui/tabs.jsx | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | Tab bars. |
| src/components/ui/textarea.jsx | `Textarea` | Multi-line text box. |
| src/components/ui/tooltip.jsx | `TooltipProvider`, `Tooltip`, `TooltipTrigger`, `TooltipContent` | Hover hints. |
## 14. Shared Portal Framework (used by every portal page)

**Where it appears:** inside every portal: Super Admin, Admin, HR, Accountant and Employee.
**What it does:** These are the common building blocks every page reuses: the sidebar and top bar, the "who is signed in" session, the 10-second session check, notifications, light/dark mode, Edit Account and Change Password, the first-sign-in password screen, the data tables, date pickers, confirmation pop-ups, error and 404 pages, CSV/Excel/PDF export, and the number, date and peso formatting.

### 14.1 Session, frame and navigation

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `leaveToLogin` | src/components/portal/session.jsx | Clears the browser's copy of the sign-in, ends the server session, then opens the sign-in page. | none | Redirect | Sign-out, or the saved sign-in is missing | `clearLocalSession`, `endServerSession`, `replaceNavigate` | — |
| `persistContext` | src/components/portal/session.jsx | Saves or deletes the signed-in user's display details in the browser. | details | none | Context changes | `localStorage` | — |
| `PortalSessionProvider` | src/components/portal/session.jsx | Wraps every portal. It loads the signed-in user and permissions, sends the wrong role to their own portal, shows the forced change-password screen when needed, and provides `notify`, `can` and `logout` to every page. | `role`, `children`, `gate` | Portal content, or the password gate | Every portal load | `readAuthContext`, `GET /api/rbac/me`, `PasswordGate` | An HR officer opening `/admin` is sent back to `/hr`. |
| (heartbeat effect) | src/components/portal/session.jsx | Every 10 seconds (and when the tab comes back), checks that the session is still valid. If it was replaced or expired, the user is signed out. | none | none | Timer, tab focus | `GET /api/legacy-auth/session`, `requirePasswordChange` | Signing in on another PC signs this browser out within 10 seconds. |
| (activity effect) | src/components/portal/session.jsx | When the user types or clicks (at most once a minute), tells the server the user is active so the idle timeout restarts. | key or pointer events | none | User activity | `GET /api/legacy-auth/session` (activity header) | — |
| (storage effect) | src/components/portal/session.jsx | If the user signs out in another tab, this tab signs out too. | storage event | Redirect | Another tab changes the sign-in | `readAuthContext`, `leaveToLogin` | — |
| (page-show effect) | src/components/portal/session.jsx | When Back/Forward restores a portal page, checks the session is still valid. | `pageshow` event | Redirect if invalid | Browser Back/Forward | `GET /api/rbac/me` | Pressing Back after sign-out cannot reopen the portal. |
| `updateContext` | src/components/portal/session.jsx | Updates the saved display details (for example, after a profile edit). | changes | none | Profile or password changes | `persistContext` | — |
| `logout` | src/components/portal/session.jsx | Signs out: clears saved pages and details, ends the server session, goes to sign-in. | none | Redirect | "Sign out" in the user menu | `leaveToLogin` | — |
| `notify` | src/components/portal/session.jsx | Shows a pop-up message and adds it to the bell's history (last 30). | title, description, type | Pop-up | After saves, errors and so on | `toast` | "Payroll Saved" pop-up after processing a payslip. |
| `can` | src/components/portal/session.jsx | Checks whether the signed-in role may do an action on a module (used to hide buttons and pages). | module, action | true/false | Rendering menus and buttons | permissions from `/api/rbac/me` | The "Approve" button is hidden for users without approval rights. |
| `markRead` | src/components/portal/session.jsx | Marks the bell's notifications as seen. | none | none | Opening the bell | — | — |
| `useSystemName` | src/components/portal/session.jsx | Gives the system name for headers ("SACS Payroll"). | none | Name | Header display | `systemName` | — |
| `usePortalSession` | src/components/portal/session.jsx | Gives any page access to the session tools. | none | Session tools | Used by pages | — | — |
| `usePersistedPage` | src/components/portal/session.jsx | Remembers which sidebar page is open (in the address and the browser) so refresh and Back keep the user's place. | role, allowed pages, default | Current page and a setter | Portal load, sidebar clicks, Back | `localStorage`, browser history | After a refresh, HR stays on "Leave Requests". |
| `urlWithPage` / `onPopState` / `setPage` (inside `usePersistedPage`) | src/components/portal/session.jsx | Build the page address, react to Back/Forward, and switch pages (new history entry, scroll to top). | page | none | Navigation | — | — |
| `PortalLayout` | src/components/portal/portal-layout.jsx | Root of every portal route: theme, fonts and pop-up area. | `children` | Layout | Portal load | `ThemeScope`, `Toaster` | — |
| `useAccountDialogs` | src/components/portal/app-shell.jsx | Lets a page open the Edit Account or Change Password dialog. | none | `{open}` | Profile buttons | — | — |
| `NavLinks` | src/components/portal/app-shell.jsx | Draws the sidebar links the user's role may see, with "waiting" count badges, and closes the menu on phones after a click. | nav, page, `onNavigate`, badges | Sidebar links | Every render | `can` | HR sees "Leave Requests (4)". |
| `AppearanceItems` | src/components/portal/app-shell.jsx | Light / Dark / Device-setting choices in the user menu. | none | Menu items | User menu | `useUiTheme` | — |
| `UserMenu` | src/components/portal/app-shell.jsx | The account menu at the bottom of the sidebar: Profile, Change password, Appearance and Sign out (with confirmation). | `onProfile` | Menu | Clicking the user's name | `useConfirm`, `logout`, `useAccountDialogs` | — |
| `signOut` (in `UserMenu`) | src/components/portal/app-shell.jsx | Asks "Sign out?" and signs out if confirmed. | none | Sign-out | "Sign out" menu item | `confirm`, `logout` | — |
| `formatNotifTime` | src/components/portal/app-shell.jsx | "Just now", "5m ago", "2h ago" or a date. | date | Text | Bell list | — | — |
| `useStoredNotifications` | src/components/portal/app-shell.jsx | Loads saved notifications every minute and can mark them all as read. | none | List, unread count, `markAllRead`, `reload` | Portal load, every 60 seconds | `GET`/`PATCH /api/notifications` | The Accountant sees "HR approved the October 1–15 payroll." |
| `NotificationsMenu` | src/components/portal/app-shell.jsx | The bell: a live summary, saved notifications (click to open the related page) and this session's messages. | summary, `onNavigate` | Dropdown | Bell click | `useStoredNotifications`, `markRead` | — |
| `ThemeIconButton` | src/components/portal/app-shell.jsx | Top-bar button cycling Light → Dark → Device. | none | Button | Click | `useUiTheme` | — |
| `AppShell` | src/components/portal/app-shell.jsx | The frame of every portal page: green sidebar, top bar (title, refresh, bell, theme), content area and the account dialogs. | nav, page, title, `onRefresh`, badges, `children` | Page frame | Every portal | `NavLinks`, `UserMenu`, `NotificationsMenu`, `EditAccountDialog`, `ChangePasswordDialog` | — |
| `PasswordGate` | src/components/portal/password-gate.jsx | The forced "Change your password" screen shown on first sign-in, while the default password (last name + birth date) is still in use. | `ctx`, `updateContext`, `logout` | Screen | Sign-in with a default or expired password | `evaluateRules`, `firstRuleError`, `POST /api/legacy-auth/change-password` | A new employee must replace "Santos01151998!" before seeing the portal. |
| `edit` / `submit` (in `PasswordGate`) | src/components/portal/password-gate.jsx | `edit` clears the error while typing. `submit` checks all three boxes and the rules, saves the new password, then reloads into the portal. | form values | Portal opens | Typing / "Update password & continue" | `apiFetch` | — |

### 14.2 Account dialogs (Edit Account and Change Password)

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `namePart` | src/components/portal/account-dialogs.jsx | Validation rule for a name box (required, allowed characters). | label, required? | Rule | Form set-up | `PERSON_NAME_PATTERN` | — |
| `displayValue` | src/components/portal/account-dialogs.jsx | Shows a stored value: masked IDs stay masked, and digit fields get dashes. | field, value | Text | Filling the form | `formatDigitField`, `isMaskedPii` | SSS shows "12-3456789-0". |
| `valuesFrom` | src/components/portal/account-dialogs.jsx | Builds the form's starting values from the user's details. | details | Form values | Dialog opens | `displayValue` | — |
| `composeName` | src/components/portal/account-dialogs.jsx | Joins first, middle, last and suffix into a full name (optionally capitalized). | name parts, title-case flag | Full name | Saving | — | "juan dela cruz jr." becomes "Juan Dela Cruz Jr." |
| `DigitInput` | src/components/portal/account-dialogs.jsx | Number box that adds dashes as you type and shows the stored mask until you change it. | field, spec | Input | Form display | `formatDigitField` | — |
| `SectionLabel` | src/components/portal/account-dialogs.jsx | Small gold heading inside the form. | text, note | Heading | Display | — | — |
| `EditAccountDialog` | src/components/portal/account-dialogs.jsx | Edit Account dialog: name, mobile, address, emergency contact and government numbers (read-only for Employees and Accountants). | `open`, `onOpenChange`, `payrollReadOnly`, `titleCaseName` | Dialog | "Edit account" button / user menu → Profile | `GET`/`POST /api/legacy-auth/update-profile`, `updateContext`, `notify` | A teacher updates their emergency contact to their spouse. |
| `rememberMasks` | src/components/portal/account-dialogs.jsx | Remembers which fields arrived masked, so unchanged masks are not re-sent. | profile | none | Dialog load | — | — |
| (open effect) | src/components/portal/account-dialogs.jsx | When the dialog opens, loads the latest stored profile and fills untouched fields. | `open` | Filled form | Dialog opens | `GET /api/legacy-auth/update-profile` | — |
| `onSubmit` (Edit Account) | src/components/portal/account-dialogs.jsx | Saves the profile changes (skipping unchanged masked IDs) and updates the header name. | form values | Saved; pop-up "Profile Updated" | "Save information" | `POST /api/legacy-auth/update-profile` | — |
| `nameField` / `digitField` / `selectField` | src/components/portal/account-dialogs.jsx | Build the name, number and dropdown boxes. The name box removes characters that are not allowed and shows a hint. | name, label, options | Form field | Display | `cleanNameInput` | Typing "Ana2" keeps "Ana" and shows "Names can only have letters…". |
| `lastNameCandidates` | src/components/portal/account-dialogs.jsx | Possible last-name forms from a full name. | full name | List | Password rules | — | — |
| `looksLikeDefaultPassword` | src/components/portal/account-dialogs.jsx | Detects the default "LastName + MMDDYYYY + !" password in the browser. | password, details | true/false | Typing a new password | `lastNameCandidates` | — |
| `evaluateRules` | src/components/portal/account-dialogs.jsx | Checks each password rule for the live checklist (length, letters and numbers, uppercase, symbol, no spaces, different, not default, matching). | current, new, confirm, details | Yes/no per rule | Typing | `looksLikeDefaultPassword` | — |
| `firstRuleError` | src/components/portal/account-dialogs.jsx | The message for the first unmet rule. | rules | Message | Submitting | — | "New password must contain at least one uppercase letter." |
| `PasswordInput` | src/components/portal/account-dialogs.jsx | Password box with show/hide. | id, label, value, `onChange` | Input | Display | — | — |
| `ChangePasswordDialog` | src/components/portal/account-dialogs.jsx | 3-step Change Password: current password → emailed code → new password. | `open`, `onOpenChange` | Dialog | User menu → Change password | `start`, `verify`, `resend`, `change` | — |
| `report` / `restart` | src/components/portal/account-dialogs.jsx | Show a message / go back to step 1 (for example, the code expired). | message | none | Step results | — | — |
| `step` | src/components/portal/account-dialogs.jsx | Sends one emailed-code step to the server. | data | Response | Internal | `POST /api/legacy-auth/change-password-otp` | — |
| `start` | src/components/portal/account-dialogs.jsx | Step 1: checks the current password and emails a code (or skips straight to step 3 if no code is needed). | current password | Next step | "Send code" | `step` | — |
| `verify` (Change Password) | src/components/portal/account-dialogs.jsx | Step 2: checks the 6-digit code. | code | Next step | 6th digit / "Verify code" | `step` | — |
| `resend` (Change Password) | src/components/portal/account-dialogs.jsx | Emails a new code (60-second wait). | none | New code | "Resend code" | `step` | — |
| `change` | src/components/portal/account-dialogs.jsx | Step 3: checks the rules and saves the new password. | new, confirm | Success pop-up | "Update password" | `POST /api/legacy-auth/change-password`, `notify` | — |
| `submit` (Change Password) | src/components/portal/account-dialogs.jsx | Runs the right step on Enter or the main button. | form event | Step | Form submit | `start`, `verify`, `change` | — |

### 14.3 Reusable screen pieces

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `useConfirm` | src/components/portal/confirm-dialog.jsx | A "Are you sure?" pop-up that waits for Yes or No. | title, description, labels, destructive? | true/false | Before deleting, approving or signing out | `AlertDialog` | "Reject this payroll run?" |
| `confirm` / `finish` (in `useConfirm`) | src/components/portal/confirm-dialog.jsx | Open the pop-up / return the answer. | options / answer | Promise | Button clicks | — | — |
| `DataTable` | src/components/portal/data-table.jsx | The standard table: search, click-to-sort headers, pages, loading skeleton, empty and error messages. It can also page on the server. | columns, rows, loading, error, `onRetry`, options | Table | Every list page | `EmptyState`, `ErrorState` | The employee list with search "Santos" and 25 rows per page. |
| `sortValueOf` / `compare` | src/components/portal/data-table.jsx | Get a column's sort value / compare two values (numbers, then text with natural number order). | column, row | Value / order | Sorting | — | "SACS-2" sorts before "SACS-10". |
| `toggleSort` | src/components/portal/data-table.jsx | Clicking a header cycles ascending → descending → off. | column | none | Header click | — | — |
| `goTo` / `resize` / `alignClass` | src/components/portal/data-table.jsx | Change page / change rows per page / align a column. | page, size | none | Pager buttons | — | — |
| `BranchGroupedTable` | src/components/portal/branch-grouped-table.jsx | Table with a heading per group (usually per branch, with a count), plus search and pages. | columns, rows, `groupOf`, `groupLabel` | Table | HR reports, transfer lists | `EmptyState` | "Antipolo Main — 48 employees". |
| `BranchLevelGroups` | src/components/portal/branch-level-groups.jsx | Rows grouped by branch, then by level (Preschool, Grade School…), with "select all" boxes on each heading. | columns, rows, group functions, selection | Table | Work Schedules | — | HR ticks "Grade School" in one branch to give them all a new schedule. |
| `toggle` / `headingBox` / `partial` / `count` / `ids` / `selectedIn` (in `BranchLevelGroups`) | src/components/portal/branch-level-groups.jsx | Select or clear a whole group, draw its checkbox, show "3 of 10 selected" and counts. | row list | Selection | Heading checkbox | — | — |
| `keyToDate` / `dateToKey` / `latestMonth` | src/components/portal/date-picker.jsx | Convert between "YYYY-MM-DD" and a calendar date / the furthest month the calendar reaches (10 years ahead). | text / date | Date / text | Date picker | — | — |
| `DatePicker` | src/components/portal/date-picker.jsx | A date box that opens a calendar, with optional earliest and latest dates. | value, `onChange`, min, max | Date field | Forms with dates | `Calendar`, `Popover` | Picking a leave start date. |
| `EmptyState` / `ErrorState` | src/components/portal/empty-state.jsx | Friendly "nothing here yet" / "something went wrong — try again" panels. | title, message, `onRetry` | Panel | Empty or failed loads | — | — |
| `InfoList` | src/components/portal/info-list.jsx | Label/value pairs for profile cards. | items | List | Profile pages | — | — |
| `PageSkeleton` | src/components/portal/lazy-page.jsx | Grey placeholders while a page downloads. | none | Placeholder | Page loading | — | — |
| `StatCard` | src/components/portal/stat-card.jsx | A summary number tile with an icon. | label, value, hint, icon, tone | Card | Dashboards | — | "Present Today: 42". |
| `StatusBadge` | src/components/portal/status-badge.jsx | Coloured status pill with a dot and a label. | tone, text | Badge | Tables | — | — |
| `attendanceTone` / `AttendanceBadge` | src/components/portal/status-badge.jsx | Colour (green On Time, gold Late, red Absent, and so on) and badge for an attendance status. | status | Tone / badge | Attendance tables | `normalizeAttendanceStatus` | — |
| `RequestStatusBadge` / `isPendingRequest` | src/components/portal/status-badge.jsx | Badge for request statuses (Pending, Approved, Rejected, Paid…) / is it still waiting? | status | Badge / true-false | Leave and request lists | — | — |
| `StatusScreen` | src/components/portal/status-screen.jsx | A full-page notice with a "Back to my portal" or "Go to sign in" button. | icon, code, title, description | Page | 404 and error pages | `readAuthContext` | — |
| `NotFoundScreen` | src/components/portal/status-screen.jsx | "Page not found" (Error 404). | none | Page | Unknown address | `StatusScreen` | — |
| `ErrorScreen` | src/components/portal/status-screen.jsx | "This screen could not be loaded" with Try again and a reference code. | error, reset | Page | A page crashes | `StatusScreen` | — |
| `ErrorBoundary` | src/app/error.js | Catches a crashed page and shows `ErrorScreen`. | error, reset | Page | Page crash | `ErrorScreen` | — |
| `GlobalError` | src/app/global-error.js | Last-resort "SACS Payroll is unavailable" page if the whole app fails to start. | error, reset | Page | App start-up failure | — | — |
| `NotFound` | src/app/not-found.js | The 404 page. | none | Page | Unknown address | `NotFoundScreen` | Typing `/payrol` by mistake. |
| `useUrlParam` | src/components/portal/use-url-param.js | Keeps a tab or filter choice in the address (?key=value), so refresh, Back and shared links reopen the same view. | key, default | Value and setter | Tabs and filters | browser history | — |
| `storedEmployeeId` / `setEmployeeParam` | src/components/portal/use-employee-page.js | Remember / put in the address which employee's attendance record is open. | ID | ID / none | Opening a record | `sessionStorage` | — |
| `useEmployeeRecordPage` | src/components/portal/use-employee-page.js | Manages the "Individual Employee Attendance Record" sub-page. It opens an employee and goes back to the list if none is chosen. | current page, setter, page IDs | `employeeId`, `openEmployee`, `navigate` | Clicking an employee in the attendance list | — | HR clicks "Maria Santos" to see her month. |
| `BulkLinesDialog` | src/components/portal/bulk-lines-dialog.jsx | "Many at once" tool: paste one line per item, check every line, run the valid ones one by one with a progress bar, and download a CSV report. | title, `parseLine`, `run`, `onDone` | Dialog | Bulk buttons (cards, schedules, etc.) | `downloadCsv` | Registering 40 RFID cards in one go. |
| `check` / `start` (in `BulkLinesDialog`) | src/components/portal/bulk-lines-dialog.jsx | Check every pasted line (repeats refused) / run the accepted lines. | pasted text | Per-line results | "Check" / "Run" buttons | `parseLine`, `run` | — |
| `classify` | src/components/portal/proof-viewer.jsx | Accepts only safe proof files (PDF/PNG/JPEG data, https or same-site links) and detects image or PDF. | URL | Kind, or nothing | Opening proof | — | — |
| `useProofViewer` / `open` | src/components/portal/proof-viewer.jsx | Opens a leave request's proof document (medical certificate and so on) in a viewer with a Download button. | proof URL | Viewer | "View proof" button | `classify`, `notify` | HR opens the medical certificate attached to a sick-leave request. |
| `Section` | src/components/portal/staff-profile.jsx | A titled card on the profile page. | icon, title | Card | Display | — | — |
| `StaffProfilePage` | src/components/portal/staff-profile.jsx | The Profile page for Admin, HR and Super Admin: name, ID, contact details, emergency contact and masked government numbers, with an Edit account or Change password button. | role label, options | Page | Sidebar → Profile | `GET /api/legacy-auth/update-profile`, `useAccountDialogs` | — |
| `UpcomingHolidaysCard` | src/components/portal/upcoming-holidays.jsx | Dashboard card listing the next 5 holidays or suspensions with "Tomorrow" or "In 12 days". | `refreshKey` | Card | Dashboard load | `GET /api/admin/holidays?upcoming=5` | "Bonifacio Day — Nov 30 · In 12 days". |
| `readStoredTheme` / `systemPrefersDark` | src/components/theme.jsx | Read the saved theme / the device's dark-mode setting. | none | Theme | Page load | `localStorage` | — |
| `ThemeScope` | src/components/theme.jsx | Applies light or dark mode to the page (without a flash on load). | `children` | Themed area | Every page | — | — |
| `setTheme` / `useUiTheme` / `ThemeToggle` | src/components/theme.jsx | Save the theme choice / read it / one button cycling Light, Dark and Device. | theme | none | Theme buttons | `localStorage` | — |
| `useIsMobile` | src/hooks/use-mobile.js | Whether the screen is phone-sized (under 768px). | none | true/false | Sidebar layout | — | — |
| `cn` | src/lib/utils.js | Joins style class names. | class names | Text | Everywhere in the interface | `clsx`, `tailwind-merge` | — |

### 14.4 Talking to the server, and formatting

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `hardNavigate` / `replaceNavigate` | src/lib/portal/api.js | Full page change (with / without a history entry). | URL | none | Sign-in, sign-out, portal changes | — | — |
| `clearLocalSession` | src/lib/portal/api.js | Removes every browser copy of the sign-in. | none | none | Sign-out | `localStorage`, `sessionStorage` | — |
| `signOutLocally` | src/lib/portal/api.js | Signs out in the browser and opens sign-in with a reason. | reason | Redirect | Server says the session ended | `clearLocalSession` | — |
| `requirePasswordChange` | src/lib/portal/api.js | Marks the user as "must change password" and reloads into the password screen. | none | Reload | Server says a password change is required | — | — |
| `apiFetch` | src/lib/portal/api.js | The portals' server call. It automatically signs out on "session ended" and opens the password screen on "change password first". | URL, options | Response | Every portal server call | `signOutLocally`, `requirePasswordChange` | — |
| `fetchJson` | src/lib/portal/api.js | `apiFetch`, then reads the data and turns server errors into readable messages. | URL, options | Data | Most page loads and saves | `apiFetch` | — |
| `jsonBody` | src/lib/portal/api.js | Packs data for a POST, PATCH or DELETE. | method, data | Request options | Saves | — | — |
| `endServerSession` | src/lib/portal/api.js | Tells the server to end the session. | none | none | Sign-out | `POST /api/legacy-auth/logout` | — |
| `logAuditMovement` | src/lib/portal/audit.js | Records a page visit or export in the audit trail (never blocks the action). | event details | none | Page opens, exports, manual scans | `POST /api/admin/audit-logs` | The audit log shows "HR exported the attendance report". |
| `formatPeso` / `formatPesoShort` | src/lib/portal/format.js | "₱ 12,345.00" / "₱ 12,345". | amount | Text | Money display | — | — |
| `formatPhTime` / `formatTime` | src/lib/portal/format.js | Philippine time "08:05 AM" (or "—"). | ISO time | Text | Attendance tables | — | — |
| `formatDateKey` / `weekdayOf` / `formatIssued` | src/lib/portal/format.js | "Mon, Oct 06, 2026" / "Mon" / "October 7, 2026". | date | Text | Dates on screen | — | — |
| `manilaDateKey` | src/lib/portal/format.js | Today's date in Manila as YYYY-MM-DD. | date | Text | Date defaults | — | — |
| `timeInputValue` | src/lib/portal/format.js | "HH:MM" (24-hour) for a time box. | ISO time | Text | Correction forms | — | — |
| `initialsOf` | src/lib/portal/format.js | Two-letter initials. | name | "JD" | Avatars | — | — |
| `normalizeAttendanceStatus` / `attendanceBucket` (browser) | src/lib/portal/format.js | Official status label / calendar colour group (present, late, absent, leave, holiday). | status | Label / group | Calendars and badges | — | — |
| `leaveSummary` | src/lib/portal/format.js | "Sick Leave · Sep 28 – Sep 29, 2026 · With pay · Approved by …". | leave | Text | Calendar tooltips | — | — |
| `holidayLineLabel` | src/lib/portal/format.js | "Bonifacio Day, Nov 30 (8 h)". | holiday line | Text | Payslip holiday lines | — | — |
| `digitsOnly` / `formatDigitGroups` / `formatDigitField` | src/lib/portal/format.js | Keep digits / add dashes in groups / format a field by its type (SSS 2-7-1, Pag-IBIG 4-4-4, PhilHealth 2-9-1, TIN 3-3-3-3, mobile 4-3-4). | value, groups / spec | Text | Number boxes | — | "1234567890" becomes "12-3456789-0" for SSS. |
| `isMaskedPii` / `formatPiiForDisplay` / `formatContactNumber` | src/lib/portal/format.js | Detect a masked ID / show an ID with dashes / show "0917 123 4567". | value | Text | Profile display | — | — |
| `formatDateTime` / `formatTapTime` / `formatDayHeading` / `formatMonthHeading` | src/lib/portal/attendance.js | Date and time formats for attendance ("Oct 07, 2026, 08:01 AM", "08:01:15 AM", "Friday, September 25, 2026", "October 2026"). | date | Text | Attendance pages | — | — |
| `formatMinutes` / `workedMinutes` / `hoursMinutes` / `formatWorked` | src/lib/portal/attendance.js | "12 min" / minutes worked between taps / "2h 02m" / the Hours column. | record or minutes | Text or number | Attendance tables | — | Time In 8:00, Time Out 17:02 shows "9h 02m". |
| `payPeriodLabels` | src/lib/portal/attendance.js | The current and previous semi-monthly pay periods ("October 1-15, 2026"). | count | Labels | Period dropdowns | `todayKey` | — |
| `oneRowPerDay` / `sortByDay` | src/lib/portal/attendance.js | One row per employee per day (a real record beats a "not tapped" placeholder) / newest day first. | rows | Rows | Attendance lists | — | — |
| `branchContext` / `rowBranchId` / `branchLabel` / `sortByBranchDay` | src/lib/portal/attendance.js | Group attendance by the employee's current branch, label branches, sort by branch, then day, then name. | rows | Grouping info | Attendance lists | — | — |
| `countBy` / `branchCounts` / `statusBreakdown` | src/lib/portal/attendance.js | Count rows and statuses per group / per branch for its latest day / "3 On Time · 1 Late". | rows | Counts | Attendance summaries | — | — |
| `matchesEmployee` | src/lib/portal/attendance.js | Search by name, Employee ID, type or card. | row, text | true/false | Attendance search box | — | — |
| `employeeRange` | src/lib/portal/attendance.js | Turns "This week", "This month", "Last month" or "Custom" into from/to dates. | range choice | From, to | Employee record filter | — | — |
| `canCorrect` / `isLogId` / `nowHm` / `reasonError` | src/lib/portal/attendance.js | Can this record be corrected (not a leave day)? / Is it a real record ID? / Manila time now / a reason of at least 5 characters. | row / ID / text | true-false / text | Correction dialogs | — | — |
| `csvCell` / `downloadCsv` | src/lib/portal/attendance.js | Make a cell safe for CSV (blocks spreadsheet formulas) / download rows as a CSV that opens in Excel. | value / file name, headers, rows | Text / file download | "Export CSV" buttons | browser download | HR downloads "attendance-october.csv". |
| `crc32` / `zip` / `escapeXml` / `columnName` / `sheetXml` | src/lib/export/xlsx.js | Build the parts of an Excel file by hand (checksums, ZIP packing, safe text, column letters, sheet content). | data | Bytes / text | Excel exports | node `zlib` | — |
| `buildXlsx` | src/lib/export/xlsx.js | Creates a real .xlsx workbook (bold header, frozen top row, numbers with 2 decimals) from one or more sheets. | sheets | Excel file bytes | "Export Excel" (payroll sheet, alphalist, reports) | `zip`, `sheetXml` | The Accountant downloads the school payroll sheet as Excel. |
| `clipToWidth` | src/lib/export/table-pdf.js | Shortens text with "..." to fit a PDF column. | text, width, size | Text | PDF reports | `textWidth` | — |
| `buildTablePdf` | src/lib/export/table-pdf.js | Creates a landscape A4 PDF report: school title, summary figures, a table across as many pages as needed, and page numbers. | title, subtitle, summary, columns, rows, footer | PDF bytes | "Export PDF" on reports | `pdfText`, `textWidth` | HR prints the monthly attendance summary as a PDF. |

### 14.5 Common server helpers

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `sanitizeError` | src/lib/api-error.js | Turns technical database errors into plain messages ("A record with this information already exists.") and reports them to error monitoring. | error, fallback | Message | Every API error | Sentry `captureException` | Users never see "duplicate key value violates…". |
| `getServiceClient` / `getCachedServiceClient` | src/lib/supabase/admin.js | Create / reuse the trusted server database connection. | none | Database client | Every API route | Supabase | — |
| `createClient` | src/lib/supabase/server.js | A database connection that uses the browser's cookies (used by the developer status page). | none | Client | Supabase status page | `@supabase/ssr` | — |
| `fetchAllRows` | src/lib/supabase/fetch-all.js | Reads every row of a query, 1,000 at a time. | query builder | All rows | Large lists | Supabase | Listing 1,200 employees. |
| `chunkValues` / `fetchAllIn` / `forEachInChunk` | src/lib/supabase/fetch-all.js | Split long ID lists into groups of 100 to avoid "URL too long" errors, then read or update group by group. | values, query | Rows / result | Large branch queries | `fetchAllRows` | — |
| `loadOrgName` / `invalidateOrgName` | src/lib/org-name.js | Read the organization name (remembered for 1 minute) / forget it after a change. | client | Name | Headers, emails, payslips | `system_config` table | — |
| `normalizeOrgName` / `systemName` | src/lib/org-name-format.js | Clean the organization name (max 60 characters) / "SACS" becomes "SACS Payroll". | text | Text | Display | — | — |
| `isPersonName` / `cleanNameInput` | src/lib/person-name.js | Name rule check (letters, spaces, - ' . only) / remove disallowed characters as typed. | text | true-false / cleaned text | Name boxes everywhere | — | — |
| `parseIsoDate` / `todayUtc` / `yearsBetween` / `latestBirthDate` | src/lib/portal/staff-rules.js | Date helpers for staff forms: read a date, today's date, age in years, the latest birth date allowed (18 years ago). | dates | Date / number | Staff account forms | — | — |
| `checkNamePart` / `cleanName` / `cleanAddress` / `emergencySkipped` | src/lib/portal/staff-rules.js | Name check / remove bad name or address characters / skip the emergency contact when editing an account that has none. | values | Message / text / true-false | Staff forms | — | — |
| `STAFF_RULES` (check and clean rules per field) | src/lib/portal/staff-rules.js | Validation for each Add Staff Account field: name, email, role, branch (Admins need one), birth date (18+), hire date, sex, civil status, mobile 09xxxxxxxxx, address, emergency contact (number must differ from own) and password. | field value, all values | Message | Typing in staff forms | — | Refuses a 17-year-old's birth date. |
| `cleanStaffField` / `checkStaffFields` | src/lib/portal/staff-rules.js | Filter a typed value (with a note on what was removed) / check many fields at once. | name, value / fields | Value and note / messages | Typing / saving | `STAFF_RULES` | — |
| `scrub` / `sentryOptions` | src/lib/monitoring/sentry-options.js | Remove personal and payroll data before an error report is sent / error-monitoring settings (off until configured). | event / key | Event / settings | Any app error | Sentry | — |
| `register` / `onRequestError` | src/instrumentation.js | Start server-side error monitoring / report a failed request. | none | none | Server start | Sentry | — |
| `onRouterTransitionStart` (Sentry set-up) | src/instrumentation-client.js | Start browser-side error monitoring. | none | none | Browser load | Sentry | — |
| `SupabaseStatusPage` / `probe` | src/app/supabase-status/page.js | Developer-only page checking that the database and login services are reachable (hidden in production). | none | Status page | Opening `/supabase-status` on a dev machine | Supabase health endpoints | A developer checks the database connection. |

### 14.6 Text clean-up and fonts

| Function | File | Purpose | Inputs | Output | Trigger | Uses (tables / other functions) | Real-world example |
|---|---|---|---|---|---|---|---|
| `normalizeText` | src/lib/auth/normalize.js | Trimmed text, or a fallback when empty. | value, fallback | Text | Almost every API route | — | "  Maria " → "Maria". |
| `normalizeRole` | src/lib/auth/normalize.js | A role name in lowercase (anything unknown becomes "employee"). | value | Role | Display and older routes | — | — |
| `normalizeRoleEmail` | src/lib/auth/normalize.js | A lowercased email, or empty if it isn't shaped like one. | email | Text | Sign-in, accounts | — | — |
| `normalizeDigits` | src/lib/auth/normalize.js | Keeps only digits (optionally capped in length) for ID and phone fields. | value, max length | Digits | Saving government IDs and numbers | — | "12-3456789-0" → "1234567890". |
| (font set-up, no function) | src/lib/fonts.js | Loads the DM Sans and DM Mono fonts used by the portals (exports `fontVariables`). | — | — | Page load | Next.js fonts | — |
| `AccountantPage` / `AdminPage` / `SuperAdminPage` | src/app/accountant/page.js, src/app/admin/page.js, src/app/super-admin/page.js | Entry points that show each portal. | none | Portal | Opening the address | each portal component | — |
## 15. Database Functions and Triggers (Supabase / PostgreSQL, `supabase/migrations`)

**Where they live:** in the database itself. They are created by the 103 migration files in `supabase/migrations`, which contain 162 `CREATE FUNCTION` statements. Some functions are re-defined by later migrations, which leaves **138 unique functions**.
**What they do:** they enforce the rules even if someone bypasses the web pages: the attendance status engine, append-only history, the payroll commit and approval workflow, the RFID card rules, encryption of government ID numbers, sign-in attempt limits and emailed codes, and the scheduled nightly jobs.

**How to read this table:**
- "Trigger function" means it runs automatically when a row is inserted, updated or deleted in a table.
- "Called by" names the web code that calls it (`.rpc(...)`), or "database" when only other database code uses it.
- The migration shown is the first one that created the function. A later migration may have updated it.

### 15.1 Security, roles and branch scoping

| Function | Migration (first) | Purpose | Inputs | Output | Trigger | Called by | Example |
|---|---|---|---|---|---|---|---|
| `drop_column_not_null` | 20260512010000_add_drop_notnull_helper.sql | Helper that removes a NOT NULL rule from a `payroll_entries` column only (an old automatic fix). | table, column | none | Called | database / older API code | — |
| `block_hard_delete` | 20260903010000_rbac_branch_scoping.sql | Trigger function that refuses every DELETE on protected tables (accounts are archived, never removed). | — | Error | Before delete | database | Deleting an employee's profile row fails. |
| `can_reach_branch` | 20260903010000_rbac_branch_scoping.sql | Whether the current user may reach a row of a branch (Super Admin and HR always; others only their own branch). | branch ID | true/false | Called | row-level security policies | — |
| `current_branch_id` | 20260903010000_rbac_branch_scoping.sql | The signed-in user's branch, read from their profile. | — | Branch ID | Called | security policies | — |
| `current_role_name` | 20260903010000_rbac_branch_scoping.sql | The signed-in user's role, read from their profile. | — | Role | Called | security policies | — |
| `has_permission` | 20260903010000_rbac_branch_scoping.sql | Whether the current role has an action on a module (from the `role_permissions` table, respecting "self only" scope). | module, action | true/false | Called | security policies | — |
| `is_super_admin` | 20260903010000_rbac_branch_scoping.sql | Whether the current user is a Super Admin. | — | true/false | Called | security policies | — |
| `get_user_role` | 20260923045144_role_helper_reads_profiles.sql | The current user's role from `profiles` (falls back to "employee"). | — | Role | Called | security helpers | — |
| `stamp_branch_from_employee` | 20260903010000_rbac_branch_scoping.sql | Trigger function that fills in `branch_id` on history rows from the employee's branch. | — | Row | Before insert | database | — |
| `sync_profile_branch_from_assignment` | 20260903010000_rbac_branch_scoping.sql | Trigger function that keeps `employee_branch_assignments` and `profiles.branch_id` in step. | — | Row | On write | database | — |
| `set_updated_at` | 20260923091528_backfill_set_updated_at.sql | Trigger function that stamps `updated_at` with the current time. | — | Row | Before update | database | — |

### 15.2 Profiles, names and protected personal data

| Function | Migration (first) | Purpose | Inputs | Output | Trigger | Called by | Example |
|---|---|---|---|---|---|---|---|
| `compose_full_name` | 20260924010000_profiles_name_parts.sql | Joins first, middle, last and suffix into a full name. | name parts | Text | Called | `profiles_sync_name_parts` | — |
| `is_valid_name_part` | 20260924010000_profiles_name_parts.sql | Checks that a name part contains only allowed characters. | text | true/false | Called | profile constraints | — |
| `split_full_name` | 20260924010000_profiles_name_parts.sql | Splits a full name into first, middle, last and suffix (handles "dela", "de los" and so on). | full name | Name parts | Called | `profiles_sync_name_parts`, backfill | "Juan Dela Cruz Jr." → Juan / Dela Cruz / Jr. |
| `profiles_sync_name_parts` | 20260924010000_profiles_name_parts.sql | Trigger function that keeps the full name and the separate name parts in step. | — | Row | Before insert / update on `profiles` | database | — |
| `profiles_archive_stamp` | 20260924085321_profiles_archive_tracking.sql | Trigger function that clears the archive stamp on an active account and stamps it when archived. | — | Row | Before update on `profiles` | database | — |
| `private.pii_key` | 20260927080000_profiles_pii_encryption.sql | Reads the encryption key for government ID numbers from the database vault. | — | Key | Called | encrypt / decrypt | — |
| `private.encrypt_pii` / `private.decrypt_pii` | 20260927080000_profiles_pii_encryption.sql | Encrypt / decrypt a government ID number. | text / bytes | Bytes / text | Called | `profiles_protect_pii`, `get_profiles_pii` | — |
| `private.mask_pii` | 20260927080000_profiles_pii_encryption.sql | Masks a number except its last 4 digits. | value, visible | "••••••••9012" | Called | profile columns | — |
| `private.pii_plaintext_retired` | 20260927080000_profiles_pii_encryption.sql | Switch telling whether the old plain-text ID columns are retired. | — | true/false | Called | `profiles_protect_pii` | — |
| `private.profiles_protect_pii` | 20260927080000_profiles_pii_encryption.sql | Trigger function that encrypts SSS, PhilHealth, Pag-IBIG and TIN on save and keeps only the last 4 digits readable. | — | Row | Before write on `profiles` | database | HR saves an SSS number; only "••••7890" is readable afterwards. |
| `get_profiles_pii` | 20260927080000_profiles_pii_encryption.sql | Returns the full (decrypted) government IDs for given profiles. Server only. | profile IDs | IDs table | Called | `fetchProfilesPii` (HR employee list, BIR forms) | — |

### 15.3 Attendance engine, holidays, leave and history

| Function | Migration (first) | Purpose | Inputs | Output | Trigger | Called by | Example |
|---|---|---|---|---|---|---|---|
| `attendance_close_days` | 20260926010000_attendance_status_engine.sql | Closes finished days in a range: a Time In without a Time Out becomes Incomplete, and an active employee with no tap and no leave on a working day gets an Absent record. Run nightly and before payroll and attendance views. | from, to | Summary | Called / scheduled job `attendance-nightly-close` every night at 12:05 AM Manila (last 7 days) | `/api/attendance/logs`, payroll, Edge Function | At midnight, teachers who never tapped on Oct 21 are marked Absent. |
| `attendance_hhmm_to_minutes` / `attendance_to_number` | 20260926010000_attendance_status_engine.sql | Convert "HH:MM" to minutes / text to a number. | text | Number | Called | engine | — |
| `attendance_is_rest_day` | 20260926010000_attendance_status_engine.sql | Whether a day is a whole-day holiday or suspension. | day | true/false | Called | engine, AWOL | — |
| `attendance_is_rest_day_on` / `attendance_is_rest_day_for` | 20261013010000_employee_schedules_cutoffs_early_bird.sql | Whether a day is off under given working days / under an employee's own schedule. | day, days / employee | true/false | Called | engine | — |
| `attendance_policy_for` | 20260926010000_attendance_status_engine.sql | A branch's schedule (start, end, grace, hours) with fallbacks to the default. | branch | Schedule | Called | engine | — |
| `attendance_schedule_for` / `attendance_schedules_between` | 20261013010000_employee_schedules_cutoffs_early_bird.sql | The schedule an employee works on one day / on every day of a range (up to 62 days). | employee, branch, day(s) | Schedule rows | Called | `getEmployeeAttendancePolicy`, `loadEmployeeScheduleDays` | — |
| `work_schedule_version_on` | 20261013010000_employee_schedules_cutoffs_early_bird.sql | The version of a work schedule in force on a day. | key, day | Schedule | Called | schedule lookups | — |
| `work_schedules_guard` | 20261013010000_employee_schedules_cutoffs_early_bird.sql | Trigger function: schedules are append-only and never start in the past. | — | Row / error | On write | database | — |
| `attendance_logs_compute_status` | 20260926010000_attendance_status_engine.sql | Trigger function that computes every attendance status (On Time, Early Bird, Late, Undertime, Half Day, Absent, Incomplete, Holiday) and the late and undertime minutes from the schedule. | — | Row | Before write on `attendance_logs` | database | A Time In at 8:20 with an 8:00 start and 15 minutes' grace is stored as "Late, 20 min". |
| `attendance_request_correction` | 20260926010000_attendance_status_engine.sql | An employee asks for a corrected Time Out; the day becomes Pending Correction. | log, employee, time, reason | Correction | Called | `POST /api/attendance/corrections` | — |
| `attendance_review_correction` | 20260926010000_attendance_status_engine.sql | HR or Admin approves (time replaced, status Corrected) or rejects (Incomplete, Absent or Half Day) a request. | correction, decision, resolution, reviewer, note | Correction | Called | `PATCH /api/attendance/corrections` | — |
| `attendance_resolve_record` | 20260926010000_attendance_status_engine.sql | Resolves an Incomplete day: record a time out, or mark Absent or Half Day. | log, resolution, time, reviewer, note | Correction | Called | corrections API | — |
| `attendance_correct_absence` | 20260926040000_absence_corrections.sql | Records the real time in and out of a day marked Absent. | employee, date, times, reviewer, note | Correction | Called | corrections API | — |
| `attendance_correct_record` | 20261002010000_attendance_correct_any_record.sql | Corrects any day (time in, time out, both, or present). | log/employee/date, type, times, reviewer, note | Correction | Called | corrections API | — |
| `attendance_corrections_clear_tap_flag` | 20261002020000_attendance_raw_taps.sql | Trigger function that clears the "tapped after correction" flag once a new correction is approved. | — | Row | After write | database | — |
| `attendance_taps_append_only` | 20261002020000_attendance_raw_taps.sql | Trigger function: raw taps are evidence and can never be edited or removed. | — | Error | Before update / delete | database | — |
| `attendance_logs_capture_history` | 20260927020000_attendance_logs_history.sql | Trigger function that copies every change of an attendance record into `attendance_logs_history`. | — | none | After write | database | — |
| `attendance_logs_change_actor` | 20260927020000_attendance_logs_history.sql | Trigger function that records who made a change and from where. | — | Row | Before write | database | — |
| `block_history_rewrite` | 20260927020000_attendance_logs_history.sql | Trigger function: history is append-only. | — | Error | Before update / delete | database | — |
| `attendance_apply_holiday` | 20261007010000_holiday_calendar.sql | Re-marks a day's attendance after a holiday is added or removed. | day, actor | Records changed | Called | holidays API | — |
| `attendance_seed_holidays` | 20261007010000_holiday_calendar.sql | Fills a year with the holidays fixed by law and the computed ones (Holy Week). | year, name | Number added | Called; also the yearly job `holiday-calendar-next-year` (Dec 1, 12:10 AM Manila) | holidays "Generate" | — |
| `attendance_approved_leave` | 20260928010000_leave_attendance_sync.sql | The approved leave covering a day for an employee. | employee, day | Leave row | Called | `isEmployeeOnLeave` (RFID taps) | — |
| `attendance_leave_date` | 20260928010000_leave_attendance_sync.sql | Reads a leave date stored as text (only well-formed dates). | text | Date | Called | leave functions | — |
| `attendance_sync_leave` | 20260928010000_leave_attendance_sync.sql | Keeps a leave request's On Leave days in step (adds them on approval, removes them on cancellation) and reports days that already have a tap. | leave ID | Summary | Called | `syncLeaveAttendance` | — |
| `leave_requests_sync_attendance` | 20260928010000_leave_attendance_sync.sql | Trigger function that runs the leave sync whenever a request's status changes. | — | none | After update on `leave_requests` | database | — |
| `school_break_kind_on` | 20261015010000_tenure_pay_protection.sql | Which school break (summer or Christmas) a day falls in. | day | Kind | Called | tenure protection | — |

### 15.4 Sign-in security

| Function | Migration (first) | Purpose | Inputs | Output | Trigger | Called by | Example |
|---|---|---|---|---|---|---|---|
| `auth_throttle_check` | 20260927030000_auth_throttle.sql | Seconds a key must wait before trying again (0 = allowed). | key, max, lockout | Seconds | Called | `persistentRetryAfter` | — |
| `auth_throttle_fail` / `auth_throttle_clear` | 20260927030000_auth_throttle.sql | Count a failed attempt / forget a key after success. | key | none | Called | `persistentFailure`, `persistentClear` | — |
| `auth_email_otp_issue` | 20261007020000_email_otp_codes.sql | Stores a new code's fingerprint (5 minutes, 5 tries) unless one was sent less than 60 seconds ago. | key, hash, ttl, cooldown, max | 0 or seconds to wait | Called | `sendEmailOtp` | — |
| `auth_email_otp_verify` | 20261007020000_email_otp_codes.sql | Checks a code: ok (then deleted), invalid, locked or expired. | key, hash, max | Result word | Called | `verifyEmailOtp` | — |
| `auth_email_otp_discard` | 20261007020000_email_otp_codes.sql | Throws away a code whose email could not be sent. | key | none | Called | `sendEmailOtp` | — |

### 15.5 Payroll: rates, commit, schedule, approval runs, corrections

| Function | Migration (first) | Purpose | Inputs | Output | Trigger | Called by | Example |
|---|---|---|---|---|---|---|---|
| `payroll_rate_configs_append_only` | 20260926020000_payroll_rate_configs.sql | Trigger function: rate versions can never be updated or deleted. | — | Error | Before update / delete | database | — |
| `payroll_rate_configs_refuse_retired` | 20261013010000_employee_schedules_cutoffs_early_bird.sql | Trigger function that refuses new versions of the retired per-day Early Bird bonus rate. | — | Error | Before insert | database | — |
| `payroll_commit_entries` | 20260926090000_payroll_legal_rules_and_atomic_commit.sql | Saves payslips all-or-nothing per employee: the record, payslip number (taken under a lock), entry and deduction/incentive lines in one transaction. | items (JSON) | Results | Called | `commitPayrollEntries` | — |
| `payroll_entries_final_lock` | 20261015020000_final_payslip_lock.sql | Trigger function: a Final payslip is never rewritten outside the commit function. | — | Error | Before update | database | — |
| `payroll_entries_follow_employee_branch` | 20261015030000_payroll_entries_follow_employee_branch.sql | Trigger function that moves a reprocessed payslip to the employee's current branch, but never out of a Pending or Approved run. | — | Row | Before update | database | — |
| `payroll_entries_stamp_cutoff` | 20261013010000_employee_schedules_cutoffs_early_bird.sql | Trigger function that stamps which cutoff (first or second) a payslip belongs to. | — | Row | Before insert / update | database | "October 16-31, 2026" → second. |
| `payroll_entries_totals` | 20261022010000_scale_indexes_and_totals.sql | Totals (count, gross, deductions, net) of the payslips matching HR's filters, summed in the database. | period, branch, search | Totals | Called | `GET /api/hr/payroll-records` | — |
| `payroll_append_only` / `payroll_append_only_guard` | 20261009010000 / 20261014010000 | Trigger functions that keep payroll history, snapshots and settings append-only. | — | Error | Before update / delete | database | — |
| `payroll_settings_log` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | Trigger function that logs every settings change (who, when, old, new, reason) into `payroll_setting_changes`. | — | none | After write | database | — |
| `payroll_generation_date_for` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | The generation date of a period under given settings. | start, days, rule | Date | Called | `payroll_schedule_for` | — |
| `payroll_schedule_for` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | A period's generation date, closing date, window days and rule. | period start | Schedule row | Called | schedule logic | — |
| `payroll_schedule_settings_guard` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | Trigger function: a schedule change may apply only to upcoming periods. | — | Error | Before insert | database | — |
| `payroll_period_label` / `payroll_period_start` | 20261014010000_payroll_run_approval.sql | 2026-10-16 → "October 16-31, 2026" / the reverse. | date / label | Label / date | Called | run functions | — |
| `payroll_approval_effective` / `payroll_period_requires_approval` | 20261014010000_payroll_run_approval.sql | The first period that needs HR approval / whether a period needs it. | — / label | Date / true-false | Called | run functions | — |
| `payroll_run_status_for` | 20261014010000_payroll_run_approval.sql | The status of the run a payslip belongs to (branch + period). | branch, label | Status | Called | lock guard | — |
| `payroll_run_action_on` | 20261014010000_payroll_run_approval.sql | Whether the current transaction is one of the official run functions (only they may change runs). | — | true/false | Called | guards | — |
| `payroll_runs_guard` | 20261014010000_payroll_run_approval.sql | Trigger function: a run is never deleted, starts as Draft, changes only via submit/approve/reject (Draft→Pending, Pending→Approved/Rejected, Rejected→Pending), and its branch and period never change. | — | Row / error | On write to `payroll_runs` | database | — |
| `payroll_run_lock_guard` | 20261014010000_payroll_run_approval.sql | Trigger function: no payslip of a Pending or Approved run may be created, changed or removed. | — | Error | On write to payslips | database | The Accountant can't reprocess a payslip while HR is reviewing the run. |
| `payroll_run_actor` / `payroll_run_record` / `payroll_run_notify` | 20261014010000_payroll_run_approval.sql | Who is acting (role, branch) / write history and audit rows / send bell notifications. | actor / run, action / recipients, message | Rows / none | Called | run functions | — |
| `ensure_payroll_run` | 20261014010000_payroll_run_approval.sql | Creates a branch's Draft run for a period if it doesn't exist (Accountant). | branch, label, actor | Run | Called | `submitRun` | — |
| `submit_payroll_run` | 20261014010000_payroll_run_approval.sql | Submits a run: checks the snapshot items match the Final payslips exactly, stores them, sets Pending, and notifies HR. | run, actor, items | Run | Called | `submitRun` | — |
| `approve_payroll_run` / `reject_payroll_run` | 20261014010000_payroll_run_approval.sql | HR approves (payslips released, locked) / rejects with remarks (back to the Accountant). | run, actor, remarks | Run | Called | `PATCH /api/hr/payroll-runs` | — |
| `payroll_pending_run_count` | 20261014010000_payroll_run_approval.sql | Number of runs waiting for HR. | — | Count | Called | database | — |
| `payroll_correction_file` / `payroll_correction_resubmit` / `payroll_correction_decide` / `payroll_correction_step` | 20261022020000_payroll_corrections.sql | File a post-approval correction (Accountant) / resubmit a rejected one / HR approves or rejects / write one history step. | actor, entry, kind, amount, payrolls, reason / decision | Correction | Called | `/api/payroll/corrections` | — |
| `early_bird_threshold_minutes` | 20261013010000_employee_schedules_cutoffs_early_bird.sql | The Early Bird threshold setting (default 15). | — | Minutes | Called | status engine | — |
| `early_bird_lock_on_final` / `early_bird_winners_guard` | 20261013010000_employee_schedules_cutoffs_early_bird.sql | Trigger functions: the first Final payslip of a period locks its winner, and a locked winner can't change. | — | Row / error | On write | database | — |

### 15.6 Loans, cash advances, subsidy, AWOL, licenses, tenure

| Function | Migration (first) | Purpose | Inputs | Output | Trigger | Called by | Example |
|---|---|---|---|---|---|---|---|
| `payroll_loans_open` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | Trigger function that opens a loan; a subsidy advance is checked against and added to the subsidy balance. | — | Row | Before insert on `payroll_loans` | database | — |
| `payroll_loan_payments_apply` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | Trigger function that applies a repayment (never more than the balance; ₱0 balance = paid). | — | Row | On insert | database | — |
| `payroll_cash_advances_read_only` | 20261009030000_cash_advances_read_only.sql | Trigger function that makes the old cash advances table read-only (new advances go under Loans). | — | Error | Before write | database | — |
| `payroll_subsidy_year_for` / `payroll_subsidy_open_year` / `payroll_subsidy_refresh` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | The subsidy year and settings for a day (default calendar year, ₱24,000) / open every eligible teacher's row for the year / open or recompute one teacher's row. | day / employee | Rows | Called / daily job | database | — |
| `payroll_subsidy_settings_guard` / `payroll_subsidy_adjustments_guard` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | Trigger functions: subsidy settings apply only from the next year; adjustments are capped and move only pending → approved/rejected → applied. | — | Error | Before write | database | — |
| `teacher_subsidy_eligible_on` / `teacher_subsidy_months` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | Whether a teacher is eligible on a day (license on, verified, not expired) / which months of a year count (eligible on the 15th). | employee, dates | true-false / months | Called | subsidy functions | — |
| `teacher_license_daily` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | Daily job: license expiry warnings, recording expiries, opening and refreshing subsidy rows. | today | none | Scheduled job `teacher-license-daily` (12:30 AM Manila) | database | — |
| `employee_license_changes_apply` / `employee_license_changes_refresh_subsidy` / `profiles_license_guard` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | Trigger functions: apply a license change to the profile (the only way the fields change), refresh the subsidy at once, and block direct edits of license fields. | — | Row | On insert / update | database (`/api/hr/teacher-license` inserts changes) | — |
| `payroll_subsidy_requests_guard` / `payroll_loans_subsidy_flow_guard` / `payroll_loan_payments_subsidy_flow_guard` / `payroll_subsidy_adjustments_flow_guard` | 20261021010000_subsidy_processing.sql | Trigger functions: subsidy items are written only by the process/decide functions (only on HR's approval). | — | Error | Before write | database | — |
| `payroll_subsidy_adjustments_mark_request` | 20261021010000_subsidy_processing.sql | Trigger function: when payroll pays an approved adjustment, its request reads "Applied to payroll". | — | none | After update | database | — |
| `subsidy_request_process` / `subsidy_request_decide` / `subsidy_requests_raise_excess` | 20261021010000_subsidy_processing.sql | The Accountant processes (or resubmits) a subsidy item / HR approves or rejects it / the system raises settlements for excess advances. | actor, request, details | Request / count | Called | `/api/admin/approvals`, `/api/accountant/loans` | — |
| `awol_flag_candidates` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | Opens an AWOL case for each employee absent on the last N working days in a row (setting `awol_flag_days`, default 3). | through date | Cases opened | Scheduled job `awol-flag-candidates` (12:20 AM Manila) | database | After 3 straight absences, a case appears in HR's AWOL list. |
| `profiles_payroll_hold_sync` | 20261009010000_payslip_schedule_loans_awol_subsidy.sql | Trigger function: AWOL or Separated holds pay; AWOL → Active lifts it (Separated never does). | — | Row | Before update on `profiles` | database | — |
| `tenure_meets_threshold` / `tenure_protection_policy_for` / `tenure_protection_grant_for` | 20261015010000_tenure_pay_protection.sql | Minimum tenure check / the branch's policy / the grant protecting a category on a day. | employee, day, category | Values | Called | database | — |
| `tenure_protection_actor_role` / `tenure_protection_grants_guard` / `tenure_protection_settings_guard` | 20261015010000_tenure_pay_protection.sql | Who is acting / trigger functions limiting writes to HR, Admin and Super Admin and keeping history (never deleted). | — | Role / error | Before write | database | — |
| `tenure_protection_record_applications` | 20261015010000_tenure_pay_protection.sql | Trigger function that records each payslip's waived deductions in `tenure_protection_applications`. | — | none | After payslip write | database | — |
| `apply_transfer_request_approval` | 20260910010000_transfer_requests_and_employee_contact.sql | Trigger function: when a transfer is approved, stamp the review time and move the employee's profile to the new branch. | — | Row | Before update on `transfer_requests` | database | — |
| `restrict_transfer_request_update` | 20260910010000_transfer_requests_and_employee_contact.sql | Trigger function: only status, reviewer, review time and remarks of a transfer may change. | — | Error | Before update | database | — |

### 15.7 RFID cards and terminals, and system health

| Function | Migration (first) | Purpose | Inputs | Output | Trigger | Called by | Example |
|---|---|---|---|---|---|---|---|
| `rfid_actor_for` | 20261021030000_rfid_cards_terminals.sql | Who may act on a branch's cards or terminals (raises if not allowed). | actor, branch, what | Actor | Called | RFID functions | — |
| `rfid_uid_free` | 20261021030000_rfid_cards_terminals.sql | Whether a card number may be used (refuses one in use, lost or replaced). | UID, employee | Status | Called | register / replace | — |
| `rfid_card_register` / `rfid_card_replace` / `rfid_card_set_status` | 20261021030000_rfid_cards_terminals.sql | Register a card / replace it (old one Lost or Replaced) / deactivate, mark lost or reactivate (a reason is required). | actor, employee/card, UID, reason | Card | Called | `/api/rfid/cards`, `separateEmployee` | — |
| `rfid_card_event` | 20261021030000_rfid_cards_terminals.sql | Writes one entry of the card history. | card, action, reason, actor | none | Called | card functions | — |
| `rfid_flow_guard` / `profiles_rfid_uid_guard` | 20261021030000_rfid_cards_terminals.sql | Trigger functions: only the RFID functions write card tables, and `profiles.rfid_uid` always follows the active card. | — | Error / row | Before write | database | — |
| `rfid_terminal_save` / `rfid_terminal_touch` | 20261021030000_rfid_cards_terminals.sql, 20261027040000_rfid_terminals_removed.sql | Since terminal management was removed (October 27, 2026): `rfid_terminal_save` is an intentional guard that refuses every call; it is kept on purpose and must not be removed (database comment added in 20261029030000_rfid_terminal_save_kept_as_guard.sql) / `rfid_terminal_touch` is no longer called. | actor, terminal, fields / result | Error / none | Not called by the app | — | — |
| `system_database_size` | 20261022010000_scale_indexes_and_totals.sql | The database size, for the health panel (warning at 350 MB). | — | Bytes | Called | `/api/admin/system` | — |

## 16. Appendix: Small Inner Helper Functions

These are short helpers written *inside* a bigger function. Nothing calls them directly: they run when their parent function runs, so the trigger is always "when the parent runs". They are listed here so that every function in the code is accounted for.

| Helper | File | What it does (plain language) | Belongs to / used by |
|---|---|---|---|
| `ensureUser` | scripts/seed-auth-users.mjs | Creates one seed sign-in account, or updates it if it already exists. | Seed script |
| `round2` / `totalOf` / `perPayroll` | src/app/accountant/loans-page.jsx | Rounds to centavos / loan total = amount plus interest % / the deduction per payroll (total ÷ number of payrolls, rounded up). | Loans page |
| `HR_TONE` | src/app/admin/endorsement-pages.jsx | Picks the badge colour for HR's decision (approved = green, rejected or cancelled = red, otherwise gold). | Admin recommendations pages |
| `inWindow` | src/app/api/accountant/final-pay/route.js | Checks whether a date falls inside the final pay period (used to count absent and unpaid-leave days). | Final pay route |
| `buildQuery` / `contextPromise` | src/app/api/accountant/payroll/route.js | Build the database queries for the chosen pay period and load them together. | Payroll route |
| `ownSpan` | src/app/api/accountant/payroll/route.js | The attendance window for one employee (shortened for new hires and leavers). | Payroll route |
| `branchDaysFor` | src/app/api/accountant/payroll/route.js | Days worked in each branch after a mid-period transfer. | Payroll route |
| `contributionDefault` / `contributionPct` | src/app/api/accountant/payroll/route.js | The default SSS, PhilHealth or Pag-IBIG amount / the contribution percentage. | Payroll route |
| `itemAmount` / `sumItems` | src/app/api/accountant/payroll/route.js | Amount of one payslip item / total of a list of items. | Payroll route |
| `settle` | src/app/api/accountant/payroll/route.js | The 2nd-half settlement computation. (In src/app/api/accountant/loans/route.js `settle` is only a number: the part of an overpayment applied to the loan balance.) | Payroll route |
| `adjustment` | src/app/api/accountant/payroll/route.js | Makes the override line when the Accountant changes a computed value. | Payroll route |
| `statutory` | src/app/api/accountant/payroll/route.js | Makes one SSS, PhilHealth or Pag-IBIG payslip line. | Payroll route |
| `earn` / `deduct` | src/app/api/accountant/payroll/route.js | Add an earning line / a deduction line to the cutoff payslip. | Payroll route |
| `paymentsFor` | src/app/api/accountant/payroll/route.js | Cash-advance repayments due for an employee. | Payroll route |
| `withRunStatus` | src/app/api/accountant/payroll/route.js | Adds the payroll run's status (Pending, Approved, Rejected) to a record. | Payroll route |
| `fixed` | src/app/api/accountant/payroll/route.js, src/app/api/admin/payroll-settings/route.js, src/app/super-admin/tax-section.jsx, src/lib/payroll/school-sheet.js | Reads a fixed (manually set) contribution amount when there is one. | Payroll, settings, tax table, school sheet |
| `pct` | src/app/api/admin/branch-oversight/route.js (also inside attendance-pay.js, loans.js, payslip-summary.js) | Turns two counts or amounts into a percentage. | Branch oversight and payroll libraries |
| `countStatus` | src/app/api/admin/branch-reports/route.js | Counts attendance rows with one status (e.g. Late). | Branch reports |
| `latestFor` | src/app/api/admin/payroll-settings/route.js | The latest contribution setting for an employee on a date. | Payroll settings route |
| `buildQuery` / `profileName` / `levelRows` / `followed` / `usable` | src/app/api/admin/work-schedules/route.js | Build the schedules query / a schedule's name / assignments for one school level / which schedule an employee actually follows / whether a schedule can be used today. | Work schedules route |
| `buildLogs` / `buildToday` | src/app/api/attendance/logs/route.js, src/app/api/attendance/overtime/route.js | Build the attendance query for the chosen range / for today. | Attendance logs and overtime routes |
| `flagText` / `listMeta` | src/app/api/hr/payroll-runs/route.js | Turns run warning flags into words for the export / loads the branch and period filter lists. | HR payroll runs route |
| `wrongCode` | src/app/api/legacy-auth/reset-password/route.js | Records a wrong reset code and blocks further tries after too many. | Reset password route |
| `entriesQuery` | src/lib/payroll/bir-forms.js | Query for the paid payslips of a year. | BIR forms library |
| `minus` | src/app/employee/payslips-page.jsx, src/lib/payroll/payslip-pdf.js | Shows a deduction with a minus sign. | Payslip page and PDF |
| `csvText` | src/app/employee/timesheet-page.jsx | Builds the timesheet CSV text. | Timesheet download |
| `attempt` | src/app/hr/employees-page.jsx (also admin/employees route, lib/employees/staff-id.js) | Tries again (up to 3 times) when loading or generating fails. | Employee pages and staff ID |
| `branchKey` | src/app/hr/reports-page.jsx | Sorts report rows by branch name (no branch goes last). | HR reports |
| `tick` / `onOnline` / `onOffline` | src/app/rfid-terminal/rfid-terminal.jsx | Updates the kiosk clock every second / sends queued taps when the internet returns / shows the offline banner. | RFID kiosk |
| `mb` / `panel` | src/app/super-admin/dashboard-page.jsx | Shows bytes as MB for the database-size warning / picks a dashboard figure. | Super Admin dashboard |
| `nextCode` | src/app/super-admin/branches-page.jsx | Suggests the next branch code (e.g. "BR-004"). | Branch Management |
| `holidayName` | src/app/super-admin/payslip-schedule-section.jsx | Name of the holiday on a pay date. | Payslip schedule |
| `error` / `valueCell` | src/app/super-admin/rates-section.jsx | Shows a field's error message / shows a rate value and whether it is the default. | Rates settings |
| `dateField` | src/app/super-admin/staff-account-dialogs.jsx | Draws a date picker for an account form. | Admin & HR account dialogs |
| `setCell` / `addRow` / `removeRow` | src/app/super-admin/tax-section.jsx | Edit, add and remove a row in the tax table editor. | Tax settings |
| `shown` | src/components/portal/approvals-page.jsx | Requests of one kind and status for the current tab. | Approvals page |
| `notFuture` / `pair` | src/components/portal/attendance/dialogs.jsx | Blocks a corrected time later than now / shows a "Time In – Time Out" pair in the correction history. | Attendance correction dialogs |
| `tabCount` | src/components/portal/attendance/status-board.jsx | Small number badge on a status tab. | Attendance status board |
| `filtered` | src/lib/audit/store.js (also data-table, status board, grouped tables) | Applies the branch and search filters to a list. | Audit log and tables |
| `onVisible` / `onInput` | src/components/portal/session.jsx | Rechecks the session when the tab is shown again / tells the server the user is active, at most once per renew interval, so the session stays alive. | Portal session |
| `feedbackFor` | src/components/portal/tenure-protection.jsx | Shows the success or error message under the right form. | Tenure Pay Protection |
| `fire` / `onFocus` | src/components/portal/use-live-payroll-runs.js | Refreshes payroll run status half a second after a change / when the window gets focus. | Live payroll runs |
| `scheduleOptions` | src/components/portal/work-schedules.jsx | Builds the schedule dropdown list. | Work schedules |
| `header` / `newPage` / `push` / `cell` | src/lib/export/table-pdf.js | Draws the PDF header, starts a new page, adds a piece to the PDF file being built, draws a table cell. | Table PDF export |
| `push` / `cell` | src/lib/payroll/payslip-pdf.js, src/lib/payroll/bir-2316-pdf.js, src/lib/payroll/bir-2316.js | Add a drawing command / fill a form cell. | Payslip PDF and BIR 2316 |
| `CRC_TABLE` / `cell` / `safeName` | src/lib/export/xlsx.js | Checksum table for the zip file / one spreadsheet cell / a valid sheet name (max 31 characters). | Excel export |
| `waive` / `lateBy` | src/lib/payroll/attendance-pay.js | Removes a deduction covered by a tenure waiver / totals late deductions of one kind. | Attendance pay |
| `byCriteria` | src/lib/payroll/early-bird.js | Compares two employees on the Early Bird ranking rules in order. | Early Bird |
| `statutoryBasis` | src/lib/payroll/payslip-summary.js | Explains where a contribution came from (fixed, per employee or table). | Payslip summary |
| `specificity` | src/lib/payroll/rates.js | Ranks rates so an employee's own rate beats the branch rate and the default. | Rates |
| `isRestDay` / `isWholeDayHoliday` / `forPeriod` / `lockDayFor` | src/lib/payroll/schedule.js | Whether a date is a rest day / a whole-day holiday / a period's generation and cut-off dates / the 2nd-half attendance cut-off day. | Payslip schedule |
| `keyOf` | src/lib/payroll/tenure-protection.js | The date part ("2026-10-22") of a value. | Tenure protection |
| `iso` | src/lib/portal/attendance.js, src/lib/attendance/work-schedules.js | Date as "YYYY-MM-DD". | Attendance helpers |
| `environment` | src/lib/supabase/admin.js | Reads the Supabase address and server key from the settings. | Server database client |

---

## 17. Shared / Reusable Functions Used Across Multiple Pages

These functions are written once and used by many pages. Each one's full row is in the section shown.

### Security and sessions (server)

| Function | Where documented | Used by |
|---|---|---|
| `requirePermission` | 1.6 (src/lib/rbac/guard.js) | Almost every API route: checks the user is signed in and their role may do the action. |
| `denyForeignBranch` / `scopeListToBranch` / `denyRoleEscalation` | 1.6 | Admin, HR and Super Admin routes: keep branch admins inside their branch and stop people giving themselves a higher role. |
| `readSession` / `attachSession` / `clearSession` | 1.6 (src/lib/rbac/session.js) | Sign-in, sign-out and every protected route. |
| `appendAuditLog` | 11.2 (src/lib/audit/store.js) | Every route that changes data (employees, attendance, payroll, schedules, RFID, settings). It records who did what. |
| `sanitizeError` | 14.5 (src/lib/api-error.js) | All API routes: hide technical error details from users. |
| `normalizeText` / `normalizeRoleEmail` / `normalizeDigits` | 14.6 (src/lib/auth/normalize.js) | Nearly every route that reads form input. |

### Database access (server)

| Function | Where documented | Used by |
|---|---|---|
| `getServiceClient` / `getCachedServiceClient` | 14.5 (src/lib/supabase/admin.js) | Every API route that reads or saves data. |
| `fetchAllRows` / `fetchAllIn` / `forEachInChunk` | 14.5 (src/lib/supabase/fetch-all.js) | Large lists such as attendance, payroll and the 1,200-employee reports. |
| `listUsersCached` | 1.5 (src/lib/auth/users-cache.js) | Employee, HR, payroll, RFID and Super Admin routes that need account emails. |
| `loadPayrollStaff` | 10.4 (src/lib/payroll/staff.js) | Payroll, HR payroll approval and reports. |
| `notify` / `notifyEndorsers` | 11.2 (src/lib/branch-requests-server.js) | Leave, transfers, recommendations and RFID issues: send in-app notifications. |

### Talking to the server and showing data (browser)

| Function | Where documented | Used by |
|---|---|---|
| `fetchJson` / `apiFetch` / `jsonBody` | 14.4 (src/lib/portal/api.js) | Every portal page that loads or saves data. |
| `usePortalSession` / `notify` (pop-up message) | 14.1 (src/components/portal/session.jsx) | Every portal page: who is signed in, permissions and pop-up messages. |
| `AppShell` | 14.1 | Frame (sidebar, top bar, notifications) of all five portals. |
| `DataTable` | 14.3 | Lists of employees, attendance, payroll, leave, audit logs and more. |
| `useConfirm` | 14.3 | Every "Are you sure?" step (archive, approve, reject, delete). |
| `StatusBadge` / `AttendanceBadge` / `RequestStatusBadge` | 14.3 | Coloured status labels on all lists. |
| `EmptyState` / `ErrorState` | 14.3 | "Nothing here yet" and "Could not load" messages. |
| `AttendanceStatusBoard` / `useAttendanceActions` | 5.1–5.2 | HR, Admin, Super Admin and Accountant attendance pages. |
| `BranchGroupedTable` / `BranchLevelGroups` | 14.3 | HR, Admin and Super Admin lists grouped by branch and school level. |
| `RfidCardsPanel` | 2.5 | HR, Admin and Super Admin RFID pages. |
| `WorkSchedulesPanel` | 7 | HR, Super Admin and Admin (view only). |
| `TenureProtectionPanel` | 8 | HR, Admin and Super Admin. |

### Formatting, dates and exports

| Function | Where documented | Used by |
|---|---|---|
| `formatPeso` / `formatPesoShort` | 14.4 (src/lib/portal/format.js) | Every page that shows money. |
| `formatTime` / `formatDateKey` / `formatDateTime` / `formatWorked` | 14.4 | Attendance, timesheet, payslip and report pages. |
| `manilaDateKey` | 14.4 and 10.1 | "Today" in Philippine time, for attendance, payroll periods and schedules. |
| `periodForDateKey` / `periodFromLabel` / `nextPeriod` | 10.1 (src/lib/payroll/periods.js) | Payroll pages, payslips and reports. |
| `resolveRate` / `resolveRates` | 10.1 (src/lib/payroll/rates.js) | Payroll computation, settings and the payroll preview. |
| `downloadCsv` | 14.4 (src/lib/portal/attendance.js) | CSV downloads on HR, Admin and Employee pages. |
| `buildXlsx` | 14.4 (src/lib/export/xlsx.js) | Excel exports: payroll runs, reports and the alphalist. |
| `buildTablePdf` | 14.4 (src/lib/export/table-pdf.js) | PDF report exports for HR, Admin and Accountant. |
| `isPersonName` / `cleanNameInput` | 14.5 (src/lib/person-name.js) | Name fields on every account form. |
| `loadOrgName` / `systemName` | 14.5 (src/lib/org-name.js) | Sidebar, payslips, PDFs and emails. |
