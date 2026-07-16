import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Experimental Gate 0 read perspective. Undefined preserves the legacy unfiltered
 * behavior; a supplied participant id admits only rows they witnessed plus rows
 * explicitly written with an empty witness list (authored/global memory).
 */
export interface WitnessEligibility {
  viewpointId?: string;
}

/**
 * SQL eligibility fence for facts/episodes, composed BEFORE ordering and LIMIT.
 * Non-array legacy corruption is denied rather than crashing the query or leaking.
 */
export function witnessEligibilityWhere(
  witnessedBy: AnyPgColumn,
  eligibility?: WitnessEligibility,
): SQL {
  const viewpointId = eligibility?.viewpointId?.trim();
  if (!viewpointId) return sql`true`;
  const singleton = JSON.stringify([viewpointId]);
  return sql`(
    jsonb_typeof(${witnessedBy}) = 'array'
    and (
      jsonb_array_length(${witnessedBy}) = 0
      or ${witnessedBy} @> ${singleton}::jsonb
    )
  )`;
}
