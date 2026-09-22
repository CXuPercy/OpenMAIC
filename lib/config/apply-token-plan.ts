import type { ProviderId } from '@/lib/types/provider';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import type { TTSProviderId } from '@/lib/audio/types';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import { MODALITY_ORDER, TOKEN_PLAN_PRESETS, tokenPlanSeedFingerprint } from './token-plan-presets';
import type {
  TokenPlanModality,
  TokenPlanModalityTarget,
  TokenPlanPreset,
} from './token-plan-presets';
import { getCatalogThinkingCapability } from '@/lib/ai/model-metadata';
import { PROVIDERS } from '@/lib/ai/providers';
import { findModelById } from '@/lib/ai/model-aliases';
import type { ModelInfo } from '@/lib/types/provider';

/**
 * The subset of settings-store setters needed to fill a token plan across
 * modalities. Injected so the orchestration is a pure, testable function.
 * Signatures mirror the store actions so they can be passed verbatim.
 */
export interface TokenPlanActions {
  setProviderConfig: (id: ProviderId, config: Record<string, unknown>) => void;
  setImageProviderConfig: (
    id: ImageProviderId,
    config: Partial<{
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      customModels: Array<{ id: string; name: string }>;
      replaceBuiltInModels: boolean;
    }>,
  ) => void;
  setVideoProviderConfig: (
    id: VideoProviderId,
    config: Partial<{
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      customModels: Array<{ id: string; name: string }>;
      replaceBuiltInModels: boolean;
    }>,
  ) => void;
  setTTSProviderConfig: (
    id: TTSProviderId,
    config: Partial<{
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      modelId: string;
      customModels: Array<{ id: string; name: string }>;
    }>,
  ) => void;
  setWebSearchProviderConfig: (
    id: WebSearchProviderId,
    config: Partial<{ apiKey: string; baseUrl: string; enabled: boolean }>,
  ) => void;
  /**
   * Optional model-selection setters. When provided, applying an image/video
   * modality that declares `defaultModels` also makes that provider+model the
   * active selection, so the plan's model is used out of the box. Optional so
   * `applyTokenPlan` stays usable in tests/headless callers without them.
   */
  setImageProvider?: (id: ImageProviderId) => void;
  setImageModelId?: (modelId: string) => void;
  setVideoProvider?: (id: VideoProviderId) => void;
  setVideoModelId?: (modelId: string) => void;
  /**
   * Optional main-model + stage-route setters. LLM apply makes the plan's
   * `defaultModelId` (or first catalogue model) the mainline selection and
   * writes the preset's recommended per-stage routes (e.g. courseware /
   * interactive / pro-mode agent models).
   */
  setModel?: (providerId: ProviderId, modelId: string) => void;
  setStageRoute?: (
    stage: string,
    route: { providerId: ProviderId; modelId: string } | null,
  ) => void;
  /** Optional active-selection switches for TTS / web search. */
  setTTSProvider?: (id: TTSProviderId) => void;
  setWebSearchProvider?: (id: WebSearchProviderId) => void;
  /** Current stage routes — used by removal to drop routes onto this plan. */
  getStageRoutes?: () => Record<string, { providerId: string }>;
  /**
   * Explicit enrollment bookkeeping. Plan apply can only be told apart from a
   * personal key on the same provider (minimax / tokendance / doubao are both
   * plan endpoints and ordinary direct providers) by recording that THIS plan
   * wrote the credentials. `null` un-enrolls (disconnect).
   */
  setTokenPlanEnrolled?: (presetId: string, llmProviderId: string | null) => void;
  /**
   * 授权开关的记账。连接（apply）时清除可能残留的「已关闭」标记——重新连接
   * 即重新授权；解除连接（remove）时同样清除，让标志位不携带跨连接状态的
   * 残影（否则「关闭→断开→重连」的套餐会以 Connected (off) 的矛盾姿态回来）。
   */
  setTokenPlanEnabled?: (presetId: string, enabled: boolean) => void;
  /**
   * Seed-fingerprint bookkeeping. Only recorded after a successful seed so a
   * failed seed is retried by the next startup reconciliation. `null` clears.
   */
  setTokenPlanSeedVersion?: (presetId: string, fingerprint: string | null) => void;
  /** Currently enrolled plans (presetId → llm providerId); removal uses this
   *  to skip clearing providers another enrolled plan still owns. */
  getTokenPlanEnrollments?: () => Record<string, string>;
  /**
   * 供播种做优先级仲裁的状态快照（enrollments + providersConfig + 授权开关）。
   * 提供后，独占槽位会让位给列表中更靠前且生效的套餐；不提供时退化为旧行为
   * （后写覆盖先写）。
   */
  getTokenPlanPriorityState?: () => TokenPlanEnrollmentState;
}

