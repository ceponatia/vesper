"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cx } from "./cx";

export type ToastTone = "info" | "success" | "error";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
}

interface ToastRecord extends ToastInput {
  id: number;
}

interface ToastApi {
  push: (toast: ToastInput) => void;
}

/** Default no-op so a stray useToast outside the provider degrades silently. */
const ToastContext = createContext<ToastApi>({ push: () => {} });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const toneStyles: Record<ToastTone, string> = {
  info: "border-ink-500",
  success: "border-ok-400/60",
  error: "border-danger-500/60",
};

const TOAST_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { ...toast, id }]);
      setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={cx(
              "pointer-events-auto rounded-card border bg-ink-800 px-4 py-3 shadow-lift",
              toneStyles[toast.tone ?? "info"],
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-paper-100">{toast.title}</p>
                {toast.description ? <p className="mt-0.5 text-xs text-paper-400">{toast.description}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss"
                className="cursor-pointer text-paper-500 hover:text-paper-100"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
