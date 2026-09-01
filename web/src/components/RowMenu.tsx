import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// A single "⋮" trigger per row, whatever the number of actions available —
// so a row-actions cell is always exactly one button tall. Stacking a
// variable number of inline buttons instead made rows with more available
// actions visibly taller than rows with fewer, so the table never read as
// an even grid.
export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="row-menu" ref={ref}>
      <button type="button" className="row-menu-trigger" aria-label={label} onClick={() => setOpen((o) => !o)}>
        ⋮
      </button>
      {open && (
        <div className="row-menu-dropdown" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function RowMenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="row-menu-item" onClick={onClick}>
      {children}
    </button>
  );
}
