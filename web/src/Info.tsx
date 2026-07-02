import { useEffect, useId, useRef, useState, type ReactNode } from "react";

// Plain-English glossary for the jargon "?" chips. One place for the copy so a
// term is defined once and reused wherever it appears in the panel.
const GLOSSARY: Record<string, ReactNode> = {
  corridor:
    "The modeled fiber route this screen measures distance to — built from major-arterial road right-of-way. A model, not real fiber.",
  "right-of-way":
    "The public strip along a road where linear infrastructure like fiber is typically allowed to run.",
  circuity:
    "A slack multiplier on the connector distance. The distance is already road-routed, so this is optional extra (≥ 1.00) for detours the model didn't capture.",
  "z-score":
    "How many standard deviations a value sits from the mean — used to put the index terms on a comparable scale before weighting.",
  MAUP: "Modifiable Areal Unit Problem: aggregated scores depend on the size and placement of the cells. Flip r8 ⇄ r9 to feel it.",
  H3: "Uber's hexagonal grid. Near-uniform cell area, no orientation bias — the hexes this overview aggregates buildings into.",
  POI: "Point of interest — a whitelisted public Overture place (shop, office, clinic…), used as a modeled tenant-density signal, not a customer count.",
};

interface Props {
  term: string; // key into GLOSSARY (also the aria label subject)
  label?: string; // trigger text; defaults to a "?" chip
  pos?: "below" | "above";
  align?: "left" | "right";
}

// A dependency-free info tooltip: focusable "?" button + role="tooltip" popover.
// Opens on hover/focus/click; closes on Escape (returns focus), blur, outside click.
export default function Info({ term, label, pos = "below", align = "left" }: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const body = GLOSSARY[term] ?? null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!body) return null;

  const openNow = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const closeSoon = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  };

  return (
    <span className="nn-info" ref={wrapRef} onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <button
        type="button"
        ref={btnRef}
        className="nn-info-btn"
        aria-label={`What is ${term}?`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onFocus={openNow}
        onBlur={closeSoon}
        onClick={() => setOpen((o) => !o)}
      >
        {label ?? "?"}
      </button>
      {open && (
        <span id={id} role="tooltip" className="nn-info-pop" data-pos={pos} data-align={align}>
          {body}
        </span>
      )}
    </span>
  );
}
