import { CURRENCIES, STAGES } from './crm';
import { LIST_COLUMNS, LIST_STAGES, type ListViewConfig } from './lists';
export type ViewField = { key: string; label: string; kind: string; options: string[]; archived: boolean };
export type ViewCondition = { field: string; operator: string; value?: string | number | boolean };
export type BusinessEntry = { id: string; recordId: number; stage: string; note: string | null; createdAt: string | Date; record: { id: number; name: string; stage?: string; owner?: string; currency?: string; valueCents?: number; customValues?: Record<string, string | number | boolean> } };
export type CustomDefinition = { id: string; name: string; kind: string; options: string[]; archivedAt: Date | string | null };
export function businessFields(custom: CustomDefinition[]): ViewField[] {
 return [{ key: 'name', label: 'Name', kind: 'text', options: [], archived: false }, { key: 'canonicalStage', label: 'Deal pipeline stage', kind: 'single_select', options: [...STAGES], archived: false }, { key: 'owner', label: 'Owner label', kind: 'text', options: [], archived: false }, { key: 'currency', label: 'Currency', kind: 'single_select', options: [...CURRENCIES], archived: false }, { key: 'value', label: 'Deal value', kind: 'number', options: [], archived: false }, ...custom.map(f => ({ key: 'custom:'+f.id, label: f.name, kind: f.kind, options: f.options, archived: !!f.archivedAt }))];
}
export function operators(field: ViewField) { return ['isEmpty','isSet','eq','neq', ...(['number','date'].includes(field.kind) ? ['gt','gte','lt','lte'] : ['checkbox','single_select'].includes(field.kind) ? [] : ['contains'])]; }
export const operatorLabels: Record<string,string> = { isEmpty:'is empty', isSet:'is set', eq:'equals', neq:'does not equal', contains:'contains', gt:'greater than', gte:'at least', lt:'less than', lte:'at most' };
export function normalizeViewConfig(value: unknown, objectType: string, fields: ViewField[]): ListViewConfig {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Choose valid view settings.'); const v=value as Record<string,unknown>;
 if (v.filterStage!==''&&!LIST_STAGES.includes(v.filterStage as typeof LIST_STAGES[number])) throw Error('Choose a valid list-stage filter.');
 const extended=v.version===2||v.filters!==undefined||v.direction!==undefined;
 if (v.version!==undefined&&v.version!==2) throw Error('Unsupported view version.');
 const allowed=new Map(fields.map(f=>[f.key,f])); const usable=(key: unknown) => { if(typeof key!=='string'||!allowed.has(key)||allowed.get(key)!.archived) throw Error(`Unavailable view field: ${typeof key==='string'?(allowed.get(key)?.label||key):'unknown'}. Remove the archived or unavailable field to continue.`);return allowed.get(key)!; };
 if (!Array.isArray(v.columns)||!v.columns.length||v.columns.length>(extended?12:LIST_COLUMNS.length)||new Set(v.columns).size!==v.columns.length||!v.columns.includes('name')) throw Error('Choose up to12 distinct columns including Name.');
 for(const key of v.columns)if(!LIST_COLUMNS.includes(key as typeof LIST_COLUMNS[number])) { if(!extended||objectType!=='deal')throw Error('Choose valid columns.');usable(key); }
 if(typeof v.sort!=='string')throw Error('Choose a sort.');
 if(!['name','stage','newest'].includes(v.sort)){if(!extended||objectType!=='deal')throw Error('Choose a valid sort.');usable(v.sort);}
 if(!extended)return {filterStage:v.filterStage as string,sort:v.sort,columns:v.columns as string[]};
 if(objectType!=='deal')throw Error('Business filters are available on deal lists.');
 if(v.direction!==undefined&&!['asc','desc'].includes(v.direction as string))throw Error('Choose ascending or descending.');
 if(v.filters!==undefined&&(!Array.isArray(v.filters)||v.filters.length>8))throw Error('Use up to8 AND conditions.');
 const filters:ViewCondition[]=[];
 for(const raw of (v.filters||[]) as unknown[]){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Choose valid conditions.');const b=raw as Record<string,unknown>,field=usable(b.field);
  if(typeof b.operator!=='string'||!operators(field).includes(b.operator))throw Error(`Choose a supported operator for ${field.label}.`);
  const condition:ViewCondition={field:field.key,operator:b.operator};
  if(!['isEmpty','isSet'].includes(b.operator)){
   const val=b.value;
   if(field.kind==='number'){if(typeof val!=='number'||!Number.isFinite(val)||Math.abs(val)>1e12)throw Error(`${field.label} needs a finite number within1 trillion.`);}
   else if(field.kind==='checkbox'){if(typeof val!=='boolean')throw Error(`${field.label} needs true or false.`);}
   else {if(typeof val!=='string'||!val.trim()||val.length>500)throw Error(`${field.label} needs a value.`);if(field.kind==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(val)||!Number.isFinite(Date.parse(val+'T00:00:00Z'))||new Date(val+'T00:00:00Z').toISOString().slice(0,10)!==val))throw Error('Choose a valid calendar date.');if(field.kind==='single_select'&&!field.options.includes(val))throw Error(`Choose a saved option for ${field.label}.`);}
   condition.value=typeof val==='string'?val.trim():val as number|boolean;
  }
  filters.push(condition);
 }
 const currencies=filters.filter(f=>f.field==='currency'&&f.operator==='eq');
 if((v.sort==='value'||filters.some(f=>f.field==='value'&&!['isEmpty','isSet'].includes(f.operator)))&&currencies.length!==1)throw Error('Filter Currency equals one currency before comparing or sorting deal values.');
 // Custom columns/sorts must also be active, including previously saved configurations after archival.
 for(const key of v.columns)if(typeof key==='string'&&key.startsWith('custom:'))usable(key);
 return {version:2,filterStage:v.filterStage as string,sort:v.sort,columns:v.columns as string[],direction:(v.direction||'asc') as 'asc'|'desc',filters};
}
export function fieldValue(entry: BusinessEntry,key:string): string|number|boolean|null {
 if(key==='name')return entry.record.name;if(key==='stage')return entry.stage;if(key==='note')return entry.note;
 if(key==='canonicalStage')return entry.record.stage??null;
 if(key==='value')return entry.record.valueCents===undefined?null:entry.record.valueCents/100;
 if(key.startsWith('custom:'))return entry.record.customValues?.[key.slice(7)]??null;
 return key==='owner'?entry.record.owner??null:key==='currency'?entry.record.currency??null:null;
}
export function displayField(entry: BusinessEntry,key:string){const value=fieldValue(entry,key);if(value===null||value==='')return '—';if(typeof value==='boolean')return value?'Yes':'No';if(key==='value')return new Intl.NumberFormat('en-US',{style:'currency',currency:entry.record.currency||'USD'}).format(Number(value));return String(value);}
export function evaluateView(entries: BusinessEntry[],config:ListViewConfig,fields:ViewField[],objectType='deal'):{rows:BusinessEntry[];issues:string[]}{
 let c:ListViewConfig;try{c=normalizeViewConfig(config,objectType,fields);}catch(e){return {rows:[],issues:[e instanceof Error?e.message:'Saved view unavailable.']};}
 const compare=(a:string|number|boolean,b:string|number|boolean)=>typeof a==='string'&&typeof b==='string'?a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()):a===b?0:a>b?1:-1;
 const matches=(row:BusinessEntry,f:ViewCondition)=>{const val=fieldValue(row,f.field),missing=val===null||val==='';if(f.operator==='isEmpty')return missing;if(f.operator==='isSet')return !missing;if(missing)return false;const cmp=compare(val!,f.value!);return f.operator==='eq'?cmp===0:f.operator==='neq'?cmp!==0:f.operator==='contains'?String(val).toLocaleLowerCase().includes(String(f.value).toLocaleLowerCase()):f.operator==='gt'?cmp>0:f.operator==='gte'?cmp>=0:f.operator==='lt'?cmp<0:cmp<=0;};
 const rows=entries.filter(e=>(!c.filterStage||e.stage===c.filterStage)&&(c.filters||[]).every(f=>matches(e,f)));
 rows.sort((a,b)=>{const av=c.sort==='newest'?new Date(a.createdAt).toISOString():fieldValue(a,c.sort),bv=c.sort==='newest'?new Date(b.createdAt).toISOString():fieldValue(b,c.sort);const am=av===null||av==='',bm=bv===null||bv==='';if(am!==bm)return am?1:-1;let cmp=am?0:compare(av!,bv!);if(c.sort==='newest')cmp=-cmp;if(c.direction==='desc')cmp=-cmp;return cmp||a.record.name.localeCompare(b.record.name)||a.id.localeCompare(b.id);});return {rows,issues:[]};
}
