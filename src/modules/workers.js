import { loadConfig, getPolygonRpcUrl } from './config.js';
import { getDecryptedPrivateKey, getDecryptedL2Credentials } from './auth.js';
import { sendNotification } from './bot/bot.js';
import {
  initClient,
  initContracts,
  redeem,
  getPositions as getApiPositions,
  getOrders as getApiOpenOrders,
  getBestBidAsk,
  parsePriceToMicro,
  formatPriceFromMicro,
  parseSharesToBase,
  formatSharesFromBase,
  createOrder,
  cancelOrder,
  placeMarketSellFOK
} from './polymarket.js';
import {
  replacePositionsSnapshot,
  getPositions as getDbPositions,
  getTrackedOrders,
  cleanupInvalidTrackedOrders,
  cleanupUnmanagedOrders,
  getOrderById,
  upsertOrderStatus,
  updateOrderStatus,
  getAllUsers
} from './database.js';
import { getUserSession, userContextStorage } from './userManager.js';
import { Wallet } from 'ethers';
import { DATA_API_URL } from './constants.js';
import { createContext, safeLogError, safeLogWarn, safeLogInfo, retry } from './logger.js';

const MINUTE_MS = 60 * 1000;
const DEFAULT_SYNC_POSITIONS_MS = 60 * MINUTE_MS;
const DEFAULT_MONITOR_MS = 45 * 1000;
const DEFAULT_5M_STRATEGY_MS = 5 * 1000;
const DEFAULT_WORKER_HEALTH_LOG_MS = 10 * MINUTE_MS;

const workerTimers = new Map();
const workerRunning = new Set();
const workerMetrics = new Map();
let workersStarted = false;

const runtime = {
  initialized: false,
  walletAddress: '',
  chatId: '',
  initPromise: null
};

function ensureWorkerMetric(name) {
  if (!workerMetrics.has(name)) {
    workerMetrics.set(name, {
      runs: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      skippedDueToOverlap: 0,
      isRunning: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastDurationMs: null,
      lastErrorName: null,
      lastErrorMessage: null
    });
  }
  return workerMetrics.get(name);
}

function summarizeWorkerError(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'Unknown worker error')
  };
}

export function getWorkersHealthSnapshot() {
  const workers = {};
  for (const [name, metric] of workerMetrics.entries()) {
    workers[name] = { ...metric };
  }

  return {
    timestamp: nowIso(),
    workersStarted,
    runtime: {
      initialized: runtime.initialized,
      walletAddress: runtime.walletAddress || null,
      notificationsChatConfigured: Boolean(runtime.chatId)
    },
    running: Array.from(workerRunning),
    scheduled: Array.from(workerTimers.keys()),
    workers
  };
}

function parseIntervalEnv(name, fallbackMs) {
  const raw = process.env[name];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallbackMs;
  return Math.floor(value);
}

function toBigIntSafe(value, fallback = 0n) {
  try {
    return BigInt(value?.toString?.() ?? value);
  } catch {
    return fallback;
  }
}

function parseSharesBaseSafe(value) {
  if (value === null || value === undefined) return 0n;
  const raw = String(value).trim();
  if (!raw) return 0n;
  try {
    return parseSharesToBase(raw);
  } catch {
    return 0n;
  }
}

function parsePriceMicroSafe(value) {
  if (value === null || value === undefined) return 0n;
  const cleaned = String(value).replace(/[^0-9.,]/g, '').trim();
  if (!cleaned) return 0n;
  try {
    return parsePriceToMicro(cleaned.replace(',', '.'));
  } catch {
    return 0n;
  }
}

function hasFieldValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return true;
}

function readOrderSizeBase(order, keys) {
  const source = order || {};
  for (const key of keys) {
    if (!(key in source)) continue;
    const raw = source[key];
    if (!hasFieldValue(raw)) {
      return { hasField: true, value: 0n };
    }
    return { hasField: true, value: parseSharesBaseSafe(raw) };
  }
  return { hasField: false, value: 0n };
}

