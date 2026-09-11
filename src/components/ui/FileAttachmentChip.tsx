import { ChevronRight, File, FileArchive, FileImage, FileSpreadsheet, FileText, FileVideo, Music, X } from "lucide-react";
import "./FileAttachmentChip.css";

export function FileAttachmentChip({ id, name, path, detail, mimeType, onOpen, onRemove, removeLabel }: {
  id?: string;
  name: string;
  path?: string;
  detail?: string;
  mimeType?: string;
  onOpen?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const extension = /\.[^.\\/]+$/.exec(name)?.[0] ?? "";
  const type = extension.slice(1).toLowerCase();
  const category = /^(xlsx?|csv|ods)$/.test(type) ? "spreadsheet"
    : /^(png|jpe?g|gif|webp|svg|avif|heic)$/.test(type) || mimeType?.startsWith("image/") ? "image"
    : /^(mp4|mov|webm)$/.test(type) || mimeType?.startsWith("video/") ? "video"
    : /^(mp3|wav|ogg|flac)$/.test(type) || mimeType?.startsWith("audio/") ? "audio"
    : /^(zip|rar|7z|tar|gz)$/.test(type) ? "archive"
    : type === "pdf" ? "pdf" : /^(docx?|txt|md|json|tsx?|jsx?|py|rs)$/.test(type) ? "document" : "file";
  const Icon = { spreadsheet: FileSpreadsheet, image: FileImage, video: FileVideo, audio: Music, archive: FileArchive, pdf: FileText, document: FileText, file: File }[category];
  const title = [name, path, detail].filter(Boolean).join("\n");
  const content = <>
    <Icon className="file-attachment-chip__icon" aria-hidden="true" size={18} />
    <span className="file-attachment-chip__name">{name}</span>
    {type ? <span className="file-attachment-chip__type" aria-hidden="true">{type.toUpperCase()}</span> : null}
    {onOpen ? <ChevronRight className="file-attachment-chip__chevron" aria-hidden="true" size={14} /> : null}
  </>;
  return <div className="file-attachment-chip" data-category={category} data-attachment-id={id}>
    {onOpen
      ? <button type="button" className="file-attachment-chip__content" title={title} aria-label={title} onClick={onOpen}>{content}</button>
      : <span className="file-attachment-chip__content" title={title} role="group" aria-label={title} tabIndex={0}>{content}</span>}
    {onRemove ? <button type="button" className="file-attachment-chip__remove" aria-label={removeLabel} onClick={onRemove}><X aria-hidden="true" size={14} /></button> : null}
  </div>;
}
