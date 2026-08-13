import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/server/log";
import {
  configuredMagicLinkTransport,
  magicLinkEnv,
  magicLinkEvent,
  magicLinkFailureEvent,
  magicLinkPluginEnabled,
  sendMagicLink,
  type MagicLinkEnv,
  type MagicLinkTransport,
} from "./magic-link";

/**
 * Magic-link delivery policy (security-authz.plan.md slice 1). The load-bearing
 * assertions: a production without a **resolved transport** has no plugin — even
 * with the reserved transport env vars set, since an env name is not a sender —
 * and a production log payload carries no `url` key, ever, including on a failed
 * send.
 */

/** Every key a production `auth.magic_link` payload is allowed to carry. */
const APPROVED_PRODUCTION_KEYS = ["email", "error"];

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const LINK = {
  email: "player@vesper.local",
  url: "https://vesper.fly.dev/api/auth/magic-link/verify?token=tokensecret",
};

/** NODE_ENV is read-only in the Next types; assign through a cast for the test. */
function setNodeEnv(value: string | undefined) {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

function clearTransportEnv() {
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_URL;
}

/** A transport that records its sends — the injection point the real registry has no entry for yet. */
function fakeTransport(): MagicLinkTransport & { sends: { email: string; url: string }[] } {
  const sends: { email: string; url: string }[] = [];
  return {
    sends,
    send(email, url) {
      sends.push({ email, url });
      return Promise.resolve();
    },
  };
}

/** A transport that always rejects — the "send failed, don't claim delivery" case. */
function failingTransport(): MagicLinkTransport {
  const err = new Error(`smtp 550 rejected while POSTing ${LINK.url}`);
  err.name = "SmtpError";
  return { send: () => Promise.reject(err) };
}

const DEV: MagicLinkEnv = { production: false, transport: null };
const PROD_NO_TRANSPORT: MagicLinkEnv = { production: true, transport: null };

describe("configuredMagicLinkTransport / magicLinkEnv", () => {
  // Cleared going in as well as out: an ambient transport var in the developer's
  // shell would otherwise make the "no transport" assertions lie.
  beforeEach(clearTransportEnv);

  afterEach(() => {
    clearTransportEnv();
    setNodeEnv(ORIGINAL_NODE_ENV);
  });

  it("resolves no transport — v1 registers no concrete sender", () => {
    expect(configuredMagicLinkTransport()).toBeNull();
  });

  it("still resolves none with the reserved env vars set — a key is not a sender", () => {
    process.env.RESEND_API_KEY = "re_123";
    process.env.SMTP_URL = "smtp://user:pass@mail.example:587";
    expect(configuredMagicLinkTransport()).toBeNull();
  });

  it("reads the resolved transport alongside NODE_ENV", () => {
    expect(magicLinkEnv()).toEqual({ production: false, transport: null });
    setNodeEnv("production");
    process.env.SMTP_URL = "smtp://mail.example";
    expect(magicLinkEnv()).toEqual({ production: true, transport: null });
  });
});

describe("magicLinkPluginEnabled", () => {
  beforeEach(clearTransportEnv);

  afterEach(() => {
    clearTransportEnv();
    setNodeEnv(ORIGINAL_NODE_ENV);
  });

  it("always registers in dev — the logged link is the only local delivery", () => {
    expect(magicLinkPluginEnabled(DEV)).toBe(true);
    expect(magicLinkPluginEnabled({ production: false, transport: fakeTransport() })).toBe(true);
  });

  it("stays off in production while no transport resolves", () => {
    expect(magicLinkPluginEnabled(PROD_NO_TRANSPORT)).toBe(false);
  });

  it("stays off in production even with RESEND_API_KEY / SMTP_URL set", () => {
    setNodeEnv("production");
    process.env.RESEND_API_KEY = "re_123";
    process.env.SMTP_URL = "smtp://user:pass@mail.example:587";
    expect(magicLinkPluginEnabled()).toBe(false);
  });

  it("registers in production once a transport resolves", () => {
    expect(magicLinkPluginEnabled({ production: true, transport: fakeTransport() })).toBe(true);
  });
});

describe("magicLinkEvent", () => {
  it("logs the link in dev so a local sign-in can complete", () => {
    expect(magicLinkEvent(LINK, DEV)).toEqual({
      level: "info",
      message: "magic-link sign-in requested (dev: link logged)",
      data: { email: LINK.email, url: LINK.url },
    });
  });

  it("warns on the production drop and carries the email only", () => {
    const event = magicLinkEvent(LINK, PROD_NO_TRANSPORT);
    expect(event.level).toBe("warn");
    expect(Object.keys(event.data)).toEqual(["email"]);
    expect(event.data).toEqual({ email: LINK.email });
  });

  it("stays email-only once a transport exists", () => {
    const event = magicLinkEvent(LINK, { production: true, transport: fakeTransport() });
    expect(event.level).toBe("info");
    expect(Object.keys(event.data)).toEqual(["email"]);
  });

  it("never puts the url, token, or query string in a production payload", () => {
    const prodEnvs: MagicLinkEnv[] = [PROD_NO_TRANSPORT, { production: true, transport: fakeTransport() }];
    for (const env of prodEnvs) {
      const { data } = magicLinkEvent(LINK, env);
      expect(data).not.toHaveProperty("url");
      expect(data).not.toHaveProperty("token");
      expect(JSON.stringify(data)).not.toContain("tokensecret");
      expect(Object.keys(data).every((key) => APPROVED_PRODUCTION_KEYS.includes(key))).toBe(true);
    }
  });
});

describe("magicLinkFailureEvent", () => {
  it("carries the email and the error class only — never the failing url", () => {
    const event = magicLinkFailureEvent(LINK, new Error(`connect ECONNREFUSED while sending ${LINK.url}`));
    expect(event.level).toBe("error");
    expect(Object.keys(event.data)).toEqual(["email", "error"]);
    expect(event.data).toEqual({ email: LINK.email, error: "Error" });
    expect(JSON.stringify(event.data)).not.toContain("tokensecret");
    expect(event.message).not.toContain("sent");
  });

  it("degrades to the value's type for a non-Error rejection", () => {
    expect(magicLinkFailureEvent(LINK, "boom").data).toEqual({ email: LINK.email, error: "string" });
  });
});

describe("sendMagicLink", () => {
  function spies() {
    return {
      info: vi.spyOn(log, "info").mockImplementation(() => undefined),
      warn: vi.spyOn(log, "warn").mockImplementation(() => undefined),
      error: vi.spyOn(log, "error").mockImplementation(() => undefined),
    };
  }

  beforeEach(clearTransportEnv);

  afterEach(() => {
    clearTransportEnv();
    setNodeEnv(ORIGINAL_NODE_ENV);
    vi.restoreAllMocks();
  });

  it("emits the dev event with the recoverable link", async () => {
    const { info, warn, error } = spies();
    await sendMagicLink(LINK);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
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

  it("hands the email and url to the resolved transport and logs email only", async () => {
    const { info, warn, error } = spies();
    const transport = fakeTransport();
    await sendMagicLink(LINK, { production: true, transport });
    expect(transport.sends).toEqual([{ email: LINK.email, url: LINK.url }]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    const payload = info.mock.calls[0]?.[2] ?? {};
    expect(Object.keys(payload)).toEqual(["email"]);
    expect(JSON.stringify(payload)).not.toContain("tokensecret");
  });

  it("propagates a failed send instead of reporting it as delivered", async () => {
    const { info, warn, error } = spies();
    await expect(sendMagicLink(LINK, { production: true, transport: failingTransport() })).rejects.toThrow(
      /smtp 550/,
    );
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const [, message, payload = {}] = error.mock.calls[0] ?? [];
    expect(message).not.toContain("sent");
    expect(Object.keys(payload)).toEqual(["email", "error"]);
    expect(payload).not.toHaveProperty("url");
    expect(JSON.stringify(payload)).not.toContain("tokensecret");
  });
});
