import { LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";
import { PasscodePad } from "../components/PasscodePad";
import { getAuthStatus } from "../lib/api";
import { useI18n, type Messages } from "../lib/i18n";

interface LoginPageProps {
  onLogin: (password: string) => Promise<void>;
  onSetup: (password: string, setupToken: string) => Promise<void>;
}

type Phase = "login" | "setup-enter" | "setup-confirm";

function phaseCopy(m: Messages, phase: Phase): { title: string; subtitle: string } {
  const copy: Record<Phase, { title: string; subtitle: string }> = {
    login: { title: m.login.welcome, subtitle: m.login.enterPasscode },
    "setup-enter": { title: m.login.setTitle, subtitle: m.login.choosePasscode },
    "setup-confirm": { title: m.login.confirmTitle, subtitle: m.login.reenterSame }
  };
  return copy[phase];
}

export function LoginPage({ onLogin, onSetup }: LoginPageProps) {
  const { m } = useI18n();
  const [phase, setPhase] = useState<Phase>("login");
  const [firstPin, setFirstPin] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [setupTokenRequired, setSetupTokenRequired] = useState(false);
  const [setupAvailable, setSetupAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [entryKey, setEntryKey] = useState(0);

  // A fresh deployment (no passcode configured yet) gets the first-run setup
  // flow instead of the login pad. Existing installs resolve to `login`.
  useEffect(() => {
    let cancelled = false;
    getAuthStatus()
      .then((status) => {
        if (!cancelled && status.needsSetup) {
          setSetupTokenRequired(status.setupTokenRequired !== false);
          setSetupAvailable(status.setupAvailable !== false);
          if (status.setupAvailable === false) {
            setNotice(m.login.setupUnavailable);
            setError(true);
          }
          setPhase("setup-enter");
        }
      })
      .catch(() => {
        // Offline or older backend — the classic login pad still works.
      });
    return () => {
      cancelled = true;
    };
  }, [m.login.setupUnavailable]);

  function failEntry(message: string | null, nextPhase?: Phase) {
    setError(true);
    setNotice(message);
    window.setTimeout(() => {
      if (nextPhase) setPhase(nextPhase);
      setEntryKey((key) => key + 1);
    }, 420);
  }

  async function handleComplete(pin: string) {
    if (phase === "setup-enter") {
      if (setupTokenRequired && !setupToken.trim()) {
        failEntry(m.login.setupTokenHint, "setup-enter");
        return;
      }
      setFirstPin(pin);
      setPhase("setup-confirm");
      setEntryKey((key) => key + 1);
      return;
    }
    if (phase === "setup-confirm") {
      if (pin !== firstPin) {
        failEntry(m.login.mismatch, "setup-enter");
        return;
      }
      setBusy(true);
      try {
        await onSetup(pin, setupToken.trim());
      } catch (err) {
        setBusy(false);
        failEntry(err instanceof Error && err.message ? err.message : m.login.couldNotSave, "setup-enter");
      }
      return;
    }
    setBusy(true);
    try {
      await onLogin(pin);
    } catch {
      setBusy(false);
      failEntry(null);
    }
  }

  const copy = phaseCopy(m, phase);
  const subtitle = error ? (notice ?? m.login.wrongPasscode) : copy.subtitle;

  return (
    <main className="login-screen" aria-label={m.login.keypadAria}>
      <PasscodePad
        icon={<LockKeyhole size={26} aria-hidden="true" />}
        title={copy.title}
        subtitle={subtitle}
        error={error}
        busy={busy || (phase !== "login" && !setupAvailable)}
        entryKey={entryKey}
        onInput={() => {
          setError(false);
          setNotice(null);
        }}
        onComplete={handleComplete}
        autofillEmail={phase === "login" ? "owner@project-manager.local" : undefined}
        extra={
          phase !== "login" && setupTokenRequired ? (
            <label className="pin-setup-token">
              <span>{m.login.setupToken}</span>
              <input
                type="password"
                autoComplete="one-time-code"
                value={setupToken}
                onChange={(event) => {
                  setSetupToken(event.target.value);
                  setError(false);
                  setNotice(null);
                }}
                disabled={busy || !setupAvailable}
              />
            </label>
          ) : undefined
        }
      />
    </main>
  );
}