/** The slices of settings state the enrollment predicates read. */
export interface TokenPlanEnrollmentState {
  tokenPlanEnrollments: Record<string, string>;
  providersConfig: Record<string, { apiKey?: string }>;
  /** 授权层开关：被显式关闭的套餐。缺省视为启用。 */
  tokenPlanDisabled?: Record<string, boolean>;
}

/**
 * Whether a plan is genuinely connected: it was enrolled through the Token
 * Plan UI (explicit marker — never inferred from a provider merely having a
 * key, which would hijack personal keys on shared providers) and its LLM
 * credentials are still present. Presets without an LLM modality never count
 * as enrolled (all shipped presets anchor on LLM).
 *
 * 注意：这是「连接层」判定，不看授权开关——Token Plan 页面要能显示一个
 * 已连接但被关闭的套餐。下游消费请用 isTokenPlanUsable。
 */
export function isTokenPlanActive(
  preset: TokenPlanPreset,
  state: TokenPlanEnrollmentState,
): boolean {
  const llm = preset.modalities.llm;
  if (!llm) return false;
  if (state.tokenPlanEnrollments[preset.id] !== llm.providerId) return false;
  return !!state.providersConfig[llm.providerId]?.apiKey;
}

/**
 * 授权层判定：已连接**且**未被「启用此套餐」开关关闭。课程模型配置的候选、
 * 排序与覆盖一律走这个口径——与「模型服务」里 provider 的 `enabled !== false`
 * 同层。
 */
export function isTokenPlanUsable(
  preset: TokenPlanPreset,
  state: TokenPlanEnrollmentState,
): boolean {
  if (state.tokenPlanDisabled?.[preset.id]) return false;
  return isTokenPlanActive(preset, state);
}

/**
 * 当前生效的套餐，按 TOKEN_PLAN_PRESETS 的声明顺序返回——这是全站唯一的
 * 套餐优先级来源。多个套餐同时开启时：列表中靠前者优先级更高，既决定课程
 * 模型配置里覆盖（stage routes / 主线模型）的归属，也决定选择列表中各套餐
 * 模型组的先后。
 */
export function activeTokenPlansInPriorityOrder(
  state: TokenPlanEnrollmentState,
): TokenPlanPreset[] {
  return TOKEN_PLAN_PRESETS.filter((preset) => isTokenPlanUsable(preset, state));
}

/**
 * 套餐授权开关的级联：把「启用此套餐」翻译成它各模态 provider 的 `enabled`
 * 标志。这样下游（课程模型配置候选、stage route 清理、媒体开关守卫、
 * x-model-routes 头）完全复用既有的授权层口径，无需各自理解套餐概念——
 * 与「模型服务」里 provider 开关的效果一致。
 *
 * 共享 provider（tokendance 与 volcengine-ark 都骑 seedream 等）由其他仍然
 * 生效的套餐占用时跳过：那份凭证此刻属于对方，不能被本套餐的开关带走。
 */
