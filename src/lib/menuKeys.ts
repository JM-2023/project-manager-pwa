import type { KeyboardEvent } from "react";

/**
 * Arrow/Home/End focus movement across a role="menu" popover's menuitems,
 * wrapping at the ends — the keyboard contract that role promises. Returns
 * true when it handled the key.
 */
export function handleMenuKeyDown(event: KeyboardEvent<HTMLElement>): boolean {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
  if (items.length === 0) return false;
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  switch (event.key) {
    case "ArrowDown":
      next = current < 0 ? 0 : (current + 1) % items.length;
      break;
    case "ArrowUp":
      next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = items.length - 1;
      break;
    default:
      return false;
  }
  event.preventDefault();
  items[next].focus({ preventScroll: true });
  return true;
}
