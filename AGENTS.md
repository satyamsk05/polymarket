# AGENTS.md

## Tone
- Be concise, direct, and avoid filler.
- Rely strictly on code, README, and package scripts; do not speculate on exchange or bot behavior.

## Project Context
- What it is: single-user Telegram bot for automated trading on Polymarket (Polygon) with market/limit orders, split/merge/redeem, strategies, background workers, and SQLite.
- Runtime: Node.js `>=22.22.0`, ESM (`"type": "module"`).
- Main entrypoint: `src/index.js`.
- Key external dependencies: `grammy`, `ethers`, `@polymarket/clob-client-v2`, `better-sqlite3`, `axios`, `dotenv`, `node-cron`, `https-proxy-agent`, `node-machine-id`.
- Repository: `denis-skripnik/polymarket-trading-bot`.

## Run And Validation
- Install dependencies: `npm install`
- Bootstrap sanity check without starting bot/workers: `npm run bootstrap`
- Standard start: `npm start`
- Dev watch: `npm run dev`
- Unit + integration tests: `npm run test`
- Unit tests only: `npm run test:unit`
- PM2 prod lifecycle:
  - `npm run pm2:start`
  - `npm run pm2:restart`
  - `npm run pm2:stop`
  - `npm run pm2:delete`
  - `npm run pm2:logs`
- Migration flow:
  - `npm run migrate:prepare -- --ttl-minutes 30`
  - `npm run migrate:export -- --request <request.json> --fingerprint <fingerprint>`
  - `npm run migrate:apply -- --request <request.json> --bundle <bundle.json>`

## Config And Secrets
- Required env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`.
- Recommended env: `POLYGON_RPC_URL`, `ETHERSCAN_API_KEY`.
- Proxy: `PROXY`, `OUTBOUND_HTTP_TIMEOUT_MS`.
- Translation env: `TRANSLATION_ENABLED`, `TRANSLATION_SERVICE`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODELS`, `OPENROUTER_BASE_URL`.
- Worker env: `WORKER_SYNC_POSITIONS_MS`, `WORKER_MONITOR_MS`, `WORKER_HEALTH_LOG_MS`, `WORKER_AUTO_REDEEM_MS`, `WORKERS_NOTIFICATIONS_CHAT_ID`.
- Strategy watcher env: `STRATEGY_MARKETS_WATCHER_WS_URL`, `STRATEGY_MARKETS_WATCHER_PAGE_SIZE`, `STRATEGY_MARKETS_WATCHER_PAGES`, `STRATEGY_MARKETS_WATCHER_REFRESH_MS`, `STRATEGY_MARKETS_WATCHER_MAX_TRACKED_MARKETS`, `STRATEGY_MARKETS_WATCHER_SUBSCRIPTION_CHUNK`, `STRATEGY_MARKETS_WATCHER_WS_RECONNECT_BASE_MS`, `STRATEGY_MARKETS_WATCHER_WS_RECONNECT_MAX_MS`.
- Gas/allowance env: `POLYGON_MIN_PRIORITY_FEE_GWEI`, `POLYGON_MIN_MAX_FEE_GWEI`, `POLYGON_APPROVE_GAS_RETRY_COUNT`, `POLYGON_APPROVE_GAS_BUMP_MULTIPLIER`, `POLYGON_MIN_USDC_ALLOWANCE_USDC`.
- Logs: `LOG_TO_FILE`, `LOG_FILE_PATH`.
- Do not commit real secrets to the repository; template only in `.env.example`.
- Per README, sensitive data is stored in `data/config.json`, encrypted with a key derived from machine ID.

## Data And Runtime Files
- Runtime data directory is created by `src/modules/config.js`.
- README describes runtime artifacts:
  - `data/config.json` — encrypted credentials + bot settings
  - `data/database.sqlite` — SQLite cache/state
  - `data/logs/app.log` — JSON logs
  - `data/logs/pm2-out.log`, `data/logs/pm2-error.log` — PM2 logs
  - `data/migration/*` — migration request/bundle artifacts

## Architectural Boundaries
- `src/index.js` orchestration only: env bootstrap, proxy patching, DB init, bot init/start, workers start/stop, shutdown hooks.
- `src/modules/polymarket.js` — all integration with Polymarket/Gamma/CLOB/onchain; test any changes to trading logic, price/amount conversions, approvals, withdraw, split/merge/redeem, and fallback behavior here and via tests.
- `src/modules/database.js` — sole SQLite state layer for markets, positions, orders, strategies, alerts, translations.
- `src/modules/workers.js` — background reconciliation/monitoring lifecycle; if modifying orders/strategies status or alerts, check the corresponding worker.
- `src/modules/strategyMarketWatcher.js` — dedicated WS watcher for strategy markets; do not mix discovery/subscription logic with bot UI without need.
- `src/modules/bot/` — Telegram UI/runtime/routing/features.
- `src/modules/bot/bot.js` — large orchestrator/legacy aggregation file; before editing, check if logic is already factored into `features/*`, `routing/*`, `ui/*`, `notifications.js`, `runtime.js`.
- `src/modules/auth.js` and migration scripts — security-sensitive zone; changes require caution and passing migration/auth tests.
- `src/modules/logger.js` and `src/modules/proxy.js` patch global behavior (`console`, fetch/provider/http paths); fragile, test startup and tests carefully.

## Project Conventions
- ESM codebase, imports with `*.js`.
- Many places use `BigInt` and base units (`pUSD base`, `shares base`, `price micro`). When modifying, do not replace with float arithmetic.
- Parsers/formatters exist in `src/modules/bot/ui/formatters.js` and conversion helpers in `src/modules/polymarket.js`; reuse them.
- For messages/notifications and HTML formatting, check `src/modules/bot/ui/formatters.js` and `src/modules/bot/notifications.js` first.
- Locales reside in `src/locales/en.json` and `src/locales/ru.json`; when adding new UI keys, update both locales.
- When changing callback/text routing, check `src/modules/bot/routing/callback-router.js`, `src/modules/bot/routing/text-router.js`, and the related feature module.
- When changing environment behavior, keep `.env.example` and README in sync.

## Update Rules
- If public run/setup/ENV/PM2/migration flow changes — update `README.md` and `.env.example`.
- If localized UI keys change — update both locale JSON files.
- If auth/config/proxy/logger/polymarket conversions/runtime helpers/withdraw logic changes — update or add unit tests in `tests/unit`.
- If file tree, feature modules, or functions change — update this `AGENTS.md`.
- If external integrations, endpoints, SDK methods, auth headers, or fallback chains change — update `External APIs And SDKs`, `Integration Map`, `SDK Method Map`.

## External APIs And SDKs

### Telegram Bot API via `grammy`
- Library: `grammy`.
- Main initialization: `src/modules/bot/bot.js` → `initBot`, `startBot`, `stopBot`.
- Feature/UI modules in `src/modules/bot/features/*.js`, routing in `src/modules/bot/routing/*.js`, keyboards/formatting in `src/modules/bot/ui/*`.
- Auth/config:
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_ALLOWED_USER_ID`
- Risk/invariant: bot is single-user; access control and rate limiting are built into `initBot` middleware.

### Polymarket CLOB SDK (`@polymarket/clob-client-v2`)
- Library: `@polymarket/clob-client-v2` `^1.0.2`.
- Main imports: `src/modules/polymarket.js`, `src/modules/auth.js`.
- Base URL: `CLOB_API_URL = https://clob.polymarket.com`.
- Chain: `Chain.POLYGON` (`137`) via options-object constructor.
- Auth model:
  - signer (`ethers.Wallet`, compatible interface with V2 signer)
  - L2 creds `{ key/apiKey, secret, passphrase }`
  - `createL2Headers(...)` is used for HTTP fallback
