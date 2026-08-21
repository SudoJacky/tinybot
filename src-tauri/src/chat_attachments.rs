use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MANAGED_IMAGE_DIRECTORY: &str = "chat-attachments/images";
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedImageAttachment {
    pub(crate) content_hash: String,
    pub(crate) mime_type: String,
    pub(crate) path: String,
    pub(crate) size_bytes: u64,
}

pub(crate) fn store_image_attachment(
    source: &Path,
    data_root: &Path,
) -> Result<Option<ManagedImageAttachment>, String> {
    let mut source_file = fs::File::open(source).map_err(|error| {
        format!(
            "failed to open selected attachment `{}`: {error}",
            source.display()
        )
    })?;
    let source_size = source_file
        .metadata()
        .map_err(|error| {
            format!(
                "failed to inspect selected attachment `{}`: {error}",
                source.display()
            )
        })?
        .len();
    let mut prefix = [0_u8; 12];
    let prefix_len = source_file.read(&mut prefix).map_err(|error| {
        format!(
            "failed to inspect selected attachment `{}`: {error}",
            source.display()
        )
    })?;
    let Some(mime_type) = detect_supported_image_mime(&prefix[..prefix_len]) else {
        return Ok(None);
    };
    if source_size > MAX_IMAGE_BYTES {
        return Err(format!(
            "image attachment `{}` is {} bytes; the maximum supported image size is {} bytes",
            source.display(),
            source_size,
            MAX_IMAGE_BYTES
        ));
    }

    let bytes = fs::read(source).map_err(|error| {
        format!(
            "failed to read selected image `{}`: {error}",
            source.display()
        )
    })?;
    let detected_mime = detect_supported_image_mime(&bytes).ok_or_else(|| {
        format!(
            "selected image `{}` has unsupported content",
            source.display()
        )
    })?;
    if detected_mime != mime_type {
        return Err(format!(
            "selected image `{}` changed while it was being read",
            source.display()
        ));
    }
    let content_hash = sha256_hex(&bytes);
    let directory = data_root.join(MANAGED_IMAGE_DIRECTORY);
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "failed to create managed attachment directory `{}`: {error}",
            directory.display()
        )
    })?;
    let target = directory.join(format!("{content_hash}.{}", extension_for_mime(mime_type)));
    write_content_addressed_file(&target, &bytes)?;
    Ok(Some(ManagedImageAttachment {
        content_hash,
        mime_type: mime_type.to_string(),
        path: target.display().to_string(),
        size_bytes: bytes.len() as u64,
    }))
}

pub(crate) fn managed_image_data_url(
    path: &str,
    expected_mime_type: &str,
    expected_size_bytes: u64,
    expected_content_hash: &str,
) -> Result<String, String> {
    managed_image_data_url_from_root(
        &crate::config::application::tinybot_data_root(),
        path,
        expected_mime_type,
        expected_size_bytes,
        expected_content_hash,
    )
}

