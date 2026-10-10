'use client';

import { useEffect, useRef, useState } from 'react';

import { takeFragmentToken } from './fragment-token';

export type FragmentTokenState = { status: 'reading' } | { status: 'ready'; token: string | null };

const NOT_TAKEN = Symbol('not-taken');

/**
 * Takes the `#token=` from the address bar once, after hydration (the server never sees a
 * fragment), and removes it from the URL right away.
 *
 * The ref keeps the token across React Strict Mode's double effect run: the second run would
 * otherwise find the fragment already gone.
 */
export function useFragmentToken(): FragmentTokenState {
  const taken = useRef<string | null | typeof NOT_TAKEN>(NOT_TAKEN);
  const [state, setState] = useState<FragmentTokenState>({ status: 'reading' });

  useEffect(() => {
    if (taken.current === NOT_TAKEN) {
      taken.current = takeFragmentToken(window.location, window.history);
    }
    const token = taken.current;
    // Syncing from an external system (the URL fragment) that only exists in the browser.
    setState({ status: 'ready', token });
  }, []);

  return state;
}