- Where client is created:
  - `src/modules/auth.js` → `createL2Credentials` (temporary client for `createOrDeriveApiKey`)
  - `src/modules/polymarket.js` → `initClient`
- Important V2 differences in this project:
  - `ClobClient` constructor is now called with object options (`host`, `chain`, `signer`, `creds`, `funderAddress`)
  - order args must no longer depend on V1-only fields (`feeRateBps`, `nonce`, `taker`)
  - collateral on Polygon is now `pUSD`, and CLOB exchange allowances apply to V2 exchange addresses
- Key risks:
  - do not log `key`, `secret`, `passphrase`, `Authorization`, cookies
  - keep signed HTTP fallback and proxy patching in sync with V2 package layout
  - collateral/allowance state depends on both SDK and onchain approve flow

### Polymarket Gamma API
- Base URL: `GAMMA_API_URL = https://gamma-api.polymarket.com`.
- Used as public read API without L2 creds.
- Main module: `src/modules/polymarket.js`.
- Additional strategy market discovery: `src/modules/strategyMarketWatcher.js`.
- Used endpoint families in code:
  - `/markets`
  - `/markets/{id}`
  - `/markets/slug/{slug}`
  - `/events`
  - `/events/{id}`
  - `/events/slug/{slug}`
  - `/categories`
  - `/tags`
- Risks:
  - code includes fallback across different tag param names: `tag_id`, `tagId`, `tag`
  - some slug/event lookups may return 404 for ephemeral slugs; accounted for in bot routing/comments

### Polymarket Data API
- Base URL: `DATA_API_URL = https://data-api.polymarket.com`.
- Used for read-only runtime data and reconciliation.
- Main module: `src/modules/polymarket.js`.
- Additional usage: `src/modules/workers.js`.
- Used endpoint families in code:
  - `/positions`
  - `/trades`
  - `/activity`
- Role:
  - positions snapshot
  - missing-order reconciliation
  - fill/activity evidence for worker logic
- Risk:
  - empty/partial response does not always mean no position; explorer/onchain fallback exists

### Etherscan V2 API for Polygon fallback
- Base URL: `https://api.etherscan.io/v2/api`.
- Auth/config:
  - `ETHERSCAN_API_KEY`
  - `chainid=137`
- Used only as fallback/read path in `src/modules/polymarket.js`.
- Main scenarios:
  - `module=account&action=token1155tx` for ERC-1155 transfer history
  - `module=proxy&action=eth_getTransactionByHash` for decoding split tx input
- Why it is needed:
  - recovering onchain positions when Data API is empty
  - recovering metadata for split-derived token positions
- Risks:
  - rate limits are handled by retry/delay logic
  - without `ETHERSCAN_API_KEY`, fallback silently degrades to omitting onchain enrichment

### OpenRouter Chat Completions API
- Used only for optional UI label translation.
- Main module: `src/modules/ai.js`.
- Base path: `OPENROUTER_BASE_URL + /chat/completions`.
- Required env when enabled:
  - `TRANSLATION_ENABLED=true`
  - `TRANSLATION_SERVICE=openrouter`
  - `OPENROUTER_API_KEY`
  - `OPENROUTER_MODEL`
  - `OPENROUTER_BASE_URL`
  - optional `OPENROUTER_FALLBACK_MODELS`
- Auth header: `Authorization: Bearer <OPENROUTER_API_KEY>`.
- Runtime behavior:
  - timeout 9s
  - batch translation up to 20 items
  - strict JSON response expected
  - temporary model blacklist on repeated provider/model failures
- Risks:
  - translation is not critical for core trading flow; on failure code falls back to original texts
  - non-JSON provider output is explicitly treated as an error

### Polygon RPC / ethers.js
- Library: `ethers` `^5.8.0`.
- Read/write RPC is used in `src/modules/polymarket.js`, wallet/crypto in `src/modules/auth.js`, partially in `workers.js`/bot features.
- RPC source:
  - `POLYGON_RPC_URL` or fallback list in `src/modules/polymarket.js`
  - fallback URLs in code: `https://polygon-public.nodies.app`, `https://polygon-bor-rpc.publicnode.com`, `https://polygon.llamarpc.com`
- Main onchain contracts:
  - pUSD ERC20 collateral (`PUSD_ADDRESS`; legacy alias `USDC_ADDRESS` still points here)
  - USDC.e collateral source asset (`USDCE_ADDRESS`)
  - CollateralOnramp (`COLLATERAL_ONRAMP_ADDRESS`) for `wrap(address _asset, address _to, uint256 _amount)`
  - CTF contract
  - CTF exchange
  - neg-risk exchange
  - neg-risk adapter
- Important constants: `USDC_DECIMALS = 6`, `BINARY_PARTITION = [1, 2]`.
- Risk:
  - do not break base-unit math and approvals
  - YES/NO conditional tokens here are ERC-1155 ids, not separate ERC20s

### WebSocket market subscriptions
- Library: `ws`.
- Module: `src/modules/strategyMarketWatcher.js`.
- Default URL: `wss://ws-subscriptions-clob.polymarket.com/ws/market`.
- Purpose: live best-ask updates for strategy markets watcher.
- Config env:
  - `STRATEGY_MARKETS_WATCHER_WS_URL`
  - `STRATEGY_MARKETS_WATCHER_SUBSCRIPTION_CHUNK`
  - `STRATEGY_MARKETS_WATCHER_WS_RECONNECT_BASE_MS`
  - `STRATEGY_MARKETS_WATCHER_WS_RECONNECT_MAX_MS`
- Risk:
  - reconnect/subscription logic is stateful; do not modify without checking `refreshUniverseIfNeeded`, `updateSubscriptions`, `scheduleReconnect`

### Proxy/transport patching
- Module: `src/modules/proxy.js`.
- Libraries: `axios`, `https-proxy-agent`, module patching via `createRequire`.
- Purpose:
  - normalize `PROXY`
  - patch global fetch, axios defaults, clob-client http helpers, provider send, websocket proxy options
- Auth/config:
  - `PROXY`
  - `OUTBOUND_HTTP_TIMEOUT_MS`
- Risk:
  - this is a cross-cutting transport layer; easy to break CLOB, Gamma, Data API, OpenRouter, and WS simultaneously

## Integration Map
- `src/index.js`
  - `applyProxyRuntime()` before starting the rest of the runtime
  - `initDatabase()`
  - `initBot()` / `startBot()`
  - `startWorkers()`
- `src/modules/auth.js`
  - `ethers.Wallet.createRandom()` for wallet generation
  - temporary `ClobClient(...).createOrDeriveApiKey()` for L2 creds
  - machine-specific encryption via `node-machine-id` + `crypto.scryptSync`
