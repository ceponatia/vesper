"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { apiGet } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { signIn, signUp } from "./auth-client";

/** Providers we know how to label; the server only enables ones with env creds. */
const PROVIDER_LABELS = { google: "Google", github: "GitHub", discord: "Discord" } as const;
type KnownProvider = keyof typeof PROVIDER_LABELS;

const configSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" ? raw : {}),
  z.object({
    providers: z.array(z.string()).catch([]),
    magicLink: z.boolean().catch(true),
  }),
);

function isKnownProvider(p: string): p is KnownProvider {
  return p === "google" || p === "github" || p === "discord";
}

/**
 * Thin sign-in / sign-up surface: email+password with a mode toggle, a
 * magic-link request, and OAuth buttons for whichever providers the server
 * reports as env-enabled. Expandable — more methods are just more buttons. On
 * success the signed session cookie is set, so we route home.
 */
export function SignInForm() {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<KnownProvider[]>([]);
  const [magicLinkEnabled, setMagicLinkEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    void apiGet(configSchema, "/api/auth-config").then((r) => {
      if (!active || !r.ok) return;
      setProviders(r.data.providers.filter(isKnownProvider));
      setMagicLinkEnabled(r.data.magicLink);
    });
    return () => {
      active = false;
    };
  }, []);

  function onDone(title: string) {
    toast.push({ title, tone: "success" });
    router.push("/");
    router.refresh();
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const result =
      mode === "signin"
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name: name.trim() || email.split("@")[0] || "Player" });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? "Something went wrong. Try again.");
      return;
    }
    onDone(mode === "signin" ? "Signed in" : "Account created");
  }

  async function onMagicLink() {
    if (!email.trim()) {
      setError("Enter your email first.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await signIn.magicLink({ email, callbackURL: "/" });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? "Could not send the link.");
      return;
    }
    toast.push({ title: "Check your email", description: "We sent you a sign-in link.", tone: "success" });
  }

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16">
      <h1 className="prose-display mb-1 text-2xl text-paper-50 italic">Vesper</h1>
      <p className="mb-6 text-sm text-paper-400">
        {mode === "signin" ? "Sign in to your account." : "Create an account to start forging."}
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4"
      >
        {mode === "signup" && (
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Optional — defaults to your email name"
                autoComplete="name"
              />
            )}
          </Field>
        )}
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          )}
        </Field>
        <Field label="Password" error={error}>
          {(id) => (
            <Input
              id={id}
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
            />
          )}
        </Field>
        <Button type="submit" busy={busy}>
          {mode === "signin" ? "Sign in" : "Create account"}
        </Button>
      </form>

      {magicLinkEnabled && (
        <Button variant="ghost" className="mt-3 w-full" busy={busy} onClick={onMagicLink}>
          Email me a sign-in link
        </Button>
      )}

      {providers.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          {providers.map((p) => (
            <Button key={p} variant="ghost" className="w-full" onClick={() => void signIn.social({ provider: p, callbackURL: "/" })}>
              Continue with {PROVIDER_LABELS[p]}
            </Button>
          ))}
        </div>
      )}

      <button
        type="button"
        className="mt-6 text-sm text-paper-400 hover:text-paper-100"
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setError(null);
        }}
      >
        {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
      </button>
    </div>
  );
}
