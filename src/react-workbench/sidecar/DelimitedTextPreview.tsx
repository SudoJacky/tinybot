import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { logRendererEvent } from '../../app-core/native/rendererLogger';
import { parseDelimitedText } from './delimitedText';
import './DelimitedTextPreview.css';

const MAX_ROWS = 200;
const MAX_COLUMNS = 50;

export function DelimitedTextPreview({ text, delimiter, title, actions, truncated = false }: {
  text: string;
  delimiter: ',' | '\t';
  title: string;
  actions: ReactNode;
  truncated?: boolean;
}) {
  const { t } = useTranslation('chat');
  const [view, setView] = useState<'table' | 'source'>('table');
  const parsed = useMemo(() => {
    try { return { data: parseDelimitedText(text, delimiter), error: undefined }; }
    catch (cause) { return { data: undefined, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [text, delimiter]);
  useEffect(() => {
    if (parsed.error) logRendererEvent('warn', 'artifact.delimited.parse.failed', { title, message: parsed.error, truncated });
  }, [parsed.error, title, truncated]);
  const data = parsed.data;
  const limited = data && (data.rows.length > MAX_ROWS || data.headers.length > MAX_COLUMNS);
  return <>
    <div className="react-artifact-detail__toolbar">
      <div aria-label={t('details.delimitedViews')} className="react-delimited-views" role="group">
        <button aria-pressed={view === 'table'} onClick={() => setView('table')} type="button">{t('details.delimitedTable')}</button>
        <button aria-pressed={view === 'source'} onClick={() => setView('source')} type="button">{t('details.delimitedSource')}</button>
      </div>
      {data ? <span className="react-delimited-dimensions">{t('dataView.dimensions', { rows: data.rows.length, columns: data.headers.length })}{truncated ? '+' : ''}</span> : null}
      <div className="react-artifact-detail__actions">{actions}</div>
    </div>
    {view === 'source' ? <pre aria-label={title} className="react-artifact-detail__text">{text}</pre>
      : parsed.error ? <p className="react-delimited-error" role="alert">{t('details.delimitedFailed', { message: parsed.error })}</p>
      : data?.headers.length ? <>
        <div aria-label={title} className="react-delimited-table" role="region" tabIndex={0}>
          <table aria-label={title}>
            <thead><tr><th aria-label={t('details.delimitedRow')} scope="col">#</th>{data.headers.slice(0, MAX_COLUMNS).map((header, index) => <th key={index} scope="col">{header}</th>)}</tr></thead>
            <tbody>{data.rows.slice(0, MAX_ROWS).map((row, rowIndex) => <tr key={rowIndex}>
              <th scope="row">{rowIndex + 1}</th>
              {row.slice(0, MAX_COLUMNS).map((value, columnIndex) => <td data-numeric={/^[+-]?\d+(?:[.,]\d+)*(?:[eE][+-]?\d+)?%?$/.test(value.trim()) || undefined} key={columnIndex}>{value}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
        {limited ? <p className="react-delimited-limit" role="status">{t('details.officeSpreadsheetTruncated', { rows: MAX_ROWS, columns: MAX_COLUMNS })}</p> : null}
      </> : <p>{t('details.noPreview')}</p>}
  </>;
}
