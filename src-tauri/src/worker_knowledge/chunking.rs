use super::*;

pub(super) fn make_document_id(name: &str, content: &str, created_at: &str) -> String {
    let mut hasher = DefaultHasher::new();
    created_at.hash(&mut hasher);
    name.hash(&mut hasher);
    content.hash(&mut hasher);
    format!("doc_{:08x}", (hasher.finish() & 0xffff_ffff) as u32)
}

pub(super) fn build_document_chunks(
    doc_id: &str,
    doc_name: &str,
    file_path: &str,
    sections: &[ParentSection],
    params: &KnowledgeAddDocumentParams,
    created_at: &str,
) -> Vec<KnowledgeChunk> {
    let mut chunks = Vec::new();
    for (index, section) in sections.iter().enumerate() {
        let parent = KnowledgeChunk::parent(
            doc_id, doc_name, file_path, section, index, params, created_at,
        );
        let parent_id = parent.id.clone();
        chunks.push(parent);
        if sections.len() <= 1 {
            continue;
        }
        for (child_index, line) in section.child_lines.iter().enumerate() {
            let parent_section_id = section
                .parent_section_index
                .map(|parent_index| section_id(doc_id, parent_index))
                .unwrap_or_else(|| "section-root".to_string());
            chunks.push(KnowledgeChunk::child(
                doc_id,
                doc_name,
                file_path,
                &parent_id,
                index,
                child_index,
                line,
                &section.section_path,
                &section.section_title,
                &parent_section_id,
                section.section_ordinal,
                params,
                created_at,
            ));
        }
    }
    chunks
}

