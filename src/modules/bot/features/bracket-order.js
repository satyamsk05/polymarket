import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import {
  createOrder,
  getOrder,
  cancelOrder,
  formatSharesFromBase,
  formatUSDCFromBase,
  parseUSDCToBase,
  getCollateralBalanceBase
} from '../../polymarket.js';
import { createContext, safeLogError, safeLogInfo } from '../../logger.js';
import { busyLocks } from '../runtime.js';
import { getPersistentBottomKeyboard } from '../ui/keyboards.js';

export function normalizePrice(val) {
  if (val === undefined || val === null) return null;
  const num = parseFloat(String(val).trim());
  if (isNaN(num) || num <= 0) return null;

  // 1 to 99 represents cents: 2 -> 0.02, 20 -> 0.20, 45 -> 0.45
  if (num >= 1 && num <= 99) {
    return parseFloat((num / 100).toFixed(4));
  }
  // Decimal 0.01 to 0.99
  if (num > 0 && num < 1) {
    return parseFloat(num.toFixed(4));
  }
  return null;
}

export function parseLiveBracketCommand(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim().toLowerCase();

  // Pattern 1: e.g. "up 2 2 3", "down 5 45 50", "up 2 2 3 eth", "down $5 45 50 btc"
  const p1 = raw.match(/^(up|down|u|d)\s+\$?(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s+(btc|eth))?$/i);
  if (p1) {
    const side = p1[1].toLowerCase().startsWith('u') ? 'UP' : 'DOWN';
    const amount = parseFloat(p1[2]);
    const buyPrice = normalizePrice(p1[3]);
    const sellPrice = normalizePrice(p1[4]);
    const coin = p1[5] ? p1[5].toUpperCase() : 'BTC';

    if (!amount || amount <= 0) {
      return { error: 'Bet amount must be greater than $0.' };
    }
    if (!buyPrice || !sellPrice) {
      return { error: 'Prices must be between 1¢ and 99¢ (e.g. 2 for 2¢, 45 for 45¢).' };
    }
    if (sellPrice <= buyPrice) {
      const buyCents = Math.round(buyPrice * 100);
      const sellCents = Math.round(sellPrice * 100);
      return {
        error: `Target sell price (${sellCents}¢) must be higher than buy price (${buyCents}¢).`
      };
    }

    return {
      side,
      amount,
      buyPrice,
      sellPrice,
      buyPriceCents: Math.round(buyPrice * 100),
      sellPriceCents: Math.round(sellPrice * 100),
      coin
    };
  }

  // Pattern 2: e.g. "$2 up 2 3", "5 down 45 50", "2 up 2 3 eth"
  const p2 = raw.match(/^\$?(\d+(?:\.\d+)?)\s+(up|down|u|d)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s+(btc|eth))?$/i);
  if (p2) {
    const amount = parseFloat(p2[1]);
    const side = p2[2].toLowerCase().startsWith('u') ? 'UP' : 'DOWN';
    const buyPrice = normalizePrice(p2[3]);
    const sellPrice = normalizePrice(p2[4]);
    const coin = p2[5] ? p2[5].toUpperCase() : 'BTC';

    if (!amount || amount <= 0) {
      return { error: 'Bet amount must be greater than $0.' };
    }
    if (!buyPrice || !sellPrice) {
      return { error: 'Prices must be between 1¢ and 99¢ (e.g. 2 for 2¢, 45 for 45¢).' };
    }
    if (sellPrice <= buyPrice) {
      const buyCents = Math.round(buyPrice * 100);
      const sellCents = Math.round(sellPrice * 100);
      return {
        error: `Target sell price (${sellCents}¢) must be higher than buy price (${buyCents}¢).`
      };
    }

    return {
      side,
      amount,
      buyPrice,
      sellPrice,
      buyPriceCents: Math.round(buyPrice * 100),
      sellPriceCents: Math.round(sellPrice * 100),
      coin
    };
  }

  return null;
}

