import { useEffect, useState } from 'react';

/** Tracks whether a CSS media query currently matches. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);

    update();
    list.addEventListener('change', update);

    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}
