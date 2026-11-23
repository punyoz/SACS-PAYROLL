/**
 * Undo of an applied automatic action (Part E). Each module that applies
 * something registers how to put it back; an action of a module without a
 * handler cannot be undone here (HR fixes it on the module's own page).
 *
 *   handler(supabase, row, { actor }) -> { reverted } | { error, status }
 */
import { undoScheduleRequest } from "@/lib/automation/schedule-requests";

const HANDLERS = {
  schedule_requests: undoScheduleRequest,
};

export function registerUndo(module, handler) {
  HANDLERS[module] = handler;
}

export function canUndo(module) {
  return typeof HANDLERS[module] === "function";
}

export async function undoAutomation(supabase, row, context) {
  const handler = HANDLERS[row.module];
  if (!handler) return { error: "This automatic action can't be undone here: fix it on its own page.", status: 409 };
  try {
    return (await handler(supabase, row, context)) || { reverted: null };
  } catch (error) {
    return { error: error?.message || "Not undone.", status: 409 };
  }
}
