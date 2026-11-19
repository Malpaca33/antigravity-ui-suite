/**
 * @fileoverview 主窗口双栖挂载外壳 (WindowOverlayShell.js).
 *
 * 采用「分离式双 Shadow Host」架构，彻底规避宿主顶栏层叠上下文 (`z-0` / `overflow: hidden`) 裁切与路由重绘卸载问题：
 * 1. `#ag-usage-monitor-capsule`：轻量顶栏胶囊，优先内嵌停靠至 `[class*="@container/titlebar"]` 右侧按钮组，
 *    支持四级迟滞宽度自适应折叠（`wide` -> `compact` -> `minimal` -> `ring-only`），找不到顶栏时自动回退至右上角固定定位；
 * 2. `#ag-usage-monitor-portal`：常驻 `document.body` 顶层的无遮挡浮层宿主，仅承载当前窗口实时运行流与子代理面板 (`wm-multi-panel`)，
 *    在宿主切换会话重建顶栏 DOM 时始终保持组件实例与状态不丢失。
 */

import {
  h,
  isEventInside,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../../core/domPatch.js';
import { formatElapsedSec } from '../../core/formatters.js';
import { deliverCdpBridgeResponses, getWindowBridgeConfig } from '../../core/httpClient.js';
import { createSvgIcon, SVG_NS } from '../../icons/SvgIcon.js';
import {
  extractHostRouteCascadeId,
  fetchTelemetry,
  getAgentBadgeClass,
  normalizeClientTopbarSlots,
  resolveScopedConversation,
  startAsyncTelemetryLoop,
  stopAsyncTelemetryLoop,
  telemetryStore,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';
import { formatTopbarModelSublabel } from '../../views/LiveOverviewView.js';

const CAPSULE_HOST_ID = 'ag-usage-monitor-capsule';
const PORTAL_HOST_ID = 'ag-usage-monitor-portal';
const MULTI_PANEL_WIDTH = 360;
const RING_RADIUS = 10.4;
const RING_CIRCUMFERENCE = +(2 * Math.PI * RING_RADIUS).toFixed(2);

/**
 * 带迟滞区间（Hysteresis）的四阶段顶栏双胶囊响应式宽度计算，避免临界宽度反复跳动。
 * 当左侧多会话入口关闭（`showMulti === false`）时自动释放约 76px 预算给右侧指标胶囊。
 *
 * @param {number} availWidth
 * @param {'wide'|'compact'|'minimal'|'ring-only'} currentMode
 * @param {{ showMulti?: boolean }} [options]
 * @returns {'wide'|'compact'|'minimal'|'ring-only'}
 */
export function computeCapsuleLayoutMode(availWidth, currentMode = 'wide', options = undefined) {
  if (availWidth == null || Number.isNaN(availWidth)) return 'wide';
  const showMulti = options?.showMulti !== false;
  const baseEffWidth = showMulti ? availWidth : availWidth + 76;
  const effWidth = baseEffWidth;
  if (currentMode === 'wide') {
    if (baseEffWidth < 78) return 'ring-only';
    if (effWidth < 196) return 'minimal';
    if (effWidth < 256) return 'compact';
    return 'wide';
  }
  if (currentMode === 'compact') {
    if (effWidth >= 272) return 'wide';
    if (baseEffWidth < 78) return 'ring-only';
    if (effWidth < 196) return 'minimal';
    return 'compact';
  }
  if (currentMode === 'minimal') {
    if (effWidth >= 272) return 'wide';
    if (effWidth >= 212) return 'compact';
    if (baseEffWidth < 78) return 'ring-only';
    return 'minimal';
  }
  if (effWidth >= 272) return 'wide';
  if (effWidth >= 212) return 'compact';
  if (baseEffWidth >= 92) return 'minimal';
  return 'ring-only';
}

function findHostTitlebar() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    return document.querySelector('[class*="@container/titlebar"]');
  } catch {
    return null;
  }
}

function findNativeTopRightAnchor() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
    if (auxToggle?.closest) {
      return auxToggle.closest('div.absolute.right-0.top-0') || auxToggle;
    }
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    for (const btn of candidates) {
      const text = String(btn.textContent || '').trim();
      if (
        (text === 'Open IDE' || text === '打开 IDE' || text.includes('Open IDE') || text.includes('打开 IDE')) &&
        btn.getBoundingClientRect?.().top < 52
      ) {
        return btn.closest?.('div.flex.items-center, div.absolute.right-0') || btn;
      }
    }
    return document.querySelector('div.absolute.right-0.top-0');
  } catch {
    return null;
  }
}

function getLeftSidebarRightEdge(vw) {
  try {
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      const navEl = document.querySelector('div[role="navigation"]');
      if (navEl?.getBoundingClientRect) {
        const nr = navEl.getBoundingClientRect();
        if (nr.width > 0 && nr.left <= 8 && nr.right > 0 && nr.right < vw - 280) {
          return Math.ceil(nr.right);
        }
      }
    }
  } catch {
    // 忽略侧栏测量异常
  }
  return 0;
}

function resolveQuotaCapsuleSummary(quotas) {
  if (!quotas) return null;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const geminiPool =
    pools.find((p) => p?.poolKey === 'Gemini') ||
    pools.find(
      (p) => !THIRD_PARTY_FAMILY_RE.test(String(p?.poolKey || p?.poolLabel || p?.family || ''))
    );
  const activePool =
    quotas.activePool &&
    !THIRD_PARTY_FAMILY_RE.test(
      String(quotas.activePool.poolKey || quotas.activePool.family || quotas.activePool.poolLabel || '')
    )
      ? quotas.activePool
      : null;
  const targetPool = geminiPool || activePool;
  const weekly = quotas.weekly;
  const candidates = [];
  const fiveHourPct =
    targetPool && Number.isFinite(Number(targetPool.remainingPct))
      ? Math.max(0, Math.min(100, Number(targetPool.remainingPct)))
      : null;
  const weeklyPctRaw =
    targetPool && Number.isFinite(Number(targetPool.weeklyRemainingPct))
      ? Number(targetPool.weeklyRemainingPct)
      : weekly &&
          !THIRD_PARTY_FAMILY_RE.test(String(weekly.poolFamily || '')) &&
          Number.isFinite(Number(weekly.remainingPct))
        ? Number(weekly.remainingPct)
        : null;
  const weeklyPct =
    weeklyPctRaw != null ? Math.max(0, Math.min(100, weeklyPctRaw)) : null;

  if (fiveHourPct != null) {
    candidates.push({
      pct: fiveHourPct,
      label: targetPool.poolLabel || targetPool.family || 'Gemini',
      windowTag: '5h',
    });
  }
  if (weeklyPct != null) {
    candidates.push({
      pct: weeklyPct,
      label: targetPool?.poolLabel || targetPool?.family || weekly?.poolFamily || 'Gemini',
      windowTag: '周',
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.pct - b.pct);
  const tightest = candidates[0];
  const rounded = Math.max(0, Math.min(100, Math.round(tightest.pct)));
  return {
    roundedPct: rounded,
    fiveHourPct,
    weeklyPct,
    shortText: `余 ${rounded}%`,
    detailText: candidates
      .map((c) => `${c.label} ${c.windowTag} 余 ${Math.max(0, Math.min(100, Math.round(c.pct)))}%`)
      .join(' · '),
  };
}

const THIRD_PARTY_FAMILY_RE = /claude|gpt|anthropic|openai|3p|sonnet|opus|haiku/i;

/**
 * 解析指定模型池（Gemini 或 Claude & GPT）与指定时间窗口（5h 或周额度）的剩余百分比摘要。
 *
 * @param {object|null|undefined} quotas
 * @param {'gemini_5h'|'gemini_weekly'|'claude_5h'|'claude_weekly'} slotKey
 * @returns {{ roundedPct: number, shortText: string } | null}
 */
function resolveSpecificQuotaSlotSummary(quotas, slotKey) {
  if (!quotas) return null;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const activePool = quotas.activePool || null;
  const isClaude = slotKey.startsWith('claude_');
  const isWeekly = slotKey.endsWith('_weekly');
  let rawPct = null;

  if (isClaude) {
    const claudePool =
      pools.find((p) => p?.poolKey === 'Claude & GPT') ||
      pools.find((p) => THIRD_PARTY_FAMILY_RE.test(String(p?.poolKey || p?.poolLabel || '')));
    const cand = isWeekly ? claudePool?.weeklyRemainingPct : claudePool?.remainingPct;
    if (cand != null && Number.isFinite(Number(cand))) {
      rawPct = Number(cand);
    } else if (
      activePool &&
      THIRD_PARTY_FAMILY_RE.test(String(activePool.family || activePool.poolLabel || ''))
    ) {
      const fb = isWeekly ? activePool.weeklyRemainingPct : activePool.remainingPct;
      if (fb != null && Number.isFinite(Number(fb))) {
        rawPct = Number(fb);
      }
    }
  } else {
    const stdGemini =
      pools.find((p) => p?.poolKey === 'Gemini') ||
      pools.find(
        (p) =>
          /gemini/i.test(String(p?.poolKey || p?.poolLabel || '')) &&
          !/carbon|argon/i.test(String(p?.poolKey || ''))
      );
    const geminiFamilyPools = pools.filter((p) =>
      /gemini|carbon|argon/i.test(String(p?.poolKey || p?.poolLabel || ''))
    );
    const primaryCand = isWeekly ? stdGemini?.weeklyRemainingPct : stdGemini?.remainingPct;
    if (primaryCand != null && Number.isFinite(Number(primaryCand))) {
      rawPct = Number(primaryCand);
    } else {
      const familyVals = geminiFamilyPools
        .map((p) => (isWeekly ? p?.weeklyRemainingPct : p?.remainingPct))
        .filter((v) => v != null && Number.isFinite(Number(v)))
        .map(Number);
      if (familyVals.length > 0) {
        rawPct = Math.min(...familyVals);
      } else if (
        activePool &&
        !THIRD_PARTY_FAMILY_RE.test(String(activePool.family || activePool.poolLabel || ''))
      ) {
        const fb = isWeekly ? activePool.weeklyRemainingPct : activePool.remainingPct;
        if (fb != null && Number.isFinite(Number(fb))) {
          rawPct = Number(fb);
        }
      }
      if (
        rawPct == null &&
        isWeekly &&
        quotas.weekly &&
        !THIRD_PARTY_FAMILY_RE.test(String(quotas.weekly.poolFamily || '')) &&
        quotas.weekly.remainingPct != null &&
        Number.isFinite(Number(quotas.weekly.remainingPct))
      ) {
        rawPct = Number(quotas.weekly.remainingPct);
      }
    }
  }

  if (rawPct == null || !Number.isFinite(rawPct)) return null;
  const rounded = Math.max(0, Math.min(100, Math.round(rawPct)));
  return {
    poolChoice: isClaude ? 'claude' : 'gemini',
    poolLabel: isClaude ? 'Claude & GPT' : 'Gemini',
    roundedPct: rounded,
    fiveHourPct: isWeekly ? null : Number(rawPct),
    weeklyPct: isWeekly ? Number(rawPct) : null,
    shortText: `余 ${rounded}%`,
    detailText: `${isClaude ? 'Claude & GPT' : 'Gemini'} ${isWeekly ? '周' : '5h'} 余 ${rounded}%`,
  };
}

const DOT_FONT_5X7 = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '.': ['00', '00', '00', '00', '00', '11', '11'],
  '-': ['0000', '0000', '0000', '1111', '0000', '0000', '0000'],
};

function updateDotMatrixSvg(svgEl, text) {
  const str = String(text || '--');
  let colOffset = 0;
  const glyphs = [];
  for (let i = 0; i < str.length; i += 1) {
    const g = DOT_FONT_5X7[str[i]];
    if (!g) continue;
    if (glyphs.length > 0) colOffset += 1;
    glyphs.push({ rows: g, startCol: colOffset, cols: g[0].length });
    colOffset += g[0].length;
  }
  const totalCols = Math.max(1, colOffset);
  const pitch = 2;
  const svgW = totalCols * pitch;
  const svgH = 7 * pitch;
  svgEl.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
  if (svgEl.style) {
    svgEl.style.width = `${Math.round((svgW * 13) / svgH)}px`;
    svgEl.style.height = '13px';
  }
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  for (const glyph of glyphs) {
    for (let r = 0; r < glyph.rows.length; r += 1) {
      const rowStr = glyph.rows[r];
      for (let c = 0; c < rowStr.length; c += 1) {
        if (rowStr[c] !== '1') continue;
        const dot = document.createElementNS(SVG_NS, 'rect');
        dot.setAttribute('x', String((glyph.startCol + c) * pitch + 0.14));
        dot.setAttribute('y', String(r * pitch + 0.14));
        dot.setAttribute('width', '1.72');
        dot.setAttribute('height', '1.72');
        dot.setAttribute('rx', '0.62');
        dot.setAttribute('fill', 'currentColor');
        svgEl.appendChild(dot);
      }
    }
  }
}

function resolveSpeedTierClass(tps, hasValidTps) {
  if (!hasValidTps || !Number.isFinite(tps) || tps < 46) return 'speed-tier-low';
  if (tps < 100) return 'speed-tier-green';
  if (tps < 180) return 'speed-tier-orange';
  return 'speed-tier-purple';
}

function formatCompactContextLimit(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return '--';
  const k = Math.round(n / 1000);
  if (n >= 1000000 && k !== 1024) {
    const m = +(n / (n % 1048576 === 0 ? 1048576 : 1000000)).toFixed(1);
    return `${m}M`;
  }
  return `${k}k`;
}

function readSelectedModelTextFromHostDom() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
    return '';
  }
  const btn = document.querySelector(
    'button[aria-label^="Select model"], button[aria-label*="模型"]'
  );
  if (!btn) return '';
  return String(btn.getAttribute?.('aria-label') || btn.textContent || '').trim();
}

