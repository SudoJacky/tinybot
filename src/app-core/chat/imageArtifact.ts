const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
};

export function resolveImageArtifactMimeType({ mimeType, path, title }: {
  mimeType?: string;
  path?: string;
  title?: string;
}): string | undefined {
  const normalized = mimeType?.split(";", 1)[0].trim().toLowerCase();
  if (normalized && Object.values(IMAGE_MIME_TYPES).includes(normalized)) return normalized;
  const extension = /\.([^./\\]+)$/.exec(path || title || "")?.[1].toLowerCase();
  return extension && Object.prototype.hasOwnProperty.call(IMAGE_MIME_TYPES, extension) ? IMAGE_MIME_TYPES[extension] : undefined;
}
