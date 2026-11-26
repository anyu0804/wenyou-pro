import { appStore } from './store';
import { captureTheater, listTheaters, readTheater, resolveWorkspaceScopeFromUrl, type TheaterState } from './theater-cache';
import { serializeProject } from './project-serializer';
import {
  createImageTheaterFromBridge,
  exportProjectForBridge,
  importProjectFromBridge,
  resetSandboxFromBridge,
  type BridgeCreateImageTheaterPayload,
  type BridgeImageTheaterResult,
  type BridgeProjectExportResult,
  type BridgeProjectResult,
} from './theater-manager';

export const WENYOU_MAP_BRIDGE_PROTOCOL = 'wenyou-map-bridge/v1';
export const WENYOU_SANDBOX_VERSION = '0.9.1';

export interface BridgeSyncContextPayload {
  worldId: string;
  worldTitle: string;
  currentEra: string;
  viewer?: string;
  workspaceKey?: string;
}

export type BridgeHostMessage =
  | { protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL; type: 'ping'; requestId?: string }
  | { protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL; type: 'reset_sandbox'; requestId?: string }
  | { protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL; type: 'sync_context'; payload: BridgeSyncContextPayload }
  | {
      protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
      type: 'load_project';
      requestId?: string;
      payload: {
        fileName: string;
        projectJson: string;
        forceOverwrite?: boolean;
      };
    }
  | { protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL; type: 'request_export_project'; requestId?: string }
  | {
      protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
      type: 'create_image_theater';
      requestId?: string;
      payload: {
        name: string;
        imageUrl: string;
        imageRelPath?: string;
        gridPreset?: 'coarse' | 'standard' | 'fine';
        mapWidthKm?: number;
      };
    };

export type BridgeSandboxMessage =
  | {
      protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
      type: 'ready' | 'pong';
      requestId?: string;
      payload: {
        version: string;
        activeMapId: string | null;
        mapName: string | null;
        theaterCount: number;
        workspaceKey?: string;
      };
    }
  | {
      protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
      type: 'context_acked';
      payload: {
        worldId: string;
        currentEra: string;
        activeMapId: string | null;
        workspaceKey?: string;
      };
    }
  | {
      protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
      type: 'project_loaded';
      requestId?: string;
      payload: {
        ok: boolean;
        activeMapId?: string | null;
        mapName?: string | null;
        theaterCount?: number;
        error?: string;
        workspaceKey?: string;
      };
    }
  | {
      protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
      type: 'project_exported';
      requestId?: string;
      payload: {
        ok: boolean;
        projectJson?: string;
        activeMapId?: string | null;
        mapName?: string | null;
        theaterCount?: number;
        error?: string;
        workspaceKey?: string;
      };
    }
  | {
      protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
      type: 'image_theater_created';
      requestId?: string;
      payload: {
        ok: boolean;
        activeMapId?: string | null;
        mapName?: string | null;
        cellCount?: number;
        kmPerPixel?: number;
        error?: string;
        workspaceKey?: string;
      };
    }
  | {
      protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
      type: 'autosave_project';
      payload: {
        projectJson: string;
        activeMapId: string;
        mapName: string;
        theaterCount: number;
        workspaceKey?: string;
      };
    }
  | {
      protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
      type: 'selection_changed';
      payload: {
        kind: 'burg' | 'unit';
        id: number | string;
        name: string;
        stateName?: string;
        personnel?: number;
        x?: number;
        y?: number;
      };
    }
  | {
      protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
      type: 'focus_source';
      payload: {
        sourceId: string;
        highlightQuote?: string;
      };
    };

