import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/server/log";
import {
  magicLinkEnv,
  magicLinkEvent,
  magicLinkPluginEnabled,
  magicLinkTransportConfigured,
  sendMagicLink,
  type MagicLinkEnv,
} from "./magic-link";

/**
 * Magic-link delivery policy (security-authz.plan.md slice 1). The load-bearing
 * assertions: the plugin is absent in a production without a transport, and a
 * production log payload carries no `url` key, ever.
 */

const DEV: MagicLinkEnv = { production: false, transportConfigured: false };
const PROD_NO_TRANSPORT: MagicLinkEnv = { production: true, transportConfigured: false };
const PROD_WITH_TRANSPORT: MagicLinkEnv = { production: true, transportConfigured: true };

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const LINK = {
  email: "player@vesper.local",
  url: "https://vesper.fly.dev/api/auth/magic-link/verify?token=tokensecret",
};

/** NODE_ENV is read-only in the Next types; assign through a cast for the test. */
function setNodeEnv(value: string | undefined) {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

describe("magicLinkTransportConfigured / magicLinkEnv", () => {
  function clearTransportEnv() {
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_URL;
  }

  // Cleared going in as well as out: an ambient transport var in the developer's
  // shell would otherwise make the "no transport" assertions lie.
  beforeEach(clearTransportEnv);

  afterEach(() => {
    clearTransportEnv();
    setNodeEnv(ORIGINAL_NODE_ENV);
  });

  it("is false with no transport env, and with blank values", () => {
    expect(magicLinkTransportConfigured()).toBe(false);
    process.env.RESEND_API_KEY = "";
    process.env.SMTP_URL = "   ";
    expect(magicLinkTransportConfigured()).toBe(false);
  });

  it("is true when either transport var carries a value", () => {
    process.env.RESEND_API_KEY = "re_123";
    expect(magicLinkTransportConfigured()).toBe(true);
    delete process.env.RESEND_API_KEY;
    process.env.SMTP_URL = "smtp://user:pass@mail.example:587";
    expect(magicLinkTransportConfigured()).toBe(true);
  });

  it("reads the transport fact alongside NODE_ENV", () => {
    expect(magicLinkEnv()).toEqual({ production: false, transportConfigured: false });
    setNodeEnv("production");
    process.env.SMTP_URL = "smtp://mail.example";
    expect(magicLinkEnv()).toEqual({ production: true, transportConfigured: true });
  });
});

describe("magicLinkPluginEnabled", () => {
  it("always registers in dev — the logged link is the only local delivery", () => {
    expect(magicLinkPluginEnabled(DEV)).toBe(true);
    expect(magicLinkPluginEnabled({ production: false, transportConfigured: true })).toBe(true);
  });

  it("registers in production only behind a configured transport", () => {
    expect(magicLinkPluginEnabled(PROD_NO_TRANSPORT)).toBe(false);
    expect(magicLinkPluginEnabled(PROD_WITH_TRANSPORT)).toBe(true);
  });
});

describe("magicLinkEvent", () => {
  it("logs the link in dev so a local sign-in can complete", () => {
    expect(magicLinkEvent(LINK, DEV)).toEqual({
      level: "info",
      message: "magic-link sign-in requested (dev fallback: link logged)",
      data: { email: LINK.email, url: LINK.url },
    });
  });

  it("warns on the production drop and carries the email only", () => {
    const event = magicLinkEvent(LINK, PROD_NO_TRANSPORT);
    expect(event.level).toBe("warn");
    expect(event.data).toEqual({ email: LINK.email });
  });

  it("stays email-only once a transport exists", () => {
    const event = magicLinkEvent(LINK, PROD_WITH_TRANSPORT);
    expect(event.level).toBe("info");
    expect(Object.keys(event.data)).toEqual(["email"]);
  });

  it("never puts the url, token, or query string in a production payload", () => {
    for (const env of [PROD_NO_TRANSPORT, PROD_WITH_TRANSPORT]) {
      const { data } = magicLinkEvent(LINK, env);
      expect(data).not.toHaveProperty("url");
      expect(data).not.toHaveProperty("token");
      expect(JSON.stringify(data)).not.toContain("tokensecret");
    }
  });
});

describe("sendMagicLink", () => {
  function spies() {
    return {
      info: vi.spyOn(log, "info").mockImplementation(() => undefined),
      warn: vi.spyOn(log, "warn").mockImplementation(() => undefined),
    };
  }

  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_URL;
  });

  afterEach(() => {
    setNodeEnv(ORIGINAL_NODE_ENV);
    vi.restoreAllMocks();
  });

  it("emits the dev event with the recoverable link", async () => {
    const { info, warn } = spies();
    await sendMagicLink(LINK);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("auth.magic_link", expect.any(String), { email: LINK.email, url: LINK.url });
  });

  it("emits a url-free warn when production has no transport", async () => {
    const { info, warn } = spies();
    setNodeEnv("production");
    await sendMagicLink(LINK);
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]?.[2] ?? {};
    expect(Object.keys(payload)).toEqual(["email"]);
  });
});
