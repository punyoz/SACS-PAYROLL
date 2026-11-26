import re, sys, pymupdf
pdf = sys.argv[1]; src = sys.argv[2]
d = pymupdf.open(pdf)
heads = []
for line in open(src, encoding="utf-8"):
    if line.startswith("# ") or line.startswith("## "):
        heads.append(line.split(" ", 1)[1].strip())
heads += ["Appendix A. Sexual and Gender-Based Harassment Complaint Form", "Appendix B. Grievance Form", "Appendix C. Payslip Query Form", "Appendix D. Acknowledgment of Receipt (File Copy)"]
# TOC entries: pages 2-4 of the PDF (index 2..4)
toc_text = "".join(d[i].get_text() for i in range(2, 5))
bad = 0; missing = 0
for h in heads:
    m = re.search(re.escape(h) + r"\s*\.*\s*(\d+)\s*$", toc_text, re.M)
    if not m:
        missing += 1; print("NOT IN TOC:", h); continue
    toc_page = int(m.group(1))
    # actual: first page index >= 5 whose text has the heading as a line
    actual = None
    for i in range(5, len(d)):
        if any(l.strip() == h for l in d[i].get_text().splitlines()):
            actual = i; break
    if actual is None: print("HEADING NOT FOUND:", h); bad += 1
    elif actual != toc_page: print(f"MISMATCH {h}: toc {toc_page} actual {actual}"); bad += 1
print("headings", len(heads), "missing", missing, "wrong", bad)
blank = [i for i in range(len(d)) if len(d[i].get_text().strip()) < 40]
print("near-blank pages:", blank)
emb = {}
for p in d:
    for x in p.get_fonts(): emb[x[3]] = x[1]
print("fonts:", emb)
footers = [re.search(r"Page (\d+) of (\d+)", d[i].get_text()) for i in range(1, len(d))]
print("footer ok:", all(f and int(f.group(1)) == i + 1 and f.group(2) == str(len(d) - 1) for i, f in enumerate(footers)))
