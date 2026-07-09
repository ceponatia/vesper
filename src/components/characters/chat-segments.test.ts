import { describe, expect, it } from "vitest";
import { chatReplySegments } from "./chat-segments";

describe("chatReplySegments — reply → labeled display segments (dialogue-attribution)", () => {
  it("hides the [Name] tag and labels the speaker segment", () => {
    expect(chatReplySegments('Mara leans in.\n[Mara] "You came back."', "Mara")).toEqual([
      { speaker: null, content: "Mara leans in.", showLabel: false },
      { speaker: "Mara", content: '"You came back."', showLabel: true },
    ]);
  });

  it("attributes a bare whole-line quote to the character and labels it", () => {
    expect(chatReplySegments('She sets down the cup.\n"You came back."', "Mara")).toEqual([
      { speaker: null, content: "She sets down the cup.", showLabel: false },
      { speaker: "Mara", content: '"You came back."', showLabel: true },
    ]);
  });

  it("renders an all-prose reply as one unlabeled narrator segment", () => {
    expect(chatReplySegments("Mara watches you from the doorway, saying nothing.", "Mara")).toEqual([
      { speaker: null, content: "Mara watches you from the doorway, saying nothing.", showLabel: false },
    ]);
  });

  it("suppresses the label on a segment that is solely a *Name: …* comms line", () => {
    // The comms styling (Name: label + italic body) already carries the attribution.
    expect(chatReplySegments("[Mara] *Mara: on my way, five minutes*", "Mara")).toEqual([
      { speaker: "Mara", content: "*Mara: on my way, five minutes*", showLabel: false },
    ]);
  });

  it("keeps the label when a speaker segment mixes a comms line with other content", () => {
    const segs = chatReplySegments('[Mara] "Hang on." *Mara: omw*', "Mara");
    expect(segs).toHaveLength(1);
    expect(segs[0]?.speaker).toBe("Mara");
    expect(segs[0]?.showLabel).toBe(true);
  });

  it("handles an empty character name without throwing (no attribution)", () => {
    expect(chatReplySegments('"You came back."', "")).toEqual([
      { speaker: null, content: '"You came back."', showLabel: false },
    ]);
  });
});
