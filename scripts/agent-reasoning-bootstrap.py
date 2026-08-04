from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one occurrence, found {count}: {old[:100]!r}")
    write(path, text.replace(old, new, 1))


def replace_count(path: str, old: str, new: str, expected: int) -> None:
    text = read(path)
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"{path}: expected {expected} occurrences, found {count}: {old[:100]!r}")
    write(path, text.replace(old, new))


def regex_once(path: str, pattern: str, replacement: str, flags: int = 0) -> None:
    text = read(path)
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{path}: regex expected one occurrence, found {count}: {pattern[:120]!r}")
    write(path, next_text)


# The existing post-turn extraction watchdogs are temporarily 60s. Reasoning
# experiments need more headroom than that ceiling, not merely the same ceiling.
replace_once(
    "src/lib/agent-reasoning.ts",
    "export const AGENT_REASONING_MAX_TIMEOUT_MS = 60_000;",
    "export const AGENT_REASONING_MAX_TIMEOUT_MS = 120_000;",
)

# Per-chat storage: operational experiment state, deliberately outside rollback.
replace_once(
    "src/server/db/schema.ts",
    '    sceneModel: text("scene_model").notNull().default("reference"),\n',
    '''    sceneModel: text("scene_model").notNull().default("reference"),
    /**
     * Admin-only structured-agent reasoning experiment. This is operational
     * configuration, not story state: retakes and state rollback never change it.
     */
    agentReasoningProfile: text("agent_reasoning_profile", {
      enum: ["off", "continuity", "synthesis", "broad_post_turn"],
    })
      .notNull()
      .default("off"),
''',
)

replace_once(
    "src/server/ai/index.ts",
    'export * from "./agent-failures";\n',
    'export * from "./agent-failures";\nexport * from "./agent-reasoning";\n',
)

# Telemetry carries the effective profile and switch, so Inspector comparisons
# remain attributable even after the admin changes the chat setting.
replace_once(
    "src/server/ai/agent-failures.ts",
    "  /** The watchdog budget (timeouts only). */\n  timeoutMs?: number;\n",
    '''  /** The watchdog budget (timeouts only). */
  timeoutMs?: number;
  /** Admin-selected per-chat experiment profile at call time. */
  reasoningProfile?: string;
  /** Whether this leg actually received a reasoning configuration. */
  reasoningEnabled?: boolean;
''',
)
replace_once(
    "src/server/ai/agent-failures.ts",
    "    detail,\n    at: (input.at ?? new Date()).toISOString(),\n",
    '''    detail,
    reasoningProfile: input.reasoningProfile ?? "off",
    reasoningEnabled: input.reasoningEnabled ?? false,
    at: (input.at ?? new Date()).toISOString(),
''',
)
replace_once(
    "src/server/ai/agent-failures.ts",
    "    details: capDetails(input.details ?? []),\n    at: (input.at ?? new Date()).toISOString(),\n",
    '''    details: capDetails(input.details ?? []),
    reasoningProfile: input.reasoningProfile ?? "off",
    reasoningEnabled: input.reasoningEnabled ?? false,
    at: (input.at ?? new Date()).toISOString(),
''',
)

replace_once(
    "src/contracts/turns/agent-failure.ts",
    "  /** HTTP status, when the provider gave one. */\n  httpStatus: z.number().int().catch(0),\n",
    '''  /** The effective admin reasoning experiment at call time (old rows heal to off). */
  reasoningProfile: z.string().catch("off").default("off"),
  reasoningEnabled: z.boolean().catch(false).default(false),
  /** HTTP status, when the provider gave one. */
  httpStatus: z.number().int().catch(0),
''',
)
replace_once(
    "src/contracts/turns/agent-failure.ts",
    '  chat_scene_sketch: "Location artist",\n',
    '  chat_scene_sketch: "Location artist",\n  chat_meanwhile: "Meanwhile pass",\n',
)
replace_once(
    "src/contracts/turns/agent-failure.ts",
    "  /** One line of what the leg produced (\"3 facts · 1 episode · 2 queries\"); \"\" = nothing changed. */\n",
    '''  /** The effective admin reasoning experiment at call time (old rows heal to off). */
  reasoningProfile: z.string().catch("off").default("off"),
  reasoningEnabled: z.boolean().catch(false).default(false),
  /** One line of what the leg produced ("3 facts · 1 episode · 2 queries"); "" = nothing changed. */
''',
)

