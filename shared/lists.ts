export const LIST_STAGES = ['New', 'In progress', 'Done'] as const;
export const LIST_COLUMNS = ['name', 'stage', 'note', 'canonicalStage'] as const;
export type ListViewConfig = { filterStage: string; sort: string; columns: string[]; version?:2; filters?:import('./list-business-views').ViewCondition[]; direction?:'asc'|'desc' };
export const DEFAULT_VIEW: ListViewConfig = { filterStage: '', sort: 'name', columns: ['name', 'stage', 'note'] };
