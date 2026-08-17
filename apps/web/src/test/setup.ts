// Force demo mode in tests: no network LLM/image calls, deterministic pseudo-embeddings.
// EVERY provider credential is cleared, not just the ones demo mode branches on:
// `isDemoMode` keys off OPENROUTER_API_KEY, but a test that resolves a narrator
// still reads FEATHERLESS_API_TOKEN to decide whether that pick is payable, and a
// developer with the secret exported would otherwise get a different answer than CI.
process.env.AI_FAKE = "1";
delete process.env.OPENROUTER_API_KEY;
delete process.env.REPLICATE_API_TOKEN;
delete process.env.FEATHERLESS_API_TOKEN;