- `src/modules/polymarket.js`
  - Gamma API: markets/events/categories/tags/market details
  - CLOB SDK: order book, orders, market orders, limit orders, balance allowance, tick size, neg-risk checks, cancel
  - CLOB HTTP fallback: signed GET with `createL2Headers`
  - Data API: positions
  - Etherscan API: ERC-1155 explorer fallback
  - ethers RPC: approvals, withdraw, split, merge, redeem, balance checks
- `src/modules/strategyMarketWatcher.js`
  - Gamma `/markets` discovery
  - WebSocket subscription stream for asset price books
- `src/modules/workers.js`
  - Data API `/trades` + `/activity` for missing-order status resolution
  - bot notifications via `sendNotification`, `sendPriceAlertNotification`, `sendStrategyMarketAlertNotification`
- `src/modules/ai.js`
  - OpenRouter `/chat/completions` for optional UI translation only
- `src/modules/bot/*`
  - `grammy` UI/action layer above polymarket/database/config modules

## SDK Method Map

### `@polymarket/clob-client-v2` methods seen in repo
- `createOrDeriveApiKey` — `src/modules/auth.js`
- `getOrderBook` — `src/modules/polymarket.js`
- `getOpenOrders` — `src/modules/polymarket.js`
- `getServerTime` — `src/modules/polymarket.js`
- `updateBalanceAllowance` — `src/modules/polymarket.js`
- `getBalanceAllowance` — `src/modules/polymarket.js`
- `getTickSize` — `src/modules/polymarket.js`
- `getNegRisk` — `src/modules/polymarket.js`
- `createAndPostMarketOrder` — `src/modules/polymarket.js`
- `createAndPostOrder` — `src/modules/polymarket.js`
- `cancelOrder` — `src/modules/polymarket.js`
- `createL2Headers` helper — `src/modules/polymarket.js`

### `ethers` usage families seen in repo
- `Wallet` / `ethers.Wallet` — auth, signer creation, workers
- `ethers.utils.Interface` — decode split tx input for explorer fallback
- `Contract`/provider/signer-based reads & writes — approvals, balances, split/merge/redeem, withdraw
- Gas bump / retry logic centralized in `src/modules/logger.js` and `src/modules/polymarket.js`

### `grammy` usage families seen in repo
- `Bot` init — `src/modules/bot/bot.js`
- `InlineKeyboard` and keyboard composition — features/ui modules
- callback/text routing split across `routing/callback-router.js` and `routing/text-router.js`

## Function → API / SDK Reference

### `src/modules/auth.js`
- `generatePrivateKey` → `ethers.Wallet.createRandom()`.
- `createL2Credentials` → temporary `ClobClient(...)` + `createOrDeriveApiKey()` against CLOB auth flow.
- `getMachineKey` → `node-machine-id` + `crypto.scryptSync`, not an external API.

### `src/modules/ai.js`
- `requestBatchTranslation` → OpenRouter `POST {OPENROUTER_BASE_URL}/chat/completions` with `Authorization: Bearer <OPENROUTER_API_KEY>`.
- `translateUiTexts` / `translateUiText` → orchestration over OpenRouter batching/cache/fallback.

### `src/modules/polymarket.js` — Gamma API
- `getMarkets` → `GET /markets`.
- `getMarketDetailsById` → `GET /markets/{marketId}`.
- `getMarketDetailsBySlug` → `GET /markets/slug/{slug}`.
- `getEventTags` → `GET /tags` (+ event tag normalization/filtering).
- `getEvents` → `GET /events`.
- `getCategories` → `GET /categories`.
- `getEventById` → `GET /events/{id}`.
- `getEventBySlug` → `GET /events/slug/{slug}`.
- `fetchGammaMarketByConditionId` → `GET /markets` with condition-based filtering logic.

### `src/modules/polymarket.js` — CLOB SDK / CLOB HTTP
- `initClient` → creates shared `ClobClient`.
- `getOrderBook` → `clobClient.getOrderBook(tokenId)`.
- `getOrders` → `clobClient.getOpenOrders()` with HTTP fallback.
- `getL2HeaderTimestamp` → `clobClient.getServerTime()`.
- `fetchOpenOrdersPageViaHttp` → signed CLOB HTTP GET via `createL2Headers(...)` to `/orders` or `/data/orders`.
- `getOpenOrdersViaHttpFallback` → paginated fallback for open orders.
- `refreshClobBalanceAllowance` → `clobClient.updateBalanceAllowance(...)`.
- `getCollateralStatus` → `clobClient.getBalanceAllowance({ asset_type: COLLATERAL })`.
- `ensureClobCollateralReady` → collateral allowance/balance readiness via CLOB SDK.
- `resolveOrderOptions` → `clobClient.getTickSize(tokenId)` + `clobClient.getNegRisk(tokenId)`.
- `placeMarketBuyFOK` → `clobClient.createAndPostMarketOrder(...)` or fallback `createAndPostOrder(...)`.
- `placeMarketSellFOK` → `clobClient.createAndPostMarketOrder(...)` or fallback `createAndPostOrder(...)`.
- `createOrder` → `clobClient.createAndPostOrder(...)`.
- `cancelOrder` → `clobClient.cancelOrder({ orderID })`.
- `checkBalance` → `clobClient.getBalanceAllowance(...)`.
- `setAllAllowances` → mix of CLOB collateral allowance sync + onchain approve flows.

### `src/modules/polymarket.js` — Data API
- `getPositions` → `GET /positions?user=<wallet>&sizeThreshold=0`.
- `resolveMissingOrderStatus` logic is not here; Data API order reconciliation lives in `workers.js`.

### `src/modules/polymarket.js` — Etherscan fallback
- `fetchExplorerTransactionByHash` → `module=proxy&action=eth_getTransactionByHash`.
- `fetchOnchainTransfersFromExplorer` → `module=account&action=token1155tx`.
- `buildSplitDerivedTokenMeta` → explorer tx fetch + ABI decode + Gamma enrichment.

### `src/modules/polymarket.js` — ethers / Polygon RPC
- `getOnchainReadProvider` / `createWorkingProvider` / `resolveRpcChainId` → provider bootstrap/fallback.
- `fetchTokenBalancesFromChain` → ERC-1155 `balanceOfBatch` reads.
- `initContracts` → signer/provider-backed contract objects.
- `checkAllowance` / `setAllowance` → ERC20 pUSD collateral allowance read/write.
- `withdrawUSDC` → ERC20 `transfer(...)` of pUSD collateral (function name retained for backward compatibility in code).
- `mergeLegacyUsdcPair` / `splitNegRiskToTradable` / `mergeNegRiskTradable` / `split` / `merge` / `redeem` → CTF / neg-risk onchain writes against pUSD collateral.
- `getOnchainAllowancesUSDC` → ERC20 collateral allowance reads (function name retained).

### `src/modules/strategyMarketWatcher.js`
- `fetchDiscoveryPage` → Gamma `GET /markets` for discovery universe.
- `connectWebSocketIfNeeded` → `new WebSocket(STRATEGY_MARKETS_WATCHER_WS_URL)`.
- `sendWsOperation` → WS subscribe/unsubscribe payloads for asset IDs.
- `refreshUniverseIfNeeded` / `tick` → orchestration of Gamma discovery + WS subscription state.

