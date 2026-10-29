import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import {
  placeMarketBuyFOK,
  formatUSDCFromBase,
  parseUSDCToBase
} from '../../polymarket.js';
import { createContext, safeLogError, safeLogInfo } from '../../logger.js';
import { busyLocks } from '../runtime.js';
import {
  getPersistentBottomKeyboard,
  getQuickBetAmountKeyboard,
  getQuickBetDirectionKeyboard
} from '../ui/keyboards.js';

// In-memory selection state per user: { amount: 3, coin: 'BTC' }
const quickBetSelections = new Map();

function getUserSelection(chatId) {
  if (!quickBetSelections.has(chatId)) {
    quickBetSelections.set(chatId, { amount: 3, coin: 'BTC' });
  }
  return quickBetSelections.get(chatId);
}

export async function fetchNext5mRound(coin = 'BTC') {
  const seriesSlug = coin.toUpperCase() === 'ETH' ? 'eth-up-or-down-5m' : 'btc-up-or-down-5m';
  const url = `https://gamma-api.polymarket.com/events?series_slug=${seriesSlug}&closed=false&order=endDate&ascending=true`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma API responded with HTTP ${res.status}`);
  }

  const data = await res.json();
  const now = Date.now();
  const upcoming = (Array.isArray(data) ? data : [])
    .filter((e) => !e.closed && e.endDate && new Date(e.endDate).getTime() > now)
    .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

  if (upcoming.length < 2) {
    throw new Error('Next round is not yet listed by Polymarket. Please check back in a moment.');
  }

  // upcoming[0] is the current running round. upcoming[1] is the NEXT round!
  const nextEvent = upcoming[1];
  const market = Array.isArray(nextEvent.markets) && nextEvent.markets[0] ? nextEvent.markets[0] : nextEvent;

  let tokenIds = [];
  try {
    tokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
  } catch {
    tokenIds = [];
  }

  if (!Array.isArray(tokenIds) || tokenIds.length < 2) {
    throw new Error('Missing token IDs on next round.');
  }

  return {
    event: nextEvent,
    market,
    title: nextEvent.title || market.question || '5M Up/Down',
    endDate: nextEvent.endDate,
    upTokenId: tokenIds[0],
    downTokenId: tokenIds[1]
  };
}

export function parseQuickBetTextCommand(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim().toLowerCase();

  // Don't match navigation / button texts like "Buy UP ($3)", "Buy DOWN ($5)", "Back", "Settings"
  if (raw.startsWith('buy up') || raw.startsWith('buy down') || raw.includes('switch to')) {
    return null;
  }

  // 1. e.g. "50 up", "50up", "$50 up", "50$ up", "50 u", "50 up eth", "30 down btc"
  const p1 = raw.match(/^\$?(\d+(?:\.\d+)?)\s*\$?\s*(up|down|u|d)(?:\s*(btc|eth))?$/i);
  if (p1) {
    const amount = parseFloat(p1[1]);
    if (!amount || amount <= 0) return null;
    const side = p1[2].toLowerCase().startsWith('u') ? 'UP' : 'DOWN';
    const coin = p1[3] ? p1[3].toUpperCase() : null;
    return { amount, side, coin };
  }

  // 2. e.g. "up 50", "down 30", "up $50", "down $30 eth"
  const p2 = raw.match(/^(up|down)\s*\$?(\d+(?:\.\d+)?)\s*\$?(?:\s*(btc|eth))?$/i);
  if (p2) {
    const amount = parseFloat(p2[2]);
    if (!amount || amount <= 0) return null;
    const side = p2[1].toLowerCase().startsWith('u') ? 'UP' : 'DOWN';
    const coin = p2[3] ? p2[3].toUpperCase() : null;
    return { amount, side, coin };
  }

  // 3. e.g. "50 eth up", "30 btc down", "$50 btc up"
  const p3 = raw.match(/^\$?(\d+(?:\.\d+)?)\s*\$?\s*(btc|eth)\s*(up|down|u|d)$/i);
  if (p3) {
    const amount = parseFloat(p3[1]);
    if (!amount || amount <= 0) return null;
    const coin = p3[2].toUpperCase();
    const side = p3[3].toLowerCase().startsWith('u') ? 'UP' : 'DOWN';
    return { amount, side, coin };
  }

  // 4. e.g. "eth 50 up", "btc 30 down"
  const p4 = raw.match(/^(btc|eth)\s*\$?(\d+(?:\.\d+)?)\s*\$?\s*(up|down|u|d)$/i);
  if (p4) {
    const amount = parseFloat(p4[2]);
    if (!amount || amount <= 0) return null;
    const coin = p4[1].toUpperCase();
    const side = p4[3].toLowerCase().startsWith('u') ? 'UP' : 'DOWN';
    return { amount, side, coin };
  }

  return null;
}

export function createQuickBetFeature(deps = {}) {
  const { ensureClientInitialized } = deps;

  // STEP 1: Select Amount ONLY in bottom keyboard (No inline buttons!)
  async function showQuickBetMenu(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');
    const chatId = ctx.chat.id;

    if (!config.walletAddress) {
      await ctx.reply(t('error_no_wallet'), {
        reply_markup: getPersistentBottomKeyboard()
      });
      return;
    }

    const state = getUserSelection(chatId);
    let nextRoundInfo = null;
    let startsInSec = null;

    try {
      nextRoundInfo = await fetchNext5mRound(state.coin);
      const now = Date.now();
      const endMs = new Date(nextRoundInfo.endDate).getTime();
      const startMs = endMs - 300_000;
      startsInSec = Math.max(0, Math.round((startMs - now) / 1000));
    } catch {}

    const minutesLeft = startsInSec !== null ? Math.floor(startsInSec / 60) : 0;
    const secondsLeft = startsInSec !== null ? startsInSec % 60 : 0;
    const timeDisplay = startsInSec !== null ? `${minutesLeft}m ${secondsLeft}s` : 'soon';

    let text = `⚡️ <b>1-Click Quick Bet (Step 1/2)</b>\n\n`;
    if (nextRoundInfo) {
      text += `🎯 Target: <b>Next 5M Round</b> (Starts in <b>~${timeDisplay}</b>)\n`;
      text += `Market: <code>${nextRoundInfo.title}</code>\n`;
    }
    text += `🪙 Asset: <b>${state.coin}</b>\n\n`;
    text += `👉 <b>Select Bet Amount:</b>`;

    await ctx.reply(text, {
      reply_markup: getQuickBetAmountKeyboard(state.coin),
      parse_mode: 'HTML'
    });
  }

  // STEP 2: Amount is selected -> Select Direction ONLY in bottom keyboard
  async function showDirectionMenu(ctx, amount) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');
    const chatId = ctx.chat.id;

    const state = getUserSelection(chatId);
    state.amount = Number(amount) || state.amount || 3;

    let nextRoundInfo = null;
    let startsInSec = null;
    try {
      nextRoundInfo = await fetchNext5mRound(state.coin);
      const now = Date.now();
      const endMs = new Date(nextRoundInfo.endDate).getTime();
      const startMs = endMs - 300_000;
      startsInSec = Math.max(0, Math.round((startMs - now) / 1000));
    } catch {}

    const minutesLeft = startsInSec !== null ? Math.floor(startsInSec / 60) : 0;
    const secondsLeft = startsInSec !== null ? startsInSec % 60 : 0;
    const timeDisplay = startsInSec !== null ? `${minutesLeft}m ${secondsLeft}s` : 'soon';

    let text = `⚡️ <b>1-Click Quick Bet (Step 2/2)</b>\n\n`;
    if (nextRoundInfo) {
      text += `🎯 Target: <b>Next 5M Round</b> (Starts in <b>~${timeDisplay}</b>)\n`;
      text += `Market: <code>${nextRoundInfo.title}</code>\n`;
    }
    text += `🪙 Asset: <b>${state.coin}</b>\n`;
    text += `💵 Selected Amount: <b>$${state.amount}.00 USDC</b>\n\n`;
    text += `👉 <b>Select Direction (Places Market Order Instantly):</b>`;

    await ctx.reply(text, {
      reply_markup: getQuickBetDirectionKeyboard(state.amount, state.coin),
      parse_mode: 'HTML'
    });
  }

  async function handleSelectAmount(ctx, amount) {
    await showDirectionMenu(ctx, amount);
  }

  async function handleToggleCoin(ctx, targetCoin) {
    const chatId = ctx.chat.id;
    const state = getUserSelection(chatId);
    state.coin = targetCoin === 'ETH' ? 'ETH' : 'BTC';
    await showQuickBetMenu(ctx);
  }

  async function handleExecuteQuickBet(ctx, side, customAmount = null, customCoin = null) {
    const chatId = ctx.chat.id;
    if (busyLocks.get(chatId)) {
      await ctx.reply('⏳ Previous request is processing, please wait a moment.');
      return;
    }

    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');

    if (!config.walletAddress) {
      await ctx.reply(t('error_no_wallet'), {
        reply_markup: getPersistentBottomKeyboard()
      });
      return;
    }

    const state = getUserSelection(chatId);
    const amountUSDC = customAmount !== null && !isNaN(customAmount) ? Number(customAmount) : state.amount;
    const targetCoin = customCoin ? customCoin.toUpperCase() : state.coin;

    if (amountUSDC <= 0) {
      await ctx.reply('❌ Invalid amount. Amount must be greater than $0.');
      return;
    }

    busyLocks.set(chatId, true);
    const normSide = side.toLowerCase() === 'up' ? 'UP' : 'DOWN';

    await ctx.reply(`⏳ Placing <b>$${amountUSDC}.00</b> Market Buy on <b>${normSide}</b> for Next Round (${targetCoin})...`, {
      parse_mode: 'HTML'
    });

    try {
      if (ensureClientInitialized) {
        await ensureClientInitialized();
      }

      const nextRound = await fetchNext5mRound(targetCoin);
      const targetTokenId = normSide === 'UP' ? nextRound.upTokenId : nextRound.downTokenId;

      const result = await placeMarketBuyFOK(targetTokenId, amountUSDC);

      const orderId = result?.orderID || result?.id || 'Submitted';
      const sideIcon = normSide === 'UP' ? '🟢' : '🔴';

      let successText = `⚡️ <b>1-Click Bet Executed!</b>\n\n`;
      successText += `Asset: <b>${targetCoin}</b>\n`;
      successText += `Market: <code>${nextRound.title}</code>\n`;
      successText += `Side: <b>${sideIcon} ${normSide}</b>\n`;
      successText += `Amount: <b>$${amountUSDC}.00 USDC</b> (Market Order)\n`;
      successText += `Order ID: <code>${orderId}</code>\n`;
      successText += `Status: <b>MATCHED</b> ✅\n`;

      await ctx.reply(successText, {
        reply_markup: getPersistentBottomKeyboard(),
        parse_mode: 'HTML'
      });

      const ctxLog = createContext('quickBet', 'executed');
      safeLogInfo(ctxLog, 'Quick bet placed successfully', {
        coin: targetCoin,
        side: normSide,
        amountUSDC,
        orderId
      });
    } catch (err) {
      const ctxLog = createContext('quickBet', 'error');
      safeLogError(ctxLog, err);

      let errorMsg = err?.message || 'Transaction failed';
      if (errorMsg.includes('collateral') || errorMsg.includes('allowance')) {
        errorMsg = 'Insufficient USDC collateral balance or allowance.';
      }

      await ctx.reply(
        `❌ <b>Quick Bet Failed</b>\n\nReason: <i>${errorMsg}</i>`,
        {
          reply_markup: getPersistentBottomKeyboard(),
          parse_mode: 'HTML'
        }
      );
    } finally {
      busyLocks.delete(chatId);
    }
  }

  return {
    showQuickBetMenu,
    showDirectionMenu,
    handleSelectAmount,
    handleToggleCoin,
    handleExecuteQuickBet
  };
}
