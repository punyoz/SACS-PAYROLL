// A sent AWOL notice as a PDF (2026-11-24): the stored one (the private awol-notices bucket), or rendered
// from the text kept with the notice. Used by HR's download and by the daily delivery (/api/cron/awol-notices).
import { renderLetterDocument } from "@/lib/export/pdf-doc";

const longDate = (key) => (key ? new Date(`${String(key).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");

/** The PDF from the notice's kept text (title, then paragraphs separated by blank lines). */
export async function renderNoticePdf(notice) {
  const [title, ...rest] = String(notice.body || "").split(/\n\s*\n/);
  return renderLetterDocument({
    title: (title || notice.title || "Notice").trim(),
    paragraphs: rest.map((x) => x.trim()).filter(Boolean),
    footerText: `AWOL case · ${notice.kind === "second" ? "2nd" : "1st"} notice sent ${longDate(notice.sent_on)}`,
  });
}

/** A sent notice's PDF: the stored one, else rendered from its kept text. */
export async function noticePdf(supabase, notice) {
  if (notice.pdf_path) {
    const { data } = await supabase.storage.from("awol-notices").download(notice.pdf_path);
    if (data) return Buffer.from(await data.arrayBuffer());
  }
  return renderNoticePdf(notice);
}
