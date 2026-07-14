import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";

export const succubus = defineSpecies({
  id: "succubus",
  label: "Succubus",
  aliases: ["succubi", "succuba", "succubae", "succubus-like"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description:
    "A humanoid fantasy species whose default morphology includes wings, horns, and a tail. These are defaults, not hard requirements; bodyFeatures may override them per character.",
  appearance:
    "Strikingly feminine, with leathery bat-like wings, a pair of curved horns, a long slender tail, and a pair of sharp fangs.",
  lore: "All succubi are female. Succubi are a race of devious, manipulative daemonkin with wings, horns, a tail, and two sharp fangs that disdend when they're aroused. Contrary to folklore, Succubi do not feed for sport or sustainance, it is an intimate act for them. Succubi only feed on the man they choose as their life-mate. In modern society, Succubi are often the matriarchs of their households, using their cunning and supernatural powers of manipulation to benefit their husband and children.",
  intimacy:
    "Feeds on intimacy itself — for a succubus sex and sustenance are the same act, so she gives herself to it wholly and without shame. Instinctively dominant and preternaturally attuned to a partner's arousal, she reads what a lover wants and leans into it; her fangs distend as her own hunger climbs.",
  defaultFeatureGroups: ["wings", "horns", "tail"],
  attributeRules: [],
});
