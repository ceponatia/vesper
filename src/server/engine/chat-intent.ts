/**
 * Pre-turn intent cue for character chat (character-chat-state-narration.spec.md §7).
 *
 * Chat has no pre-narrator agent; this is a cheap, regex-first read of the player's input
 * (mirroring `engine/intent.ts`) that raises a ONE-TURN hint when the beat invites an
 * opportunistic cue — the player drawing close, making contact, turning the moment
 * intimate, or putting their attention on the character's appearance
 * (chat-narrator-pov.plan.md). The narrator already carries an opportunistic-cue rule; this just tells it
 * *this* is a turn where a sensory detail or a state beat can land, so cues fire when the
 * beat earns it rather than whenever a band merely allows it. It must NOT persist into chat
 * history, and adds no model call. A blank/OOC input ⇒ no hint ⇒ today's behavior.
 */

export interface ChatCueHint {
  /** The player drew close / approached / reached toward the character. */
  proximity: boolean;
  /** The player made physical contact (touch / hold / embrace). */
  touch: boolean;
  /** The beat turned intimate (kiss / taste / undress / explicit). */
  intimate: boolean;
  /**
   * The player's attention is on the character's appearance — a look-over, a stare,
   * a compliment, a mention of a feature or what they're wearing (chat-narrator-pov.plan.md).
   * Unlike the three above this is NOT proximity-gated: sight carries at any distance.
   */
  attention: boolean;
}

const PROXIMITY_RE =
  /\b(?:lean(?:s|ed|ing)?(?: in| close(?:r)?| toward)?|step(?:s|ped|ping)? (?:close|closer|toward|in)|move(?:s|d)? (?:close|closer|in|toward)|draw(?:s|n|ing)? (?:close|near)|drew (?:close|near)|come(?:s)? closer|slide(?:s|d)? (?:up |in )?(?:beside|next to|close)|press(?:es|ed)? (?:close|against)|sit(?:s|ting)? (?:beside|next to|close)|close the (?:distance|gap)|right up (?:to|against)|inches from)\b/i;

const TOUCH_RE =
  /\b(?:touch(?:es|ed|ing)?|brush(?:es|ed|ing)?(?: against)?|stroke(?:s|d|ing)?|caress(?:es|ed|ing)?|hold(?:s|ing)?|held|hug(?:s|ged|ging)?|embrace(?:s|d|ing)?|take[sn]? (?:your|her|his|their|my) hand|took (?:your|her|his|their|my) hand|grab(?:s|bed|bing)?|squeeze(?:s|d|zing)?|run(?:s|ning)? (?:a |my |your |his |her |their )?(?:hand|fingers|palm)|rest(?:s|ed)? (?:a |my |your |his |her |their )?hand|pull(?:s|ed)? (?:you|her|him|them) (?:close|in)|wrap(?:s|ped)? (?:an? )?arm)\b/i;

// Appearance-directed attention: a gaze verb aimed at a person, an appearance
// compliment, or a possessive + body/clothing noun ("your hair", "her legs"). The
// gaze verbs require a person object so "I glance at the clock" stays silent; the
// possessive arm deliberately excludes "my" (the player's own body isn't the
// character's appearance). A false positive costs only an unused one-turn invite.
const ATTENTION_RE =
  /\b(?:look(?:s|ed|ing)? (?:you|her|him|them) (?:up and down|over)|look(?:s|ed|ing)? (?:at|over) (?:you|her|him|them)\b|watch(?:es|ed|ing)? (?:you|her|him|them)\b|star(?:e|es|ed|ing) at (?:you|her|him|them)\b|gaz(?:e|es|ed|ing) at (?:you|her|him|them)\b|glanc(?:e|es|ed|ing) (?:at|over) (?:you|her|him|them)\b|check(?:s|ed|ing)? (?:you|her|him|them) out|siz(?:e|es|ed|ing) (?:you|her|him|them) up|drink(?:s|ing)? (?:you|her|him|them) in|admir(?:e|es|ed|ing) (?:you|her|him|them)\b|(?:my|his|her|their) eyes (?:linger|trace|travel|wander|drift|rake|roam)|can't (?:stop|help) (?:looking|staring)|you look (?:beautiful|gorgeous|stunning|amazing|incredible|lovely|radiant|hot|great|good|nice)|looks? (?:good|great|amazing|stunning|beautiful|gorgeous|incredible|nice|perfect) on you|(?:your|her|his|their) (?:hair|eyes|lips|smile|face|cheeks?|neck|shoulders?|arms?|chest|waist|hips?|thighs?|legs?|feet|ankles?|figure|curves?|skin|dress|skirt|blouse|neckline|outfit|heels|stockings?)\b)/i;

const INTIMATE_RE =
  /\b(?:kiss(?:es|ed|ing)?|taste(?:s|d)?|tasting|lick(?:s|ed|ing)?|nibble(?:s|d|ing)?|undress(?:es|ed|ing)?|strip(?:s|ped|ping)?|naked|bare(?:s|d)? (?:skin|chest|body)?|slip(?:s|ped)? (?:off|out of)|pull(?:s|ed)? off (?:your|her|his|their|my)|bite(?:s)? (?:your|her|his|their) (?:lip|neck)|breath(?:e|es)? against|mouth(?:es|ed)? (?:at|on))\b/i;

export function detectChatCue(input: string): ChatCueHint {
  const text = input ?? "";
  return {
    proximity: PROXIMITY_RE.test(text),
    touch: TOUCH_RE.test(text),
    intimate: INTIMATE_RE.test(text),
    attention: ATTENTION_RE.test(text),
  };
}

/**
 * Render the one-turn cue invitation line for the prompt (most-charged signal wins:
 * intimate > touch > proximity > attention), or "" when the input invites nothing. The
 * route passes the rendered string to the prompt builder, so the builder stays a pure
 * function over a plain string. Each arm is worded as sensation ARRIVING in the
 * player's senses, never as the character's property (chat-narrator-pov.plan.md).
 */
export function chatCueInviteLine(cue: ChatCueHint, name: string): string {
  if (cue.intimate) {
    return `This turn the moment is turning intimate — a sensory detail (scent, warmth, taste, the catch of ${name}'s breath) or a visible shift in ${name}'s state can land now, written as it reaches the player's senses. Weave at most one into the action; never list it.`;
  }
  if (cue.touch) {
    return `The player has just made contact — closeness like this is a moment a single sensory cue (warmth, scent, texture) can register in the player's own senses. Use one only if ${name} has it, woven into a gesture; never list it.`;
  }
  if (cue.proximity) {
    return `The player has drawn close — if ${name} has a sensory cue (scent, the sound of their voice), this is when it might reach them. One at most, woven into action, never announced.`;
  }
  if (cue.attention) {
    return `The player's attention is on ${name}'s appearance — this is a turn where one concrete visual detail (drawn from ${name}'s attributes and what ${name} is wearing) lands well, woven into ${name}'s reaction and seen from the player's eye. One detail at most; never a head-to-toe description.`;
  }
  return "";
}