pub(super) fn build_knowledge_document_tree(
    doc_id: &str,
    mut parent_chunks: Vec<KnowledgeChunk>,
) -> KnowledgeDocumentTreeResult {
    parent_chunks.sort_by(|left, right| {
        left.section_ordinal
            .cmp(&right.section_ordinal)
            .then_with(|| left.chunk_index.cmp(&right.chunk_index))
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut children_by_parent: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in &parent_chunks {
        let section_id = knowledge_chunk_section_id(chunk);
        let parent_id = if chunk.parent_section_id.is_empty() {
            "section-root".to_string()
        } else {
            chunk.parent_section_id.clone()
        };
        children_by_parent
            .entry(parent_id)
            .or_default()
            .push(section_id);
    }
    let sections = parent_chunks
        .into_iter()
        .map(|chunk| {
            let section_id = knowledge_chunk_section_id(&chunk);
            KnowledgeDocumentTreeSection {
                id: section_id.clone(),
                doc_id: chunk.doc_id,
                chunk_id: chunk.id,
                title: if chunk.section_title.is_empty() {
                    chunk.section_path.clone()
                } else {
                    chunk.section_title
                },
                section_path: chunk.section_path,
                parent_id: if chunk.parent_section_id.is_empty() {
                    "section-root".to_string()
                } else {
                    chunk.parent_section_id
                },
                children: children_by_parent.remove(&section_id).unwrap_or_default(),
                ordinal: chunk.section_ordinal,
                line_start: chunk.line_start,
                line_end: chunk.line_end,
                chunk_count: 1,
            }
        })
        .collect::<Vec<_>>();
    let section_count = sections.len();
    KnowledgeDocumentTreeResult {
        object: "knowledge_document_tree".to_string(),
        doc_id: doc_id.to_string(),
        root: KnowledgeDocumentTreeRoot {
            id: "section-root".to_string(),
            children: children_by_parent
                .remove("section-root")
                .unwrap_or_default(),
        },
        sections,
        section_count,
    }
}

pub(super) fn knowledge_chunk_section_id(chunk: &KnowledgeChunk) -> String {
    if chunk.section_id.is_empty() {
        section_id(&chunk.doc_id, chunk.section_ordinal)
    } else {
        chunk.section_id.clone()
    }
}

pub(super) fn split_parent_sections(content: &str) -> Vec<ParentSection> {
    let line_spans = content_line_spans(content);
    if line_spans.is_empty() {
        return vec![ParentSection {
            content: content.to_string(),
            start_char: 0,
            end_char: content.chars().count(),
            line_start: 1,
            line_end: 1,
            section_path: String::new(),
            section_title: String::new(),
            parent_section_index: None,
            section_ordinal: 0,
            child_lines: Vec::new(),
        }];
    }
    let mut sections = Vec::new();
    let mut current_start = 0usize;
    let mut current_line_start = 1usize;
    let mut current_section_path = first_markdown_heading(content).unwrap_or_default();
    let mut current_heading_level = first_markdown_heading_level(content).unwrap_or(0);
    let mut current_parent_section_index = None;
    let mut current_child_lines = Vec::new();
    let mut heading_stack: Vec<(usize, usize)> = Vec::new();
    for (index, line) in line_spans.iter().enumerate() {
        if line.is_heading && index != current_start {
            let closed_section_index = sections.len();
            sections.push(parent_section_from_lines(
                &line_spans[current_start..index],
                current_line_start,
                current_section_path,
                current_parent_section_index,
                closed_section_index,
                current_child_lines,
            ));
            if current_heading_level > 0 {
                heading_stack.retain(|(level, _)| *level < current_heading_level);
                heading_stack.push((current_heading_level, closed_section_index));
            }
            current_start = index;
            current_line_start = line.line_number;
            current_section_path = line.heading.clone().unwrap_or_default();
            current_heading_level = line.heading_level.unwrap_or(0);
            heading_stack.retain(|(level, _)| *level < current_heading_level);
            current_parent_section_index = heading_stack
                .last()
                .map(|(_, section_index)| *section_index);
            current_child_lines = Vec::new();
        }
        if !line.is_heading && !line.trimmed.is_empty() {
            current_child_lines.push(SectionLine {
                content: line.trimmed.clone(),
                start_char: line.start_char,
                end_char: line.end_char,
                line_number: line.line_number,
            });
        }
    }
    sections.push(parent_section_from_lines(
        &line_spans[current_start..],
        current_line_start,
        current_section_path,
        current_parent_section_index,
        sections.len(),
        current_child_lines,
    ));
    sections
}

pub(super) fn parent_section_from_lines(
    lines: &[LineSpan],
    line_start: usize,
    section_path: String,
    parent_section_index: Option<usize>,
    section_ordinal: usize,
    child_lines: Vec<SectionLine>,
) -> ParentSection {
    let content = lines
        .iter()
        .map(|line| line.original.as_str())
        .collect::<Vec<_>>()
        .join("");
    let start_char = lines.first().map(|line| line.start_char).unwrap_or(0);
    let end_char = lines.last().map(|line| line.end_char).unwrap_or(start_char);
    let line_end = lines
        .last()
        .map(|line| line.line_number)
        .unwrap_or(line_start);
    ParentSection {
        content,
        start_char,
        end_char,
        line_start,
        line_end,
        section_title: section_path.clone(),
        section_path,
        parent_section_index,
        section_ordinal,
        child_lines,
    }
}

#[derive(Clone, Debug)]
pub(super) struct LineSpan {
    original: String,
    trimmed: String,
    start_char: usize,
    end_char: usize,
    line_number: usize,
    is_heading: bool,
    heading: Option<String>,
    heading_level: Option<usize>,
}

pub(super) fn content_line_spans(content: &str) -> Vec<LineSpan> {
    let mut spans = Vec::new();
    let mut offset = 0usize;
    for (index, line) in content.split_inclusive('\n').enumerate() {
        let line_without_newline = line.trim_end_matches(['\r', '\n']);
        let trimmed = line_without_newline.trim().to_string();
        let heading = markdown_heading(&trimmed);
        let end_char = offset + line.chars().count();
        spans.push(LineSpan {
            original: line.to_string(),
            trimmed,
            start_char: offset,
            end_char,
            line_number: index + 1,
            is_heading: heading.is_some(),
            heading: heading.as_ref().map(|(_, title)| title.clone()),
            heading_level: heading.map(|(level, _)| level),
        });
        offset = end_char;
    }
    if offset < content.chars().count() {
        let remainder = &content[offset..];
        let trimmed = remainder.trim().to_string();
        let heading = markdown_heading(&trimmed);
        spans.push(LineSpan {
            original: remainder.to_string(),
            trimmed,
            start_char: offset,
            end_char: content.chars().count(),
            line_number: spans.len() + 1,
            is_heading: heading.is_some(),
            heading: heading.as_ref().map(|(_, title)| title.clone()),
            heading_level: heading.map(|(level, _)| level),
        });
    }
    spans
}

pub(super) fn now_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    seconds.to_string()
}

pub(super) fn first_markdown_heading(content: &str) -> Option<String> {
    content
        .lines()
        .find_map(|line| markdown_heading_text(line.trim()))
}

pub(super) fn first_markdown_heading_level(content: &str) -> Option<usize> {
    content
        .lines()
        .find_map(|line| markdown_heading(line.trim()).map(|(level, _)| level))
}

pub(super) fn markdown_heading_text(trimmed: &str) -> Option<String> {
    markdown_heading(trimmed).map(|(_, title)| title)
}

pub(super) fn markdown_heading(trimmed: &str) -> Option<(usize, String)> {
    let level = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if level == 0 || level > 6 {
        return None;
    }
    let title = trimmed[level..].trim();
    if title.is_empty() {
        return None;
    }
    Some((level, title.to_string()))
}

pub(super) fn section_id(doc_id: &str, section_ordinal: usize) -> String {
    format!("section_{doc_id}_{section_ordinal}")
}
