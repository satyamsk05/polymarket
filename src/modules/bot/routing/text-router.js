import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { createContext, safeLogError } from '../../logger.js';
import { mapErrorToUserMessage } from '../../polymarket.js';
import { busyLocks, userStates } from '../runtime.js';
import { parseQuickBetTextCommand } from '../features/quick-bet.js';

function normalizeCtx(ctx) {
  if (!ctx.callbackQuery && !ctx._normalized) {
    let sentMessage = null;
    ctx.editMessageText = async (text, other) => {
      if (sentMessage) {
        try {
          return await ctx.api.editMessageText(ctx.chat.id, sentMessage.message_id, text, other);
        } catch {}
      }
      sentMessage = await ctx.reply(text, other);
      return sentMessage;
    };
    ctx._normalized = true;
  }
  return ctx;
}

export function createHandleTextMessageRouter(deps) {
  const {
    parsePolymarketEventUrl,
    handlePolymarketEventUrlInput,
    getMainMenuKeyboard,
    getPersistentBottomKeyboard,
    showQuickBet,
    showMarketsList,
    showPositions,
    showOrders,
    showSettings,
    handleShowBalance,
    handleManualRedeem,
    handleQuickBetAmount,
    handleQuickBetCoin,
    handleQuickBetExecute,
    handleSetAllowances,
    handleCollateralStatus,
    handleWrapAllUsdce,
    startWithdrawFlow,
    handleStartExportPk,
    handleBuyAmount,
    handleSellAmount,
    handleSplitAmount,
    handleStrategySplitAmount,
    handleMergeAmount,
    handleExportConfirmation,
    handleLimitAmount,
    handleLimitPrice,
    handleStrategySettingsInput,
    handleNotificationSettingsInput,
    handleEventsFilterRangeInput,
    handleWithdrawAddress,
    handleWithdrawAmount
  } = deps;

  return async function handleTextMessage(ctx) {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');
    const norm = (text || '').trim();

    // 1-Click Bet Amount Selection ($1, $3, $5, $10)
    if (norm === '$1' || norm === '$3' || norm === '$5' || norm === '$10') {
      userStates.delete(chatId);
      const amt = Number(norm.replace('$', ''));
      if (handleQuickBetAmount) return await handleQuickBetAmount(ctx, amt);
    }

    // 1-Click Bet Coin Toggle
    if (norm.includes('Switch to ETH')) {
      userStates.delete(chatId);
      if (handleQuickBetCoin) return await handleQuickBetCoin(ctx, 'ETH');
    }
    if (norm.includes('Switch to BTC')) {
      userStates.delete(chatId);
      if (handleQuickBetCoin) return await handleQuickBetCoin(ctx, 'BTC');
    }

    // 1-Click Bet Direction Selection
    if (norm.includes('Buy UP')) {
      userStates.delete(chatId);
      if (handleQuickBetExecute) return await handleQuickBetExecute(ctx, 'up');
    }
    if (norm.includes('Buy DOWN')) {
      userStates.delete(chatId);
      if (handleQuickBetExecute) return await handleQuickBetExecute(ctx, 'down');
    }
    if (norm.includes('Change Amount') || norm === '🔄 Refresh') {
      userStates.delete(chatId);
      if (showQuickBet) return await showQuickBet(ctx);
    }

    // Direct Quick Bet Text Shortcut (e.g. "50 up", "30 down", "50up", "30down", "50 up eth")
    const quickCmd = parseQuickBetTextCommand(norm);
    if (quickCmd) {
      userStates.delete(chatId);
      if (handleQuickBetExecute) {
        return await handleQuickBetExecute(ctx, quickCmd.side, quickCmd.amount, quickCmd.coin);
      }
    }

    // Settings actions from bottom keyboard
    if (norm.includes('Redeem Winnings') || norm.includes('Redeem')) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (handleManualRedeem) return await handleManualRedeem(ctx);
    }
    if (norm.includes('Set Allowances')) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (handleSetAllowances) return await handleSetAllowances(ctx);
    }
    if (norm.includes('Collateral Status')) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (handleCollateralStatus) return await handleCollateralStatus(ctx);
    }
    if (norm.includes('Wrap USDC.e')) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (handleWrapAllUsdce) return await handleWrapAllUsdce(ctx);
    }
    if (norm.includes('Withdraw Funds')) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (startWithdrawFlow) return await startWithdrawFlow(ctx);
    }
    if (norm.includes('Export Private Key')) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (handleStartExportPk) return await handleStartExportPk(ctx);
    }
    if (norm.includes('CONFIRM EXPORT')) {
      normalizeCtx(ctx);
      if (handleExportConfirmation) return await handleExportConfirmation(ctx, userStates.get(chatId) || {}, 'confirm');
    }
    if (norm.includes('Back to Settings')) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (showSettings) return await showSettings(ctx);
    }

    // Return to main menu
    if (norm.includes('Back to Menu') || norm.includes('Main Menu')) {
      userStates.delete(chatId);
      await ctx.reply(t('main_menu'), {
        reply_markup: getPersistentBottomKeyboard ? getPersistentBottomKeyboard() : await getMainMenuKeyboard(config.language || 'en')
      });
      return;
    }

    // Bottom persistent keyboard navigation triggers
    if (norm.includes('1-Click Bet')) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (showQuickBet) return await showQuickBet(ctx);
    }
    if (norm.includes('Balance')) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (handleShowBalance) return await handleShowBalance(ctx);
    }
    if (norm.includes('5M UpDown') || norm.includes('BTC/ETH')) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (showMarketsList) return await showMarketsList(ctx, 1);
    }
    if (norm.includes('Positions') || norm.includes(t('menu_positions'))) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (showPositions) return await showPositions(ctx);
    }
    if (norm.includes('Orders') || norm.includes(t('menu_orders'))) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (showOrders) return await showOrders(ctx);
    }
    if (norm.includes('Settings') || norm.includes(t('menu_settings'))) {
      userStates.delete(chatId);
      normalizeCtx(ctx);
      if (showSettings) return await showSettings(ctx);
    }

    const state = userStates.get(chatId);
    if (!state) {
      const parsedUrl = parsePolymarketEventUrl(text);
      if (parsedUrl) {
        await handlePolymarketEventUrlInput(ctx, parsedUrl, t);
        return;
      }

      // No active state, show menu
      await ctx.reply(t('main_menu'), {
        reply_markup: getPersistentBottomKeyboard ? getPersistentBottomKeyboard() : await getMainMenuKeyboard(config.language || 'en')
      });
      return;
    }
    
    // Check busy lock - but NOT during confirmation state
    const isInConfirmationState = state.state === 'CONFIRMING_BUY' || state.state === 'CONFIRMING_SELL' ||
                                  state.state === 'CONFIRMING_SPLIT' || state.state === 'CONFIRMING_MERGE' ||
                                  state.state === 'CONFIRMING_LIMIT' || state.state === 'CONFIRMING_STRATEGY_SPLIT' ||
                                  state.state === 'AWAITING_EXPORT_CONFIRMATION';
    
    if (busyLocks.get(chatId) && !isInConfirmationState) {
      await ctx.reply(t('error_busy'));
      return;
    }
    
    try {
      switch (state.state) {
        case 'AWAITING_BUY_AMOUNT':
          await handleBuyAmount(ctx, state, text);
          break;
        case 'AWAITING_SELL_AMOUNT':
          await handleSellAmount(ctx, state, text);
          break;
        case 'AWAITING_SPLIT_AMOUNT':
          await handleSplitAmount(ctx, state, text);
          break;
        case 'AWAITING_STRATEGY_SPLIT_AMOUNT':
          await handleStrategySplitAmount(ctx, state, text);
          break;
        case 'AWAITING_MERGE_AMOUNT':
          await handleMergeAmount(ctx, state, text);
          break;
        case 'AWAITING_EXPORT_CONFIRMATION':
          await handleExportConfirmation(ctx, state, text);
          break;
        case 'AWAITING_LIMIT_AMOUNT':
          await handleLimitAmount(ctx, state, text);
          break;
        case 'AWAITING_LIMIT_PRICE':
          await handleLimitPrice(ctx, state, text);
          break;
        case 'AWAITING_STRATEGY_STOP_LOSS':
        case 'AWAITING_STRATEGY_TAKE_PROFIT':
        case 'AWAITING_STRATEGY_MAX_ASK_PRICE':
          await handleStrategySettingsInput(ctx, state, text);
          break;
        case 'AWAITING_NOTIFICATION_PRICE_CHANGE':
        case 'AWAITING_NOTIFICATION_REPEAT_STEP':
        case 'AWAITING_NOTIFICATION_COOLDOWN':
          await handleNotificationSettingsInput(ctx, state, text);
          break;
        case 'AWAITING_EVENTS_FILTER_RANGE':
          await handleEventsFilterRangeInput(ctx, state, text);
          break;
        case 'AWAITING_WITHDRAW_ADDRESS':
          await handleWithdrawAddress(ctx, text);
          break;
        case 'AWAITING_WITHDRAW_AMOUNT':
          await handleWithdrawAmount(ctx, text);
          break;
        default:
          await ctx.reply(t('main_menu'), {
            reply_markup: await getMainMenuKeyboard(config.language || 'en')
          });
      }
    } catch (error) {
      const ctxLog = createContext('bot', 'handleTextMessage');
      safeLogError(ctxLog, error, { state: state?.state });
      const errorInfo = mapErrorToUserMessage(error);
      await ctx.reply(t(errorInfo.key, errorInfo.params), {
        reply_markup: await getMainMenuKeyboard(config.language || 'en')
      });
      userStates.delete(chatId);
    }
  };
}
