import { useState, type FormEvent } from "react";
import { useAppState } from "../state/AppState";

export default function AuthScreen() {
  const { needsSetup, apiDown, login, register } = useAppState();
  const [agencyName, setAgencyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (needsSetup) await register(agencyName, email, password);
      else await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  };

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

            <button className="btn" type="submit" disabled={busy} style={{ marginTop: 18, width: "100%", justifyContent: "center" }}>
              {busy ? "One moment…" : needsSetup ? "Create account" : "Log in"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
