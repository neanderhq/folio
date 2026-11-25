'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Dialog } from './workspace-ui';
import { AttioButton } from '../src/neander-design-pack/attio/1.1.0/AttioBlocks';
import { CURRENCIES, STAGES } from '../shared/crm';

type RecordType = 'company' | 'person' | 'deal' | 'note';
type RecordData = { id: number; version: number; name?: string; domain?: string | null; description?: string | null; email?: string | null; companyId?: number; personId?: number; stage?: string; owner?: string; valueCents?: number; currency?: string; lostReason?: string | null; body?: string };
type Option = { id: number; name: string; companyId?: number };
function draftOf(record: RecordData) { return { name: record.name || '', domain: record.domain || '', description: record.description || '', email: record.email || '', companyId: String(record.companyId || ''), personId: String(record.personId || ''), stage: record.stage || 'Lead', owner: record.owner || '', value: String((record.valueCents || 0) / 100), currency: record.currency || 'USD', lostReason: record.lostReason || '', body: record.body || '' }; }
export default function RecordEditor({ type, record, workspaceId, companies, people, canWrite, onSaved, onRefresh }: { type: RecordType; record: RecordData; workspaceId: string; companies: Option[]; people: Option[]; canWrite: boolean; onSaved: () => Promise<void>; onRefresh: () => Promise<void> }) {
  const [editing,setEditing]=useState(false);
  const [draft, setDraft] = useState(() => draftOf(record));
  const [baseVersion, setBaseVersion] = useState(record.version);
  const [state, setState] = useState<'idle' | 'pending' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [reviewed, setReviewed] = useState<RecordData | null>(null);
  const [reviewing, setReviewing] = useState(false);
  function openEditor() {
    setDraft(draftOf(record)); setBaseVersion(record.version);
    setState('idle'); setMessage(''); setReviewed(null); setEditing(true);
  }
  async function reviewLatest() {
    setReviewing(true);
    try {
      const response = await fetch('/api/crm', { cache: 'no-store', headers: { 'x-workspace-id': workspaceId } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load the latest record.');
      const collection = type === 'company' ? result.companies : type === 'person' ? result.people : type === 'deal' ? result.deals : result.notes;
      const latest = collection.find((item: RecordData) => item.id === record.id) as RecordData | undefined;
      if (!latest) throw new Error('This record is no longer available. Your draft has been kept.');
      setBaseVersion(latest.version); setReviewed(latest); setState('idle');
      setMessage('Latest saved values are below. Your draft has been kept; review it before saving again.');
      await onRefresh();
    } catch (error) { setState('error'); setMessage(error instanceof Error ? error.message : 'Could not load the latest record.'); }
    finally { setReviewing(false); }
  }
  const field = (name: keyof typeof draft, value: string) => { setDraft(old => ({ ...old, [name]: value, ...(name === 'companyId' ? { personId: '' } : {}) })); setState('idle'); };
  async function save(event: FormEvent) {
    event.preventDefault();
    const value = Number(draft.value);
    const changes = type === 'company' ? { name: draft.name, domain: draft.domain, description: draft.description }
      : type === 'person' ? { name: draft.name, email: draft.email, companyId: draft.companyId }
      : type === 'deal' ? { name: draft.name, companyId: draft.companyId, personId: draft.personId, stage: draft.stage, owner: draft.owner, valueCents: Number.isFinite(value) ? Math.round(value * 100) : null, currency: draft.currency, lostReason: draft.lostReason }
      : { body: draft.body };
    setState('pending'); setMessage('Saving…');
    try {
      const response = await fetch('/api/crm', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ type, id: record.id, version: baseVersion, ...changes }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save this record.');
      setBaseVersion(result.version); setState('saved'); setMessage('Saved.');
      await onSaved();
    } catch (error) { setState('error'); setMessage(error instanceof Error ? error.message : 'Could not save this record.'); }
  }
  return <><AttioButton leadingIcon="note" onClick={openEditor}>Edit {type}</AttioButton><Dialog open={editing} onClose={()=>setEditing(false)} title={`Edit ${type}`}><form className="record-editor" onSubmit={save}>

    {type !== 'note' && <label className="field">Name<input required maxLength={120} disabled={!canWrite || state === 'pending'} value={draft.name} onChange={e => field('name', e.target.value)} /></label>}
    {type === 'company' && <><label className="field">Domain<input maxLength={253} disabled={!canWrite || state === 'pending'} value={draft.domain} onChange={e => field('domain', e.target.value)} /></label><label className="field">Description<input maxLength={500} disabled={!canWrite || state === 'pending'} value={draft.description} onChange={e => field('description', e.target.value)} /></label></>}
    {type === 'person' && <><label className="field">Email<input type="email" maxLength={254} disabled={!canWrite || state === 'pending'} value={draft.email} onChange={e => field('email', e.target.value)} /></label><label className="field">Company<select disabled={!canWrite || state === 'pending'} value={draft.companyId} onChange={e => field('companyId', e.target.value)}>{companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label></>}
    {type === 'deal' && <><label className="field">Company<select disabled={!canWrite || state === 'pending'} value={draft.companyId} onChange={e => field('companyId', e.target.value)}>{companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label><label className="field">Person<select required disabled={!canWrite || state === 'pending'} value={draft.personId} onChange={e => field('personId', e.target.value)}><option value="">Choose person</option>{people.filter(person => String(person.companyId) === draft.companyId).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><label className="field">Stage<select disabled={!canWrite || state === 'pending'} value={draft.stage} onChange={e => field('stage', e.target.value)}>{STAGES.map(stage => <option key={stage}>{stage}</option>)}</select></label>{draft.stage === 'Lost' && <label className="field">Lost reason<input required maxLength={500} disabled={!canWrite || state === 'pending'} value={draft.lostReason} onChange={e => field('lostReason', e.target.value)} /></label>}<label className="field">Owner<input required maxLength={80} disabled={!canWrite || state === 'pending'} value={draft.owner} onChange={e => field('owner', e.target.value)} /></label><label className="field">Value in currency units<input required type="number" min="0" max="21474836.47" step="0.01" disabled={!canWrite || state === 'pending'} value={draft.value} onChange={e => field('value', e.target.value)} /></label><label className="field">Currency<select disabled={!canWrite || state === 'pending'} value={draft.currency} onChange={e => field('currency', e.target.value)}>{CURRENCIES.map(currency => <option key={currency}>{currency}</option>)}</select></label></>}
    {type === 'note' && <label className="field">Note<textarea required maxLength={2000} disabled={!canWrite || state === 'pending'} value={draft.body} onChange={e => field('body', e.target.value)} /></label>}
    {canWrite && <><button className="primary" disabled={state === 'pending' || reviewing}>{state === 'pending' ? 'Saving…' : 'Save changes'}</button>{state === 'error' && <button type="button" className="textlink" disabled={reviewing} onClick={()=>void reviewLatest()}>{reviewing ? 'Loading latest…' : 'Load latest version, keep draft'}</button>}</>}
    {message && <p role={state === 'error' ? 'alert' : 'status'} className={state === 'error' ? 'alert' : 'muted'}>{message}</p>}
    {reviewed && <section className="record-review" aria-label="Latest saved values"><h3>Latest saved values</h3><dl>
      {type === 'note' ? <><dt>Note</dt><dd>{reviewed.body}</dd></> : <><dt>Name</dt><dd>{reviewed.name}</dd></>}
      {type === 'company' && <><dt>Domain</dt><dd>{reviewed.domain || 'Not set'}</dd><dt>Description</dt><dd>{reviewed.description || 'Not set'}</dd></>}
      {type === 'person' && <><dt>Email</dt><dd>{reviewed.email || 'Not set'}</dd></>}
      {(type === 'person' || type === 'deal') && <><dt>Company</dt><dd>{companies.find(item=>item.id===reviewed.companyId)?.name || 'Unavailable'}</dd></>}
      {type === 'deal' && <><dt>Person</dt><dd>{people.find(item=>item.id===reviewed.personId)?.name || 'Unavailable'}</dd><dt>Stage</dt><dd>{reviewed.stage}</dd><dt>Owner</dt><dd>{reviewed.owner}</dd><dt>Value</dt><dd>{new Intl.NumberFormat('en-US',{style:'currency',currency:reviewed.currency || 'USD'}).format((reviewed.valueCents || 0)/100)}</dd>{reviewed.lostReason && <><dt>Lost reason</dt><dd>{reviewed.lostReason}</dd></>}</>}
    </dl></section>}
  </form></Dialog></>;
}

export function RecordHistory({ type, id, version, workspaceId }: { type: RecordType; id: number; version: number; workspaceId: string }) {
  const [items, setItems] = useState<{ id: number; actorEmail: string; changes: Record<string, { from: string | number | null; to: string | number | null }>; changedAt: string }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; setItems([]); fetch(`/api/records/history?type=${type}&id=${id}`, { headers: { 'x-workspace-id': workspaceId }, cache: 'no-store' }).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not load changes.'); if (active) { setItems(result.changes); setError(''); } }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load changes.'); }); return () => { active = false; }; }, [type, id, version, workspaceId]);
  return <details className="record-history disclosure"><summary>Change history</summary>{error && <p role="alert">{error}</p>}{items.length ? items.map(item => <div className="activityitem" key={item.id}><small>{item.actorEmail} · {new Date(item.changedAt).toLocaleString()}</small>{Object.entries(item.changes).map(([field, change]) => <p key={field}>{field}: {String(change.from ?? 'empty')} → {String(change.to ?? 'empty')}</p>)}</div>) : !error && <p className="muted">No edits recorded yet.</p>}</details>;
}
