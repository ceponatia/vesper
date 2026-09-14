"use client";

import type { ReactNode } from "react";
import { Button, type ButtonVariant } from "./button";
import { Dialog, type DialogProps } from "./dialog";

const toneVariant: Record<"danger" | "primary", ButtonVariant> = {
  danger: "danger",
  primary: "primary",
};

export interface ConfirmDialogProps {
  open: boolean;
  /** Fires for Escape, a backdrop click, and Cancel — never while `busy`. */
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  /** Body copy. */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** The confirmed operation is still running. */
  busy?: boolean;
  tone?: "danger" | "primary";
  size?: DialogProps["size"];
  /** Disables confirm for a reason other than `busy` (e.g. nothing selected). */
  confirmDisabled?: boolean;
}

/**
 * The one confirmation surface (docs/ui/conventions.md §Confirmations),
 * built on `Dialog`. Its busy guard is the whole point: while `busy`, the
 * running operation stays visible onscreen and cannot be dismissed out from
 * under it — Cancel and `Dialog`'s own `onClose` (Escape, backdrop click)
 * both route through the same guarded wrapper, and the confirm button relies
 * on `Button`'s own `busy` (disables + spinner) so a second click can never
 * start a second operation. `size` is `Dialog`'s width knob, never a
 * `max-w-*` className.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  busy = false,
  tone = "danger",
  size,
  confirmDisabled,
}: ConfirmDialogProps) {
  const dismiss = () => {
    if (!busy) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={dismiss}
      title={title}
      size={size}
      footer={
        <>
          <Button onClick={dismiss} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={toneVariant[tone]} busy={busy} disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