### `src/modules/workers.js`
- `fetchDataApiList` → generic Data API GET helper.
- `fetchFilledSizeFromDataApi` → Data API `/trades` and `/activity` evidence collection.
- `resolveMissingOrderStatus` → Data API `/trades` + `/activity` over multiple order-id key variants.
- `ensureClientInitialized` → wallet decrypt + `initClient(...)` bootstrap path before CLOB-dependent workers.
- Worker family usage:
  - `syncPositionsWorker` → positions sync via `getPositions()`.
  - `monitorOrdersWorker` → open orders + Data API reconciliation.
  - `monitorStrategiesWorker` → strategy lifecycle using CLOB/Data/onchain helpers.
  - `monitorStrategyMarketsWatcherWorker` → delegates to WS watcher.

### `src/modules/bot/bot.js`
- `initBot` → `new Bot(token)`, Telegram middleware, command/callback/text wiring.
- `startBot` / `stopBot` → Telegram polling lifecycle.
- Other bot functions are primarily orchestration/UI and rely on `polymarket.js`, `database.js`, `config.js`, `i18n.js`, not directly on external APIs.

## API/Fallback Rules
- Gamma API and Data API are primary read sources.
- If Data API positions are empty, code attempts onchain fallback via Etherscan + Polygon RPC.
- If `clobClient.getOpenOrders()` fails, code attempts signed HTTP fallback against CLOB (`/orders`, then `/data/orders`).
- Translation/OpenRouter must not block trading UI; on failure original labels are returned.
- Proxy runtime is applied as early as possible and must cover fetch/axios/CLOB/provider/WS simultaneously.
- Verify any changes to fallback chains with tests and by reviewing adjacent calls in `workers.js`, `bot.js`, `strategyMarketWatcher.js`.

## Repository Structure
```text
.
├── .env.example
├── .gitignore
├── AGENTS.md
├── README.md
├── ecosystem.config.cjs
├── install/
│   ├── install.sh
│   └── windows_install.bat
├── package-lock.json
├── package.json
├── scripts/
│   ├── apply-migration-bundle.js
│   ├── export-migration-bundle.js
│   ├── migration-common.js
│   └── prepare-migration-request.js
├── src/
│   ├── index.js
│   ├── locales/
│   │   ├── en.json
│   │   └── ru.json
│   └── modules/
│       ├── ai.js
│       ├── auth.js
│       ├── bot/
│       │   ├── bot.js
│       │   ├── constants.js
│       │   ├── contract-snapshot.md
│       │   ├── features/
│       │   │   ├── bracket-order.js
│       │   │   ├── language.js
│       │   │   ├── market-details.js
│       │   │   ├── markets.js
│       │   │   ├── orders.js
│       │   │   ├── positions.js
│       │   │   ├── quick-bet.js
│       │   │   ├── security.js
│       │   │   ├── settings.js
│       │   │   ├── trade-limit.js
│       │   │   ├── trade-market.js
│       │   │   ├── trade-onchain.js
│       │   │   └── withdraw.js
│       │   ├── notifications.js
│       │   ├── routing/
│       │   │   ├── callback-router.js
│       │   │   └── text-router.js
│       │   ├── runtime.js
│       │   └── ui/
│       │       ├── formatters.js
│       │       └── keyboards.js
│       ├── config.js
│       ├── constants.js
│       ├── database.js
│       ├── i18n.js
│       ├── logger.js
│       ├── polymarket.js
│       ├── proxy.js
│       ├── userManager.js
│       └── workers.js
└── tests/
    ├── run-tests.js
    └── unit/
        ├── auth-crypto.test.js
        ├── config-runtime.test.js
        ├── formatters.test.js
        ├── logger.test.js
        ├── migration-common.test.js
        ├── polymarket-conversions.test.js
        ├── quick-bet.test.js
        ├── runtime.test.js
        ├── user-manager.test.js
        └── withdraw.test.js
```

## File Ownership Map
- `.env.example` — required and recommended env.
- `.gitignore` — git ignore rules.
- `README.md` — install/run/config/features/migration docs.
- `ecosystem.config.cjs` — PM2 process config.
- `install/install.sh` — Linux auto-installer.
- `install/windows_install.bat` — Windows auto-installer.
- `package.json` — scripts, deps, Node engine, package metadata.
- `package-lock.json` — locked dependency graph.
- `scripts/prepare-migration-request.js` — target machine migration request generation.
- `scripts/export-migration-bundle.js` — source machine export of encrypted migration bundle.
- `scripts/apply-migration-bundle.js` — target machine bundle apply + re-encryption.
- `scripts/migration-common.js` — shared CLI/migration helpers.
- `src/index.js` — app bootstrap/startup/shutdown.
- `src/locales/en.json`, `src/locales/ru.json` — UI locale dictionaries.
- `src/modules/ai.js` — RU AI label translation batching/cache/fallback logic.
- `src/modules/auth.js` — key derivation, encryption, wallet init, decrypt helpers.
- `src/modules/config.js` — config file lifecycle + runtime config helpers.
- `src/modules/constants.js` — external constants/ABIs/onchain constants.
- `src/modules/database.js` — SQLite schema and CRUD for cache/state.
- `src/modules/i18n.js` — locale loading and translation helpers.
- `src/modules/logger.js` — structured logging, retries, redaction, console patching.
- `src/modules/polymarket.js` — all Polymarket/Gamma/CLOB/onchain trading and conversion logic.
- `src/modules/proxy.js` — proxy normalization, axios/fetch/provider patching.
- `src/modules/strategyMarketWatcher.js` — WS strategy market discovery/subscriptions/alerts.
- `src/modules/workers.js` — periodic sync/reconciliation/monitoring workers.
- `src/modules/bot/bot.js` — main Telegram bot composition and large legacy/aggregated handlers.
- `src/modules/bot/constants.js` — bot-specific constants.
- `src/modules/bot/contract-snapshot.md` — contract-related notes snapshot.
- `src/modules/bot/features/bracket-order.js` — live 5M round scalping/bracket order execution with auto-sell take profit.
- `src/modules/bot/features/language.js` — language selection/settings feature.
- `src/modules/bot/features/market-details.js` — event/market details rendering.
- `src/modules/bot/features/markets.js` — categories/events/markets browsing and strategy-markets listing.
- `src/modules/bot/features/orders.js` — orders list/detail/cancel flow.
- `src/modules/bot/features/positions.js` — positions list/detail/sell/merge/redeem start points.
- `src/modules/bot/features/security.js` — wallet init, allowances, collateral, private key export confirmation flow.
- `src/modules/bot/features/settings.js` — strategy/notification/settings menus and edits.
- `src/modules/bot/features/strategies.js` — strategies list/detail/manual close/emergency close logic.
- `src/modules/bot/features/trade-limit.js` — limit buy/sell flow.
- `src/modules/bot/features/trade-market.js` — market buy/sell flow.
- `src/modules/bot/features/trade-onchain.js` — split/merge/redeem + strategy split flow.
- `src/modules/bot/features/withdraw.js` — withdraw flow.
- `src/modules/bot/notifications.js` — notification payload formatting and sending.
- `src/modules/bot/routing/callback-router.js` — callback query dispatcher.
- `src/modules/bot/routing/text-router.js` — text message dispatcher.
- `src/modules/bot/runtime.js` — shared in-memory runtime state/setters.
- `src/modules/bot/ui/formatters.js` — bot UI parsing/formatting helpers.
- `src/modules/bot/ui/keyboards.js` — keyboard builders.
- `tests/run-tests.js` — test launcher/helper file.
- `tests/unit/auth-crypto.test.js` — auth crypto tests.
- `tests/unit/bracket-order.test.js` — live bracket limit and auto-sell tests.
- `tests/unit/config-runtime.test.js` — config runtime tests.
- `tests/unit/formatters.test.js` — formatter tests.
- `tests/unit/logger.test.js` — logger tests.
- `tests/unit/migration-common.test.js` — migration helper tests.
- `tests/unit/polymarket-conversions.test.js` — conversion tests.
- `tests/unit/runtime.test.js` — runtime state tests.
- `tests/unit/withdraw.test.js` — withdraw helper tests.

