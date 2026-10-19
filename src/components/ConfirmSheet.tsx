import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";

export interface ConfirmRequest {
  /** The consequence, as a question. */
  title: string;
  /** What exactly it touches. */
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** The action discards or overwrites something: it is drawn as the
   * warning, and the safe answer holds the focus. */
  danger?: boolean;
}

type Pending = ConfirmRequest & { resolve: (confirmed: boolean) => void };

let present: ((request: Pending) => void) | null = null;

/**
 * Ask in the app's own sheet instead of `window.confirm` (which shows the
 * page's address as its title, stays English in the Chinese UI, and can't
 * say which answer is the safe one). Resolves false when dismissed — Cancel,
 * Escape, or a tap outside — and at once when no ConfirmHost is mounted.
 */
export function requestConfirm(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    if (!present) {
      resolve(false);
      return;
    }
    present({ ...request, resolve });
  });
}

/** Mount once. Shows one request at a time; a new one answers the old with false. */
export function ConfirmHost() {
  const { m } = useI18n();
  const [request, setRequest] = useState<Pending | null>(null);
  const [closing, setClosing] = useState(false);
  const pendingRef = useRef<Pending | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    present = (next) => {
      pendingRef.current?.resolve(false);
      pendingRef.current = next;
      setRequest(next);
      setClosing(false);
    };
    return () => {
      present = null;
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!request || !dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Native modality: the page behind goes inert, Escape cancels, and the
    // opener gets its focus back on close.
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("[data-safe]")?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [request]);

  // The exit's animationend unmounts the sheet; this covers an animation
  // that never reports (a hidden tab).
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setRequest(null), 360);
    return () => window.clearTimeout(timer);
  }, [closing]);

  // The answer goes out on the tap; the sheet leaves after it.
  function answer(confirmed: boolean) {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    pending.resolve(confirmed);
    setClosing(true);
  }

  if (!request) return null;

  const action = (
    <button
      type="button"
      className={request.danger ? "ghost-button danger" : "primary-button"}
      onClick={() => answer(true)}
      {...(request.danger ? {} : { "data-safe": true })}
    >
      <span>{request.confirmLabel}</span>
    </button>
  );
  const cancel = (
    <button type="button" className="secondary-button" onClick={() => answer(false)} {...(request.danger ? { "data-safe": true } : {})}>
      <span>{request.cancelLabel ?? m.common.cancel}</span>
    </button>
  );

  return (
    <dialog
      ref={dialogRef}
      className={`confirm-sheet${closing ? " is-closing" : ""}`}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onCancel={(event) => {
        event.preventDefault();
        answer(false);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) answer(false);
      }}
    >
      <div
        className="confirm-sheet__panel"
        onAnimationEnd={(event) => {
          if (closing && event.target === event.currentTarget) setRequest(null);
        }}
      >
        <h2 id={titleId}>{request.title}</h2>
        <p id={messageId}>{request.message}</p>
        <div className="confirm-sheet__actions">
          {action}
          {cancel}
        </div>
      </div>
    </dialog>
  );
}
