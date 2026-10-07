"use client";

import * as React from "react";

/*
 * The Individual Employee Attendance Record sub-page of the Admin, HR and
 * Super Admin portals. The employee lives in ?employee= and in this session
 * (attEmployeeStoredId, public/legacy/js/app.js), so a refresh reopens it;
 * leaving the page drops ?employee=.
 */
const EMPLOYEE_KEY = "sacs-att-employee";

function storedEmployeeId() {
  try {
    return new URLSearchParams(window.location.search).get("employee") || sessionStorage.getItem(EMPLOYEE_KEY) || "";
  } catch {
    return "";
  }
}

function setEmployeeParam(value) {
  const params = new URLSearchParams(window.location.search);
  if (value) params.set("employee", value);
  else if (params.has("employee")) params.delete("employee");
  else return;
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

/**
 * @param current    the page on screen
 * @param setPage    the portal's page setter
 * @param recordPage the record sub-page id (e.g. "hr-att-employee")
 * @param backPage   where the record page returns to (e.g. "hr-attendance")
 */
export function useEmployeeRecordPage(current, setPage, recordPage, backPage) {
  const [employeeId, setEmployeeId] = React.useState("");

  React.useEffect(() => {
    if (current !== recordPage || employeeId) return;
    const stored = storedEmployeeId();
    if (stored) setEmployeeId(stored);
    else setPage(backPage);
  }, [current, employeeId, recordPage, backPage, setPage]);

  const openEmployee = React.useCallback((id) => {
    const value = String(id || "");
    if (!value) return;
    setEmployeeId(value);
    try { sessionStorage.setItem(EMPLOYEE_KEY, value); } catch { /* private mode */ }
    setPage(recordPage);
    setEmployeeParam(value);
  }, [setPage, recordPage]);

  const navigate = React.useCallback((id) => {
    if (id !== recordPage) setEmployeeParam("");
    setPage(id);
  }, [setPage, recordPage]);

  return { employeeId, openEmployee, navigate };
}