replace_once(
    "src/lib/api-inspector.ts",
    "  detail: textOr(\"\"),\n  at: textOr(\"\"),\n});\nexport type AgentFailureRow",
    '''  detail: textOr(""),
  reasoningProfile: textOr("off"),
  reasoningEnabled: z.boolean().catch(false),
  at: textOr(""),
});
export type AgentFailureRow''',
)
replace_once(
    "src/lib/api-inspector.ts",
    "  details: arrayOf(agentRunDetailRowSchema),\n  at: textOr(\"\"),\n});\nexport type AgentRunRow",
    '''  details: arrayOf(agentRunDetailRowSchema),
  reasoningProfile: textOr("off"),
  reasoningEnabled: z.boolean().catch(false),
  at: textOr(""),
});
export type AgentRunRow''',
)

# generateChecked and the watchdog currently enumerate telemetry fields rather
# than spreading them, so thread the new fields through every record path.
replace_once(
    "src/server/ai/generate-checked.ts",
    "    maxOutputTokens: opts.maxOutputTokens ?? 4096,\n    detail: providerClassification?.detail ?? firstError,\n",
    '''    maxOutputTokens: opts.maxOutputTokens ?? 4096,
    reasoningProfile: opts.telemetry?.reasoningProfile,
    reasoningEnabled: opts.telemetry?.reasoningEnabled,
    detail: providerClassification?.detail ?? firstError,
''',
)
replace_once(
    "src/server/ai/generate-timeout.ts",
    "        maxOutputTokens: telemetry?.maxOutputTokens,\n        detail: `no response within ${timeoutMs}ms`,\n",
    '''        maxOutputTokens: telemetry?.maxOutputTokens,
        reasoningProfile: telemetry?.reasoningProfile,
        reasoningEnabled: telemetry?.reasoningEnabled,
        detail: `no response within ${timeoutMs}ms`,
''',
)
replace_once(
    "src/server/ai/generate-timeout.ts",
    "            maxOutputTokens: telemetry.maxOutputTokens,\n            provider: r.provider,\n",
    '''            maxOutputTokens: telemetry.maxOutputTokens,
            reasoningProfile: telemetry.reasoningProfile,
            reasoningEnabled: telemetry.reasoningEnabled,
            provider: r.provider,
''',
)

# Inspector: profile is searchable and visible in compact rows and the detail dialog.
replace_once(
    "src/components/chat/chat-inspector-agent-health.tsx",
    '          ? `${agentLegLabel(item.legId)} ${item.run.summary} ${item.run.modelId} ${item.run.provider ?? ""}`\n',
    '          ? `${agentLegLabel(item.legId)} ${item.run.summary} ${item.run.modelId} ${item.run.provider ?? ""} ${item.run.reasoningProfile}`\n',
)
replace_once(
    "src/components/chat/chat-inspector-agent-health.tsx",
    '          : `${agentLegLabel(item.legId)} ${item.failure.detail} ${item.failure.cause} ${item.failure.modelId} ${item.failure.provider ?? ""}`;\n',
    '          : `${agentLegLabel(item.legId)} ${item.failure.detail} ${item.failure.cause} ${item.failure.modelId} ${item.failure.provider ?? ""} ${item.failure.reasoningProfile}`;\n',
)
replace_once(
    "src/components/chat/chat-inspector-agent-health.tsx",
    '  const facts = [run.provider ? `via ${run.provider}` : "", run.modelId].filter(Boolean);\n',
    '''  const facts = [
    run.reasoningEnabled ? `reasoning: ${run.reasoningProfile}` : "reasoning: off",
    run.provider ? `via ${run.provider}` : "",
    run.modelId,
  ].filter(Boolean);
''',
)
replace_once(
    "src/components/chat/chat-inspector-agent-health.tsx",
    "    failure.provider ? `via ${failure.provider}` : \"\",\n    failure.modelId,\n",
    '''    failure.reasoningEnabled ? `reasoning: ${failure.reasoningProfile}` : "reasoning: off",
    failure.provider ? `via ${failure.provider}` : "",
    failure.modelId,
''',
)
replace_once(
    "src/components/chat/chat-inspector-agent-health.tsx",
    '          ["Provider", item.run.provider || "—"],\n          ["Prompt",',
    '          ["Provider", item.run.provider || "—"],\n          ["Reasoning", item.run.reasoningEnabled ? item.run.reasoningProfile : "off"],\n          ["Prompt",',
)
replace_once(
    "src/components/chat/chat-inspector-agent-health.tsx",
    '          ["Model", item.failure.modelId || "—"],\n          ["When",',
    '          ["Model", item.failure.modelId || "—"],\n          ["Reasoning", item.failure.reasoningEnabled ? item.failure.reasoningProfile : "off"],\n          ["When",',
)

