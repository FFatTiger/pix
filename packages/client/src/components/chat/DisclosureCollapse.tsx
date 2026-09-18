import { useLayoutEffect, useState, type ReactNode } from "react";

export const DISCLOSURE_TRANSITION_MS = 180;

export function useDisclosurePresence(open: boolean): { present: boolean; visuallyOpen: boolean } {
  const [present, setPresent] = useState(open);
  const [visuallyOpen, setVisuallyOpen] = useState(open);

  useLayoutEffect(() => {
    let frame = 0;
    let timer = 0;

    if (open) {
      setPresent(true);
      frame = window.requestAnimationFrame(() => setVisuallyOpen(true));
    } else {
      setVisuallyOpen(false);
      timer = window.setTimeout(() => setPresent(false), DISCLOSURE_TRANSITION_MS);
    }

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      if (timer !== 0) window.clearTimeout(timer);
    };
  }, [open]);

  return { present, visuallyOpen };
}

export function DisclosureCollapse({
  open,
  className = "",
  innerClassName = "",
  children,
}: {
  open: boolean;
  className?: string | undefined;
  innerClassName?: string | undefined;
  children: ReactNode;
}) {
  const { present, visuallyOpen } = useDisclosurePresence(open);
  if (!present) return null;

  return (
    <div
      className={`disclosure-collapse${className ? ` ${className}` : ""}`}
      data-state={visuallyOpen ? "open" : "closed"}
      aria-hidden={!open}
      inert={open ? undefined : true}
    >
      <div className={`disclosure-collapse-inner${innerClassName ? ` ${innerClassName}` : ""}`}>
        {children}
      </div>
    </div>
  );
}