## Function Inventory
_Note: the list below was gathered by automated repo scan of top-level named declarations; this is a working reference map for future coding sessions._

### ecosystem.config.cjs
- no top-level named functions/classes found by scanner.

### scripts/apply-migration-bundle.js
- `ensureBundle`
- `ensureRequest`
- `toObject`
- `main`

### scripts/export-migration-bundle.js
- `ensureRequest`
- `main`

### scripts/migration-common.js
- `parseArgs`
- `parsePositiveInt`
- `normalizeFingerprint`
- `formatFingerprint`
- `getPublicKeyFingerprint`
- `readJson`
- `resolvePathFromCwd`
- `decodeBase64`

### scripts/prepare-migration-request.js
- `main`

### src/index.js
- `shutdown`
- `setupProcessHandlers`
- `main`
- `runBootstrap`
- `runBot`

### src/modules/ai.js
- `ensureCacheSizeLimit`
- `isModelTemporarilyUnavailable`
- `markModelTemporarilyUnavailable`
- `warnThrottled`
- `getResponseContent`
- `parseJsonFromText`
- `parseTranslationPayload`
- `chunkArray`
- `toNonEmptyText`
- `normalizeBaseUrl`
- `requestBatchTranslation`
- `translateUiTexts`
- `translateUiText`

### src/modules/auth.js
- `getMachineIdModule`
- `generatePrivateKey`
- `createL2Credentials`
- `getMachineKey`
- `assertAes256Key`
- `decodeBase64Strict`
- `encrypt`
- `decrypt`
- `initializeWallet`
- `getDecryptedPrivateKey`
- `getDecryptedL2Credentials`

### src/modules/bot/bot.js
- `initBot`
- `showLanguageSelection`
- `handleLanguageSelection`
- `handleStart`
- `showLanguageSettings`
- `handleSettingsLanguageChange`
- `showMarketsList`
- `toFinitePositiveNumber`
- `resolveStrategyMaxAskPrice`
- `resolveNotificationAlertCooldownSeconds`
- `formatStrategyAskPrice`
- `formatProbabilityValue`
- `parseMarketOutcomePrices`
- `resolveMarketYesProbability`
- `normalizeEventsPriceFilter`
- `getEventsPriceFilter`
- `setEventsPriceFilter`
- `applyEventsPriceFilterPreset`
- `formatEventsPriceFilterLabel`
- `marketMatchesEventsPriceFilter`
- `filterMarketsByEventsPriceFilter`
- `eventMatchesEventsPriceFilter`
- `loadEventsPageWithPriceFilter`
- `isStrategyMarketPrecheckCandidate`
- `mapWithConcurrencyLimit`
- `getStrategyMarketsCache`
- `getCachedStrategyMarket`
- `fetchStrategyMarketsCandidates`
- `evaluateStrategyMarketByOrderbook`
- `loadStrategyMarkets`
- `showStrategyMarketsList`
- `buildEventsListCallback`
- `buildEventsFilterCallback`
- `buildEventsFilterPresetCallback`
- `buildEventsFilterCustomCallback`
- `buildEventDetailsCallback`
- `getCategoryToken`
- `normalizeCategoryName`
- `parsePolymarketEventUrl`
- `handlePolymarketEventUrlInput`
- `getLiquidityValue`
- `sortByLiquidityDesc`
- `truncateButtonLabel`
- `translateUiLabelsForLanguage`
- `translateUiLabelForLanguage`
- `normalizeEventTag`
- `isOperationalTagSlug`
- `collectActiveEventTagStats`
- `loadCategoryCatalog`
- `showMarketCategoriesList`
- `showEventsFilterMenu`
- `showEventsList`
- `showEventDetails`
- `getCachedMarket`
- `getCachedCategory`
- `getCachedCategoryContext`
- `showEventsListByCategoryToken`
- `getCachedEvent`
- `getCachedEventDetails`
- `getCachedSubmarket`
- `getCachedMarketDetails`
- `getCachedMarketDetailsState`
- `parseMarketTokensAndOutcomes`
- `getActionLabel`
- `getCachedPosition`
- `getCachedPositions`
- `setCachedPositions`
- `refreshPositionsCache`
- `sleep`
- `hasUnresolvedOnchainPositionLabels`
- `refreshPositionsAfterMutation`
- `getCachedOrder`
- `getCachedStrategy`
- `parseStrategyOrderPair`
- `encodeStrategyOrderPair`
- `extractOrderId`
- `getPositionMarketRef`
- `getMarketRefValue`
- `formatUsdOrNA`
- `parsePriceMicroSafe`
- `normalizeTokenId`
- `getPositionSharesBaseForToken`
- `isValidMarketAction`
- `showOutcomeSelection`
- `handleOutcomeSelection`
- `parseSharesBaseSafe`
- `getPositionTokenId`
- `getPositionConditionId`
- `getPositionOppositeTokenId`
- `parseBooleanLike`
- `hasPositiveNumericField`
- `canRedeemPosition`
- `canSellPosition`
- `findOppositePositionForMerge`
- `getMergeablePairSizeBase`
- `resolvePositionMergeInfo`
- `resolveOrderSizeBase`
- `shortenHexLike`
- `isHexLikeId`
- `getOrderStatusText`
- `getOrderSideText`
- `isOrderCancellableStatus`
- `getOrderMarketDisplay`
- `getOrderTokenId`
- `getOrderConditionId`
- `formatSharesCompact`
- `formatOrderRemainingWithNotional`
- `formatStrategyPercentValue`
- `getStrategyStatusText`
- `getPositionSharesForTokenFromList`
- `shortOrderIdOrNA`
- `formatStrategyOrderStatus`
- `resolveOrderMarketDisplay`
- `applyPercentToPriceMicro`
- `getResultErrorMessage`
- `getTxHashFromResult`
- `buildUsdcPercentKeyboard`
- `buildSharesPercentKeyboard`
- `buildLimitPriceKeyboard`
- `getTokenSharesBalanceBase`
- `showBuyAmountPrompt`
- `showBuyConfirmation`
- `showSplitAmountPrompt`
- `showSplitConfirmation`
- `showPositionDetailsFromCache`
- `startSellFromCachedPosition`
- `startMergeFromCachedPosition`
- `startRedeemFromCachedPosition`
- `showMarketDetails`
- `startBuyFlow`
- `handleBuyAmount`
- `executeConfirmedBuy`
- `startSellFlow`
- `handleSellPercent`
- `handleSellAmount`
- `executeConfirmedSell`
- `startLimitFlow`
- `handleLimitAmount`
- `showLimitPricePrompt`
- `showLimitConfirmation`
- `handleLimitPrice`
- `handleLimitBuyPercent`
- `handleLimitSellPercent`
- `handleLimitPricePreset`
- `executeConfirmedLimit`
- `showPositions`
- `showStrategies`
- `showStrategyDetailsFromCache`
- `startCloseStrategyFromCache`
- `executeConfirmedStrategyClose`
- `handleBuyPercent`
- `showOrders`
- `showOrderDetailsFromCache`
- `cancelCachedOrder`
- `extractStrategyTokenPair`
- `startStrategyFlowFromMarket`
- `handleStrategySplitAmount`
- `handleStrategySplitPercent`
- `executeConfirmedStrategySplit`
- `startSplitFlow`
- `handleSplitAmount`
- `handleSplitPercent`
- `executeConfirmedSplit`
- `startMergeFlow`
- `handleMergeAmount`
- `handleMergeMax`
- `executeConfirmedMerge`
- `executeConfirmedRedeem`
- `showSettings`
- `showStrategySettings`
- `showNotificationSettings`
- `startStrategySettingsEdit`
- `handleStrategySettingsInput`
- `startNotificationSettingsEdit`
- `handleNotificationSettingsInput`
- `createMessageEditContext`
- `handleEventsFilterRangeInput`
- `handleWithdrawAddress`
- `handleWithdrawAmount`
- `handleInitWallet`
- `handleSetAllowances`
- `handleCollateralStatus`
- `handleStartExportPk`
- `handleConfirmExportPk`
- `handleCancelExportPk`
- `startWithdrawFlow`
- `handleWithdrawPercent`
- `executeWithdraw`
- `handleExportConfirmation`
- `ensureClientInitialized`
- `ensureContractsInitialized`
- `ensureAutoAllowancesConfigured`
- `sendMessage`
- `sendNotification`
- `only`
- `sendPriceAlertNotification`
- `sendStrategyMarketAlertNotification`
- `showMainMenu`
- `startBot`
- `stopBot`
- `showMarketCategories`
- `showMarketsListLegacy`
- `showMarketPage`
- `handleBuyMarket`
- `handleSellMarket`
- `handleBuyLimit`
- `handleSellLimit`
- `handleSplitLegacy`
- `handleMergeLegacy`
- `showPositionDetails`
- `showActiveStrategies`
- `handleStartStrategy`
- `handleIncreasePosition`
- `handlePartialClose`
- `handleCloseStrategy`
- `handleLanguageChange`
- `handleExportPrivateKey`
- `is`
- `offsetBase`
- `startIndex`
- `worker`
- `absoluteIndex`
- `normalized`
- `byCount`
- `remember`
- `resolveFromCachedMarket`

