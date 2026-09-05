import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import "./ChatDisclosureIcon.css";

export function ChatDisclosureIcon({ icon }: { icon: ReactNode }) {
  return (
    <span aria-hidden="true" className="react-chat-disclosure-icon">
      <span className="react-chat-disclosure-icon__symbol">{icon}</span>
      <ChevronDown className="react-chat-disclosure-icon__chevron" size={16} />
    </span>
  );
}