export function setTokenPlanAuthorization(
  preset: TokenPlanPreset,
  enabled: boolean,
  actions: TokenPlanActions,
  state: TokenPlanEnrollmentState,
): void {
  const ownedByOtherUsablePlan = (providerId: string): boolean =>
    TOKEN_PLAN_PRESETS.some((other) => {
      if (other.id === preset.id) return false;
      if (!isTokenPlanUsable(other, state)) return false;
      return MODALITY_ORDER.some((m) => other.modalities[m]?.providerId === providerId);
    });

  for (const modality of MODALITY_ORDER) {
    const target = preset.modalities[modality];
    if (!target) continue;
    // 关闭时才需要避让：开启本套餐不会伤到别人（同一 provider 被另一个
    // 生效套餐用着，把它打开也是对方想要的状态）。
    if (!enabled && ownedByOtherUsablePlan(target.providerId)) continue;

    try {
      switch (modality) {
        case 'llm':
          actions.setProviderConfig(target.providerId as ProviderId, { enabled });
          break;
        case 'image':
          actions.setImageProviderConfig(target.providerId as ImageProviderId, { enabled });
          break;
        case 'video':
          actions.setVideoProviderConfig(target.providerId as VideoProviderId, { enabled });
          break;
        case 'tts':
          actions.setTTSProviderConfig(target.providerId as TTSProviderId, { enabled });
          break;
        case 'webSearch':
          actions.setWebSearchProviderConfig(target.providerId as WebSearchProviderId, { enabled });
          break;
      }
    } catch {
      // 单个模态写失败不应阻断其余模态——与 apply/remove 的隔离口径一致。
    }
  }
}

export interface ApplyResult {
  modality: TokenPlanModality;
  // 'pending' is a UI-only state the settings page sets while a live probe is in
  // flight; applyTokenPlan itself only ever returns 'lit' or 'failed'.
  status: 'pending' | 'lit' | 'failed';
  providerId: string;
  detail?: string;
}

/**
 * Fills the API key into every modality the preset declares and enables it.
 * Each modality is isolated: a thrown setter doesn't abort the others.
 *
 * Note: this fills config synchronously. For LLM, the caller may additionally
 * trigger model probing (via /api/provider/probe-models) to populate the model
 * list — that's async and lives in the UI, not here.
 */
