'use client';
import { useState } from 'react';
import { CSV_FIELDS, CSV_MAX_BYTES, parseCsv, type ImportMode, type ImportType, type RowOutcome } from '../shared/csv';
import { AttioButton } from '../src/neander-design-pack/attio/1.1.0/AttioBlocks';

type Result = { status: 'preview' | 'completed'; total: number; outcomes: RowOutcome[]; counts: { create: number; update: number; unchanged: number; error: number } };
export default function CsvSection({ type, workspaceId, canWrite, onImported }: { type: ImportType; workspaceId: string; canWrite: boolean; onImported: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null), [headers, setHeaders] = useState<string[]>([]), [mapping, setMapping] = useState<Record<string, string>>({}), [mode, setMode] = useState<ImportMode>('upsert');
  const [result, setResult] = useState<Result | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function choose(next: File | null) {
    setFile(next); setHeaders([]); setMapping({}); setResult(null); setError('');
    if (!next) return;
    if (next.size > CSV_MAX_BYTES) { setError('CSV file exceeds the 10 MB limit.'); return; }
    try {
      const parsed = parseCsv(await next.text());
      setHeaders(parsed.headers);
      setMapping(Object.fromEntries(CSV_FIELDS[type].map(field => [field, parsed.headers.find(header => header.toLowerCase() === field.toLowerCase()) || ''])));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read CSV.'); }
  }
  async function request(action: 'preview' | 'import') {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const form = new FormData(); form.set('action', action); form.set('type', type); form.set('mode', mode); form.set('mapping', JSON.stringify(mapping)); form.set('file', file);
      const response = await fetch('/api/csv', { method: 'POST', headers: { 'x-workspace-id': workspaceId }, body: form });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'CSV operation failed.');
      setResult(data);
      if (action === 'import') await onImported();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'CSV operation failed.'); }
    finally { setBusy(false); }
  }
  async function download() {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/csv?type=${type}`, { headers: { 'x-workspace-id': workspaceId }, cache: 'no-store' });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Export failed.'); }
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `folio-${type}.csv`; link.click(); URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Export failed.'); }
    finally { setBusy(false); }
  }
  return <section className="panel csv-section"><h2>CSV transfer · {type === 'companies' ? 'Companies' : 'People'}</h2>
    <p>Export records in this workspace. Spreadsheet formulas are made safe. Import is synchronous and limited to 10 MB, 10,000 rows, and the workspace&apos;s 500 records per collection. No background job is created.</p>
    <AttioButton leadingIcon="download" disabled={busy} onClick={() => void download()}>Download {type} CSV</AttioButton>
    {canWrite && <><h3>Import {type}</h3><p>{type === 'companies' ? 'Match companies by domain. A domain is required for every imported row.' : 'Match people by email. Each row needs the domain of a company already in this workspace.'} Review the preview before saving.</p>
      <label className="field">CSV file<input type="file" accept=".csv,text/csv" onChange={e => void choose(e.target.files?.[0] || null)} /></label>
      {!!headers.length && <><div className="formgrid">{CSV_FIELDS[type].map(field => <label className="field" key={field}>{field}<select value={mapping[field] || ''} onChange={e => { setMapping(old => ({ ...old, [field]: e.target.value })); setResult(null); }}><option value="">Do not map</option>{headers.map(header => <option key={header} value={header}>{header}</option>)}</select></label>)}</div>
        <label className="field">Import mode<select value={mode} onChange={e => { setMode(e.target.value as ImportMode); setResult(null); }}><option value="upsert">Create or update</option><option value="create-only">Create only</option><option value="update-only">Update only</option></select></label>
        <AttioButton disabled={busy} onClick={() => void request('preview')}>{busy ? 'Working…' : 'Preview rows'}</AttioButton>
      </>}
      {result?.status === 'preview' && <AttioButton variant="primary" disabled={busy || result.counts.create + result.counts.update === 0} onClick={() => void request('import')}>Import {result.counts.create + result.counts.update} {result.counts.create + result.counts.update === 1 ? 'row' : 'rows'}</AttioButton>}
    </>}
    {error && <p className="alert" role="alert">{error}</p>}
    {result && <div role="status"><p><strong>{result.status === 'preview' ? 'Preview' : 'Completed'}:</strong> {result.total} rows · {result.counts.create} created{result.status === 'preview' ? ' planned' : ''}, {result.counts.update} updated{result.status === 'preview' ? ' planned' : ''}, {result.counts.unchanged} unchanged, {result.counts.error} failed.</p>
      <div className="csv-results"><table><thead><tr><th>CSV row</th><th>Outcome</th><th>Record ID</th><th>Detail</th></tr></thead><tbody>{result.outcomes.map(outcome => <tr key={outcome.row}><td>{outcome.row}</td><td>{outcome.action}</td><td>{outcome.id ?? '—'}</td><td>{outcome.message}</td></tr>)}</tbody></table></div></div>}
  </section>;
}
