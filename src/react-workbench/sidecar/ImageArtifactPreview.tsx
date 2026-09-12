import { useState } from "react";
import { useTranslation } from "react-i18next";
import { logRendererEvent } from "../../app-core/native/rendererLogger";

export function ImageArtifactPreview({ src, title, path }: { src: string; title: string; path?: string }) {
  const { t } = useTranslation("chat");
  const [failed, setFailed] = useState(false);
  return failed ? <p role="alert">{t("details.imagePreviewFailed", { name: title })}</p> : (
    <img
      alt={title}
      className="react-artifact-detail__image"
      src={src}
      onError={() => {
        logRendererEvent("error", "artifact.image.decode.failed", { path, title });
        setFailed(true);
      }}
    />
  );
}