# Shared character/world conversation UI: the same chat surface serves both lanes.
replace_once(
    "src/components/chat/chat-conversation.tsx",
    'import { ChatPermissionsPanel } from "@/components/chat/chat-permissions-panel";\n',
    'import { AgentReasoningSelect } from "@/components/chat/agent-reasoning-select";\nimport { ChatPermissionsPanel } from "@/components/chat/chat-permissions-panel";\n',
)
replace_once(
    "src/components/chat/chat-conversation.tsx",
    "      onChatModelChange={saveChatModel}\n      hasState={chatState !== null}\n",
    '''      onChatModelChange={saveChatModel}
      agentReasoningControl={isAdmin ? <AgentReasoningSelect chatId={chatId} /> : undefined}
      hasState={chatState !== null}
''',
)
replace_once(
    "src/components/chat/chat-conversation.tsx",
    "  onChatModelChange,\n  hasState,\n",
    "  onChatModelChange,\n  agentReasoningControl,\n  hasState,\n",
)
replace_once(
    "src/components/chat/chat-conversation.tsx",
    "  onChatModelChange: (modelId: string) => void;\n  hasState: boolean;\n",
    "  onChatModelChange: (modelId: string) => void;\n  /** Owner-admin-only experiment selector; absent for ordinary users. */\n  agentReasoningControl?: ReactNode;\n  hasState: boolean;\n",
)
replace_once(
    "src/components/chat/chat-conversation.tsx",
    "      </label>\n      <div className=\"my-1 border-t border-ink-600\" />\n",
    "      </label>\n      {agentReasoningControl}\n      <div className=\"my-1 border-t border-ink-600\" />\n",
)