fn managed_image_data_url_from_root(
    data_root: &Path,
    path: &str,
    expected_mime_type: &str,
    expected_size_bytes: u64,
    expected_content_hash: &str,
) -> Result<String, String> {
    let attachment_root = data_root.join(MANAGED_IMAGE_DIRECTORY);
    let canonical_root = attachment_root.canonicalize().map_err(|error| {
        format!(
            "failed to resolve managed attachment directory `{}`: {error}",
            attachment_root.display()
        )
    })?;
    let requested = PathBuf::from(path);
    let canonical_path = requested.canonicalize().map_err(|error| {
        format!(
            "failed to resolve image attachment `{}`: {error}",
            requested.display()
        )
    })?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(format!(
            "image attachment `{}` is outside Tinybot managed storage",
            canonical_path.display()
        ));
    }
    let bytes = fs::read(&canonical_path).map_err(|error| {
        format!(
            "failed to read image attachment `{}`: {error}",
            canonical_path.display()
        )
    })?;
    if bytes.len() as u64 != expected_size_bytes {
        return Err(format!(
            "image attachment `{}` size changed: expected {}, got {}",
            canonical_path.display(),
            expected_size_bytes,
            bytes.len()
        ));
    }
    let actual_mime_type = detect_supported_image_mime(&bytes).ok_or_else(|| {
        format!(
            "image attachment `{}` no longer contains a supported image",
            canonical_path.display()
        )
    })?;
    if actual_mime_type != expected_mime_type {
        return Err(format!(
            "image attachment `{}` MIME type changed: expected {}, got {}",
            canonical_path.display(),
            expected_mime_type,
            actual_mime_type
        ));
    }
    let actual_content_hash = sha256_hex(&bytes);
    if actual_content_hash != expected_content_hash {
        return Err(format!(
            "image attachment `{}` content hash changed",
            canonical_path.display()
        ));
    }
    Ok(format!(
        "data:{actual_mime_type};base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

fn write_content_addressed_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        let existing = fs::read(path).map_err(|error| {
            format!(
                "failed to verify managed attachment `{}`: {error}",
                path.display()
            )
        })?;
        if existing == bytes {
            return Ok(());
        }
        return Err(format!(
            "managed attachment hash collision at `{}`",
            path.display()
        ));
    }

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "managed attachment path is missing a file name".to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        timestamp
    ));
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                format!(
                    "failed to create managed attachment `{}`: {error}",
                    temporary.display()
                )
            })?;
        file.write_all(bytes).map_err(|error| {
            format!(
                "failed to write managed attachment `{}`: {error}",
                temporary.display()
            )
        })?;
        file.sync_all().map_err(|error| {
            format!(
                "failed to sync managed attachment `{}`: {error}",
                temporary.display()
            )
        })?;
        drop(file);
        match fs::rename(&temporary, path) {
            Ok(()) => Ok(()),
            Err(_) if path.exists() => {
                let existing = fs::read(path).map_err(|error| {
                    format!(
                        "failed to verify concurrently stored attachment `{}`: {error}",
                        path.display()
                    )
                })?;
                if existing == bytes {
                    Ok(())
                } else {
                    Err(format!(
                        "managed attachment hash collision at `{}`",
                        path.display()
                    ))
                }
            }
            Err(error) => Err(format!(
                "failed to publish managed attachment `{}`: {error}",
                path.display()
            )),
        }
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn detect_supported_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => unreachable!("unsupported image MIME type"),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn fixture_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tinybot-chat-attachment-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn stores_an_image_by_detected_content_and_loads_it_as_a_data_url() {
        let root = fixture_root("roundtrip");
        let source = root.join("selected.txt");
        fs::create_dir_all(&root).unwrap();
        let bytes = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01];
        fs::write(&source, bytes).unwrap();

        let stored = store_image_attachment(&source, &root)
            .expect("image should store")
            .expect("image content should be detected");
        let data_url = managed_image_data_url_from_root(
            &root,
            &stored.path,
            &stored.mime_type,
            stored.size_bytes,
            &stored.content_hash,
        )
        .expect("managed image should load");

        assert_eq!(stored.mime_type, "image/png");
        assert!(stored.path.ends_with(".png"));
        assert!(data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn rejects_paths_outside_managed_attachment_storage() {
        let root = fixture_root("containment");
        let source = root.join("outside.png");
        fs::create_dir_all(root.join(MANAGED_IMAGE_DIRECTORY)).unwrap();
        let bytes = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        fs::write(&source, bytes).unwrap();
        let hash = sha256_hex(&bytes);

        let error = managed_image_data_url_from_root(
            &root,
            &source.display().to_string(),
            "image/png",
            bytes.len() as u64,
            &hash,
        )
        .expect_err("unmanaged path must fail");

        assert!(error.contains("outside Tinybot managed storage"));
    }
}
