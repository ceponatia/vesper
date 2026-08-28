import type { Diagnostic } from "@/contracts";
import { cx } from "@/components/ui/cx";

export interface DiagnosticListProps {
  diagnostics: readonly Diagnostic[];
  className?: string;
  /** When set, "no such location" diagnostics gain a one-click "Create location" action (UX-audit M2). */
  onCreateLocation?: (name: string) => void;
}

const TONE: Record<Diagnostic["severity"], string> = {
  error: "border-danger-500/40 bg-danger-500/10 text-danger-300",
  warn: "border-accent-500/30 bg-accent-500/5 text-accent-300",
  info: "border-ink-500 bg-ink-800/60 text-paper-500",
};

const ORDER: Diagnostic["severity"][] = ["error", "warn", "info"];

/**
 * Severity-aware forge diagnostics (docs/authoring/README.md §Guardrails):
 * errors are failures with a call to action, warns are degradations already applied
 * (dropped/cleared values), infos are muted notices. Visual weight must match
 * severity — a recovered repair must not read like a failed section.
 */
export function DiagnosticList({ diagnostics, className, onCreateLocation }: DiagnosticListProps) {
  if (diagnostics.length === 0) return null;
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      {ORDER.flatMap((severity) => {
        const group = diagnostics.filter((d) => d.severity === severity);
        if (group.length === 0) return [];
        return [
          <div key={severity} className={cx("rounded-card border px-4 py-3", TONE[severity])}>
            {group.map((d, i) => {
              const missingLocation =
                onCreateLocation && d.context?.kind === "missing_location" && typeof d.context.missingLocation === "string"
                  ? d.context.missingLocation
                  : null;
              return (
                <p key={i} className="flex flex-wrap items-center gap-2 text-xs">
                  <span>
                    {d.message}
                    {severity === "error" ? " — regenerate that section or write it manually." : null}
                  </span>
                  {missingLocation && onCreateLocation ? (
                    <button
                      type="button"
                      onClick={() => onCreateLocation(missingLocation)}
                      className="shrink-0 rounded border border-current px-1.5 py-0.5 font-medium hover:bg-ink-800/40"
                    >
                      + Create “{missingLocation}”
                    </button>
                  ) : null}
                </p>
              );
            })}
          </div>,
        ];
      })}
    </div>
  );
}
