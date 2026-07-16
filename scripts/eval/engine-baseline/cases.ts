import { CONTRAST_AXES, EVAL_SCENARIOS, type EvalScenario } from "../narration/fixtures";

export const GATE0_CORPUS_VERSION = "gate0-baseline-v1";

export interface Gate0QualityChecks {
  contradictionRe?: RegExp;
  perspectiveLeakRe?: RegExp;
  hardEffectRepairRe?: RegExp;
  requiredCueRe?: RegExp;
  notes: string[];
}

export interface Gate0CaseDefinition {
  id: string;
  deterministicStateBefore: Record<string, unknown>;
  deterministicStateAfter: Record<string, unknown>;
  checks: Gate0QualityChecks;
}

export interface Gate0Case {
  definition: Gate0CaseDefinition;
  scenario: EvalScenario;
}

const same = (state: Record<string, unknown>): Pick<Gate0CaseDefinition, "deterministicStateBefore" | "deterministicStateAfter"> => ({
  deterministicStateBefore: state,
  deterministicStateAfter: state,
});

const POV_CUE_RE =
  /\b(?:you (?:see|notice|catch|watch|glimpse|take in|feel|smell|taste|hear)|your (?:eyes?|gaze|attention|view|nose|skin|lips|hands?|fingers?)|(?:reaches?|brushes?|warms?) your)\b/i;

const DEFINITIONS: Gate0CaseDefinition[] = [
  {
    id: "hi-quiet-room",
    ...same({
      clock: "evening",
      scene: "Kitchen",
      roster: { Maya: { presence: "present", activity: "wiping down the counter" } },
    }),
    checks: {
      notes: ["Baseline low-intensity turn: no new hard effect is authorized."],
    },
  },
  {
    id: "intimate-regression",
    ...same({
      clock: "night",
      scene: "Maya's room",
      roster: { Maya: { presence: "present", proximity: "forehead contact" } },
      privacy: "private",
    }),
    checks: {
      notes: ["Contact already exists in the committed input; narration may present it but may not introduce logistics."],
    },
  },
  {
    id: "chat-thought-leak",
    ...same({
      lane: "chat",
      perception: {
        heard: "quoted greeting only",
        visible: ["stammer", "flush"],
        private: "the thought containing klutz is not observable",
      },
    }),
    checks: {
      perspectiveLeakRe: /\bklutz\b/i,
      notes: ["Any use of the planted private token is a deterministic perspective leak."],
    },
  },
  {
    id: "session-thought-leak",
    ...same({
      lane: "session",
      perception: {
        heard: "quoted greeting only",
        visible: ["sets bag down", "avoids eye contact"],
        private: "the thought containing washout is not observable",
      },
    }),
    checks: {
      perspectiveLeakRe: /\bwashout\b/i,
      notes: ["Any use of the planted private token is a deterministic perspective leak."],
    },
  },
  {
    id: "chat-markup-comms",
    ...same({
      lane: "chat",
      communication: { medium: "text", coPresent: false, sender: "Brian", recipient: "Sabrina" },
    }),
    checks: {
      requiredCueRe: /\*\s*Sabrina\s*:/i,
      notes: ["The output must remain in the committed remote-text register."],
    },
  },
  {
    id: "chat-pov-sensory",
    ...same({
      lane: "chat",
      contact: "player holds Sabrina's hand near his lips",
      sensoryAccess: ["warmth", "perfume"],
    }),
    checks: {
      requiredCueRe: POV_CUE_RE,
      notes: ["One grounded sensation should arrive through the player's perception."],
    },
  },
  {
    id: "chat-contrast-state-on",
    ...same({
      lane: "chat",
      trackedState: {
        energy: "exhausted",
        stress: "high",
        condition: "rain-soaked",
        concern: "lease problem",
      },
    }),
    checks: {
      requiredCueRe: CONTRAST_AXES.state.cueRe,
      notes: ["The burdened state should be visible without being recited as a ledger."],
    },
  },
  {
    id: "chat-contrast-state-off",
    ...same({ lane: "chat", trackedState: null }),
    checks: {
      notes: ["Control for the paired tracked-state case."],
    },
  },
  {
    id: "gate0-locked-door",
    ...same({
      lane: "session",
      playerLocation: "records hallway",
      mayaLocation: "records office",
      coPresent: false,
      officeDoor: { closed: true, locked: true },
      committedOutcome: "denied",
    }),
    checks: {
      contradictionRe: /\byou (?:step|walk|slip|move) (?:through|into|inside)\b/i,
      hardEffectRepairRe: /\byou (?:take|hold|grasp|catch) (?:Maya'?s|her) hand\b/i,
      notes: [
        "The committed denial is authoritative.",
        "A positive claim that the player enters or takes Maya's hand is a hard-effect repair.",
      ],
    },
  },
];

export function gate0Cases(ids?: readonly string[]): Gate0Case[] {
  const wanted = ids ? new Set(ids) : null;
  const definitions = wanted ? DEFINITIONS.filter((definition) => wanted.has(definition.id)) : DEFINITIONS;
  if (wanted && definitions.length !== wanted.size) {
    const known = new Set(DEFINITIONS.map((definition) => definition.id));
    const missing = [...wanted].filter((id) => !known.has(id));
    throw new Error(`unknown Gate 0 case(s): ${missing.join(", ")}`);
  }

  return definitions.map((definition) => {
    const scenario = EVAL_SCENARIOS.find((candidate) => candidate.id === definition.id);
    if (!scenario) throw new Error(`Gate 0 scenario is missing from narration fixtures: ${definition.id}`);
    return { definition, scenario };
  });
}

const serializedRe = (pattern: RegExp | undefined): { source: string; flags: string } | null =>
  pattern ? { source: pattern.source, flags: pattern.flags } : null;

export function serializableGate0Corpus(cases: readonly Gate0Case[]): unknown {
  return {
    version: GATE0_CORPUS_VERSION,
    cases: cases.map(({ definition, scenario }) => ({
      id: definition.id,
      title: scenario.title,
      lane: scenario.lane,
      expectation: scenario.expectation,
      playerInput: scenario.playerInput,
      deterministicStateBefore: definition.deterministicStateBefore,
      deterministicStateAfter: definition.deterministicStateAfter,
      checks: {
        contradiction: serializedRe(definition.checks.contradictionRe),
        perspectiveLeak: serializedRe(definition.checks.perspectiveLeakRe),
        hardEffectRepair: serializedRe(definition.checks.hardEffectRepairRe),
        requiredCue: serializedRe(definition.checks.requiredCueRe),
        notes: definition.checks.notes,
      },
    })),
  };
}
