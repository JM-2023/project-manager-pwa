import { Check, CircleAlert, CloudOff, RefreshCcw, UploadCloud } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { EASE, EASE_OUT, morphTo, usePresenceMorph, type PresenceMotion } from "../lib/morph";
import { usePresence } from "../lib/usePresence";
import type { SyncStatus } from "../state/appStore";

interface OfflineBannerProps {
  online: boolean;
  pendingCount: number;
  syncStatus: SyncStatus;
  error: string | null;
  /** Another notice has the slot above the Dock (the undo bar wins it). */
  held: boolean;
  onSync: () => void;
  onOpenSettings: () => void;
}

interface BannerView {
  state: string;
  message: string;
  /** Raw error text: often an English exception message, so it stays out of
   * the localized pill and only rides along as a tooltip. Settings shows it. */
  detail: string | undefined;
  Icon: typeof CloudOff;
  showSync: boolean;
  syncing: boolean;
  /** Offline or failing: a tap on the pill opens the sync details. */
  opensSettings: boolean;
}

// A healthy edit queues, pushes and settles in about a second. Announcing
// that on every commit made the pill blink in and out (with three different
// labels) after each edit, so routine traffic only surfaces once it has run
// this long. Offline and errors still show at once.
const SLOW_SYNC_MS = 2000;
/** How long a pill that was showing says "Synced" before it goes. */
const SYNCED_MS = 900;

const PILL_MOTION: PresenceMotion = {
  hidden: { opacity: "0", scale: "0.98", translate: "0px 10px" },
  gone: { opacity: "0", scale: "0.98", translate: "0px 8px" },
  enterMs: 220,
  exitMs: 180
};

/** True once `active` has held continuously for `ms`; false as soon as it drops. */
function useSustained(active: boolean, ms: number): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    setSustained(false);
    if (!active) return;
    const timer = window.setTimeout(() => setSustained(true), ms);
    return () => window.clearTimeout(timer);
  }, [active, ms]);
  return active && sustained;
}

interface Glyph {
  id: number;
  Icon: typeof CloudOff;
  spin: boolean;
}

/** The pill's icon: a new state's icon fades in over the last one as that
 * one fades out, rather than swapping in a single frame. */
function GlyphSwap({ Icon, spin }: { Icon: typeof CloudOff; spin: boolean }) {
  const [glyphs, setGlyphs] = useState<Glyph[]>([{ id: 0, Icon, spin }]);
  const top = glyphs[glyphs.length - 1];
  // At most the outgoing icon and the incoming one.
  if (top.Icon !== Icon || top.spin !== spin) setGlyphs([top, { id: top.id + 1, Icon, spin }]);
  const refs = useRef(new Map<number, HTMLSpanElement>());

  useLayoutEffect(() => {
    if (glyphs.length < 2) return;
    const [out, next] = glyphs;
    const outEl = refs.current.get(out.id);
    const nextEl = refs.current.get(next.id);
    if (nextEl) morphTo(nextEl, { opacity: "1", scale: "1" }, { from: { opacity: "0", scale: "0.7" }, duration: 160, easing: EASE_OUT });
    if (!outEl) return;
    const fade = morphTo(outEl, { opacity: "0", scale: "0.7" }, { duration: 160, easing: EASE, hold: true });
    fade.finished.then(
      () => setGlyphs((current) => current.filter((glyph) => glyph.id !== out.id)),
      () => undefined
    );
  }, [glyphs]);

  return (
    <span className="offline-banner__icon">
      {glyphs.map(({ id, Icon: Glyph, spin: spinning }) => (
        <span
          key={id}
          ref={(el) => {
            if (el) refs.current.set(id, el);
            else refs.current.delete(id);
          }}
          className={`offline-banner__glyph${spinning ? " is-spinning" : ""}`}
        >
          <Glyph size={16} aria-hidden="true" />
        </span>
      ))}
    </span>
  );
}

/**
 * The sync pill. It floats above the Dock in the undo bar's slot and
 * material, and steps aside while an undo is on offer. Routine syncing
 * stays quiet; a pill that did show (a slow sync, offline, an error) says
 * "Synced" for a moment before it goes, so a sync it announced visibly
 * ends. Its width eases from one label to the next.
 */
