import type { MapData } from './store';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** FMG 1.x / 2.x 的原始段；数据段布局与加载器口径一致。不从精简的渲染对象猜造未加载的数据。 */
export function originalMapRecords(map: MapData): string[] {
  if (map.source.originalMap === undefined) {
    throw new Error(`战区“${map.source.name}”来自旧缓存，请重新导入该战区原始 .map 补齐原文后导出；现有编辑会保留`);
  }
  const records = map.source.originalMap.split('\r\n');
  if (!/^[12]\.\d+(?:\.\d+)*(?:-[^|]+)?\|/.test(records[0]) || records.length < 33) {
    throw new Error('仅支持当前加载器的 FMG 1.x / 2.x 存档格式');
  }
  return records;
}

/** 返回标准 .map 文本。兵牌与战线使用工程 JSON 保存。 */
export function serializeMap(map: MapData): string {
  if (map.source.baseKind === 'image') {
    throw new Error('当前战区基于静态图片底图创建，不支持导出为 FMG .map；请点击「导出推演工程」完整保存版图、修补笔划与兵牌');
  }
  const records = originalMapRecords(map);
  const { cells } = map;
  const storedCount = records[25].split(',').length;
  if (storedCount !== cells.count || cells.state.length !== storedCount || cells.province.length !== storedCount) {
    throw new Error('地块数与原图不一致，不能按原编号导出 .map');
  }
  const gridHeights = records[7].split(',').map(Number);
  if (cells.h.some((height, cell) => height !== gridHeights[cells.g[cell]])) {
    throw new Error('当前含细地块高度修改，无法无损反写 FMG 粗网格；请使用“导出推演工程”完整保存');
  }

  const states = JSON.parse(records[14]) as Record<string, any>[];
  const provinces = JSON.parse(records[30]) as Array<Record<string, any> | 0>;
  const burgs = JSON.parse(records[15]) as Record<string, any>[];
  const cultures = records[19].split(',').map(Number);
  const features = records[9].split(',').map(Number);
  const cellBurgs = new Uint16Array(cells.count);
  const burgIds = new Set<number>();

  // 实体数组以 i 为下标，保留已删除槽位及不在沙盘模型中的原生字段。
  for (const state of map.states) {
    const old = states[state.i];
    const isFresh = !old || typeof old !== 'object' || old.removed;
    const native = isFresh ? { diplomacy: [], provinces: [], military: [], type: 'Generic', culture: 0 } : old;
    const merged: Record<string, any> = { ...native, ...state };
    if (!state.removed) delete merged.removed;
    states[state.i] = merged;
    if (isFresh || old.fullName === old.name) states[state.i].fullName = state.name;
  }
  for (const province of map.provinces) {
    const { centerCell, x, y, ...fields } = province;
    const old = provinces[province.i];
    const base = !old || typeof old !== 'object' || old.removed ? { formName: 'Province' } : old;
    const merged: Record<string, any> = { ...base, ...fields, center: centerCell, pole: [x, y] };
    if (!province.removed) delete merged.removed;
    provinces[province.i] = merged;
  }
  for (const burg of map.burgs) {
    if (!Number.isInteger(burg.i) || burg.i <= 0 || burg.i > 65535 || burgIds.has(burg.i) ||
        !Number.isInteger(burg.cell) || burg.cell < 0 || burg.cell >= cells.count ||
        !Number.isFinite(burg.x) || !Number.isFinite(burg.y) || !Number.isFinite(burg.population)) {
      throw new Error(`城市 ${burg.i} 的编号、地块或坐标无效，无法导出`);
    }
    burgIds.add(burg.i);
    if (!burg.removed && cellBurgs[burg.cell] !== 0) {
      throw new Error(`城市 ${burg.i} 与 ${cellBurgs[burg.cell]} 位于同一地块；FMG 每格只能有一座城市，请先移开其中一座`);
    }
    const { tier, province, ...fields } = burg;
    const old = burgs[burg.i];
    const native = !old || typeof old !== 'object' || old.removed ? {
      culture: cultures[burg.cell], feature: features[cells.g[burg.cell]], type: 'Generic',
      temple: 0, citadel: 0, plaza: 0, walls: 0, shanty: 0,
    } : old;
    const merged: Record<string, any> = { ...native, ...fields, group: burg.capital ? 'cities' : 'towns' };
    if (!burg.removed) delete merged.removed;
    burgs[burg.i] = merged;
    if (!burg.removed) cellBurgs[burg.cell] = burg.i;
  }
  // 新实体可能越过原图末尾的已删除索引；显式 tombstone 是 FMG 槽位格式。
  for (const entities of [states, provinces, burgs]) {
    for (let i = 0; i < entities.length; i++) {
      if (entities[i] === undefined) entities[i] = { i, removed: true };
    }
  }
  for (const state of map.states) {
    states[state.i].provinces = map.provinces.filter(p => !p.removed && p.state === state.i).map(p => p.i);
    states[state.i].burgs = map.burgs.filter(b => !b.removed && b.state === state.i).length;
    states[state.i].urban = map.burgs.filter(b => !b.removed && b.state === state.i).reduce((sum, b) => sum + b.population, 0);
  }
  records[14] = JSON.stringify(states);
  records[15] = JSON.stringify(burgs);
  records[17] = cellBurgs.join(',');
  records[25] = cells.state.join(',');
  records[26] = cells.religion.join(',');
  records[27] = cells.province.join(',');
  records[30] = JSON.stringify(provinces);
  records[5] = serializeSvg(records[5], map);
  return records.join('\r\n');
}

