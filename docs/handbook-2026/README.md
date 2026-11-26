# Employee Handbook 2026 (draft)

Documents only. Nothing in the payroll system, the database or any payslip was changed.

| File | What it is |
|---|---|
| `Employee-Handbook-2026.docx` | The handbook (Word): cover, acknowledgment, table of contents, sections 1–11, Appendices A–D, page numbers |
| `Employee-Handbook-2026.pdf` | PDF copy (fonts embedded, bookmarks) |
| `handbook-source.md` | The handbook text the .docx is built from (edit this, then rebuild) |
| `01-system-facts.md` | Step 1: how the system works today |
| `02-mapping-table.md` | Step 2: reference section → our version (approved 26 Nov 2026) |
| `03-needs-school-decision.md` | Every [TO CONFIRM] with its default |
| `04-system-vs-handbook-mismatches.md` | Where the system and the handbook differ (separate tasks) |
| `05-legal-sources.md` | Legal figures, sources and items to verify |
| `build/` | `build.js` (docx-js), `word-finish.ps1` (Word: TOC, page numbers, PDF), `verify.py` (TOC pages, blanks, fonts, footers) |

Rebuild: `node build/build.js handbook-source.md raw.docx` (needs `npm install docx@9.5.1`), then
`powershell -File build/word-finish.ps1 -In <abs>\raw.docx -OutDocx <abs>\Employee-Handbook-2026.docx -OutPdf <abs>\Employee-Handbook-2026.pdf`,
then `python build/verify.py Employee-Handbook-2026.pdf handbook-source.md`.
