from pathlib import Path

path = Path("scripts/agent-reasoning-bootstrap.py")
text = path.read_text()

replacements = [
    (
        '''replace_once(
    "src/server/engine/chat-memory.ts",
    'import { parseOr, parseOrNull } from "@/lib/parse";\\n',
    'import { agentReasoningPlan, type AgentReasoningProfileId } from "@/lib/agent-reasoning";\\nimport { parseOr, parseOrNull } from "@/lib/parse";\\n',
)
''',
        '''replace_once(
    "src/server/engine/chat-memory.ts",
    'import type { AgentRunDescription, AgentRunDetailSection } from "@/contracts/turns/agent-failure";\\n',
    'import type { AgentRunDescription, AgentRunDetailSection } from "@/contracts/turns/agent-failure";\\nimport { agentReasoningPlan, type AgentReasoningProfileId } from "@/lib/agent-reasoning";\\n',
)
''',
    ),
    (
        '''replace_count(
    "src/server/engine/chat-memory.ts",
    '      legId: "memory",\\n      ctx:',
    '      legId: "memory",\\n      reasoningProfile,\\n      ctx:',
    2,
)
''',
        '''replace_once(
    "src/server/engine/chat-memory.ts",
    '      legId: "memory",\\n      ctx,\\n',
    '      legId: "memory",\\n      reasoningProfile,\\n      ctx,\\n',
)
replace_once(
    "src/server/engine/chat-memory.ts",
    '    legId: "memory",\\n    ctx: { ...input },\\n',
    '    legId: "memory",\\n    reasoningProfile,\\n    ctx: { ...input },\\n',
)
''',
    ),
    (
        '''replace_once(
    "src/server/engine/chat-memory.ts",
    '      legId: "continuity",\\n      ctx:',
    '      legId: "continuity",\\n      reasoningProfile,\\n      ctx:',
)
''',
        '''replace_once(
    "src/server/engine/chat-memory.ts",
    '      legId: "continuity",\\n      ctx,\\n',
    '      legId: "continuity",\\n      reasoningProfile,\\n      ctx,\\n',
)
''',
    ),
    (
        '''replace_once(
    "src/server/engine/chat-memory.ts",
    '      legId: "character",\\n      ctx:',
    '      legId: "character",\\n      reasoningProfile,\\n      ctx:',
)
''',
        '''replace_once(
    "src/server/engine/chat-memory.ts",
    '      legId: "character",\\n      ctx,\\n',
    '      legId: "character",\\n      reasoningProfile,\\n      ctx,\\n',
)
''',
    ),
    (
        '    "  const modelId = agentModelId();\\\\n  const telemetry: Partial<AgentTelemetry> = {\\\\n",\n',
        '    "  const modelId = agentModelId();\\\\n  // Failure telemetry (contracts/turns/agent-failure.ts) — a pulse that times out every\\\\n  // exchange freezes the whole relationship curve silently; now it lands in the tally.\\\\n  const telemetry: Partial<AgentTelemetry> = {\\\\n",\n',
    ),
]

for old, new in replacements:
    if text.count(old) != 1:
        raise RuntimeError(f"expected bootstrap compatibility block exactly once: {old[:100]!r}")
    text = text.replace(old, new, 1)

path.write_text(text)
