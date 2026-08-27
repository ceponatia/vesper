"use client";

import {
  DRIVE_WANT_MAX_CHARS,
  DRIVE_WHY_MAX_CHARS,
  DRIVES_MAX,
  familiarityBandById,
  familiarityBands,
  regardBands,
  type Drive,
} from "@/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export interface DrivesEditorProps {
  drives: readonly Drive[];
  onChange: (drives: Drive[]) => void;
}

/** Encode a secret's reveal gate as one select value ("axis:band"; "" = the ruled default). */
const gateValue = (drive: Drive): string =>
  drive.revealBand ? `${drive.revealBand.axis}:${drive.revealBand.band}` : "";

function parseGate(value: string): Drive["revealBand"] {
  const [axis, band] = value.split(":");
  if ((axis !== "familiarity" && axis !== "regard") || !band) return undefined;
  return { axis, band };
}

const DEFAULT_GATE_LABEL = `Default — familiarity reaches ${familiarityBandById("familiar")?.label ?? "Familiar"}`;

/**
 * Live cap counter: the inputs hard-stop at maxLength, which used to clip
 * silently mid-word. Quiet until the text nears the cap (80%), accent-toned once
 * it hits it.
 */
function CapCounter({ value, max }: { value: string; max: number }) {
  if (value.length < max * 0.8) return null;
  return (
    <span
      aria-live="polite"
      className={`self-end text-[11px] tabular-nums ${value.length >= max ? "text-accent-300" : "text-paper-500"}`}
    >
      {value.length}/{max}
    </span>
  );
}

/**
 * The "Desires & secrets" card: ≤3 authored drives — the wants the character
 * pursues across a chat. `open` steers scenes,
 * `guarded` withholds until asked, `secret` is protected below its reveal gate
 * (the character may lie for it — scoped to that one secret, owner ruling
 * 2026-07-11). Rows saved with an empty want drop at the trust boundary
 * (contracts drivesSchema) rather than failing the save.
 */
export function DrivesEditor({ drives, onChange }: DrivesEditorProps) {
  const update = (index: number, patch: Partial<Drive>) =>
    onChange(drives.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  const remove = (index: number) => onChange(drives.filter((_, i) => i !== index));
  const add = () => onChange([...drives, { want: "", why: "", secrecy: "open" }]);
  const setSecrecy = (index: number, secrecy: Drive["secrecy"]) =>
    update(index, { secrecy, ...(secrecy === "secret" ? {} : { revealBand: undefined }) });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-paper-200">Desires &amp; secrets</span>
        {drives.length < DRIVES_MAX ? (
          <Button size="sm" variant="ghost" onClick={add}>
            + Add drive
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-paper-500">
        Up to {DRIVES_MAX} wants the character actively pursues in chat. Open drives steer what they bring up; guarded
        ones come out only when asked; a secret is protected — they will deflect, and lie if cornered, until the
        relationship crosses its reveal gate.
      </p>

      {drives.length === 0 ? (
        <p className="rounded-card border border-dashed border-ink-600 px-4 py-6 text-center text-sm text-paper-500">
          No drives yet. Add one to give this character something to pursue — or a secret to keep.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {drives.map((drive, index) => (
            <li
              key={index}
              className="grid grid-cols-1 items-end gap-2 rounded-card border border-ink-700 bg-ink-850 p-3 sm:grid-cols-[2fr_2fr_auto_auto_auto]"
            >
              <Field
                label="Want"
                error={!drive.want.trim() ? "Blank — this row is dropped on save." : undefined}
              >
                {(id) => (
                  <div className="flex flex-col gap-0.5">
                    <Input
                      id={id}
                      value={drive.want}
                      maxLength={DRIVE_WANT_MAX_CHARS}
                      placeholder="to reopen the gallery under her own name…"
                      onChange={(e) => update(index, { want: e.target.value })}
                    />
                    <CapCounter value={drive.want} max={DRIVE_WANT_MAX_CHARS} />
                  </div>
                )}
              </Field>
              <Field label="Why (optional)">
                {(id) => (
                  <div className="flex flex-col gap-0.5">
                    <Input
                      id={id}
                      value={drive.why}
                      maxLength={DRIVE_WHY_MAX_CHARS}
                      placeholder="one line of motive…"
                      onChange={(e) => update(index, { why: e.target.value })}
                    />
                    <CapCounter value={drive.why} max={DRIVE_WHY_MAX_CHARS} />
                  </div>
                )}
              </Field>
              <Field label="Secrecy">
                {(id) => (
                  <Select
                    id={id}
                    value={drive.secrecy}
                    onChange={(e) => setSecrecy(index, e.target.value === "guarded" ? "guarded" : e.target.value === "secret" ? "secret" : "open")}
                  >
                    <option value="open">Open</option>
                    <option value="guarded">Guarded</option>
                    <option value="secret">Secret</option>
                  </Select>
                )}
              </Field>
              {drive.secrecy === "secret" ? (
                <Field label="Reveal gate">
                  {(id) => (
                    <Select id={id} value={gateValue(drive)} onChange={(e) => update(index, { revealBand: parseGate(e.target.value) })}>
                      <option value="">{DEFAULT_GATE_LABEL}</option>
                      <optgroup label="Familiarity reaches">
                        {familiarityBands.map((b) => (
                          <option key={b.id} value={`familiarity:${b.id}`}>
                            {b.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Regard reaches">
                        {regardBands.map((b) => (
                          <option key={b.id} value={`regard:${b.id}`}>
                            {b.label}
                          </option>
                        ))}
                      </optgroup>
                    </Select>
                  )}
                </Field>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove(index)}
                aria-label="Remove drive"
                className="touch-target w-full sm:col-start-5 sm:w-auto"
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
