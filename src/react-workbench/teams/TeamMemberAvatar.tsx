import type { ReactNode } from "react";
import portraits from "./assets/employee-portraits.png";

// Keep identities stable when members are renamed, filtered, or reordered.
const presetPortraits: Record<string, number> = { research: 0, analysis: 4, editor: 7 };

export function TeamMemberAvatar({ memberId, children }: { memberId: string; children?: ReactNode }) {
  const portrait = presetPortraits[memberId] ?? Array.from(memberId).reduce(
    (hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0,
  ) % 12;
  return (
    <span className="team-avatar team-avatar--pixel" aria-hidden="true" style={{
      backgroundImage: `url(${portraits})`,
      backgroundPosition: `${(portrait % 4) * 100 / 3}% ${Math.floor(portrait / 4) * 50}%`,
    }}>
      {children}
    </span>
  );
}