export interface BridgeWindowLike {
  parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface InitMapBridgeOptions {
  win?: BridgeWindowLike;
  doc?: Document | null;
  version?: string;
  workspaceScope?: string | null;
  earlyMessages?: MessageEvent[];
  listTheaters?: () => Promise<{ mapId: string; name: string }[]>;
  readTheater?: (mapId: string) => Promise<TheaterState | undefined>;
  importProject?: (projectJson: string, options?: { forceOverwrite?: boolean }) => Promise<BridgeProjectResult>;
  exportProject?: () => Promise<BridgeProjectExportResult>;
  createImageTheater?: (payload: BridgeCreateImageTheaterPayload) => Promise<BridgeImageTheaterResult>;
  resetSandbox?: () => Promise<void>;
}

export interface MapBridgeHandle {
  getLastContext(): BridgeSyncContextPayload | null;
  destroy(): void;
}

/** 放行合法 http(s):// 宿主源（含回环与局域网/远端域名或 IP）、Electron file:// 与内置协议源（wenyou-sandbox://、app://）。 */
export function isAllowedHostOrigin(origin: string): boolean {
  if (
    origin === 'null' ||
    origin === '' ||
    origin.startsWith('file://') ||
    origin.startsWith('wenyou-sandbox://') ||
    origin.startsWith('app://')
  ) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return (
      Boolean(parsed.hostname) &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash &&
      !parsed.username &&
      !parsed.password &&
      !origin.endsWith('/') &&
      !origin.includes('?') &&
      !origin.includes('#')
    );
  } catch {
    return false;
  }
}

