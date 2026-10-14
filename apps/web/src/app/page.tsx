"use client";

import { useEffect, useState } from "react";

type AuthenticatedUser = { name?: string; phoneNumber?: string };

function normalizePhone(value: string): string | null {
  const input = value.trim().replace(/[\s()-]/g, "");
  const e164 = input.startsWith("+")
    ? input
    : input.startsWith("0")
      ? `+234${input.slice(1)}`
      : input.startsWith("234")
        ? `+${input}`
        : "";
  return /^\+234[789]\d{9}$/.test(e164) ? e164 : null;
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export default function Home() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code" | "signed-in">("phone");
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/get-session", { credentials: "same-origin" })
      .then(readResponse)
      .then((data) => {
        if (!active) return;
        const session = data.session as { user?: AuthenticatedUser } | null | undefined;
        if (session?.user) {
          setUser(session.user);
          setStep("signed-in");
        }
      })
      .catch(() => {
        if (active) setMessage("Sign-in is temporarily unavailable. Please try again.");
      });
    return () => {
      active = false;
    };
  }, []);

  async function requestCode(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setMessage("Enter a valid Nigerian mobile number, such as 0803 123 4567.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/phone-number/send-otp", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phoneNumber: normalized }),
      });
      await readResponse(response);
      if (!response.ok) throw new Error("delivery");
      setPhone(normalized);
      setStep("code");
      setMessage("If this number can receive a code, one will arrive shortly.");
    } catch {
      setMessage("We couldn’t send a code right now. Check the number and try again later.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setMessage("Enter the six-digit code.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/phone-number/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone, code }),
      });
      const data = await readResponse(response);
      if (!response.ok || data.status !== true) throw new Error("verification");
      setUser((data.user as AuthenticatedUser | undefined) ?? { phoneNumber: phone });
      setStep("signed-in");
      setCode("");
      setMessage("Your phone is verified and you’re signed in.");
    } catch {
      setMessage("That code couldn’t be verified. Check it or request a new code.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("sign-out");
      setUser(null);
      setPhone("");
      setStep("phone");
      setMessage("You’re signed out.");
    } catch {
      setMessage("We couldn’t sign you out. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Mizvo home">
          <span className="brand-mark" aria-hidden="true">
            m
          </span>
          <span>Mizvo</span>
        </a>
        <span className="header-note">Business clarity. Financial growth.</span>
      </header>

      <section className="auth-layout" aria-labelledby="auth-title">
        <div className="welcome-panel">
          <p className="eyebrow">A clearer view of your business</p>
          <h1 id="auth-title">Make room to grow.</h1>
          <p className="welcome-copy">
            Keep your business information in one place and make your next decision with more
            clarity.
          </p>
          <div className="welcome-note">
            <span className="note-icon" aria-hidden="true">
              ✳
            </span>
            <p>Start with a verified phone number. Your business workspace comes later.</p>
          </div>
          <div className="decorative-shape" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>

        <section className="form-panel" aria-label="Phone sign-in">
          {step === "signed-in" ? (
            <div className="form-content">
              <p className="eyebrow">You’re signed in</p>
              <h2>Welcome to Mizvo.</h2>
              <p className="form-intro">
                {user?.phoneNumber ?? phone} is verified. Business setup will be available in a
                later release.
              </p>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={signOut}
                type="button"
              >
                {busy ? "Signing out…" : "Sign out"}
              </button>
            </div>
          ) : step === "code" ? (
            <div className="form-content">
              <p className="eyebrow">Phone verification</p>
              <h2>Enter your code.</h2>
              <p className="form-intro">
                We sent a six-digit code to <strong>{phone}</strong>. It expires in five minutes.
              </p>
              <form onSubmit={verifyCode}>
                <label htmlFor="verification-code">Six-digit code</label>
                <input
                  autoComplete="one-time-code"
                  className="code-input"
                  id="verification-code"
                  inputMode="numeric"
                  maxLength={6}
                  name="code"
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  pattern="[0-9]{6}"
                  required
                  value={code}
                />
                <button className="button" disabled={busy} type="submit">
                  {busy ? "Checking code…" : "Verify and continue"}
                </button>
              </form>
              <div className="form-actions">
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void requestCode()}
                  type="button"
                >
                  Send a new code
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setStep("phone");
                    setMessage("");
                  }}
                  type="button"
                >
                  Change number
                </button>
              </div>
            </div>
          ) : (
            <div className="form-content">
              <p className="eyebrow">Your account</p>
              <h2>Continue with your phone.</h2>
              <p className="form-intro">
                Existing accounts will sign in. Verifying a new number creates your Mizvo account.
              </p>
              <form onSubmit={requestCode}>
                <label htmlFor="phone-number">Nigerian mobile number</label>
                <input
                  autoComplete="tel"
                  id="phone-number"
                  inputMode="tel"
                  name="phone"
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="0803 123 4567"
                  required
                  type="tel"
                  value={phone}
                />
                <p className="field-hint">
                  We’ll send a one-time code by SMS. Email is optional and unavailable until email
                  delivery is configured.
                </p>
                <button className="button" disabled={busy} type="submit">
                  {busy ? "Sending code…" : "Send verification code"}
                </button>
              </form>
            </div>
          )}
          <output aria-live="polite" className="status-message">
            {message}
          </output>
          <div className="form-footer">
            <span className="lock-icon" aria-hidden="true">
              ▣
            </span>
            Your phone is verified before an account is created or accessed.
          </div>
        </section>
      </section>

      <footer className="site-footer">
        <span>© {new Date().getFullYear()} Mizvo</span>
        <span>Secure phone sign-in</span>
      </footer>
    </main>
  );
}