function getRecordUniqueKey(record, index, prefix) {
  const idCandidates = [
    record?.id,
    record?.trade_id,
    record?.tradeId,
    record?.activity_id,
    record?.activityId,
    record?.tx_hash,
    record?.txHash,
    record?.hash
  ];

  for (const value of idCandidates) {
    const normalized = String(value ?? '').trim();
    if (normalized) return `${prefix}:${normalized}`;
  }

  return `${prefix}:idx:${index}:${JSON.stringify(record || {})}`;
}

function extractFilledSizeBaseFromRecord(record) {
  const fields = [
    'size',
    'filled_size',
    'filledSize',
    'matched_size',
    'matchedSize',
    'trade_size',
    'tradeSize',
    'maker_size',
    'makerSize',
    'taker_size',
    'takerSize',
    'order_size',
    'orderSize',
    'base_size',
    'baseSize'
  ];

  for (const field of fields) {
    if (!(field in (record || {}))) continue;
    const parsed = parseSharesBaseSafe(record[field]);
    if (parsed > 0n) return parsed;
  }

  return 0n;
}

function sumFilledSizeFromRecords(records, seen, prefix) {
  const list = Array.isArray(records) ? records : [];
  let total = 0n;
  let hasEvidence = false;

  for (let index = 0; index < list.length; index += 1) {
    const record = list[index];
    const key = getRecordUniqueKey(record, index, prefix);
    if (seen.has(key)) continue;
    seen.add(key);

    hasEvidence = true;
    total += extractFilledSizeBaseFromRecord(record);
  }

  return { total, hasEvidence };
}

async function fetchFilledSizeFromDataApi(orderId, walletAddress) {
  const orderIdVariants = ['order_id', 'orderId', 'id'];
  const seen = new Set();
  let total = 0n;
  let hasEvidence = false;

  for (const key of orderIdVariants) {
    try {
      const trades = await fetchDataApiList('/trades', { [key]: orderId, user: walletAddress });
      const aggregated = sumFilledSizeFromRecords(trades, seen, `trades:${key}`);
      total += aggregated.total;
      hasEvidence = hasEvidence || aggregated.hasEvidence;
    } catch {}
  }

  if (hasEvidence) {
    return { filledSizeBase: total, hasEvidence: true };
  }

  for (const key of orderIdVariants) {
    try {
      const activity = await fetchDataApiList('/activity', { [key]: orderId, user: walletAddress });
      const aggregated = sumFilledSizeFromRecords(activity, seen, `activity:${key}`);
      total += aggregated.total;
      hasEvidence = hasEvidence || aggregated.hasEvidence;
    } catch {}
  }

  return { filledSizeBase: total, hasEvidence };
}

function getOrderId(order) {
  const candidates = [order?.id, order?.orderID, order?.orderId, order?.order_id];
  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return '';
}

function parseOrderIds(value) {
  if (value === null || value === undefined) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOrderId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function parseStrategyOrderPair(value) {
  const raw = String(value ?? '').trim();
  const pair = { yes: '', no: '' };
  const extra = [];

  if (!raw) {
    return { ...pair, allIds: [] };
  }

  if (raw.includes('yes:') || raw.includes('no:')) {
    const parts = raw
      .split(';')
      .map((part) => String(part).trim())
      .filter(Boolean);

    for (const part of parts) {
      if (part.startsWith('yes:')) {
        pair.yes = normalizeOrderId(part.slice(4));
      } else if (part.startsWith('no:')) {
        pair.no = normalizeOrderId(part.slice(3));
      } else {
        const normalized = normalizeOrderId(part);
        if (normalized) extra.push(normalized);
      }
    }
  } else {
    const ids = parseOrderIds(raw);
    if (ids.length > 0) pair.yes = ids[0];
    if (ids.length > 1) pair.no = ids[1];
    if (ids.length > 2) extra.push(...ids.slice(2));
  }

  const allIds = dedupeTokens([pair.yes, pair.no, ...extra]);
  return { ...pair, allIds };
}

function encodeStrategyOrderPair(pair) {
  const yes = normalizeOrderId(pair?.yes);
  const no = normalizeOrderId(pair?.no);
  if (!yes && !no) return null;
  return `yes:${yes};no:${no}`;
}

function getOrderStatusById(orderId, rowById, openOrderIds) {
  const id = normalizeOrderId(orderId);
  if (!id) return 'missing';
  const row = rowById.get(id);

  if (openOrderIds.has(id)) {
    const status = String(row?.status || '').toLowerCase();
    if (status === 'partially_filled' || status === 'partial') return 'partially_filled';
    return 'open';
  }

  const status = String(row?.status || '').toLowerCase();
  if (!status) return 'missing';
  if (status === 'partial') return 'partially_filled';
  return status;
}

function isSafeCancelOrderFailure(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('not found') ||
    message.includes('already cancelled') ||
    message.includes('already canceled') ||
    message.includes('already filled') ||
    message.includes('not open')
  );
}

