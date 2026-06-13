import { z } from "zod";
import { humanoidBodyLocations } from "./locations";

export const bodyPlanSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  bodyLocationIds: z.array(z.string().min(1)).readonly(),
});

export type BodyPlan = z.infer<typeof bodyPlanSchema>;

/**
 * Body plans are data; non-humanoid plans (quadruped, avian, …) are future
 * additions to this list, not refactors. Characters reference a bodyPlanId.
 */
export const bodyPlans: readonly BodyPlan[] = [
  {
    id: "humanoid",
    label: "Humanoid",
    description: "Bipedal humanoid body plan.",
    bodyLocationIds: humanoidBodyLocations.map((l) => l.id),
  },
];

export function bodyPlanById(id: string): BodyPlan | undefined {
  return bodyPlans.find((p) => p.id === id);
}

export const DEFAULT_BODY_PLAN_ID = "humanoid";
