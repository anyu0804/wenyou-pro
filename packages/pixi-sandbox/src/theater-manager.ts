import { appStore, type MapData } from './store';
import { parseWorkingMap } from './map-loader';
import {
  buildImageHexMapData,
  computeHexRadiusForPreset,
  createImageBaseSpec,
  probeImageDimensions,
  serializeImageBaseSpecFromMap,
  type ImageGridPreset,
} from './image-map-builder';
import { captureTheater, clearAllTheaters, deleteTheater, isBaseReplacementPending, listTheaters, readActiveTheater, readTheater, replaceBaseOnNextSave, saveTheater, saveTheaters, type TheaterState } from './theater-cache';
import { setInputOwner } from './input-owner';
import { downloadText, serializeMap } from './map-serializer';
import { parseProject, serializeProject } from './project-serializer';
import { emptyBattleState } from './battle-storage';
import { resetBattleHistory } from './battle-actions';

export interface BridgeProjectResult {
  activeMapId: string | null;
  mapName: string | null;
  theaterCount: number;
}

export interface BridgeProjectExportResult extends BridgeProjectResult {
  projectJson: string;
}

export interface BridgeCreateImageTheaterPayload {
  name: string;
  imageUrl: string;
  imageRelPath?: string;
  gridPreset?: ImageGridPreset;
  mapWidthKm?: number;
  width?: number;
  height?: number;
}

export interface BridgeImageTheaterResult {
  activeMapId: string;
  mapName: string;
  cellCount: number;
  kmPerPixel?: number;
  theaterCount: number;
}

const IMAGE_FILE_RE = /\.(png|jpe?g|webp|svg|gif|bmp)$/i;

function isImageFile(file: File): boolean {
  return IMAGE_FILE_RE.test(file.name) || file.type.startsWith('image/');
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result.startsWith('data:')) {
        resolve(reader.result);
      } else {
        reject(new Error('无法将图片读取为 Data URL'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取本地图片失败'));
    reader.readAsDataURL(file);
  });
}

interface SwitcherHooks {
  waitSaving: () => Promise<void>;
  clearSaveTimer: () => void;
  markSaved: () => void;
  setBusy: (busy: boolean) => void;
  refreshUi: (statusText?: string) => Promise<void>;
}

let switcherHooks: SwitcherHooks | null = null;

function newTheater(mapData: MapData): TheaterState {
  return {
    version: 4, mapData, garrisons: [], battle: emptyBattleState(), fieldBattles: [], tacticalItems: [],
  };
}

function ensureValidActiveState(mapData: MapData): void {
  const hasCurrent = mapData.states.some((state) => state.i === appStore.activeStateId && state.i > 0 && !state.removed);
  if (hasCurrent) return;
  const fallback = mapData.states.find((state) => state.i > 0 && !state.removed);
  appStore.activeStateId = fallback ? fallback.i : 0;
}

function publishTheater(state: TheaterState): void {
  appStore.mapData = state.mapData;
  appStore.mapId = state.mapData.source.mapId;
  appStore.garrisons = state.garrisons;
  appStore.battle = state.battle;
  appStore.fieldBattles = state.fieldBattles;
  resetBattleHistory();
  appStore.tacticalItems = state.tacticalItems;
  appStore.selectedTacticalId = null;
  appStore.selectedBurgId = null;
  appStore.interactionMode = 'pan';
  ensureValidActiveState(state.mapData);
  // 数据全部就位后才通知渲染器。旧显示对象可释放，业务数据已持久化。
  appStore.emit('map:loaded', state.mapData);
  appStore.emit('tactical-mode-change');
  appStore.emit('brush:changed');
  appStore.emit('tactical-change');
}

function publishEmptySandbox(): void {
  appStore.mapData = null;
  appStore.mapId = '';
  appStore.garrisons = [];
  appStore.battle = emptyBattleState();
  appStore.fieldBattles = [];
  resetBattleHistory();
  appStore.tacticalItems = [];
  appStore.selectedTacticalId = null;
  appStore.selectedBurgId = null;
  appStore.interactionMode = 'pan';
  appStore.emit('map:cleared');
  appStore.emit('tactical-mode-change');
  appStore.emit('brush:changed');
  appStore.emit('tactical-change');
}

// 启动不加载任何底图：无已存战区时进入空沙盘，用户导入 .map 后才建区。
export async function restoreInitialTheater(ignoreCache = false): Promise<void> {
  const activeId = await readActiveTheater();
  if (activeId === undefined) return; // 空沙盘：战区栏提示导入，画布保持空白
  if (ignoreCache) {
    // 用户选择忽略损坏缓存：标记该战区，重新导入同一张图时重建缓存，原记录在此之前保持原样
    replaceBaseOnNextSave(activeId);
    return;
  }
  const saved = await readTheater(activeId);
  if (saved === undefined) throw new Error('上次打开战区的缓存不存在，请先导出原始缓存');
  publishTheater(saved);
}

