/**
 * The government deduction tables as the Accountant and HR see them,
 * read-only (GET /api/payroll/government-rates, 2026-10-26): the SSS /
 * PhilHealth / Pag-IBIG rates and limits, the SSS salary credit table and the
 * withholding tax table, each with the version in force now and next period,
 * and every change (who, when, old → new). Only school-wide values: nothing
 * per employee.
 */

import { GOVERNMENT_RATE_TYPES, RATE_TYPES, rateHistory, resolveRate } from "@/lib/payroll/rates";
import { resolveTaxTableRows } from "@/lib/payroll/semi-monthly";
import { mscVersions } from "@/lib/payroll/sss-msc";

/** Rows saved together (tax or MSC), newest first, each with its rows. */
function taxVersions(rows) {
  const byVersion = new Map();
  (rows || []).forEach((row) => {
    if (!byVersion.has(row.version_id)) {
      byVersion.set(row.version_id, {
        version_id: row.version_id, effective_date: row.effective_date, note: row.note || null,
        created_by_name: row.created_by_name || null, created_at: row.created_at, rows: [],
      });
    }
    byVersion.get(row.version_id).rows.push({ bracket_over: Number(row.bracket_over), base_tax: Number(row.base_tax), rate_pct: Number(row.rate_pct) });
  });
  return [...byVersion.values()]
    .map((version) => ({ ...version, rows: version.rows.sort((a, b) => a.bracket_over - b.bracket_over) }))
    .sort((a, b) => (String(b.effective_date).localeCompare(String(a.effective_date)) || String(b.created_at).localeCompare(String(a.created_at))));
}

/**
 * @param {object} args
 * @param {Array}  args.configs   payroll_rate_configs rows
 * @param {Array}  args.taxRows   payroll_tax_brackets rows
 * @param {Array}  args.mscRows   payroll_sss_msc_brackets rows ([] before 20261026020000)
 * @param {boolean} args.mscAvailable
 * @param {{ start_key: string }} args.current   the pay period now
 * @param {{ start_key: string }} args.upcoming  the next pay period
 */
export function buildGovernmentRates({ configs, taxRows, mscRows = [], mscAvailable = false, current, upcoming }) {
  const rates = GOVERNMENT_RATE_TYPES.map((type) => {
    const history = rateHistory(configs, type, "global");
    return {
      rate_type: type,
      label: RATE_TYPES[type].label,
      unit: RATE_TYPES[type].unit,
      hint: RATE_TYPES[type].hint,
      current: Number(resolveRate(configs, type, {}, current.start_key).value) || 0,
      next_period: Number(resolveRate(configs, type, {}, upcoming.start_key).value) || 0,
      // Oldest first, each with the day it stopped applying.
      history: history.map((v) => ({ value: v.value, effective_date: v.effective_date, until: v.until, created_by_name: v.created_by_name || null, created_at: v.created_at || null, note: v.note || null })),
    };
  });

  const tax = taxVersions(taxRows);
  const msc = mscVersions(mscRows);

  // Every change, newest first: who, when, what, old → new.
  const changes = [];
  rates.forEach((rate) => {
    rate.history.forEach((version, index) => {
      changes.push({
        kind: "rate", what: rate.label, rate_type: rate.rate_type, unit: rate.unit,
        from: index > 0 ? rate.history[index - 1].value : null, to: version.value,
        effective_date: version.effective_date, created_by_name: version.created_by_name, created_at: version.created_at, note: version.note,
      });
    });
  });
  const tableChanges = (versions, what, size) => {
    const oldestFirst = [...versions].reverse();
    oldestFirst.forEach((version, index) => {
      const previous = oldestFirst[index - 1] || null;
      changes.push({
        kind: "table", what,
        from: previous ? `${size(previous)} (from ${previous.effective_date})` : null, to: size(version),
        effective_date: version.effective_date, created_by_name: version.created_by_name, created_at: version.created_at, note: version.note,
      });
    });
  };
  tableChanges(tax, "Withholding tax table (monthly)", (v) => `${v.rows.length} brackets`);
  tableChanges(msc, "SSS salary credit table", (v) => `${v.rows.length} brackets, ₱${v.rows[0]?.msc ?? 0}–₱${v.rows[v.rows.length - 1]?.msc ?? 0}`);
  changes.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || String(b.effective_date).localeCompare(String(a.effective_date)));

  return {
    rates,
    tax_table: {
      current_version_id: resolveTaxTableRows(taxRows, current.start_key)[0]?.version_id || null,
      next_period_version_id: resolveTaxTableRows(taxRows, upcoming.start_key)[0]?.version_id || null,
      versions: tax,
    },
    sss_msc: {
      available: mscAvailable,
      current_version_id: resolveTaxTableRows(mscRows, current.start_key)[0]?.version_id || null,
      next_period_version_id: resolveTaxTableRows(mscRows, upcoming.start_key)[0]?.version_id || null,
      versions: msc,
    },
    changes,
    current_period: current,
    next_period: upcoming,
  };
}
