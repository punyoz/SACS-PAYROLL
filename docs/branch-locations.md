# Branch locations: regions to barangays

Alpha test B, 2026-11-09.

**The gap:** the bundled address list (`src/lib/portal/ph-locations.js`) had barangays for only 188 of the 1,634 cities and municipalities. It was also keyed by town name alone, so the 116 town names used in more than one province (for example San Juan, Batangas and San Juan, Metro Manila) shared one list.

**The fix:** `public/ph-barangays/<region>.json` holds the PSA's Philippine Standard Geographic Code (PSGC) barangays, keyed `"Province|City"`. That covers 41,911 barangays across 1,632 towns.
- Each region's file is 15–60 KB and loads only when a city is chosen in the Branch dialog.
- Molundo and Sultan Gumander (Lanao del Sur) are newer than the PSGC edition used. For these two, the dialog asks for the barangay to be typed.
- Old names are matched to their PSGC entries, for example Bumbaran → Amai Manabilang, Banguingui → Tongkil, Leon B. Postigo → Bacungan, and Datu Montawal → Pagagawan. Maguindanao del Norte / del Sur are read from the single Maguindanao list in that edition.

**Rebuild:** `scripts/data/build-ph-barangays.py`. The source is https://psgc.gitlab.io/api/, a public mirror of the PSA PSGC.

**Region bug fixed:** a saved location in Region IV-A, II or III was read back as Region I, which emptied the province and city on Edit. The region is now matched exactly, by its label, or by the longest whole name (`src/lib/portal/branch-location.js`).
