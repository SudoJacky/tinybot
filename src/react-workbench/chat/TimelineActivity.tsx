import { Children, useId, useState, type ReactNode } from "react";
import { ChatDisclosureIcon } from "./ChatDisclosureIcon";
import "./TimelineActivity.css";

type Expansion =
  | { open: boolean; onOpenChange: (open: boolean) => void; defaultOpen?: never }
  | { open?: never; onOpenChange?: never; defaultOpen?: boolean };

type TimelineActivityProps = Expansion & {
  icon: ReactNode;
  title: ReactNode;
  triggerLabel?: string;
  meta?: ReactNode;
  preview?: ReactNode;
  status?: ReactNode;
  summary?: ReactNode;
  children?: ReactNode;
  className?: string;
  keepMounted?: boolean;
};

export function TimelineActivity({
  icon, title, triggerLabel, meta, preview, status, summary, children,
  className = "", keepMounted = false, open, onOpenChange, defaultOpen = false,
}: TimelineActivityProps) {
  const id = useId();
  const triggerId = `${id}-trigger`;
  const contentId = `${id}-content`;
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const hasContent = Children.toArray(children).length > 0;
  const expanded = hasContent && (open ?? localOpen);
  const heading = (
    <>
      <span aria-hidden="true" className="react-timeline-activity__icon">
        {hasContent ? <ChatDisclosureIcon icon={icon} /> : icon}
      </span>
      <span className="react-timeline-activity__heading">
        <span className="react-timeline-activity__title">{title}</span>
        {meta ? <span className="react-timeline-activity__meta">{meta}</span> : null}
      </span>
      {preview ? <span aria-hidden="true" className="react-timeline-activity__preview" hidden={expanded}>{preview}</span> : null}
      {status}
    </>
  );

  return (
    <div className={`react-timeline-activity ${className}`} data-open={expanded ? "true" : undefined}>
      {hasContent ? (
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={triggerLabel}
          className="react-timeline-activity__header react-chat-disclosure-trigger"
          id={triggerId}
          type="button"
          onClick={() => {
            if (open === undefined) setLocalOpen(!expanded);
            else onOpenChange(!expanded);
          }}
        >{heading}</button>
      ) : <div className="react-timeline-activity__header">{heading}</div>}
      {summary}
      {hasContent ? (
        <div aria-labelledby={triggerId} className="react-timeline-activity__content" hidden={!expanded} id={contentId} role="region">
          {expanded || keepMounted ? children : null}
        </div>
      ) : null}
    </div>
  );
}
