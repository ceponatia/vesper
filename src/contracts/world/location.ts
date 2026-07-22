import { z } from "zod";

/**
 * Ambient sensory blob on a location ({ scent, sound, light }). Canonical home —
 * server (API input) and client both import this one definition.
 */
export const ambientSchema = z.object({
  scent: z.string().max(500).optional(),
  sound: z.string().max(500).optional(),
  light: z.string().max(500).optional(),
});
export type Ambient = z.infer<typeof ambientSchema>;
