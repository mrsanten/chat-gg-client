import { useEffect, useState } from "react";

/**
 * Zwraca true gdy viewport <= 768px szerokości. Re-renderuje gdy się zmieni
 * (rotacja telefonu, resize okna). Próg pasuje do CSS media query
 * `@media (max-width: 768px)`, więc JS + CSS się zgadzają.
 */
const BREAKPOINT = "(max-width: 768px)";

export function useMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(BREAKPOINT).matches;
  });

  useEffect(() => {
    const mq = window.matchMedia(BREAKPOINT);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