# Shared extraction legs: load once per fan-out, then resolve per leg.
replace_once(
    "src/server/engine/chat-memory.ts",
    'import { parseOr, parseOrNull } from "@/lib/parse";\n',
    'import { agentReasoningPlan, type AgentReasoningProfileId } from "@/lib/agent-reasoning";\nimport { parseOr, parseOrNull } from "@/lib/parse";\n',
)
replace_once(
    "src/server/engine/chat-memory.ts",
    'import { agentModelId, embedText, generateChecked, isDemoMode, toVectorLiteral, withGenerateTimeout, type AgentTelemetry } from "../ai";\n',
    'import { agentModelId, embedText, generateChecked, isDemoMode, loadChatAgentReasoningProfile, toVectorLiteral, withGenerateTimeout, type AgentTelemetry } from "../ai";\n',
)
replace_once(
    "src/server/engine/chat-memory.ts",
    "  code: string;\n  /** Which conversation/exchange this leg is running for — so a failure is diagnosable. */\n",
    "  code: string;\n  reasoningProfile: AgentReasoningProfileId;\n  /** Which conversation/exchange this leg is running for — so a failure is diagnosable. */\n",
)
replace_once(
    "src/server/engine/chat-memory.ts",
    "  const modelId = agentModelId();\n  // Failure telemetry",
    '''  const modelId = agentModelId();
  const reasoning = agentReasoningPlan({
    profileId: args.reasoningProfile,
    leg: args.legId,
    maxOutputTokens: args.maxOutputTokens,
    timeoutMs: args.timeoutMs,
  });
  // Failure telemetry''',
)
replace_once(
    "src/server/engine/chat-memory.ts",
    "    maxOutputTokens: args.maxOutputTokens,\n  };\n  const work",
    '''    maxOutputTokens: reasoning.maxOutputTokens,
    reasoningProfile: reasoning.profileId,
    reasoningEnabled: reasoning.enabled,
  };
  const work''',
)
replace_once(
    "src/server/engine/chat-memory.ts",
    "    maxOutputTokens: args.maxOutputTokens,\n    code: `${args.code}.extract`,\n",
    "    maxOutputTokens: reasoning.maxOutputTokens,\n    code: `${args.code}.extract`,\n",
)
replace_once(
    "src/server/engine/chat-memory.ts",
    "    disableReasoning: true,\n    lowLatencyRouting: true,\n",
    "    disableReasoning: !reasoning.enabled,\n    providerOptions: reasoning.providerOptions,\n    lowLatencyRouting: true,\n",
)
replace_once(
    "src/server/engine/chat-memory.ts",
    "    args.timeoutMs,\n    `${args.code}.timeout`,\n",
    "    reasoning.timeoutMs,\n    `${args.code}.timeout`,\n",
)
replace_once(
    "src/server/engine/chat-memory.ts",
    "  const empty = degradedChatArchivist();\n\n  const [memory, continuity, character] = await Promise.all([\n",
    '''  const empty = degradedChatArchivist();
  const reasoningProfile = await loadChatAgentReasoningProfile(input.trace?.chatId);

  const [memory, continuity, character] = await Promise.all([
''',
)
replace_count(
    "src/server/engine/chat-memory.ts",
    '      legId: "memory",\n      ctx:',
    '      legId: "memory",\n      reasoningProfile,\n      ctx:',
    2,
)
replace_once(
    "src/server/engine/chat-memory.ts",
    '      legId: "continuity",\n      ctx:',
    '      legId: "continuity",\n      reasoningProfile,\n      ctx:',
)
replace_once(
    "src/server/engine/chat-memory.ts",
    '      legId: "character",\n      ctx:',
    '      legId: "character",\n      reasoningProfile,\n      ctx:',
)
replace_once(
    "src/server/engine/chat-memory.ts",
    "  const empty = degradedChatArchivist();\n  const { value, degraded } = await runExtractorLeg<ChatMemoryScribe>({\n",
    '''  const empty = degradedChatArchivist();
  const reasoningProfile = await loadChatAgentReasoningProfile(input.trace?.chatId);
  const { value, degraded } = await runExtractorLeg<ChatMemoryScribe>({
''',
)
replace_once(
    "src/server/engine/chat-memory.ts",
    "\n  return runExtractorLeg<ChatPersonalNotes>({\n    legId: \"personal\",\n",
    '''
  const reasoningProfile = await loadChatAgentReasoningProfile(input.trace?.chatId);
  return runExtractorLeg<ChatPersonalNotes>({
    legId: "personal",
    reasoningProfile,
''',
)

