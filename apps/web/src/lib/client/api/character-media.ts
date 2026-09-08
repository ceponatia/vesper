import { z } from "zod";
import { characterMediaJobSchema, type CharacterMediaJob, type CharacterMediaRetryTarget } from "@/contracts";
import { apiGet } from "./http";
import { arrayOf } from "./shared";

export const characterMediaJobsClientResponseSchema = z.object({
  jobs: arrayOf(characterMediaJobSchema),
});
export type CharacterMediaJobsClientResponse = z.infer<typeof characterMediaJobsClientResponseSchema>;

export const characterMediaJobsApi = {
  list: (characterId: string) =>
    apiGet(characterMediaJobsClientResponseSchema, `/api/characters/${characterId}/media-jobs`),
};

export type { CharacterMediaJob, CharacterMediaRetryTarget };
