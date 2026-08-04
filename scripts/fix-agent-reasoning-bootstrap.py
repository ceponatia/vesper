from pathlib import Path

path = Path("scripts/agent-reasoning-bootstrap.py")
text = path.read_text()
old = '''replace_once(
    "src/server/engine/chat-memory.ts",
    'import { parseOr, parseOrNull } from "@/lib/parse";\\n',
    'import { agentReasoningPlan, type AgentReasoningProfileId } from "@/lib/agent-reasoning";\\nimport { parseOr, parseOrNull } from "@/lib/parse";\\n',
)
'''
new = '''replace_once(
    "src/server/engine/chat-memory.ts",
    'import type { AgentRunDescription, AgentRunDetailSection } from "@/contracts/turns/agent-failure";\\n',
    'import type { AgentRunDescription, AgentRunDetailSection } from "@/contracts/turns/agent-failure";\\nimport { agentReasoningPlan, type AgentReasoningProfileId } from "@/lib/agent-reasoning";\\n',
)
'''
if text.count(old) != 1:
    raise RuntimeError("expected chat-memory bootstrap block exactly once")
path.write_text(text.replace(old, new, 1))
