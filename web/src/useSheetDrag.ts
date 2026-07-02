// V2.4 — mobile bottom-sheet drag (Apple/Google-Maps style: peek / half / full
// detents, pointer-drag + snap). The sheet's vertical offset rides on a CSS var
// `--sheet-ty` (px) set inline on the panel; CSS reads it as translateY. Desktop
// ignores the var (the panel has no transform there), so this is inert unless
// `enabled` (mobile) is true.

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type Detent = "peek" | "half" | "full";
const ORDER: Detent[] = ["peek", "half", "full"];
const PEEK_PX = 120; // visible strip in the peek state
const SHEET_VH = 0.88; // sheet height as a fraction of the viewport
const FLICK = 6; // px/last-move that counts as a fast flick → jump one detent

// translateY (px) for a detent: full = fully up (0), peek = only PEEK_PX showing.
function detentY(detent: Detent, h: number): number {
  if (detent === "full") return 0;
  if (detent === "half") return Math.max(0, Math.round(h * 0.44));
  return Math.max(0, Math.round(h * SHEET_VH) - PEEK_PX); // peek
}

export interface SheetControls {
  detent: Detent;
  setDetent: (d: Detent) => void;
  style: CSSProperties; // apply to the panel: carries --sheet-ty (+ transition off while dragging)
  onGrabPointerDown: (e: ReactPointerEvent) => void;
  onGrabKeyDown: (e: ReactKeyboardEvent) => void;
}

export function useSheetDrag(enabled: boolean): SheetControls {
  const [detent, setDetent] = useState<Detent>("peek");
  const [ty, setTy] = useState<number>(() =>
    typeof window === "undefined" ? 0 : detentY("peek", window.innerHeight),
  );
  const [dragging, setDragging] = useState(false);

  // Snap ty to the current detent when not dragging, and on viewport resize.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setTy(detentY(detent, window.innerHeight));
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [detent]);

  const onGrabPointerDown = (e: ReactPointerEvent) => {
    if (!enabled) return;
    e.preventDefault();
    const startPointerY = e.clientY;
    const startTy = ty;
    const maxTy = detentY("peek", window.innerHeight);
    let curTy = startTy;
    let prevY = startPointerY;
    let lastDy = 0;
    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      lastDy = ev.clientY - prevY;
      prevY = ev.clientY;
      curTy = Math.min(maxTy, Math.max(0, startTy + (ev.clientY - startPointerY)));
      setTy(curTy);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(false);
      const h = window.innerHeight;
      const targets = ORDER.map((d) => ({ d, y: detentY(d, h) }));
      let nearest = targets.reduce((a, b) =>
        Math.abs(b.y - curTy) < Math.abs(a.y - curTy) ? b : a,
      );
      // Fast flick → bias one detent in the drag direction (up = raise = smaller y).
      const idx = ORDER.indexOf(nearest.d);
      if (lastDy < -FLICK) nearest = targets[Math.min(ORDER.length - 1, idx + 1)];
      else if (lastDy > FLICK) nearest = targets[Math.max(0, idx - 1)];
      setDetent(nearest.d); // the effect re-snaps ty to the chosen detent
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onGrabKeyDown = (e: ReactKeyboardEvent) => {
    if (!enabled) return;
    const idx = ORDER.indexOf(detent);
    if (e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setDetent(ORDER[Math.min(ORDER.length - 1, idx + 1)]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setDetent(ORDER[Math.max(0, idx - 1)]);
    }
  };

  const style = useMemo<CSSProperties>(
    () => ({ "--sheet-ty": `${ty}px`, transition: dragging ? "none" : undefined } as CSSProperties),
    [ty, dragging],
  );

  return { detent, setDetent, style, onGrabPointerDown, onGrabKeyDown };
}
