import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_NPC_SCENE_AUTHORITY_KINDS,
  chatNpcSceneAuthorityKinds,
} from "./constants";

const ENV = "CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS";

afterEach(() => {
  delete process.env[ENV];
});

describe("chatNpcSceneAuthorityKinds", () => {
  it("defaults an unset scope to the first rollout increment only", () => {
    expect([...chatNpcSceneAuthorityKinds()]).toEqual(["movement"]);
    expect(DEFAULT_NPC_SCENE_AUTHORITY_KINDS).toEqual(["movement"]);
  });

  it("treats a blank scope exactly like an unset scope", () => {
    process.env[ENV] = "   ";
    expect([...chatNpcSceneAuthorityKinds()]).toEqual(["movement"]);
  });

  it("requires explicit expansion for starts and updates", () => {
    process.env[ENV] = "movement,start";
    expect([...chatNpcSceneAuthorityKinds()]).toEqual(["movement", "start"]);

    process.env[ENV] = "movement,start,update";
    expect([...chatNpcSceneAuthorityKinds()]).toEqual(["movement", "start", "update"]);
  });

  it("grants nothing for a nonblank scope containing no known kind", () => {
    process.env[ENV] = "movment,starts";
    expect([...chatNpcSceneAuthorityKinds()]).toEqual([]);
  });
});