export function applyTokenPlan(
  preset: TokenPlanPreset,
  apiKey: string,
  actions: TokenPlanActions,
): ApplyResult[] {
  const results: ApplyResult[] = [];

  for (const modality of MODALITY_ORDER) {
    const target = preset.modalities[modality];
    if (!target) continue;

    try {
      applyModality(modality, target, preset, apiKey, actions);
      results.push({ modality, status: 'lit', providerId: target.providerId });
    } catch (err) {
      results.push({
        modality,
        status: 'failed',
        providerId: target.providerId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const lit = results.filter((r) => r.status === 'lit').map((r) => r.modality);

  // Enrollment FIRST: with credentials in, the plan counts as connected even
  // if seeding below throws — reconciliation retries the seed on next load.
  if (lit.length > 0) {
    actions.setTokenPlanEnrolled?.(
      preset.id,
      preset.modalities.llm?.providerId ?? results[0].providerId,
    );
    // 重新连接即重新授权：清掉上一连接周期可能残留的「已关闭」标记。
    actions.setTokenPlanEnabled?.(preset.id, true);
  }

  // Seed only the modalities that actually got credentials — seeding a failed
  // modality would switch its active selection onto a keyless provider. The
  // fingerprint is recorded only on seed success, so a failed seed is retried.
  try {
    // 独占槽位（主线模型 / stage route / 各模态选中项）让位给更高优先级的
    // 生效套餐：新连一个靠后的套餐，不应抢走靠前套餐已占的位置。
    seedPlanModels(preset, actions, {
      modalities: lit,
      priorityState: actions.getTokenPlanPriorityState?.(),
    });
    actions.setTokenPlanSeedVersion?.(preset.id, tokenPlanSeedFingerprint(preset));
  } catch {
    // Credentials stand; the startup reconciliation retries on next load
    // (the fingerprint above was deliberately not recorded).
  }

  return results;
}

function catalogModelFor(target: TokenPlanModalityTarget, id: string): ModelInfo | undefined {
  const direct = findModelById(
    target.providerId,
    PROVIDERS[target.providerId as ProviderId]?.models,
    id,
  );
  if (direct) return direct;

  const allModels = Object.values(PROVIDERS).flatMap((provider) => provider.models);
  return (
    allModels.find((m) => m.id === id) ??
    allModels.find((m) => m.id.toLowerCase() === id.toLowerCase())
  );
}

function tokenPlanModelInfo(target: TokenPlanModalityTarget, id: string): ModelInfo {
  const catalog = catalogModelFor(target, id);
  const thinking = getCatalogThinkingCapability(target.providerId, id);
  if (catalog) {
    return {
      ...catalog,
      id,
      name: catalog.name || id,
      capabilities: {
        ...catalog.capabilities,
        ...(thinking ? { thinking } : {}),
      },
    };
  }
  return {
    id,
    name: id,
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      ...(thinking ? { thinking } : {}),
    },
  };
}

/**
 * Seed a plan's model defaults — catalogues, main model, stage routes and the
 * per-modality active selections. Credentials (apiKey/baseUrl) are NOT touched:
 * `applyTokenPlan` writes those first, and the startup reconciliation reuses
 * this to refresh an already-enabled plan whose preset data changed, keeping
 * the user's saved key untouched.
 */
export interface SeedPlanModelsOptions {
  /** Restrict seeding to these modalities (e.g. only those whose credentials
   *  were just written). Omit to seed every declared modality. */
  modalities?: TokenPlanModality[];
  /**
   * 优先级仲裁：多个套餐同时生效时，主线模型与 stage route 这类「独占槽位」
   * 归属更靠前的套餐（顺序即 TOKEN_PLAN_PRESETS / Token Plan 列表顺序）。
   * 传入当前状态后，本次播种会跳过那些已被更高优先级套餐声明的槽位，使得
   * 结果与播种先后无关——无论是新连接一个低优先级套餐，还是启动时按任意
   * 顺序 reconcile，高优先级套餐的声明都不会被覆盖。
   */
  priorityState?: TokenPlanEnrollmentState;
}

/** 比 preset 更高优先级（列表更靠前）且当前生效的套餐。 */
function higherPriorityPlans(
  preset: TokenPlanPreset,
  state: TokenPlanEnrollmentState,
): TokenPlanPreset[] {
  const order = TOKEN_PLAN_PRESETS.findIndex((p) => p.id === preset.id);
  if (order < 0) return [];
  return TOKEN_PLAN_PRESETS.slice(0, order).filter((p) => isTokenPlanUsable(p, state));
}

export function seedPlanModels(
  preset: TokenPlanPreset,
  actions: TokenPlanActions,
  opts?: SeedPlanModelsOptions,
): void {
  const m = preset.modalities;
  const allowed = (modality: TokenPlanModality) =>
    !opts?.modalities || opts.modalities.includes(modality);

  // 独占槽位的让位判定。没有传 priorityState 时（单元测试 / 无状态调用）
  // 退化为「不让位」，保持既有行为。
  const rivals = opts?.priorityState ? higherPriorityPlans(preset, opts.priorityState) : [];
  const mainModelTaken = rivals.some((p) => {
    const llm = p.modalities.llm;
    return !!(llm?.defaultModelId ?? llm?.defaultModels?.[0]);
  });
  const stageTaken = (stage: string) =>
    rivals.some((p) => p.modalities.llm?.stageRoutes?.[stage] !== undefined);

  if (m.llm && allowed('llm')) {
    const target = m.llm;
    // Only overwrite the catalogue when the preset curates one — an LLM-only
    // plan without defaultModels keeps the provider's existing model list.
    // 目录不是独占槽位（每个 provider 一份），不参与让位。
    if (target.defaultModels?.length) {
      actions.setProviderConfig(target.providerId as ProviderId, {
        models: target.defaultModels.map((id) => tokenPlanModelInfo(target, id)),
      });
    }
    const mainModel = target.defaultModelId ?? target.defaultModels?.[0];
    if (mainModel && !mainModelTaken) {
      actions.setModel?.(target.providerId as ProviderId, mainModel);
    }
    for (const [stage, modelId] of Object.entries(target.stageRoutes ?? {})) {
      if (stageTaken(stage)) continue;
      actions.setStageRoute?.(stage, {
        providerId: target.providerId as ProviderId,
        modelId,
      });
    }
  }

  // 各模态的「当前选用 provider」同样是独占槽位：高优先级套餐已声明该模态
  // 时，本套餐只写自己的目录/凭证，不抢走选中态。
  const selectionTaken = (modality: TokenPlanModality) =>
    rivals.some((p) => !!p.modalities[modality]);

  if (m.image && allowed('image')) {
    const customModels = (m.image.defaultModels ?? []).map((id) => ({ id, name: id }));
    if (customModels.length) {
      actions.setImageProviderConfig(m.image.providerId as ImageProviderId, {
        customModels,
        replaceBuiltInModels: true,
      });
      if (!selectionTaken('image')) {
        actions.setImageProvider?.(m.image.providerId as ImageProviderId);
        actions.setImageModelId?.(customModels[0].id);
      }
    }
  }

  if (m.video && allowed('video')) {
    const customModels = (m.video.defaultModels ?? []).map((id) => ({ id, name: id }));
    if (customModels.length) {
      actions.setVideoProviderConfig(m.video.providerId as VideoProviderId, {
        customModels,
        replaceBuiltInModels: true,
      });
      if (!selectionTaken('video')) {
        actions.setVideoProvider?.(m.video.providerId as VideoProviderId);
        actions.setVideoModelId?.(customModels[0].id);
      }
    }
  }

  if (m.tts && allowed('tts')) {
    const ttsModels = (m.tts.defaultModels ?? []).map((id) => ({ id, name: id }));
    actions.setTTSProviderConfig(m.tts.providerId as TTSProviderId, {
      ...(m.tts.defaultModelId ? { modelId: m.tts.defaultModelId } : {}),
      ...(ttsModels.length ? { customModels: ttsModels } : {}),
    });
    if (!selectionTaken('tts')) {
      actions.setTTSProvider?.(m.tts.providerId as TTSProviderId);
    }
  }

  if (m.webSearch && allowed('webSearch') && !selectionTaken('webSearch')) {
    actions.setWebSearchProvider?.(m.webSearch.providerId as WebSearchProviderId);
  }
}

function applyModality(
  modality: TokenPlanModality,
  target: TokenPlanModalityTarget,
  preset: TokenPlanPreset,
  apiKey: string,
  actions: TokenPlanActions,
): void {
  switch (modality) {
    case 'llm':
      actions.setProviderConfig(target.providerId as ProviderId, {
        apiKey,
        baseUrl: target.baseUrl,
        // Connecting a plan authorizes the provider: without this, a provider
        // whose enable toggle was previously off stays disabled while the seed
        // below force-selects it, leaving a contradictory state.
        enabled: true,
        type: target.apiFormat ?? 'openai',
        name: preset.name,
        icon: preset.icon,
        requiresApiKey: true,
        isBuiltIn: false,
        // Seed the model list from the preset's curated `defaultModels`.
        // Token-plan apply never probes individual models; unsupported tier
        // picks surface at generation time instead of being silently pruned.
        ...(target.modelsUrl ? { modelsUrl: target.modelsUrl } : {}),
      });
      break;
    case 'image':
      actions.setImageProviderConfig(target.providerId as ImageProviderId, {
        apiKey,
        baseUrl: target.baseUrl,
        enabled: true,
      });
      break;
    case 'video':
      actions.setVideoProviderConfig(target.providerId as VideoProviderId, {
        apiKey,
        baseUrl: target.baseUrl,
        enabled: true,
      });
      break;
    case 'tts':
      actions.setTTSProviderConfig(target.providerId as TTSProviderId, {
        apiKey,
        baseUrl: target.baseUrl,
        enabled: true,
      });
      break;
    case 'webSearch':
      actions.setWebSearchProviderConfig(target.providerId as WebSearchProviderId, {
        apiKey,
        baseUrl: target.baseUrl,
        enabled: true,
      });
      break;
  }
}

/**
 * Removes a token plan: clears the API key and disables every modality it
 * declared. For LLM, applying overwrote the shared built-in provider in place
 * (baseUrl, models, name, icon, isBuiltIn: false, …), so removal must restore
 * those built-in defaults — not just clear the key — or the provider stays
 * pointed at the plan endpoint with plan-specific model ids. For image/video,
 * the store switches the active selection away when the provider is disabled
 * (see setImageProviderConfig/setVideoProviderConfig). Each modality is isolated
 * — a thrown setter doesn't abort the rest.
 */
export function removeTokenPlan(preset: TokenPlanPreset, actions: TokenPlanActions): ApplyResult[] {
  const results: ApplyResult[] = [];

  // Plans share media providers (e.g. tokendance and volcengine-ark both ride
  // `seedream`): when another ENROLLED plan still targets the same provider,
  // its credentials own it now and clearing them would break that plan.
  const enrollments = actions.getTokenPlanEnrollments?.() ?? {};
  const ownedByOtherPlan = (providerId: string): boolean =>
    Object.keys(enrollments).some((pid) => {
      if (pid === preset.id) return false;
      const other = TOKEN_PLAN_PRESETS.find((p) => p.id === pid);
      if (!other) return false;
      return MODALITY_ORDER.some((m) => other.modalities[m]?.providerId === providerId);
    });

  // Drop the user-level stage routes this plan seeded (courseware / interactive /
  // pro-agent picks), so removal doesn't leave dead routes onto a keyless
  // provider. Stage routes the user later re-pointed elsewhere stay untouched —
  // and so do routes another enrolled plan re-seeded onto the same provider.
  const llmProviderId = preset.modalities.llm?.providerId;
  if (llmProviderId && actions.getStageRoutes && actions.setStageRoute) {
    if (!ownedByOtherPlan(llmProviderId)) {
      for (const [stage, route] of Object.entries(actions.getStageRoutes())) {
        if (route.providerId === llmProviderId) actions.setStageRoute(stage, null);
      }
    }
  }

  for (const modality of MODALITY_ORDER) {
    const target = preset.modalities[modality];
    if (!target) continue;
    if (ownedByOtherPlan(target.providerId)) {
      results.push({ modality, status: 'lit', providerId: target.providerId });
      continue;
    }

    try {
      removeModality(modality, target, actions);
      results.push({ modality, status: 'lit', providerId: target.providerId });
    } catch (err) {
      results.push({
        modality,
        status: 'failed',
        providerId: target.providerId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Always close the book on this plan, whatever happened above. The disabled
  // marker goes too — it describes THIS connection's authorization and must
  // not leak into the next connect cycle.
  actions.setTokenPlanEnrolled?.(preset.id, null);
  actions.setTokenPlanEnabled?.(preset.id, true);
  actions.setTokenPlanSeedVersion?.(preset.id, null);

  return results;
}

function removeModality(
  modality: TokenPlanModality,
  target: TokenPlanModalityTarget,
  actions: TokenPlanActions,
): void {
  switch (modality) {
    case 'llm': {
      // Applying overwrote the built-in provider in place. Restore its built-in
      // defaults so it doesn't linger on the plan endpoint with plan model ids
      // and isBuiltIn:false. The store's LLM resolver then switches the active
      // selection away since the restored config has no key. Custom (non-built-
      // in) providers aren't in the registry — just clear the key for those.
      const builtIn = PROVIDERS[target.providerId as ProviderId];
      if (builtIn) {
        actions.setProviderConfig(target.providerId as ProviderId, {
          apiKey: '',
          baseUrl: '',
          models: builtIn.models,
          name: builtIn.name,
          type: builtIn.type,
          defaultBaseUrl: builtIn.defaultBaseUrl,
          icon: builtIn.icon,
          requiresApiKey: builtIn.requiresApiKey,
          isBuiltIn: true,
          modelsUrl: undefined,
          // 连接时 applyModality 强制 enabled:true（见其注释），解除连接对称
          // 恢复——否则「关开关→断开」后内置 provider 残留 enabled:false，
          // 之后填个人 key 还得手动再开一次。
          enabled: true,
        });
      } else {
        actions.setProviderConfig(target.providerId as ProviderId, { apiKey: '' });
      }
      break;
    }
    case 'image':
      actions.setImageProviderConfig(target.providerId as ImageProviderId, {
        apiKey: '',
        baseUrl: '',
        enabled: false,
        customModels: [],
        replaceBuiltInModels: false,
      });
      break;
    case 'video':
      actions.setVideoProviderConfig(target.providerId as VideoProviderId, {
        apiKey: '',
        baseUrl: '',
        enabled: false,
        customModels: [],
        replaceBuiltInModels: false,
      });
      break;
    case 'tts':
      actions.setTTSProviderConfig(target.providerId as TTSProviderId, {
        apiKey: '',
        baseUrl: '',
        enabled: false,
      });
      break;
    case 'webSearch':
      actions.setWebSearchProviderConfig(target.providerId as WebSearchProviderId, {
        apiKey: '',
        baseUrl: '',
        enabled: false,
      });
      break;
  }
}
