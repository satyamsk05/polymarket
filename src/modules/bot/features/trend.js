import { InlineKeyboard } from 'grammy';
import { createContext, safeLogError } from '../../logger.js';

export async function fetchLast10Rounds(coin = 'BTC') {
  const seriesSlug = coin.toUpperCase() === 'ETH' ? 'eth-up-or-down-5m' : 'btc-up-or-down-5m';
  const url = `https://gamma-api.polymarket.com/events?series_slug=${seriesSlug}&closed=true&order=endDate&ascending=false&limit=10`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma API responded with HTTP ${res.status}`);
  }

  const events = await res.json();
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  return events.map((e) => {
    const market = Array.isArray(e.markets) && e.markets[0] ? e.markets[0] : null;
    let prices = [];
    try {
      prices = typeof market?.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices)
        : (market?.outcomePrices || []);
    } catch {
      prices = [];
    }

    let winner = 'UNKNOWN';
    if (prices[0] === '1') {
      winner = 'UP';
    } else if (prices[1] === '1') {
      winner = 'DOWN';
    }

    const timeMatch = e.title?.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)\s*-\s*\d{1,2}:\d{2}\s*(?:AM|PM)\s*ET)/i);
    const timeStr = timeMatch
      ? timeMatch[1]
      : (e.endDate ? new Date(e.endDate).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET' : 'Round');

    return {
      title: e.title,
      timeStr,
      winner,
      endDate: e.endDate
    };
  });
}

export function formatTrendMessage(rounds, coin = 'BTC') {
  const symbol = coin.toUpperCase();
  let upCount = 0;
  let downCount = 0;

  rounds.forEach((r) => {
    if (r.winner === 'UP') upCount++;
    if (r.winner === 'DOWN') downCount++;
  });

  // Calculate current streak
  let streakSide = null;
  let streakCount = 0;
  for (const r of rounds) {
    if (r.winner === 'UP' || r.winner === 'DOWN') {
      if (!streakSide) {
        streakSide = r.winner;
        streakCount = 1;
      } else if (streakSide === r.winner) {
        streakCount++;
      } else {
        break;
      }
    }
  }

  const streakText = streakSide
    ? `${streakSide === 'UP' ? '🟢 UP' : '🔴 DOWN'} (${streakCount} in a row)`
    : 'None';

  // Dot timeline (from oldest to newest)
  const dots = [...rounds]
    .reverse()
    .map((r) => (r.winner === 'UP' ? '🟢' : r.winner === 'DOWN' ? '🔴' : '⚪️'))
    .join(' ');

  let text = `📈 <b>${symbol} 5M Up/Down Trend</b> (Last 10 Rounds)\n\n`;
  text += `<b>Timeline:</b> ${dots}\n`;
  text += `<b>Summary:</b> 🟢 UP: <b>${upCount}</b> | 🔴 DOWN: <b>${downCount}</b>\n`;
  text += `<b>Streak:</b> ${streakText}\n\n`;
  text += `<b>Recent Outcomes:</b>\n`;

  rounds.forEach((r, idx) => {
    const outcomeBadge = r.winner === 'UP'
      ? '🟢 <b>UP</b>'
      : r.winner === 'DOWN'
        ? '🔴 <b>DOWN</b>'
        : '⚪️ Pending';
    text += `${idx + 1}. <code>${r.timeStr}</code> ➔ ${outcomeBadge}\n`;
  });

  return text;
}

export function getTrendKeyboard(coin = 'BTC') {
  const otherCoin = coin.toUpperCase() === 'BTC' ? 'ETH' : 'BTC';
  return new InlineKeyboard()
    .text(`🪙 Switch to ${otherCoin}`, `trend:coin:${otherCoin}`)
    .text('🔄 Refresh', `trend:refresh:${coin.toUpperCase()}`)
    .row()
    .text('⚡️ 1-Click Bet Next Round', 'quick_bet');
}

export function createTrendFeature() {
  async function showTrend(ctx, coin = 'BTC', isEdit = false) {
    try {
      const rounds = await fetchLast10Rounds(coin);
      if (!rounds.length) {
        const errorMsg = `⚠️ No recent rounds data found for ${coin}. Please try again shortly.`;
        if (isEdit && ctx.callbackQuery) {
          return ctx.editMessageText(errorMsg, {
            reply_markup: getTrendKeyboard(coin),
            parse_mode: 'HTML'
          });
        }
        return ctx.reply(errorMsg, {
          reply_markup: getTrendKeyboard(coin),
          parse_mode: 'HTML'
        });
      }

      const text = formatTrendMessage(rounds, coin);
      const keyboard = getTrendKeyboard(coin);

      if (isEdit && ctx.callbackQuery) {
        try {
          await ctx.editMessageText(text, {
            reply_markup: keyboard,
            parse_mode: 'HTML'
          });
        } catch (editErr) {
          // If message is identical, telegram throws "message is not modified"
          if (!String(editErr?.message).includes('message is not modified')) {
            throw editErr;
          }
        }
      } else {
        await ctx.reply(text, {
          reply_markup: keyboard,
          parse_mode: 'HTML'
        });
      }
    } catch (err) {
      safeLogError(createContext('trend', 'showTrend'), err);
      const failMsg = `⚠️ Failed to fetch trend data for ${coin}: ${err.message || 'Network error'}`;
      if (isEdit && ctx.callbackQuery) {
        await ctx.editMessageText(failMsg, {
          reply_markup: getTrendKeyboard(coin),
          parse_mode: 'HTML'
        });
      } else {
        await ctx.reply(failMsg, {
          reply_markup: getTrendKeyboard(coin),
          parse_mode: 'HTML'
        });
      }
    }
  }

  return {
    showTrend
  };
}
