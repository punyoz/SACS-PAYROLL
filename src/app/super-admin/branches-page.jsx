"use client";

import * as React from "react";
import { BuildingIcon, CheckCircle2Icon, Loader2Icon, MapPinIcon, PencilIcon, PlusIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { cn } from "@/lib/utils";
import { BRANCH_NAME_MAX } from "@/lib/input-limits";
import { SearchableSelect } from "@/components/portal/searchable-select";
import { DataTable } from "@/components/portal/data-table";
import { parseBranchLocation, regionSlug } from "@/lib/portal/branch-location";

/*
 * Branch Management (loadSABranches / openSABranchModal / submitSABranch,
 * public/legacy/js/super-admin.js): GET /api/admin/branches, the staff count
 * from /api/admin/dashboard, and POST (new) or PATCH { id } to save. The
 * location is stored as "Barangay, City, Province, Region".
 */

const REGION_LABELS = {
  NCR: "NCR – National Capital Region",
  "Region I": "Region I – Ilocos Region",
  CAR: "CAR – Cordillera Administrative Region",
  "Region II": "Region II – Cagayan Valley",
  "Region III": "Region III – Central Luzon",
  "Region IV-A (CALABARZON)": "Region IV-A – CALABARZON",
  "Region IV-B (MIMAROPA)": "Region IV-B – MIMAROPA",
  "Region V": "Region V – Bicol Region",
  "Region VI": "Region VI – Western Visayas",
  "Region VII": "Region VII – Central Visayas",
  "Region VIII": "Region VIII – Eastern Visayas",
  "Region IX": "Region IX – Zamboanga Peninsula",
  "Region X": "Region X – Northern Mindanao",
  "Region XI": "Region XI – Davao Region",
  "Region XII": "Region XII – SOCCSKSARGEN",
  "Region XIII (CARAGA)": "Region XIII – CARAGA",
  BARMM: "BARMM – Bangsamoro Autonomous Region",
};

// The Philippine address lists (~75 KB) load the first time the Branch dialog
// opens, not with the Super Admin portal.
const NO_LOCATIONS = { PH_REGIONS: [], PH_PROVINCES: {}, PH_CITIES: {}, PH_BARANGAYS: {} };
let phLocationsPromise = null;
function loadPhLocations() {
  phLocationsPromise ??= import("@/lib/portal/ph-locations").catch((error) => {
    phLocationsPromise = null;
    throw error;
  });
  return phLocationsPromise;
}

/*
 * Every barangay (alpha test B, 2026-11-09): the bundled list above had
 * barangays for only 188 of 1,634 cities. public/ph-barangays/<region>.json
 * holds the PSA's PSGC list (41,911 barangays, 1,632 cities), keyed
 * "Province|City" so towns with the same name in two provinces never share
 * a list. One region's file (15-60 KB) loads when a city is chosen. A city
 * with no list (Molundo, Sultan Gumander: newer than the PSGC edition used)
 * takes the barangay typed in.
 */
const barangayFiles = new Map();
function loadRegionBarangays(region) {
  const slug = regionSlug(region);
  if (!slug) return Promise.resolve({});
  if (!barangayFiles.has(slug)) {
    barangayFiles.set(slug, fetch(`/ph-barangays/${slug}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => {
      barangayFiles.delete(slug);
      return {};
    }));
  }
  return barangayFiles.get(slug);
}

/** The selects for a stored location string (src/lib/portal/branch-location.js). */
const parseLocation = (location, lists = NO_LOCATIONS) => parseBranchLocation(location, lists, REGION_LABELS);

function BranchDialog({ open, branch, nextCode, onOpenChange, onSaved }) {
  const { notify } = usePortalSession();
  const [values, setValues] = React.useState({ name: "", code: "", status: "Active", region: "", province: "", city: "", barangay: "" });
  const [errors, setErrors] = React.useState({});
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);
  const [ph, setPh] = React.useState(NO_LOCATIONS);
  const { PH_REGIONS, PH_PROVINCES, PH_CITIES, PH_BARANGAYS } = ph;

  React.useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setErrors({});
    setFeedback({ text: "", ok: false });
    setBusy(false);
    setValues(branch
      ? { name: branch.name || "", code: branch.code || "", status: branch.status || "Active", ...parseLocation(branch.location, ph) }
      : { name: "", code: nextCode, status: "Active", region: "", province: "", city: "", barangay: "" });
    // First opening: fetch the address lists, then fill an edited branch's
    // location (the selects stay disabled until they have options).
    if (ph === NO_LOCATIONS) {
      loadPhLocations()
        .then((lists) => {
          if (cancelled) return;
          setPh(lists);
          if (branch) setValues((current) => ({ ...current, ...parseLocation(branch.location, lists) }));
        })
        .catch(() => { if (!cancelled) setFeedback({ text: "Could not load the address lists. Close and reopen the dialog.", ok: false }); });
    }
    return () => { cancelled = true; };
    // ph is read only to know whether the lists are loaded yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, branch, nextCode]);

  const set = (key, value) => {
    setValues((current) => {
      const next = { ...current, [key]: value };
      // Each level resets the ones under it.
      if (key === "region") Object.assign(next, { province: "", city: "", barangay: "" });
      if (key === "province") Object.assign(next, { city: "", barangay: "" });
      if (key === "city") next.barangay = "";
      return next;
    });
    if (errors[key]) setErrors((current) => ({ ...current, [key]: "" }));
  };

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    const name = values.name.trim();
    const nextErrors = {};
    if (!name) nextErrors.name = "Branch name is required.";
    if (!values.city) nextErrors.city = "City / municipality is required.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setFeedback({ text: "Branch name and city / municipality are required.", ok: false });
      document.getElementById(nextErrors.name ? "sa-branch-name" : nextErrors.city && !values.region ? "sa-branch-region" : "sa-branch-city")?.focus();
      return;
    }
    const payload = {
      name,
      location: [values.barangay, values.city, values.province, values.region].filter(Boolean).join(", "),
      code: values.code.trim(),
      status: values.status,
    };
    setBusy(true);
    setFeedback({ text: "Saving…", ok: true });
    try {
      await fetchJson("/api/admin/branches", jsonBody(branch ? "PATCH" : "POST", branch ? { id: branch.id, ...payload } : payload));
      setFeedback({ text: "Branch saved.", ok: true });
      notify(branch ? "Branch Updated" : "Branch Added", `${name} was saved.`, "success");
      await onSaved();
      // Stays disabled until the dialog closes, so a second click cannot add a twin.
      setTimeout(() => onOpenChange(false), 600);
    } catch (error) {
      setFeedback({ text: error.message || "Failed to save branch.", ok: false });
      setBusy(false);
    }
  }

  const provinces = PH_PROVINCES[values.region] || [];
  const cities = PH_CITIES[values.province] || [];
  // The city's barangays from the region's PSGC file (loaded on demand).
  const [regionBarangays, setRegionBarangays] = React.useState({});
  React.useEffect(() => {
    let live = true;
    if (!values.region) { setRegionBarangays({}); return undefined; }
    loadRegionBarangays(values.region).then((data) => { if (live) setRegionBarangays(data || {}); });
    return () => { live = false; };
  }, [values.region]);
  const listed = regionBarangays[`${values.province}|${values.city}`] || PH_BARANGAYS[values.city] || [];
  // The saved barangay always shows, even if a list changes name later.
  const barangays = values.barangay && !listed.includes(values.barangay) ? [values.barangay, ...listed] : listed;
  const typeBarangay = Boolean(values.city) && !listed.length;

  const select = (key, label, options, placeholder, { disabled = false, labels = null } = {}) => (
    <div className="space-y-2">
      <Label htmlFor={`sa-branch-${key}`}>{label}{key === "city" ? <span className="text-destructive" aria-hidden="true"> *</span> : null}</Label>
      <SearchableSelect
        id={`sa-branch-${key}`}
        label={label}
        value={values[key] || ""}
        onValueChange={(value) => set(key, value)}
        disabled={disabled || !options.length}
        placeholder={placeholder}
        searchPlaceholder={`Search ${label.toLowerCase()}…`}
        options={options.map((option) => ({ value: option, label: labels?.[option] || option }))}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `sa-branch-${key}-error` : undefined}
      />
      {errors[key] ? <p id={`sa-branch-${key}-error`} className="text-sm text-destructive">{errors[key]}</p> : null}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{branch ? "Edit branch" : "Add branch"}</DialogTitle>
          <DialogDescription>Choose the branch&apos;s location from region down to barangay. The branch code is assigned automatically.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} noValidate className="grid items-start gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="sa-branch-name">Branch name<span className="text-destructive" aria-hidden="true"> *</span></Label>
            <Input
              id="sa-branch-name"
              maxLength={BRANCH_NAME_MAX}
              value={values.name}
              // Letters, digits, spaces and . ' - only (BRANCH_NAME_PATTERN); anything else is not typed in.
              onChange={(e) => set("name", e.target.value.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ0-9 .'-]/g, ""))}
              placeholder="e.g. Main Campus"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? "sa-branch-name-error" : undefined}
            />
            {errors.name ? <p id="sa-branch-name-error" className="text-sm text-destructive">{errors.name}</p> : null}
          </div>
          {select("region", "Region", PH_REGIONS, "Select region", { labels: REGION_LABELS })}
          {select("province", "Province / district", provinces, values.region ? "Select province / district" : "Choose a region first")}
          {select("city", "City / municipality", cities, values.province ? "Select city / municipality" : "Choose a province first")}
          {typeBarangay ? (
            <div className="space-y-2">
              <Label htmlFor="sa-branch-barangay">Barangay</Label>
              <Input id="sa-branch-barangay" maxLength={80} value={values.barangay} onChange={(e) => set("barangay", e.target.value.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ0-9 .'()-]/g, ""))} placeholder="Type the barangay" aria-describedby="sa-branch-barangay-hint" />
              <p id="sa-branch-barangay-hint" className="text-xs text-muted-foreground">No official list for this town yet: type its barangay.</p>
            </div>
          ) : select("barangay", "Barangay", barangays, values.city ? "Select barangay" : "Choose a city first")}
          <div className="space-y-2">
            <Label htmlFor="sa-branch-code">Branch code</Label>
            <Input id="sa-branch-code" value={values.code} readOnly tabIndex={-1} className="bg-muted font-mono text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sa-branch-status">Status</Label>
            <Select value={values.status} onValueChange={(value) => set("status", value)}>
              <SelectTrigger id="sa-branch-status" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="Active">Active</SelectItem>
                <SelectItem value="Inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p role="status" aria-live="polite" className={cn("min-h-5 text-sm sm:col-span-2", feedback.ok ? "text-muted-foreground" : "text-destructive", feedback.text === "Branch saved." && "text-success")}>{feedback.text}</p>
          <DialogFooter className="gap-2 sm:col-span-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save branch"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BranchesPage({ refreshKey }) {
  const [state, setState] = React.useState({ loading: true, error: null, branches: [], staff: null });
  const [dialog, setDialog] = React.useState({ open: false, branch: null, code: "" });

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: !current.branches.length, error: null }));
    const [branches, dashboard] = await Promise.allSettled([fetchJson("/api/admin/branches?with_counts=1"), fetchJson("/api/admin/dashboard")]);
    setState((current) => ({
      loading: false,
      error: branches.status === "rejected" && !current.branches.length ? branches.reason?.message || "Failed to load branches." : null,
      branches: branches.status === "fulfilled" ? branches.value.branches || [] : current.branches,
      staff: dashboard.status === "fulfilled" ? dashboard.value?.panels?.total_employees ?? null : current.staff,
    }));
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const branchColumns = React.useMemo(() => [
    { key: "name", header: "Branch", sortable: true, mobilePrimary: true, className: "min-w-40 font-medium whitespace-normal", searchValue: (b) => b.name },
    { key: "code", header: "Code", sortable: true, className: "whitespace-nowrap", searchValue: (b) => b.code, cell: (b) => <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{b.code || "—"}</code> },
    {
      key: "location", header: "Location", className: "min-w-56 whitespace-normal", searchValue: (b) => b.location,
      cell: (b) => <span className="flex items-start gap-1.5 text-muted-foreground"><MapPinIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><span className="min-w-0 [overflow-wrap:anywhere]">{b.location || "No location set"}</span></span>,
    },
    { key: "status", header: "Status", sortable: true, searchValue: (b) => b.status, cell: (b) => <StatusBadge tone={b.status === "Active" ? "success" : "danger"}>{b.status}</StatusBadge> },
    { key: "employee_count", header: "Employees", align: "right", sortable: true, className: "tabular-nums", cell: (b) => (b.employee_count ?? "—") },
    {
      key: "actions", header: <span className="sr-only">Actions</span>, align: "right",
      cell: (b) => <Button variant="outline" size="sm" onClick={() => setDialog({ open: true, branch: b, code: "" })} aria-label={`Edit ${b.name}`}><PencilIcon aria-hidden="true" />Edit</Button>,
    },
  ], []);
  const active = state.branches.filter((b) => b.status === "Active").length;
  // Fixed when the dialog opens, so the reload after a save does not reset the form.
  const nextCode = () => `BR-${String(state.branches.length + 1).padStart(3, "0")}`;
  const loading = state.loading;

  return (
    <>
      <section aria-label="Branches" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Total branches" value={state.branches.length} hint="Registered branches" icon={BuildingIcon} tone="info" loading={loading} />
        <StatCard label="Active branches" value={active} hint="Currently operating" icon={CheckCircle2Icon} tone="success" loading={loading} />
        <StatCard label="Total staff" value={state.staff ?? "—"} hint="Across all branches" icon={UsersIcon} loading={loading} />
      </section>

      {/* A table on desktop, cards on phones (DataTable, alpha test B). */}
      <Card className="min-w-0 shadow-xs">
        <CardContent>
          <DataTable
            columns={branchColumns}
            rows={state.branches}
            rowKey={(b) => b.id}
            loading={loading}
            error={state.error}
            onRetry={load}
            searchPlaceholder="Search name, location or code…"
            initialSort={{ key: "name", dir: "asc" }}
            toolbar={<Button onClick={() => setDialog({ open: true, branch: null, code: nextCode() })}><PlusIcon aria-hidden="true" />Add branch</Button>}
            empty={{ icon: BuildingIcon, title: "No branches configured yet", description: "Add the first branch to start assigning staff." }}
            caption="Branches"
            minWidth={820}
          />
        </CardContent>
      </Card>

      <BranchDialog
        open={dialog.open}
        branch={dialog.branch}
        nextCode={dialog.code}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        onSaved={load}
      />
    </>
  );
}