# Reaction pulse is intentionally broad-profile only.
replace_once(
    "src/server/engine/chat-state.ts",
    'import { parseOr, parseOrNull } from "@/lib/parse";\n',
    'import { agentReasoningPlan } from "@/lib/agent-reasoning";\nimport { parseOr, parseOrNull } from "@/lib/parse";\n',
)
replace_once(
    "src/server/engine/chat-state.ts",
    'import { agentModelId, generateChecked, isDemoMode, withGenerateTimeout, type AgentTelemetry } from "../ai";\n',
    'import { agentModelId, generateChecked, isDemoMode, loadChatAgentReasoningProfile, withGenerateTimeout, type AgentTelemetry } from "../ai";\n',
)
replace_once(
    "src/server/engine/chat-state.ts",
    "  const modelId = agentModelId();\n  const telemetry: Partial<AgentTelemetry> = {\n",
    '''  const modelId = agentModelId();
  const reasoningProfile = await loadChatAgentReasoningProfile(input.trace?.chatId);
  const reasoning = agentReasoningPlan({
    profileId: reasoningProfile,
    leg: "pulse",
    maxOutputTokens: CHAT_PULSE_MAX_OUTPUT_TOKENS,
    timeoutMs: CHAT_PULSE_TIMEOUT_MS,
  });
  const telemetry: Partial<AgentTelemetry> = {
''',
)
replace_once(
    "src/server/engine/chat-state.ts",
    "    maxOutputTokens: CHAT_PULSE_MAX_OUTPUT_TOKENS,\n  };\n  const work",
    '''    maxOutputTokens: reasoning.maxOutputTokens,
    reasoningProfile: reasoning.profileId,
    reasoningEnabled: reasoning.enabled,
  };
  const work''',
)
replace_once(
    "src/server/engine/chat-state.ts",
    "    maxOutputTokens: CHAT_PULSE_MAX_OUTPUT_TOKENS,\n    code: \"chat_state.pulse\",\n",
    "    maxOutputTokens: reasoning.maxOutputTokens,\n    code: \"chat_state.pulse\",\n",
)
replace_once(
    "src/server/engine/chat-state.ts",
    "    disableReasoning: true,\n    lowLatencyRouting: true,\n",
    "    disableReasoning: !reasoning.enabled,\n    providerOptions: reasoning.providerOptions,\n    lowLatencyRouting: true,\n",
)
replace_once(
    "src/server/engine/chat-state.ts",
    "    CHAT_PULSE_TIMEOUT_MS,\n    \"chat_state.pulse.timeout\",\n",
    "    reasoning.timeoutMs,\n    \"chat_state.pulse.timeout\",\n",
)

# Detached location sketch.
replace_once(
    "src/server/engine/chat-scene-sketch.ts",
    'import { calendarStartSchema } from "@/lib/clock";\n',
    'import { agentReasoningPlan, resolveAgentReasoningProfile } from "@/lib/agent-reasoning";\nimport { calendarStartSchema } from "@/lib/clock";\n',
)
replace_once(
    "src/server/engine/chat-scene-sketch.ts",
    'import { agentModelId, generateChecked, isDemoMode, withGenerateTimeout } from "../ai";\n',
    'import { agentModelId, generateChecked, isDemoMode, withGenerateTimeout, type AgentTelemetry } from "../ai";\n',
)
replace_once(
    "src/server/engine/chat-scene-sketch.ts",
    "      calendarStart: characterChats.calendarStart,\n",
    "      calendarStart: characterChats.calendarStart,\n      agentReasoningProfile: characterChats.agentReasoningProfile,\n",
)
replace_once(
    "src/server/engine/chat-scene-sketch.ts",
    "  const controller = new AbortController();\n  const work = generateChecked<ChatSceneSketch>({\n",
    '''  const controller = new AbortController();
  const modelId = agentModelId();
  const reasoning = agentReasoningPlan({
    profileId: resolveAgentReasoningProfile(row.agentReasoningProfile),
    leg: "scene_sketch",
    maxOutputTokens: CHAT_SCENE_SKETCH_MAX_OUTPUT_TOKENS,
    timeoutMs: CHAT_SCENE_SKETCH_TIMEOUT_MS,
  });
  const telemetry: Partial<AgentTelemetry> = {
    legId: "chat_scene_sketch",
    chatId: input.chatId,
    modelId,
    maxOutputTokens: reasoning.maxOutputTokens,
    reasoningProfile: reasoning.profileId,
    reasoningEnabled: reasoning.enabled,
  };
  const work = generateChecked<ChatSceneSketch>({
''',
)
replace_once(
    "src/server/engine/chat-scene-sketch.ts",
    "    modelId: agentModelId(),\n",
    "    modelId,\n",
)
replace_once(
    "src/server/engine/chat-scene-sketch.ts",
    "    maxOutputTokens: CHAT_SCENE_SKETCH_MAX_OUTPUT_TOKENS,\n",
    "    maxOutputTokens: reasoning.maxOutputTokens,\n",
)
replace_once(
    "src/server/engine/chat-scene-sketch.ts",
    "    disableReasoning: true,\n    lowLatencyRouting: true,\n",
    "    disableReasoning: !reasoning.enabled,\n    providerOptions: reasoning.providerOptions,\n    lowLatencyRouting: true,\n",
)
replace_once(
    "src/server/engine/chat-scene-sketch.ts",
    '''    CHAT_SCENE_SKETCH_TIMEOUT_MS,
    "chat_scene_sketch.timeout",
  );
''',
    '''    reasoning.timeoutMs,
    "chat_scene_sketch.timeout",
    undefined,
    telemetry,
  );
''',
)