export async function fetchLive5mRound(coin = 'BTC') {
  const seriesSlug = coin.toUpperCase() === 'ETH' ? 'eth-up-or-down-5m' : 'btc-up-or-down-5m';
  const url = `https://gamma-api.polymarket.com/events?series_slug=${seriesSlug}&closed=false&order=endDate&ascending=true`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma API responded with HTTP ${res.status}`);
  }

  const data = await res.json();
  const now = Date.now();
  const activeEvents = (Array.isArray(data) ? data : [])
    .filter((e) => !e.closed && e.endDate && new Date(e.endDate).getTime() > now)
    .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

  if (activeEvents.length === 0) {
    throw new Error(`No active ${coin} 5M round currently found on Polymarket.`);
  }

  // activeEvents[0] is the current LIVE running round
  const liveEvent = activeEvents[0];
  const market = Array.isArray(liveEvent.markets) && liveEvent.markets[0] ? liveEvent.markets[0] : liveEvent;

  let tokenIds = [];
  try {
    tokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
  } catch {
    tokenIds = [];
  }

  if (!Array.isArray(tokenIds) || tokenIds.length < 2) {
    throw new Error('Missing token IDs on live round.');
  }

  const endMs = new Date(liveEvent.endDate).getTime();
  const timeLeftSec = Math.max(0, Math.round((endMs - now) / 1000));

  return {
    event: liveEvent,
    market,
    title: liveEvent.title || market.question || `${coin} 5M Up/Down`,
    endDate: liveEvent.endDate,
    upTokenId: tokenIds[0],
    downTokenId: tokenIds[1],
    timeLeftSec
  };
}

export function createBracketOrderFeature(deps = {}) {
  const { ensureClientInitialized } = deps;

  async function handleLiveBracketOrder(ctx, parsed) {
    const chatId = ctx.chat.id;

    if (parsed.error) {
      await ctx.reply(`⚠️ ${parsed.error}`, {
        reply_markup: getPersistentBottomKeyboard()
      });
      return;
    }

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

    busyLocks.set(chatId, true);

    try {
      if (ensureClientInitialized) {
        await ensureClientInitialized();
      }

      const { side, amount, buyPrice, sellPrice, buyPriceCents, sellPriceCents, coin } = parsed;
      const liveRound = await fetchLive5mRound(coin);

      if (liveRound.timeLeftSec <= 10) {
        await ctx.reply(
          `⚠️ <b>Round is ending in ~${liveRound.timeLeftSec}s!</b>\nToo late to place limit orders for this round. Please wait a few seconds for the next round to become live.`,
          {
            reply_markup: getPersistentBottomKeyboard(),
            parse_mode: 'HTML'
          }
        );
        return;
      }

      // Calculate shares based on USD amount / buy price
      const rawShares = Math.floor(amount / buyPrice);
      if (rawShares < 5) {
        await ctx.reply(
          `❌ <b>Order size too small!</b>\nAmount \$${amount} @ ${buyPriceCents}¢ yields <b>${rawShares} shares</b>.\nPolymarket CLOB requires at least <b>5 shares</b> per limit order.\nPlease increase the bet amount.`,
          {
            reply_markup: getPersistentBottomKeyboard(),
            parse_mode: 'HTML'
          }
        );
        return;
      }

      // Pre-check USDC collateral balance
      try {
        const requiredUsdcBase = parseUSDCToBase(amount.toString());
        const currentBalanceBase = await getCollateralBalanceBase();
        if (typeof currentBalanceBase === 'bigint' && currentBalanceBase < requiredUsdcBase) {
          const userBalance = formatUSDCFromBase(currentBalanceBase);
          await ctx.reply(
            `❌ <b>Insufficient Balance</b>\n\n` +
            `Required: <b>$${amount.toFixed(2)} USDC</b>\n` +
            `Available: <b>$${userBalance} USDC</b>\n\n` +
            `Aapke bot wallet mein sufficient USDC balance nahi hai. Trading shuru karne ke liye pehle Polygon network par USDC deposit karein.`,
            {
              reply_markup: getPersistentBottomKeyboard(),
              parse_mode: 'HTML'
            }
          );
          return;
        }
      } catch (balErr) {
        // Non-blocking if balance check fails, let exchange validate
      }

      const targetTokenId = side === 'UP' ? liveRound.upTokenId : liveRound.downTokenId;
      const sideIcon = side === 'UP' ? '🟢' : '🔴';

      const minLeft = Math.floor(liveRound.timeLeftSec / 60);
      const secLeft = liveRound.timeLeftSec % 60;
      const timeLeftStr = `${minLeft}m ${secLeft}s`;

      await ctx.reply(
        `⏳ Placing <b>${sideIcon} ${side}</b> Buy Limit Order @ <b>${buyPriceCents}¢</b> for <b>${rawShares} shares</b> in Live Round (${coin})...`,
        { parse_mode: 'HTML' }
      );

      // Place Buy Limit Order (GTC)
      const buyResult = await createOrder({
        tokenId: targetTokenId,
        price: buyPrice.toString(),
        sizeShares: rawShares.toString(),
        side: 'BUY',
        orderType: 'GTC'
      });

      const buyOrderId = buyResult?.orderID || buyResult?.id || buyResult?.order_id;
      if (!buyOrderId) {
        const detail = buyResult?.errorMsg || buyResult?.error || buyResult?.message;
        throw new Error(detail || 'Order rejected by CLOB exchange (insufficient funds or collateral).');
      }

      const placedText =
        `⚡️ <b>Live Round Scalp Placed!</b>\n\n` +
        `🪙 <b>Asset:</b> ${coin} (Live 5M Round)\n` +
        `⏰ <b>Ends In:</b> ~${timeLeftStr}\n` +
        `👉 <b>Side:</b> ${sideIcon} <b>${side}</b>\n` +
        `💵 <b>Budget:</b> $${amount.toFixed(2)} USDC\n` +
        `📉 <b>Buy Limit:</b> <b>${buyPriceCents}¢</b> ($${buyPrice.toFixed(2)})\n` +
        `📈 <b>Auto-Sell Target:</b> <b>${sellPriceCents}¢</b> ($${sellPrice.toFixed(2)})\n` +
        `📦 <b>Shares:</b> <b>${rawShares} SHARES</b>\n` +
        `🆔 <b>Buy Order:</b> <code>${buyOrderId}</code>\n\n` +
        `⏳ <i>Watching live market... As soon as Buy fills, Auto-Sell order will trigger instantly!</i>`;

      await ctx.reply(placedText, {
        reply_markup: getPersistentBottomKeyboard(),
        parse_mode: 'HTML'
      });

      const ctxLog = createContext('bracketOrder', 'placed');
      safeLogInfo(ctxLog, 'Live bracket order placed successfully', {
        coin,
        side,
        amount,
        buyPrice,
        sellPrice,
        rawShares,
        buyOrderId
      });

      // Start asynchronous watcher for this bracket order
      watchBracketOrder({
        buyOrderId,
        targetTokenId,
        side,
        rawShares,
        amount,
        buyPrice,
        sellPrice,
        buyPriceCents,
        sellPriceCents,
        coin,
        liveRound,
        chatId,
        ctx
      }).catch((err) => {
        const errLog = createContext('bracketOrder', 'watcherError');
        safeLogError(errLog, err);
      });

    } catch (err) {
      const ctxLog = createContext('bracketOrder', 'error');
      safeLogError(ctxLog, err);

      let errorMsg = err?.message || 'Transaction failed';
      const lower = errorMsg.toLowerCase();
      if (
        lower.includes('collateral') ||
        lower.includes('allowance') ||
        lower.includes('balance') ||
        lower.includes('insufficient') ||
        lower.includes('obtain order id')
      ) {
        errorMsg = 'Insufficient USDC balance in wallet. Please fund your bot wallet with USDC on Polygon to place orders.';
      }

      await ctx.reply(
        `❌ <b>Limit Order Placement Failed</b>\n\nReason: <i>${errorMsg}</i>`,
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
    handleLiveBracketOrder
  };
}

async function watchBracketOrder(params) {
  const {
    buyOrderId,
    targetTokenId,
    side,
    rawShares,
    amount,
    buyPrice,
    sellPrice,
    buyPriceCents,
    sellPriceCents,
    coin,
    liveRound,
    chatId,
    ctx
  } = params;

  const roundEndMs = new Date(liveRound.endDate).getTime();
  let buyFilled = false;
  let filledShares = rawShares;
  let sellOrderId = null;

  // Poll every 1.5 seconds
  const pollInterval = 1500;

  // Phase 1: Watch Buy Order
  while (!buyFilled) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const now = Date.now();
    // Safety check: If round is within 4 seconds of ending and buy hasn't filled, cancel it
    if (now >= roundEndMs - 4000) {
      try {
        await cancelOrder(buyOrderId);
        await ctx.api.sendMessage(
          chatId,
          `⏱ <b>Live Round Ended - Buy Unfilled</b>\n\n` +
          `🪙 <b>${coin}</b> 5M Round has concluded.\n` +
          `Your Buy Limit price (<b>${buyPriceCents}¢</b>) was not reached during this round.\n` +
          `The unfilled buy order has been cancelled and your funds are safe!`,
          { parse_mode: 'HTML' }
        );
      } catch (cancelErr) {
        // If it was already filled at the very last moment
        try {
          const check = await getOrder(buyOrderId);
          if (check && (check.status === 'MATCHED' || check.status === 'FILLED')) {
            buyFilled = true;
            filledShares = parseFloat(check.size_matched) || rawShares;
            break;
          }
        } catch {}
      }
      return;
    }

    try {
      const order = await getOrder(buyOrderId);
      if (!order) continue;

      const status = String(order.status || '').toUpperCase();
      const matched = parseFloat(order.size_matched || order.filled_size || 0);

      if (status === 'CANCELED') {
        await ctx.api.sendMessage(
          chatId,
          `ℹ️ <b>Buy order cancelled:</b> <code>${buyOrderId}</code>. Bracket watcher stopped.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      if (status === 'MATCHED' || status === 'FILLED' || matched >= rawShares) {
        buyFilled = true;
        if (matched > 0) filledShares = matched;
        break;
      }
    } catch (pollErr) {
      // Non-fatal, retry next tick
    }
  }

  // Phase 2: Buy Filled -> Place Auto-Sell Limit Order Immediately!
  try {
    const sideIcon = side === 'UP' ? '🟢' : '🔴';
    await ctx.api.sendMessage(
      chatId,
      `🟢 <b>BUY ORDER FILLED!</b>\n\n` +
      `Matched <b>${filledShares} SHARES</b> @ <b>${buyPriceCents}¢</b>\n` +
      `⚡️ Placing Auto-Sell Limit @ <b>${sellPriceCents}¢</b> instantly...`,
      { parse_mode: 'HTML' }
    );

    const sellResult = await createOrder({
      tokenId: targetTokenId,
      price: sellPrice.toString(),
      sizeShares: filledShares.toString(),
      side: 'SELL',
      orderType: 'GTC'
    });

    sellOrderId = sellResult?.orderID || sellResult?.id;

    await ctx.api.sendMessage(
      chatId,
      `🎯 <b>Take-Profit Sell Order Active!</b>\n\n` +
      `🪙 <b>Asset:</b> ${coin}\n` +
      `👉 <b>Side:</b> Sell ${sideIcon} ${side}\n` +
      `📦 <b>Shares:</b> <b>${filledShares} SHARES</b>\n` +
      `📈 <b>Target Price:</b> <b>${sellPriceCents}¢</b> ($${sellPrice.toFixed(2)})\n` +
      `🆔 <b>Sell Order ID:</b> <code>${sellOrderId}</code>\n\n` +
      `⏳ <i>Waiting for price to hit ${sellPriceCents}¢ before round ends...</i>`,
      { parse_mode: 'HTML' }
    );
  } catch (sellErr) {
    await ctx.api.sendMessage(
      chatId,
      `❌ <b>Failed to place Auto-Sell order:</b> <i>${sellErr?.message}</i>\n` +
      `You own ${filledShares} shares. You can sell manually via /orders or Positions menu.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Phase 3: Watch Sell Order
  let sellFilled = false;
  while (!sellFilled) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const now = Date.now();
    if (now >= roundEndMs) {
      await ctx.api.sendMessage(
        chatId,
        `🏁 <b>Round Concluded</b>\n\n` +
        `Your take-profit sell order (<b>${sellPriceCents}¢</b>) did not hit before the round ended.\n` +
        `You are holding <b>${filledShares} SHARES</b> into round resolution (0 or 1).`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    try {
      const order = await getOrder(sellOrderId);
      if (!order) continue;

      const status = String(order.status || '').toUpperCase();
      const matched = parseFloat(order.size_matched || order.filled_size || 0);

      if (status === 'CANCELED') {
        await ctx.api.sendMessage(
          chatId,
          `ℹ️ <b>Sell order cancelled:</b> <code>${sellOrderId}</code>.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      if (status === 'MATCHED' || status === 'FILLED' || matched >= filledShares) {
        sellFilled = true;
        const totalPayout = filledShares * sellPrice;
        const netProfit = totalPayout - amount;
        const profitPercent = Math.round((netProfit / amount) * 100);

        await ctx.api.sendMessage(
          chatId,
          `🎉 <b>TARGET HIT & PROFIT BOOKED!</b> 🚀\n\n` +
          `✅ <b>Take-Profit Executed!</b>\n` +
          `📦 <b>Sold:</b> ${filledShares} SHARES @ <b>${sellPriceCents}¢</b>\n` +
          `💵 <b>Total Payout:</b> <b>$${totalPayout.toFixed(2)} USDC</b>\n` +
          `💰 <b>Net Profit:</b> <b>+$${netProfit.toFixed(2)} USDC</b> (+${profitPercent}%)\n\n` +
          `⚡️ <i>Scalp completed successfully!</i>`,
          { parse_mode: 'HTML' }
        );
        return;
      }
    } catch (pollErr) {
      // Non-fatal, retry next tick
    }
  }
}
