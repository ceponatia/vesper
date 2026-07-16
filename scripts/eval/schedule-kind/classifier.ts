export const SCHEDULE_KINDS = [
  "sleep",
  "meal",
  "hygiene",
  "work",
  "travel",
  "exercise",
  "social",
  "leisure",
] as const;

export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export type ScheduleKindStatus = "matched" | "ambiguous" | "unknown";

export interface ScheduleKindClassification {
  status: ScheduleKindStatus;
  kind: ScheduleKind | null;
  confidence: "high" | "medium" | "none";
  matchedRuleIds: string[];
  candidateKinds: ScheduleKind[];
  unknownSegments: string[];
  reason: string;
}

interface Rule {
  id: string;
  kind: ScheduleKind;
  pattern: RegExp;
}

/**
 * Deliberately high-precision, anchored shadow rules. These are an experiment,
 * not a production semantic contract: partial keyword hits are rejected.
 */
const RULES: Rule[] = [
  { id: "sleep.explicit", kind: "sleep", pattern: /^(?:sleep|sleeping|bedtime|nap|napping|take a nap|go(?:ing)? to bed)$/ },
  {
    id: "meal.explicit",
    kind: "meal",
    pattern:
      /^(?:breakfast|lunch|dinner|supper|eat(?:ing)? (?:breakfast|lunch|dinner|supper)|hav(?:e|ing) (?:breakfast|lunch|dinner|supper)|coffee|coffee break)$/,
  },
  {
    id: "meal.with_company",
    kind: "meal",
    pattern: /^(?:breakfast|lunch|dinner|supper) with .+$/,
  },
  {
    id: "hygiene.explicit",
    kind: "hygiene",
    pattern:
      /^(?:shower|showering|take a shower|bathe|bathing|bath|brush teeth|brushing teeth|wash up|washing up|get dressed|getting dressed|dress for the day)$/,
  },
  {
    id: "work.explicit",
    kind: "work",
    pattern:
      /^(?:work|working|work shift|(?:morning|day|evening|night) shift|shift at .+|at work|office hours|teach(?:ing)? (?:class|classes)|open(?:ing)? (?:the )?shop|clos(?:e|ing) (?:the )?shop)$/,
  },
  {
    id: "travel.explicit",
    kind: "travel",
    pattern:
      /^(?:commute(?: to .+)?|(?:drive|driving|ride|riding|walk|walking|head|heading|travel|traveling) to .+|go(?:ing)? to (?!bed$).+|return(?:ing)? home|leave|leaving for .+)$/,
  },
  {
    id: "exercise.explicit",
    kind: "exercise",
    pattern:
      /^(?:exercise|exercising|workout|work out|working out|yoga|(?:morning|evening)? ?run|running|jog|jogging|gym|swim|swimming)$/,
  },
  {
    id: "social.explicit",
    kind: "social",
    pattern:
      /^(?:meet(?:ing)? .+|visit(?:ing)? .+|call(?:ing)? .+|date night|hang(?:ing)? out with .+|(?:breakfast|lunch|dinner|supper) with .+)$/,
  },
  {
    id: "leisure.explicit",
    kind: "leisure",
    pattern:
      /^(?:read|reading|watch(?:ing)? (?:tv|television|a movie)|relax|relaxing|play(?:ing)? (?:games|video games)|hobby time)$/,
  },
];

const normalize = (activity: string): string =>
  activity
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");

function splitSegments(activity: string): string[] {
  return activity
    .split(/\s+(?:and then|and|then)\s+|\s*[,&/;]\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function matchingRules(segment: string): Rule[] {
  return RULES.filter((rule) => rule.pattern.test(segment));
}

export function inferScheduleKind(activity: string): ScheduleKindClassification {
  const normalized = normalize(activity);
  if (!normalized) {
    return {
      status: "unknown",
      kind: null,
      confidence: "none",
      matchedRuleIds: [],
      candidateKinds: [],
      unknownSegments: [],
      reason: "empty activity",
    };
  }

  const segments = splitSegments(normalized);
  const matches = segments.map((segment) => ({ segment, rules: matchingRules(segment) }));
  const unknownSegments = matches.filter((match) => match.rules.length === 0).map((match) => match.segment);
  const matchedRules = matches.flatMap((match) => match.rules);
  const matchedRuleIds = [...new Set(matchedRules.map((rule) => rule.id))];
  const candidateKinds = [...new Set(matchedRules.map((rule) => rule.kind))];

  if (matchedRules.length === 0) {
    return {
      status: "unknown",
      kind: null,
      confidence: "none",
      matchedRuleIds,
      candidateKinds,
      unknownSegments,
      reason: "no high-precision rule matched the full activity",
    };
  }

  if (unknownSegments.length > 0 || candidateKinds.length !== 1) {
    return {
      status: "ambiguous",
      kind: null,
      confidence: "none",
      matchedRuleIds,
      candidateKinds,
      unknownSegments,
      reason:
        unknownSegments.length > 0
          ? "compound activity contains an unclassified segment"
          : "activity matches more than one semantic kind",
    };
  }

  return {
    status: "matched",
    kind: candidateKinds[0] ?? null,
    confidence: segments.length === 1 ? "high" : "medium",
    matchedRuleIds,
    candidateKinds,
    unknownSegments,
    reason: segments.length === 1 ? "one complete activity matched one kind" : "all compound segments matched the same kind",
  };
}

export const HARD_EFFECT_SCHEDULE_KINDS: ReadonlySet<ScheduleKind> = new Set([
  "sleep",
  "meal",
  "hygiene",
  "travel",
]);

export function hasHardEffectCandidate(
  classification: Pick<ScheduleKindClassification, "candidateKinds">,
): boolean {
  return classification.candidateKinds.some((kind) => HARD_EFFECT_SCHEDULE_KINDS.has(kind));
}
