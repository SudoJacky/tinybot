import { Check, ChevronDown, Pencil, Search, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TeamMember } from "../../app-core/native/desktopNativeTeams";
import { TeamMemberAvatar } from "./TeamMemberAvatar";

export function TeamMemberPicker({ members, selectedIds, disabled, onSelectionChange, onChange }: {
  members: TeamMember[];
  selectedIds: string[];
  disabled: boolean;
  onSelectionChange(ids: string[]): void;
  onChange(members: TeamMember[]): void;
}) {
  const { t } = useTranslation("common");
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const selected = members.filter(member => selectedIds.includes(member.id));
  const visible = members.filter(member => member.id === editingId || member.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const expanded = open && !disabled;

  useLayoutEffect(() => {
    if (!expanded || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 20;
    const above = rect.top - 20;
    const upward = below < 340 && above > below;
    const width = Math.min(360, window.innerWidth - 24);
    setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      top: upward ? undefined : rect.bottom + 8,
      bottom: upward ? window.innerHeight - rect.top + 8 : undefined,
      maxHeight: Math.max(0, upward ? above : below) });
    searchRef.current?.focus();
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOpen(false);
    }
    function dismissOnScroll(event: Event) {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    const dismiss = () => setOpen(false);
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [expanded]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }
  function updateMember(memberId: string, patch: Partial<TeamMember>) {
    onChange(members.map(member => member.id === memberId ? { ...member, ...patch } : member));
  }

  return (
    <div className="team-roster-control" ref={rootRef}
      onBlur={event => {
        if (event.relatedTarget instanceof Node && !rootRef.current?.contains(event.relatedTarget) && !panelRef.current?.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}>
      <span className="react-settings-choice__label" id={`${id}-label`}>{t("teams.members")}</span>
      <button type="button" className="team-picker-trigger" ref={triggerRef}
        aria-label={`${t("teams.configureMembers")} · ${selected.length}`}
        aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? `${id}-panel` : undefined}
        disabled={disabled} onClick={() => { setOpen(!open); setQuery(""); }}>
        <span className="team-avatar-stack">
          {selected.map(member => <TeamMemberAvatar key={member.id} memberId={member.id} />)}
        </span>
        <span className="team-picker-summary">
          <strong>{t("teams.selectedMembers", { count: selected.length })}</strong>
          <span>{selected.map(member => member.displayName).join(" · ")}</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {expanded && createPortal(
        <div ref={panelRef} className="team-layout react-form-controls team-picker-panel" id={`${id}-panel`} role="dialog" aria-labelledby={`${id}-label`} style={position}>
          <div className="team-picker-heading">
            <strong>{t("teams.chooseMembers")}</strong>
            <button type="button" className="team-picker-icon" aria-label={t("teams.closeMembers")} onClick={close}><X size={16} /></button>
          </div>
          <label className="team-picker-search">
            <Search size={16} aria-hidden="true" />
            <input ref={searchRef} type="search" value={query} aria-label={t("teams.searchMembers")}
              placeholder={t("teams.searchMembers")} onChange={event => { setQuery(event.target.value); setEditingId(null); }}
              onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} />
          </label>
          <div className="team-picker-list">
            {visible.map(member => {
              const checked = selectedIds.includes(member.id);
              const lastSelected = checked && selected.length === 1;
              const editing = editingId === member.id;
              return (
                <div className="team-picker-member" key={member.id}>
                  <div className="team-picker-row" data-selected={checked}>
                    <label className="team-picker-choice" title={lastSelected ? t("teams.keepOneMember") : undefined}>
                      <input type="checkbox" checked={checked} disabled={lastSelected} aria-label={member.displayName}
                        onChange={() => onSelectionChange(checked ? selectedIds.filter(value => value !== member.id) : [...selectedIds, member.id])} />
                      <TeamMemberAvatar memberId={member.id} />
                      <span className="team-picker-name">{member.displayName}</span>
                      <span className="team-picker-check" aria-hidden="true">{checked && <Check size={13} strokeWidth={3} />}</span>
                    </label>
                    <button type="button" className="team-picker-icon" aria-label={t("teams.editMember", { name: member.displayName })}
                      aria-expanded={editing} aria-controls={editing ? `${id}-${member.id}-edit` : undefined}
                      onClick={() => setEditingId(editing ? null : member.id)}><Pencil size={14} /></button>
                  </div>
                  {editing && (
                    <div className="team-picker-editor" id={`${id}-${member.id}-edit`}>
                      <label className="react-settings-choice__label">{t("teams.memberName")}
                        <input className="react-form-input" required={checked} value={member.displayName}
                          onChange={event => updateMember(member.id, { displayName: event.target.value })} />
                      </label>
                      <label className="react-settings-choice__label">{t("teams.instructions")}
                        <textarea className="react-form-input" required={checked} value={member.instructions}
                          onChange={event => updateMember(member.id, { instructions: event.target.value })} />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
            {!visible.length && <p className="team-picker-empty">{t("teams.noMatchingMembers")}</p>}
          </div>
          <div className="team-picker-footer">
            <span role="status">{t("teams.selectedMembers", { count: selected.length })}</span>
            <button type="button" onClick={close}>{t("teams.doneMembers")}</button>
          </div>
          <p className="team-picker-hint">{t("teams.defaultModel")}</p>
        </div>, document.body,
      )}
    </div>
  );
}