### src/modules/bot/constants.js
- `MIN_LIMIT_ORDER_SHARES_BASE`

### src/modules/bot/features/language.js
- `showLanguageSelectionScreen`
- `handleLanguageSelectionAction`
- `showLanguageSettingsMenu`
- `handleSettingsLanguageChangeAction`

### src/modules/bot/features/market-details.js
- `createMarketDetailsFeature`
- `showEventDetails`
- `showMarketDetails`
- `startIndex`

### src/modules/bot/features/markets.js
- `createMarketsFeature`
- `showMarketsList`
- `showStrategyMarketsList`
- `showMarketCategoriesList`
- `showEventsFilterMenu`
- `showEventsList`
- `showEventsListByCategoryToken`
- `parsePolymarketEventUrl`
- `handlePolymarketEventUrlInput`
- `startIndex`
- `offset`
- `decodeSafe`

### src/modules/bot/features/orders.js
- `createOrdersFeature`
- `showOrders`
- `showOrderDetailsFromCache`
- `cancelCachedOrder`

### src/modules/bot/features/positions.js
- `createPositionsFeature`
- `showPositions`
- `showPositionDetailsFromCache`
- `startSellFromCachedPosition`
- `startMergeFromCachedPosition`
- `startRedeemFromCachedPosition`

### src/modules/bot/features/security.js
- `createSecurityFeature`
- `ensureClientInitialized`
- `ensureContractsInitialized`
- `ensureAutoAllowancesConfigured`
- `handleInitWallet`
- `handleSetAllowances`
- `handleCollateralStatus`
- `handleStartExportPk`
- `handleConfirmExportPk`
- `handleCancelExportPk`
- `handleExportConfirmation`
- `walletAddress`
- `allowancePromise`

### src/modules/bot/features/settings.js
- `createSettingsFeature`
- `showSettings`
- `showStrategySettings`
- `showNotificationSettings`
- `startStrategySettingsEdit`
- `handleStrategySettingsInput`
- `startNotificationSettingsEdit`
- `handleNotificationSettingsInput`
- `handleEventsFilterRangeInput`
- `parsed`
- `valueLabel`

### src/modules/bot/features/strategies.js
- `createStrategiesFeature`
- `showStrategies`
- `showStrategyDetailsFromCache`
- `startCloseStrategyFromCache`
- `createEmergencyStrategyCloseOrder`
- `executeConfirmedStrategyClose`
- `getDisplayedOrderStatus`

### src/modules/bot/features/trade-limit.js
- `getEnabledSellPercents`
- `buildSellPercentKeyboard`
- `buildMinSellThresholdMessage`
- `createTradeLimitFeature`
- `startLimitFlow`
- `handleLimitAmount`
- `showLimitPricePrompt`
- `showLimitConfirmation`
- `handleLimitPrice`
- `handleLimitBuyPercent`
- `handleLimitSellPercent`
- `handleLimitPricePreset`
- `executeConfirmedLimit`
- `sharesBase`
- `usdcBase`

### src/modules/bot/features/trade-market.js
- `getEnabledSellPercents`
- `buildSellPercentKeyboard`
- `buildMinSellThresholdMessage`
- `createTradeMarketFeature`
- `showOutcomeSelection`
- `handleOutcomeSelection`
- `showBuyAmountPrompt`
- `showBuyConfirmation`
- `startBuyFlow`
- `handleBuyAmount`
- `executeConfirmedBuy`
- `startSellFlow`
- `handleSellPercent`
- `handleSellAmount`
- `executeConfirmedSell`
- `handleBuyPercent`
- `sharesBase`
- `sharesToSellBase`
- `usdcBase`

### src/modules/bot/features/trade-onchain.js
- `createTradeOnchainFeature`
- `extractStrategyTokenPair`
- `showStrategySplitAmountPrompt`
- `showStrategySplitConfirmation`
- `startStrategyFlowFromMarket`
- `handleStrategySplitAmount`
- `handleStrategySplitPercent`
- `executeConfirmedStrategySplit`
- `startSplitFlow`
- `handleSplitAmount`
- `handleSplitPercent`
- `executeConfirmedSplit`
- `startMergeFlow`
- `handleMergeAmount`
- `handleMergeMax`
- `executeConfirmedMerge`
- `executeConfirmedRedeem`
- `amountBase`

