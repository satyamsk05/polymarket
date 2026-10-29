import { InlineKeyboard, Keyboard } from 'grammy';
import { getTranslator } from '../../i18n.js';

// Language selection keyboard
export function getLanguageSelectionKeyboard() {
  return new InlineKeyboard()
    .text('🇬🇧 English', 'select_lang:en');
}

// Persistent bottom keyboard (pinned at the bottom of the screen)
export function getPersistentBottomKeyboard() {
  return new Keyboard()
    .text('⚡️ 1-Click Bet')
    .text('💰 Balance')
    .row()
    .text('💼 Positions')
    .text('📋 Orders')
    .row()
    .text('⚙️ Settings')
    .resized()
    .persistent();
}

// 1-Click Bet: Step 1 (Amount selection in bottom keyboard)
export function getQuickBetAmountKeyboard(coin = 'BTC') {
  const otherCoin = coin === 'BTC' ? 'ETH' : 'BTC';
  return new Keyboard()
    .text('$1')
    .text('$3')
    .text('$5')
    .text('$10')
    .row()
    .text(`🪙 Switch to ${otherCoin}`)
    .text('🔄 Refresh')
    .row()
    .text('⬅️ Back to Menu')
    .resized()
    .persistent();
}

// 1-Click Bet: Step 2 (Direction selection in bottom keyboard)
export function getQuickBetDirectionKeyboard(amount, coin = 'BTC') {
  return new Keyboard()
    .text(`🟢 Buy UP ($${amount})`)
    .text(`🔴 Buy DOWN ($${amount})`)
    .row()
    .text('⬅️ Change Amount')
    .text('🏠 Main Menu')
    .resized()
    .persistent();
}

// Settings bottom keyboard
export function getSettingsBottomKeyboard() {
  return new Keyboard()
    .text('🏆 Redeem Winnings')
    .row()
    .text('🔑 Set Allowances')
    .text('💵 Collateral Status')
    .row()
    .text('🔄 Wrap USDC.e')
    .text('📤 Withdraw Funds')
    .row()
    .text('🔐 Export Private Key')
    .text('⬅️ Back to Menu')
    .resized()
    .persistent();
}

// Export PK confirmation bottom keyboard
export function getExportPkConfirmKeyboard() {
  return new Keyboard()
    .text('⚠️ CONFIRM EXPORT')
    .row()
    .text('⬅️ Back to Settings')
    .resized()
    .persistent();
}

// Withdraw flow cancel bottom keyboard
export function getWithdrawCancelKeyboard() {
  return new Keyboard()
    .text('⬅️ Back to Settings')
    .resized()
    .persistent();
}

export async function getMainMenuKeyboard(lang) {
  const t = await getTranslator(lang);

  return new InlineKeyboard()
    .text('⚡️ 1-Click Bet (Next Round)', 'quick_bet')
    .row()
    .text('📈 BTC/ETH 5M UpDown', 'markets:1')
    .row()
    .text(t('menu_positions'), 'positions')
    .text(t('menu_orders'), 'orders')
    .row()
    .text(t('menu_settings'), 'settings');
}


export function buildMergeAmountKeyboard(t, hasMaxOption = false) {
  const keyboard = new InlineKeyboard();
  if (hasMaxOption) {
    keyboard.text('MAX', 'merge_max');
  }
  keyboard.text(t('cancel'), 'cancel');
  return keyboard;
}

