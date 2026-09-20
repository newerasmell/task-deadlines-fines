import type { ReactNode } from "react";

export function AccordionItem({
  headerLeft,
  headerRight,
  open,
  onToggle,
  children,
}: {
  headerLeft: ReactNode;
  headerRight?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="accordion-item">
      <div className="accordion-header">
        <button type="button" className="accordion-toggle" onClick={onToggle}>
          <span className={`chevron${open ? " open" : ""}`}>▸</span>
          {headerLeft}
        </button>
        {headerRight}
      </div>
      {open && <div className="accordion-body">{children}</div>}
    </div>
  );
}
