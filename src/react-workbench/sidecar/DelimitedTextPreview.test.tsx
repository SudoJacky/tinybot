// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelimitedTextPreview } from './DelimitedTextPreview';
import { artifactDelimiter, parseDelimitedText } from './delimitedText';

afterEach(cleanup);

describe('delimited text', () => {
  it('preserves quoted separators, escaped quotes, newlines, Unicode and integer precision', () => {
    expect(parseDelimitedText('\uFEFFname,note,id\r\n"中文, repo","line 1\nline ""2""",9007199254740993\r\n', ',')).toEqual({
      headers: ['name', 'note', 'id'], rows: [['中文, repo', 'line 1\nline "2"', '9007199254740993']],
    });
    expect(parseDelimitedText('a\tb\n1\t\n', '\t').rows).toEqual([['1', '']]);
    expect(parseDelimitedText('', ',')).toEqual({ headers: [], rows: [] });
    expect(parseDelimitedText('a,b\n"",', ',').rows).toEqual([['', '']]);
  });
  it('rejects malformed quoting and uneven rows instead of changing the data', () => {
    expect(() => parseDelimitedText('a,b\n"unfinished,2', ',')).toThrow('Unclosed quoted field');
    expect(() => parseDelimitedText('a,b\n"closed"extra,2', ',')).toThrow('Unexpected text');
    expect(() => parseDelimitedText('a,b\n1,2,3', ',')).toThrow('Record 2 has 3 fields; expected 2');
  });
  it('recognizes file extensions even when the backend reports text/plain', () => {
    expect(artifactDelimiter('gh_agents/repos.CSV', 'text/plain')).toBe(',');
    expect(artifactDelimiter('values.tsv', 'text/plain')).toBe('\t');
    expect(artifactDelimiter('export', 'text/csv; charset=utf-8')).toBe(',');
    expect(artifactDelimiter('notes.txt', 'text/plain')).toBeUndefined();
  });
});

describe('DelimitedTextPreview', () => {
  it('switches to intact source and retains the reference action and updated contents', () => {
    const reference = vi.fn();
    const props = { actions: <button onClick={reference}>Reference in chat</button>, delimiter: ',' as const, title: 'repos.csv' };
    const view = render(<DelimitedTextPreview {...props} text={'repo,stars\nAutoGPT,9007199254740993'} />);
    expect(within(screen.getByRole('table')).getByRole('cell', { name: '9007199254740993' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByLabelText('repos.csv').textContent).toBe('repo,stars\nAutoGPT,9007199254740993');
    fireEvent.click(screen.getByRole('button', { name: 'Reference in chat' }));
    expect(reference).toHaveBeenCalledOnce();
    view.rerender(<DelimitedTextPreview {...props} text={'repo,stars\ndify,155176'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(within(screen.getByRole('table')).getByRole('cell', { name: 'dify' })).toBeTruthy();
  });
  it('keeps invalid source accessible with an explicit parse error', () => {
    render(<DelimitedTextPreview actions={null} delimiter="," title="broken.csv" text={'a,b\n"unfinished'} />);
    expect(screen.getByRole('alert').textContent).toContain('Unclosed quoted field');
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByLabelText('broken.csv').textContent).toBe('a,b\n"unfinished');
  });
  it('bounds rendered rows and explains that more data exists', () => {
    render(<DelimitedTextPreview actions={null} delimiter="," title="large.csv" text={'id\n' + Array.from({ length: 220 }, (_, i) => i).join('\n')} />);
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(201);
    expect(screen.getByRole('status').textContent).toContain('200');
  });
});