/** 供宿主桥接重置为空沙盘：清空当前工作区隔离缓存并恢复空态。 */
export async function resetSandboxFromBridge(): Promise<void> {
  if (appStore.isSwitchingMap) {
    throw new Error('正在切换战区，请稍后再重置沙盘');
  }
  appStore.isSwitchingMap = true;
  switcherHooks?.setBusy(true);
  try {
    appStore.emit('theater:leaving');
    switcherHooks?.clearSaveTimer();
    await switcherHooks?.waitSaving();
    await clearAllTheaters();
    publishEmptySandbox();
    switcherHooks?.markSaved();
    await switcherHooks?.refreshUi('空沙盘：点击「导入 .map」或「导入图片建图」，也可直接拖入文件开始');
  } finally {
    appStore.isSwitchingMap = false;
    switcherHooks?.setBusy(false);
  }
}

/** 供宿主桥接无弹窗导入推演工程 JSON；共用切换锁与自动暂存边界。 */
export async function importProjectFromBridge(
  projectJson: string,
  options?: { forceOverwrite?: boolean; notifyHost?: boolean },
): Promise<BridgeProjectResult> {
  if (appStore.isSwitchingMap) {
    throw new Error('正在切换战区，请稍后再导入推演工程');
  }
  const project = parseProject(projectJson);
  const forceOverwrite = options?.forceOverwrite !== false;
  const shouldNotifyHost = options?.notifyHost === true;
  appStore.isSwitchingMap = true;
  switcherHooks?.setBusy(true);
  let previous: TheaterState | undefined;
  let publishing = false;
  let succeeded = false;
  try {
    appStore.emit('theater:leaving');
    switcherHooks?.clearSaveTimer();
    await switcherHooks?.waitSaving();
    if (!forceOverwrite) {
      const existing = await listTheaters();
      const conflicts = existing.filter(entry => project.theaters.some(state => state.mapData.source.mapId === entry.mapId));
      if (conflicts.length > 0) {
        throw new Error(`目标战区已存在且未允许覆盖：${conflicts.map(entry => entry.name).join('、')}`);
      }
    }
    if (appStore.mapData !== null) {
      previous = captureTheater();
      await saveTheater(previous);
      switcherHooks?.markSaved();
    }
    const next = project.theaters.find(state => state.mapData.source.mapId === project.activeMapId)!;
    await saveTheaters(project.theaters, project.activeMapId);
    appStore.emit('map:loading');
    publishing = true;
    publishTheater(next);
    switcherHooks?.markSaved();
    const theaters = await listTheaters();
    await switcherHooks?.refreshUi('已从 Wenyou 宿主载入推演工程');
    succeeded = true;
    return {
      activeMapId: appStore.mapId || null,
      mapName: appStore.mapData?.source.name ?? null,
      theaterCount: theaters.length,
    };
  } catch (error) {
    if (publishing && previous !== undefined) publishTheater(previous);
    throw error;
  } finally {
    appStore.isSwitchingMap = false;
    switcherHooks?.setBusy(false);
    if (succeeded && shouldNotifyHost && appStore.mapData !== null) {
      appStore.emit('project:autosaved');
    }
  }
}

/** 供宿主桥接导出全部战区的推演工程 JSON（先完成当前战区落盘）。 */
export async function exportProjectForBridge(): Promise<BridgeProjectExportResult> {
  if (appStore.isSwitchingMap) {
    throw new Error('正在切换战区，请稍后再导出推演工程');
  }
  if (appStore.mapData === null) {
    throw new Error('尚未导入地图，没有可导出的推演工程');
  }
  appStore.isSwitchingMap = true;
  switcherHooks?.setBusy(true);
  try {
    appStore.emit('brush:finish');
    switcherHooks?.clearSaveTimer();
    await switcherHooks?.waitSaving();
    const current = captureTheater();
    await saveTheater(current);
    switcherHooks?.markSaved();
    const theaters = [current];
    for (const entry of await listTheaters()) {
      if (entry.mapId === current.mapData.source.mapId) continue;
      const saved = await readTheater(entry.mapId);
      if (saved === undefined) throw new Error(`战区 ${entry.name} 缺失，工程未导出`);
      theaters.push(saved);
    }
    const projectJson = serializeProject(theaters, current.mapData.source.mapId);
    await switcherHooks?.refreshUi('已向 Wenyou 宿主回传推演工程');
    return {
      projectJson,
      activeMapId: current.mapData.source.mapId,
      mapName: current.mapData.source.name,
      theaterCount: theaters.length,
    };
  } finally {
    appStore.isSwitchingMap = false;
    switcherHooks?.setBusy(false);
  }
}

