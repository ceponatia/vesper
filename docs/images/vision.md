# Image understanding (vision input)

The reverse direction — a model **looking at** a stored image — serves the
character-sheet forge's portrait→attributes pass
([authoring/in-sheet-forge.md](../authoring/in-sheet-forge.md)). It runs on **OpenRouter, not
Replicate** (Replicate is generation/editing only here): `generateChecked` accepts an
`images` option (raw bytes or base64 + mediaType, sent as message image parts) and
`visionModelId()` (`server/ai/provider.ts` `MODEL_DEFAULTS.vision`, currently
`qwen/qwen3-vl-235b-a22b-instruct`) is the code-default vision model — no override
layer. First consumer: `server/authoring/portrait-attributes.ts`, which reads a
character's ready avatar (bytes via `absoluteImagePath` + `fs.readFile`) and emits
closed-vocabulary attribute readings. Demo mode degrades to schema defaults (an empty
reading), never an invented one. Second consumer: the **chat photo read**
(`server/engine/chat-vision.ts` — one batched call describing a message's attached
photos, degrading to "a photo you can't quite make out"; [pipelines/chat-images.md](pipelines/chat-images.md) §Player photo attachments).
Add a vision consumer the same way: closed output
vocabulary, `generateChecked` + `images`, ground the output, degrade to a no-op.
