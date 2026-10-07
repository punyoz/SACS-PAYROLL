"use client";

import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * A confirmation for destructive or approval actions (the legacy
 * confirmDestructiveAction / confirmApproveAction in app.js).
 *
 *   const [confirmDialog, confirm] = useConfirm();
 *   if (!(await confirm({ title, description, confirmLabel, destructive: true }))) return;
 *   ...render {confirmDialog} once in the component.
 */
export function useConfirm() {
  const [request, setRequest] = React.useState(null);

  const confirm = React.useCallback((options) => new Promise((resolve) => {
    setRequest({ ...options, resolve });
  }), []);

  const finish = (answer) => {
    request?.resolve(answer);
    setRequest(null);
  };

  const dialog = (
    <AlertDialog open={Boolean(request)} onOpenChange={(open) => { if (!open) finish(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title}</AlertDialogTitle>
          {request?.description ? <AlertDialogDescription>{request.description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => finish(false)}>{request?.cancelLabel || "Cancel"}</AlertDialogCancel>
          <AlertDialogAction variant={request?.destructive ? "destructive" : "default"} onClick={() => finish(true)}>
            {request?.confirmLabel || "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return [dialog, confirm];
}