### src/modules/bot/features/withdraw.js
- `isValidEthAddress`
- `buildWithdrawPercentKeyboard`
- `createWithdrawFeature`
- `startWithdrawFlow`
- `handleWithdrawAddress`
- `handleWithdrawAmount`
- `handleWithdrawPercent`
- `showWithdrawConfirmation`
- `executeWithdraw`

### src/modules/bot/notifications.js
- `createNotificationsFeature`
- `localizeOutcomeLabel`
- `formatStrategyWatcherPriceLabel`
- `truncateNotificationMarketLabel`
- `resolveAlertMarketRefForCallback`
- `buildAlertCallbackData`
- `only`
- `sendPriceAlertNotification`
- `sendStrategyMarketAlertNotification`

### src/modules/bot/routing/callback-router.js
- `createHandleCallbackRouter`
- `handleCallback`
- `answerCallback`

### src/modules/bot/routing/text-router.js
- `createHandleTextMessageRouter`
- `handleTextMessage`

### src/modules/bot/runtime.js
- `setBot`
- `setAllowedUserId`
- `setBotClientInitPromise`
- `setBotClientInitializedWallet`
- `setBotClientReady`
- `setBotContractsInitPromise`
- `setBotContractsInitializedWallet`
- `setBotContractsReady`
- `setLocalesCache`
- `setCategoriesCatalogCache`

### src/modules/bot/ui/formatters.js
- `toUnitIntervalOrNull`
- `escapeHtml`
- `parseBaseUnitsBigIntSafe`
- `formatPlainNumber`
- `normalizeOutcomeSideHint`
- `getRedeemActionLabel`
- `formatOrderPriceDisplay`
- `getTxUrl`
- `formatTxHashLink`
- `formatSignedPercentValue`
- `parsePercentInput`
- `parsePositiveNumberInput`
- `parseUnitIntervalInput`
- `parseEventsFilterRangeInput`
- `parseNonNegativeIntegerInput`

### src/modules/bot/ui/keyboards.js
- `getLanguageSelectionKeyboard`
- `getMainMenuKeyboard`
- `buildMergeAmountKeyboard`

### src/modules/config.js
- `ensureDataDir`
- `configFileExists`
- `ensureConfigFileExists`
- `loadConfig`
- `fsyncFile`
- `isIgnorableFsyncError`
- `fsyncDirectory`
- `withSaveConfigLock`
- `saveConfig`
- `updateConfig`
- `isLanguageConfigured`
- `isWalletConfigured`
- `export`
- `isFirstRun`
- `getPolygonRpcUrl`
- `parseBooleanEnv`
- `toNonEmptyEnv`
- `splitCsvEnv`
- `getTranslationRuntimeConfig`

### src/modules/constants.js
- `splitPosition`
- `mergePositions`
- `redeemPositions`
- `getCollectionId`
- `getPositionId`
- `balanceOf`
- `balanceOfBatch`
- `setApprovalForAll`
- `isApprovedForAll`
- `approve`
- `allowance`
- `decimals`
- `transfer`

### src/modules/database.js
- `initDatabase`
- `createTables`
- `cacheMarket`
- `getMarketCache`
- `getMarketCacheByConditionId`
- `getMarketCacheByTokenId`
- `getCachedMarkets`
- `toBigInt`
- `savePosition`
- `updatePosition`
- `upsertPositionSnapshot`
- `replacePositionsSnapshot`
- `reducePosition`
- `getPositions`
- `deletePosition`
- `saveOrder`
- `getOrders`
- `getOrderById`
- `getTrackedOrders`
- `cleanupInvalidTrackedOrders`
- `cleanupUnmanagedOrders`
- `upsertOrderStatus`
- `updateOrderStatus`
- `deleteOrder`
- `saveStrategy`
- `updateStrategy`
- `getActiveStrategies`
- `closeStrategy`
- `updatePriceAlert`
- `getPriceAlert`
- `saveTranslation`
- `getTranslation`
- `resultAvg`

### src/modules/i18n.js
- `loadLocale`
- `for`
- `getTranslator`
- `t`
- `getTranslationSync`
- `getLocalesCache`
- `preloadLocale`

### src/modules/logger.js
- `parseBooleanEnv`
- `isSensitiveField`
- `redactSensitive`
- `safeLogError`
- `safeLogWarn`
- `safeLogInfo`
- `shouldEmitLogEntry`
- `emitLogEntry`
- `writeLogEntryToFile`
- `getLoggerRuntimeStatus`
- `flushLogger`
- `normalizeNumericInput`
- `createContext`
- `wait`
- `isRetryableError`
- `retry`
- `formatError`
- `bumpBigNumberish`
- `retryWithHigherGas`
- `redactSensitiveText`
- `redactConsoleArg`
- `patchConsoleForRedaction`

