import { appStore, terrainContainer } from './store';
import type { BattleDeployment, BattleEdit, BattleSource, BattleUnit } from './battle-contract';
import type { UnitEditBatch, UnitEditTarget } from './field-battle-types';
import { applyBattleEdits } from './battle-actions';

/**
 * 主地图单位编辑目标（FB-E）
 * 供兵牌生成与自定义设计器（garrison-panel）读写主地图部队数据。
 */
export function createMapUnitEditTarget(): UnitEditTarget {
  return {
    getUnits(): readonly BattleUnit[] {
      return appStore.garrisons;
    },
    getDeployments(): readonly BattleDeployment[] {
      return appStore.battle.deployments;
    },
    getSources(): readonly BattleSource[] {
      return appStore.battle.sources;
    },
    commit(batch: UnitEditBatch): void {
      if (!appStore.mapId) {
        throw new Error('尚未导入地图，无法部署或修改主地图部队');
      }
      if (batch.deployments.removeByUnitId && batch.deployments.removeByUnitId.length > 0) {
        throw new Error('主地图不支持单独删除部署 (removeByUnitId)');
      }

      const edits: BattleEdit[] = [];
      if (batch.sources?.upsert) {
        for (const source of batch.sources.upsert) {
          edits.push({ kind: 'upsert-source', source });
        }
      }
      if (batch.units?.upsert) {
        for (const unit of batch.units.upsert) {
          edits.push({ kind: 'upsert-unit', unit: unit as BattleUnit });
        }
      }
      if (batch.units?.remove) {
        for (const unitId of batch.units.remove) {
          edits.push({ kind: 'remove-unit', unitId });
        }
      }
      if (batch.deployments?.upsert) {
        for (const deployment of batch.deployments.upsert) {
          edits.push({ kind: 'set-deployment', deployment });
        }
      }

      const label = batch.units.upsert.length > 0
        ? `更新部队 [${batch.units.upsert[0].unitName.state === 'known' ? batch.units.upsert[0].unitName.value : batch.units.upsert[0].id}] 兵牌与编制`
        : '兵牌设计器编辑';

      applyBattleEdits({
        label,
        origin: 'manual',
        candidateItemIds: [],
        edits,
      });
    },
    newUnitCenter(): [number, number] {
      const parent = terrainContainer.parent;
      if (!parent) return [0, 0];
      const w = typeof innerWidth !== 'undefined' ? innerWidth : 800;
      const h = typeof innerHeight !== 'undefined' ? innerHeight : 600;
      const point = parent.toLocal({ x: w / 2, y: h / 2 });
      return [point.x, point.y];
    },
  };
}
