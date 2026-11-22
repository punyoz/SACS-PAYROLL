"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/portal/date-picker";
import { useUrlParam } from "@/components/portal/use-url-param";
import { fetchJson } from "@/lib/portal/api";
import { EMPLOYMENT_STATUS_OPTIONS } from "@/lib/employees/classification";

/*
 * Filters for every approval list (Part F, 2026-11-22): search by name or ID;
 * type (with counts), status, branch, category (Teaching / Non-Teaching),
 * employment status and a date range; sort by date filed or date requested.
 * Every choice is kept in the address (prefix_q, prefix_type, …), so a refresh
 * or a shared link opens the same view.
 *
 *   get: { name, code?, type?, status?, filed?, requested?, branch?, employeeId? }   accessors per row
 *   The category and employment status come from the employee list (HR), read once.
 */

const ALL = "all";
const SORTS = { filed_desc: "Filed: newest first", filed_asc: "Filed: oldest first", req_asc: "Date requested: soonest first", req_desc: "Date requested: latest first" };
let employeeIndex = null;
let branchList = null;

function useBranchList(enabled) {
  const [list, setList] = React.useState(branchList || []);
  React.useEffect(() => {
    if (!enabled || branchList) return undefined;
    let live = true;
    fetchJson("/api/admin/branches").then((d) => { branchList = d.branches || []; if (live) setList(branchList); }).catch(() => {});
    return () => { live = false; };
  }, [enabled]);
  return list;
}

function useEmployeeIndex(enabled) {
  const [index, setIndex] = React.useState(employeeIndex);
  React.useEffect(() => {
    if (!enabled || employeeIndex) return;
    let live = true;
    fetchJson("/api/hr/employees")
      .then((d) => { employeeIndex = new Map((d.employees || []).map((e) => [String(e.id), e])); if (live) setIndex(employeeIndex); })
      .catch(() => { if (live) setIndex(new Map()); });
    return () => { live = false; };
  }, [enabled]);
  return index;
}

const day = (v) => String(v || "").slice(0, 10);

export function useApprovalFilters(rows, { prefix, get, typeLabel = "Type", statuses = null, people = true }) {
  const branches = useBranchList(Boolean(get.branch));
  const [q, setQ] = useUrlParam(`${prefix}_q`, "");
  const [type, setType] = useUrlParam(`${prefix}_type`, ALL);
  const [status, setStatus] = useUrlParam(`${prefix}_status`, ALL);
  const [branch, setBranch] = useUrlParam(`${prefix}_branch`, ALL);
  const [cat, setCat] = useUrlParam(`${prefix}_cat`, ALL);
  const [emp, setEmp] = useUrlParam(`${prefix}_emp`, ALL);
  const [from, setFrom] = useUrlParam(`${prefix}_from`, "");
  const [to, setTo] = useUrlParam(`${prefix}_to`, "");
  const [sort, setSort] = useUrlParam(`${prefix}_sort`, "filed_desc");
  const index = useEmployeeIndex(people && Boolean(get.employeeId));
  const person = React.useCallback((r) => (get.employeeId && index ? index.get(String(get.employeeId(r))) : null), [get, index]);

  const list = React.useMemo(() => (Array.isArray(rows) ? rows : []), [rows]);
  const counts = React.useMemo(() => list.reduce((acc, r) => {
    const t = get.type ? get.type(r) || "Other" : null;
    if (t) acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {}), [list, get]);

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = list.filter((r) => {
      if (needle && !`${get.name?.(r) || ""} ${get.code?.(r) || ""}`.toLowerCase().includes(needle)) return false;
      if (type !== ALL && get.type && (get.type(r) || "Other") !== type) return false;
      if (status !== ALL && get.status && String(get.status(r)) !== status) return false;
      if (branch !== ALL && get.branch && String(get.branch(r) || "") !== branch) return false;
      const p = person(r);
      if (cat !== ALL && String(p?.employee_type || "Teaching").toLowerCase() !== cat) return false;
      if (emp !== ALL && String(p?.employment_status || "") !== emp) return false;
      const requested = day(get.requested?.(r) || get.filed?.(r));
      if (from && requested && requested < from) return false;
      if (to && requested && requested > to) return false;
      return true;
    });
    const key = sort.startsWith("req") ? (r) => day(get.requested?.(r)) : (r) => String(get.filed?.(r) || "");
    const factor = sort.endsWith("asc") ? 1 : -1;
    return [...out].sort((a, b) => factor * key(a).localeCompare(key(b)));
  }, [list, q, type, status, branch, cat, emp, from, to, sort, get, person]);

  const toolbar = (
    <div className="flex flex-wrap items-end gap-2" data-testid={`${prefix}-filters`}>
      <Input aria-label="Search name or ID" className="w-full sm:w-56" placeholder="Search name or ID…" value={q} onChange={(e) => setQ(e.target.value)} />
      {get.type ? (
        <Select value={type} onValueChange={setType}>
          <SelectTrigger aria-label={typeLabel} className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every {typeLabel.toLowerCase()} ({list.length})</SelectItem>
            {Object.entries(counts).map(([t, n]) => <SelectItem key={t} value={t}>{t} ({n})</SelectItem>)}
          </SelectContent>
        </Select>
      ) : null}
      {get.status && statuses ? (
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="Status" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>Any status</SelectItem>{Object.entries(statuses).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
        </Select>
      ) : null}
      {get.branch && branches.length > 1 ? (
        <Select value={branch} onValueChange={setBranch}>
          <SelectTrigger aria-label="Branch" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>All branches</SelectItem>{branches.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}</SelectContent>
        </Select>
      ) : null}
      {get.employeeId && people ? (
        <>
          <Select value={cat} onValueChange={setCat}>
            <SelectTrigger aria-label="Category" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>Any category</SelectItem><SelectItem value="teaching">Teaching</SelectItem><SelectItem value="non-teaching">Non-Teaching</SelectItem></SelectContent>
          </Select>
          <Select value={emp} onValueChange={setEmp}>
            <SelectTrigger aria-label="Employment status" className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>Any employment status</SelectItem>{EMPLOYMENT_STATUS_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
          </Select>
        </>
      ) : null}
      {get.requested || get.filed ? (
        <>
          <div className="w-40"><DatePicker aria-label="From" value={from} max={to || undefined} onChange={setFrom} placeholder="From" /></div>
          <div className="w-40"><DatePicker aria-label="To" value={to} min={from || undefined} onChange={setTo} placeholder="To" /></div>
        </>
      ) : null}
      <Select value={sort} onValueChange={setSort}>
        <SelectTrigger aria-label="Sort" className="w-56"><SelectValue /></SelectTrigger>
        <SelectContent>{Object.entries(SORTS).filter(([k]) => (k.startsWith("req") ? Boolean(get.requested) : Boolean(get.filed))).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
  return { rows: filtered, toolbar, counts };
}
