import { useSyncExternalStore } from "react";

/* Typing on a touch keyboard. While one is up it covers half the view, and
   the Dock and the notices above it (the undo bar, the sync pill) are no use
   there, so they step aside until the field lets go. The flag is set on the
   root as data-typing (the Dock's CSS reads it) and read by the notices
   through useTyping(). A pointer-and-keyboard device never sets it. */

const NOT_TEXT = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "file", "color", "image", "hidden"]);

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "TEXTAREA") return true;
  return target instanceof HTMLInputElement && !NOT_TEXT.has(target.type);
}

function touchKeyboard(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

let typing = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (next === typing) return;
  typing = next;
  if (next) document.documentElement.dataset.typing = "";
  else delete document.documentElement.dataset.typing;
  for (const listener of listeners) listener();
}

let installed = false;
function install() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  // Moving from one field to the next carries the focus across in one
  // step (relatedTarget), so the Dock doesn't flicker back in between.
  document.addEventListener("focusin", (event) => set(touchKeyboard() && isTextEntry(event.target)));
  document.addEventListener("focusout", (event) => set(touchKeyboard() && isTextEntry(event.relatedTarget)));
  set(touchKeyboard() && isTextEntry(document.activeElement));
}

function subscribe(listener: () => void) {
  install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a text field has the focus on a touch device (its keyboard is up). */
export function useTyping(): boolean {
  return useSyncExternalStore(subscribe, () => typing, () => false);
}
