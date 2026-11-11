"use client";
import { useEffect, useState } from "react";
import { getStoredToken, storeToken } from "./api";
import { parseFragmentToken } from "./format";

// Moves #k= into sessionStorage and strips it; never mutates server state
export function useTaskToken(taskId: string) {
  const [state, setState] = useState<{ ready: boolean; token: string | null }>({ ready: false, token: null });
  useEffect(() => {
    const frag = parseFragmentToken(window.location.hash);
    if (frag) {
      storeToken(taskId, frag);
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is client-only
    setState({ ready: true, token: frag ?? getStoredToken(taskId) });
  }, [taskId]);
  return state;
}
