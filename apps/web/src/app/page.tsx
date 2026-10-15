"use client";

import { useCallback, useEffect, useState } from "react";

type AuthenticatedUser = { name?: string; phoneNumber?: string };
type Business = { id: string; name: string; role: string };
type PasskeyRecord = { id: string; name: string | null; createdAt: string | null };

const localPasskeyBuildEnabled =
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_MIZVO_PASSKEY_ENROLLMENT === "development";

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
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [activeBusinessId, setActiveBusinessId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([]);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [showLocalPasskeys, setShowLocalPasskeys] = useState(false);

  const loadPasskeys = useCallback(async () => {
    try {
      const response = await fetch("/api/security/passkeys", { credentials: "same-origin" });
      const data = await readResponse(response);
      if (!response.ok) throw new Error("passkey-list");
      setPasskeys((data.passkeys as PasskeyRecord[] | undefined) ?? []);
    } catch {
      setPasskeys([]);
      setMessage("Passkey status is temporarily unavailable.");
    }
  }, []);

  useEffect(() => {
    setShowLocalPasskeys(
      localPasskeyBuildEnabled && window.location.origin === "http://localhost:3000",
    );
  }, []);

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
          void fetch("/api/businesses", { credentials: "same-origin" })
            .then((response) => {
              if (!response.ok) throw new Error("business-list");
              return readResponse(response);
            })
            .then((businessData) => {
              if (!active) return;
              setBusinesses((businessData.businesses as Business[] | undefined) ?? []);
              setActiveBusinessId(
                (businessData.activeBusinessId as string | null | undefined) ?? null,
              );
            })
            .catch(() => {
              if (active) setMessage("We couldn’t load your businesses. Please try again.");
            });
        }
      })
      .catch(() => {
        if (active) setMessage("Sign-in is temporarily unavailable. Please try again.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (showLocalPasskeys && step === "signed-in") void loadPasskeys();
  }, [showLocalPasskeys, step, loadPasskeys]);

  async function loadBusinesses() {
    try {
      const response = await fetch("/api/businesses", { credentials: "same-origin" });
      const data = await readResponse(response);
      if (!response.ok) throw new Error("business-list");
      setBusinesses((data.businesses as Business[] | undefined) ?? []);
      setActiveBusinessId((data.activeBusinessId as string | null | undefined) ?? null);
    } catch {
      setMessage("We couldn’t load your businesses. Please try again.");
    }
  }

  async function enrollLocalPasskey() {
    if (!showLocalPasskeys || passkeyBusy) return;
    setPasskeyBusy(true);
    setMessage("");
    try {
      const [{ createAuthClient }, { passkeyClient }] = await Promise.all([
        import("better-auth/react"),
        import("@better-auth/passkey/client"),
      ]);
      const client = createAuthClient({
        baseURL: window.location.origin,
        plugins: [passkeyClient()],
      });
      const { error } = await client.passkey.addPasskey({ name: "Mizvo local test passkey" });
      if (error) throw new Error("passkey-enrollment");
      await loadPasskeys();
      setMessage("Development passkey enrolled for this verified account.");
    } catch {
      setMessage("Passkey setup was cancelled or is unavailable in this browser.");
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function createBusiness(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = businessName.trim();
    if (!name || name.length > 120) {
      setMessage("Enter a business name up to 120 characters.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/businesses", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error("business-create");
      setBusinessName("");
      await loadBusinesses();
      setMessage("Your business workspace is ready.");
    } catch {
      setMessage("We couldn’t create that business. Check the name and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function switchBusiness(organizationId: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/businesses/active", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      if (!response.ok) throw new Error("business-switch");
      setActiveBusinessId(organizationId);
      setMessage("Business switched.");
    } catch {
      await loadBusinesses();
      setMessage("We couldn’t switch businesses. Your access may have changed.");
    } finally {
      setBusy(false);
    }
  }

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
      await loadBusinesses();
      if (showLocalPasskeys) await loadPasskeys();
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
      setBusinesses([]);
      setActiveBusinessId(null);
      setBusinessName("");
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
                {user?.phoneNumber ?? phone} is verified. Your businesses are kept under this
                account.
              </p>
              <section className="business-list" aria-labelledby="business-list-title">
                <h3 id="business-list-title">Your businesses</h3>
                {businesses.length === 0 ? (
                  <p className="field-hint">Create a business workspace to get started.</p>
                ) : (
                  <label className="business-picker" htmlFor="active-business">
                    <span>Active business</span>
                    <select
                      disabled={busy}
                      id="active-business"
                      onChange={(event) => void switchBusiness(event.target.value)}
                      value={activeBusinessId ?? ""}
                    >
                      <option disabled value="">
                        Choose a business
                      </option>
                      {businesses.map((business) => (
                        <option key={business.id} value={business.id}>
                          {business.name} · {business.role}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </section>
              <form onSubmit={createBusiness}>
                <label htmlFor="business-name">Create a business</label>
                <input
                  autoComplete="organization"
                  id="business-name"
                  maxLength={120}
                  onChange={(event) => setBusinessName(event.target.value)}
                  placeholder="Business name"
                  required
                  value={businessName}
                />
                <button className="button" disabled={busy} type="submit">
                  {busy ? "Saving…" : "Create business"}
                </button>
              </form>
              <section className="business-list" aria-labelledby="staff-invitations-title">
                <h3 id="staff-invitations-title">Invite staff</h3>
                <p className="field-hint">
                  Staff invitations will be available after independent recovery and recent sign-in
                  security are set up.
                </p>
              </section>
              {showLocalPasskeys ? (
                <section className="business-list" aria-labelledby="development-passkeys-title">
                  <h3 id="development-passkeys-title">Local development passkeys</h3>
                  <p className="field-hint">
                    Test-only enrollment for this verified account. These credentials cannot sign in
                    or authorize owner actions.
                  </p>
                  {passkeys.length > 0 ? (
                    <ul>
                      {passkeys.map((item) => (
                        <li key={item.id}>
                          {item.name ?? "Unnamed passkey"}
                          {item.createdAt
                            ? ` · ${new Date(item.createdAt).toLocaleDateString()}`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="field-hint">No local passkeys enrolled.</p>
                  )}
                  <button
                    className="button button-secondary"
                    disabled={busy || passkeyBusy}
                    onClick={() => void enrollLocalPasskey()}
                    type="button"
                  >
                    {passkeyBusy ? "Waiting for authenticator…" : "Add a local test passkey"}
                  </button>
                </section>
              ) : null}
              <p className="field-hint">
                You’ll be the owner. Other membership changes will be available after additional
                security setup.
              </p>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={signOut}
                type="button"
              >
                {busy ? "Please wait…" : "Sign out"}
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
