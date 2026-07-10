import { KeyRound } from "lucide-react";
import { useState } from "react";
import { changePassword, login } from "../lib/api";
import { useI18n, type Messages } from "../lib/i18n";
import { PasscodePad } from "./PasscodePad";

interface ChangePasscodeProps {
  onClose: () => void;
  /** Presence-driven exit: the overlay fades out, then onExited unmounts it. */
  closing?: boolean;
  onExited?: () => void;
}

type Step = "current" | "next" | "confirm" | "done";

function stepCopy(m: Messages, step: Step): { title: string; subtitle: string } {
  const copy: Record<Step, { title: string; subtitle: string }> = {
    current: { title: m.passcode.currentTitle, subtitle: m.passcode.currentSub },
    next: { title: m.passcode.nextTitle, subtitle: m.passcode.nextSub },
    confirm: { title: m.passcode.confirmTitle, subtitle: m.passcode.confirmSub },
    done: { title: m.passcode.doneTitle, subtitle: m.passcode.doneSub }
  };
  return copy[step];
}

/**
 * Full-screen change-passcode flow (Settings → 安全), styled as the login pad:
 * verify the current passcode, enter the new one twice, brief success state.
 */
export function ChangePasscode({ onClose, closing, onExited }: ChangePasscodeProps) {
  const { m } = useI18n();
  const [step, setStep] = useState<Step>("current");
  const [currentPin, setCurrentPin] = useState("");
  const [nextPin, setNextPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [entryKey, setEntryKey] = useState(0);

  function advance(nextStep: Step) {
    setStep(nextStep);
    setEntryKey((key) => key + 1);
  }

  function failEntry(message: string, fallbackStep?: Step) {
    setError(true);
    setNotice(message);
    window.setTimeout(() => {
      if (fallbackStep) setStep(fallbackStep);
      setEntryKey((key) => key + 1);
    }, 420);
  }

  async function handleComplete(pin: string) {
    if (step === "current") {
      setBusy(true);
      try {
        // The login endpoint is the server-side truth for "is this the current
        // passcode"; a success just refreshes the existing session cookie.
        await login(pin);
        setCurrentPin(pin);
        advance("next");
      } catch {
        failEntry(m.passcode.wrong);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (step === "next") {
      setNextPin(pin);
      advance("confirm");
      return;
    }
    if (step === "confirm") {
      if (pin !== nextPin) {
        failEntry(m.passcode.mismatch, "next");
        return;
      }
      setBusy(true);
      try {
        await changePassword(currentPin, pin);
        setStep("done");
        window.setTimeout(onClose, 1200);
      } catch (err) {
        setBusy(false);
        failEntry(err instanceof Error && err.message ? err.message : m.passcode.couldNotUpdate, "current");
      }
    }
  }

  const copy = stepCopy(m, step);
  const subtitle = error && notice ? notice : copy.subtitle;

  return (
    <div
      className={`passcode-overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={m.passcode.dialogAria}
      onAnimationEnd={(event) => {
        if (closing && event.target === event.currentTarget) onExited?.();
      }}
    >
      <PasscodePad
        icon={<KeyRound size={26} aria-hidden="true" />}
        title={copy.title}
        subtitle={subtitle}
        error={error}
        busy={busy || step === "done"}
        entryKey={entryKey}
        onInput={() => {
          setError(false);
          setNotice(null);
        }}
        onComplete={handleComplete}
      />
      <button type="button" className="ghost-button passcode-cancel" onClick={onClose} disabled={step === "done"}>
        <span>{m.common.cancel}</span>
      </button>
    </div>
  );
}
