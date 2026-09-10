/** Parse quoted CSV/TSV without changing field values or numeric precision. */
export function parseDelimitedText(text: string, delimiter: ',' | '\t') {
  const input = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const finishField = () => { row.push(field); field = ''; closedQuote = false; };
  const finishRow = () => { finishField(); records.push(row); row = []; };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character !== '"') field += character;
      else if (input[index + 1] === '"') { field += '"'; index += 1; }
      else { quoted = false; closedQuote = true; }
      continue;
    }
    if (character === delimiter) finishField();
    else if (character === '\r' || character === '\n') {
      finishRow();
      if (character === '\r' && input[index + 1] === '\n') index += 1;
    } else if (character === '"' && !field && !closedQuote) quoted = true;
    else {
      if (closedQuote || character === '"') throw new Error('Unexpected text beside a quoted field at record ' + (records.length + 1));
      field += character;
    }
  }
  if (quoted) throw new Error('Unclosed quoted field at record ' + (records.length + 1));
  if (field || row.length || closedQuote) finishRow();
  const [headers = [], ...rows] = records;
  const invalidIndex = rows.findIndex((record) => record.length !== headers.length);
  if (invalidIndex !== -1) throw new Error('Record ' + (invalidIndex + 2) + ' has ' + rows[invalidIndex].length + ' fields; expected ' + headers.length);
  return { headers, rows };
}

export function artifactDelimiter(name: string, mimeType?: string): ',' | '\t' | undefined {
  const type = mimeType?.split(';', 1)[0].trim().toLowerCase();
  if (/\.tsv$/i.test(name) || type === 'text/tab-separated-values') return '\t';
  if (/\.csv$/i.test(name) || type === 'text/csv' || type === 'application/csv') return ',';
  return undefined;
}
