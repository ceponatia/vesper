import { describe, expect, it, vi } from "vitest";
import { applyDatabaseHardening, IMAGE_PATH_CONTAINMENT_SQL } from "./db-hardening";

describe("database hardening", () => {
  it("repairs image paths before installing the canonical check constraint", async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await applyDatabaseHardening({ query } as never);

    expect(query).toHaveBeenCalledOnce();
    expect(IMAGE_PATH_CONTAINMENT_SQL).toContain(
      `SET "path" = 'images/' || "owner_id" || '/' || "id" || '.webp'`,
    );
    expect(IMAGE_PATH_CONTAINMENT_SQL).toContain(`ADD CONSTRAINT "images_path_canonical"`);
    expect(IMAGE_PATH_CONTAINMENT_SQL).toContain(
      `CHECK ("path" = 'images/' || "owner_id" || '/' || "id" || '.webp')`,
    );
    expect(IMAGE_PATH_CONTAINMENT_SQL.indexOf("UPDATE \"images\"")).toBeLessThan(
      IMAGE_PATH_CONTAINMENT_SQL.indexOf("ADD CONSTRAINT"),
    );
  });
});
