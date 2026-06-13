// Force demo mode in tests: no network LLM calls, deterministic pseudo-embeddings.
process.env.AI_FAKE = "1";
delete process.env.OPENROUTER_API_KEY;
delete process.env.VENICE_API_KEY;