/** 供宿主桥接无弹窗从图片底图创建/打开战区，共用切换锁与自动暂存边界。 */
export async function createImageTheaterFromBridge(
  payload: BridgeCreateImageTheaterPayload,
): Promise<BridgeImageTheaterResult> {
  if (appStore.isSwitchingMap) {
    throw new Error('正在切换战区，请稍后再创建图片战区');
  }
  if (!payload || typeof payload.imageUrl !== 'string' || !payload.imageUrl.trim()) {
    throw new Error('create_image_theater 缺少有效的 imageUrl');
  }

  // 在异步探测图片尺寸前立即加锁，杜绝探测期间并发重入切换临界区（TOCTOU）
  appStore.isSwitchingMap = true;
  switcherHooks?.setBusy(true);
  let previous: TheaterState | undefined;
  let publishing = false;
  let succeeded = false;
  try {
    const hasExplicitSize =
      typeof payload.width === 'number' &&
      Number.isFinite(payload.width) &&
      payload.width > 0 &&
      typeof payload.height === 'number' &&
      Number.isFinite(payload.height) &&
      payload.height > 0;
    const dims = hasExplicitSize
      ? { width: Math.round(payload.width!), height: Math.round(payload.height!) }
      : await probeImageDimensions(payload.imageUrl);

    const spec = createImageBaseSpec({
      name: payload.name || '图片战区',
      width: dims.width,
      height: dims.height,
      imageUrl: payload.imageUrl,
      imageRelPath: payload.imageRelPath,
      gridPreset: payload.gridPreset ?? 'standard',
      mapWidthKm: payload.mapWidthKm,
    });
    const builtMap = buildImageHexMapData(spec);

    appStore.emit('theater:leaving');
    switcherHooks?.clearSaveTimer();
    await switcherHooks?.waitSaving();
    if (appStore.mapData !== null) {
      previous = captureTheater();
      await saveTheater(previous);
      switcherHooks?.markSaved();
    }
    const existing = await readTheater(builtMap.source.mapId).catch(() => undefined);
    let next: TheaterState;
    if (existing && existing.mapData.source.baseKind === 'image') {
      next = existing;
      next.mapData.source.imageUrl = builtMap.source.imageUrl;
      if (builtMap.source.imageRelPath !== undefined) {
        next.mapData.source.imageRelPath = builtMap.source.imageRelPath;
      }
      if (builtMap.source.mapWidthKm !== undefined) {
        next.mapData.source.mapWidthKm = builtMap.source.mapWidthKm;
        next.mapData.source.kmPerPixel = builtMap.source.kmPerPixel;
      }
      next.mapData.source.originalMap = serializeImageBaseSpecFromMap(next.mapData);
      replaceBaseOnNextSave(next.mapData.source.mapId);
    } else {
      next = newTheater(builtMap);
    }
    await saveTheater(next);
    appStore.emit('map:loading');
    publishing = true;
    publishTheater(next);
    switcherHooks?.markSaved();
    const theaters = await listTheaters();
    await switcherHooks?.refreshUi(`已从图片底图载入战区「${next.mapData.source.name}」（${next.mapData.cells.count} 格）`);
    succeeded = true;
    return {
      activeMapId: next.mapData.source.mapId,
      mapName: next.mapData.source.name,
      cellCount: next.mapData.cells.count,
      ...(next.mapData.source.kmPerPixel !== undefined ? { kmPerPixel: next.mapData.source.kmPerPixel } : {}),
      theaterCount: theaters.length,
    };
  } catch (error) {
    if (publishing && previous !== undefined) publishTheater(previous);
    throw error;
  } finally {
    appStore.isSwitchingMap = false;
    switcherHooks?.setBusy(false);
    if (succeeded && appStore.mapData !== null) {
      appStore.emit('project:autosaved');
    }
  }
}

