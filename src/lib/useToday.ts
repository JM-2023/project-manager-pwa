import { useEffect, useState } from "react";
import { todayDate } from "./dates";

/**
 * Reactive "today" — re-checks the local date once a minute and whenever the
 * app regains focus/visibility, so a page left open across midnight (or
 * resumed from the iOS app switcher the next morning) moves to the new day.
 */
export function useToday(): string {
  const [today, setToday] = useState(todayDate);

  useEffect(() => {
    function refresh() {
      setToday((current) => {
        const next = todayDate();
        return next === current ? current : next;
      });
    }

    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return today;
}