async function cancelOrderAndMark(orderId, options = {}) {
  const id = normalizeOrderId(orderId);
  if (!id) return;
  const strictCancel = options?.strictCancel === true;
  try {
    await cancelOrder(id);
  } catch (error) {
    const ctx = createContext('workers', 'cancelOrderAndMark');
    safeLogWarn(ctx, 'Cancel order failed', {
      orderId: id,
      message: error?.message
    });
    if (strictCancel && !isSafeCancelOrderFailure(error)) {
      throw new Error(`Cancel order failed for ${id}: ${error?.message || error}`);
    }
  }
  try {
    await updateOrderStatus(id, 'cancelled');
  } catch (error) {
    const ctx = createContext('workers', 'cancelOrderAndMark');
    safeLogWarn(ctx, 'Failed to mark order as cancelled in DB', {
      orderId: id,
      message: error?.message
    });
  }
}

async function getOrdersByIds(orderIds) {
  const ids = Array.isArray(orderIds) ? orderIds : [];
  const rows = [];
  for (const id of ids) {
    const row = await getOrderById(id);
    if (row) rows.push(row);
  }
  return rows;
}

function getOrdersAggregateStatus(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'missing';
  if (rows.some((row) => row.status === 'filled')) return 'filled';
  if (rows.some((row) => row.status === 'partially_filled')) return 'partially_filled';
  if (rows.some((row) => row.status === 'open')) return 'open';
  if (rows.every((row) => row.status === 'cancelled')) return 'cancelled';
  return 'unknown';
}

function dedupeTokens(tokens) {
  return Array.from(new Set((Array.isArray(tokens) ? tokens : []).filter(Boolean)));
}

function absBigInt(value) {
  return value < 0n ? -value : value;
}

function nowIso() {
  return new Date().toISOString();
}

async function fetchOpenOrdersWithRetry(actionName) {
  try {
    return await retry(async () => {
      const response = await getApiOpenOrders(runtime.walletAddress);
      if (Array.isArray(response)) return response;
      if (Array.isArray(response?.data)) return response.data;
      throw new Error('CLOB open-orders response is not an array');
    }, 3, 750);
  } catch (error) {
    const ctx = createContext('workers', actionName);
    safeLogWarn(ctx, 'Open-orders fetch failed after retries, skipping this cycle', {
      message: error?.message
    });
    return null;
  }
}

async function ensureClientInitialized() {
  if (runtime.initialized) return;
  if (runtime.initPromise) {
    await runtime.initPromise;
    return;
  }

  runtime.initPromise = (async () => {
    const config = await loadConfig();
    if (!config.walletAddress) {
      throw new Error('Workers require configured wallet (walletAddress is missing)');
    }

    const privateKey = await getDecryptedPrivateKey();
    const l2Creds = await getDecryptedL2Credentials();
    const signer = new Wallet(privateKey);

    await initClient(privateKey, l2Creds);

    runtime.initialized = true;
    runtime.walletAddress = config.walletAddress.toLowerCase();
    runtime.chatId = process.env.WORKERS_NOTIFICATIONS_CHAT_ID || process.env.TELEGRAM_ALLOWED_USER_ID || '';

    const ctx = createContext('workers', 'ensureClientInitialized');
    safeLogInfo(ctx, 'Workers runtime initialized', {
      walletAddress: runtime.walletAddress,
      notificationsChatConfigured: Boolean(runtime.chatId)
    });

    void signer;
  })();

  try {
    await runtime.initPromise;
  } finally {
    runtime.initPromise = null;
  }
}