/** 非 null/file origin 一律传精确 origin；仅嵌入态 file:// 或初始 ready 使用 '*'。 */
export function resolveReplyTargetOrigin(hostOrigin: string | null): string {
  if (hostOrigin && hostOrigin !== 'null' && !hostOrigin.startsWith('file://')) {
    return hostOrigin;
  }
  return '*';
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSyncContextPayload(value: unknown): value is BridgeSyncContextPayload {
  return (
    isObjectRecord(value) &&
    typeof value.worldId === 'string' &&
    typeof value.worldTitle === 'string' &&
    typeof value.currentEra === 'string' &&
    (value.viewer === undefined || typeof value.viewer === 'string')
  );
}

/** 初始化 wenyou-map-bridge/v1 对端桥接器；仅在嵌入 iframe 时向 window.parent 通信。 */
export function initMapBridge(options: InitMapBridgeOptions = {}): MapBridgeHandle {
  const win: BridgeWindowLike | undefined = options.win ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = options.doc !== undefined ? options.doc : (typeof document !== 'undefined' ? document : null);
  const version = options.version ?? WENYOU_SANDBOX_VERSION;
  const queryTheaters = options.listTheaters ?? listTheaters;
  const queryReadTheater = options.readTheater ?? readTheater;
  const doImportProject = options.importProject ?? importProjectFromBridge;
  const doExportProject = options.exportProject ?? exportProjectForBridge;
  const doCreateImageTheater = options.createImageTheater ?? createImageTheaterFromBridge;
  const doResetSandbox = options.resetSandbox ?? resetSandboxFromBridge;

  const urlWorkspaceScope =
    options.workspaceScope !== undefined
      ? (options.workspaceScope?.trim() || null)
      : resolveWorkspaceScopeFromUrl();
  let contextWorkspaceKey: string | null = null;
  let lastHostOrigin: string | null = null;
  let lastContext: BridgeSyncContextPayload | null = null;
  let contextBadgeEl: HTMLSpanElement | null = null;
  let autosaveInFlight = false;
  let autosavePending = false;
  let suppressNextMapClearedReady = false;

  const getEffectiveWorkspaceKey = (): string | null => contextWorkspaceKey || urlWorkspaceScope;
  const workspaceMeta = (): { workspaceKey?: string } => {
    const key = getEffectiveWorkspaceKey();
    return key ? { workspaceKey: key } : {};
  };

  const isEmbedded = (): boolean => Boolean(win && win.parent && win.parent !== (win as unknown));

  const postToParent = (message: BridgeSandboxMessage, explicitOrigin?: string | null): void => {
    if (!isEmbedded() || !win?.parent) return;
    const targetOrigin = resolveReplyTargetOrigin(explicitOrigin !== undefined ? explicitOrigin : lastHostOrigin);
    win.parent.postMessage(message, targetOrigin);
  };

  const countTheaters = async (): Promise<number> => {
    const entries = await queryTheaters();
    if (appStore.mapData && !entries.some(entry => entry.mapId === appStore.mapId)) {
      return entries.length + 1;
    }
    return entries.length;
  };

  const updateContextBadge = (ctx: BridgeSyncContextPayload): void => {
    if (!doc) return;
    const bar = doc.getElementById('wenyou-theater-bar');
    if (!bar) return;
    if (!contextBadgeEl || !contextBadgeEl.isConnected) {
      contextBadgeEl = doc.createElement('span');
      contextBadgeEl.id = 'wenyou-host-context';
      contextBadgeEl.style.cssText = 'padding:2px 6px;border-radius:4px;background:#1e293b;border:1px solid #38bdf866;color:#7dd3fc;font-size:11px;white-space:nowrap;';
      bar.appendChild(contextBadgeEl);
    }
    const era = ctx.currentEra ? ` · ${ctx.currentEra}` : '';
    contextBadgeEl.textContent = `宿主：${ctx.worldTitle || ctx.worldId}${era}`;
    contextBadgeEl.title = ctx.viewer ? `worldId=${ctx.worldId} viewer=${ctx.viewer}` : `worldId=${ctx.worldId}`;
  };

  const emitReady = async (type: 'ready' | 'pong', requestId?: string, explicitOrigin?: string | null): Promise<void> => {
    const theaterCount = await countTheaters();
    postToParent(
      {
        protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
        type,
        ...(requestId !== undefined ? { requestId } : {}),
        payload: {
          version,
          activeMapId: appStore.mapId || null,
          mapName: appStore.mapData?.source.name ?? null,
          theaterCount,
          ...workspaceMeta(),
        },
      },
      explicitOrigin,
    );
  };

  const onMessage = (event: MessageEvent): void => {
    if (!isEmbedded() || !win) return;
    if (event.source !== (win.parent as unknown)) return;
    if (typeof event.origin !== 'string' || !isAllowedHostOrigin(event.origin)) return;
    const data = event.data;
    if (!isObjectRecord(data) || data.protocol !== WENYOU_MAP_BRIDGE_PROTOCOL || typeof data.type !== 'string') return;

    const replyOrigin = event.origin;
    if (replyOrigin && replyOrigin !== 'null' && !replyOrigin.startsWith('file://')) {
      lastHostOrigin = replyOrigin;
    }
    const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;

    if (data.type === 'ping') {
      void emitReady('pong', requestId, replyOrigin);
      return;
    }

    if (data.type === 'reset_sandbox') {
      suppressNextMapClearedReady = true;
      void doResetSandbox().then(
        () => {
          suppressNextMapClearedReady = false;
          void emitReady('ready', requestId, replyOrigin);
        },
        (error) => {
          suppressNextMapClearedReady = false;
          console.warn('[bridge] reset_sandbox 失败', error);
          void emitReady('ready', requestId, replyOrigin);
        },
      );
      return;
    }

    if (data.type === 'sync_context') {
      if (!isSyncContextPayload(data.payload)) return;
      if (typeof data.payload.workspaceKey === 'string' && data.payload.workspaceKey.trim()) {
        contextWorkspaceKey = data.payload.workspaceKey.trim();
      }
      lastContext = { ...data.payload };
      updateContextBadge(lastContext);
      postToParent(
        {
          protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
          type: 'context_acked',
          payload: {
            worldId: lastContext.worldId,
            currentEra: lastContext.currentEra,
            activeMapId: appStore.mapId || null,
            ...workspaceMeta(),
          },
        },
        replyOrigin,
      );
      return;
    }

    if (data.type === 'load_project') {
      const payload = data.payload;
      if (!isObjectRecord(payload) || typeof payload.projectJson !== 'string') {
        postToParent(
          {
            protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
            type: 'project_loaded',
            ...(requestId !== undefined ? { requestId } : {}),
            payload: { ok: false, error: 'load_project 缺少有效的 projectJson 字符串', ...workspaceMeta() },
          },
          replyOrigin,
        );
        return;
      }
      const forceOverwrite = payload.forceOverwrite !== false;
      void doImportProject(payload.projectJson, { forceOverwrite }).then(
        (result) => {
          postToParent(
            {
              protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
              type: 'project_loaded',
              ...(requestId !== undefined ? { requestId } : {}),
              payload: {
                ok: true,
                activeMapId: result.activeMapId,
                mapName: result.mapName,
                theaterCount: result.theaterCount,
                ...workspaceMeta(),
              },
            },
            replyOrigin,
          );
        },
        (error) => {
          postToParent(
            {
              protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
              type: 'project_loaded',
              ...(requestId !== undefined ? { requestId } : {}),
              payload: {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                ...workspaceMeta(),
              },
            },
            replyOrigin,
          );
        },
      );
      return;
    }

    if (data.type === 'request_export_project') {
      void doExportProject().then(
        (result) => {
          postToParent(
            {
              protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
              type: 'project_exported',
              ...(requestId !== undefined ? { requestId } : {}),
              payload: {
                ok: true,
                projectJson: result.projectJson,
                activeMapId: result.activeMapId,
                mapName: result.mapName,
                theaterCount: result.theaterCount,
                ...workspaceMeta(),
              },
            },
            replyOrigin,
          );
        },
        (error) => {
          postToParent(
            {
              protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
              type: 'project_exported',
              ...(requestId !== undefined ? { requestId } : {}),
              payload: {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                ...workspaceMeta(),
              },
            },
            replyOrigin,
          );
        },
      );
      return;
    }

    if (data.type === 'create_image_theater') {
      const payload = data.payload;
      if (!isObjectRecord(payload) || typeof payload.imageUrl !== 'string' || !payload.imageUrl.trim()) {
        postToParent(
          {
            protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
            type: 'image_theater_created',
            ...(requestId !== undefined ? { requestId } : {}),
            payload: { ok: false, error: 'create_image_theater 缺少有效的 imageUrl', ...workspaceMeta() },
          },
          replyOrigin,
        );
        return;
      }
      const gridPreset =
        payload.gridPreset === 'coarse' || payload.gridPreset === 'standard' || payload.gridPreset === 'fine'
          ? payload.gridPreset
          : undefined;
      const mapWidthKm =
        typeof payload.mapWidthKm === 'number' && Number.isFinite(payload.mapWidthKm) && payload.mapWidthKm > 0
          ? payload.mapWidthKm
          : undefined;
      void doCreateImageTheater({
        name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : '图片战区',
        imageUrl: payload.imageUrl,
        ...(typeof payload.imageRelPath === 'string' ? { imageRelPath: payload.imageRelPath } : {}),
        ...(gridPreset !== undefined ? { gridPreset } : {}),
        ...(mapWidthKm !== undefined ? { mapWidthKm } : {}),
      }).then(
        (result) => {
          postToParent(
            {
              protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
              type: 'image_theater_created',
              ...(requestId !== undefined ? { requestId } : {}),
              payload: {
                ok: true,
                activeMapId: result.activeMapId,
                mapName: result.mapName,
                cellCount: result.cellCount,
                ...(result.kmPerPixel !== undefined ? { kmPerPixel: result.kmPerPixel } : {}),
                ...workspaceMeta(),
              },
            },
            replyOrigin,
          );
        },
        (error) => {
          postToParent(
            {
              protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
              type: 'image_theater_created',
              ...(requestId !== undefined ? { requestId } : {}),
              payload: {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                ...workspaceMeta(),
              },
            },
            replyOrigin,
          );
        },
      );
    }
  };

  const onMapLoaded = (): void => {
    void emitReady('ready');
  };
  const onMapCleared = (): void => {
    if (suppressNextMapClearedReady) return;
    void emitReady('ready');
  };
  const onSelectBurg = (burgId: number | null): void => {
    if (burgId === null || !appStore.mapData) return;
    const burg = appStore.mapData.burgs.find(item => item.i === burgId && !item.removed);
    if (!burg) return;
    const state = appStore.mapData.states.find(item => item.i === burg.state && !item.removed);
    postToParent({
      protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
      type: 'selection_changed',
      payload: {
        kind: 'burg',
        id: burg.i,
        name: burg.name,
        ...(state ? { stateName: state.name } : {}),
        x: burg.x,
        y: burg.y,
      },
    });
  };
  const onSelectUnit = (unitId: string | null): void => {
    if (unitId === null) return;
    const unit = appStore.garrisons.find(item => item.id === unitId);
    if (!unit) return;
    const name = unit.unitName.state === 'known' ? unit.unitName.value : unit.id;
    let stateName: string | undefined = unit.side.state === 'known' && unit.side.value ? unit.side.value : undefined;
    if (!stateName && unit.provinceId.state === 'known' && unit.provinceId.value !== null && appStore.mapData) {
      const provId = unit.provinceId.value;
      const province = appStore.mapData.provinces.find(item => item.i === provId && !item.removed);
      const state = province ? appStore.mapData.states.find(item => item.i === province.state && !item.removed) : undefined;
      if (state) stateName = state.name;
    }
    const personnel = unit.personnel.count.state === 'known' ? unit.personnel.count.value : undefined;
    const deployment = appStore.battle.deployments.find(item => item.unitId === unit.id);
    const anchor = deployment?.placement.state === 'known' ? deployment.placement.value.anchor : undefined;
    postToParent({
      protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
      type: 'selection_changed',
      payload: {
        kind: 'unit',
        id: unit.id,
        name,
        ...(stateName !== undefined ? { stateName } : {}),
        ...(personnel !== undefined ? { personnel } : {}),
        ...(anchor !== undefined ? { x: anchor[0], y: anchor[1] } : {}),
      },
    });
  };
  const onFocusSource = (payload: { sourceId: string; highlightQuote?: string }): void => {
    const sourceId = payload.sourceId.trim();
    if (!sourceId) return;
    postToParent({
      protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
      type: 'focus_source',
      payload: {
        sourceId,
        ...(payload.highlightQuote ? { highlightQuote: payload.highlightQuote } : {}),
      },
    });
  };

  const pushAutosaveProject = async (): Promise<void> => {
    if (!isEmbedded() || !appStore.mapData || appStore.isSwitchingMap) return;
    if (autosaveInFlight) {
      autosavePending = true;
      return;
    }
    autosaveInFlight = true;
    try {
      const current = captureTheater();
      const theaters: TheaterState[] = [current];
      const entries = await queryTheaters();
      for (const entry of entries) {
        if (entry.mapId === current.mapData.source.mapId) continue;
        const saved = await queryReadTheater(entry.mapId);
        if (saved) theaters.push(saved);
      }
      const projectJson = serializeProject(theaters, current.mapData.source.mapId);
      postToParent({
        protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
        type: 'autosave_project',
        payload: {
          projectJson,
          activeMapId: current.mapData.source.mapId,
          mapName: current.mapData.source.name,
          theaterCount: theaters.length,
          ...workspaceMeta(),
        },
      });
    } catch (error) {
      console.warn('[bridge] 自动回传推演工程失败', error);
    } finally {
      autosaveInFlight = false;
      if (autosavePending) {
        autosavePending = false;
        void pushAutosaveProject();
      }
    }
  };

  const onProjectAutosaved = (): void => {
    void pushAutosaveProject();
  };

  win?.addEventListener('message', onMessage);
  appStore.on('map:loaded', onMapLoaded);
  appStore.on('map:cleared', onMapCleared);
  appStore.on('selection:burg', onSelectBurg);
  appStore.on('selection:unit', onSelectUnit);
  appStore.on('source:focus', onFocusSource);
  appStore.on('project:autosaved', onProjectAutosaved);

  if (isEmbedded()) {
    void emitReady('ready');
    if (options.earlyMessages?.length) {
      for (const earlyEvent of options.earlyMessages) {
        onMessage(earlyEvent);
      }
    }
  }

  return {
    getLastContext: () => (lastContext ? { ...lastContext } : null),
    destroy: () => {
      win?.removeEventListener('message', onMessage);
      appStore.off('map:loaded', onMapLoaded);
      appStore.off('map:cleared', onMapCleared);
      appStore.off('selection:burg', onSelectBurg);
      appStore.off('selection:unit', onSelectUnit);
      appStore.off('source:focus', onFocusSource);
      appStore.off('project:autosaved', onProjectAutosaved);
      contextBadgeEl?.remove();
      contextBadgeEl = null;
    },
  };
}
