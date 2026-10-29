import { AsyncLocalStorage } from 'async_hooks';
import { ethers } from 'ethers';
import { ClobClient, Chain } from '@polymarket/clob-client-v2';
import { CLOB_API_URL } from './constants.js';
import {
  generatePrivateKey,
  createL2Credentials,
  getMachineKey,
  encrypt,
  decrypt
} from './auth.js';
import {
  getUserByTelegramId,
  getUserCount,
  createUserRecord,
  updateUserLanguage as dbUpdateUserLanguage
} from './database.js';
import { loadConfig } from './config.js';
import { createContext, safeLogInfo, safeLogError } from './logger.js';

export const MAX_USERS = 10;
export const userContextStorage = new AsyncLocalStorage();

// In-memory cache for active user sessions
const userSessions = new Map();

// Helper to seed owner from config.json if not already in users table
async function seedOwnerIfNeeded(tId) {
  try {
    const existing = getUserByTelegramId(tId);
    if (existing) return;

    const allowedOwnerId = process.env.TELEGRAM_ALLOWED_USER_ID;
    if (!allowedOwnerId || String(allowedOwnerId) !== String(tId)) return;

    const config = await loadConfig();
    if (config.walletAddress && config.encrypted?.privateKey) {
      const machineKey = await getMachineKey();
      let encryptedCredsStr = '';
      if (config.encrypted?.l2Credentials) {
        try {
          const l2Creds = {
            apiKey: config.encrypted.l2Credentials.apiKey || config.encrypted.l2Credentials.key,
            secret: config.encrypted.l2Credentials.secret,
            passphrase: config.encrypted.l2Credentials.passphrase
          };
          encryptedCredsStr = await encrypt(JSON.stringify(l2Creds), machineKey);
        } catch {}
      }

      createUserRecord({
        telegramId: String(tId),
        walletAddress: config.walletAddress,
        encryptedPk: config.encrypted.privateKey,
        encryptedCreds: encryptedCredsStr,
        language: config.language || 'en'
      });

      const ctxLog = createContext('userManager', 'seedOwner');
      safeLogInfo(ctxLog, 'Seeded existing owner wallet into multi-user DB', {
        telegramId: String(tId),
        walletAddress: config.walletAddress
      });
    }
  } catch (err) {
    const ctxLog = createContext('userManager', 'seedOwnerError');
    safeLogError(ctxLog, err);
  }
}

export async function getUserSession(telegramId) {
  if (!telegramId) return null;
  const tId = String(telegramId);

  // Return cached session if already loaded
  if (userSessions.has(tId)) {
    return userSessions.get(tId);
  }

  // Seed owner if this is the owner's first time in multi-user schema
  await seedOwnerIfNeeded(tId);

  const userRow = getUserByTelegramId(tId);
  if (userRow) {
    const machineKey = await getMachineKey();
    const privateKey = await decrypt(userRow.encrypted_pk, machineKey);

    let creds = null;
    if (userRow.encrypted_creds) {
      try {
        const decryptedJson = await decrypt(userRow.encrypted_creds, machineKey);
        creds = JSON.parse(decryptedJson);
      } catch {}
    }

    if (!creds || !creds.apiKey) {
      // Derive new L2 credentials if missing
      creds = await createL2Credentials(privateKey);
      const encryptedCreds = await encrypt(JSON.stringify(creds), machineKey);
      createUserRecord({
        telegramId: tId,
        walletAddress: userRow.wallet_address,
        encryptedPk: userRow.encrypted_pk,
        encryptedCreds,
        language: userRow.language || 'en'
      });
    }

    const signer = new ethers.Wallet(privateKey);
    const clobClient = new ClobClient({
      host: CLOB_API_URL,
      chain: Chain.POLYGON,
      signer,
      creds: {
        key: creds.apiKey || creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase
      },
      funderAddress: signer.address
    });

    const session = {
      telegramId: tId,
      walletAddress: userRow.wallet_address,
      privateKey,
      signer,
      clobClient,
      creds,
      language: userRow.language || 'en'
    };

    userSessions.set(tId, session);
    return session;
  }

  // User does NOT exist in DB yet — check max user limit
  const currentCount = getUserCount();
  if (currentCount >= MAX_USERS) {
    return {
      error: 'LIMIT_REACHED',
      currentCount,
      maxUsers: MAX_USERS
    };
  }

  // Provision new user (Option 1: dedicated wallet & credentials)
  const ctxLog = createContext('userManager', 'provisionUser');
  safeLogInfo(ctxLog, `Provisioning new user ${currentCount + 1}/${MAX_USERS}`, { telegramId: tId });

  const { privateKey, address } = await generatePrivateKey();
  const creds = await createL2Credentials(privateKey);
  const machineKey = await getMachineKey();

  const encryptedPk = await encrypt(privateKey, machineKey);
  const encryptedCreds = await encrypt(JSON.stringify(creds), machineKey);

  createUserRecord({
    telegramId: tId,
    walletAddress: address,
    encryptedPk,
    encryptedCreds,
    language: 'en'
  });

  const signer = new ethers.Wallet(privateKey);
  const clobClient = new ClobClient({
    host: CLOB_API_URL,
    chain: Chain.POLYGON,
    signer,
    creds: {
      key: creds.apiKey || creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase
    },
    funderAddress: signer.address
  });

  const session = {
    telegramId: tId,
    walletAddress: address,
    privateKey,
    signer,
    clobClient,
    creds,
    language: 'en',
    isNew: true,
    userNumber: currentCount + 1
  };

  userSessions.set(tId, session);
  return session;
}

export function getCurrentUserStore() {
  return userContextStorage.getStore() || null;
}

export function setUserLanguage(telegramId, language) {
  const tId = String(telegramId);
  dbUpdateUserLanguage(tId, language);
  if (userSessions.has(tId)) {
    userSessions.get(tId).language = language;
  }
}
