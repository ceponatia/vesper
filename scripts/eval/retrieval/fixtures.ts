import type { FactKind, FactSubjectKind } from "@/contracts/facts/taxonomy";

/**
 * Fixture corpora for the retrieval eval harness — the measurement precondition
 * for the retrieval-quality work (FACT_MIN_SCORE floor, pinned
 * force-include, per-query embedding + RRF fusion).
 *
 * Each fixture is a small chat-shaped memory corpus (1-on-1 romance-chat
 * flavored, docs/character-chat/) plus queries and expectations:
 *
 * - `expectRelevant` — fact/episode keys that SHOULD be retrieved by the
 *   fixture's queries (a miss is a recall failure).
 * - `expectExcluded` — distractor keys that should NOT be retrieved: off-topic
 *   facts that must fall below the FACT_MIN_SCORE floor, and episodes inside
 *   the EPISODE_WINDOW recency window (excluded structurally, not by floor).
 *
 * Keys are fixture-local and unique across facts + episodes (fixtures.test.ts
 * enforces the integrity rules). The runner (run.ts) seeds each fixture into a
 * throwaway chat memory group through the REAL `addFacts`/`appendEpisode`,
 * retrieves through the REAL fused retrievers, and always cleans up.
 */

export interface FixtureFact {
  /** Stable fixture-local key referenced by the expectation lists. */
  key: string;
  text: string;
  subjectName: string;
  subjectKind: FactSubjectKind;
  /** Fact taxonomy kind; the runner defaults to "knowledge". */
  kind?: FactKind;
  /** Seeded pinned with origin "player" — must be force-included regardless of similarity. */
  pinned?: boolean;
  tags?: string[];
}

export interface FixtureEpisode {
  /** Stable fixture-local key referenced by the expectation lists. */
  key: string;
  /**
   * Explicit exchange ordinal. Episodes with turnNumber > max(turnNumber) −
   * EPISODE_WINDOW are inside the recency window and structurally excluded
   * from RAG (they'd ride in context verbatim in a real chat).
   */
  turnNumber: number;
  summary: string;
}

export interface RetrievalFixture {
  id: string;
  title: string;
  /** Which retrieval behavior this fixture measures (coverage letter). */
  covers: string;
  facts: FixtureFact[];
  episodes: FixtureEpisode[];
  /** Retrieval queries — fed to the fused retrievers as-is, and newline-joined for the baseline. */
  queries: string[];
  /** Keys that SHOULD surface. */
  expectRelevant: string[];
  /** Keys that should NOT surface (floor rejection or recency window). */
  expectExcluded: string[];
}

