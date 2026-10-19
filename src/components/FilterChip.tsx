import { Check, ChevronDown } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DROP_MOTION, dropFromTrigger, useFloatingPopover } from "../lib/floatingPopover";
import { handleMenuKeyDown } from "../lib/menuKeys";

export interface ChipOption {
  id: string;
  label: string;
}

interface FilterChipProps {
  /** What the chip reads: the filter's name while it is off, its value once on. */
  label: string;
  /** The filter narrows the results: the chip is drawn solid. */
  active: boolean;
  /** The filter's name, for the menu and assistive tech. */
  name: string;
  options: ChipOption[];
  value: string;
  onChange: (id: string) => void;
}

/** One Search filter as a chip that opens the app's own menu (a native
 * select is a system wheel on iPhone). */
export function FilterChip({ label, active, name, options, value, onChange }: FilterChipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const menu = useFloatingPopover({ open, close, triggerRef, popoverRef, place: dropFromTrigger, motion: DROP_MOTION });
  const current = options.find((option) => option.id === value)?.label ?? label;

  function choose(id: string) {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    if (id !== value) onChange(id);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`filter-chip${active ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name}: ${current}`}
        onClick={() => setOpen((next) => !next)}
      >
        <span>{label}</span>
        <ChevronDown size={14} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {menu.mounted
        ? createPortal(
            <div
              ref={popoverRef}
              className={`task-action-menu task-action-menu--floating task-project-menu${menu.closing ? " is-closing" : ""}`}
              role="menu"
              aria-label={name}
              onKeyDown={handleMenuKeyDown}
            >
              {options.map((option) => {
                const checked = option.id === value;
                return (
                  <button key={option.id} type="button" role="menuitemradio" aria-checked={checked} onClick={() => choose(option.id)}>
                    <span>{option.label}</span>
                    {checked ? <Check size={15} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
