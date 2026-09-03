import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

interface Position {
  top?: number;
  bottom?: number;
  right: number;
}

// Rendered via a portal into <body> and positioned with `fixed` coordinates
// computed from the trigger's own bounding rect, rather than as a normal
// absolutely-positioned child of the row. A table needs `overflow: hidden`
// to keep its own rounded corners clean, but that same overflow clips any
// ordinary dropdown that tries to open below a row near the table's bottom
// edge — the portal sidesteps that entirely, and flips to open upward when
// there isn't enough room below in the viewport.
export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const estimatedMenuHeight = 220; // generous estimate covering up to ~5 items
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUpward = spaceBelow < estimatedMenuHeight && rect.top > estimatedMenuHeight;
    setPos({
      right: window.innerWidth - rect.right,
      ...(openUpward ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onScrollOrResize() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  return (
    <div className="row-menu">
      <button ref={triggerRef} type="button" className="row-menu-trigger" aria-label={label} onClick={() => setOpen((o) => !o)}>
        ⋮
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={dropdownRef}
            className="row-menu-dropdown"
            style={{ position: "fixed", top: pos.top, bottom: pos.bottom, right: pos.right }}
            onClick={() => setOpen(false)}
          >
            {children}
          </div>,
          document.body
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