# Detached off-screen synthesis.
replace_once(
    "src/server/engine/chat-meanwhile.ts",
    'import { formatElapsed } from "@/lib/clock";\n',
    'import { agentReasoningPlan } from "@/lib/agent-reasoning";\nimport { formatElapsed } from "@/lib/clock";\n',
)
replace_once(
    "src/server/engine/chat-meanwhile.ts",
    'import { agentModelId, generateChecked, isDemoMode, withGenerateTimeout } from "../ai";\n',
    'import { agentModelId, generateChecked, isDemoMode, loadChatAgentReasoningProfile, withGenerateTimeout, type AgentTelemetry } from "../ai";\n',
)
replace_once(
    "src/server/engine/chat-meanwhile.ts",
    "  const controller = new AbortController();\n  const work = generateChecked<ChatMeanwhile>({\n",
    '''  const controller = new AbortController();
  const modelId = agentModelId();
  const reasoningProfile = await loadChatAgentReasoningProfile(input.chatId);
  const reasoning = agentReasoningPlan({
    profileId: reasoningProfile,
    leg: "meanwhile",
    maxOutputTokens: CHAT_MEANWHILE_MAX_OUTPUT_TOKENS,
    timeoutMs: CHAT_MEANWHILE_TIMEOUT_MS,
  });
  const telemetry: Partial<AgentTelemetry> = {
    legId: "chat_meanwhile",
    chatId: input.chatId,
    modelId,
    maxOutputTokens: reasoning.maxOutputTokens,
    reasoningProfile: reasoning.profileId,
    reasoningEnabled: reasoning.enabled,
  };
  const work = generateChecked<ChatMeanwhile>({
''',
)
replace_once(
    "src/server/engine/chat-meanwhile.ts",
    "    modelId: agentModelId(),\n",
    "    modelId,\n",
)
replace_once(
    "src/server/engine/chat-meanwhile.ts",
    "    maxOutputTokens: CHAT_MEANWHILE_MAX_OUTPUT_TOKENS,\n",
    "    maxOutputTokens: reasoning.maxOutputTokens,\n",
)
replace_once(
    "src/server/engine/chat-meanwhile.ts",
    "    disableReasoning: true,\n    repair: false,\n",
    "    disableReasoning: !reasoning.enabled,\n    providerOptions: reasoning.providerOptions,\n    repair: false,\n",
)
replace_once(
    "src/server/engine/chat-meanwhile.ts",
    '  const { value, degraded } = await withGenerateTimeout(work, controller, CHAT_MEANWHILE_TIMEOUT_MS, "chat_meanwhile.timeout");\n',
    '''  const { value, degraded } = await withGenerateTimeout(
    work,
    controller,
    reasoning.timeoutMs,
    "chat_meanwhile.timeout",
    undefined,
    telemetry,
  );
''',
)

print("Agent reasoning profile patch applied successfully.")
