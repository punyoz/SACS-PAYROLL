"""Render payslip PDFs to PNG at 200% (PyMuPDF), for review screenshots.

  python scripts/checks/payslip-png.py <dir-with-payslip-*.pdf>
"""
import glob
import os
import sys

import pymupdf

folder = sys.argv[1]
for pdf in sorted(glob.glob(os.path.join(folder, "*.pdf"))):
    doc = pymupdf.open(pdf)
    for i, page in enumerate(doc):
        png = pdf[:-4] + (f"-p{i + 1}" if len(doc) > 1 else "") + "-200pct.png"
        page.get_pixmap(matrix=pymupdf.Matrix(2, 2)).save(png)
        print(png)
