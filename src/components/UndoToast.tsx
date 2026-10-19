import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { usePresence } from "../lib/usePresence";

export interface UndoNotice {
  id: number;
  message: string;
}

/** How long an undo stays on offer. Holding the bar — a finger on it, the
 * pointer over it, or focus inside it — stops the clock. */
export const UNDO_MS = 5000;

interface UndoToastProps {
  notice: UndoNotice | null;
  onUndo: () => void;
  onExpire: (id: number) => void;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/**
 * The bar that offers to take back the last "one tap moves it away" action
 * (a delete, a move to another day). It floats above the Dock; a newer
 * notice replaces the text in place rather than stacking a second bar. The
 * hairline along its bottom edge is the countdown.
 */
export function UndoToast({ notice, onUndo, onExpire }: UndoToastProps) {
  const { m } = useI18n();
  const presence = usePresence(notice !== null, 320);
  // The last notice stays on screen through the exit animation.
  const [shown, setShown] = useState(notice);
  if (notice && notice !== shown) setShown(notice);

  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || pressed || focused;

  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  const undoRef = useRef(onUndo);
  undoRef.current = onUndo;

  const id = notice?.id ?? null;
  // A bar that has gone hands nothing on: the next one starts unheld even
  // if the last was dismissed while a finger or the focus was on it.
  useEffect(() => {
    if (id !== null) return;
    setHovered(false);
    setPressed(false);
    setFocused(false);
  }, [id]);
  const remainingRef = useRef(UNDO_MS);
  // A new notice gets the full time. (Runs before the clock below, after
  // the old clock's cleanup has docked its elapsed time.)
  useEffect(() => {
    remainingRef.current = UNDO_MS;
  }, [id]);
  useEffect(() => {
    if (id === null || paused) return;
    const started = performance.now();
    const timer = window.setTimeout(() => expireRef.current(id), remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (performance.now() - started));
    };
  }, [id, paused]);

  // ⌘Z / Ctrl+Z takes the notice back, unless a text field owns the key.
  useEffect(() => {
    if (id === null) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "z" || event.shiftKey || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      if (isEditable(event.target)) return;
      event.preventDefault();
      undoRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [id]);

  if (!presence.mounted || !shown) return null;

  return (
    <div
      className={`undo-toast${presence.closing ? " is-leaving" : ""}`}
      role="status"
      aria-live="polite"
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) presence.onExited();
      }}
    >
      <span key={shown.id} className="undo-toast__message">
        {shown.message}
      </span>
      <button type="button" className="undo-toast__action" onClick={onUndo} disabled={presence.closing}>
        {m.undo.action}
      </button>
      <span
        key={`timer-${shown.id}`}
        className="undo-toast__timer"
        aria-hidden="true"
        style={{ animationDuration: `${UNDO_MS}ms`, animationPlayState: paused || presence.closing ? "paused" : "running" }}
      />
    </div>
  );
}