### src/modules/polymarket.js
- `normalizeApiCreds`
- `initClient`
- `toNonEmptyString`
- `toFiniteNumber`
- `normalizeListResponse`
- `normalizeTagFilterCandidates`
- `fetchGammaList`
- `fetchGammaListWithTagFallback`
- `normalizeTagComparable`
- `eventHasTagMatch`
- `getMarkets`
- `getMarketDetailsById`
- `getMarketDetailsBySlug`
- `getMarketDetails`
- `getEventTags`
- `getEvents`
- `getCategories`
- `getEventById`
- `getEventBySlug`
- `getEvent`
- `filterTradeableSubmarkets`
- `getOrderBook`
- `getBestBidAsk`
- `parseUSDCToBase`
- `formatUSDCFromBase`
- `parseSharesToBase`
- `formatSharesFromBase`
- `parsePriceToMicro`
- `formatPriceFromMicro`
- `computeSharesFromUSDC`
- `computeUSDCFromShares`
- `calculateMarketablePriceMicro`
- `absBigInt`
- `getPriceMoveBps`
- `formatBpsPercent`
- `enforceRetryPriceMovementLimits`
- `extractErrorMessage`
- `normalizeErrorMessageForUser`
- `resolveOrderPlacementResult`
- `mapErrorToUserMessage`
- `normalizePositionFromApi`
- `sleep`
- `invalidateOnchainPositionCaches`
- `getExplorerApiKey`
- `getOnchainFallbackStartBlock`
- `isNoTransactionsResult`
- `isRateLimitedResult`
- `parseArrayLike`
- `normalizeConditionId`
- `normalizeOutcomeFromIndexSet`
- `parsePriceMicroOrNull`
- `buildTokenMetaFromCachedMarkets`
- `fetchGammaMarketByConditionId`
- `normalizeExplorerProxyTx`
- `isExplorerPayloadRateLimited`
- `fetchExplorerTransactionByHash`
- `buildSplitDerivedTokenMeta`
- `fetchOnchainTransfersFromExplorer`
- `buildTokenBalancesFromTransfers`
- `collectTouchedTokenIdsFromTransfers`
- `chunkArray`
- `getOnchainReadProvider`
- `fetchTokenBalancesFromChain`
- `buildOnchainPositionsFromBalances`
- `getOnchainPositionsFromExplorer`
- `getPositions`
- `getOrders`
- `normalizeOpenOrdersPage`
- `getL2HeaderTimestamp`
- `fetchOpenOrdersPageViaHttp`
- `getOpenOrdersViaHttpFallback`
- `hasMarketOrderSupport`
- `refreshClobBalanceAllowance`
- `safeToBigInt`
- `getCollateralStatus`
- `getCollateralBalanceBase`
- `ensureClobCollateralReady`
- `toUSDCBaseAmount`
- `toSharesBaseAmount`
- `toPriceMicroAmount`
- `normalizeTickSizeForSdk`
- `resolveOrderOptions`
- `toSdkNumber`
- `isSafeToRetryOrderPlacement`
- `isAmbiguousTransportOrderError`
- `normalizeOrderSide`
- `extractTokenIdFromOrder`
- `extractOrderIdFromAny`
- `parsePriceMicroSafe`
- `parseSharesBaseSafe`
- `extractOrderSizeBase`
- `parseOrderCreatedAtMs`
- `isOpenOrderMatchingRequest`
- `sortMatchingOpenOrdersNewestFirst`
- `getMatchingOpenOrders`
- `snapshotMatchingOpenOrderIds`
- `reconcileOrderAfterAmbiguousFailure`
- `placeMarketBuyFOK`
- `placeMarketSellFOK`
- `placeMarketSellWithFallback`
- `createOrder`
- `cancelOrder`
- `checkBalance`
- `splitPosition`
- `mergePositions`
- `convertPositions`
- `wcol`
- `getConditionId`
- `getMarketData`
- `parsePositiveNumberEnv`
- `maxBigNumber`
- `isBelowMinAmount`
- `toWeiFromGwei`
- `getBumpNumerator`
- `applyBump`
- `isRetryableApprovalGasError`
- `buildApprovalGasOverrides`
- `sendWithAdaptiveApprovalGas`
- `parseRpcChainId`
- `resolveRpcChainId`
- `createWorkingProvider`
- `initContracts`
- `checkAllowance`
- `setAllowance`
- `withdrawUSDC`
- `checkApproval`
- `setApproval`
- `normalizeOutcomeKey`
- `normalizeConditionIdOrThrow`
- `ensureNegRiskAdapterReady`
- `ensureErc1155ApprovalFor`
- `getNegRiskTokenMappingByCondition`
- `resolveTokenKindInNegRiskMap`
- `mergeLegacyUsdcPair`
- `splitNegRiskToTradable`
- `mergeNegRiskTradable`
- `shouldAttemptNegRiskSellFallback`
- `executeNegRiskLegacySellFallback`
- `setAllAllowances`
- `getOnchainAllowancesUSDC`
- `split`
- `getSignerAddress`
- `merge`
- `redeem`
- `offset`
- `fraction`
- `adverseMove`
- `matched`
- `address`
- `walletAddress`
- `message`
- `errMsg`
- `lower`
- `legacyYes`
- `legacyNo`
- `tradableYes`
- `tradableNo`

### src/modules/proxy.js
- `toNonEmptyString`
- `isProxyPlaceholder`
- `parsePositiveIntegerEnv`
- `redactProxyForLogs`
- `normalizeProxyUrl`
- `getProxyConfig`
- `isProxyEnabled`
- `getProxyAgent`
- `applyProxyEnv`
- `applyAxiosClientDefaults`
- `applyAxiosDefaults`
- `patchClobHttpHelpersRequest`
- `patchedClobRequest`
- `normalizeFetchHeaders`
- `createFetchLikeResponse`
- `proxyAwareFetch`
- `patchFetchForProxy`
- `getWebSocketProxyOptions`
- `parseRpcResponseData`
- `patchProviderSendForProxy`
- `patchedProxySend`
- `applyProxyRuntime`
- `patchModule`
- `assignHeader`
- `appendHeaders`
- `buildResponse`
- `FetchHeadersAdapter`

### src/modules/strategyMarketWatcher.js
- `normalizeTokenId`
- `toFinitePositiveNumber`
- `clampInteger`
- `splitIntoChunks`
- `asArrayPayload`
- `resolveStrategyMaxAskPrice`
- `resolveNotificationsCooldownMs`
- `formatProbability`
- `isTradeableMarketCandidate`
- `getMarketKey`
- `parseTokenPair`
- `getWsEventType`
- `extractBestAskFromBook`
- `createStrategyMarketWatcher`
- `log`
- `getDiscoveryPageSize`
- `getDiscoveryPages`
- `getDiscoveryRefreshMs`
- `getMaxTrackedMarkets`
- `getSubscriptionChunkSize`
- `fetchDiscoveryPage`
- `sendWsOperation`
- `clearReconnectTimer`
- `scheduleReconnect`
- `closeSocket`
- `handleSocketMessage`
- `handlePriceUpdate`
- `handleSocketEvent`
- `connectWebSocketIfNeeded`
- `updateSubscriptions`
- `refreshUniverseIfNeeded`
- `queueAlertIfNeeded`
- `tick`
- `shutdown`
- `getStateSnapshot`
- `offset`

### src/modules/workers.js
- `ensureWorkerMetric`
- `summarizeWorkerError`
- `getWorkersHealthSnapshot`
- `parseIntervalEnv`
- `toBigIntSafe`
- `parseSharesBaseSafe`
- `parsePriceMicroSafe`
- `hasFieldValue`
- `readOrderSizeBase`
- `getRecordUniqueKey`
- `extractFilledSizeBaseFromRecord`
- `sumFilledSizeFromRecords`
- `fetchFilledSizeFromDataApi`
- `getOrderId`
- `parseOrderIds`
- `normalizeOrderId`
- `parseStrategyOrderPair`
- `encodeStrategyOrderPair`
- `getOrderStatusById`
- `isSafeCancelOrderFailure`
- `cancelOrderAndMark`
- `getOrdersByIds`
- `getOrdersAggregateStatus`
- `dedupeTokens`
- `absBigInt`
- `nowIso`
- `fetchOpenOrdersWithRetry`
- `ensureClientInitialized`
- `sendWorkerNotification`
- `resolvePriceAlertCooldownMs`
- `fetchDataApiList`
- `resolveMissingOrderStatus`
- `isFillLikeActivity`
- `getPercentDiffBps`
- `buildStrategyEntryPriceMap`
- `applyPercentToPriceMicro`
- `applyPercentToValue`
- `cancelOrdersAndMark`
- `createEmergencyStopLimit`
- `syncPositionsWorker`
- `monitorPricesWorker`
- `monitorStrategyMarketsWatcherWorker`
- `monitorOrdersWorker`
- `monitorStrategiesWorker`
- `runWorker`
- `scheduleWorker`
- `startWorkers`
- `stopWorkers`
- `adjusted`
- `run`

### tests/run-tests.js
- no top-level named functions/classes found by scanner.

### tests/unit/auth-crypto.test.js
- no top-level named functions/classes found by scanner.

### tests/unit/config-runtime.test.js
- `withEnv`

### tests/unit/formatters.test.js
- no top-level named functions/classes found by scanner.

### tests/unit/logger.test.js
- no top-level named functions/classes found by scanner.

### tests/unit/migration-common.test.js
- no top-level named functions/classes found by scanner.

### tests/unit/polymarket-conversions.test.js
- no top-level named functions/classes found by scanner.

### tests/unit/runtime.test.js
- no top-level named functions/classes found by scanner.

### tests/unit/withdraw.test.js
- `isValidEthAddress`
- `amount10`
- `amount20`
- `amount30`
- `amount50`
