export function formatFileMetadata(mimeType: string, sizeBytes: number): string {
  return `${fileTypeLabel(mimeType)} - ${formatFileSize(sizeBytes)}`;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) {
    return "0 Bytes";
  }
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function fileTypeLabel(type: string): string {
  const parts = type.split("/");
  let label = (parts[parts.length - 1] || "file").toUpperCase();
  if (label.length > 7 && label.includes("-")) {
    label = label.substring(0, label.indexOf("-"));
  }
  if (label.length > 10) {
    label = `${label.substring(0, 10)}...`;
  }
  return label;
}
