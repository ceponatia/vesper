import type { ItemDefinition, ItemInstanceState } from "@/contracts/items/item";
import type { ParticipantState } from "@/contracts/state/participant-state";
import type { PendingComms } from "@/contracts/state/session-runtime";
import type { CharacterProfile } from "@/contracts/world/profile";
import type { SessionBundle } from "../bundle";

/** Per-turn mutable copy of a session participant the reducer plans over. */
export interface WorkingParticipant {
  id: string;
  displayName: string;
  isUser: boolean;
  role: "player" | "companion" | "npc";
  characterId: string | null;
  snapshot: CharacterProfile;
  locationId: string | null;
  state: ParticipantState;
}

/** Per-turn mutable copy of a session item instance the reducer plans over. */
export interface WorkingItem {
  id: string;
  name: string;
  itemId: string | null;
  definition: ItemDefinition;
  holderParticipantId: string | null;
  worn: boolean;
  locationId: string | null;
  containerInstanceId: string | null;
  positionNote: string | null;
  state: ItemInstanceState;
}

/** Exactly-one-of placement (holder | location | container); `worn` only with a holder. */
export interface ItemPlacement {
  holderParticipantId: string | null;
  worn: boolean;
  locationId: string | null;
  containerInstanceId: string | null;
}

/** Item notes are capped (keep the most recent); mirrors the meter/inner-note caps. */
const ITEM_NOTE_CAP = 5;

/**
 * The reducer's working state (merge-decomposition.spec.md §3.1): the mutable
 * per-turn copy of participants and items, plus the per-turn accumulators. The
 * **only** way to mutate a participant/item row is through a method here, and
 * every mutator marks the matching dirty set itself — so a dropped DB write from
 * a forgotten dirty-mark is structurally impossible (enforced by the
 * `no-restricted-syntax` gate in `eslint.config.mjs`, which forbids direct field
 * assignment to participant/item state anywhere outside this file). Follows the
 * mutable-accumulator precedent of `EventChannel` / `DiagnosticCollector`.
 */
export class WorkingState {
  private readonly parts: WorkingParticipant[];
  private readonly itemRows: WorkingItem[];
  private readonly touchedParticipantSet = new Set<string>();
  private readonly touchedItemSet = new Set<string>();
  private readonly dropped: string[] = [];
  private readonly arrivalLines: string[] = [];
  private readonly departureLines: string[] = [];
  private readonly directiveLines: string[] = [];
  private readonly comms: PendingComms[] = [];

  private constructor(parts: WorkingParticipant[], items: WorkingItem[]) {
    this.parts = parts;
    this.itemRows = items;
  }

  /** Deep-copy the bundle's participant/item state into a fresh working state. */
  static fromBundle(bundle: SessionBundle): WorkingState {
    const parts: WorkingParticipant[] = bundle.participants.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      isUser: p.isUser,
      role: p.role,
      characterId: p.characterId,
      snapshot: p.snapshot,
      locationId: p.locationId,
      state: structuredClone(p.state),
    }));
    const items: WorkingItem[] = bundle.items.map((i) => ({
      id: i.id,
      name: i.name,
      itemId: i.itemId,
      definition: i.definition,
      holderParticipantId: i.holderParticipantId,
      worn: i.worn,
      locationId: i.locationId,
      containerInstanceId: i.containerInstanceId,
      positionNote: i.positionNote ?? null,
      state: structuredClone(i.state),
    }));
    return new WorkingState(parts, items);
  }

  // -- reads ------------------------------------------------------------------

  get participants(): readonly WorkingParticipant[] {
    return this.parts;
  }

  get items(): readonly WorkingItem[] {
    return this.itemRows;
  }

  get player(): WorkingParticipant | null {
    return this.parts.find((p) => p.isUser) ?? null;
  }

  // -- participant mutators (each marks the participant dirty) -----------------

  moveParticipant(p: WorkingParticipant, toLocationId: string | null): void {
    p.locationId = toLocationId;
    this.touchedParticipantSet.add(p.id);
  }

  setActivity(p: WorkingParticipant, activity: ParticipantState["activity"], posture?: ParticipantState["posture"]): void {
    p.state.activity = activity;
    if (posture !== undefined) p.state.posture = posture;
    this.touchedParticipantSet.add(p.id);
  }

  setMeters(p: WorkingParticipant, meters: ParticipantState["meters"]): void {
    p.state.meters = meters;
    this.touchedParticipantSet.add(p.id);
  }

  setConditions(p: WorkingParticipant, conditions: ParticipantState["conditions"]): void {
    p.state.conditions = conditions;
    this.touchedParticipantSet.add(p.id);
  }

  setAttributeOverlays(p: WorkingParticipant, overlays: ParticipantState["attributeOverlays"]): void {
    p.state.attributeOverlays = overlays;
    this.touchedParticipantSet.add(p.id);
  }

  // -- item mutators (each marks the item dirty) ------------------------------

  placeItem(item: WorkingItem, placement: ItemPlacement, positionNote: string | null): void {
    item.holderParticipantId = placement.holderParticipantId;
    item.worn = placement.worn;
    item.locationId = placement.locationId;
    item.containerInstanceId = placement.containerInstanceId;
    item.positionNote = positionNote;
    this.touchedItemSet.add(item.id);
  }

  setItemOpen(item: WorkingItem, open: boolean): void {
    item.state.open = open;
    this.touchedItemSet.add(item.id);
  }

  addItemNote(item: WorkingItem, note: string): void {
    item.state.notes = [...item.state.notes, note].slice(-ITEM_NOTE_CAP);
    this.touchedItemSet.add(item.id);
  }

  // -- accumulators -----------------------------------------------------------

  recordDrop(message: string): void {
    this.dropped.push(message);
  }

  stageArrival(line: string): void {
    this.arrivalLines.push(line);
  }

  stageDeparture(line: string): void {
    this.departureLines.push(line);
  }

  stageDirective(line: string): void {
    this.directiveLines.push(line);
  }

  fireComms(pending: PendingComms): void {
    this.comms.push(pending);
  }

  // -- readonly getters consumed when assembling the MergePlan ----------------

  get touchedItemIds(): readonly string[] {
    return [...this.touchedItemSet];
  }

  get touchedParticipantIds(): ReadonlySet<string> {
    return this.touchedParticipantSet;
  }

  get droppedEvents(): readonly string[] {
    return this.dropped;
  }

  get arrivals(): readonly string[] {
    return this.arrivalLines;
  }

  get departures(): readonly string[] {
    return this.departureLines;
  }

  get stagedDirectives(): readonly string[] {
    return this.directiveLines;
  }

  get firedComms(): readonly PendingComms[] {
    return this.comms;
  }
}
