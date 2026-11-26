param([string]$In, [string]$OutDocx, [string]$OutPdf)
$ErrorActionPreference = "Stop"
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($In, $false, $false, $false)
  foreach ($toc in $doc.TablesOfContents) { $toc.Update() }
  $doc.Fields.Update() | Out-Null
  $doc.Repaginate()
  foreach ($toc in $doc.TablesOfContents) { $toc.UpdatePageNumbers() }
  $doc.SaveAs2($OutDocx, 16)   # wdFormatDocumentDefault (.docx)
  $doc.ExportAsFixedFormat($OutPdf, 17, $false, 0, 0, 0, 0, 0, $true, $true, 1, $true, $true, $true)  # PDF, bookmarks from headings
  "pages: " + $doc.ComputeStatistics(2)
  $doc.Close($false)
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
