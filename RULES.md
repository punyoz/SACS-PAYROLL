# AI System Instructions & Boundaries

## 1. STRICT DIRECTIVE: Do Not Delete Code
*   **Never remove, comment out, or overwrite any existing functions, variables, or logic** unless explicitly instructed to do so in the prompt.
*   Always assume existing code is required for other parts of the application. 
*   Do not refactor unrelated code just to make it look cleaner.

## 2. Scope of Work
*   Focus strictly on the specific task prompted.
*   **Append or integrate** new code seamlessly without breaking the existing file structure.
*   If a requested task absolutely requires modifying or deleting an existing function to work, you must pause and ask for my permission before proceeding.

## 3. STRICT DIRECTIVE: UI & Design Consistency
*   **Never alter the existing overall UI design or styling** when adding new features.
*   Match the current aesthetic perfectly. For example, maintain the established simple but creative styling, preserve any specific "summer" or "pantropiko" themes, and match existing color palettes. 
*   Ensure all newly added UI elements (like buttons, widgets, or forms) are styled to look like they natively belong exactly as the current ones do.
*   Ensure any new UI additions remain fully responsive and adapt seamlessly across desktop, tablet, and mobile, just like the rest of the project.

## 4. Payroll Rate Rules (alpha test Part E, 2026-11-09)
*   **HR and the Super Admin** change the government rates (SSS, PhilHealth, Pag-IBIG) and the daily rate. Every other payroll rule stays the Super Admin's.
*   The **hourly rate is always the daily rate ÷ 8**, never typed. The **withholding tax table is fixed by law**: HR never edits it (only the Super Admin keeps its version table).
*   A change is always a **new effective-dated version** (never an edit or delete), for **future pay periods only**, with a **required reason**. Old and new values go to the audit log, and the Super Admin is notified when HR makes a change.
*   **Nobody changes a rate set for themselves.** Another HR or the Super Admin does it, and the audit log records the fallback.
*   Enforce every rule on the **server and in the database**, not only in the UI.
