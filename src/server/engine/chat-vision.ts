import { promises as fs } from "node:fs";
import { z } from "zod";
import { diag, type DiagnosticSink } from "@/contracts";
import { generateChecked, isDemoMode, visionModelId, withGenerateTimeout, type GenerateImagePart } from "../ai";
import { absoluteImagePath } from "../images";

/**
 * The chat-photo vision read (chat-image-input.plan.md): ONE batched call
 * describes every photo a player message attached (owner ruling: multi-image
 * from the start ⇒ one call, ordered descriptions — never a call per image).
 * The descriptions are what the narrator "sees" (injected as seen-channel
 * content) and what the pulse/archivist read, so they are factual and compact.
 * Everything degrades to the fallback line + `chat_vision.describe_failed` —
 * a photo the character can't make out, never a failed exchange. Runs on the
 * pre-reply path, so the timeout is tight.
 */

/** Max attachments per message (mirrored by the route schema + composer). */
export const CHAT_ATTACHMENTS_MAX = 4;
/** Per-photo description cap — a look, not an essay. */
export const CHAT_VISION_DESC_MAX_CHARS = 600;
/** Vision is on the pre-reply latency path: trip fast and degrade. */
export const CHAT_VISION_TIMEOUT_MS = 20_000;
/** What the character sees when the read failed — degraded, in-fiction. */
export const CHAT_VISION_FALLBACK = "a photo you can't quite make out";

const chatVisionSchema = z.object({
  /** One entry per attached photo, in the order given. */
  photos: z.array(z.string().max(CHAT_VISION_DESC_MAX_CHARS).catch("")).catch([]).default([]),
});

const CHAT_VISION_SYSTEM = `You describe photos a user attached to a chat message, for a character who is being shown them. For EACH photo, in the order given, write 2–4 plain factual sentences: what or who it shows, the setting, and the notable concrete details someone looking at it would register. No speculation beyond what is visible, no meta-commentary about image quality or that it is an image. Output ONLY a JSON object: {"photos": ["<description of photo 1>", "<description of photo 2>", ...]} with exactly one entry per photo.`;

export interface DescribeChatPhotosResult {
  /** One description per input id, order preserved (fallback text where the read failed). */
  descriptions: string[];
  /** True when the whole read degraded (demo/timeout/parse) — callers should NOT persist. */
  degraded: boolean;
}

/**
 * Describe a message's attachments in one vision call. `files` come from
 * `claimChatAttachments`/`chatAttachmentPaths` (already validated as this
 * chat's ready uploads). A missing file, a degraded call, or a short answer
 * fills the gap with CHAT_VISION_FALLBACK — the exchange always proceeds.
 */
export async function describeChatPhotos(input: {
  files: readonly { id: string; path: string }[];
  sink?: DiagnosticSink;
}): Promise<DescribeChatPhotosResult> {
  const fallback = input.files.map(() => CHAT_VISION_FALLBACK);
  if (input.files.length === 0) return { descriptions: [], degraded: false };
  if (isDemoMode()) {
    // Never invent a reading of an image nobody looked at (the portrait pass's rule).
    input.sink?.push(diag("info", "chat_vision.describe_failed", "demo mode; attachments unread"));
    return { descriptions: fallback, degraded: true };
  }

  const parts: GenerateImagePart[] = [];
  for (const file of input.files) {
    try {
      parts.push({ data: await fs.readFile(absoluteImagePath(file)), mediaType: "image/webp" });
    } catch (err) {
      input.sink?.push(
        diag("warn", "chat_vision.describe_failed", `attachment unreadable: ${err instanceof Error ? err.message : String(err)}`),
      );
      return { descriptions: fallback, degraded: true };
    }
  }

  const controller = new AbortController();
  const work = generateChecked({
    schema: chatVisionSchema,
    system: CHAT_VISION_SYSTEM,
    prompt: `Photos attached: ${input.files.length}. Describe each in order.`,
    images: parts,
    modelId: visionModelId(),
    temperature: 0,
    code: "chat_vision.describe",
    sink: input.sink,
    fallback: () => ({ photos: [] }),
    signal: controller.signal,
    degradeSeverity: "warn",
  });
  const { value, degraded } = await withGenerateTimeout(work, controller, CHAT_VISION_TIMEOUT_MS, "chat_vision.describe_failed", input.sink);
  const photos = value?.photos ?? [];
  if (degraded || photos.every((p) => !p.trim())) {
    input.sink?.push(diag("warn", "chat_vision.describe_failed", "vision read degraded; attachments unread"));
    return { descriptions: fallback, degraded: true };
  }
  // Align to the input count: a short/blank entry degrades to the fallback line.
  const descriptions = input.files.map((_, i) => photos[i]?.trim() || CHAT_VISION_FALLBACK);
  return { descriptions, degraded: false };
}