function serializeSvg(source: string, map: MapData): string {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('原始地图 SVG 无效，无法导出可编辑的 FMG 地图');
  const element = (tag: string, attrs: Record<string, string | number>) => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    return node;
  };
  const stateLabels = doc.querySelector('#labels > #states');
  if (stateLabels) {
    stateLabels.replaceChildren();
    for (const state of map.states) {
      if (!state.i || state.removed || state.pole === undefined) continue;
      const pathId = `textPath_stateLabel${state.i}`;
      doc.getElementById(pathId)?.remove();
      doc.querySelector('defs')!.appendChild(element('path', { id: pathId,
        d: `M${state.pole[0] - 100},${state.pole[1]}h200` }));
      const label = element('text', { id: `stateLabel${state.i}`, 'data-id': state.i, 'text-anchor': 'middle' });
      const textPath = element('textPath', { href: `#${pathId}`, startOffset: '50%' });
      textPath.textContent = state.name;
      label.appendChild(textPath);
      stateLabels.appendChild(label);
    }
  }
  // 原生版本/自定义地图的可选图层可不存在；这里只更新原图已有的图层。
  for (const id of ['burgIcons', 'burgLabels', 'anchors']) {
    const layer = doc.getElementById(id);
    if (!layer) continue;
    for (const node of Array.from(layer.querySelectorAll('[data-id]'))) node.remove();
    for (const burg of map.burgs) {
      if (burg.removed || (id === 'anchors' && !burg.port)) continue;
      const groupName = burg.capital ? 'cities' : 'towns';
      let group = layer.querySelector(`[id="${groupName}"]`);
      if (!group) {
        group = element('g', { id: groupName });
        layer.appendChild(group);
      }
      if (id === 'burgLabels') {
        const label = element('text', { id: `burgLabel${burg.i}`, 'data-id': burg.i, x: burg.x, y: burg.y, dy: '-1px' });
        label.textContent = burg.name;
        group.appendChild(label);
      } else if (id === 'burgIcons') {
        const size = group.getAttribute('size');
        const icon = size === null
          ? element('use', { href: '#icon-circle', x: burg.x, y: burg.y })
          : element('circle', { cx: burg.x, cy: burg.y, r: size });
        icon.setAttribute('id', `burg${burg.i}`);
        icon.setAttribute('data-id', String(burg.i));
        group.appendChild(icon);
      } else {
        group.appendChild(element('use', { id: `anchor${burg.i}`, 'data-id': burg.i,
          href: '#icon-anchor', x: burg.x - 0.5, y: burg.y - 0.5, width: 1, height: 1 }));
      }
    }
  }

  const paths = (owners: Uint16Array) => {
    const byOwner = new Map<number, string[]>();
    for (let cell = 0; cell < map.cells.count; cell++) {
      const owner = owners[cell];
      if (!owner || map.cells.h[cell] < 20) continue;
      const polygon = map.cells.polygons[cell];
      const path = `M${polygon.map(point => point.join(',')).join('L')}Z`;
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner)!.push(path);
    }
    return byOwner;
  };
  for (const [id, owners, entities, prefix] of [
    ['statesBody', map.cells.state, map.states, 'state'],
    ['provs', map.cells.province, map.provinces, 'province'],
  ] as const) {
    const layer = doc.getElementById(id);
    if (!layer) continue;
    layer.replaceChildren();
    const byOwner = paths(owners);
    for (const entity of entities) {
      if (entity.removed || !byOwner.has(entity.i)) continue;
      layer.appendChild(element('path', { id: `${prefix}${entity.i}`, 'data-id': entity.i,
        d: byOwner.get(entity.i)!.join(''), fill: entity.color, stroke: 'none' }));
    }
  }
  // 边界由共享多边形边的两侧归属确定，不把每格内部轮廓画成边界。
  const edges = new Map<string, { state: number; province: number }>();
  const stateEdges: string[] = [];
  const provinceEdges: string[] = [];
  const pointKey = (p: number[]) => p.map(n => n.toFixed(5)).join(',');
  for (let cell = 0; cell < map.cells.count; cell++) {
    if (map.cells.h[cell] < 20) continue;
    const polygon = map.cells.polygons[cell];
    for (let j = 0; j < polygon.length; j++) {
      const a = polygon[j], b = polygon[(j + 1) % polygon.length];
      const key = [pointKey(a), pointKey(b)].sort().join('|');
      const previous = edges.get(key);
      const state = map.cells.state[cell], province = map.cells.province[cell];
      if (previous) {
        const path = `M${a.join(',')}L${b.join(',')}`;
        if (previous.state !== state) stateEdges.push(path);
        else if (previous.province !== province) provinceEdges.push(path);
      } else edges.set(key, { state, province });
    }
  }
  for (const [id, segments] of [['stateBorders', stateEdges], ['provinceBorders', provinceEdges]] as const) {
    doc.getElementById(id)?.replaceChildren(element('path', { d: segments.join(''), fill: 'none' }));
  }
  doc.getElementById('statesHalo')?.replaceChildren();
  return new XMLSerializer().serializeToString(doc).replace(/\r?\n/g, '\n');
}

/** 下载入口；一个用户操作对应一个 Blob URL，交给浏览器后释放。 */
export function downloadText(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 工程可含多张地图，浏览器写入大 Blob 可能超过 1 秒；过早回收会取消下载。
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
