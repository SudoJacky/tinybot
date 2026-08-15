import { useTranslation } from "react-i18next";
import type { AppServices } from "../services";
import { MemoryPage } from "./MemoryPage";

export default function MemoryRoute({ services }: { services: AppServices }) {
  const { t } = useTranslation("common");
  return (
    <div className="react-workbench-page">
      <header><h1>{t("routes.memory")}</h1></header>
      <MemoryPage memoryStore={services.memoryStore} />
    </div>
  );
}