export function initTheaterSwitcher(root: HTMLElement): void {
  const bar = document.createElement('div');
  bar.id = 'wenyou-theater-bar';
  bar.style.cssText = 'position:fixed;top:12px;left:282px;right:296px;z-index:100;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;background:#0f172aee;border:1px solid #475569;border-radius:8px;font-size:12px;';
  const label = document.createElement('label');
  label.textContent = '战区';
  label.htmlFor = 'theater-select';
  const select = document.createElement('select');
  select.id = 'theater-select';
  select.style.cssText = 'min-width:100px;max-width:36%;background:#1e293b;color:white;border:1px solid #475569;padding:5px;';
  const open = document.createElement('button');
  open.textContent = '导入 .map';
  const openImage = document.createElement('button');
  openImage.id = 'import-image-map';
  openImage.textContent = '导入图片建图';
  openImage.title = '从任意 PNG/JPG/WEBP/SVG 静态地图生成六角推演沙盘';
  const remove = document.createElement('button');
  remove.id = 'delete-theater';
  remove.textContent = '删除战区';
  remove.title = '从浏览器缓存删除当前已载入的战区地图';
  const save = document.createElement('button');
  save.textContent = '暂存当前战区';
  const download = document.createElement('button');
  download.id = 'download-map';
  download.textContent = '下载 .map';
  const exportProject = document.createElement('button');
  exportProject.id = 'export-project';
  exportProject.textContent = '导出推演工程';
  const importProject = document.createElement('button');
  importProject.textContent = '导入工程';
  importProject.title = '恢复文件中的全部战区；相同地图身份覆盖，其他战区保留';
  for (const button of [open, openImage, remove, save, download, exportProject, importProject]) {
    button.type = 'button';
    button.style.cssText = 'background:#1e293b;color:#e2e8f0;border:1px solid #64748b;border-radius:4px;padding:5px 8px;cursor:pointer;white-space:nowrap;';
  }
  openImage.style.borderColor = '#0284c7';
  openImage.style.color = '#bae6fd';
  remove.style.borderColor = '#b91c1c';
  remove.style.color = '#fca5a5';
  const projectInput = document.createElement('input');
  projectInput.id = 'project-file';
  projectInput.type = 'file';
  projectInput.accept = '.json,application/json';
  projectInput.hidden = true;
  const imageInput = document.createElement('input');
  imageInput.id = 'image-map-file';
  imageInput.type = 'file';
  imageInput.accept = '.png,.jpg,.jpeg,.webp,.svg,.gif,.bmp,image/*';
  imageInput.hidden = true;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.map';
  input.hidden = true;
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'color:#94a3b8;min-width:0;overflow-wrap:anywhere;';
  status.textContent = appStore.mapData === null ? '空沙盘：点击「导入 .map」或「导入图片建图」，也可直接拖入文件开始' : '可将 .map、工程 .json 或图片拖入窗口';
  bar.append(label, select, open, openImage, remove, save, download, exportProject, importProject, input, imageInput, projectInput, status);
  bar.addEventListener('pointerdown', () => setInputOwner('map'));
  root.appendChild(bar);

  const blocker = document.createElement('div');
  blocker.style.cssText = 'position:fixed;inset:0;z-index:10001;background:#0d131a66;cursor:progress;display:none;';
  root.appendChild(blocker);
  let saveTimer: number | null = null;
  let pendingHostAutosave = false;
  let revision = 0;
  let savedRevision = 0;
  let saving: Promise<void> | null = null;
  const syncSelect = () => {
    select.value = appStore.mapData === null ? '' : appStore.mapId;
    remove.disabled = appStore.mapData === null;
    remove.style.opacity = remove.disabled ? '0.45' : '1';
    remove.style.cursor = remove.disabled ? 'default' : 'pointer';
  };
  const refresh = async () => {
    const entries = await listTheaters();
    if (appStore.mapData !== null) {
      if (!entries.some((entry) => entry.mapId === appStore.mapId)) {
        entries.push({ mapId: appStore.mapId, name: appStore.mapData.source.name });
      }
      select.replaceChildren(...entries.map((entry) => new Option(entry.name, entry.mapId)));
      select.value = appStore.mapId;
    } else {
      // 空沙盘：历史战区仍可从下拉恢复；禁用占位项防止被选中
      const placeholder = new Option('未加载地图 — 请导入 .map', '');
      placeholder.disabled = true;
      select.replaceChildren(placeholder, ...entries.map((entry) => new Option(entry.name, entry.mapId)));
      select.value = '';
    }
  };

  // 三个入口共用同一切换边界：select、file input、window drop。
  async function transition(target: string | File): Promise<void> {
    if (appStore.isSwitchingMap) {
      syncSelect();
      return;
    }
    if (target === appStore.mapId) return;
    appStore.isSwitchingMap = true;
    blocker.style.display = 'block';
    root.inert = true;
    let previous: TheaterState | undefined; // 空沙盘首次导入时没有可收尾的战区
    let publishing = false;
    let overwroteSameMap = false;
    let deletedToEmpty = false;
    const hadPendingDebounce = saveTimer !== null && pendingHostAutosave;
    let shouldNotifyHost = false;
    try {
      if (typeof target !== 'string' && !/\.(map|json)$/i.test(target.name)) throw new Error('请选择 FMG .map 文件或工程 .json 文件');
      appStore.emit('theater:leaving'); // 收尾当前编辑和视口动画
      await saving; // 正在提交的旧快照先完成，再保存收尾后的状态。
      const hasTheater = appStore.mapData !== null;
      if (target === 'delete-theater') {
        if (!hasTheater) throw new Error('尚未导入地图，没有可删除的战区');
        const currentName = appStore.mapData!.source.name;
        const deletingId = appStore.mapId;
        if (!window.confirm(`确认删除当前战区「${currentName}」？\n\n该战区的地图、兵牌、战线与战场记录将从浏览器缓存永久移除；如需保留请先点击「导出推演工程」。`)) {
          status.textContent = '已取消删除，当前战区已保留';
          return;
        }
        previous = captureTheater();
        const nextId = await deleteTheater(deletingId);
        savedRevision = revision;
        publishing = true;
        if (nextId !== undefined) {
          const next = await readTheater(nextId);
          if (next === undefined) {
            publishEmptySandbox();
            deletedToEmpty = true;
          } else {
            publishTheater(next);
          }
        } else {
          publishEmptySandbox();
          deletedToEmpty = true;
        }
        await refresh();
        shouldNotifyHost = !deletedToEmpty;
        status.textContent = deletedToEmpty
          ? `已删除战区「${currentName}」，回到空沙盘：点击「导入 .map」或拖入 .map 文件开始`
          : `已删除战区「${currentName}」，并切换到另一战区`;
        return;
      }
      if (hasTheater) {
        previous = captureTheater();
        status.textContent = '正在暂存当前战区…';
        await saveTheater(previous); // 必须等 IndexedDB transaction complete
        savedRevision = revision;
      }
      if (target === 'download-map') {
        if (previous === undefined) throw new Error('尚未导入地图，没有可下载的 .map');
        downloadText(serializeMap(previous.mapData), `${previous.mapData.source.name}.map`, 'text/plain;charset=utf-8');
        if (hadPendingDebounce) shouldNotifyHost = true;
      } else if (target === 'export-project') {
        if (previous === undefined) throw new Error('尚未导入地图，没有可导出的工程');
        const theaters = [previous];
        for (const entry of await listTheaters()) {
          if (entry.mapId === appStore.mapId) continue;
          const saved = await readTheater(entry.mapId);
          if (saved === undefined) throw new Error(`战区 ${entry.name} 缺失，工程未导出`);
          theaters.push(saved);
        }
        downloadText(serializeProject(theaters, appStore.mapId), `${previous.mapData.source.name}-推演工程.json`, 'application/json;charset=utf-8');
        if (hadPendingDebounce) shouldNotifyHost = true;
      } else if (target instanceof File && /\.json$/i.test(target.name)) {
        const project = parseProject(await target.text());
        const existing = await listTheaters();
        const overwritten = existing.filter(entry => project.theaters.some(state => state.mapData.source.mapId === entry.mapId));
        if (overwritten.length > 0 && !window.confirm(`导入工程将覆盖以下战区的当前编辑：\n${overwritten.map(entry => `${entry.name} (${entry.mapId})`).join('\n')}\n\n是否继续？`)) {
          status.textContent = '已取消工程导入，当前编辑已保留';
          return;
        }
        const next = project.theaters.find(state => state.mapData.source.mapId === project.activeMapId)!;
        await saveTheaters(project.theaters, project.activeMapId);
        appStore.emit('map:loading');
        publishing = true;
        publishTheater(next);
        shouldNotifyHost = true;
      } else if (target !== 'save') {
        appStore.emit('map:loading');
        let next: TheaterState;
        if (typeof target === 'string') {
          const saved = await readTheater(target);
          if (saved === undefined) throw new Error('所选战区的缓存不存在，请重新导入其 .map');
          next = saved;
        } else {
          const map = parseWorkingMap(await target.text());
          const fileName = target.name.replace(/\.map$/i, '');
          // 忽略损坏缓存后重新导入同图：跳过损坏记录，按全新导入重建
          const rebuild = isBaseReplacementPending(map.source.mapId);
          const saved = rebuild ? undefined : await readTheater(map.source.mapId);
          if (saved === undefined) {
            next = newTheater(map);
            next.mapData.source.name = fileName;
          } else {
            const overwrite = window.confirm(
              `浏览器中已有同身份战区「${saved.mapData.source.name}」（${map.source.mapId}）。\n\n` +
              `点击「确定」：用新导入的 .map 覆盖更新该战区（原编辑、兵牌、战线与战场将被替换，如需保留请先导出推演工程）；\n` +
              `点击「取消」：保留已有缓存并切换到原战区。`
            );
            if (overwrite) {
              replaceBaseOnNextSave(map.source.mapId);
              next = newTheater(map);
              next.mapData.source.name = fileName;
              overwroteSameMap = true;
            } else {
              next = saved;
              if (next.mapData.source.originalMap === undefined && map.source.originalMap !== undefined) {
                next.mapData.source.originalMap = map.source.originalMap;
                replaceBaseOnNextSave(next.mapData.source.mapId);
              }
            }
          }
        }
        // 先登记新大陆，成功后才替换当前可编辑状态。
        await saveTheater(next);
        publishing = true;
        publishTheater(next);
        shouldNotifyHost = true;
      } else if (previous !== undefined) {
        shouldNotifyHost = true;
      }
      await refresh();
      status.textContent = target === 'save' ? (previous === undefined ? '尚未导入地图，没有可暂存的战区' : '当前战区已暂存')
        : target === 'download-map' ? '已下载 .map（城市、国家、省份和归属；兵牌与战线请导出工程）'
        : target === 'export-project' ? '全部战区已导出为推演工程'
        : target instanceof File && /\.json$/i.test(target.name) ? '工程已导入并恢复全部战区'
        : overwroteSameMap ? '已用新版 .map 覆盖并重建战区'
        : '已切换并恢复战区';
    } catch (error) {
      // 输入/IndexedDB/渲染的统一 UI 边界，显示原始失败；不清空、不删除缓存。
      if (publishing && previous !== undefined) publishTheater(previous);
      console.error('[theater-manager] 切换或暂存失败', error);
      status.textContent = `操作失败：${String(error)}；${appStore.mapData === null ? '空沙盘保持不变' : '当前战区已保留'}`;
      appStore.emit('map:error', error);
    } finally {
      syncSelect();
      appStore.isSwitchingMap = false;
      root.inert = false;
      blocker.style.display = 'none';
      if (shouldNotifyHost && appStore.mapData !== null) {
        pendingHostAutosave = false;
        appStore.emit('project:autosaved');
      }
    }
  }

  let imageConfigModal: HTMLDivElement | null = null;
  const closeImageModal = () => {
    imageConfigModal?.remove();
    imageConfigModal = null;
  };

  async function commitImageTheater(options: {
    name: string;
    imageUrl: string;
    width: number;
    height: number;
    gridPreset: ImageGridPreset;
    mapWidthKm?: number;
  }): Promise<void> {
    if (appStore.isSwitchingMap) return;
    appStore.isSwitchingMap = true;
    blocker.style.display = 'block';
    root.inert = true;
    let previous: TheaterState | undefined;
    let publishing = false;
    let succeeded = false;
    try {
      appStore.emit('theater:leaving');
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
      await saving;
      if (appStore.mapData !== null) {
        previous = captureTheater();
        status.textContent = '正在暂存当前战区…';
        await saveTheater(previous);
        savedRevision = revision;
      }
      const spec = createImageBaseSpec({
        name: options.name,
        width: options.width,
        height: options.height,
        imageUrl: options.imageUrl,
        gridPreset: options.gridPreset,
        mapWidthKm: options.mapWidthKm,
      });
      const builtMap = buildImageHexMapData(spec);
      const next = newTheater(builtMap);
      replaceBaseOnNextSave(builtMap.source.mapId);
      await saveTheater(next);
      appStore.emit('map:loading');
      publishing = true;
      publishTheater(next);
      savedRevision = revision;
      await refresh();
      succeeded = true;
      status.textContent = `已从图片底图创建战区「${builtMap.source.name}」（${builtMap.cells.count} 格）`;
    } catch (error) {
      if (publishing && previous !== undefined) publishTheater(previous);
      console.error('[theater-manager] 创建图片战区失败', error);
      status.textContent = `图片建图失败：${String(error)}；${appStore.mapData === null ? '空沙盘保持不变' : '当前战区已保留'}`;
      appStore.emit('map:error', error);
    } finally {
      syncSelect();
      appStore.isSwitchingMap = false;
      root.inert = false;
      blocker.style.display = 'none';
      if (succeeded && appStore.mapData !== null) {
        pendingHostAutosave = false;
        appStore.emit('project:autosaved');
      }
    }
  }

  async function openImageImportDialog(file: File): Promise<void> {
    if (appStore.isSwitchingMap) return;
    closeImageModal();
    status.textContent = `正在读取图片「${file.name}」…`;
    let dataUrl: string;
    let dims: { width: number; height: number };
    try {
      dataUrl = await readFileAsDataUrl(file);
      dims = await probeImageDimensions(dataUrl);
    } catch (error) {
      console.error('[theater-manager] 读取本地图片失败', error);
      status.textContent = `读取图片失败：${String(error)}`;
      return;
    }

    const defaultName = file.name.replace(IMAGE_FILE_RE, '') || '图片战区';
    const rCoarse = computeHexRadiusForPreset(dims.width, dims.height, 'coarse');
    const rStandard = computeHexRadiusForPreset(dims.width, dims.height, 'standard');
    const rFine = computeHexRadiusForPreset(dims.width, dims.height, 'fine');

    const backdrop = document.createElement('div');
    backdrop.id = 'wenyou-image-import-modal';
    backdrop.style.cssText =
      'position:fixed;inset:0;z-index:10020;background:#020617aa;display:flex;align-items:center;justify-content:center;padding:16px;';
    const panel = document.createElement('form');
    panel.style.cssText =
      'width:min(420px,92vw);background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 16px 40px #00000080;font-size:12px;';

    const heading = document.createElement('div');
    heading.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';
    const title = document.createElement('strong');
    title.textContent = '导入静态图片建图';
    title.style.fontSize = '14px';
    const meta = document.createElement('span');
    meta.textContent = `${dims.width} × ${dims.height} px`;
    meta.style.color = '#94a3b8';
    heading.append(title, meta);

    const nameLabel = document.createElement('label');
    nameLabel.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    nameLabel.textContent = '战区名称';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = defaultName;
    nameInput.required = true;
    nameInput.style.cssText = 'background:#1e293b;color:#f8fafc;border:1px solid #475569;border-radius:4px;padding:6px 8px;';
    nameLabel.appendChild(nameInput);

    const densityWrap = document.createElement('div');
    densityWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    const densityTitle = document.createElement('span');
    densityTitle.textContent = '虚拟六角网格密度';
    const densityGroup = document.createElement('div');
    densityGroup.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:6px;';
    let selectedPreset: ImageGridPreset = 'standard';
    const presetDefs: Array<{ key: ImageGridPreset; label: string; hint: string }> = [
      { key: 'coarse', label: '粗略', hint: `~2200格 (r=${rCoarse})` },
      { key: 'standard', label: '标准', hint: `~5000格 (r=${rStandard})` },
      { key: 'fine', label: '精细', hint: `~9500格 (r=${rFine})` },
    ];
    const presetButtons: HTMLButtonElement[] = [];
    const syncPresetButtons = () => {
      for (const btn of presetButtons) {
        const active = btn.dataset.preset === selectedPreset;
        btn.style.borderColor = active ? '#38bdf8' : '#475569';
        btn.style.background = active ? '#0c4a6e' : '#1e293b';
        btn.style.color = active ? '#f0f9ff' : '#cbd5e1';
      }
    };
    for (const def of presetDefs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.preset = def.key;
      btn.style.cssText =
        'display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 4px;border:1px solid #475569;border-radius:6px;cursor:pointer;';
      const strong = document.createElement('strong');
      strong.textContent = def.label;
      const small = document.createElement('span');
      small.textContent = def.hint;
      small.style.cssText = 'font-size:10px;opacity:0.85;';
      btn.append(strong, small);
      btn.addEventListener('click', () => {
        selectedPreset = def.key;
        syncPresetButtons();
      });
      presetButtons.push(btn);
      densityGroup.appendChild(btn);
    }
    syncPresetButtons();
    densityWrap.append(densityTitle, densityGroup);

    const scaleLabel = document.createElement('label');
    scaleLabel.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    scaleLabel.textContent = '全图横向跨度（km，可选；留空不设比例尺）';
    const scaleInput = document.createElement('input');
    scaleInput.type = 'number';
    scaleInput.min = '0';
    scaleInput.step = 'any';
    scaleInput.placeholder = '例如 1200';
    scaleInput.style.cssText = 'background:#1e293b;color:#f8fafc;border:1px solid #475569;border-radius:4px;padding:6px 8px;';
    scaleLabel.appendChild(scaleInput);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:4px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = 'background:#1e293b;color:#cbd5e1;border:1px solid #64748b;border-radius:4px;padding:6px 12px;cursor:pointer;';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'submit';
    confirmBtn.textContent = '确认建图';
    confirmBtn.style.cssText = 'background:#0284c7;color:#f8fafc;border:1px solid #38bdf8;border-radius:4px;padding:6px 14px;cursor:pointer;font-weight:600;';
    actions.append(cancelBtn, confirmBtn);

    panel.append(heading, nameLabel, densityWrap, scaleLabel, actions);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    imageConfigModal = backdrop;
    status.textContent = '请确认图片战区参数';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup();
        status.textContent = '已取消图片建图';
      }
    };
    const cleanup = () => {
      window.removeEventListener('keydown', onKeyDown);
      closeImageModal();
    };
    window.addEventListener('keydown', onKeyDown);
    cancelBtn.addEventListener('click', () => {
      cleanup();
      status.textContent = '已取消图片建图';
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        cleanup();
        status.textContent = '已取消图片建图';
      }
    });
    panel.addEventListener('submit', (event) => {
      event.preventDefault();
      const mapName = nameInput.value.trim() || defaultName;
      const rawKm = scaleInput.value.trim();
      const parsedKm = rawKm ? Number(rawKm) : undefined;
      const mapWidthKm = parsedKm !== undefined && Number.isFinite(parsedKm) && parsedKm > 0 ? parsedKm : undefined;
      cleanup();
      void commitImageTheater({
        name: mapName,
        imageUrl: dataUrl,
        width: dims.width,
        height: dims.height,
        gridPreset: selectedPreset,
        mapWidthKm,
      });
    });
    nameInput.focus();
    nameInput.select();
  }

  select.addEventListener('change', () => { void transition(select.value); });
  open.addEventListener('click', () => input.click());
  openImage.addEventListener('click', () => imageInput.click());
  remove.addEventListener('click', () => { void transition('delete-theater'); });
  save.addEventListener('click', () => { void transition('save'); });
  download.addEventListener('click', () => { void transition('download-map'); });
  exportProject.addEventListener('click', () => { void transition('export-project'); });
  importProject.addEventListener('click', () => projectInput.click());
  syncSelect();
  projectInput.addEventListener('change', () => {
    const file = projectInput.files![0];
    projectInput.value = '';
    if (file) void transition(file);
  });
  imageInput.addEventListener('change', () => {
    const file = imageInput.files![0];
    imageInput.value = '';
    if (file) void openImageImportDialog(file);
  });
  input.addEventListener('change', () => {
    const file = input.files![0];
    input.value = '';
    if (file) void transition(file); // 用户可取消系统文件对话框
  });
  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = appStore.isSwitchingMap ? 'none' : 'copy';
  });
  window.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); // 阻止浏览器导航到本地文件
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      status.textContent = '请一次拖入一个 FMG .map、工程 .json 或图片文件';
      return;
    }
    const dropped = files[0];
    if (isImageFile(dropped)) {
      void openImageImportDialog(dropped);
      return;
    }
    void transition(dropped);
  });
  // 键盘监听在 window 上；inert 只屏蔽 DOM 焦点，不能拦住已有全局快捷键。
  for (const type of ['keydown', 'keyup']) {
    window.addEventListener(type, (event) => {
      if (appStore.isSwitchingMap) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, { capture: true });
  }
  void refresh().catch((error) => {
    console.error('[theater-manager] 读取战区目录失败', error);
    status.textContent = `读取战区目录失败：${String(error)}`;
  });

  // 沿用逐笔编辑合并保存的 500ms 间隔，直接保存当前战区，不再生成历史快照。
  function flushAutosave(): void {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (appStore.isSwitchingMap || appStore.mapData === null || saving !== null || revision === savedRevision) return;
    const writingRevision = revision;
    const shouldEmitHost = pendingHostAutosave;
    pendingHostAutosave = false;
    saving = saveTheater(captureTheater()).then(() => {
      savedRevision = writingRevision;
      status.textContent = revision === savedRevision ? '当前战区已自动暂存' : '正在自动暂存…';
      if (shouldEmitHost && revision === savedRevision) {
        appStore.emit('project:autosaved');
      }
    }, error => {
      if (shouldEmitHost) pendingHostAutosave = true;
      console.error('[theater-manager] 自动暂存失败', error);
      status.textContent = `自动暂存失败：${String(error)}；请导出工程保存当前编辑`;
    }).finally(() => {
      saving = null;
      // 写入期间发生了新的编辑，立即提交新一份；同一失败版本不自动重试。
      if (revision !== writingRevision && revision !== savedRevision) flushAutosave();
    });
  }
  const scheduleAutosave = (notifyHost: boolean): void => {
    if (appStore.isSwitchingMap || appStore.mapData === null) return;
    if (notifyHost) pendingHostAutosave = true;
    revision++;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    if (notifyHost) status.textContent = '正在自动暂存…';
    saveTimer = window.setTimeout(flushAutosave, 500);
  };
  for (const event of [
    'brush:painted',
    'entity:changed',
    'tactical-change',
    'garrisons-change',
    'battle:changed',
    'retouch:changed',
    'overlay:alpha',
    'scale:changed',
  ] as const) {
    appStore.on(event, () => scheduleAutosave(true));
  }
  appStore.on('fieldbattle:changed', (payload) => {
    // 野战窗纯视角平移/缩放（kind: 'view'）仅做轻量本地缓存，不触发全量多战区 project:autosaved
    scheduleAutosave(payload?.kind !== 'view');
  });
  appStore.on('theater:leaving', () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
      if (!appStore.isSwitchingMap && appStore.mapData !== null && saving === null && revision !== savedRevision) {
        flushAutosave();
      }
    }
  });
  window.addEventListener('beforeunload', event => {
    appStore.emit('brush:finish');
    if (revision !== savedRevision || saving !== null || appStore.isSwitchingMap) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      appStore.emit('brush:finish');
      flushAutosave();
    }
  });
  switcherHooks = {
    waitSaving: async () => { await saving; },
    clearSaveTimer: () => {
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
    },
    markSaved: () => {
      savedRevision = revision;
      pendingHostAutosave = false;
    },
    setBusy: (busy) => {
      blocker.style.display = busy ? 'block' : 'none';
      root.inert = busy;
      if (!busy) syncSelect();
    },
    refreshUi: async (statusText?: string) => {
      await refresh();
      syncSelect();
      if (statusText !== undefined) status.textContent = statusText;
    },
  };
}