function detectActiveModelQuotaPool(telemetry, activeConv) {
  const domModelHint = readSelectedModelTextFromHostDom();
  if (domModelHint) {
    return THIRD_PARTY_FAMILY_RE.test(domModelHint) ? 'claude' : 'gemini';
  }
  const modelHint = [
    activeConv?.activeModelLabel,
    activeConv?.activeModelShort,
    activeConv?.activeModelUpstream,
    telemetry?.quotas?.activePool?.poolKey,
    telemetry?.quotas?.activePool?.poolLabel,
    telemetry?.quotas?.activePool?.family,
  ]
    .filter(Boolean)
    .join(' ');
  return THIRD_PARTY_FAMILY_RE.test(modelHint) ? 'claude' : 'gemini';
}

function resolveQuotaPoolBatterySummary(quotas, poolChoice = 'gemini') {
  if (!quotas) return null;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const isClaude = poolChoice === 'claude';
  let targetPool = null;
  if (isClaude) {
    targetPool =
      pools.find((p) => p?.poolKey === 'Claude & GPT') ||
      pools.find((p) =>
        THIRD_PARTY_FAMILY_RE.test(String(p?.poolKey || p?.poolLabel || p?.family || ''))
      ) ||
      (quotas.activePool &&
      THIRD_PARTY_FAMILY_RE.test(
        String(quotas.activePool.poolKey || quotas.activePool.family || quotas.activePool.poolLabel || '')
      )
        ? quotas.activePool
        : null);
  } else {
    targetPool =
      pools.find((p) => p?.poolKey === 'Gemini') ||
      pools.find(
        (p) => !THIRD_PARTY_FAMILY_RE.test(String(p?.poolKey || p?.poolLabel || p?.family || ''))
      ) ||
      (quotas.activePool &&
      !THIRD_PARTY_FAMILY_RE.test(
        String(quotas.activePool.poolKey || quotas.activePool.family || quotas.activePool.poolLabel || '')
      )
        ? quotas.activePool
        : null);
  }
  const weekly = quotas.weekly;
  const weeklyMatchesPool =
    weekly &&
    (isClaude
      ? THIRD_PARTY_FAMILY_RE.test(String(weekly.poolFamily || ''))
      : !THIRD_PARTY_FAMILY_RE.test(String(weekly.poolFamily || '')));
  const fiveHourPct =
    targetPool && Number.isFinite(Number(targetPool.remainingPct))
      ? Math.max(0, Math.min(100, Number(targetPool.remainingPct)))
      : null;
  const weeklyPctRaw =
    targetPool && Number.isFinite(Number(targetPool.weeklyRemainingPct))
      ? Number(targetPool.weeklyRemainingPct)
      : weeklyMatchesPool && Number.isFinite(Number(weekly.remainingPct))
        ? Number(weekly.remainingPct)
        : null;
  const weeklyPct = weeklyPctRaw != null ? Math.max(0, Math.min(100, weeklyPctRaw)) : null;
  const poolLabel = isClaude ? 'Claude & GPT' : 'Gemini';
  const parts = [];
  if (fiveHourPct != null) parts.push(`${poolLabel} 5h 余 ${Math.round(fiveHourPct)}%`);
  if (weeklyPct != null) parts.push(`周 余 ${Math.round(weeklyPct)}%`);
  const tightest = [fiveHourPct, weeklyPct].filter((v) => v != null);
  const roundedPct = tightest.length > 0 ? Math.round(Math.min(...tightest)) : null;
  return {
    poolChoice: isClaude ? 'claude' : 'gemini',
    poolLabel,
    roundedPct,
    fiveHourPct,
    weeklyPct,
    shortText: roundedPct != null ? `余 ${roundedPct}%` : '余 --%',
    detailText: parts.join(' · ') || `${poolLabel} 额度暂无数据`,
  };
}

function formatCompactCapsuleCost(stepCost) {
  if (stepCost == null || !Number.isFinite(Number(stepCost))) return '--';
  const val = Math.max(0, Number(stepCost));
  if (val === 0) return '$0.00';
  if (val < 0.001) return '<$0.001';
  if (val < 1) return `$${val.toFixed(3)}`;
  if (val < 100) return `$${val.toFixed(2)}`;
  return `$${Math.round(val)}`;
}

function formatCompactCapsuleTtft(ttftSec) {
  if (ttftSec == null || !Number.isFinite(Number(ttftSec)) || Number(ttftSec) < 0) return '--s';
  const val = Number(ttftSec);
  if (val < 1) return `${val.toFixed(2)}s`;
  if (val < 100) return `${val.toFixed(1)}s`;
  return `${Math.round(val)}s`;
}

/**
 * 在主窗口挂载双栖顶栏胶囊与当前窗口实时运行流面板，并注册 `window.__AGUsageMonitorOverlay` 生命周期句柄。
 */
