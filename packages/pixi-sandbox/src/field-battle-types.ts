import type { Application, Container } from 'pixi.js';
import type { BattleDeployment, BattleSource, BattleUnit } from './battle-contract';
import type { BurgTier } from './store';

export type FieldRing = [number, number][];
export interface FieldPolygonPart { outer: FieldRing; holes: FieldRing[] }
export interface FieldStrokeStyle { color: string; width: number; alpha: number }

export interface FieldTerrainSnapshot {
  displayOutline: FieldPolygonPart[];
  battleOutline: FieldPolygonPart[];
  contextOutline: FieldPolygonPart[];
  cells: { polygon: FieldRing; color: string; context: boolean }[];
  coastBands: { parts: FieldPolygonPart[]; color: string; alpha: number }[];
  lakes: { parts: FieldPolygonPart[]; color: string }[];
  rivers: { parts: FieldPolygonPart[]; color: string; alpha: number }[];
  coastlines: { lines: { points: FieldRing; closed: boolean }[]; style: FieldStrokeStyle }[];
  contours: { lines: { points: FieldRing; closed: boolean }[]; style: FieldStrokeStyle }[];
  burgs: { name: string; x: number; y: number; tier: BurgTier }[];
}

export type FieldUnit = BattleUnit & { sourceUnitId: string };
export type FieldBadgeStyle = 'standard' | 'compact' | 'minimal';

export interface FieldBattle {
  id: string;
  name: string;
  createdAt: string;
  cellIds: number[];
  anchor: [number, number];
  bounds: { x: number; y: number; width: number; height: number };
  terrain: FieldTerrainSnapshot;
  units: FieldUnit[];
  deployments: BattleDeployment[];
  sources: BattleSource[];
  badgeStyle: FieldBadgeStyle;
  badgeScale: number;
  view?: { scale: number; x: number; y: number };
}

export interface UnitEditBatch {
  units: { upsert: FieldUnit[] | BattleUnit[]; remove: string[] };
  deployments: { upsert: BattleDeployment[]; removeByUnitId: string[] };
  sources: { upsert: BattleSource[] };
}

export interface UnitEditTarget {
  getUnits(): readonly BattleUnit[];
  getDeployments(): readonly BattleDeployment[];
  getSources(): readonly BattleSource[];
  commit(batch: UnitEditBatch): void;
  newUnitCenter(): [number, number];
}

export interface FieldBattleSceneContext {
  app: Application;
  host: Container;
  battle: FieldBattle;
  root: HTMLElement;
  onChange(kind: 'units' | 'style' | 'view'): void;
  onRequestClose(): void;
}

export interface FieldBattleSceneHandle {
  destroy(): void;
  saveView(): { scale: number; x: number; y: number } | undefined;
}

export interface ViewportChanged {
  scale: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FieldBattleChange {
  battleId: string;
  kind: 'create' | 'rename' | 'delete' | 'units' | 'style' | 'view';
}

export const FIELD_BATTLE_DOM = {
  viewToggle: '#view-toggle-field-battles',
  tacticalAdd: '#tactical-add-fieldbattle',
  paintPanel: '#fieldbattle-paint-panel',
  paintName: '#fieldbattle-paint-name',
  paintCount: '#fieldbattle-paint-count',
  generate: '#fieldbattle-generate',
  clear: '#fieldbattle-clear',
  cancel: '#fieldbattle-cancel',
  button: '.fieldbattle-button[data-battle-id]',
  menu: '#fieldbattle-menu',
  window: '#field-battle-window',
  title: '#field-battle-title',
  minimize: '#field-battle-minimize',
  content: '#field-battle-content',
  toolbar: '#field-battle-toolbar',
  style: '#field-battle-style',
  scale: '#field-battle-scale',
  newUnit: '#field-battle-new-unit',
  delete: '#field-battle-delete',
  designer: '#garrison-custom-modal',
} as const;
