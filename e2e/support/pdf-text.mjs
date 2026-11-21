// The text a PDF viewer shows (pdfjs-dist, as tests/helpers/pdf-read.js),
// for specs: the payslip PDFs compress their text since 2026-11-19.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function pdfText(buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false }).promise;
  const parts = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const content = await (await doc.getPage(n)).getTextContent();
    parts.push(content.items.map((item) => item.str).join(" "));
  }
  return parts.join(" ").replace(/\s+/g, " ");
}