async function sendWorkerNotification(message, options = {}) {
  if (!runtime.chatId) return;
  try {
    await sendNotification(runtime.chatId, message, options);
  } catch (error) {
    const ctx = createContext('workers', 'sendWorkerNotification');
    safeLogWarn(ctx, 'Failed to send worker notification', { message: error?.message });
  }
}

function resolvePriceAlertCooldownMs(config) {
  const notifications = config?.notifications || {};
  const rawSeconds = Number(
    notifications.alertCooldownSeconds ??
      notifications.priceAlertCooldownSeconds
  );
  if (!Number.isFinite(rawSeconds) || rawSeconds < 0) {
    return DEFAULT_PRICE_ALERT_COOLDOWN_MS;
  }
  return Math.floor(rawSeconds * 1000);
}

async function fetchDataApiList(path, params = {}) {
  const url = new URL(`${DATA_API_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Data API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

async function resolveMissingOrderStatus(orderId, walletAddress) {
  const orderIdVariants = ['order_id', 'orderId', 'id'];
  const seen = new Set();
  let filledSizeBase = 0n;
  let hasTradesEvidence = false;
  let hasActivityEvidence = false;
  let hasFillLikeActivity = false;
  let anyRequestSucceeded = false;

  for (const key of orderIdVariants) {
    try {
      const trades = await fetchDataApiList('/trades', { [key]: orderId, user: walletAddress });
      anyRequestSucceeded = true;
      const aggregated = sumFilledSizeFromRecords(trades, seen, `missing:trades:${key}`);
      if (aggregated.hasEvidence) {
        hasTradesEvidence = true;
        filledSizeBase += aggregated.total;
      }
    } catch {}
  }

  for (const key of orderIdVariants) {
    try {
      const activity = await fetchDataApiList('/activity', { [key]: orderId, user: walletAddress });
      anyRequestSucceeded = true;
      const aggregated = sumFilledSizeFromRecords(activity, seen, `missing:activity:${key}`);
      if (aggregated.hasEvidence) {
        hasActivityEvidence = true;
        filledSizeBase += aggregated.total;
      }
      if (Array.isArray(activity) && activity.some((entry) => isFillLikeActivity(entry))) {
        hasFillLikeActivity = true;
      }
    } catch {}
  }

  if (!anyRequestSucceeded) {
    return {
      status: 'unknown',
      evidence: 'data-api-unavailable',
      filledSizeBase: 0n
    };
  }

  if (hasTradesEvidence || filledSizeBase > 0n || hasFillLikeActivity) {
    return {
      status: 'filled',
      evidence: hasTradesEvidence ? 'trades' : (hasFillLikeActivity ? 'activity-fill-like' : 'filled-size'),
      filledSizeBase
    };
  }

  if (hasActivityEvidence) {
    return {
      status: 'unknown',
      evidence: 'activity-without-fill-signal',
      filledSizeBase: 0n
    };
  }

  return {
    status: 'cancelled',
    evidence: 'not-found-in-open-orders-and-no-trades',
    filledSizeBase: 0n
  };
}

function isFillLikeActivity(entry) {
  const fields = [
    entry?.type,
    entry?.event_type,
    entry?.eventType,
    entry?.action,
    entry?.status,
    entry?.state
  ];

  return fields.some((value) => {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return false;
    return text.includes('fill') || text.includes('match') || text.includes('trade') || text.includes('executed');
  });
}

function getPercentDiffBps(reference, current) {
  if (reference <= 0n) return 0n;
  const delta = current - reference;
  return (absBigInt(delta) * 10_000n) / reference;
}

function buildStrategyEntryPriceMap(strategies) {
  const map = new Map();
  const list = Array.isArray(strategies) ? strategies : [];
  for (const strategy of list) {
    const yesToken = String(strategy?.token_id_yes || '').trim();
    const noToken = String(strategy?.token_id_no || '').trim();
    const yesEntry = toBigIntSafe(strategy?.entry_price_yes_micro, 0n);
    const noEntry = toBigIntSafe(strategy?.entry_price_no_micro, 0n);

    // Keep first value only (active strategies are returned newest first).
    if (yesToken && yesEntry > 0n && !map.has(yesToken)) map.set(yesToken, yesEntry);
    if (noToken && noEntry > 0n && !map.has(noToken)) map.set(noToken, noEntry);
  }
  return map;
}

function applyPercentToPriceMicro(priceMicro, percent) {
  if (typeof priceMicro !== 'bigint' || priceMicro <= 0n) return 0n;
  const bps = Math.round(Number(percent) * 100);
  let adjusted = (priceMicro * BigInt(10_000 + bps)) / 10_000n;
  if (adjusted < 10_000n) adjusted = 10_000n;
  if (adjusted > 990_000n) adjusted = 990_000n;
  return adjusted;
}

function applyPercentToValue(value, percent) {
  if (typeof value !== 'bigint' || value <= 0n) return 0n;
  const bps = Math.round(Number(percent) * 100);
  const adjusted = (value * BigInt(10_000 + bps)) / 10_000n;
  return adjusted > 0n ? adjusted : 0n;
}

async function cancelOrdersAndMark(orderIds) {
  const ids = Array.isArray(orderIds) ? orderIds : [];
  for (const id of ids) {
    try {
      await cancelOrder(id);
    } catch {}
    try {
      await updateOrderStatus(id, 'cancelled');
    } catch {}
  }
}

async function createEmergencyStopLimit(strategy, tokenId, remainingQtyBase) {
  const created = await createOrder({
    tokenId,
    side: 'SELL',
    orderType: 'GTC',
    price: '0.010000',
    sizeShares: formatSharesFromBase(remainingQtyBase)
  });

  const orderId = getOrderId(created);
  if (!orderId) {
    throw new Error('STOP_LIMIT_ORDER_ID_MISSING');
  }
  await upsertOrderStatus({
    id: orderId,
    marketId: strategy.market_id || 'unknown-market',
    tokenId,
    side: 'sell',
    orderSide: 'limit',
    type: 'GTC',
    priceMicro: 10_000n,
    originalSizeBase: remainingQtyBase,
    remainingSizeBase: remainingQtyBase,
    filledSizeBase: 0n,
    status: 'open'
  });

  return orderId;
}

export async function syncPositionsWorker() {
  await ensureClientInitialized();

  const apiPositions = await getApiPositions(runtime.walletAddress);
  const snapshot = [];

  for (const pos of apiPositions) {
    const tokenId = String(pos.token_id || '').trim();
    if (!tokenId) continue;

    const quantityBase = parseSharesBaseSafe(pos.size);
    if (quantityBase <= 0n) continue;

    const avgPriceMicro = parsePriceMicroSafe(pos.avgPrice);
    const marketId = String(pos.market || pos.condition_id || pos.slug || tokenId);
    const side = String(pos.outcome || pos.side || 'unknown');

    snapshot.push({
      marketId,
      tokenId,
      side,
      quantityBase,
      avgPriceMicro
    });
  }

  await replacePositionsSnapshot(snapshot);

  const ctx = createContext('workers', 'syncPositionsWorker');
  safeLogInfo(ctx, 'Positions snapshot synchronized', { count: snapshot.length });
}

export async function monitorOrdersWorker() {
  await ensureClientInitialized();
  const unmanagedCleanup = await cleanupUnmanagedOrders();
  if (unmanagedCleanup?.changes > 0) {
    const ctx = createContext('workers', 'monitorOrdersWorker');
    safeLogWarn(ctx, 'Removed unmanaged market/FOK orders from local cache', { count: unmanagedCleanup.changes });
  }
  const cleanup = await cleanupInvalidTrackedOrders();
  if (cleanup?.changes > 0) {
    const ctx = createContext('workers', 'monitorOrdersWorker');
    safeLogWarn(ctx, 'Removed invalid tracked orders with empty/null IDs', { count: cleanup.changes });
  }

  const openOrders = await fetchOpenOrdersWithRetry('monitorOrdersWorker');
  if (!openOrders) {
    return;
  }
  const openIds = new Set();

  for (const order of openOrders) {
    const orderId = getOrderId(order);
    if (!orderId) continue;
    openIds.add(orderId);
    const tracked = await getOrderById(orderId);

    const remainingInfo = readOrderSizeBase(order, ['remaining_size', 'remainingSize']);
    const originalInfo = readOrderSizeBase(order, ['original_size', 'originalSize', 'size', 'amount']);
    const filledInfo = readOrderSizeBase(order, ['filled_size', 'filledSize', 'size_matched', 'matched_size', 'matchedSize']);

    let effectiveOriginal = originalInfo.value;
    if (effectiveOriginal <= 0n) {
      effectiveOriginal = toBigIntSafe(tracked?.original_size_base, 0n);
    }

    let remainingSizeBase = remainingInfo.hasField ? remainingInfo.value : null;
    let filledSizeBase = filledInfo.hasField ? filledInfo.value : 0n;

    if (remainingSizeBase !== null && effectiveOriginal > 0n && effectiveOriginal > remainingSizeBase && filledSizeBase <= 0n) {
      filledSizeBase = effectiveOriginal - remainingSizeBase;
    }

    if (!remainingInfo.hasField) {
      const dataApiFill = await fetchFilledSizeFromDataApi(orderId, runtime.walletAddress);
      if (dataApiFill.filledSizeBase > filledSizeBase) {
        filledSizeBase = dataApiFill.filledSizeBase;
      }

      if (!dataApiFill.hasEvidence) {
        const ctx = createContext('workers', 'monitorOrdersWorker');
        safeLogWarn(ctx, 'Open order has no remaining size field and no fill evidence from Data API', {
          orderId
        });
      }
    }

    if (effectiveOriginal <= 0n) {
      if (remainingSizeBase !== null && remainingSizeBase > 0n) {
        effectiveOriginal = remainingSizeBase;
      } else if (filledSizeBase > 0n) {
        effectiveOriginal = filledSizeBase;
      }
    }

    if (effectiveOriginal > 0n && filledSizeBase > effectiveOriginal) {
      effectiveOriginal = filledSizeBase;
    }

    if (remainingSizeBase === null) {
      remainingSizeBase = effectiveOriginal > filledSizeBase ? (effectiveOriginal - filledSizeBase) : 0n;
    }
    if (remainingSizeBase < 0n) {
      remainingSizeBase = 0n;
    }
    if (filledSizeBase < 0n) {
      filledSizeBase = 0n;
    }

    if (effectiveOriginal > 0n && remainingSizeBase > effectiveOriginal) {
      remainingSizeBase = effectiveOriginal;
    }
    if (effectiveOriginal > 0n && filledSizeBase > effectiveOriginal) {
      filledSizeBase = effectiveOriginal;
    }
    if (effectiveOriginal > 0n && filledSizeBase === 0n && remainingSizeBase < effectiveOriginal) {
      filledSizeBase = effectiveOriginal - remainingSizeBase;
    }

    let status = 'open';
    if (effectiveOriginal > 0n && remainingSizeBase === 0n) {
      status = 'filled';
    } else if (filledSizeBase > 0n) {
      status = 'partially_filled';
    }

    await upsertOrderStatus({
      id: orderId,
      marketId: order.market || order.slug || 'unknown-market',
      tokenId: order.token_id || order.tokenId || 'unknown-token',
      side: String(order.side || '').toLowerCase() || 'unknown',
      orderSide: 'limit',
      type: 'GTC',
      priceMicro: parsePriceMicroSafe(order.price),
      originalSizeBase: effectiveOriginal,
      remainingSizeBase,
      filledSizeBase,
      status
    });
  }

  const trackedOrders = await getTrackedOrders();
  let hasClosedOrders = false;

  for (const tracked of trackedOrders) {
    const trackedId = String(tracked.id ?? '').trim();
    if (!trackedId || trackedId.toLowerCase() === 'null' || trackedId.toLowerCase() === 'undefined') {
      continue;
    }
    if (openIds.has(trackedId)) continue;

    const resolved = await resolveMissingOrderStatus(trackedId, runtime.walletAddress);
    const originalSizeBase = toBigIntSafe(tracked.original_size_base, 0n);
    const resolvedFilledBase = toBigIntSafe(resolved?.filledSizeBase, 0n);

    if (resolved.status === 'filled') {
      if (resolvedFilledBase > 0n && originalSizeBase > 0n && resolvedFilledBase < originalSizeBase) {
        await updateOrderStatus(trackedId, 'partially_filled', {
          remaining_size_base: originalSizeBase - resolvedFilledBase,
          filled_size_base: resolvedFilledBase
        });
        await sendWorkerNotification(`Order partially filled: ${trackedId}`);
      } else {
        const finalFilled = resolvedFilledBase > 0n ? resolvedFilledBase : originalSizeBase;
        await updateOrderStatus(trackedId, 'filled', {
          remaining_size_base: 0n,
          filled_size_base: finalFilled
        });
        await sendWorkerNotification(`Order filled: ${trackedId}`);
      }
    } else if (resolved.status === 'cancelled') {
      await updateOrderStatus(trackedId, 'cancelled', {
        remaining_size_base: toBigIntSafe(tracked.remaining_size_base, 0n)
      });
      await sendWorkerNotification(`Order cancelled: ${trackedId}`);
    } else {
      const ctx = createContext('workers', 'monitorOrdersWorker');
      safeLogWarn(ctx, 'Order disappeared from open-orders but fill/cancel status is uncertain', {
        orderId: trackedId,
        evidence: resolved?.evidence
      });
      continue;
    }
    hasClosedOrders = true;
  }

  if (hasClosedOrders) {
    await syncPositionsWorker();
  }
}

async function runWorker(name, handler) {
  const metric = ensureWorkerMetric(name);
  if (workerRunning.has(name)) {
    metric.skippedDueToOverlap += 1;
    return;
  }

  const startedAtMs = Date.now();
  metric.runs += 1;
  metric.isRunning = true;
  metric.lastStartedAt = new Date(startedAtMs).toISOString();

  workerRunning.add(name);

  try {
    await handler();
    metric.successes += 1;
    metric.consecutiveFailures = 0;
    metric.lastSuccessAt = nowIso();
    metric.lastErrorName = null;
    metric.lastErrorMessage = null;
  } catch (error) {
    const summary = summarizeWorkerError(error);
    metric.failures += 1;
    metric.consecutiveFailures += 1;
    metric.lastFailureAt = nowIso();
    metric.lastErrorName = summary.name;
    metric.lastErrorMessage = summary.message;
    const ctx = createContext('workers', name);
    safeLogError(ctx, error);
  } finally {
    metric.isRunning = false;
    metric.lastFinishedAt = nowIso();
    metric.lastDurationMs = Date.now() - startedAtMs;
    workerRunning.delete(name);
  }
}

function scheduleWorker(name, intervalMs, handler, runImmediately = true) {
  const run = () => runWorker(name, handler);
  if (runImmediately) {
    run();
  }
  const timer = setInterval(run, intervalMs);
  workerTimers.set(name, timer);
}

const inFlightRedeems = new Set();

function canRedeemPosition(position) {
  const conditionId = position?.conditionId || position?.condition_id || position?.conditionID;
  if (!conditionId) return false;

  // Check explicit redeemable flags
  if (position?.redeemable === true || position?.isRedeemable === true || position?.canRedeem === true) {
    return true;
  }

  // Check numeric amount fields
  if (Number(position?.redeemable_amount) > 0 || Number(position?.redeemableAmount) > 0 || Number(position?.claimable) > 0) {
    return true;
  }

  // Backup check: curPrice=1 means winning position
  const curPrice = position?.curPrice ?? position?.currentPrice ?? position?.cur_price;
  const realizedPnl = position?.realizedPnl ?? position?.realized_pnl;

  if (curPrice !== undefined && Number(curPrice) === 1) {
    if (realizedPnl !== undefined) {
      const pnl = Number(realizedPnl);
      if (pnl === 0 || isNaN(pnl)) {
        return true;
      }
    } else {
      return true;
    }
  }

  return false;
}

// Background auto-redeem worker for all active users
async function autoRedeemWorker() {
  const users = getAllUsers();
  if (!users || users.length === 0) return;

  for (const user of users) {
    const tId = user.telegram_id;
    try {
      const session = await getUserSession(tId);
      if (!session || !session.walletAddress || !session.signer) continue;

      await userContextStorage.run(session, async () => {
        let positions = [];
        try {
          positions = await getApiPositions(session.walletAddress);
        } catch {
          return;
        }

        if (!Array.isArray(positions) || positions.length === 0) return;

        for (const pos of positions) {
          if (!canRedeemPosition(pos)) continue;

          const conditionId = pos.conditionId || pos.condition_id || pos.conditionID;
          if (!conditionId || !/^0x[a-fA-F0-9]{64}$/.test(conditionId)) continue;

          const lockKey = `${session.walletAddress}:${conditionId}`.toLowerCase();
          if (inFlightRedeems.has(lockKey)) continue;

          inFlightRedeems.add(lockKey);
          const ctxLog = createContext('workers', 'autoRedeemWorker');
          safeLogInfo(ctxLog, 'Executing auto-redeem for winning position', {
            telegramId: tId,
            wallet: session.walletAddress,
            conditionId,
            market: pos.market
          });

          try {
            await initContracts(session.signer, getPolygonRpcUrl());
            const receipt = await redeem(conditionId);

            const txHash = receipt?.hash || '';
            const txLink = txHash ? `<a href="https://polygonscan.com/tx/${txHash}">${txHash.slice(0, 10)}...</a>` : '';

            const notifyMsg =
              `🎉 <b>Winning Position Auto-Redeemed!</b>\n\n` +
              `Market: <code>${pos.market || '5M Round'}</code>\n` +
              `Winning Shares: <b>${pos.size || '0'} shares</b>\n` +
              `Status: <b>USDC credited to your wallet ✅</b>\n` +
              (txLink ? `Tx: ${txLink}` : '');

            try {
              await sendNotification(tId, notifyMsg, { parse_mode: 'HTML' });
            } catch {}
          } catch (redeemErr) {
            safeLogWarn(ctxLog, 'Auto-redeem attempt skipped or already claimed', {
              conditionId,
              message: redeemErr?.message
            });
          } finally {
            setTimeout(() => inFlightRedeems.delete(lockKey), 60_000);
          }
        }
      });
    } catch (userErr) {
      const ctx = createContext('workers', 'autoRedeemWorker');
      safeLogWarn(ctx, 'Error in auto-redeem loop for user', {
        telegramId: tId,
        message: userErr?.message
      });
    }
  }
}

export function startWorkers() {
  if (workersStarted) return;
  workersStarted = true;

  const syncPositionsMs = parseIntervalEnv('WORKER_SYNC_POSITIONS_MS', DEFAULT_SYNC_POSITIONS_MS);
  const monitorMs = parseIntervalEnv('WORKER_MONITOR_MS', DEFAULT_MONITOR_MS);
  const healthLogMs = parseIntervalEnv('WORKER_HEALTH_LOG_MS', DEFAULT_WORKER_HEALTH_LOG_MS);
  const autoRedeemMs = parseIntervalEnv('WORKER_AUTO_REDEEM_MS', 60 * 1000);

  scheduleWorker('syncPositionsWorker', syncPositionsMs, syncPositionsWorker, true);
  scheduleWorker('monitorOrdersWorker', monitorMs, monitorOrdersWorker, false);
  scheduleWorker('autoRedeemWorker', autoRedeemMs, autoRedeemWorker, false);
  scheduleWorker(
    'healthLogWorker',
    healthLogMs,
    async () => {
      const ctxHealth = createContext('workers', 'healthLogWorker');
      safeLogInfo(ctxHealth, 'Workers health snapshot', getWorkersHealthSnapshot());
    },
    false
  );

  const ctx = createContext('workers', 'startWorkers');
  safeLogInfo(ctx, 'Workers started', {
    syncPositionsMs,
    monitorMs,
    healthLogMs,
    health: getWorkersHealthSnapshot(),
    startedAt: nowIso()
  });
}

export function stopWorkers() {
  for (const timer of workerTimers.values()) {
    clearInterval(timer);
  }
  workerTimers.clear();
  workerRunning.clear();
  workersStarted = false;

  const ctx = createContext('workers', 'stopWorkers');
  safeLogInfo(ctx, 'Workers stopped', {
    stoppedAt: nowIso(),
    health: getWorkersHealthSnapshot()
  });
}
