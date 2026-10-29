import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_USERS, userContextStorage, getCurrentUserStore } from '../../src/modules/userManager.js';
import { initDatabase, getUserCount, createUserRecord, getUserByTelegramId } from '../../src/modules/database.js';

test('userManager exports MAX_USERS = 10 and userContextStorage', () => {
  assert.equal(MAX_USERS, 10);
  assert.ok(userContextStorage);
  assert.equal(typeof userContextStorage.run, 'function');
});

test('userContextStorage isolates session store per async context', async () => {
  assert.equal(getCurrentUserStore(), null);

  const mockSession1 = { telegramId: '1001', walletAddress: '0x1111111111111111111111111111111111111111' };
  const mockSession2 = { telegramId: '1002', walletAddress: '0x2222222222222222222222222222222222222222' };

  await userContextStorage.run(mockSession1, async () => {
    assert.deepEqual(getCurrentUserStore(), mockSession1);

    await userContextStorage.run(mockSession2, async () => {
      assert.deepEqual(getCurrentUserStore(), mockSession2);
    });

    assert.deepEqual(getCurrentUserStore(), mockSession1);
  });

  assert.equal(getCurrentUserStore(), null);
});

test('database users table supports create and lookup', () => {
  initDatabase();
  const testId = 'test_user_' + Date.now();
  const testAddress = '0x1234567890123456789012345678901234567890';

  createUserRecord({
    telegramId: testId,
    walletAddress: testAddress,
    encryptedPk: 'v2:test:pk:tag',
    encryptedCreds: 'v2:test:creds:tag',
    language: 'en'
  });

  const row = getUserByTelegramId(testId);
  assert.ok(row);
  assert.equal(row.telegram_id, testId);
  assert.equal(row.wallet_address, testAddress);
  assert.equal(row.language, 'en');
});