export function OfflineBanner({ online, pendingCount, syncStatus, error, held, onSync, onOpenSettings }: OfflineBannerProps) {
  const { m } = useI18n();
  const urgent = Boolean(error) || !online || syncStatus === "error";
  const working = pendingCount > 0 || syncStatus === "syncing" || syncStatus === "queued";
  const slow = useSustained(pendingCount > 0 || syncStatus === "syncing", SLOW_SYNC_MS);
  const live = (urgent || slow) && !held;
  const settled = online && !error && syncStatus !== "error" && !working;

  // A pill that showed stays with its work until that work is through (back
  // online, it goes on to say "Syncing", not vanish with the changes still
  // queued), then says "Synced" for a moment and goes. A pill that stepped
  // aside for the undo bar, or never showed, says nothing.
  const [armed, setArmed] = useState(false);
  const [ending, setEnding] = useState(false);
  if (live && !armed) setArmed(true);
  if (armed && held) setArmed(false);
  if (armed && settled && !held) {
    setArmed(false);
    setEnding(true);
  }
  if (ending && (held || live)) setEnding(false);
  useEffect(() => {
    if (!ending) return;
    const timer = window.setTimeout(() => setEnding(false), SYNCED_MS);
    return () => window.clearTimeout(timer);
  }, [ending]);
  const following = armed && !live && !held && !settled;

  const visible = live || following || ending;
  const presence = usePresence(visible, 400);
  // Freeze the last visible content for the exit animation — by the time the
  // pill leaves, the live props have already gone back to "all synced".
  const lastViewRef = useRef<BannerView | null>(null);

  if (live || following) {
    const state = error ? "error" : online ? syncStatus : "offline";
    const message = error
      ? m.offline.syncIssue
      : !online
      ? pendingCount > 0
        ? m.offline.savedOffline(pendingCount)
        : m.offline.offline
      : syncStatus === "error"
        ? m.offline.syncIssue
        : syncStatus === "syncing"
          ? m.offline.syncing(pendingCount)
          : syncStatus === "queued"
            ? m.offline.queued(pendingCount)
            : m.offline.pending(pendingCount);
    const Icon = error
      ? CircleAlert
      : !online
      ? CloudOff
      : syncStatus === "error"
        ? CircleAlert
        : syncStatus === "syncing"
          ? RefreshCcw
          : UploadCloud;
    lastViewRef.current = {
      state,
      message,
      detail: error ?? undefined,
      Icon,
      showSync: online,
      syncing: syncStatus === "syncing",
      opensSettings: urgent
    };
  } else if (ending) {
    lastViewRef.current = {
      state: "synced",
      message: m.offline.synced,
      detail: undefined,
      Icon: Check,
      showSync: false,
      syncing: false,
      opensSettings: false
    };
  }

  const pillRef = useRef<HTMLDivElement | null>(null);
  usePresenceMorph(pillRef, presence, PILL_MOTION);

  // The label's box eases from the last label's width to this one's, and
  // the new words fade in inside it. Turned around mid-ease, it continues
  // from the width it has reached.
  const view = lastViewRef.current;
  const message = view?.message ?? "";
  const textRef = useRef<HTMLSpanElement | null>(null);
  const textWidthRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) {
      textWidthRef.current = null;
      return;
    }
    // Mid-ease the box is where the running tween has it; at rest, where the
    // last label left it (the new label is already in it by now).
    const animations = el.getAnimations();
    const drawn = animations.length > 0 ? el.getBoundingClientRect().width : textWidthRef.current;
    for (const animation of animations) animation.cancel();
    const natural = el.getBoundingClientRect().width;
    textWidthRef.current = natural;
    if (drawn === null || Math.abs(natural - drawn) < 1) return;
    morphTo(el, { width: `${natural}px` }, { from: { width: `${drawn}px` }, duration: 220, easing: EASE_OUT });
  }, [message, presence.mounted]);

  if (!presence.mounted || !view) {
    return null;
  }

  const { state, detail, Icon, showSync, syncing, opensSettings } = view;
  return (
    <div ref={pillRef} className={`offline-banner ${state}${presence.closing ? " is-leaving" : ""}`} role="status" aria-live="polite">
      <GlyphSwap Icon={Icon} spin={syncing} />
      <span ref={textRef} className="offline-banner__text" title={detail}>
        <span key={message} className="offline-banner__label">
          {message}
        </span>
      </span>
      {/* Offline or failing, the whole pill is a way to the details (a
          phone has no hover for the tooltip). Laid over the pill, so the
          icon and label keep their place as the state comes and goes. */}
      {opensSettings ? (
        <button type="button" className="offline-banner__open" onClick={onOpenSettings} aria-label={m.offline.openSettings} />
      ) : null}
      {showSync ? (
        <button type="button" className="offline-banner__sync" onClick={onSync} disabled={syncing || presence.closing} aria-label={m.offline.syncNow}>
          <RefreshCcw size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
