import { describe, expect, it } from "vitest";
import { collectStream } from "@/server/test-support";
import { stripMisplacedSpeakerTags, stripMisplacedSpeakerTagStream, type SpeakerTagVocabulary } from "./narrator-speaker-tags";

const VOCAB: SpeakerTagVocabulary = { speakers: ["Mara Solane"], plain: ["Brian"] };

/** Feed an array of deltas through the streaming cleaner and join the result. */
const streamClean = (chunks: readonly string[], vocab: SpeakerTagVocabulary = VOCAB): Promise<string> =>
  collectStream(chunks, (source) => stripMisplacedSpeakerTagStream(source, vocab));

describe("stripMisplacedSpeakerTags (one-shot)", () => {
  it("de-brackets the player's name inside quoted dialogue (owner report 2026-08-02)", () => {
    expect(stripMisplacedSpeakerTags('[Mara] "Nice to see you, [Brian]."', VOCAB)).toBe(
      '[Mara] "Nice to see you, Brian."',
    );
  });

  it("keeps a legitimate line-opening speaker tag, full name or first name", () => {
    expect(stripMisplacedSpeakerTags('[Mara Solane] "Here already?"', VOCAB)).toBe('[Mara Solane] "Here already?"');
    expect(stripMisplacedSpeakerTags('[mara] "Here already?"', VOCAB)).toBe('[mara] "Here already?"');
  });

  it("de-brackets a roster name that is not opening the line", () => {
    expect(stripMisplacedSpeakerTags("She watches [Mara] cross the room.", VOCAB)).toBe(
      "She watches Mara cross the room.",
    );
  });

  it("de-brackets the player's name even at a line start — the player is never a tag", () => {
    // The renderer's tag vocabulary is the roster alone, so this would leak literally.
    expect(stripMisplacedSpeakerTags('[Brian] "I brought the wine."', VOCAB)).toBe('Brian "I brought the wine."');
  });

  it("cleans every line of a multi-line reply, and every span on a line", () => {
    const reply = '[Mara] "Sit, [Brian]. Please."\n\nShe pours. "[Brian], listen to me — [Brian]."';
    expect(stripMisplacedSpeakerTags(reply, VOCAB)).toBe(
      '[Mara] "Sit, Brian. Please."\n\nShe pours. "Brian, listen to me — Brian."',
    );
  });

  it("leaves unknown bracketed spans alone", () => {
    const prose = "The sign read [CLOSED] and a [waiter] passed.";
    expect(stripMisplacedSpeakerTags(prose, VOCAB)).toBe(prose);
  });

  it("leaves ordinary prose and an empty vocabulary untouched", () => {
    const prose = 'Mara leans in. "Good to see you, Brian."';
    expect(stripMisplacedSpeakerTags(prose, VOCAB)).toBe(prose);
    expect(stripMisplacedSpeakerTags('[Mara] "Hi, [Brian]."', { speakers: [], plain: [] })).toBe(
      '[Mara] "Hi, [Brian]."',
    );
  });
});

describe("stripMisplacedSpeakerTagStream", () => {
  it("de-brackets a name split across deltas", async () => {
    expect(await streamClean(['[Mara] "Nice to see you, [Bri', 'an]."'])).toBe('[Mara] "Nice to see you, Brian."');
  });

  it("preserves a leading tag arriving one character at a time", async () => {
    const reply = '[Mara] "Here already, [Brian]?"';
    expect(await streamClean([...reply])).toBe('[Mara] "Here already, Brian?"');
  });

  it("tracks line starts across chunk boundaries", async () => {
    // The second chunk opens a fresh line: its tag is legitimate and stays.
    expect(await streamClean(['She sets down the mug.\n', '[Mara] "For [Brian]."'])).toBe(
      'She sets down the mug.\n[Mara] "For Brian."',
    );
    // ...but a chunk that merely continues a line carries no tag position.
    expect(await streamClean(['She smiles at ', '[Mara] and waits.'])).toBe("She smiles at Mara and waits.");
  });

  it("flushes an unclosed bracket run at stream end", async () => {
    expect(await streamClean(['[Mara] "Wait, [Bri'])).toBe('[Mara] "Wait, [Bri');
  });

  it("releases a bracket run too long to be a name instead of holding the stream", async () => {
    const long = `[${"x".repeat(80)}`;
    expect(await streamClean([long, " and on."])).toBe(`${long} and on.`);
  });

  it("passes the stream through untouched when nothing is known", async () => {
    expect(await streamClean(['[Mara] "Hi, [Brian]."'], { speakers: [] })).toBe('[Mara] "Hi, [Brian]."');
  });
});