export const RETRIEVAL_FIXTURES: RetrievalFixture[] = [
  {
    id: "direct-recall",
    title: "Direct recall — the query names the fact",
    covers: "(a) direct recall: lexical overlap between query and fact text",
    facts: [
      {
        key: "mara-flowers",
        text: "Mara's favorite flowers are white peonies — she keeps a chipped jar of them beside the café register.",
        subjectName: "Mara",
        subjectKind: "character",
        kind: "preference",
        tags: ["flowers"],
      },
      {
        key: "mara-birthday",
        text: "Mara's birthday is October 14th; she pretends not to care about it.",
        subjectName: "Mara",
        subjectKind: "character",
      },
      {
        key: "mara-shift",
        text: "Mara works the closing shift at the Driftwood Café on weeknights.",
        subjectName: "Mara",
        subjectKind: "character",
      },
      {
        key: "dx-houseboat",
        text: "The player's cousin Dmitri is remodeling a houseboat in Rotterdam.",
        subjectName: "player",
        subjectKind: "player",
      },
      {
        key: "dx-taxes",
        text: "The tax filing deadline got pushed to mid-May this year.",
        subjectName: "world",
        subjectKind: "world",
      },
    ],
    episodes: [],
    queries: ["What are Mara's favorite flowers?"],
    expectRelevant: ["mara-flowers"],
    expectExcluded: ["dx-houseboat", "dx-taxes"],
  },
  {
    id: "paraphrase-recall",
    title: "Paraphrase recall — semantic match, no shared keywords",
    covers: "(b) paraphrase recall: the query shares meaning but not vocabulary with the fact",
    facts: [
      {
        key: "rowan-shellfish",
        text: "Rowan is badly allergic to shellfish — one bite of shrimp at a wedding put him in the ER.",
        subjectName: "Rowan",
        subjectKind: "character",
        tags: ["allergy"],
      },
      {
        key: "rowan-orchard",
        text: "Rowan grew up on his family's apple orchard outside Wenatchee and still prunes the old trees every winter.",
        subjectName: "Rowan",
        subjectKind: "character",
      },
      {
        key: "rowan-guitar",
        text: "Rowan keeps a battered guitar behind the bar and claims he only knows four chords.",
        subjectName: "Rowan",
        subjectKind: "character",
      },
      {
        key: "dx-laundromat",
        text: "The laundromat on Fifth Street raised its prices again.",
        subjectName: "world",
        subjectKind: "world",
      },
    ],
    episodes: [],
    queries: [
      "Is there any food I should avoid ordering for our dinner date?",
      "Where did he spend his childhood?",
    ],
    expectRelevant: ["rowan-shellfish", "rowan-orchard"],
    expectExcluded: ["dx-laundromat"],
  },
  {
    id: "distractor-rejection",
    title: "Distractor rejection — off-topic facts must fall below the floor",
    covers: "(c) distractor rejection: FACT_MIN_SCORE keeps unrelated facts out of the channel",
    facts: [
      {
        key: "sable-dance",
        text: "The player confessed to Sable that they've never slow-danced with anyone.",
        subjectName: "player",
        subjectKind: "player",
        kind: "secret",
      },
      {
        key: "sable-jazz",
        text: "Sable hums old jazz standards to herself when she thinks no one is listening.",
        subjectName: "Sable",
        subjectKind: "character",
        kind: "preference",
      },
      {
        key: "dx-bus",
        text: "The city rerouted the number 7 bus for sewer work through the end of the month.",
        subjectName: "world",
        subjectKind: "world",
      },
      {
        key: "dx-detergent",
        text: "The corner store stopped stocking the lavender laundry detergent.",
        subjectName: "world",
        subjectKind: "world",
      },
      {
        key: "dx-printer",
        text: "The office printer on the third floor jams on envelopes.",
        subjectName: "world",
        subjectKind: "world",
      },
    ],
    episodes: [],
    queries: ["Have we ever talked about dancing together?", "What has the player admitted to Sable?"],
    expectRelevant: ["sable-dance"],
    expectExcluded: ["dx-bus", "dx-detergent", "dx-printer"],
  },
  {
    id: "pinned-force-include",
    title: "Pinned force-include — a pinned fact dissimilar to every query still surfaces",
    covers: "(d) pinned force-include: 'remember this' rides ahead of the top-k, floor-exempt",
    facts: [
      {
        key: "nadia-callsign",
        text: "Always call the player 'Captain' — they asked Nadia to keep using the nickname.",
        subjectName: "player",
        subjectKind: "player",
        kind: "preference",
        pinned: true,
        tags: ["nickname"],
      },
      {
        key: "nadia-wine",
        text: "Nadia and the player split a bottle of dry Riesling on the rooftop and watched the ferries come in.",
        subjectName: "Nadia",
        subjectKind: "character",
        kind: "event",
      },
      {
        key: "nadia-scarf",
        text: "Nadia knits in secret; the crooked red scarf she gave the player took her three tries.",
        subjectName: "Nadia",
        subjectKind: "character",
      },
      {
        key: "dx-dentist",
        text: "The player's dentist appointment moved to Thursday afternoon.",
        subjectName: "player",
        subjectKind: "player",
      },
    ],
    episodes: [],
    queries: ["What did we drink on the rooftop that night?"],
    expectRelevant: ["nadia-wine", "nadia-callsign"],
    expectExcluded: ["dx-dentist"],
  },
  {
    id: "multi-query-fusion",
    title: "Multi-query fusion — two queries, two different targets, both must surface",
    covers:
      "(e) multi-query fusion: per-query embedding + RRF should beat the newline-joined single query, which dilutes both topics",
    facts: [
      {
        key: "wren-recital",
        text: "Wren's conservatory recital is Friday evening — she's playing the Elgar cello concerto and is terrified of the third movement.",
        subjectName: "Wren",
        subjectKind: "character",
        kind: "event",
      },
      {
        key: "wren-taffy",
        text: "The player promised to bring Wren saltwater taffy from the boardwalk the next time they visit.",
        subjectName: "player",
        subjectKind: "player",
        kind: "commitment",
      },
      {
        key: "wren-tea",
        text: "Wren drinks peppermint tea with far too much honey when she's nervous.",
        subjectName: "Wren",
        subjectKind: "character",
        kind: "preference",
      },
      {
        key: "wren-cat",
        text: "Wren's cat, Pergolesi, sleeps inside her cello case whenever she leaves it open.",
        subjectName: "Wren",
        subjectKind: "character",
      },
      {
        key: "wren-brother",
        text: "Wren's older brother Theo teaches sailing on the lake every summer.",
        subjectName: "Wren",
        subjectKind: "character",
      },
      {
        key: "wren-rain",
        text: "Wren loves practicing with the window open while it rains.",
        subjectName: "Wren",
        subjectKind: "character",
        kind: "preference",
      },
      {
        key: "wren-stagefright",
        text: "Wren froze on stage once at fifteen and still dreams about it before big performances.",
        subjectName: "Wren",
        subjectKind: "character",
      },
      {
        key: "wren-nails",
        text: "Wren paints her nails a different color before every performance — this week it's seafoam green.",
        subjectName: "Wren",
        subjectKind: "character",
      },
      {
        key: "dx-hallway",
        text: "The player's landlord still hasn't fixed the flickering hallway light.",
        subjectName: "player",
        subjectKind: "player",
      },
    ],
    episodes: [],
    queries: ["How is Wren feeling about the recital on Friday?", "What did I promise to bring back for Wren?"],
    expectRelevant: ["wren-recital", "wren-taffy"],
    expectExcluded: ["dx-hallway"],
  },
  {
    id: "episode-window-recall",
    title: "Episode recall past the recency window",
    covers:
      "(f) episode recall: an old on-topic episode surfaces via RAG; in-window episodes stay out structurally, off-topic old ones fall below the episode floor",
    facts: [],
    episodes: [
      {
        key: "ep-ferry",
        turnNumber: 1,
        summary:
          "Small talk on the ferry about timetables and the weather; Isolde teased the player for actually reading the safety card.",
      },
      {
        key: "ep-first-kiss",
        turnNumber: 2,
        summary:
          "A sudden downpour caught them under the pier — their first kiss, Isolde laughing about her ruined mascara while the player draped a coat over her shoulders.",
      },
      {
        key: "ep-bookshop",
        turnNumber: 3,
        summary: "They browsed the secondhand bookshop; Isolde bought the player a dog-eared collection of sea poems.",
      },
      {
        key: "ep-argument",
        turnNumber: 4,
        summary:
          "A small argument about Isolde working through the weekend again; they made up over lukewarm cocoa on the seawall.",
      },
      {
        key: "ep-market",
        turnNumber: 5,
        summary: "A slow morning at the fish market; Isolde haggled a crate of oranges down to half price and shared one, section by section.",
      },
      {
        key: "ep-lanterns",
        turnNumber: 6,
        summary: "They lit paper lanterns for the harbor festival; Isolde made a wish she refused to tell.",
      },
      {
        key: "ep-storm",
        turnNumber: 7,
        summary: "A storm knocked the power out; they played cards by candlelight and Isolde cheated shamelessly.",
      },
      {
        key: "ep-goodnight-kiss",
        turnNumber: 8,
        summary: "A slow kiss goodnight at Isolde's door; she almost asked the player to stay.",
      },
    ],
    queries: ["Do you remember our first kiss?"],
    expectRelevant: ["ep-first-kiss"],
    expectExcluded: ["ep-ferry", "ep-goodnight-kiss"],
  },
  {
    id: "mixed-channels",
    title: "Mixed channels — one corpus, expectations across facts AND episodes",
    covers: "(a)+(f) combined: fact and episode retrievers run over the same scope with shared queries",
    facts: [
      {
        key: "juno-coffee",
        text: "Juno takes her coffee with crushed cardamom and exactly one sugar cube, stirred counterclockwise.",
        subjectName: "Juno",
        subjectKind: "character",
        kind: "preference",
        tags: ["coffee"],
      },
      {
        key: "juno-freckles",
        text: "Juno has a constellation of freckles on her left shoulder she calls her Cassiopeia.",
        subjectName: "Juno",
        subjectKind: "character",
      },
      {
        key: "dx-recycling",
        text: "Recycling pickup moved to Wednesdays for the whole block.",
        subjectName: "world",
        subjectKind: "world",
      },
    ],
    episodes: [
      {
        key: "ep-paella",
        turnNumber: 1,
        summary:
          "They attempted paella; the smoke alarm went off twice and they ended up eating buttered toast on the balcony, laughing until midnight.",
      },
      {
        key: "ep-groceries",
        turnNumber: 2,
        summary: "Grocery run in the rain; Juno insisted on carrying the heavier bag and lost the argument about umbrellas.",
      },
      {
        key: "ep-movie",
        turnNumber: 3,
        summary: "They watched a terrible vampire movie; Juno narrated the plot holes in a stage whisper.",
      },
      {
        key: "ep-walk",
        turnNumber: 4,
        summary: "A long walk along the canal at dusk; Juno pointed out which houseboats she'd steal, in order.",
      },
      {
        key: "ep-teasing",
        turnNumber: 5,
        summary: "Juno teased the player mercilessly about their alphabetized spice rack, then reorganized it herself.",
      },
    ],
    queries: ["How does Juno take her coffee?", "What happened the night we tried to cook dinner together?"],
    expectRelevant: ["juno-coffee", "ep-paella"],
    expectExcluded: ["dx-recycling"],
  },
];
