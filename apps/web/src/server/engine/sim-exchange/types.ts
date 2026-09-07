export type SimChatExchangeResult =
  | {
      ok: true;
      messageId: string;
      prose: string;
      cutId: string;
      modelId: string;
      attempts: number;
      degraded: boolean;
      diagnostics: string[];
    }
  | {
      ok: false;
      code: "not_sim_enabled" | "sim_open_failed" | "render_withheld" | "nothing_to_retake" | "world_catching_up";
      message: string;
      status: number;
    };

/**
 * The successor exchange modes: a player-driven
 * turn, an utterance-free turn that still advances the span (continue/open),
 * or a same-cut re-render (retake = regenerate/rerun).
 */
export type SimChatExchangeMode = "send" | "continue" | "open" | "retake";