export function mountWindowOverlay() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;

  // 先读取旧实例缓存的遥测快照与展开态（热升级时无缝承接数据与悬停状态，杜绝闪烁或关开），再安全卸载旧实例
  let carryOverTelemetry = null;
  let carryOverMultiHoverOpen = false;
  let carryOverMultiPinnedOpen = false;
  let carryOverPointer = null;
  try {
    const prevOv = window.__AGUsageMonitorOverlay;
    carryOverTelemetry = prevOv?.getTelemetrySnapshot?.() || null;
    carryOverMultiHoverOpen = Boolean(prevOv?.isMultiHoverOpen?.());
    carryOverMultiPinnedOpen = Boolean(prevOv?.isMultiPinnedOpen?.());
    carryOverPointer = prevOv?.getLastPointer?.() || null;
    prevOv?.dispose?.();
  } catch {
    // 忽略旧实例卸载异常
  }
  try {
    document.getElementById(CAPSULE_HOST_ID)?.remove?.();
    document.getElementById(PORTAL_HOST_ID)?.remove?.();
  } catch {
    // 忽略残留节点清理异常
  }

  const bridgeConfig = getWindowBridgeConfig();
  const bundleVersion = String(bridgeConfig?.bundleVersion || '');
  const stylesCss = String(bridgeConfig?.stylesCss || '');
  const seedTelemetry =
    (bridgeConfig?.initialTelemetry && typeof bridgeConfig.initialTelemetry === 'object'
      ? bridgeConfig.initialTelemetry
      : null) || carryOverTelemetry;
  if (bridgeConfig?.initialTelemetry) {
    delete bridgeConfig.initialTelemetry;
  }
  if (seedTelemetry) {
    telemetryStore.setState({
      telemetry: seedTelemetry,
      minuteTick: Math.floor(Date.now() / 30000),
      syncState: 'idle',
    });
  }

  let disposed = false;
  let multiOpen = false;
  let multiPinned = false;
  let multiLeaveTimer = null;
  const manualSubExpandMap = new Map();
  const multiTimersMap = new Map();
  let multiLiveTickTimer = null;
  let hasPointerCoords = Boolean(
    carryOverPointer &&
      Number.isFinite(carryOverPointer.x) &&
      Number.isFinite(carryOverPointer.y)
  );
  let lastPointerX = hasPointerCoords ? carryOverPointer.x : -1;
  let lastPointerY = hasPointerCoords ? carryOverPointer.y : -1;
  let layoutMode = 'wide';
  let observedTitlebar = null;
  let dockRafId = 0;
  let lastObservedRouteId = extractHostRouteCascadeId();

  function recordPointerCoords(e) {
    if (e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      hasPointerCoords = true;
    }
  }

  function isPointerInMultiZone() {
    if (!hasPointerCoords || document.hidden || multiBtn.hasAttribute('hidden')) {
      return false;
    }
    if (multiBtn.getBoundingClientRect) {
      const mr = multiBtn.getBoundingClientRect();
      if (
        mr.width > 0 &&
        mr.height > 0 &&
        lastPointerX >= mr.left - 1 &&
        lastPointerX <= mr.right + 1 &&
        lastPointerY >= mr.top - 1 &&
        lastPointerY <= mr.bottom + 10
      ) {
        return true;
      }
    }
    if (multiOpen && multiPanelEl.getBoundingClientRect) {
      const pr = multiPanelEl.getBoundingClientRect();
      if (
        pr.width > 0 &&
        pr.height > 0 &&
        lastPointerX >= pr.left - 1 &&
        lastPointerX <= pr.right + 1 &&
        lastPointerY >= pr.top - 4 &&
        lastPointerY <= pr.bottom + 1
      ) {
        return true;
      }
    }
    return false;
  }

  function scheduleMultiHoverClose() {
    if (multiLeaveTimer) {
      clearTimeout(multiLeaveTimer);
    }
    multiLeaveTimer = setTimeout(() => {
      multiLeaveTimer = null;
      if (disposed || multiPinned || !multiOpen) return;
      let nativeHover = false;
      try {
        nativeHover = Boolean(
          multiBtn.matches?.(':hover') || multiPanelEl.matches?.(':hover')
        );
      } catch {
        nativeHover = false;
      }
      if (nativeHover || isPointerInMultiZone()) {
        return;
      }
      setMultiOpen(false);
    }, 90);
  }

  function bindMultiElapsedTimer(timerKey, sig, rawStartMs, targetEl) {
    const now = Date.now();
    const prev = multiTimersMap.get(timerKey);
    let startMs = prev?.startMs || 0;
    if (!prev || prev.sig !== sig) {
      const validRaw = Number(rawStartMs || 0);
      startMs = validRaw > 0 && validRaw <= now + 2000 ? validRaw : now;
    } else if (startMs <= 0 && Number(rawStartMs) > 0 && Number(rawStartMs) <= now + 2000) {
      startMs = Number(rawStartMs);
    }
    multiTimersMap.set(timerKey, { sig, startMs, el: targetEl });
    const elapsedSec = Math.max(0, (now - startMs) / 1000);
    patchText(targetEl, formatElapsedSec(elapsedSec));
  }

  function tickMultiElapsedDisplay() {
    const now = Date.now();
    for (const entry of multiTimersMap.values()) {
      if (!entry?.el) continue;
      const elapsedSec = entry.startMs > 0 ? Math.max(0, (now - entry.startMs) / 1000) : 0;
      patchText(entry.el, formatElapsedSec(elapsedSec));
    }
  }

  function stopMultiLiveTicker() {
    if (multiLiveTickTimer) {
      clearInterval(multiLiveTickTimer);
      multiLiveTickTimer = null;
    }
    multiTimersMap.clear();
  }

  function ensureMultiLiveTicker() {
    if (multiTimersMap.size === 0) {
      stopMultiLiveTicker();
      return;
    }
    if (!multiLiveTickTimer) {
      multiLiveTickTimer = setInterval(tickMultiElapsedDisplay, 1000);
    }
  }

  // --- 1. 创建顶栏双胶囊 Shadow Host（左：多会话实时信息；右：单会话指标胶囊） ---
  const capsuleHost = document.createElement('div');
  capsuleHost.id = CAPSULE_HOST_ID;
  capsuleHost.className = 'wm-capsule-host';
  capsuleHost.setAttribute('data-dock', 'fixed');
  capsuleHost.setAttribute('data-layout', layoutMode);
  const capsuleShadow = capsuleHost.attachShadow({ mode: 'open' });

  const capsuleStyleEl = document.createElement('style');
  capsuleStyleEl.textContent = stylesCss;
  capsuleShadow.appendChild(capsuleStyleEl);

  // 左侧无边框当前窗口子代理状态按钮（展示当前窗口运行流与子代理数，点击固定/悬停预览当前窗口任务面板）
  const multiDot = h('span', { className: 'wm-multi-dot' });
  const multiLabel = h('span', { className: 'wm-multi-label', text: '0 子代理' });
  const multiBtn = h(
    'button',
    {
      type: 'button',
      className: 'wm-multi-btn',
      'aria-label': '当前窗口运行流与子代理',
      'aria-expanded': 'false',
      onClick: (e) => {
        e.stopPropagation();
        if (multiOpen && multiPinned) {
          setMultiOpen(false);
        } else {
          setMultiOpen(true, { pinned: true });
        }
      },
      onContextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        void fetchTelemetry({ force: true });
      },
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (multiLeaveTimer) {
          clearTimeout(multiLeaveTimer);
          multiLeaveTimer = null;
        }
        if (!multiPinned) {
          setMultiOpen(true, { pinned: false });
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (!multiPinned) {
          scheduleMultiHoverClose();
        }
      },
    },
    [multiDot, multiLabel]
  );

  let manualQuotaPoolOverride = null;
  let lastAutoQuotaPool = 'gemini';

  // 构建可复用的预占胶囊槽位节点（context 挂载 2× 半径环形 SVG；tps 挂载复古点阵速度+模型小字；quota 挂载 7 格 Mac 电池+外圈复古红周限额+池标注）
  function createCapsuleSlot(slotIndex, initialMetric) {
    const ringSvg = document.createElementNS(SVG_NS, 'svg');
    ringSvg.setAttribute('viewBox', '0 0 26 26');
    ringSvg.setAttribute('class', 'wm-ring-svg');
    ringSvg.setAttribute('aria-hidden', 'true');

    const ringTrack = document.createElementNS(SVG_NS, 'circle');
    ringTrack.setAttribute('cx', '13');
    ringTrack.setAttribute('cy', '13');
    ringTrack.setAttribute('r', String(RING_RADIUS));
    ringTrack.setAttribute('class', 'wm-ring-track');

    const ringFill = document.createElementNS(SVG_NS, 'circle');
    ringFill.setAttribute('cx', '13');
    ringFill.setAttribute('cy', '13');
    ringFill.setAttribute('r', String(RING_RADIUS));
    ringFill.setAttribute('class', 'wm-ring-fill');
    ringFill.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
    ringFill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));

    ringSvg.appendChild(ringTrack);
    ringSvg.appendChild(ringFill);

    // 速度槽位：复古点阵数字 SVG + 常规单位 + 无障碍完整文本 + 底部模型小字
    const speedDotSvg = document.createElementNS(SVG_NS, 'svg');
    speedDotSvg.setAttribute('viewBox', '0 0 18 14');
    speedDotSvg.setAttribute('class', 'wm-speed-dot-svg');
    speedDotSvg.setAttribute('aria-hidden', 'true');
    updateDotMatrixSvg(speedDotSvg, '--');

    const speedUnitSpan = h('span', { className: 'wm-speed-unit', text: 't/s' });
    const speedStatusSpan = h('span', { className: 'wm-speed-status', hidden: true, text: '' });
    const speedSrText = h('span', {
      className: 'wm-slot-text wm-speed-text wm-speed-sr',
      text: '-- t/s',
    });
    const speedTopRow = h('span', { className: 'wm-speed-top' }, [
      speedDotSvg,
      speedUnitSpan,
      speedStatusSpan,
      speedSrText,
    ]);

    // 7 格 Mac 电池 (5h 窗口) + 外侧高对比周限额 SVG 边框 + 底部额度池小字
    const weeklySvg = document.createElementNS(SVG_NS, 'svg');
    weeklySvg.setAttribute('viewBox', '0 0 44 15');
    weeklySvg.setAttribute('class', 'wm-bat-weekly-svg');
    weeklySvg.setAttribute('aria-hidden', 'true');

    const weeklyTrack = document.createElementNS(SVG_NS, 'rect');
    weeklyTrack.setAttribute('x', '1');
    weeklyTrack.setAttribute('y', '1');
    weeklyTrack.setAttribute('width', '42');
    weeklyTrack.setAttribute('height', '13');
    weeklyTrack.setAttribute('rx', '3.8');
    weeklyTrack.setAttribute('ry', '3.8');
    weeklyTrack.setAttribute('class', 'wm-bat-weekly-track');

    const weeklyFill = document.createElementNS(SVG_NS, 'rect');
    weeklyFill.setAttribute('x', '1');
    weeklyFill.setAttribute('y', '1');
    weeklyFill.setAttribute('width', '42');
    weeklyFill.setAttribute('height', '13');
    weeklyFill.setAttribute('rx', '3.8');
    weeklyFill.setAttribute('ry', '3.8');
    weeklyFill.setAttribute('pathLength', '100');
    weeklyFill.setAttribute('stroke-dasharray', '100');
    weeklyFill.setAttribute('stroke-dashoffset', '100');
    weeklyFill.setAttribute('class', 'wm-bat-weekly-fill is-empty');

    weeklySvg.appendChild(weeklyTrack);
    weeklySvg.appendChild(weeklyFill);

    const batCells = Array.from({ length: 7 }, () => {
      const fill = h('span', { className: 'wm-bat-cell-fill' });
      const cell = h('span', { className: 'wm-bat-cell' }, [fill]);
      return { cell, fill };
    });
    const batBody = h(
      'span',
      { className: 'wm-bat-body' },
      batCells.map((c) => c.cell)
    );
    const batNub = h('span', { className: 'wm-bat-nub', 'aria-hidden': 'true' });
    const batShell = h('span', { className: 'wm-bat-shell', 'data-pool': 'gemini' }, [batBody, batNub]);
    const batWrap = h('span', { className: 'wm-bat-wrap' }, [weeklySvg, batShell]);
    const quotaPoolSpan = h('span', { className: 'wm-quota-pool-label', text: 'Gemini' });

    const isCtx = initialMetric === 'context';
    const isTps = initialMetric === 'tps';
    const isQuota = !isCtx && !isTps && initialMetric !== 'ttft' && initialMetric !== 'cost';

    const textSpan = h('span', {
      className: isCtx ? 'wm-slot-text wm-ctx-pct' : 'wm-slot-text',
      text: isCtx ? '--%' : '',
    });
    const ctxLimitSpan = h('span', {
      className: 'wm-ctx-limit',
      text: '--',
    });
    const ctxCol = h('span', { className: 'wm-ctx-col' }, isCtx ? [textSpan, ctxLimitSpan] : [ctxLimitSpan]);
    const modelSpan = h('span', {
      className: 'wm-speed-model',
      text: '',
    });

    const initialChildren = isCtx
      ? [ringSvg, ctxCol]
      : isTps
        ? [speedTopRow, modelSpan]
        : isQuota
          ? [batWrap, quotaPoolSpan]
          : [textSpan];

    const slotState = {
      el: null,
      ringSvg,
      ringFill,
      textSpan,
      ctxCol,
      ctxLimitSpan,
      speedTopRow,
      speedDotSvg,
      speedUnitSpan,
      speedStatusSpan,
      speedSrText,
      lastDotText: '--',
      modelSpan,
      batWrap,
      batShell,
      batCells,
      weeklyFill,
      quotaPoolSpan,
      ringMounted: isCtx,
      ctxColMounted: isCtx,
      textMounted: !isCtx && !isQuota && !isTps,
      speedMounted: isTps,
      modelMounted: isTps,
      batteryMounted: isQuota,
    };

    slotState.el = h(
      'span',
      {
        className: isCtx
          ? 'wm-cap-slot wm-ctx-seg'
          : isTps
            ? 'wm-cap-slot wm-seg-speed speed-tier-low'
            : 'wm-cap-slot wm-seg-quota',
        'data-slot-idx': String(slotIndex),
        'data-metric': initialMetric,
        'data-vis-rank': String(slotIndex + 1),
        onClick: (e) => {
          if (!slotState.batteryMounted) return;
          e.stopPropagation();
          const shownPool = manualQuotaPoolOverride || lastAutoQuotaPool;
          manualQuotaPoolOverride = shownPool === 'claude' ? 'gemini' : 'claude';
          renderCapsuleTelemetry();
        },
      },
      initialChildren
    );

    return slotState;
  }

  const capsuleSlots = [
    createCapsuleSlot(0, 'context'),
    createCapsuleSlot(1, 'tps'),
    createCapsuleSlot(2, 'quota_auto'),
  ];
  const sep0 = h('span', { className: 'wm-sep wm-sep-speed', 'data-sep-for-rank': '2' });
  const sep1 = h('span', { className: 'wm-sep wm-sep-quota', 'data-sep-for-rank': '3' });
  let lastShowMulti = true;

  const capsuleBtn = h(
    'div',
    {
      className: 'wm-capsule-btn',
      'aria-label': '用量与速度监控',
      onContextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        void fetchTelemetry({ force: true });
      },
    },
    [capsuleSlots[0].el, sep0, capsuleSlots[1].el, sep1, capsuleSlots[2].el]
  );
  capsuleShadow.appendChild(multiBtn);
  capsuleShadow.appendChild(capsuleBtn);

  // --- 2. 创建 Body 顶层浮层 Portal Shadow Host ---
  const portalHost = document.createElement('div');
  portalHost.id = PORTAL_HOST_ID;
  portalHost.className = 'wm-portal-host';
  const portalShadow = portalHost.attachShadow({ mode: 'open' });

  const portalStyleEl = document.createElement('style');
  portalStyleEl.textContent = stylesCss;
  portalShadow.appendChild(portalStyleEl);

  // 左侧多会话实时看板浮层（活跃运行会话卡片 + 近期多窗口会话速览，全槽位预占、就地补丁更新）
  function createMultiLiveSubRow() {
    const subBadge = h('span', { className: 'agent-badge badge-sub-1', text: '子1' });
    const subRole = h('span', { className: 'live-sub-role', text: '子代理' });
    const subSummary = h('span', { className: 'live-sub-summary', text: '' });
    const subElapsed = h('span', { className: 'live-sub-elapsed text-mono', text: '0s' });
    const rowEl = h('div', { className: 'live-sub-row' }, [
      h('div', { className: 'live-sub-left' }, [subBadge, subRole, subSummary]),
      subElapsed,
    ]);
    return {
      el: rowEl,
      refs: { rowEl, subBadge, subRole, subSummary, subElapsed },
    };
  }

  function createMultiLiveTaskCard() {
    const dotIcon = createSvgIcon('dot', { size: 11 });
    patchClasses(dotIcon, { 'is-pulsing': true });
    const dotWrap = h('span', { className: 'live-activity-dot' }, [dotIcon]);
    const titleEl = h('strong', { className: 'live-task-title', text: '当前会话' });
    const hereTagEl = h('span', {
      className: 'wm-session-tag is-here',
      hidden: true,
      text: '本窗',
    });
    const metricsEl = h('span', {
      className: 'wm-task-metrics text-mono',
      hidden: true,
      text: '',
    });
    const subToggleBtn = h('button', {
      type: 'button',
      className: 'live-sub-toggle',
      hidden: true,
      text: '子代理 (0) ▸',
    });
    const elapsedEl = h('span', {
      className: 'live-activity-elapsed text-mono',
      text: '0s',
    });

    const headerEl = h('div', { className: 'live-task-header' }, [
      h('div', { className: 'live-task-title-wrap' }, [dotWrap, titleEl, hereTagEl]),
      h('div', { className: 'live-task-header-right' }, [metricsEl, subToggleBtn, elapsedEl]),
    ]);

    const mainBadge = h('span', {
      className: 'agent-badge badge-main',
      hidden: true,
      text: '主',
    });
    const mainPhase = h('strong', { className: 'live-activity-phase', text: '推理中' });
    const mainProgress = h('span', {
      className: 'live-activity-progress text-mono',
      hidden: true,
      text: '',
    });
    const mainSep = h('span', { className: 'live-activity-sep', hidden: true, text: '·' });
    const mainDetail = h('span', {
      className: 'live-activity-detail',
      hidden: true,
      text: '',
    });

    const mainRowEl = h('div', { className: 'live-task-main-row' }, [
      mainBadge,
      mainPhase,
      mainProgress,
      mainSep,
      mainDetail,
    ]);

    const subListEl = h('div', { className: 'live-sub-list', hidden: true });
    const cardEl = h('div', { className: 'live-task-card' }, [headerEl, mainRowEl, subListEl]);

    return {
      el: cardEl,
      refs: {
        cardEl,
        dotIcon,
        titleEl,
        hereTagEl,
        metricsEl,
        subToggleBtn,
        elapsedEl,
        mainBadge,
        mainPhase,
        mainProgress,
        mainSep,
        mainDetail,
        subListEl,
      },
    };
  }

  const multiPinBadge = h('span', { className: 'wm-pin-badge', hidden: true, text: '已固定' });
  const multiRunningMetaEl = h('span', { className: 'panel-meta text-mono', text: '读取中...' });
  const multiEmptyEl = h('div', { className: 'wm-multi-empty' }, [
    h('span', { className: 'wm-multi-empty-left' }, [
      h('span', { className: 'wm-idle-dot' }),
      h('span', { text: '当前对话暂无子代理或运行流' }),
    ]),
  ]);
  const multiRunningListEl = h('div', {
    className: 'live-activity-list',
    hidden: true,
    'aria-live': 'polite',
  });

  const multiHeaderEl = h('div', { className: 'panel-header wm-multi-header' }, [
    h('span', { className: 'panel-title' }, [
      createSvgIcon('pulse', { size: 13 }),
      h('span', { text: '当前运行流与子代理' }),
      multiPinBadge,
    ]),
    multiRunningMetaEl,
  ]);

  const multiPanelEl = h(
    'div',
    {
      className: 'wm-multi-panel',
      role: 'dialog',
      'aria-label': '当前窗口运行流与子代理面板',
      hidden: true,
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (multiLeaveTimer) {
          clearTimeout(multiLeaveTimer);
          multiLeaveTimer = null;
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (!multiPinned) {
          scheduleMultiHoverClose();
        }
      },
    },
    [multiHeaderEl, multiEmptyEl, multiRunningListEl]
  );

  portalShadow.appendChild(multiPanelEl);
  (document.body || document.documentElement).appendChild(portalHost);

  // --- 3. 几何测量、顶栏停靠与防溢出定位 ---
  function updateFixedFallbackPosition() {
    if (capsuleHost.getAttribute('data-dock') === 'flow') {
      capsuleHost.style.top = '';
      capsuleHost.style.right = '';
      return;
    }
    try {
      const vw = Number(window.innerWidth || 1280);
      let rightOffset = 144;
      const anchor = findNativeTopRightAnchor();
      if (anchor?.getBoundingClientRect) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0 && r.left > 0 && r.left < vw) {
          rightOffset = Math.max(144, Math.ceil(vw - r.left + 6));
        }
      }
      capsuleHost.style.top = '7px';
      capsuleHost.style.right = `${rightOffset}px`;
    } catch {
      // 忽略回退坐标计算异常
    }
  }

  function measureAvailableTitlebarWidth(titlebar) {
    try {
      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          const titleEl = titlebar.firstElementChild;
          const titleInner = titleEl?.firstElementChild;
          const contentStart = titleInner?.getBoundingClientRect
            ? Math.max(8, titleInner.getBoundingClientRect().left - tbRect.left)
            : tbRect.left < 168
              ? 168 - tbRect.left
              : 12;
          const minTitleWidth = 180;
          let siblingButtonsWidth = 64;
          let rightPad = 8;
          const rightGroup = capsuleHost.parentElement;
          if (rightGroup && rightGroup !== titlebar) {
            const auxOpen =
              typeof document.querySelector === 'function' &&
              Boolean(document.querySelector('[data-testid="aux-pane-sash"]'));
            const root =
              typeof document.querySelector === 'function'
                ? document.querySelector('div.h-screen.w-screen')
                : null;
            const rightClusterVar =
              root?.style?.getPropertyValue?.('--right-cluster-width')?.trim() || '';
            if (auxOpen) {
              rightPad = 8;
            } else if (rightClusterVar) {
              rightPad = Math.max(8, (parseFloat(rightClusterVar) || 44) - 4);
            } else if (typeof window.getComputedStyle === 'function') {
              rightPad = parseFloat(window.getComputedStyle(rightGroup).paddingRight) || 0;
            }
            if (rightGroup.children) {
              let sum = 0;
              for (const child of rightGroup.children) {
                if (child !== capsuleHost && child.getBoundingClientRect) {
                  sum += child.getBoundingClientRect().width;
                }
              }
              if (sum > 0) siblingButtonsWidth = sum + 8;
            }
          }
          return tbRect.width - contentStart - minTitleWidth - rightPad - siblingButtonsWidth;
        }
      }
      if (window.innerWidth) {
        return window.innerWidth - 360;
      }
    } catch {
      // 忽略测量异常
    }
    return 320;
  }

  function positionFloatingElements() {
    if (disposed || !capsuleBtn.getBoundingClientRect) return;
    try {
      const bRect = capsuleBtn.getBoundingClientRect();
      if (bRect.width === 0 && bRect.height === 0) return;
      const vw = Number(window.innerWidth || 1280);
      const vh = Number(window.innerHeight || 800);
      const navRight = getLeftSidebarRightEdge(vw);
      const minLeft = navRight > 0 ? Math.max(12, navRight + 12) : 12;
      const defaultMultiW = Math.min(MULTI_PANEL_WIDTH, Math.max(280, vw - 24));

      if (multiOpen) {
        const mRect = multiBtn.getBoundingClientRect?.() || bRect;
        const anchorRect = mRect.width > 0 || mRect.height > 0 ? mRect : bRect;
        const rawW =
          Number(multiPanelEl.offsetWidth) ||
          Number(multiPanelEl.getBoundingClientRect?.().width) ||
          defaultMultiW;
        const panelW = Math.min(rawW, Math.max(280, vw - minLeft - 12));
        const panelH =
          Number(multiPanelEl.offsetHeight) ||
          Number(multiPanelEl.getBoundingClientRect?.().height) ||
          320;
        let top = Math.max(38, Math.round(anchorRect.bottom + 6));
        if (top + panelH > vh - 8 && anchorRect.top > panelH + 12) {
          top = Math.round(anchorRect.top - panelH - 6);
        }
        let left = Math.round(anchorRect.left);
        left = Math.min(left, vw - panelW - 12);
        left = Math.max(minLeft, left);
        multiPanelEl.style.top = `${top}px`;
        multiPanelEl.style.left = `${left}px`;
        multiPanelEl.style.maxHeight = `${Math.max(240, vh - top - 12)}px`;
      }
    } catch {
      // 忽略定位异常
    }
  }

  function updateResponsiveLayout() {
    if (disposed) return;
    const titlebar = findHostTitlebar();
    const avail = measureAvailableTitlebarWidth(titlebar);
    const curTel = telemetryStore.getState().telemetry;
    const showMulti = curTel?.settings?.showTopbarMultiSession !== false;
    const nextMode = computeCapsuleLayoutMode(avail, layoutMode, { showMulti });
    if (nextMode !== layoutMode) {
      layoutMode = nextMode;
      capsuleHost.setAttribute('data-layout', layoutMode);
    }
    if (capsuleHost.getAttribute('data-dock') === 'fixed') {
      updateFixedFallbackPosition();
    }
    if (multiOpen) {
      positionFloatingElements();
    }
  }

  let resizeObserver = null;

  function ensureCapsuleDocked() {
    if (disposed) return false;
    const bodyOrDoc = document.body || document.documentElement;
    if (bodyOrDoc && !portalHost.isConnected) {
      bodyOrDoc.appendChild(portalHost);
    }

    const titlebar = findHostTitlebar();
    if (titlebar) {
      let targetContainer = titlebar;
      try {
        const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
        if (rightGroup && rightGroup !== titlebar.firstElementChild) {
          targetContainer = rightGroup;
        }
      } catch {
        // 忽略子选择器不兼容场景
      }

      if (capsuleHost.parentElement !== targetContainer) {
        if (targetContainer.firstChild && targetContainer !== titlebar) {
          targetContainer.insertBefore(capsuleHost, targetContainer.firstChild);
        } else {
          targetContainer.appendChild(capsuleHost);
        }
      }
      patchAttr(capsuleHost, 'data-dock', 'flow');
      if (capsuleHost.style.top) capsuleHost.style.top = '';
      if (capsuleHost.style.right) capsuleHost.style.right = '';

      if (observedTitlebar !== titlebar) {
        observedTitlebar = titlebar;
        try {
          if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver.observe(titlebar);
            if (document.body) resizeObserver.observe(document.body);
          }
        } catch {
          // 忽略观察器异常
        }
      }
    } else if (bodyOrDoc) {
      if (capsuleHost.parentElement !== bodyOrDoc) {
        bodyOrDoc.appendChild(capsuleHost);
      }
      patchAttr(capsuleHost, 'data-dock', 'fixed');
      updateFixedFallbackPosition();
    }

    updateResponsiveLayout();
    return Boolean(capsuleHost.isConnected && portalHost.isConnected);
  }

  function scheduleDockSync() {
    if (disposed) return;
    if (typeof requestAnimationFrame === 'function') {
      if (dockRafId) return;
      dockRafId = requestAnimationFrame(() => {
        dockRafId = 0;
        ensureCapsuleDocked();
      });
    } else {
      ensureCapsuleDocked();
    }
  }

  function setMultiOpen(nextOpen, { pinned = false, instant = false } = {}) {
    const targetOpen = Boolean(nextOpen);
    if (targetOpen && multiLeaveTimer) {
      clearTimeout(multiLeaveTimer);
      multiLeaveTimer = null;
    }
    const nextPinned = targetOpen ? Boolean(pinned) : false;
    const stateChanged = multiOpen !== targetOpen || multiPinned !== nextPinned;
    multiOpen = targetOpen;
    multiPinned = nextPinned;
    patchClasses(multiBtn, { 'is-open': multiOpen && multiPinned });
    patchAttr(multiBtn, 'aria-expanded', multiOpen ? 'true' : 'false');
    patchAttr(multiPinBadge, 'hidden', !multiPinned);
    if (!stateChanged) return;
    patchClasses(multiPanelEl, { 'is-instant': Boolean(instant && multiOpen) });
    patchAttr(multiPanelEl, 'hidden', !multiOpen);
    if (multiOpen) {
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => positionFloatingElements());
      }
    }
  }

  function resolveCapsuleSlotPresentation(metricKey, slotCtx) {
    if (metricKey === 'none') {
      return {
        hidden: true,
        metric: 'none',
        segClass: 'wm-cap-slot',
        textClass: 'wm-slot-text',
        showRing: false,
        dashOffset: RING_CIRCUMFERENCE,
        text: '',
        running: false,
        warn: false,
        danger: false,
      };
    }

    if (metricKey === 'context') {
      if (!slotCtx.hasTelemetry) {
        return {
          hidden: false,
          metric: 'context',
          segClass: 'wm-cap-slot wm-ctx-seg',
          textClass: 'wm-slot-text wm-ctx-pct',
          showRing: true,
          dashOffset: RING_CIRCUMFERENCE,
          text: '--%',
          ctxLimitText: '--',
          running: false,
          warn: false,
          danger: false,
        };
      }
      const isDanger = slotCtx.usedPct >= 88;
      const isWarn = !isDanger && slotCtx.usedPct >= 70;
      const ctxLimitText =
        slotCtx.hasActiveConversation === false || !(Number(slotCtx.contextWindowTokens) > 0)
          ? '—'
          : formatCompactContextLimit(slotCtx.contextWindowTokens);
      return {
        hidden: false,
        metric: 'context',
        segClass: 'wm-cap-slot wm-ctx-seg',
        textClass: 'wm-slot-text wm-ctx-pct',
        showRing: true,
        dashOffset: slotCtx.dashOffset,
        text: `${Math.round(slotCtx.usedPct)}%`,
        ctxLimitText,
        running: false,
        warn: isWarn,
        danger: isDanger,
      };
    }

    if (metricKey === 'tps') {
      if (!slotCtx.hasTelemetry) {
        return {
          hidden: false,
          metric: 'tps',
          segClass: 'wm-cap-slot wm-seg-speed speed-tier-low',
          textClass: 'wm-slot-text wm-speed-text wm-speed-sr',
          showRing: false,
          showSpeed: true,
          showModelSub: true,
          showBattery: false,
          dashOffset: RING_CIRCUMFERENCE,
          text: '-- t/s',
          dotNum: '--',
          hasNumericSpeed: true,
          speedStatus: '',
          modelSub: '—',
          running: false,
          warn: false,
          danger: false,
        };
      }
      const hasValidTps = Number.isFinite(slotCtx.tps) && slotCtx.tps > 0;
      const numVal = hasValidTps ? Number(slotCtx.tps) : null;
      const dotNum = hasValidTps
        ? numVal >= 100
          ? String(Math.round(numVal))
          : numVal.toFixed(1)
        : '--';
      const tpsText = hasValidTps
        ? `${dotNum} t/s`
        : slotCtx.isRunning
          ? '生成中'
          : '待命';
      const tierCls = resolveSpeedTierClass(numVal, hasValidTps);
      return {
        hidden: false,
        metric: 'tps',
        segClass: `wm-cap-slot wm-seg-speed ${tierCls}`,
        textClass: 'wm-slot-text wm-speed-text wm-speed-sr',
        showRing: false,
        showSpeed: true,
        showModelSub: true,
        showBattery: false,
        dashOffset: RING_CIRCUMFERENCE,
        text: tpsText,
        dotNum,
        hasNumericSpeed: hasValidTps || !slotCtx.isRunning,
        speedStatus: !hasValidTps && slotCtx.isRunning ? '生成中' : '',
        modelSub: slotCtx.modelSublabel || '—',
        running: slotCtx.isRunning,
        warn: false,
        danger: false,
      };
    }

    if (metricKey === 'ttft') {
      const val = slotCtx.hasTelemetry ? slotCtx.ttft : null;
      const valid = val != null && Number.isFinite(Number(val)) && Number(val) >= 0;
      const numVal = valid ? Number(val) : 0;
      const isDanger = valid && numVal >= 30;
      const isWarn = valid && !isDanger && numVal >= 15;
      return {
        hidden: false,
        metric: 'ttft',
        segClass: 'wm-cap-slot wm-seg-ttft',
        textClass: 'wm-slot-text wm-ttft-text',
        showRing: false,
        showSpeed: false,
        showModelSub: false,
        showBattery: false,
        dashOffset: RING_CIRCUMFERENCE,
        text: valid ? formatCompactCapsuleTtft(numVal) : '--s',
        running: false,
        warn: isWarn,
        danger: isDanger,
      };
    }

    if (metricKey === 'cost') {
      const costVal = slotCtx.hasTelemetry ? slotCtx.stepCost : null;
      return {
        hidden: false,
        metric: 'cost',
        segClass: 'wm-cap-slot wm-seg-cost',
        textClass: 'wm-slot-text wm-cost-text',
        showRing: false,
        showSpeed: false,
        showModelSub: false,
        showBattery: false,
        dashOffset: RING_CIRCUMFERENCE,
        text: slotCtx.hasTelemetry ? formatCompactCapsuleCost(costVal) : '--',
        running: false,
        warn: false,
        danger: false,
      };
    }

    const poolChoice = slotCtx.quotaPoolChoice === 'claude' ? 'claude' : 'gemini';
    const quotaSum = !slotCtx.hasTelemetry
      ? null
      : metricKey === 'quota_auto'
        ? resolveQuotaPoolBatterySummary(slotCtx.quotas, poolChoice)
        : resolveSpecificQuotaSlotSummary(slotCtx.quotas, metricKey);
    const resolvedPool = quotaSum?.poolChoice || poolChoice;
    const poolLabel = quotaSum?.poolLabel || (resolvedPool === 'claude' ? 'Claude & GPT' : 'Gemini');
    const fiveHourPct =
      quotaSum &&
      quotaSum.fiveHourPct != null &&
      Number.isFinite(Number(quotaSum.fiveHourPct))
        ? Number(quotaSum.fiveHourPct)
        : quotaSum &&
            quotaSum.roundedPct != null &&
            Number.isFinite(Number(quotaSum.roundedPct))
          ? Number(quotaSum.roundedPct)
          : null;
    const weeklyPct =
      quotaSum && quotaSum.weeklyPct != null && Number.isFinite(Number(quotaSum.weeklyPct))
        ? Number(quotaSum.weeklyPct)
        : null;
    return {
      hidden: false,
      metric: metricKey,
      segClass: 'wm-cap-slot wm-seg-quota',
      textClass: 'wm-slot-text wm-quota-text',
      showRing: false,
      showSpeed: false,
      showModelSub: false,
      showBattery: true,
      dashOffset: RING_CIRCUMFERENCE,
      text: '',
      poolChoice: resolvedPool,
      poolLabel,
      fiveHourPct,
      weeklyPct,
      title: `${quotaSum?.detailText || `${poolLabel} 额度读取中`} · 点击切换额度池`,
      running: false,
      warn: false,
      danger: false,
      weeklyWarn: false,
      weeklyDanger: false,
    };
  }

  function applyCapsuleSlots(slotKeys, slotCtx) {
    const presList = slotKeys.map((key) => resolveCapsuleSlotPresentation(key, slotCtx));
    let visRank = 0;
    const visRanks = [0, 0, 0];
    for (let i = 0; i < 3; i += 1) {
      const slot = capsuleSlots[i];
      const pres = presList[i];
      if (pres.hidden) {
        patchAttr(slot.el, 'hidden', true);
        patchAttr(slot.el, 'data-metric', 'none');
        patchAttr(slot.el, 'data-vis-rank', '');
        continue;
      }
      visRank += 1;
      visRanks[i] = visRank;
      patchAttr(slot.el, 'hidden', false);
      patchAttr(slot.el, 'data-metric', pres.metric);
      patchAttr(slot.el, 'data-vis-rank', String(visRank));

      const wantPlainText = !pres.showRing && !pres.showBattery && !pres.showSpeed;
      if (wantPlainText) {
        if (slot.ringMounted) {
          slot.ringSvg.remove();
          slot.ringMounted = false;
        }
        if (slot.ctxColMounted) {
          slot.ctxCol.remove();
          slot.ctxColMounted = false;
        }
        if (!slot.textMounted) {
          slot.textSpan.remove();
          slot.el.appendChild(slot.textSpan);
          slot.textMounted = true;
        }
      } else if (pres.showRing) {
        if (slot.textMounted) {
          slot.textSpan.remove();
          slot.textMounted = false;
        }
        if (slot.textSpan.parentNode !== slot.ctxCol) {
          slot.textSpan.remove();
          slot.ctxCol.insertBefore(slot.textSpan, slot.ctxLimitSpan);
        }
        if (!slot.ringMounted) {
          slot.el.appendChild(slot.ringSvg);
          slot.ringMounted = true;
        }
        if (!slot.ctxColMounted) {
          slot.el.appendChild(slot.ctxCol);
          slot.ctxColMounted = true;
        }
      } else {
        if (slot.textMounted) {
          slot.textSpan.remove();
          slot.textMounted = false;
        }
        if (slot.ringMounted) {
          slot.ringSvg.remove();
          slot.ringMounted = false;
        }
        if (slot.ctxColMounted) {
          slot.ctxCol.remove();
          slot.ctxColMounted = false;
        }
      }

      if (pres.showSpeed && !slot.speedMounted) {
        slot.el.appendChild(slot.speedTopRow);
        slot.speedMounted = true;
      } else if (!pres.showSpeed && slot.speedMounted) {
        slot.speedTopRow.remove();
        slot.speedMounted = false;
      }

      if (pres.showModelSub && !slot.modelMounted) {
        slot.el.appendChild(slot.modelSpan);
        slot.modelMounted = true;
      } else if (!pres.showModelSub && slot.modelMounted) {
        slot.modelSpan.remove();
        slot.modelMounted = false;
      }

      if (pres.showBattery && !slot.batteryMounted) {
        slot.el.appendChild(slot.batWrap);
        slot.el.appendChild(slot.quotaPoolSpan);
        slot.batteryMounted = true;
      } else if (!pres.showBattery && slot.batteryMounted) {
        slot.batWrap.remove();
        slot.quotaPoolSpan.remove();
        slot.batteryMounted = false;
      }

      const fullSegClass =
        `${pres.segClass}${pres.running ? ' state-running' : ''}${pres.warn ? ' tone-warn' : ''}${pres.danger ? ' tone-danger' : ''}`;
      patchAttr(slot.el, 'class', fullSegClass);

      if (wantPlainText || pres.showRing) {
        const fullTextClass =
          `${pres.textClass}${pres.warn ? ' tone-warn' : ''}${pres.danger ? ' tone-danger' : ''}`;
        patchAttr(slot.textSpan, 'class', fullTextClass);
        patchText(slot.textSpan, pres.text);
      }

      if (pres.showSpeed) {
        patchText(slot.speedSrText, pres.text);
        if (pres.hasNumericSpeed) {
          patchAttr(slot.speedDotSvg, 'hidden', false);
          patchAttr(slot.speedUnitSpan, 'hidden', false);
          patchAttr(slot.speedStatusSpan, 'hidden', true);
          if (slot.lastDotText !== pres.dotNum) {
            slot.lastDotText = pres.dotNum;
            updateDotMatrixSvg(slot.speedDotSvg, pres.dotNum);
          }
        } else {
          patchAttr(slot.speedDotSvg, 'hidden', true);
          patchAttr(slot.speedUnitSpan, 'hidden', true);
          patchAttr(slot.speedStatusSpan, 'hidden', false);
          patchText(slot.speedStatusSpan, pres.speedStatus || '待命');
        }
      }

      if (pres.showModelSub) {
        patchText(slot.modelSpan, pres.modelSub || '—');
        patchAttr(slot.el, 'aria-label', `${pres.text} · ${pres.modelSub || ''}`);
      } else if (pres.showBattery) {
        const step = 100 / 7;
        const pct5h = pres.fiveHourPct;
        const pctWk = pres.weeklyPct;
        for (let ci = 0; ci < 7; ci += 1) {
          const ratio =
            pct5h == null ? 0 : Math.max(0, Math.min(1, (pct5h - ci * step) / step));
          const pctStr = `${Math.round(ratio * 100)}%`;
          slot.batCells[ci].fill.style.width = pctStr;
          patchClasses(slot.batCells[ci].cell, {
            'is-lit': ratio > 0.12,
            'is-full': ratio >= 0.85,
          });
        }
        patchAttr(slot.batShell, 'data-pool', pres.poolChoice);
        patchAttr(slot.el, 'data-pool', pres.poolChoice);
        patchClasses(slot.batShell, {
          'is-empty': pct5h == null,
        });
        const wkOffset =
          pctWk == null ? 100 : +Math.max(0, Math.min(100, 100 - pctWk)).toFixed(1);
        slot.weeklyFill.setAttribute('stroke-dashoffset', String(wkOffset));
        patchClasses(slot.weeklyFill, {
          'is-empty': pctWk == null,
        });
        patchText(slot.quotaPoolSpan, pres.poolLabel);
        patchAttr(slot.el, 'aria-label', pres.title || `${pres.poolLabel} 额度`);
        patchAttr(slot.el, 'data-5h-pct', pct5h != null ? String(Math.round(pct5h)) : '');
        patchAttr(slot.el, 'data-weekly-pct', pctWk != null ? String(Math.round(pctWk)) : '');
      }

      if (pres.showRing) {
        slot.ringFill.setAttribute('stroke-dashoffset', String(pres.dashOffset));
        patchClasses(slot.ringFill, { 'tone-warn': pres.warn, 'tone-danger': pres.danger });
        patchText(slot.ctxLimitSpan, pres.ctxLimitText || '--');
      }
    }

    const showSep0 = visRanks[1] >= 2;
    patchAttr(sep0, 'hidden', !showSep0);
    patchAttr(sep0, 'data-sep-for-rank', showSep0 ? String(visRanks[1]) : '');

    const showSep1 = visRanks[2] >= 2;
    patchAttr(sep1, 'hidden', !showSep1);
    patchAttr(sep1, 'data-sep-for-rank', showSep1 ? String(visRanks[2]) : '');
  }

  // --- 4. 实时遥测状态绑定（双胶囊与多会话/全景概览浮层全部槽位预占，仅就地更新节点，零布局跳动） ---
  function renderCapsuleTelemetry() {
    if (disposed) return;
    const telSt = telemetryStore.getState();
    const uiSt = uiStore.getState();
    const telemetry = telSt.telemetry;

    const showMulti = telemetry?.settings?.showTopbarMultiSession !== false;
    patchAttr(multiBtn, 'hidden', !showMulti);
    patchAttr(capsuleHost, 'data-multi', showMulti ? 'on' : 'off');
    if (!showMulti && multiOpen) {
      setMultiOpen(false);
    }
    if (showMulti !== lastShowMulti) {
      lastShowMulti = showMulti;
      updateResponsiveLayout();
    }

    const slotKeys = normalizeClientTopbarSlots(telemetry?.settings?.topbarCapsuleSlots);

    if (!telemetry) {
      patchClasses(multiBtn, { 'is-running': false, 'is-waiting': false });
      patchText(multiLabel, '0 子代理');
      patchText(multiRunningMetaEl, '读取中...');
      stopMultiLiveTicker();

      applyCapsuleSlots(slotKeys, { hasTelemetry: false });
      return;
    }

    const hostRouteId = telSt.hostRouteConversationId || extractHostRouteCascadeId() || '';
    const hostRouteLower = String(hostRouteId).toLowerCase();
    const targetLower = String(telSt.selectedConversationId || hostRouteId || '')
      .trim()
      .toLowerCase();

    const {
      hasSubagents: rawHasSubagents,
      agents: rawAgents,
      scopedConv: overviewScopedConv,
      ctxAgent: rawCtxAgent,
      aggregated: rawAggregated,
    } = resolveScopedConversation(telemetry, 'all', uiSt.ctxInspectorAgentId);
    const { scopedConv: rawCapsuleScopedConv } = resolveScopedConversation(
      telemetry,
      uiSt.selectedAgentScope,
      uiSt.ctxInspectorAgentId
    );
    const rawActiveConv = telemetry.activeConversation || {};
    const activeCidLower = String(rawActiveConv.cascadeId || '').toLowerCase();

    const isUnopenedChat =
      !targetLower || targetLower === '__none__' || targetLower === 'none';
    const targetMatchedAgent =
      Boolean(targetLower) &&
      Array.isArray(rawAgents) &&
      rawAgents.some((a) => String(a?.cascadeId || '').toLowerCase() === targetLower);
    const isRouteMismatch =
      Boolean(targetLower) &&
      Boolean(activeCidLower) &&
      activeCidLower !== targetLower &&
      !targetMatchedAgent;
    const isZeroStepIdle =
      Number(rawActiveConv.stepCount || 0) === 0 &&
      Number(rawActiveConv.totalStepsAllAgents || 0) === 0 &&
      !rawActiveConv.isRunning &&
      !rawAggregated?.isRunning &&
      !(Number(rawActiveConv.subagentCount || 0) > 0);

    const transitionSummary = isRouteMismatch && Array.isArray(telemetry.conversations)
      ? telemetry.conversations.find((c) => String(c?.cascadeId || '').toLowerCase() === targetLower) ||
        null
      : null;
    const hasTransitionSummary =
      Boolean(transitionSummary) &&
      (Number(transitionSummary.stepCount || 0) > 0 || Boolean(transitionSummary.isRunning));

    const hasCurrentConv = !isUnopenedChat && !isRouteMismatch && !isZeroStepIdle;
    const hasSubagents = hasCurrentConv ? rawHasSubagents : false;
    const agents = hasCurrentConv ? rawAgents : [];
    const activeConv = hasCurrentConv ? rawActiveConv : {};
    const overviewActive = hasCurrentConv
      ? overviewScopedConv || rawActiveConv
      : hasTransitionSummary
        ? {
            cascadeId: transitionSummary.cascadeId,
            title: transitionSummary.title,
            isRunning: Boolean(transitionSummary.isRunning),
            latestTokPerSec: transitionSummary.latestTokPerSec ?? null,
            activeModelShort: transitionSummary.modelShort || '模型未知',
            activeModelUpstream:
              transitionSummary.modelUpstream || transitionSummary.modelShort || '模型未知',
            context: { totalTokens: 0 },
          }
        : {};
    const capsuleScopedConv = hasCurrentConv ? rawCapsuleScopedConv : null;
    const ctxAgent = hasCurrentConv ? rawCtxAgent : null;
    const aggregated = hasCurrentConv ? rawAggregated : null;

    const ctx = hasCurrentConv
      ? ctxAgent?.context || overviewActive.context || activeConv.context || {}
      : {};
    const limitTokens = hasCurrentConv
      ? Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000)
      : 0;
    const contextWindowTokens = hasCurrentConv
      ? Number(
          ctx.limitTokens || ctx.maxContextBudgetTokens || ctx.compactionLimitTokens || 256000
        )
      : 0;
    const totalTokens = hasCurrentConv ? Number(ctx.totalTokens || 0) : 0;
    const usedPct = hasCurrentConv
      ? limitTokens > 0
        ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1))
        : 0
      : hasTransitionSummary && Number.isFinite(Number(transitionSummary.contextUsedPct))
        ? Math.max(0, Math.min(100, Number(transitionSummary.contextUsedPct)))
        : 0;
    const dashOffset =
      hasCurrentConv || hasTransitionSummary
        ? +(RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, usedPct)) / 100)).toFixed(2)
        : RING_CIRCUMFERENCE;

    // --- 4a. 仅同步当前窗口对话与子代理（不跨对话统计或显示） ---
    const currentCidLower = hasCurrentConv
      ? String(activeConv.cascadeId || hostRouteLower || '').toLowerCase()
      : '';
    const currRunningMatch =
      hasCurrentConv && Array.isArray(telemetry.runningConversations)
        ? telemetry.runningConversations.find((item) =>
            currentCidLower
              ? String(item?.cascadeId || '').toLowerCase() === currentCidLower
              : Boolean(item?.isCurrentSelected)
          )
        : null;
    const currSubList = (agents || [])
      .filter((a) => !a.isMain)
      .map((s, idx) => ({
        cascadeId: s.cascadeId || s.agentId,
        index: s.index || idx + 1,
        badgeText: s.badgeText || `子${idx + 1}`,
        shortLabel: s.shortLabel || `子代理 #${idx + 1}`,
        role: s.role || `子代理 #${idx + 1}`,
        isRunning: Boolean(s.isRunning),
        stepCount: Number(s.stepCount || 0),
        lastModifiedMs: s.lastModifiedMs || 0,
        liveActivity: s.liveActivity || {
          phase: s.isRunning ? 'thinking' : 'done',
          label: s.isRunning ? '推理中' : '已完成',
          detail: '',
          stepProgress: '',
          startedAtMs: s.lastModifiedMs || 0,
          signature: `${s.agentId}:${s.stepCount || 0}`,
        },
      }));
    const currSubTotal = currRunningMatch
      ? Number(currRunningMatch.subagentCount ?? currRunningMatch.subagents?.length ?? currSubList.length)
      : currSubList.length;
    const currSubRunning = currRunningMatch
      ? Number(currRunningMatch.runningSubagentCount ?? 0)
      : currSubList.filter((s) => s.isRunning).length;
    const isCurrRunning = Boolean(
      currRunningMatch || activeConv.isRunning || aggregated?.isRunning || currSubRunning > 0
    );

    const rawRunningList = currRunningMatch
      ? [currRunningMatch]
      : isCurrRunning || currSubTotal > 0
        ? [
            {
              cascadeId: activeConv.cascadeId || 'current',
              title: activeConv.title || '当前会话',
              isCurrentSelected: true,
              isMainRunning: Boolean(activeConv.isRunning),
              isRunning: isCurrRunning,
              mainActivity: activeConv.liveActivity || aggregated?.liveActivity || null,
              subagentCount: currSubTotal,
              runningSubagentCount: currSubRunning,
              latestTokPerSec: overviewActive.latestTokPerSec ?? null,
              contextUsedPct: usedPct,
              subagents: currSubList,
            },
          ]
        : [];

    const runningCount = rawRunningList.length;
    const hasWaiting = rawRunningList.some((item) => item.mainActivity?.phase === 'waiting');

    patchClasses(multiBtn, {
      'is-running': isCurrRunning && !hasWaiting,
      'is-waiting': isCurrRunning && hasWaiting,
    });
    const multiBtnText =
      currSubRunning > 0
        ? `${currSubRunning} 子运行`
        : currSubTotal > 0
          ? isCurrRunning
            ? `运行 · ${currSubTotal} 子`
            : `${currSubTotal} 子代理`
          : isCurrRunning
            ? '运行中'
            : '0 子代理';
    patchText(multiLabel, multiBtnText);

    patchText(
      multiRunningMetaEl,
      currSubRunning > 0
        ? `${currSubRunning} 子代理运行中`
        : isCurrRunning
          ? currSubTotal > 0
            ? `主代理运行中 · 共 ${currSubTotal} 子`
            : '主代理运行中'
          : currSubTotal > 0
            ? `当前共 ${currSubTotal} 子代理`
            : '当前待命'
    );
    patchAttr(multiEmptyEl, 'hidden', runningCount > 0);
    patchAttr(multiRunningListEl, 'hidden', runningCount === 0);

    const runningIdsLower = new Set(
      rawRunningList.map((item) => String(item.cascadeId || '').toLowerCase())
    );

    if (runningCount === 0) {
      stopMultiLiveTicker();
      manualSubExpandMap.clear();
    } else {
      for (const cid of [...manualSubExpandMap.keys()]) {
        if (!runningIdsLower.has(String(cid || '').toLowerCase())) {
          manualSubExpandMap.delete(cid);
        }
      }

      const activeTimerKeys = new Set();
      for (const item of rawRunningList) {
        activeTimerKeys.add(`main:${item.cascadeId}`);
        const subCount = Number(item.subagentCount || item.subagents?.length || 0);
        const runSubs = Number(item.runningSubagentCount || 0);
        const isExp = manualSubExpandMap.has(item.cascadeId)
          ? manualSubExpandMap.get(item.cascadeId)
          : runSubs > 0;
        if (subCount > 0 && isExp) {
          for (const sub of item.subagents || []) {
            if (sub?.isRunning) {
              activeTimerKeys.add(`sub:${sub.cascadeId}`);
            }
          }
        }
      }

      patchKeyedList(multiRunningListEl, rawRunningList, {
        keyFn: (item) => item.cascadeId,
        sigFn: (item) => {
          const runSubs = Number(item.runningSubagentCount || 0);
          const isExp = manualSubExpandMap.has(item.cascadeId)
            ? manualSubExpandMap.get(item.cascadeId)
            : runSubs > 0;
          const isHere =
            Boolean(hostRouteLower) &&
            String(item.cascadeId || '').toLowerCase() === hostRouteLower;
          const subSig = (item.subagents || [])
            .map(
              (s) =>
                `${s.cascadeId}:${s.isRunning}:${s.stepCount}:${s.liveActivity?.signature || ''}:${s.liveActivity?.startedAtMs || 0}`
            )
            .join('|');
          return `${item.cascadeId}:${item.title}:${isHere}:${item.isMainRunning}:${item.subagentCount}:${runSubs}:${isExp}:${item.latestTokPerSec ?? ''}:${item.contextUsedPct ?? ''}:${item.mainActivity?.signature || ''}:${item.mainActivity?.startedAtMs || 0}:${subSig}`;
        },
        createRow: createMultiLiveTaskCard,
        updateRow: (refs, item) => {
          const act = item.mainActivity || {
            phase: 'thinking',
            label: '推理中',
            detail: '',
            stepProgress: '',
            startedAtMs: item.lastModifiedMs || 0,
            signature: `fallback:${item.lastModifiedMs || 0}`,
          };
          const isWaiting = act.phase === 'waiting';
          const isCompacting = act.phase === 'compacting';
          patchClasses(refs.cardEl, {
            'is-waiting': isWaiting,
            'is-compacting': isCompacting,
          });
          patchClasses(refs.dotIcon, { 'is-pulsing': true });

          const convTitle = item.title || item.cascadeId?.slice(0, 8) || '当前会话';
          patchText(refs.titleEl, convTitle);
          patchAttr(refs.titleEl, 'title', convTitle);

          const isHere =
            Boolean(hostRouteLower) &&
            String(item.cascadeId || '').toLowerCase() === hostRouteLower;
          patchAttr(refs.hereTagEl, 'hidden', !isHere);

          const metricParts = [];
          if (Number.isFinite(item.latestTokPerSec) && item.latestTokPerSec > 0) {
            metricParts.push(
              `${item.latestTokPerSec >= 100 ? Math.round(item.latestTokPerSec) : item.latestTokPerSec.toFixed(1)} t/s`
            );
          }
          if (item.contextUsedPct != null && Number.isFinite(Number(item.contextUsedPct))) {
            metricParts.push(`${Math.round(Number(item.contextUsedPct))}%`);
          }
          const metricsStr = metricParts.join(' · ');
          patchAttr(refs.metricsEl, 'hidden', !metricsStr);
          if (metricsStr) {
            patchText(refs.metricsEl, metricsStr);
          }

          const subCount = Number(item.subagentCount || item.subagents?.length || 0);
          const runSubCount = Number(item.runningSubagentCount || 0);
          const isExpanded = manualSubExpandMap.has(item.cascadeId)
            ? manualSubExpandMap.get(item.cascadeId)
            : runSubCount > 0;
          patchAttr(refs.mainBadge, 'hidden', subCount === 0);
          patchAttr(refs.subToggleBtn, 'hidden', subCount === 0);
          if (subCount > 0) {
            const arrow = isExpanded ? '▾' : '▸';
            const toggleText =
              runSubCount > 0
                ? `子代理 ${runSubCount}/${subCount} ${arrow}`
                : `子代理 (${subCount}) ${arrow}`;
            patchText(refs.subToggleBtn, toggleText);
            patchClasses(refs.subToggleBtn, { 'is-expanded': isExpanded });
            refs.subToggleBtn.onclick = (e) => {
              e.stopPropagation();
              manualSubExpandMap.set(item.cascadeId, !isExpanded);
              renderCapsuleTelemetry();
              if (multiOpen) {
                positionFloatingElements();
              }
            };
          }

          const mainTimerKey = `main:${item.cascadeId}`;
          activeTimerKeys.add(mainTimerKey);
          bindMultiElapsedTimer(
            mainTimerKey,
            `${item.cascadeId}:${act.signature || act.label}`,
            act.startedAtMs,
            refs.elapsedEl
          );

          patchText(refs.mainPhase, act.label || '推理中');
          const progText = act.stepProgress ? `[${act.stepProgress}]` : '';
          patchAttr(refs.mainProgress, 'hidden', !progText);
          if (progText) {
            patchText(refs.mainProgress, progText);
          }

          const detailStr = act.detail || '';
          patchAttr(refs.mainSep, 'hidden', !detailStr);
          patchAttr(refs.mainDetail, 'hidden', !detailStr);
          patchText(refs.mainDetail, detailStr);

          const showSubs = subCount > 0 && isExpanded;
          patchAttr(refs.subListEl, 'hidden', !showSubs);
          if (showSubs) {
            const subItems = item.subagents || [];
            patchKeyedList(refs.subListEl, subItems, {
              keyFn: (sub) => sub.cascadeId,
              sigFn: (sub) =>
                `${sub.cascadeId}:${sub.role}:${sub.isRunning}:${sub.stepCount}:${sub.liveActivity?.signature || ''}:${sub.isRunning ? multiTimersMap.has(`sub:${sub.cascadeId}`) : true}`,
              createRow: createMultiLiveSubRow,
              updateRow: (subRefs, sub) => {
                const subAct = sub.liveActivity || {
                  phase: sub.isRunning ? 'thinking' : 'done',
                  label: sub.isRunning ? '推理中' : '已完成',
                  detail: '',
                  stepProgress: '',
                  startedAtMs: sub.lastModifiedMs || 0,
                };
                patchClasses(subRefs.rowEl, { 'is-done': !sub.isRunning });
                const subBadgeCls = getAgentBadgeClass(sub.index || 1, false);
                patchAttr(subRefs.subBadge, 'class', `agent-badge ${subBadgeCls}`);
                patchText(subRefs.subBadge, sub.badgeText || `子${sub.index || 1}`);
                patchText(subRefs.subRole, sub.role || sub.shortLabel || '子代理');

                const subProg = subAct.stepProgress ? ` [${subAct.stepProgress}]` : '';
                const summaryText = sub.isRunning
                  ? `${subAct.label || '运行中'}${subProg}${subAct.detail ? ` · ${subAct.detail}` : ''}`
                  : `已完成 (${sub.stepCount || 0} 步)`;
                patchText(subRefs.subSummary, summaryText);

                const subTimerKey = `sub:${sub.cascadeId}`;
                if (sub.isRunning) {
                  activeTimerKeys.add(subTimerKey);
                  bindMultiElapsedTimer(
                    subTimerKey,
                    `${sub.cascadeId}:${subAct.signature || subAct.label}`,
                    subAct.startedAtMs || sub.lastModifiedMs,
                    subRefs.subElapsed
                  );
                } else {
                  multiTimersMap.delete(subTimerKey);
                  patchText(subRefs.subElapsed, `${sub.stepCount || 0}步`);
                }
              },
            });
          }
        },
      });

      for (const k of [...multiTimersMap.keys()]) {
        if (!activeTimerKeys.has(k)) {
          multiTimersMap.delete(k);
        }
      }
      ensureMultiLiveTicker();
    }

    // --- 4b. 同步右侧指标胶囊 ---
    const isRunning = hasCurrentConv
      ? Boolean(aggregated?.isRunning || activeConv.isRunning)
      : Boolean(hasTransitionSummary && transitionSummary.isRunning);
    const tps = hasCurrentConv
      ? capsuleScopedConv?.latestTokPerSec ??
        aggregated?.latestTokPerSec ??
        activeConv.latestTokPerSec ??
        null
      : hasTransitionSummary
        ? transitionSummary.latestTokPerSec ?? null
        : null;
    const ttft = hasCurrentConv
      ? capsuleScopedConv?.latestTtftSec ??
        aggregated?.latestTtftSec ??
        activeConv.latestTtftSec ??
        null
      : null;
    const capsuleStepCost = hasCurrentConv
      ? capsuleScopedConv?.latestStepCostUsd ??
        aggregated?.latestStepCostUsd ??
        activeConv.latestStepCostUsd ??
        null
      : null;

    const showUpstream = Boolean(telemetry.settings?.showUpstreamModel);
    const autoQuotaPool = detectActiveModelQuotaPool(
      telemetry,
      hasCurrentConv || hasTransitionSummary ? overviewActive : {}
    );
    if (autoQuotaPool !== lastAutoQuotaPool) {
      manualQuotaPoolOverride = null;
    }
    lastAutoQuotaPool = autoQuotaPool;
    const quotaPoolChoice = manualQuotaPoolOverride || autoQuotaPool;
    patchClasses(capsuleBtn, { 'is-running': isRunning });
    applyCapsuleSlots(slotKeys, {
      hasTelemetry: true,
      hasActiveConversation: hasCurrentConv,
      usedPct,
      dashOffset,
      contextWindowTokens,
      isRunning,
      tps,
      modelSublabel:
        hasCurrentConv || hasTransitionSummary
          ? formatTopbarModelSublabel(overviewActive, showUpstream)
          : '—',
      quotaPoolChoice,
      ttft,
      stepCost: capsuleStepCost,
      quotas: telemetry.quotas,
    });
  }

  const unsubStore = telemetryStore.subscribe(
    (st) => ({
      syncState: st.syncState,
      telemetry: st.telemetry,
      minuteTick: st.minuteTick,
      selectedConversationId: st.selectedConversationId,
      hostRouteConversationId: st.hostRouteConversationId,
    }),
    (slice) => {
      if (slice.telemetry?.settings?.enableWindowOverlay === false) {
        if (multiOpen) setMultiOpen(false);
      }
      renderCapsuleTelemetry();
    }
  );

  const unsubUiScope = uiStore.subscribe(
    (st) => ({
      selectedAgentScope: st.selectedAgentScope,
      ctxInspectorAgentId: st.ctxInspectorAgentId,
    }),
    () => renderCapsuleTelemetry()
  );

  // --- 5. 宿主会话路由跟随与全局交互监听 ---
  function syncHostRouteIfChanged() {
    if (disposed) return;
    const currentRouteId = extractHostRouteCascadeId();
    if (currentRouteId === lastObservedRouteId) return;
    lastObservedRouteId = currentRouteId;
    manualQuotaPoolOverride = null;
    const st = telemetryStore.getState();
    const patch = { hostRouteConversationId: currentRouteId };
    if (st.selectedConversationId && st.selectedConversationId !== currentRouteId) {
      patch.selectedConversationId = '';
    }
    uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' });
    telemetryStore.setState(patch);
    void fetchTelemetry({ force: false });
  }

  let routeClickTimer = null;
  const onDocClickRouteCheck = () => {
    if (disposed) return;
    if (routeClickTimer) clearTimeout(routeClickTimer);
    routeClickTimer = setTimeout(() => {
      routeClickTimer = null;
      syncHostRouteIfChanged();
    }, 30);
    routeClickTimer?.unref?.();
  };

  const onDocMouseDown = (e) => {
    if (multiOpen && !isEventInside(e, multiPanelEl) && !isEventInside(e, capsuleHost)) {
      setMultiOpen(false);
    }
  };

  const onDocKeyDown = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (multiOpen) {
        setMultiOpen(false);
      }
    }
  };

  const onWindowPointerMove = (e) => recordPointerCoords(e);
  const onWindowBlur = () => {
    hasPointerCoords = false;
    if (multiOpen && !multiPinned) {
      setMultiOpen(false);
    }
  };
  const onWindowResize = () => updateResponsiveLayout();
  const onPopState = () => syncHostRouteIfChanged();
  const onVisibilityChange = () => {
    if (document.hidden) {
      hasPointerCoords = false;
      if (multiOpen && !multiPinned) {
        setMultiOpen(false);
      }
      return;
    }
    if (!document.hidden && !disposed) {
      syncHostRouteIfChanged();
      void fetchTelemetry({ force: false });
    }
  };

  let hostDomObserver = null;
  try {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateResponsiveLayout());
      if (document.body) resizeObserver.observe(document.body);
    }
    if (typeof MutationObserver !== 'undefined' && document.body) {
      hostDomObserver = new MutationObserver(() => {
        syncHostRouteIfChanged();
        const tb = findHostTitlebar();
        if (
          !capsuleHost.isConnected ||
          !portalHost.isConnected ||
          (tb && !tb.contains(capsuleHost)) ||
          (!tb && capsuleHost.getAttribute('data-dock') === 'flow')
        ) {
          scheduleDockSync();
        }
      });
      hostDomObserver.observe(document.body, { childList: true, subtree: true });
    }
  } catch {
    // 忽略观察器初始化异常
  }

  document.addEventListener?.('mousedown', onDocMouseDown, true);
  document.addEventListener?.('click', onDocClickRouteCheck, true);
  document.addEventListener?.('keydown', onDocKeyDown);
  document.addEventListener?.('visibilitychange', onVisibilityChange);
  window.addEventListener?.('pointermove', onWindowPointerMove, { passive: true });
  window.addEventListener?.('blur', onWindowBlur);
  window.addEventListener?.('resize', onWindowResize);
  window.addEventListener?.('popstate', onPopState);
  window.addEventListener?.('hashchange', onPopState);
  navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', onWindowResize);

  let lastHostModelText = readSelectedModelTextFromHostDom();
  const watchdogTimer = setInterval(() => {
    if (disposed) return;
    syncHostRouteIfChanged();
    const curModelText = readSelectedModelTextFromHostDom();
    if (curModelText && curModelText !== lastHostModelText) {
      lastHostModelText = curModelText;
      renderCapsuleTelemetry();
    }
    if (!capsuleHost.isConnected || !portalHost.isConnected) {
      ensureCapsuleDocked();
    }
  }, 1200);

  ensureCapsuleDocked();
  renderCapsuleTelemetry();
  const allowMultiCarryOver =
    telemetryStore.getState().telemetry?.settings?.showTopbarMultiSession !== false;
  if (carryOverMultiPinnedOpen && allowMultiCarryOver) {
    setMultiOpen(true, { pinned: true, instant: true });
  } else if (carryOverMultiHoverOpen && allowMultiCarryOver) {
    setMultiOpen(true, { pinned: false, instant: true });
  }
  const stopPolling = startAsyncTelemetryLoop(2000);

  const handle = {
    bundleVersion,
    ensureAlive() {
      if (disposed) return false;
      return ensureCapsuleDocked();
    },
    updateBridge(nextBridge) {
      if (disposed || !nextBridge || typeof nextBridge !== 'object') return false;
      const port = Number(nextBridge.port || 0);
      const token = String(nextBridge.token || '');
      if (!Number.isInteger(port) || port <= 0 || !token) return false;
      const cur = window.__AGUsageMonitorBridge || {};
      const portChanged = Number(cur.port || 0) !== port;
      cur.port = port;
      cur.token = token;
      if (portChanged && cur.transportMode !== 'cdp') {
        cur.transportMode = 'http';
      }
      window.__AGUsageMonitorBridge = cur;
      void fetchTelemetry({ force: false });
      return true;
    },
    getTelemetrySnapshot() {
      return telemetryStore.getState().telemetry;
    },
    getLastPointer() {
      return hasPointerCoords ? { x: lastPointerX, y: lastPointerY } : null;
    },
    deliverRpc(responses) {
      if (disposed) return 0;
      return deliverCdpBridgeResponses(responses);
    },
    open() {},
    close() {},
    toggle() {},
    openMulti(pinned = true) {
      setMultiOpen(true, { pinned: Boolean(pinned) });
    },
    closeMulti() {
      setMultiOpen(false);
    },
    isOpen: () => false,
    isHoverOpen: () => false,
    isMultiOpen: () => multiOpen,
    isMultiHoverOpen: () => Boolean(multiOpen && !multiPinned),
    isMultiPinnedOpen: () => Boolean(multiOpen && multiPinned),
    getLayoutMode: () => layoutMode,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(watchdogTimer);
      if (multiLeaveTimer) {
        clearTimeout(multiLeaveTimer);
        multiLeaveTimer = null;
      }
      if (routeClickTimer) {
        clearTimeout(routeClickTimer);
        routeClickTimer = null;
      }
      stopMultiLiveTicker();
      if (dockRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(dockRafId);
        dockRafId = 0;
      }
      stopPolling();
      stopAsyncTelemetryLoop();
      unsubStore();
      unsubUiScope();
      try {
        resizeObserver?.disconnect();
      } catch {}
      try {
        hostDomObserver?.disconnect();
      } catch {}
      document.removeEventListener?.('mousedown', onDocMouseDown, true);
      document.removeEventListener?.('click', onDocClickRouteCheck, true);
      document.removeEventListener?.('keydown', onDocKeyDown);
      document.removeEventListener?.('visibilitychange', onVisibilityChange);
      window.removeEventListener?.('pointermove', onWindowPointerMove);
      window.removeEventListener?.('blur', onWindowBlur);
      window.removeEventListener?.('resize', onWindowResize);
      window.removeEventListener?.('popstate', onPopState);
      window.removeEventListener?.('hashchange', onPopState);
      navigator?.windowControlsOverlay?.removeEventListener?.('geometrychange', onWindowResize);
      try {
        capsuleHost.remove();
      } catch {}
      try {
        portalHost.remove();
      } catch {}
      if (window.__AGUsageMonitorOverlay === handle) {
        delete window.__AGUsageMonitorOverlay;
      }
    },
  };

  window.__AGUsageMonitorOverlay = handle;
  return handle;
}
