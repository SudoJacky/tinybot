import { BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

export function skillDisplayLabel(id: string): string {
  return id.slice(id.lastIndexOf(":") + 1)
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

export function MessageSkills({ skills = [] }: { skills?: readonly string[] }) {
  const { t } = useTranslation("chat");
  if (!skills.length) return null;
  return (
    <ul aria-label={t("composer.skill.heading")} className="react-message-skills">
      {skills.map((skill) => (
        <li className="react-message-skills__chip" key={skill} title={skill}>
          <BookOpen aria-hidden="true" size={14} />
          <span>{skillDisplayLabel(skill)}</span>
        </li>
      ))}
    </ul>
  );
}
