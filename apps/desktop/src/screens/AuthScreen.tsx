import { useState, type FormEvent } from "react";
import { useAppState } from "../state/AppState";
import { useIsPhone } from "../lib/phone";
import { useApiStatus } from "../components/ApiStatus";

export default function AuthScreen() {
  const { needsSetup, apiDown, login, register } = useAppState();
  const [agencyName, setAgencyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  // Bumped on every failed attempt so the phone field shakes again.
  const [shakeKey, setShakeKey] = useState(0);
  const isPhone = useIsPhone();
  const api = useApiStatus();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (needsSetup) await register(agencyName, email, password);
      else await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
      setShakeKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  };

  if (isPhone) {
    // Phone sign-in (mobile pass): a full-screen form, 48px fields with 16px
    // text, a Show button in the password field, one big Log in button, and a
    // plain banner instead of the developer hint when the API is down.
    return (
      <div className="mb-auth">
        <form className="mb-authform" onSubmit={submit} noValidate={false}>
          <div className="mb-authbrand">
            <span className="mb-authlogo" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z" />
              </svg>
            </span>
            <span>
              <b>Toreroflow</b>
              <small>by Torerone</small>
            </span>
          </div>

          <h1 className="mb-authh">{needsSetup ? "Set up your operator account" : "Welcome back"}</h1>
          <p className="mb-authsub">
            {needsSetup ? "First run: create the account that controls this Toreroflow." : "Log in to your command center."}
          </p>

          {apiDown && (
            <div className="mb-banner bad" role="alert">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-wifi-off" />
              </svg>
              <span className="mb-bt">
                <b>Can't reach Toreroflow.</b> Check your connection, then try again.
              </span>
              <button type="button" className="mb-btn sm" onClick={() => window.location.reload()}>
                Try again
              </button>
            </div>
          )}

          {needsSetup && (
            <div className="mb-field">
              <label htmlFor="auth-agency">Agency name</label>
              <input
                id="auth-agency"
                className="mb-input"
                placeholder="e.g. Torerone"
                value={agencyName}
                autoCapitalize="words"
                autoComplete="organization"
                onChange={(e) => setAgencyName(e.target.value)}
                required
              />
            </div>
          )}
          <div className="mb-field">
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              className="mb-input"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete={needsSetup ? "email" : "username"}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="mb-field">
            <label htmlFor="auth-password">Password</label>
            <div className={`mb-pass${error ? " shake" : ""}`} key={shakeKey}>
              <input
                id="auth-password"
                className={`mb-input${error ? " err" : ""}`}
                type={show ? "text" : "password"}
                autoComplete={needsSetup ? "new-password" : "current-password"}
                enterKeyHint="go"
                placeholder={needsSetup ? "8+ characters" : "your password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={needsSetup ? 8 : 1}
                required
              />
              <button
                type="button"
                className="mb-ib ghost"
                aria-label={show ? "Hide password" : "Show password"}
                aria-pressed={show}
                onClick={() => setShow((v) => !v)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#i-eye" />
                </svg>
              </button>
            </div>
            {error && (
              <div className="mb-err" role="alert">
                {error}
              </div>
            )}
          </div>

          <button className="mb-btn pri lg block" type="submit" disabled={busy || apiDown}>
            {busy ? "One moment" : needsSetup ? "Create account" : "Log in"}
          </button>
          {!needsSetup && (
            <div className="mb-banner mb-authinfo">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-info" />
              </svg>
              <span className="mb-bt">
                <b>First time on this server?</b> This screen becomes "Set up your operator account" with an Agency name field.
              </span>
            </div>
          )}
        </form>
        <div className="mb-authfoot" role="status">
          Toreroflow{api.version ? ` ${api.version}` : ""} · {api.checked ? api.label : "Checking the API"}
        </div>
      </div>
    );
  }

  return (
    <div className="authwrap">
      <form className="authcard glass" onSubmit={submit}>
        <div className="brand" style={{ padding: "0 0 14px" }}>
          <div className="logo">
            <svg viewBox="0 0 24 24">
              <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z" />
            </svg>
          </div>
          <div>
            <h1>
              <span>Toreroflow</span>
            </h1>
            <small>by Torerone</small>
          </div>
        </div>

        {apiDown ? (
          <>
            <h2>API offline</h2>
            <p className="sub2">
              The Toreroflow API isn't reachable. Start it with <code>pnpm dev:api</code> and
              relaunch the app.
            </p>
          </>
        ) : (
          <>
            <h2>{needsSetup ? "Set up your operator account" : "Welcome back"}</h2>
            <p className="sub2">
              {needsSetup
                ? "First run: create the account that controls this Toreroflow."
                : "Log in to your command center."}
            </p>

            {needsSetup && (
              <>
                <label className="flabel">Agency name</label>
                <input
                  className="field-in"
                  placeholder="e.g. Torerone"
                  value={agencyName}
                  onChange={(e) => setAgencyName(e.target.value)}
                  required
                />
              </>
            )}
            <label className="flabel">Email</label>
            <input
              className="field-in"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <label className="flabel">Password</label>
            <input
              className="field-in"
              type="password"
              placeholder={needsSetup ? "8+ characters" : "your password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={needsSetup ? 8 : 1}
              required
            />

            {error && <div className="autherr">{error}</div>}

            <button className="btn pri" type="submit" disabled={busy} style={{ marginTop: 18, width: "100%", justifyContent: "center" }}>
              {busy ? "One moment…" : needsSetup ? "Create account" : "Log in"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
