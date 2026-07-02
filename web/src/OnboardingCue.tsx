import { useState } from "react";

// First-run cue: the app's headline interaction (hover/tap a building) is easy
// to miss. Show a one-time card, dismissed to localStorage. No storage layer
// exists elsewhere, so every access is guarded (private-mode / SSR safe).
const KEY = "nn-onboard-dismissed";

function readDismissed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export default function OnboardingCue() {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed) return null;

  const close = () => {
    try {
      window.localStorage.setItem(KEY, "1");
    } catch {
      /* private mode — dismiss for this session only */
    }
    setDismissed(true);
  };

  return (
    <div className="nn-onboard" role="note">
      <div className="nn-onboard-body">
        This map estimates roughly what it&rsquo;d cost to connect any Pittsburgh building to a
        modeled network corridor. <b>Hover or tap any building</b> to see its screening estimate —{" "}
        <span className="nn-onboard-note">a modeled screen, not a real quote.</span>
      </div>
      <button type="button" onClick={close}>
        Got it
      </button>
    </div>
  );
}
