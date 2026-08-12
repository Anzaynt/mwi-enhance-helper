// ==UserScript==
// @name         Milkyway Idle - Enhance Helper
// @namespace    https://github.com/Anzaynt/mwi-enhance-helper
// @version      1.6.0
// @description  Enhancement profit helper: identify profitable enhancements and record realized market profit.
// @author       wangchyan / 柒雨 / PaperCat / fixed integrated edition
// @license      MIT
// @homepageURL   https://github.com/Anzaynt/mwi-enhance-helper
// @supportURL    https://github.com/Anzaynt/mwi-enhance-helper/issues
// @updateURL     https://raw.githubusercontent.com/Anzaynt/mwi-enhance-helper/main/mwi-enhance-helper.user.js
// @downloadURL   https://raw.githubusercontent.com/Anzaynt/mwi-enhance-helper/main/mwi-enhance-helper.user.js
// @match        https://*.milkywayidle.com/*
// @match        https://*.milkywayidlecn.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/mathjs/10.6.4/math.min.js
// @require      https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  if (window.__MWI_PRIVATE_PROFIT_LEDGER__) return;
  window.__MWI_PRIVATE_PROFIT_LEDGER__ = true;

  const DB_NAME = "MWI_Private_Profit_Ledger";
  const DB_VERSION = 1;
  const ORDER_STORE = "orders";
  const EVENT_STORE = "fills";
  const GENERAL_SELL_FACTOR = 0.98;
  const COWBELL_BAG_SELL_FACTOR = 0.82;
  // New storage deliberately starts clean after the ledger-accuracy repair.
  // Old provisional snapshots must never be treated as real batches.
  const ENHANCEMENT_HISTORY_KEY = "MWI_Integrated_EnhancementHistory_v3";
  const ENHANCEMENT_SERVER_LEVELS_KEY = "MWI_EnhancementServerLevels_v2";
  const completedEnhancementLogTimes = window.__MWI_COMPLETED_ENHANCE_LOG_TIMES__ ||= new Set();
  const enhancementCompletions = window.__MWI_ENHANCEMENT_COMPLETIONS__ ||= (() => {
    try {
      const rows = JSON.parse(localStorage.getItem(ENHANCEMENT_SERVER_LEVELS_KEY) || "[]");
      return Array.isArray(rows) ? rows : [];
    } catch (_) { return []; }
  })();
  const liveEnhancementActions = new Map();
  const enhancementBatchStates = new Map();
  const recentEnhancementCompletionMessages = new Map();
  const processedMessageEvents = new WeakSet();
  let currentCharacterId = "unknown";
  let writeQueue = Promise.resolve();
  let dbPromise = null;

  const profitUi = {
    button: null,
    overlay: null,
    dialog: null,
    panel: null,
    integrationTimer: null,
    refreshToken: 0
  };

  function openLedgerDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ORDER_STORE)) {
          const orders = db.createObjectStore(ORDER_STORE, { keyPath: "key" });
          orders.createIndex("characterId", "characterId", { unique: false });
          orders.createIndex("lastSeenAt", "lastSeenAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(EVENT_STORE)) {
          const fills = db.createObjectStore(EVENT_STORE, { keyPath: "id" });
          fills.createIndex("orderKey", "orderKey", { unique: false });
          fills.createIndex("occurredAt", "occurredAt", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开收益账本数据库"));
    });
    return dbPromise;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB 操作失败"));
    });
  }

  async function getAllRecords(storeName) {
    const db = await openLedgerDb();
    const tx = db.transaction(storeName, "readonly");
    return requestResult(tx.objectStore(storeName).getAll());
  }

  function numeric(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeCharacterId(order, message) {
    const value = order?.characterID ?? order?.characterId
      ?? message?.character?.id ?? message?.character?.characterID
      ?? message?.characterID ?? message?.characterId ?? currentCharacterId;
    return value === undefined || value === null || value === "" ? "unknown" : String(value);
  }

  function orderKey(order, characterId) {
    const id = order?.id ?? order?.marketListingID ?? order?.marketListingId;
    if (id === undefined || id === null) return null;
    return `${characterId}|${id}`;
  }

  function sellFactor(itemHrid) {
    return itemHrid === "/items/bag_of_10_cowbells"
      ? COWBELL_BAG_SELL_FACTOR
      : GENERAL_SELL_FACTOR;
  }

  function extractPersonalOrders(message) {
    const results = [];
    const seen = new Set();
    for (const [name, value] of Object.entries(message || {})) {
      if (!Array.isArray(value) || !/marketlistings/i.test(name)) continue;
      for (const order of value) {
        if (!order || typeof order !== "object" || !order.itemHrid) continue;
        if (order.id === undefined && order.marketListingID === undefined && order.marketListingId === undefined) continue;
        const fingerprint = `${order.id ?? order.marketListingID ?? order.marketListingId}|${order.itemHrid}|${order.isSell}`;
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        results.push({ order, source: name });
      }
    }
    return results;
  }

  function currentCharacterFromMessage(message) {
    const value = message?.character?.id ?? message?.character?.characterID
      ?? message?.characterID ?? message?.characterId;
    if (value !== undefined && value !== null && value !== "") {
      currentCharacterId = String(value);
      window.__MWI_PROFIT_CURRENT_CHARACTER_ID__ = currentCharacterId;
    }
  }

  function rememberCompletedEnhancementLogs(message) {
    for (const value of Object.values(message || {})) {
      if (!Array.isArray(value)) continue;
      for (const log of value) {
        if (log?.actionHrid !== "/actions/enhancing/enhance" || !log.endTime || !log.startTime) continue;
        completedEnhancementLogTimes.add(String(log.startTime).slice(0, 19));
      }
    }
  }

  function enhancementHashInfo(hash, items = []) {
    const text = String(hash || "");
    const levelMatch = text.match(/::(\d+)$/);
    const matchedItem = items.find((item) => item?.hash === text);
    const parts = text.split("::");
    const itemHrid = matchedItem?.itemHrid || parts.find((part) => part.startsWith("/items/")) || null;
    // Most item hashes end in ::<enhancement level>, but some completion
    // payloads identify the concrete item with a non-numeric suffix. In that
    // case the authoritative endCharacterItems entry still contains its level.
    const itemLevel = Number(matchedItem?.enhancementLevel);
    const level = levelMatch ? Number(levelMatch[1]) : itemLevel;
    return itemHrid && Number.isInteger(level) && level >= 0 ? { itemHrid, level } : null;
  }

  function completedEnhancementAction(message) {
    // Reconnects often replay a finished queue as action_completed, rather
    // than actions_updated.  Both protocol forms are authoritative here.
    if (message?.type === "action_completed"
      && message?.endCharacterAction?.actionHrid === "/actions/enhancing/enhance") {
      return message.endCharacterAction;
    }
    if (message?.type === "actions_updated" && Array.isArray(message?.endCharacterActions)) {
      return message.endCharacterActions.find((action) =>
        action?.isDone === true && action?.actionHrid === "/actions/enhancing/enhance"
      ) || null;
    }
    return null;
  }

  function enhancementActionKey(itemHrid, targetLevel) {
    return `${currentCharacterId}|${itemHrid}|${Number.isFinite(Number(targetLevel)) ? Number(targetLevel) : "unknown"}`;
  }

  function rememberLiveEnhancementActions(message) {
    const items = message?.characterItems || message?.endCharacterItems || [];
    const candidates = [];
    if (Array.isArray(message?.characterActions)) candidates.push(...message.characterActions);
    for (const [name, value] of Object.entries(message || {})) {
      if (name === "endCharacterAction") continue;
      if (value?.actionHrid === "/actions/enhancing/enhance") candidates.push(value);
      if (Array.isArray(value)) candidates.push(...value.filter((row) => row?.actionHrid === "/actions/enhancing/enhance"));
    }
    for (const action of candidates) {
      if (action?.actionHrid !== "/actions/enhancing/enhance") continue;
      const info = enhancementHashInfo(action.primaryItemHash, items);
      if (!info) continue;
      const targetLevel = numeric(action.enhancingMaxLevel, NaN);
      liveEnhancementActions.set(enhancementActionKey(info.itemHrid, targetLevel), {
        itemHrid: info.itemHrid,
        level: info.level,
        targetLevel,
        currentCount: numeric(action.currentCount, 0),
        observedAt: new Date().toISOString()
      });
    }
  }

  function rememberEnhancementCompletion(message) {
    const action = completedEnhancementAction(message);
    if (!action) return;
    const messageSignature = [action.primaryItemHash, action.currentCount, action.enhancingMaxLevel].join("|");
    const messageTime = Date.now();
    const previousMessageTime = recentEnhancementCompletionMessages.get(messageSignature) || 0;
    if (messageTime - previousMessageTime < 2000) return;
    recentEnhancementCompletionMessages.set(messageSignature, messageTime);
    if (recentEnhancementCompletionMessages.size > 50) {
      for (const [signature, seenAt] of recentEnhancementCompletionMessages) {
        if (messageTime - seenAt > 10000) recentEnhancementCompletionMessages.delete(signature);
      }
    }
    const completionItems = message.endCharacterItems || message.characterItems || [];
    const info = enhancementHashInfo(action.primaryItemHash, completionItems);
    if (!info) return;
    const targetLevel = numeric(action.enhancingMaxLevel, NaN);
    const currentCount = numeric(action.currentCount, NaN);
    const key = enhancementActionKey(info.itemHrid, targetLevel);
    const live = liveEnhancementActions.get(key);
    const otherSameItems = completionItems.filter((item) =>
      item?.itemHrid === info.itemHrid && item?.hash !== action.primaryItemHash
    );
    let preAttemptItem = null;
    if (otherSameItems.length === 1) preAttemptItem = otherSameItems[0];
    else if (otherSameItems.length > 1) {
      const withoutSecondary = otherSameItems.filter((item) => item?.hash !== action.secondaryItemHash);
      if (withoutSecondary.length === 1) preAttemptItem = withoutSecondary[0];
    }
    const preAttemptLevel = Number.isInteger(Number(preAttemptItem?.enhancementLevel))
      ? Number(preAttemptItem.enhancementLevel)
      : null;
    let state = enhancementBatchStates.get(key);
    if (!state || !Number.isFinite(currentCount) || currentCount <= numeric(state.lastCount)) {
      state = {
        startLevel: Number.isInteger(live?.level) ? live.level : preAttemptLevel,
        startLevelSource: Number.isInteger(live?.level) ? "server_action" : (preAttemptLevel !== null ? "server_item_transition" : "unknown"),
        startedAt: live?.observedAt || new Date().toISOString(),
        lastCount: 0
      };
    }
    state.lastCount = currentCount;
    state.finalLevel = info.level;
    enhancementBatchStates.set(key, state);
    liveEnhancementActions.set(key, { itemHrid: info.itemHrid, level: info.level, targetLevel, currentCount, observedAt: new Date().toISOString() });
    const completion = {
      itemHrid: info.itemHrid,
      startLevel: state.startLevel,
      startLevelSource: state.startLevelSource,
      finalLevel: info.level,
      finalLevelSource: "server_action_completed",
      targetLevel,
      enhanceCount: currentCount,
      protectAt: numeric(action.enhancingProtectionMinLevel, NaN),
      startedAt: state.startedAt,
      observedAt: new Date().toISOString()
    };
    const duplicateIndex = enhancementCompletions.findIndex((row) =>
      row.itemHrid === completion.itemHrid
      && row.enhanceCount === completion.enhanceCount
      && row.targetLevel === completion.targetLevel
      && row.finalLevel === completion.finalLevel
      && Math.abs(new Date(row.observedAt).getTime() - new Date(completion.observedAt).getTime()) < 5000
    );
    if (duplicateIndex >= 0) enhancementCompletions[duplicateIndex] = completion;
    else enhancementCompletions.push(completion);
    if (enhancementCompletions.length > 100) enhancementCompletions.splice(0, enhancementCompletions.length - 100);
    try { localStorage.setItem(ENHANCEMENT_SERVER_LEVELS_KEY, JSON.stringify(enhancementCompletions)); } catch (_) {}
  }

  window.__MWI_FIND_ENHANCEMENT_COMPLETION__ = (itemHrid, enhanceCount, startedAt = null, completedAt = null) => {
    const candidates = enhancementCompletions.filter((row) =>
      row.itemHrid === itemHrid
      && (!Number.isFinite(Number(enhanceCount)) || row.enhanceCount === Number(enhanceCount))
    );
    if (!candidates.length) return null;
    const referenceTime = new Date(completedAt || startedAt || "").getTime();
    if (Number.isFinite(referenceTime)) {
      const timed = candidates
        .map((row) => ({ row, distance: Math.abs(new Date(row.observedAt || "").getTime() - referenceTime) }))
        .filter(({ distance }) => Number.isFinite(distance))
        .sort((left, right) => left.distance - right.distance);
      if (timed.length && timed[0].distance <= 15 * 60 * 1000) return timed[0].row;
      // After an offline period observedAt is necessarily the login time, not
      // the queue's end time.  A single matching item/count is still exact;
      // do not lose its final level merely because the player came back late.
      if (candidates.length === 1) return candidates[0];
      return null;
    }
    return candidates[candidates.length - 1];
  };

  // The integrated loot tracker has its own WebSocket wrapper. Let it forward
  // enhancement messages too, so stacked userscript wrappers cannot hide the
  // authoritative action_completed payload from this early ledger hook.
  window.__MWI_CAPTURE_ENHANCEMENT_MESSAGE__ = (message) => {
    if (!message || typeof message !== "object") return;
    currentCharacterFromMessage(message);
    rememberCompletedEnhancementLogs(message);
    rememberEnhancementCompletion(message);
    rememberLiveEnhancementActions(message);
  };

  function normalizeOrder(raw, message, source, oldOrder, now) {
    const characterId = normalizeCharacterId(raw, message);
    const key = orderKey(raw, characterId);
    if (!key) return null;
    const filledQuantity = Math.max(0, numeric(raw.filledQuantity));
    const orderQuantity = Math.max(filledQuantity, numeric(raw.orderQuantity, filledQuantity));
    const unclaimedCoinCount = Math.max(0, numeric(raw.unclaimedCoinCount));
    const unclaimedItemCount = Math.max(0, numeric(raw.unclaimedItemCount));
    return {
      key,
      id: String(raw.id ?? raw.marketListingID ?? raw.marketListingId),
      characterId,
      itemHrid: String(raw.itemHrid),
      enhancementLevel: Math.max(0, Math.trunc(numeric(raw.enhancementLevel))),
      isSell: Boolean(raw.isSell),
      price: Math.max(0, numeric(raw.price)),
      orderQuantity,
      filledQuantity,
      status: String(raw.status || oldOrder?.status || "/market_listing_status/active"),
      unclaimedCoinCount,
      unclaimedItemCount,
      firstSeenAt: oldOrder?.firstSeenAt || now,
      lastSeenAt: now,
      source,
      lastUnclaimedCoinCount: unclaimedCoinCount,
      lastUnclaimedItemCount: unclaimedItemCount,
      observedNetCoins: numeric(oldOrder?.observedNetCoins),
      observedClaimedItems: numeric(oldOrder?.observedClaimedItems),
      exactSellFilledQuantity: numeric(oldOrder?.exactSellFilledQuantity),
      backfilled: oldOrder?.backfilled ?? (/myMarketListings/i.test(source) && filledQuantity > 0)
    };
  }

  async function ingestOrderBatch(message, extracted) {
    if (!extracted.length) return;
    const db = await openLedgerDb();
    const tx = db.transaction([ORDER_STORE, EVENT_STORE], "readwrite");
    const orders = tx.objectStore(ORDER_STORE);
    const fills = tx.objectStore(EVENT_STORE);
    const now = new Date().toISOString();

    for (const { order: raw, source } of extracted) {
      const characterId = normalizeCharacterId(raw, message);
      const key = orderKey(raw, characterId);
      if (!key) continue;
      const oldOrder = await requestResult(orders.get(key));
      const normalized = normalizeOrder(raw, message, source, oldOrder, now);
      if (!normalized) continue;

      const oldFilled = numeric(oldOrder?.filledQuantity);
      const fillDelta = Math.max(0, normalized.filledQuantity - oldFilled);
      const oldUnclaimedCoins = numeric(oldOrder?.lastUnclaimedCoinCount);
      // 首次看见一个已有成交的订单时，unclaimedCoinCount 可能只是尚未领取的余额，
      // 不能证明它覆盖了全部 filledQuantity。只有连续两次服务器快照之间的增量才算准确。
      const coinIncrease = oldOrder
        ? Math.max(0, normalized.unclaimedCoinCount - oldUnclaimedCoins)
        : 0;
      const oldUnclaimedItems = numeric(oldOrder?.lastUnclaimedItemCount);
      const itemIncrease = Math.max(0, normalized.unclaimedItemCount - oldUnclaimedItems);

      normalized.observedClaimedItems += itemIncrease;
      const expectedSellAmount = normalized.price * fillDelta * sellFactor(normalized.itemHrid);
      // 若领取金币和新成交恰好落在同一服务器快照中，待领取金币的净增量会偏小。
      // 只有它与按订单价计算的税后金额基本吻合时，才标为服务器可核对金额。
      const exactSellAmount = normalized.isSell && fillDelta > 0 && coinIncrease > 0
        && Math.abs(coinIncrease - expectedSellAmount) <= Math.max(1, fillDelta);
      if (exactSellAmount) {
        normalized.observedNetCoins += coinIncrease;
        normalized.exactSellFilledQuantity += fillDelta;
      }

      if (fillDelta > 0) {
        const amount = normalized.isSell
          ? (exactSellAmount
            ? coinIncrease
            : expectedSellAmount)
          : normalized.price * fillDelta;
        const eventId = `${key}|${oldFilled}->${normalized.filledQuantity}`;
        fills.put({
          id: eventId,
          orderKey: key,
          orderId: normalized.id,
          characterId,
          itemHrid: normalized.itemHrid,
          enhancementLevel: normalized.enhancementLevel,
          isSell: normalized.isSell,
          quantity: fillDelta,
          cumulativeFilledQuantity: normalized.filledQuantity,
          orderQuantity: normalized.orderQuantity,
          limitPrice: normalized.price,
          amount,
          amountConfidence: exactSellAmount ? "server" : "estimated",
          occurredAt: now,
          backfilled: normalized.backfilled,
          source,
          status: normalized.status
        });
      }

      if (oldOrder && normalized.unclaimedCoinCount < oldUnclaimedCoins) {
        fills.put({
          id: `${key}|claim-coins|${now}`,
          orderKey: key,
          orderId: normalized.id,
          characterId,
          itemHrid: normalized.itemHrid,
          enhancementLevel: normalized.enhancementLevel,
          isSell: true,
          quantity: 0,
          amount: oldUnclaimedCoins - normalized.unclaimedCoinCount,
          amountConfidence: "server",
          kind: "claim",
          occurredAt: now,
          source,
          status: normalized.status
        });
      }

      orders.put(normalized);
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("收益账本写入失败"));
      tx.onabort = () => reject(tx.error || new Error("收益账本写入已中止"));
    });
    scheduleProfitPanelRefresh();
  }

  function handleGameMessage(message) {
    if (!message || typeof message !== "object") return;
    currentCharacterFromMessage(message);
    rememberCompletedEnhancementLogs(message);
    rememberEnhancementCompletion(message);
    rememberLiveEnhancementActions(message);
    const extracted = extractPersonalOrders(message);
    if (!extracted.length) return;
    writeQueue = writeQueue
      .then(() => ingestOrderBatch(message, extracted))
      .catch((error) => console.error("[MWI Profit Ledger] 订单记账失败", error));
  }

  function installEarlyWebSocketLedger() {
    const descriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
    if (!descriptor || typeof descriptor.get !== "function") return;
    const originalGetter = descriptor.get;
    Object.defineProperty(MessageEvent.prototype, "data", {
      ...descriptor,
      get: function () {
        const value = originalGetter.call(this);
        if (this.currentTarget instanceof WebSocket && typeof value === "string" && !processedMessageEvents.has(this)) {
          processedMessageEvents.add(this);
          try {
            handleGameMessage(JSON.parse(value));
          } catch (_) {}
        }
        return value;
      }
    });
  }

  function profitItemKey(row) {
    return `${row.characterId}|${row.itemHrid}|${numeric(row.enhancementLevel)}`;
  }

  function loadEnhancementLots() {
    try {
      const rows = JSON.parse(localStorage.getItem(ENHANCEMENT_HISTORY_KEY) || "[]");
      if (!Array.isArray(rows)) return [];
      return mergeEnhancementHistory(rows.filter((row) =>
        Number.isInteger(Number(row?.finalLevel))
        && ["server", "server_action_completed", "successful_target"].includes(row?.finalLevelSource)
      ))
        .filter((row) => row?.characterId && row?.itemHrid && row.finalLevel !== null && row.finalLevel !== undefined && Number.isInteger(Number(row.finalLevel)))
        .map((row) => ({
          characterId: String(row.characterId),
          itemHrid: row.itemHrid,
          enhancementLevel: Number(row.finalLevel),
          quantity: 1,
          remaining: 1,
          unitCost: numeric(row.startingItemCost) + numeric(row.totalCost),
          confidence: "estimated",
          occurredAt: row.completedAt || row.archivedAt,
          source: "enhancement",
          batchKey: row.key
        }));
    } catch (_) {
      return [];
    }
  }

  function replayProfit(fills, enhancementLots = []) {
    const lots = new Map();
    const realizedRows = [];
    const enhancementSaleLinks = [];
    const timeline = [
      ...enhancementLots.map((lot) => ({ ...lot, replayKind: "lot" })),
      ...fills.filter((event) => event.kind !== "claim").map((event) => ({ ...event, replayKind: "fill" }))
    ].sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));

    const addLot = (key, lot) => {
      if (!lots.has(key)) lots.set(key, []);
      lots.get(key).push(lot);
    };

    for (const entry of timeline) {
      const key = profitItemKey(entry);
      if (entry.replayKind === "lot") {
        addLot(key, { ...entry });
        continue;
      }
      if (!entry.isSell) {
        addLot(key, {
          remaining: numeric(entry.quantity),
          unitCost: numeric(entry.quantity) > 0 ? numeric(entry.amount) / numeric(entry.quantity) : 0,
          confidence: entry.amountConfidence,
          occurredAt: entry.occurredAt,
          source: "market_buy"
        });
        continue;
      }

      let remaining = numeric(entry.quantity);
      let matchedCost = 0;
      let matchedQuantity = 0;
      let hasEstimatedCost = false;
      const saleUnitRevenue = numeric(entry.quantity) > 0 ? numeric(entry.amount) / numeric(entry.quantity) : 0;
      const queue = lots.get(key) || [];
      for (const lot of queue) {
        if (remaining <= 0) break;
        if (lot.remaining <= 0) continue;
        const used = Math.min(remaining, lot.remaining);
        matchedCost += used * lot.unitCost;
        matchedQuantity += used;
        remaining -= used;
        lot.remaining -= used;
        if (lot.confidence !== "server") hasEstimatedCost = true;
        if (lot.source === "enhancement" && lot.batchKey) {
          enhancementSaleLinks.push({
            batchKey: lot.batchKey,
            saleEventId: entry.id,
            quantity: used,
            revenue: used * saleUnitRevenue,
            revenueConfidence: entry.amountConfidence,
            soldAt: entry.occurredAt
          });
        }
      }
      const revenue = numeric(entry.amount);
      const confidence = remaining > 0
        ? "unknown"
        : (entry.amountConfidence === "server" && !hasEstimatedCost ? "server" : "estimated");
      realizedRows.push({
        ...entry,
        revenue,
        matchedCost,
        matchedQuantity,
        unmatchedQuantity: remaining,
        profit: remaining > 0 ? null : revenue - matchedCost,
        profitConfidence: confidence
      });
    }

    return { lots, realizedRows, enhancementSaleLinks };
  }

  function loadEnhancementHistory() {
    try {
      const rows = JSON.parse(localStorage.getItem(ENHANCEMENT_HISTORY_KEY) || "[]");
      if (!Array.isArray(rows)) return [];
      // A distribution of drops proves only levels seen during the queue, not
      // the final equipped item.  Exclude provisional old snapshots here too.
      return mergeEnhancementHistory(rows.filter((row) =>
        Number.isInteger(Number(row?.finalLevel))
        && ["server", "server_action_completed", "successful_target"].includes(row?.finalLevelSource)
      ));
    } catch (_) {
      return [];
    }
  }

  function enhancementStartTime(row) {
    const explicit = new Date(row?.startedAt || "").getTime();
    if (Number.isFinite(explicit)) return explicit;
    const end = new Date(row?.completedAt || row?.archivedAt || "").getTime();
    return Number.isFinite(end) ? end - numeric(row?.duration) * 1000 : NaN;
  }

  function enhancementEndTime(row) {
    const end = new Date(row?.completedAt || row?.archivedAt || "").getTime();
    return Number.isFinite(end) ? end : enhancementStartTime(row) + numeric(row?.duration) * 1000;
  }

  function canMergeEnhancementSegments(previous, next) {
    if (!previous || !next || previous.itemHrid !== next.itemHrid) return false;
    const previousCharacter = String(previous.characterId || "unknown");
    const nextCharacter = String(next.characterId || "unknown");
    if (previousCharacter !== "unknown" && nextCharacter !== "unknown" && previousCharacter !== nextCharacter) return false;
    const previousFinalWasInferred = !["server", "server_action_completed", "successful_target"].includes(previous.finalLevelSource);
    // A finished server-confirmed batch is never a continuation, even if the
    // next batch happens to start at the same level and target the same item.
    if (!previousFinalWasInferred) return false;
    const levelsConnect = numeric(next.startLevel, -2) === numeric(previous.finalLevel, -1);
    if (!levelsConnect && !previousFinalWasInferred) return false;
    const previousEnd = enhancementEndTime(previous);
    const nextStart = enhancementStartTime(next);
    return Number.isFinite(previousEnd) && Number.isFinite(nextStart)
      && previousEnd <= nextStart;
  }

  function sumOptional(left, right) {
    const a = Number(left);
    const b = Number(right);
    return Number.isFinite(a) && Number.isFinite(b) ? a + b : null;
  }

  function appendEnhancementSegment(chain, next) {
    const segments = [...(chain.segments || [chain.key]), ...(next.segments || [next.key])];
    const correctedLink = numeric(chain.finalLevel, -1) !== numeric(next.startLevel, -2);
    return {
      ...chain,
      characterId: String(chain.characterId || "unknown") === "unknown" ? next.characterId : chain.characterId,
      key: `chain|${segments.join("|")}`,
      segments,
      chainCount: segments.length,
      correctedLinkCount: numeric(chain.correctedLinkCount) + (correctedLink ? 1 : 0),
      correctedLinks: [...(chain.correctedLinks || []), ...(correctedLink ? [{ from: chain.finalLevel, to: next.startLevel }] : [])],
      completedAt: next.completedAt || next.archivedAt,
      archivedAt: next.archivedAt,
      finalLevel: next.finalLevel,
      finalLevelSource: next.finalLevelSource,
      targetLevel: next.targetLevel,
      protectAt: next.protectAt,
      enhanceCount: numeric(chain.enhanceCount) + numeric(next.enhanceCount),
      duration: numeric(chain.duration) + numeric(next.duration),
      materialCost: numeric(chain.materialCost) + numeric(next.materialCost),
      protectionCost: numeric(chain.protectionCost) + numeric(next.protectionCost),
      totalCost: numeric(chain.totalCost) + numeric(next.totalCost),
      protectionCount: numeric(chain.protectionCount) + numeric(next.protectionCount),
      materialAskCost: sumOptional(chain.materialAskCost, next.materialAskCost),
      materialBidCost: sumOptional(chain.materialBidCost, next.materialBidCost),
      protectionAskCost: sumOptional(chain.protectionAskCost, next.protectionAskCost),
      protectionBidCost: sumOptional(chain.protectionBidCost, next.protectionBidCost),
      outputAskPrice: next.outputAskPrice,
      outputBidPrice: next.outputBidPrice,
      bidPrice: next.bidPrice,
      revenue: next.revenue,
      netCashFlow: null
    };
  }

  function enhancementGroupIdentity(row) {
    return String(row.itemHrid || "");
  }

  function mergeEnhancementHistory(rows) {
    const ordered = rows.slice().sort((a, b) => enhancementStartTime(a) - enhancementStartTime(b));
    const merged = [];
    for (const raw of ordered) {
      const legacyInferredFinal = !raw.finalLevelSource;
      const row = {
        ...raw,
        observedMaxLevel: legacyInferredFinal ? raw.finalLevel : raw.observedMaxLevel,
        finalLevel: legacyInferredFinal ? null : raw.finalLevel,
        finalLevelSource: raw.finalLevelSource || "legacy_distribution_inferred",
        segments: raw.segments || [raw.key],
        chainCount: numeric(raw.chainCount, 1),
        correctedLinkCount: numeric(raw.correctedLinkCount)
      };
      let mergeIndex = -1;
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        const candidate = merged[index];
        if (enhancementGroupIdentity(candidate) !== enhancementGroupIdentity(row)) continue;
        if (canMergeEnhancementSegments(candidate, row)) {
          mergeIndex = index;
          break;
        }
        // 同角色、同物品、同目标只尝试衔接最近的一条未完成链；
        // 中间允许插入任意其他强化，且不限制间隔时间。
      }
      if (mergeIndex >= 0) merged[mergeIndex] = appendEnhancementSegment(merged[mergeIndex], row);
      else merged.push(row);
    }
    return merged.sort((a, b) => enhancementStartTime(a) - enhancementStartTime(b));
  }

  function formatCoins(value) {
    if (!Number.isFinite(Number(value))) return "—";
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Number(value));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  let cachedItemDetails = null;
  function itemName(itemHrid) {
    if (!cachedItemDetails) {
      try {
        const compressed = localStorage.getItem("initClientData");
        const parsed = compressed ? JSON.parse(LZString.decompressFromUTF16(compressed)) : null;
        cachedItemDetails = parsed?.itemDetailMap || {};
      } catch (_) {
        cachedItemDetails = {};
      }
    }
    const detail = cachedItemDetails[itemHrid];
    const english = detail?.name;
    return window.MwiGuildCreditChineseItems?.[english]
      || english
      || String(itemHrid).split("/").pop().replaceAll("_", " ");
  }

  function statusText(order) {
    const filled = numeric(order.filledQuantity);
    const total = numeric(order.orderQuantity);
    if (filled > 0 && filled < total && /active/.test(order.status)) return "部分成交";
    const labels = {
      "/market_listing_status/filled": "全部成交",
      "/market_listing_status/active": "进行中",
      "/market_listing_status/cancelled": filled > 0 ? "部分成交后取消" : "已取消",
      "/market_listing_status/expired": filled > 0 ? "部分成交后过期" : "已过期"
    };
    return labels[order.status] || order.status || "未知";
  }

  function confidenceText(value) {
    if (value === "server") return "准确";
    if (value === "estimated") return "估算";
    return "成本未知";
  }

  function createProfitPanel() {
    const panel = document.createElement("section");
    panel.id = "mwi-private-profit-panel";
    panel.innerHTML = `
      <style>
        #mwi-private-profit-panel{height:100%;overflow:auto;background:#202139;color:#eef0ff;padding:12px;font:13px system-ui,sans-serif;box-sizing:border-box}
        #mwi-private-profit-panel *{box-sizing:border-box}
        #mwi-private-profit-panel .mpl-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
        #mwi-private-profit-panel h3{margin:0;font-size:17px}.mpl-note{margin:8px 0;color:#b9bdd8;line-height:1.55}
        #mwi-private-profit-panel .mpl-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin:10px 0}
        #mwi-private-profit-panel .mpl-card{background:#292a46;border:1px solid #484a69;border-radius:6px;padding:9px}.mpl-card span{display:block;color:#b9bdd8;font-size:11px}.mpl-card strong{display:block;margin-top:4px;font-size:16px;color:#7be0bc}.mpl-card.warn strong{color:#ffd17c}
        #mwi-private-profit-panel .mpl-controls{display:flex;gap:7px;flex-wrap:wrap;margin:9px 0}#mwi-private-profit-panel input,#mwi-private-profit-panel select,#mwi-private-profit-panel button{min-height:30px;border:1px solid #686b91;border-radius:4px;padding:4px 8px;background:#f0f1ff;color:#202139;font:inherit}
        #mwi-private-profit-panel button{background:#43c4ad;border:0;font-weight:700;cursor:pointer}#mwi-private-profit-panel button.mpl-danger{background:#bd4b58;color:#fff}.mpl-table-wrap{overflow:auto;border:1px solid #484a69;border-radius:5px}
        #mwi-private-profit-panel table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:11px}#mwi-private-profit-panel th,#mwi-private-profit-panel td{padding:6px;border-bottom:1px solid #3d3f5b;text-align:right}#mwi-private-profit-panel th{position:sticky;top:0;background:#292a46;color:#cfd2eb}#mwi-private-profit-panel th:nth-child(-n+4),#mwi-private-profit-panel td:nth-child(-n+4){text-align:left}
        #mwi-private-profit-panel .mpl-exact{color:#7be0bc}.mpl-estimated{color:#ffd17c}.mpl-unknown{color:#ff8c92}
      </style>
      <div class="mpl-head"><h3>个人强化收益账本</h3><span><span data-role="ledger-status">等待强化记录…</span><button data-role="close" type="button" title="关闭" aria-label="关闭" style="margin-left:10px;font-size:18px;min-width:32px">×</button></span></div>
      <p class="mpl-note">主表只收录已确认结束且已入账的强化批次。掉落面板会标注“已入账 / 等待完成 / 未入账”。清空仅删除强化收益快照，不删除市场订单；随后可用当前可见的最近掉落记录重新生成。</p>
      <div class="mpl-cards">
        <div class="mpl-card"><span>强化批次数</span><strong data-role="batch-count">0</strong></div>
        <div class="mpl-card warn"><span>强化投入（冻结估值）</span><strong data-role="enhance-cost">0</strong></div>
        <div class="mpl-card"><span>未售批次估值收益</span><strong data-role="valuation-profit">0</strong></div>
        <div class="mpl-card"><span>成交匹配后收益（归属推定）</span><strong data-role="realized-enhance-profit">0</strong></div>
        <div class="mpl-card warn"><span>待补完整数据</span><strong data-role="incomplete-count">0</strong></div>
      </div>
      <div class="mpl-controls">
        <select data-role="period"><option value="0">全部时间</option><option value="1">今天</option><option value="7">近7天</option><option value="30">近30天</option></select>
        <select data-role="result"><option value="all">全部结果</option><option value="sold">已实际出售</option><option value="unsold">尚未出售</option><option value="profit">正收益</option><option value="loss">负收益</option><option value="incomplete">数据不完整</option></select>
        <select data-role="input-side"><option value="ask">投入按出售价购入</option><option value="bid">投入按收购价补货</option></select>
        <select data-role="output-side"><option value="bid">成品按收购价变现</option><option value="ask">成品按出售价挂牌</option></select>
        <input data-role="search" type="search" placeholder="物品名称 / HRID">
        <button data-role="refresh" type="button">刷新强化账本</button><button data-role="audit" type="button">强化账本自检</button><button data-role="copy-audit" type="button">复制校验报告</button><button data-role="csv" type="button">导出强化CSV</button><button data-role="clear-enhancement" class="mpl-danger" type="button">清空强化账本</button><details style="display:inline-block"><summary style="cursor:pointer">市场交易明细（辅助）</summary><div data-role="market-summary" class="mpl-note"></div></details>
      </div>
      <details data-role="audit-panel" style="margin:8px 0;background:#292a46;border:1px solid #484a69;border-radius:5px;padding:8px"><summary style="cursor:pointer;font-weight:700">校验说明与自检结果</summary><pre data-role="audit-output" style="white-space:pre-wrap;word-break:break-word;line-height:1.55;color:#d8daed;margin:8px 0 0">点击“账本自检”查看。</pre></details>
      <div class="mpl-table-wrap"><table><thead><tr><th>完成时间</th><th>强化批次</th><th>实际次数 / 耗时</th><th>起始装备</th><th>材料+保护</th><th>总投入</th><th>成品价值/实收</th><th>批次收益</th><th>时薪</th><th>口径</th></tr></thead><tbody data-role="rows"></tbody></table></div>`;

    for (const role of ["period", "result", "input-side", "output-side"]) panel.querySelector(`[data-role="${role}"]`).addEventListener("change", () => refreshProfitPanel(panel));
    panel.querySelector('[data-role="search"]').addEventListener("input", () => refreshProfitPanel(panel));
    panel.querySelector('[data-role="refresh"]').addEventListener("click", () => refreshProfitPanel(panel));
    panel.querySelector('[data-role="audit"]').addEventListener("click", () => runLedgerAudit(panel));
    panel.querySelector('[data-role="copy-audit"]').addEventListener("click", () => copyLedgerAudit(panel));
    panel.querySelector('[data-role="csv"]').addEventListener("click", exportEnhancementCsv);
    panel.querySelector('[data-role="clear-enhancement"]').addEventListener("click", () => clearEnhancementLedger(panel));
    panel.querySelector('[data-role="close"]').addEventListener("click", closeProfitDialog);
    return panel;
  }

  async function buildLedgerAuditReport() {
    await writeQueue;
    const [orders, fills] = await Promise.all([getAllRecords(ORDER_STORE), getAllRecords(EVENT_STORE)]);
    const history = loadEnhancementHistory();
    const tradeFills = fills.filter((row) => row.kind !== "claim");
    const replay = replayProfit(tradeFills, loadEnhancementLots());
    const keys = new Set();
    let duplicateBatches = 0;
    let incomplete = 0;
    for (const row of history) {
      if (keys.has(row.key)) duplicateBatches += 1;
      keys.add(row.key);
      if (!isCompleteEnhancement(row)) incomplete += 1;
    }
    const soldBatchKeys = new Set(replay.enhancementSaleLinks.map((row) => row.batchKey));
    const mergedChains = history.filter((row) => numeric(row.chainCount, 1) > 1);
    const exactSales = replay.enhancementSaleLinks.filter((row) => row.revenueConfidence === "server").length;
    const estimatedSales = replay.enhancementSaleLinks.length - exactSales;
    const verdict = duplicateBatches === 0 && incomplete === 0 ? "通过" : "有项目需要留意";
    return [
      `MWI个人强化收益账本自检：${verdict}`,
      `生成时间：${new Date().toLocaleString()}`,
      `强化链：${history.length}；其中停止后重开合并：${mergedChains.length}条（共${mergedChains.reduce((sum, row) => sum + numeric(row.chainCount), 0)}段）；重复批次键：${duplicateBatches}；数据不完整：${incomplete}`,
      `已匹配出售的强化批次：${soldBatchKeys.size}；服务器回款可核对：${exactSales}；限价估算回款：${estimatedSales}`,
      `辅助市场订单：${orders.length}；成交增量：${tradeFills.length}`,
      "",
      "核对方法：",
      "1. 完成一批强化后，强化链应只增加1；同一掉落记录重复刷新不会重复保存。同角色、同物品的失败链会尝试衔接；旧记录角色为unknown时可由新段补全。旧版曾用等级分布误判终点的记录，会用下一段明确起始等级回填。允许中间插入其他强化且不限制间隔时间。",
      "2. 实际次数、保护次数、起止等级和耗时来自该次强化结果；金额使用该记录完成时冻结的价格，不会被以后行情改写。",
      "3. 尚未出售显示“估值收益”；追踪到同物品同强化等级实际售出后显示成交匹配。市场订单没有装备唯一编号，因此批次归属按FIFO推定。",
      "4. 若买入原装备或材料的真实成交价无法由服务器确认，必须标为市场估值，不能显示成精确现金成本。",
      "",
      "批次收益 = 成品税后价值（或实际回款） - 起始装备成本 - 实际强化次数对应材料成本 - 实际保护消耗；时薪 = 批次收益 ÷ 实际耗时。"
    ].join("\n");
  }

  async function runLedgerAudit(panel = profitUi.panel) {
    if (!panel?.isConnected) return;
    const output = panel.querySelector('[data-role="audit-output"]');
    const details = panel.querySelector('[data-role="audit-panel"]');
    output.textContent = "正在检查强化批次与对应成交…";
    details.open = true;
    output.textContent = await buildLedgerAuditReport();
  }

  async function copyLedgerAudit(panel = profitUi.panel) {
    const report = await buildLedgerAuditReport();
    try {
      await navigator.clipboard.writeText(report);
      if (panel?.isConnected) panel.querySelector('[data-role="ledger-status"]').textContent = "校验报告已复制";
    } catch (_) {
      if (panel?.isConnected) {
        panel.querySelector('[data-role="audit-panel"]').open = true;
        panel.querySelector('[data-role="audit-output"]').textContent = report;
      }
    }
  }

  function isCompleteEnhancement(row) {
    return Boolean(row?.key && row?.itemHrid && row.finalLevel !== null && row.finalLevel !== undefined && Number.isInteger(Number(row.finalLevel))
      && numeric(row.enhanceCount) > 0 && numeric(row.duration) > 0
      && numeric(row.startingItemCost) > 0 && numeric(row.totalCost) >= 0
      && numeric(row.revenue) > 0);
  }

  function enhancementRows(fills, inputSide = "ask", outputSide = "bid") {
    const replay = replayProfit(fills, loadEnhancementLots());
    const sales = new Map();
    for (const link of replay.enhancementSaleLinks) {
      const old = sales.get(link.batchKey) || { quantity: 0, revenue: 0, exact: true, soldAt: null };
      old.quantity += numeric(link.quantity);
      old.revenue += numeric(link.revenue);
      old.exact = old.exact && link.revenueConfidence === "server";
      if (!old.soldAt || String(link.soldAt) > String(old.soldAt)) old.soldAt = link.soldAt;
      sales.set(link.batchKey, old);
    }
    return loadEnhancementHistory().map((row) => {
      const sale = sales.get(row.key);
      const selectedNumber = (value, fallback) => value === null || value === undefined ? fallback : numeric(value, NaN);
      const capInput = inputSide === "bid" ? "Bid" : "Ask";
      const capOutput = outputSide === "ask" ? "Ask" : "Bid";
      const legacyInput = inputSide === "ask";
      const legacyOutput = outputSide === "bid";
      const startingItemCost = selectedNumber(row[`startingItem${capInput}`], legacyInput ? numeric(row.startingItemCost) : NaN);
      const materialCost = selectedNumber(row[`material${capInput}Cost`], legacyInput ? numeric(row.materialCost) : NaN);
      const protectionCost = selectedNumber(row[`protection${capInput}Cost`], legacyInput ? numeric(row.protectionCost) : NaN);
      const outputPrice = selectedNumber(row[`output${capOutput}Price`], legacyOutput ? numeric(row.bidPrice) : NaN);
      const complete = isCompleteEnhancement(row) && [startingItemCost, materialCost, protectionCost, outputPrice].every(Number.isFinite) && outputPrice > 0;
      const investment = complete ? startingItemCost + materialCost + protectionCost : NaN;
      const sold = numeric(sale?.quantity) >= 0.999;
      const proceeds = sold ? numeric(sale.revenue) : outputPrice * sellFactor(row.itemHrid);
      const profit = complete && proceeds > 0 ? proceeds - investment : null;
      const hourly = profit !== null && numeric(row.duration) > 0 ? profit / (numeric(row.duration) / 3600) : null;
      return { ...row, complete, investment, startingItemCostSelected: startingItemCost, materialCostSelected: materialCost, protectionCostSelected: protectionCost, inputSide, outputSide, sold, sale, proceeds, profit, hourly };
    });
  }

  async function refreshProfitPanel(panel = profitUi.panel) {
    if (!panel?.isConnected) return;
    const token = ++profitUi.refreshToken;
    const status = panel.querySelector('[data-role="ledger-status"]');
    status.textContent = "正在读取强化批次…";
    await writeQueue;
    const [orders, fills] = await Promise.all([getAllRecords(ORDER_STORE), getAllRecords(EVENT_STORE)]);
    if (token !== profitUi.refreshToken) return;
    const inputSide = panel.querySelector('[data-role="input-side"]').value;
    const outputSide = panel.querySelector('[data-role="output-side"]').value;
    const allRows = enhancementRows(fills, inputSide, outputSide);
    const days = numeric(panel.querySelector('[data-role="period"]').value);
    const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
    const result = panel.querySelector('[data-role="result"]').value;
    const query = panel.querySelector('[data-role="search"]').value.trim().toLowerCase();
    const visible = allRows.filter((row) => {
      const time = new Date(row.completedAt || row.archivedAt).getTime();
      if (cutoff && time < cutoff) return false;
      if (result === "sold" && !row.sold) return false;
      if (result === "unsold" && row.sold) return false;
      if (result === "profit" && !(row.profit !== null && row.profit >= 0)) return false;
      if (result === "loss" && !(row.profit !== null && row.profit < 0)) return false;
      if (result === "incomplete" && row.complete) return false;
      const name = String(row.itemName || itemName(row.itemHrid)).toLowerCase();
      return !query || name.includes(query) || String(row.itemHrid).toLowerCase().includes(query);
    }).sort((a, b) => String(b.completedAt || b.archivedAt).localeCompare(String(a.completedAt || a.archivedAt)));

    const scope = visible;
    const valuationProfit = scope.filter((row) => row.complete && !row.sold).reduce((sum, row) => sum + numeric(row.profit), 0);
    const realizedProfit = scope.filter((row) => row.complete && row.sold).reduce((sum, row) => sum + numeric(row.profit), 0);
    panel.querySelector('[data-role="batch-count"]').textContent = formatCoins(scope.length);
    panel.querySelector('[data-role="enhance-cost"]').textContent = formatCoins(scope.reduce((sum, row) => sum + numeric(row.investment), 0));
    panel.querySelector('[data-role="valuation-profit"]').textContent = formatCoins(valuationProfit);
    panel.querySelector('[data-role="realized-enhance-profit"]').textContent = formatCoins(realizedProfit);
    panel.querySelector('[data-role="incomplete-count"]').textContent = formatCoins(scope.filter((row) => !row.complete).length);
    panel.querySelector('[data-role="market-summary"]').textContent = `本地保存 ${orders.length} 笔个人市场订单、${fills.filter((row) => row.kind !== "claim").length} 次成交增量；仅用于成本和成品回款匹配。`;

    panel.querySelector('[data-role="rows"]').innerHTML = visible.slice(0, 500).map((row) => {
      const finishedAt = row.completedAt || row.archivedAt;
      const name = row.itemName || itemName(row.itemHrid);
      const priceBasis = `投入${row.inputSide === "ask" ? "出售价" : "收购价"} / 成品${row.outputSide === "ask" ? "出售价" : "收购价"}`;
      const basis = !row.complete ? `该口径价格不完整·${priceBasis}` : row.sold
        ? (row.sale?.exact ? "回款已确认·批次归属FIFO推定" : "回款按限价估算·批次归属FIFO推定")
        : `未实现估值·${priceBasis}`;
      const cls = !row.complete ? "unknown" : "estimated";
      const timeText = numeric(row.duration) > 0 ? `${formatCoins(row.duration)}秒` : "—";
      const outputText = row.sold ? formatCoins(row.proceeds) : `${formatCoins(row.proceeds)}（估值）`;
      const chainLabel = numeric(row.chainCount, 1) > 1 ? `（${formatCoins(row.chainCount)}段合并${numeric(row.correctedLinkCount) > 0 ? `，等级回填${formatCoins(row.correctedLinkCount)}次` : ""}）` : "";
      const finalLevelText = row.finalLevel === null || row.finalLevel === undefined ? "?" : formatCoins(row.finalLevel);
      const uncertainty = finalLevelText === "?" && Number.isInteger(Number(row.observedMaxLevel)) ? `（记录中最高曾到+${formatCoins(row.observedMaxLevel)}，非最终等级）` : "";
      return `<tr><td>${escapeHtml(new Date(finishedAt).toLocaleString())}</td><td title="${escapeHtml(row.itemHrid)}">${escapeHtml(name)} +${numeric(row.startLevel)} → +${finalLevelText}${uncertainty}${chainLabel}</td><td>${formatCoins(row.enhanceCount)}次 / ${timeText}</td><td class="mpl-estimated">${formatCoins(row.startingItemCostSelected)}</td><td class="mpl-estimated">${formatCoins(row.materialCostSelected)} + ${formatCoins(row.protectionCostSelected)}（${formatCoins(row.protectionCount)}次）</td><td class="mpl-estimated">${formatCoins(row.investment)}</td><td class="mpl-${cls}">${outputText}</td><td class="mpl-${cls}">${row.profit === null ? "—" : formatCoins(row.profit)}</td><td class="mpl-${cls}">${row.hourly === null ? "—" : formatCoins(row.hourly)}</td><td class="mpl-${cls}">${basis}</td></tr>`;
    }).join("") || '<tr><td colspan="10" style="text-align:center;color:#aaa">暂无已完成的强化批次；完成一次强化并打开掉落记录后会自动保存。</td></tr>';
    status.textContent = `本地保存 ${allRows.length} 个强化批次；当前筛选 ${visible.length} 个`;
  }

  function downloadFile(name, type, text) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportEnhancementCsv() {
    await writeQueue;
    const fills = await getAllRecords(EVENT_STORE);
    const rows = enhancementRows(fills, "ask", "bid");
    const columns = ["completedAt", "archivedAt", "characterId", "key", "itemHrid", "itemName", "startLevel", "finalLevel", "enhanceCount", "duration", "protectionCount", "startingItemCost", "materialCost", "protectionCost", "investment", "sold", "proceeds", "profit", "hourly"];
    const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [columns.join(","), ...rows.map((row) => columns.map((key) => quote(row[key])).join(","))].join("\r\n");
    downloadFile(`MWI-强化收益账本-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv;charset=utf-8", `\ufeff${csv}`);
  }

  async function clearEnhancementLedger(panel = profitUi.panel) {
    const accepted = window.confirm(
      "清空全部强化收益记录？\n\n这只删除本地的强化收益快照，不会删除市场订单、成交记录或游戏内数据。当前掉落列表中仍可匹配的已完成记录，会在重新扫描后重新入账。"
    );
    if (!accepted) return;
    localStorage.removeItem(ENHANCEMENT_HISTORY_KEY);
    if (panel?.isConnected) {
      panel.querySelector('[data-role="ledger-status"]').textContent = "强化账本已清空；正在重新扫描当前掉落记录";
      await refreshProfitPanel(panel);
    }
    // Let the visible recent loot rows refresh their state badges. Their data
    // is never used to recreate a completed batch without completion evidence.
    window.testEnhancementLootTracker?.();
  }

  async function exportLedgerJson() {
    const [orders, fills] = await Promise.all([getAllRecords(ORDER_STORE), getAllRecords(EVENT_STORE)]);
    downloadFile(`MWI-收益账本备份-${new Date().toISOString().slice(0, 10)}.json`, "application/json", JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), orders, fills }, null, 2));
  }

  async function importLedgerJson(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.version !== 1 || !Array.isArray(data.orders) || !Array.isArray(data.fills)) throw new Error("备份格式不正确");
      const db = await openLedgerDb();
      const tx = db.transaction([ORDER_STORE, EVENT_STORE], "readwrite");
      for (const row of data.orders) if (row?.key) tx.objectStore(ORDER_STORE).put(row);
      for (const row of data.fills) if (row?.id) tx.objectStore(EVENT_STORE).put(row);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      await refreshProfitPanel();
    } catch (error) {
      alert(`收益账本恢复失败：${error?.message || error}`);
    }
  }

  function closeProfitDialog() {
    profitUi.overlay?.remove();
    profitUi.dialog?.remove();
    profitUi.overlay = null;
    profitUi.dialog = null;
    profitUi.panel = null;
  }

  function openProfitDialog() {
    closeProfitDialog();
    const overlay = document.createElement("div");
    overlay.id = "mwi-private-profit-overlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.64);z-index:2147483645;";
    const dialog = document.createElement("div");
    dialog.id = "mwi-private-profit-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "个人强化收益账本");
    dialog.tabIndex = -1;
    dialog.style.cssText = "position:fixed;left:3vw;right:3vw;top:5vh;bottom:5vh;z-index:2147483646;border:1px solid #696d92;border-radius:9px;overflow:hidden;box-shadow:0 18px 70px rgba(0,0,0,.65);background:#202139;";
    const panel = createProfitPanel();
    dialog.append(panel);
    overlay.addEventListener("click", closeProfitDialog);
    dialog.addEventListener("click", (event) => event.stopPropagation());
    document.body.append(overlay, dialog);
    profitUi.overlay = overlay;
    profitUi.dialog = dialog;
    profitUi.panel = panel;
    dialog.focus();
    refreshProfitPanel(panel);
  }

  function ensureProfitLootButton() {
    if (profitUi.button?.isConnected && profitUi.button.closest(".LootLogPanel_lootLogPanel__2013X, [class*='LootLogPanel_lootLogPanel__']")) return;
    document.querySelector('[data-mwi-profit-tab="true"]')?.remove();
    document.querySelectorAll('[data-mwi-enhancement-profit-button="true"]').forEach((node) => node.remove());
    const lootPanel = document.querySelector(".LootLogPanel_lootLogPanel__2013X, [class*='LootLogPanel_lootLogPanel__']");
    if (!lootPanel) return;
    const refreshButton = lootPanel.querySelector("button.Button_button__1Fe9z, button[class*='Button_button__']");
    if (!refreshButton) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.mwiEnhancementProfitButton = "true";
    button.title = "查看强化收益历史";
    button.textContent = "强化收益";
    button.className = refreshButton.className;
    button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;white-space:nowrap;color:#ffd47a;";
    button.addEventListener("click", openProfitDialog);
    refreshButton.insertAdjacentElement("afterend", button);
    refreshButton.style.display = "inline-flex";
    refreshButton.style.flex = "0 0 auto";
    const buttonRow = refreshButton.parentElement;
    if (buttonRow) {
      buttonRow.style.display = "flex";
      buttonRow.style.flexDirection = "row";
      buttonRow.style.alignItems = "center";
      buttonRow.style.justifyContent = "flex-start";
      buttonRow.style.flexWrap = "nowrap";
      buttonRow.style.gap = "8px";
    }
    profitUi.button = button;
  }

  function scheduleProfitPanelRefresh() {
    if (profitUi.panel?.isConnected) {
      window.setTimeout(() => refreshProfitPanel(profitUi.panel), 50);
    }
  }

  function startProfitUi() {
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && profitUi.dialog?.isConnected) closeProfitDialog();
    }, true);
    profitUi.integrationTimer = window.setInterval(ensureProfitLootButton, 1500);
    window.setTimeout(ensureProfitLootButton, 800);
  }

  window.__MWI_PROFIT_LEDGER_DEBUG__ = {
    handleGameMessage,
    replayProfit,
    getAllRecords,
    waitForWrites: () => writeQueue,
    ensureProfitLootButton,
    openProfitDialog,
    mergeEnhancementHistory,
    refreshProfitPanel
  };
  installEarlyWebSocketLedger();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startProfitUi, { once: true });
  else startProfitUi();
})();

// ==UserScript==
// @name         Enhance Hourly Rate Show - 私人收购排行榜版
// @license      MIT
// @version      1.4.0-private
// @author       wangchyan（强化原版）/ 柆雨（信用原版）/ 私人合并优化版
// @description  强化工时、全市场强化排行榜、公会信用点性价比与神龛升级的一体化私人只读工具
// @match        https://*.milkywayidle.com/*
// @match        https://*.milkywayidlecn.com/*
// @grant        none
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js
// @namespace https://greasyfork.org/users/1565573
// @downloadURL none
// @updateURL none
// ==/UserScript==

(function () {
    "use strict";

    // 排行榜使用独立防重复标记。即使原版仍在运行，私人标签页也能加载。
    if (window.__ENHANCE_HOURLY_RATE_RANKING__) return;
    window.__ENHANCE_HOURLY_RATE_RANKING__ = true;
    const legacyHourlyRateAlreadyRunning = Boolean(window.__ENHANCE_HOURLY_RATE_SHOW__);
    if (!legacyHourlyRateAlreadyRunning) window.__ENHANCE_HOURLY_RATE_SHOW__ = true;

    // ═══════════════════════════════════════════════
    //  常量
    // ═══════════════════════════════════════════════
    const ENHANCE_ACTION_TYPE = "/action_types/enhancing";
    const ENHANCE_SKILL_HRID = "/skills/enhancing";
    const ENHANCE_ACTION_HRID = "/actions/enhancing/enhance";
    const NS_PER_HOUR = 3600e9;
    const MIN_TIME_COST_NS = 3e9;

    const DEFAULT_TEAS = [
      "/items/ultra_enhancing_tea",
      "/items/blessed_tea",
      "/items/wisdom_tea"
    ];

    // 中文名称来自用户提供的公会信用点脚本所附公开翻译映射。
    // 本地内置，排行榜渲染时不会为了翻译名称发送网络请求。
    const PRIVATE_ZH_ITEM_NAMES = Object.freeze({
      "Currencie": "货币",
      "Food": "食物",
      "Drink": "饮料",
      "Resource": "资源",
      "Consumable": "消耗品",
      "Ability Book": "技能书",
      "Equipment": "装备",
      "Tool": "工具",
      "Coin": "硬币",
      "Basic currency": "基础货币",
      "Task Token": "任务代币",
      "Cowbell": "牛铃",
      "Bag Of 10 Cowbells": "10牛铃包",
      "Milk": "牛奶",
      "mooo": "哞",
      "Verdant Milk": "翠绿牛奶",
      "moooo": "哞哞",
      "Azure Milk": "蔚蓝牛奶",
      "mooooo": "哞哞哞",
      "Burble Milk": "深紫牛奶",
      "moooooo": "哞哞哞哞",
      "Crimson Milk": "深红牛奶",
      "mooooooo": "哞哞哞哞哞",
      "Rainbow Milk": "彩虹牛奶",
      "moooooooo": "哞哞哞哞哞哞",
      "Holy Milk": "圣奶",
      "mooooooooo": "哞哞哞哞哞哞哞",
      "Cheese": "奶酪",
      "Verdant Cheese": "翠绿奶酪",
      "Azure Cheese": "蔚蓝奶酪",
      "Burble Cheese": "深紫奶酪",
      "Crimson Cheese": "深红奶酪",
      "Rainbow Cheese": "彩虹奶酪",
      "Holy Cheese": "圣奶酪",
      "Log": "原木",
      "Birch Log": "白桦原木",
      "Cedar Log": "雪松原木",
      "Purpleheart Log": "紫心原木",
      "Ginkgo Log": "银杏原木",
      "Redwood Log": "红木",
      "Arcane Log": "神秘原木",
      "Lumber": "木板",
      "Birch Lumber": "白桦木板",
      "Cedar Lumber": "雪松木板",
      "Purpleheart Lumber": "紫心木板",
      "Ginkgo Lumber": "银杏木板",
      "Redwood Lumber": "红木板",
      "Arcane Lumber": "神秘木板",
      "Rough Hide": "粗糙兽皮",
      "Reptile Hide": "爬行动物皮",
      "Gobo Hide": "哥布林皮",
      "Beast Hide": "野兽皮",
      "Umbral Hide": "暗影皮",
      "Rough Leather": "粗糙皮革",
      "Reptile Leather": "爬行动物皮革",
      "Gobo Leather": "哥布林皮革",
      "Beast Leather": "野兽皮革",
      "Umbral Leather": "暗影皮革",
      "Cotton": "棉花",
      "Flax": "亚麻",
      "Bamboo Branch": "竹子",
      "Cocoon": "茧",
      "Radiant Fiber": "光辉纤维",
      "Cotton Fabric": "棉花布料",
      "Linen Fabric": "亚麻布料",
      "Bamboo Fabric": "竹子布料",
      "Silk Fabric": "丝绸",
      "Radiant Fabric": "光辉布料",
      "Egg": "鸡蛋",
      "Wheat": "小麦",
      "Sugar": "糖",
      "Blueberry": "蓝莓",
      "Blackberry": "黑莓",
      "Strawberry": "草莓",
      "Mooberry": "月梅",
      "Marsberry": "火星梅",
      "Spaceberry": "太空梅",
      "Apple": "苹果",
      "Orange": "橙子",
      "Plum": "李子",
      "Peach": "桃子",
      "Dragon Fruit": "火龙果",
      "Star Fruit": "杨桃",
      "Arabica Coffee Bean": "小果咖啡豆",
      "Robusta Coffee Bean": "中果咖啡豆",
      "Liberica Coffee Bean": "大果咖啡豆",
      "Excelsa Coffee Bean": "高产咖啡豆",
      "Fieriosa Coffee Bean": "火山咖啡豆",
      "Spacia Coffee Bean": "太空咖啡豆",
      "Green Tea Leaf": "绿茶叶",
      "Black Tea Leaf": "黑茶叶",
      "Burble Tea Leaf": "紫茶叶",
      "Moolong Tea Leaf": "月亮茶叶",
      "Red Tea Leaf": "红茶叶",
      "Emp Tea Leaf": "虚空茶叶",
      "Snake Fang": "蛇牙",
      "Material used in smithing Snake Fang Dirk": "用于锻造蛇牙短剑的材料",
      "Shoebill Feather": "鲸头鹳羽毛",
      "Material used in tailoring Shoebill Shoes": "用于缝鲸头鹳鞋的材料",
      "Snail Shell": "蜗牛壳",
      "Crab Pincer": "蟹钳",
      "Material used in smithing Pincer Gloves": "用于锻造螯钳手套的材料",
      "Turtle Shell": "乌龟壳",
      "Marine Scale": "海洋鳞片",
      "Treant Bark": "树皮",
      "Material used in crafting Treant Shield": "用于制作树人盾的材料",
      "Centaur Hoof": "半人马蹄",
      "Material used in tailoring Centaur Boots": "用于缝半人马靴的材料",
      "Luna Wing": "月神翼",
      "Gobo Rag": "哥布林破布",
      "Goggles": "护目镜",
      "Material used in smithing Vision Helmet": "用于锻造视觉头盔的材料",
      "Magnifying Glass": "放大镜",
      "Eye Of The Watcher": "观察者之眼",
      "Icy Cloth": "冰霜布料",
      "Flaming Cloth": "燃烧的布料",
      "Sorcerer's Sole": "魔法师的鞋底",
      "Material used in tailoring Sorcerer Boots": "用于缝魔法师靴的材料",
      "Chrono Sphere": "时空球",
      "Frost Sphere": "冰霜球",
      "Material used in crafting Frost Staff": "用于制作霜之法杖的材料",
      "Panda Fluff": "熊猫绒",
      "Material used in smithing Panda Gloves": "用于锻造熊猫手套的材料",
      "Black Bear Fluff": "黑熊绒",
      "Material used in smithing Black Bear Shoes": "用于锻造黑熊鞋的材料",
      "Grizzly Bear Fluff": "灰熊绒",
      "Polar Bear Fluff": "北极熊绒",
      "Material used in smithing Polar Bear Shoes": "用于锻造北极熊鞋的材料",
      "Red Panda Fluff": "小熊猫绒",
      "Magnet": "磁铁",
      "Material used in smithing Magnetic Gloves": "用于锻造磁力手套的材料",
      "Stalactite Shard": "钟乳石碎片",
      "Living Granite": "活花岗岩",
      "Colossus Core": "巨像核心",
      "Vampire Fang": "吸血鬼牙",
      "Werewolf Claw": "狼爪",
      "Revenant Anima": "亡者之魂",
      "Soul Fragment": "灵魂碎片",
      "Infernal Ember": "地狱余烬",
      "Demonic Core": "恶魔核心",
      "Swamp Essence": "沼泽精华",
      "Aqua Essence": "海洋精华",
      "Jungle Essence": "丛林精华",
      "Gobo Essence": "哥布林精华",
      "Eyessence": "眼球精华",
      "Sorcerer Essence": "法师精华",
      "Bear Essence": "熊精华",
      "Golem Essence": "魔像精华",
      "Twilight Essence": "暮光之城精华",
      "Abyssal Essence": "地狱精华",
      "Star Fragment": "星星碎片",
      "Pearl": "珍珠",
      "Amber": "琥珀",
      "Garnet": "石榴石",
      "Jade": "翡翠",
      "Amethyst": "紫水晶",
      "Moonstone": "月亮石",
      "Crushed Pearl": "珍珠碎片",
      "Used to be a piece of pearl": "曾经是一颗珍珠",
      "Crushed Amber": "琥珀碎片",
      "Used to be a piece of amber": "曾经是一块琥珀",
      "Crushed Garnet": "石榴石碎片",
      "Used to be a piece of garnet": "曾经是一颗石榴石",
      "Crushed Jade": "翡翠碎片",
      "Used to be a piece of jade": "曾经是一块翡翠",
      "Crushed Amethyst": "紫水晶碎片",
      "Used to be a piece of amethyst": "曾经是一颗紫水晶",
      "Crushed Moonstone": "月亮石碎片",
      "Used to be a piece of moonstone": "曾经是一块月亮石",
      "Shard Of Protection": "保护碎片",
      "Mirror Of Protection": "保护之镜",
      "Donut": "甜甜圈",
      "Blueberry Donut": "蓝莓甜甜圈",
      "Blackberry Donut": "黑莓甜甜圈",
      "Strawberry Donut": "草莓甜甜圈",
      "Mooberry Donut": "月莓甜甜圈",
      "Marsberry Donut": "火星莓甜甜圈",
      "Spaceberry Donut": "太空莓甜甜圈",
      "Cupcake": "纸杯蛋糕",
      "Blueberry Cake": "蓝莓蛋糕",
      "Blackberry Cake": "黑莓蛋糕",
      "Strawberry Cake": "草莓蛋糕",
      "Mooberry Cake": "月莓蛋糕",
      "Marsberry Cake": "火星莓蛋糕",
      "Spaceberry Cake": "太空莓蛋糕",
      "Gummy": "软糖",
      "Apple Gummy": "苹果软糖",
      "Orange Gummy": "橙子软糖",
      "Plum Gummy": "李子软糖",
      "Peach Gummy": "桃子软糖",
      "Dragon Fruit Gummy": "火龙果软糖",
      "Star Fruit Gummy": "杨桃软糖",
      "Yogurt": "酸奶",
      "Apple Yogurt": "苹果酸奶",
      "Orange Yogurt": "橙子酸奶",
      "Plum Yogurt": "李子酸奶",
      "Peach Yogurt": "桃子酸奶",
      "Dragon Fruit Yogurt": "火龙果酸奶",
      "Star Fruit Yogurt": "杨桃酸奶",
      "Milking Tea": "挤奶茶",
      "Foraging Tea": "采集茶",
      "Woodcutting Tea": "伐木茶",
      "Cooking Tea": "烹饪茶",
      "Brewing Tea": "冲泡茶",
      "Enhancing Tea": "强化茶",
      "Cheesesmithing Tea": "奶酪锻造茶",
      "Crafting Tea": "制作茶",
      "Tailoring Tea": "裁缝茶",
      "Super Milking Tea": "超级挤奶茶",
      "Super Foraging Tea": "超级采集茶",
      "Super Woodcutting Tea": "超级伐木茶",
      "Super Cooking Tea": "超级烹饪茶",
      "Super Brewing Tea": "超级冲泡茶",
      "Super Enhancing Tea": "超级强化茶",
      "Super Cheesesmithing Tea": "超级奶酪锻造茶",
      "Super Crafting Tea": "超级制作茶",
      "Super Tailoring Tea": "超级裁缝茶",
      "Gathering Tea": "收集茶",
      "Gourmet Tea": "双倍茶",
      "Wisdom Tea": "经验茶",
      "Processing Tea": "加工茶",
      "Efficiency Tea": "效率茶",
      "Artisan Tea": "工匠茶",
      "Blessed Tea": "祝福茶",
      "Stamina Coffee": "体力咖啡",
      "Intelligence Coffee": "智力咖啡",
      "Defense Coffee": "防御咖啡",
      "Attack Coffee": "攻击咖啡",
      "Power Coffee": "力量咖啡",
      "Ranged Coffee": "远程咖啡",
      "Magic Coffee": "魔法咖啡",
      "Super Stamina Coffee": "超级体力咖啡",
      "Super Intelligence Coffee": "超级智力咖啡",
      "Super Defense Coffee": "超级防御咖啡",
      "Super Attack Coffee": "超级攻击咖啡",
      "Super Power Coffee": "超级力量咖啡",
      "Super Ranged Coffee": "超级远程咖啡",
      "Super Magic Coffee": "超级魔法咖啡",
      "Wisdom Coffee": "经验咖啡",
      "Lucky Coffee": "幸运咖啡",
      "Swiftness Coffee": "迅捷咖啡",
      "Channeling Coffee": "引导咖啡",
      "Critical Coffee": "暴击咖啡",
      "Poke": "戳",
      "Pokes the targeted enemy": "戳向目标敌人",
      "Pierce": "刺",
      "Pierces the targeted enemy": "刺穿目标敌人",
      "Puncture": "穿刺",
      "Scratch": "抓挠",
      "Scratches the targeted enemy": "抓伤目标敌人",
      "Cleave": "劈砍",
      "Cleaves all enemies": "劈砍所有敌人",
      "Maim": "重砍",
      "Smack": "锤击",
      "Smacks the targeted enemy": "猛击目标敌人",
      "Sweep": "横扫",
      "Performs a sweeping attack on all enemies": "对所有敌人进行横扫攻击",
      "Stunning Blow": "重锤",
      "Quick Shot": "快速射击",
      "Takes a quick shot at the targeted enemy": "对目标敌人进行快速射击",
      "Aqua Arrow": "流水箭",
      "Flame Arrow": "火焰箭",
      "Rain Of Arrows": "箭雨",
      "Shoots a rain of arrows on all enemies": "向所有敌人射出箭雨",
      "Silencing Shot": "沉默箭",
      "Steady Shot": "稳定射击",
      "Water Strike": "流水冲击",
      "Casts a water strike at the targeted enemy": "对目标敌人射出流水",
      "Ice Spear": "冰矛",
      "Casts an ice spear at the targeted enemy": "对目标敌人施放冰矛",
      "Frost Surge": "冰霜激涌",
      "Casts frost surge at all enemies": "对所有敌人施放冰霜激涌",
      "Entangle": "缠绕",
      "Entangles the targeted enemy": "缠绕目标敌人",
      "Toxic Pollen": "毒性花粉",
      "Casts toxic pollen at all enemies": "对所有敌人施放毒性花粉",
      "Nature's Veil": "自然面纱",
      "Fireball": "火球",
      "Casts a fireball at the targeted enemy": "对目标敌人施放火球",
      "Flame Blast": "火焰冲击",
      "Casts a flame blast at all enemies": "对所有敌人施放火焰冲击",
      "Firestorm": "火焰风暴",
      "Casts a firestorm at all enemies": "对所有敌人施放火焰风暴",
      "Minor Heal": "小治疗",
      "Casts minor heal on yourself": "对自己施放小治疗术",
      "Heal": "治疗",
      "Casts heal on yourself": "对自己施放治疗术",
      "Quick Aid": "快速援助",
      "Rejuvenate": "恢复活力",
      "Heals all allies": "治疗所有队友",
      "Taunt": "嘲讽",
      "Greatly increases threat rating": "大幅增加威胁等级",
      "Provoke": "挑衅",
      "Tremendously increases threat rating": "极大地增加威胁等级",
      "Toughness": "坚韧",
      "Elusiveness": "闪避",
      "Greatly increases evasion temporarily": "临时大幅增加闪避",
      "Precision": "精确",
      "Greatly increases accuracy temporarily": "临时大幅增加准确性",
      "Berserk": "狂暴",
      "Frenzy": "狂躁",
      "Greatly increases attack speed temporarily": "临时大幅增加攻击速度",
      "Elemental Affinity": "元素亲和",
      "Spike Shell": "尖刺壳",
      "Gains physical reflect power temporarily": "临时获得物理反射能力",
      "Vampirism": "吸血",
      "Gains lifesteal temporarily": "临时获得生命偷取",
      "Revive": "复活",
      "Revives a dead ally": "复活一个死亡的队友",
      "Insanity": "疯狂",
      "Invincible": "坚毅",
      "Fierce Aura": "物理光环",
      "Aqua Aura": "流水光环",
      "Sylvan Aura": "自然光环",
      "Flame Aura": "火焰光环",
      "Speed Aura": "速度光环",
      "Critical Aura": "暴击光环",
      "Increases critical rate for all allies": "增加所有队友的暴击率",
      "Gobo Stabber": "哥布林长剑",
      "Gobo Slasher": "哥布林关刀",
      "Gobo Smasher": "哥布林狼牙棒",
      "Spiked Bulwark": "尖刺盾",
      "Werewolf Slasher": "狼人关刀",
      "Gobo Shooter": "哥布林弹弓",
      "Vampiric Bow": "吸血弓",
      "Gobo Boomstick": "哥布林火枪",
      "Cheese Bulwark": "奶酪盾",
      "Verdant Bulwark": "翠绿盾",
      "Azure Bulwark": "蔚蓝盾",
      "Burble Bulwark": "深紫盾",
      "Crimson Bulwark": "深红盾",
      "Rainbow Bulwark": "彩虹盾",
      "Holy Bulwark": "神圣盾",
      "Wooden Bow": "木弓",
      "Birch Bow": "桦木弓",
      "Cedar Bow": "雪松弓",
      "Purpleheart Bow": "紫心弓",
      "Ginkgo Bow": "银杏弓",
      "Redwood Bow": "红木弓",
      "Arcane Bow": "神秘弓",
      "Stalactite Spear": "钟乳石长矛",
      "Granite Bludgeon": "花岗岩大棒",
      "Soul Hunter Crossbow": "灵魂猎手弩",
      "Frost Staff": "冰霜法杖",
      "Infernal Battlestaff": "炼狱法杖",
      "Cheese Sword": "奶酪剑",
      "Verdant Sword": "翠绿剑",
      "Azure Sword": "蔚蓝剑",
      "Burble Sword": "深紫剑",
      "Crimson Sword": "深红剑",
      "Rainbow Sword": "彩虹剑",
      "Holy Sword": "神圣剑",
      "Cheese Spear": "奶酪矛",
      "Verdant Spear": "翠绿矛",
      "Azure Spear": "蔚蓝矛",
      "Burble Spear": "深紫矛",
      "Crimson Spear": "深红矛",
      "Rainbow Spear": "彩虹矛",
      "Holy Spear": "神圣矛",
      "Cheese Mace": "奶酪狼牙棒",
      "Verdant Mace": "翠绿狼牙棒",
      "Azure Mace": "蔚蓝狼牙棒",
      "Burble Mace": "深紫狼牙棒",
      "Crimson Mace": "深红狼牙棒",
      "Rainbow Mace": "彩虹狼牙棒",
      "Holy Mace": "神圣狼牙棒",
      "Wooden Crossbow": "木弩",
      "Birch Crossbow": "桦木弩",
      "Cedar Crossbow": "雪松弩",
      "Purpleheart Crossbow": "紫心木弩",
      "Ginkgo Crossbow": "银杏弩",
      "Redwood Crossbow": "红木弩",
      "Arcane Crossbow": "神秘弩",
      "Wooden Water Staff": "木水法杖",
      "Birch Water Staff": "桦木水法杖",
      "Cedar Water Staff": "雪松水法杖",
      "Purpleheart Water Staff": "紫心木水法杖",
      "Ginkgo Water Staff": "银杏水法杖",
      "Redwood Water Staff": "红木水法杖",
      "Arcane Water Staff": "神秘水法杖",
      "Wooden Nature Staff": "木自然法杖",
      "Birch Nature Staff": "桦木自然法杖",
      "Cedar Nature Staff": "雪松自然法杖",
      "Purpleheart Nature Staff": "紫心木自然法杖",
      "Ginkgo Nature Staff": "银杏自然法杖",
      "Redwood Nature Staff": "红木自然法杖",
      "Arcane Nature Staff": "神秘自然法杖",
      "Wooden Fire Staff": "木火法杖",
      "Birch Fire Staff": "桦木火法杖",
      "Cedar Fire Staff": "雪松火法杖",
      "Purpleheart Fire Staff": "紫心木火法杖",
      "Ginkgo Fire Staff": "银杏火法杖",
      "Redwood Fire Staff": "红木火法杖",
      "Arcane Fire Staff": "神秘火法杖",
      "Eye Watch": "眼睛手表",
      "Snake Fang Dirk": "蛇牙短剑",
      "Vision Shield": "视觉盾",
      "Gobo Defender": "哥布林防御者",
      "Vampire Fang Dirk": "吸血鬼短剑",
      "Treant Shield": "树人盾",
      "Tome Of Healing": "治疗之书",
      "Tome Of The Elements": "元素之书",
      "Watchful Relic": "警戒遗物",
      "Cheese Buckler": "奶酪圆盾",
      "Verdant Buckler": "翠绿圆盾",
      "Azure Buckler": "蔚蓝圆盾",
      "Burble Buckler": "深紫圆盾",
      "Crimson Buckler": "深红圆盾",
      "Rainbow Buckler": "彩虹圆盾",
      "Holy Buckler": "神圣圆盾",
      "Wooden Shield": "木盾",
      "Birch Shield": "桦木盾",
      "Cedar Shield": "雪松盾",
      "Purpleheart Shield": "紫心木盾",
      "Ginkgo Shield": "银杏盾",
      "Redwood Shield": "红木盾",
      "Arcane Shield": "神秘盾",
      "Red Chef's Hat": "红色厨师帽",
      "Snail Shell Helmet": "蜗牛壳头盔",
      "Vision Helmet": "视觉头盔",
      "Fluffy Red Hat": "蓬松红帽子",
      "Cheese Helmet": "奶酪头盔",
      "Verdant Helmet": "翠绿头盔",
      "Azure Helmet": "蔚蓝头盔",
      "Burble Helmet": "深紫头盔",
      "Crimson Helmet": "深红头盔",
      "Rainbow Helmet": "彩虹头盔",
      "Holy Helmet": "神圣头盔",
      "Rough Hood": "粗糙兜帽",
      "Reptile Hood": "爬行动物兜帽",
      "Gobo Hood": "哥布林兜帽",
      "Beast Hood": "野兽兜帽",
      "Umbral Hood": "暗影兜帽",
      "Cotton Hat": "棉帽",
      "Linen Hat": "亚麻帽",
      "Bamboo Hat": "竹帽",
      "Silk Hat": "丝帽",
      "Radiant Hat": "光辉帽",
      "Gator Vest": "鳄鱼背心",
      "Turtle Shell Body": "龟壳板甲",
      "Colossus Plate Body": "巨像板甲",
      "Demonic Plate Body": "恶魔板甲",
      "Marine Tunic": "航海束腰",
      "Revenant Tunic": "亡灵外套",
      "Icy Robe Top": "冰霜长袍",
      "Flaming Robe Top": "燃烧长袍",
      "Luna Robe Top": "月亮长袍",
      "Cheese Plate Body": "奶酪板甲",
      "Verdant Plate Body": "翠绿板甲",
      "Azure Plate Body": "蔚蓝板甲",
      "Burble Plate Body": "深紫板甲",
      "Crimson Plate Body": "深红板甲",
      "Rainbow Plate Body": "彩虹板甲",
      "Holy Plate Body": "神圣板甲",
      "Rough Tunic": "粗糙束腰",
      "Reptile Tunic": "爬行动物束腰",
      "Gobo Tunic": "哥布林束腰",
      "Beast Tunic": "野兽束腰",
      "Umbral Tunic": "暗影束腰",
      "Cotton Robe Top": "棉布上衣",
      "Linen Robe Top": "亚麻上衣",
      "Bamboo Robe Top": "竹上衣",
      "Silk Robe Top": "丝绸上衣",
      "Radiant Robe Top": "光辉上衣",
      "Turtle Shell Legs": "龟壳护腿",
      "Colossus Plate Legs": "巨像板甲护腿",
      "Demonic Plate Legs": "恶魔板甲护腿",
      "Marine Chaps": "航海护腿",
      "Revenant Chaps": "亡灵护腿",
      "Icy Robe Bottoms": "冰霜下装",
      "Flaming Robe Bottoms": "燃烧下装",
      "Luna Robe Bottoms": "月亮下装",
      "Cheese Plate Legs": "奶酪板甲护腿",
      "Verdant Plate Legs": "翠绿板甲护腿",
      "Azure Plate Legs": "蔚蓝板甲护腿",
      "Burble Plate Legs": "深紫板甲护腿",
      "Crimson Plate Legs": "深红板甲护腿",
      "Rainbow Plate Legs": "彩虹板甲护腿",
      "Holy Plate Legs": "神圣板甲护腿",
      "Rough Chaps": "粗糙护腿",
      "Reptile Chaps": "爬行动物护腿",
      "Gobo Chaps": "哥布林护腿",
      "Beast Chaps": "野兽护腿",
      "Umbral Chaps": "暗影护腿",
      "Cotton Robe Bottoms": "棉长袍下装",
      "Linen Robe Bottoms": "亚麻长袍下装",
      "Bamboo Robe Bottoms": "竹长袍下装",
      "Silk Robe Bottoms": "丝长袍下装",
      "Radiant Robe Bottoms": "光辉长袍下装",
      "Enchanted Gloves": "附魔手套",
      "Pincer Gloves": "螯钳手套",
      "Panda Gloves": "熊猫手套",
      "Magnetic Gloves": "磁力手套",
      "Sighted Bracers": "瞄准护腕",
      "Chrono Gloves": "时空手套",
      "Cheese Gauntlets": "奶酪臂铠",
      "Verdant Gauntlets": "翠绿臂铠",
      "Azure Gauntlets": "蔚蓝臂铠",
      "Burble Gauntlets": "深紫臂铠",
      "Crimson Gauntlets": "深红臂铠",
      "Rainbow Gauntlets": "彩虹臂铠",
      "Holy Gauntlets": "神圣臂铠",
      "Rough Bracers": "粗糙护腕",
      "Reptile Bracers": "爬行动物护腕",
      "Gobo Bracers": "哥布林护腕",
      "Beast Bracers": "野兽护腕",
      "Umbral Bracers": "暗影护腕",
      "Cotton Gloves": "棉手套",
      "Linen Gloves": "亚麻手套",
      "Bamboo Gloves": "竹手套",
      "Silk Gloves": "丝手套",
      "Radiant Gloves": "光辉手套",
      "Collector's Boots": "收藏家靴",
      "Shoebill Shoes": "鲸头鹳鞋",
      "Black Bear Shoes": "黑熊鞋",
      "Grizzly Bear Shoes": "灰熊鞋",
      "Polar Bear Shoes": "北极熊鞋",
      "Centaur Boots": "半人马靴",
      "Sorcerer Boots": "巫师靴",
      "Cheese Boots": "奶酪靴",
      "Verdant Boots": "翠绿靴",
      "Azure Boots": "蔚蓝靴",
      "Burble Boots": "深紫靴",
      "Crimson Boots": "深红靴",
      "Rainbow Boots": "彩虹靴",
      "Holy Boots": "神圣靴",
      "Rough Boots": "粗糙靴",
      "Reptile Boots": "爬行动物靴",
      "Gobo Boots": "哥布林靴",
      "Beast Boots": "野兽靴",
      "Umbral Boots": "暗影靴",
      "Cotton Boots": "棉靴",
      "Linen Boots": "亚麻靴",
      "Bamboo Boots": "竹靴",
      "Silk Boots": "丝靴",
      "Radiant Boots": "光辉靴",
      "Necklace Of Efficiency": "效率项链",
      "Fighter Necklace": "战士项链",
      "Ranger Necklace": "游侠项链",
      "Wizard Necklace": "巫师项链",
      "Necklace Of Wisdom": "智慧项链",
      "Earrings Of Gathering": "采集耳环",
      "Earrings Of Armor": "护甲耳环",
      "Earrings Of Regeneration": "回复耳环",
      "Earrings Of Resistance": "抗性耳环",
      "Earrings Of Rare Find": "稀有发现耳环",
      "Ring Of Gathering": "采集戒指",
      "Ring Of Armor": "护甲戒指",
      "Ring Of Regeneration": "回复戒指",
      "Ring Of Resistance": "抗性戒指",
      "Ring Of Rare Find": "稀有发现戒指",
      "Small Pouch": "小袋子",
      "Medium Pouch": "中袋子",
      "Large Pouch": "大袋子",
      "Giant Pouch": "巨大袋子",
      "Cheese Brush": "奶酪刷子",
      "Verdant Brush": "翠绿刷子",
      "Azure Brush": "蔚蓝刷子",
      "Burble Brush": "深紫刷子",
      "Crimson Brush": "深红刷子",
      "Rainbow Brush": "彩虹刷子",
      "Holy Brush": "神圣刷子",
      "Cheese Shears": "奶酪剪刀",
      "Verdant Shears": "翠绿剪刀",
      "Azure Shears": "蔚蓝剪刀",
      "Burble Shears": "深紫剪刀",
      "Crimson Shears": "深红剪刀",
      "Rainbow Shears": "彩虹剪刀",
      "Holy Shears": "神圣剪刀",
      "Cheese Hatchet": "奶酪斧头",
      "Verdant Hatchet": "翠绿斧头",
      "Azure Hatchet": "蔚蓝斧头",
      "Burble Hatchet": "深紫斧头",
      "Crimson Hatchet": "深红斧头",
      "Holy Hatchet": "神圣斧头",
      "Rainbow Hatchet": "彩虹斧头",
      "Cheese Hammer": "奶酪锤",
      "Verdant Hammer": "翠绿锤",
      "Azure Hammer": "蔚蓝锤",
      "Burble Hammer": "深紫锤",
      "Crimson Hammer": "深红锤",
      "Rainbow Hammer": "彩虹锤",
      "Holy Hammer": "神圣锤",
      "Cheese Chisel": "奶酪凿子",
      "Verdant Chisel": "翠绿凿子",
      "Azure Chisel": "蔚蓝凿子",
      "Burble Chisel": "深紫凿子",
      "Crimson Chisel": "深红凿子",
      "Rainbow Chisel": "彩虹凿子",
      "Holy Chisel": "神圣凿子",
      "Cheese Spatula": "奶酪铲子",
      "Verdant Spatula": "翠绿铲子",
      "Azure Spatula": "蔚蓝铲子",
      "Burble Spatula": "深紫铲子",
      "Crimson Spatula": "深红铲子",
      "Rainbow Spatula": "彩虹铲子",
      "Holy Spatula": "神圣铲子",
      "Cheese Needle": "奶酪针",
      "Verdant Needle": "翠绿针",
      "Azure Needle": "蔚蓝针",
      "Burble Needle": "深紫针",
      "Crimson Needle": "深红针",
      "Rainbow Needle": "彩虹针",
      "Holy Needle": "神圣针",
      "Cheese Pot": "奶酪锅",
      "Verdant Pot": "翠绿锅",
      "Azure Pot": "蔚蓝锅",
      "Burble Pot": "深紫锅",
      "Crimson Pot": "深红锅",
      "Rainbow Pot": "彩虹锅",
      "Holy Pot": "神圣锅",
      "Cheese Enhancer": "奶酪强化器",
      "Verdant Enhancer": "翠绿强化器",
      "Azure Enhancer": "蔚蓝强化器",
      "Burble Enhancer": "深紫强化器",
      "Crimson Enhancer": "赤红强化器",
      "Rainbow Enhancer": "彩虹强化器",
      "Holy Enhancer": "神圣强化器",
      "Small Meteorite Cache": "小型陨石",
      "Medium Meteorite Cache": "中型陨石",
      "Large Meteorite Cache": "大型陨石",
      "Small Artisan's Crate": "工匠的小型箱子",
      "Medium Artisan's Crate": "工匠的中型箱子",
      "Large Artisan's Crate": "工匠的大型箱子",
      "Small Treasure Chest": "小型宝箱",
      "Medium Treasure Chest": "中型宝箱",
      "Large Treasure Chest": "大型宝箱",
      "Purple's Gift": "紫色的礼物"
    });

    // 合并后的信用榜复用同一份中文名称表，避免保存第二份大型映射。
    window.MwiGuildCreditChineseItems = window.MwiGuildCreditChineseItems || PRIVATE_ZH_ITEM_NAMES;

    // MWITools 当前版本的 HRID → 中文物品名映射，优先级高于历史英文名映射。
    const PRIVATE_ZH_ITEM_HRIDS = Object.freeze({
            "/items/coin": "\u91d1\u5e01",
            "/items/task_token": "\u4efb\u52a1\u4ee3\u5e01",
            "/items/labyrinth_token": "\u8ff7\u5bab\u4ee3\u5e01",
            "/items/chimerical_token": "\u5947\u5e7b\u4ee3\u5e01",
            "/items/sinister_token": "\u9634\u68ee\u4ee3\u5e01",
            "/items/enchanted_token": "\u79d8\u6cd5\u4ee3\u5e01",
            "/items/pirate_token": "\u6d77\u76d7\u4ee3\u5e01",
            "/items/guild_token": "\u516c\u4f1a\u4ee3\u5e01",
            "/items/green_guild_credit": "\u7eff\u8272\u516c\u4f1a\u4fe1\u7528\u70b9",
            "/items/brown_guild_credit": "\u68d5\u8272\u516c\u4f1a\u4fe1\u7528\u70b9",
            "/items/white_guild_credit": "\u767d\u8272\u516c\u4f1a\u4fe1\u7528\u70b9",
            "/items/blue_guild_credit": "\u84dd\u8272\u516c\u4f1a\u4fe1\u7528\u70b9",
            "/items/purple_guild_credit": "\u7d2b\u8272\u516c\u4f1a\u4fe1\u7528\u70b9",
            "/items/red_guild_credit": "\u7ea2\u8272\u516c\u4f1a\u4fe1\u7528\u70b9",
            "/items/silver_guild_credit": "\u94f6\u8272\u516c\u4f1a\u4fe1\u7528\u70b9",
            "/items/gold_guild_credit": "\u91d1\u8272\u516c\u4f1a\u4fe1\u7528\u70b9",
            "/items/cowbell": "\u725b\u94c3",
            "/items/bag_of_10_cowbells": "\u725b\u94c3\u888b (10\u4e2a)",
            "/items/purples_gift": "\u5c0f\u7d2b\u725b\u7684\u793c\u7269",
            "/items/small_meteorite_cache": "\u5c0f\u9668\u77f3\u8231",
            "/items/medium_meteorite_cache": "\u4e2d\u9668\u77f3\u8231",
            "/items/large_meteorite_cache": "\u5927\u9668\u77f3\u8231",
            "/items/small_artisans_crate": "\u5c0f\u5de5\u5320\u5323",
            "/items/medium_artisans_crate": "\u4e2d\u5de5\u5320\u5323",
            "/items/large_artisans_crate": "\u5927\u5de5\u5320\u5323",
            "/items/small_treasure_chest": "\u5c0f\u5b9d\u7bb1",
            "/items/medium_treasure_chest": "\u4e2d\u5b9d\u7bb1",
            "/items/large_treasure_chest": "\u5927\u5b9d\u7bb1",
            "/items/chimerical_chest": "\u5947\u5e7b\u5b9d\u7bb1",
            "/items/chimerical_refinement_chest": "\u5947\u5e7b\u7cbe\u70bc\u5b9d\u7bb1",
            "/items/sinister_chest": "\u9634\u68ee\u5b9d\u7bb1",
            "/items/sinister_refinement_chest": "\u9634\u68ee\u7cbe\u70bc\u5b9d\u7bb1",
            "/items/enchanted_chest": "\u79d8\u6cd5\u5b9d\u7bb1",
            "/items/enchanted_refinement_chest": "\u79d8\u6cd5\u7cbe\u70bc\u5b9d\u7bb1",
            "/items/pirate_chest": "\u6d77\u76d7\u5b9d\u7bb1",
            "/items/pirate_refinement_chest": "\u6d77\u76d7\u7cbe\u70bc\u5b9d\u7bb1",
            "/items/purdoras_box_skilling": "\u7d2b\u591a\u62c9\u4e4b\u76d2\uff08\u751f\u6d3b\uff09",
            "/items/purdoras_box_combat": "\u7d2b\u591a\u62c9\u4e4b\u76d2\uff08\u6218\u6597\uff09",
            "/items/labyrinth_refinement_chest": "\u8ff7\u5bab\u7cbe\u70bc\u5b9d\u7bb1",
            "/items/seal_of_gathering": "\u91c7\u96c6\u5377\u8f74",
            "/items/seal_of_gourmet": "\u7f8e\u98df\u5377\u8f74",
            "/items/seal_of_processing": "\u52a0\u5de5\u5377\u8f74",
            "/items/seal_of_efficiency": "\u6548\u7387\u5377\u8f74",
            "/items/seal_of_action_speed": "\u884c\u52a8\u901f\u5ea6\u5377\u8f74",
            "/items/seal_of_combat_drop": "\u6218\u6597\u6389\u843d\u5377\u8f74",
            "/items/seal_of_attack_speed": "\u653b\u51fb\u901f\u5ea6\u5377\u8f74",
            "/items/seal_of_cast_speed": "\u65bd\u6cd5\u901f\u5ea6\u5377\u8f74",
            "/items/seal_of_damage": "\u4f24\u5bb3\u5377\u8f74",
            "/items/seal_of_critical_rate": "\u66b4\u51fb\u7387\u5377\u8f74",
            "/items/seal_of_wisdom": "\u7ecf\u9a8c\u5377\u8f74",
            "/items/seal_of_rare_find": "\u7a00\u6709\u53d1\u73b0\u5377\u8f74",
            "/items/blue_key_fragment": "\u84dd\u8272\u94a5\u5319\u788e\u7247",
            "/items/green_key_fragment": "\u7eff\u8272\u94a5\u5319\u788e\u7247",
            "/items/purple_key_fragment": "\u7d2b\u8272\u94a5\u5319\u788e\u7247",
            "/items/white_key_fragment": "\u767d\u8272\u94a5\u5319\u788e\u7247",
            "/items/orange_key_fragment": "\u6a59\u8272\u94a5\u5319\u788e\u7247",
            "/items/brown_key_fragment": "\u68d5\u8272\u94a5\u5319\u788e\u7247",
            "/items/stone_key_fragment": "\u77f3\u5934\u94a5\u5319\u788e\u7247",
            "/items/dark_key_fragment": "\u9ed1\u6697\u94a5\u5319\u788e\u7247",
            "/items/burning_key_fragment": "\u71c3\u70e7\u94a5\u5319\u788e\u7247",
            "/items/chimerical_entry_key": "\u5947\u5e7b\u94a5\u5319",
            "/items/chimerical_chest_key": "\u5947\u5e7b\u5b9d\u7bb1\u94a5\u5319",
            "/items/sinister_entry_key": "\u9634\u68ee\u94a5\u5319",
            "/items/sinister_chest_key": "\u9634\u68ee\u5b9d\u7bb1\u94a5\u5319",
            "/items/enchanted_entry_key": "\u79d8\u6cd5\u94a5\u5319",
            "/items/enchanted_chest_key": "\u79d8\u6cd5\u5b9d\u7bb1\u94a5\u5319",
            "/items/pirate_entry_key": "\u6d77\u76d7\u94a5\u5319",
            "/items/pirate_chest_key": "\u6d77\u76d7\u5b9d\u7bb1\u94a5\u5319",
            "/items/donut": "\u751c\u751c\u5708",
            "/items/blueberry_donut": "\u84dd\u8393\u751c\u751c\u5708",
            "/items/blackberry_donut": "\u9ed1\u8393\u751c\u751c\u5708",
            "/items/strawberry_donut": "\u8349\u8393\u751c\u751c\u5708",
            "/items/mooberry_donut": "\u54de\u8393\u751c\u751c\u5708",
            "/items/marsberry_donut": "\u706b\u661f\u8393\u751c\u751c\u5708",
            "/items/spaceberry_donut": "\u592a\u7a7a\u8393\u751c\u751c\u5708",
            "/items/cupcake": "\u7eb8\u676f\u86cb\u7cd5",
            "/items/blueberry_cake": "\u84dd\u8393\u86cb\u7cd5",
            "/items/blackberry_cake": "\u9ed1\u8393\u86cb\u7cd5",
            "/items/strawberry_cake": "\u8349\u8393\u86cb\u7cd5",
            "/items/mooberry_cake": "\u54de\u8393\u86cb\u7cd5",
            "/items/marsberry_cake": "\u706b\u661f\u8393\u86cb\u7cd5",
            "/items/spaceberry_cake": "\u592a\u7a7a\u8393\u86cb\u7cd5",
            "/items/gummy": "\u8f6f\u7cd6",
            "/items/apple_gummy": "\u82f9\u679c\u8f6f\u7cd6",
            "/items/orange_gummy": "\u6a59\u5b50\u8f6f\u7cd6",
            "/items/plum_gummy": "\u674e\u5b50\u8f6f\u7cd6",
            "/items/peach_gummy": "\u6843\u5b50\u8f6f\u7cd6",
            "/items/dragon_fruit_gummy": "\u706b\u9f99\u679c\u8f6f\u7cd6",
            "/items/star_fruit_gummy": "\u6768\u6843\u8f6f\u7cd6",
            "/items/yogurt": "\u9178\u5976",
            "/items/apple_yogurt": "\u82f9\u679c\u9178\u5976",
            "/items/orange_yogurt": "\u6a59\u5b50\u9178\u5976",
            "/items/plum_yogurt": "\u674e\u5b50\u9178\u5976",
            "/items/peach_yogurt": "\u6843\u5b50\u9178\u5976",
            "/items/dragon_fruit_yogurt": "\u706b\u9f99\u679c\u9178\u5976",
            "/items/star_fruit_yogurt": "\u6768\u6843\u9178\u5976",
            "/items/milking_tea": "\u6324\u5976\u8336",
            "/items/foraging_tea": "\u91c7\u6458\u8336",
            "/items/woodcutting_tea": "\u4f10\u6728\u8336",
            "/items/cooking_tea": "\u70f9\u996a\u8336",
            "/items/brewing_tea": "\u51b2\u6ce1\u8336",
            "/items/alchemy_tea": "\u70bc\u91d1\u8336",
            "/items/enhancing_tea": "\u5f3a\u5316\u8336",
            "/items/cheesesmithing_tea": "\u5976\u916a\u953b\u9020\u8336",
            "/items/crafting_tea": "\u5236\u4f5c\u8336",
            "/items/tailoring_tea": "\u7f1d\u7eab\u8336",
            "/items/super_milking_tea": "\u8d85\u7ea7\u6324\u5976\u8336",
            "/items/super_foraging_tea": "\u8d85\u7ea7\u91c7\u6458\u8336",
            "/items/super_woodcutting_tea": "\u8d85\u7ea7\u4f10\u6728\u8336",
            "/items/super_cooking_tea": "\u8d85\u7ea7\u70f9\u996a\u8336",
            "/items/super_brewing_tea": "\u8d85\u7ea7\u51b2\u6ce1\u8336",
            "/items/super_alchemy_tea": "\u8d85\u7ea7\u70bc\u91d1\u8336",
            "/items/super_enhancing_tea": "\u8d85\u7ea7\u5f3a\u5316\u8336",
            "/items/super_cheesesmithing_tea": "\u8d85\u7ea7\u5976\u916a\u953b\u9020\u8336",
            "/items/super_crafting_tea": "\u8d85\u7ea7\u5236\u4f5c\u8336",
            "/items/super_tailoring_tea": "\u8d85\u7ea7\u7f1d\u7eab\u8336",
            "/items/ultra_milking_tea": "\u7a76\u6781\u6324\u5976\u8336",
            "/items/ultra_foraging_tea": "\u7a76\u6781\u91c7\u6458\u8336",
            "/items/ultra_woodcutting_tea": "\u7a76\u6781\u4f10\u6728\u8336",
            "/items/ultra_cooking_tea": "\u7a76\u6781\u70f9\u996a\u8336",
            "/items/ultra_brewing_tea": "\u7a76\u6781\u51b2\u6ce1\u8336",
            "/items/ultra_alchemy_tea": "\u7a76\u6781\u70bc\u91d1\u8336",
            "/items/ultra_enhancing_tea": "\u7a76\u6781\u5f3a\u5316\u8336",
            "/items/ultra_cheesesmithing_tea": "\u7a76\u6781\u5976\u916a\u953b\u9020\u8336",
            "/items/ultra_crafting_tea": "\u7a76\u6781\u5236\u4f5c\u8336",
            "/items/ultra_tailoring_tea": "\u7a76\u6781\u7f1d\u7eab\u8336",
            "/items/gathering_tea": "\u91c7\u96c6\u8336",
            "/items/gourmet_tea": "\u7f8e\u98df\u8336",
            "/items/wisdom_tea": "\u7ecf\u9a8c\u8336",
            "/items/processing_tea": "\u52a0\u5de5\u8336",
            "/items/efficiency_tea": "\u6548\u7387\u8336",
            "/items/artisan_tea": "\u5de5\u5320\u8336",
            "/items/catalytic_tea": "\u50ac\u5316\u8336",
            "/items/blessed_tea": "\u798f\u6c14\u8336",
            "/items/stamina_coffee": "\u8010\u529b\u5496\u5561",
            "/items/intelligence_coffee": "\u667a\u529b\u5496\u5561",
            "/items/defense_coffee": "\u9632\u5fa1\u5496\u5561",
            "/items/attack_coffee": "\u653b\u51fb\u5496\u5561",
            "/items/melee_coffee": "\u8fd1\u6218\u5496\u5561",
            "/items/ranged_coffee": "\u8fdc\u7a0b\u5496\u5561",
            "/items/magic_coffee": "\u9b54\u6cd5\u5496\u5561",
            "/items/super_stamina_coffee": "\u8d85\u7ea7\u8010\u529b\u5496\u5561",
            "/items/super_intelligence_coffee": "\u8d85\u7ea7\u667a\u529b\u5496\u5561",
            "/items/super_defense_coffee": "\u8d85\u7ea7\u9632\u5fa1\u5496\u5561",
            "/items/super_attack_coffee": "\u8d85\u7ea7\u653b\u51fb\u5496\u5561",
            "/items/super_melee_coffee": "\u8d85\u7ea7\u8fd1\u6218\u5496\u5561",
            "/items/super_ranged_coffee": "\u8d85\u7ea7\u8fdc\u7a0b\u5496\u5561",
            "/items/super_magic_coffee": "\u8d85\u7ea7\u9b54\u6cd5\u5496\u5561",
            "/items/ultra_stamina_coffee": "\u7a76\u6781\u8010\u529b\u5496\u5561",
            "/items/ultra_intelligence_coffee": "\u7a76\u6781\u667a\u529b\u5496\u5561",
            "/items/ultra_defense_coffee": "\u7a76\u6781\u9632\u5fa1\u5496\u5561",
            "/items/ultra_attack_coffee": "\u7a76\u6781\u653b\u51fb\u5496\u5561",
            "/items/ultra_melee_coffee": "\u7a76\u6781\u8fd1\u6218\u5496\u5561",
            "/items/ultra_ranged_coffee": "\u7a76\u6781\u8fdc\u7a0b\u5496\u5561",
            "/items/ultra_magic_coffee": "\u7a76\u6781\u9b54\u6cd5\u5496\u5561",
            "/items/wisdom_coffee": "\u7ecf\u9a8c\u5496\u5561",
            "/items/lucky_coffee": "\u5e78\u8fd0\u5496\u5561",
            "/items/swiftness_coffee": "\u8fc5\u6377\u5496\u5561",
            "/items/channeling_coffee": "\u541f\u5531\u5496\u5561",
            "/items/critical_coffee": "\u66b4\u51fb\u5496\u5561",
            "/items/poke": "\u7834\u80c6\u4e4b\u523a",
            "/items/impale": "\u900f\u9aa8\u4e4b\u523a",
            "/items/puncture": "\u7834\u7532\u4e4b\u523a",
            "/items/penetrating_strike": "\u8d2f\u5fc3\u4e4b\u523a",
            "/items/scratch": "\u722a\u5f71\u65a9",
            "/items/cleave": "\u5206\u88c2\u65a9",
            "/items/maim": "\u8840\u5203\u65a9",
            "/items/crippling_slash": "\u81f4\u6b8b\u65a9",
            "/items/smack": "\u91cd\u78be",
            "/items/sweep": "\u91cd\u626b",
            "/items/stunning_blow": "\u91cd\u9524",
            "/items/fracturing_impact": "\u788e\u88c2\u51b2\u51fb",
            "/items/shield_bash": "\u76fe\u51fb",
            "/items/quick_shot": "\u5feb\u901f\u5c04\u51fb",
            "/items/aqua_arrow": "\u6d41\u6c34\u7bad",
            "/items/flame_arrow": "\u70c8\u7130\u7bad",
            "/items/rain_of_arrows": "\u7bad\u96e8",
            "/items/silencing_shot": "\u6c89\u9ed8\u4e4b\u7bad",
            "/items/steady_shot": "\u7a33\u5b9a\u5c04\u51fb",
            "/items/pestilent_shot": "\u75ab\u75c5\u5c04\u51fb",
            "/items/penetrating_shot": "\u8d2f\u7a7f\u5c04\u51fb",
            "/items/water_strike": "\u6d41\u6c34\u51b2\u51fb",
            "/items/ice_spear": "\u51b0\u67aa\u672f",
            "/items/frost_surge": "\u51b0\u971c\u7206\u88c2",
            "/items/mana_spring": "\u6cd5\u529b\u55b7\u6cc9",
            "/items/entangle": "\u7f20\u7ed5",
            "/items/toxic_pollen": "\u5267\u6bd2\u7c89\u5c18",
            "/items/natures_veil": "\u81ea\u7136\u83cc\u5e55",
            "/items/life_drain": "\u751f\u547d\u5438\u53d6",
            "/items/fireball": "\u706b\u7403",
            "/items/flame_blast": "\u7194\u5ca9\u7206\u88c2",
            "/items/firestorm": "\u706b\u7130\u98ce\u66b4",
            "/items/smoke_burst": "\u70df\u7206\u706d\u5f71",
            "/items/minor_heal": "\u521d\u7ea7\u81ea\u6108\u672f",
            "/items/heal": "\u81ea\u6108\u672f",
            "/items/quick_aid": "\u5feb\u901f\u6cbb\u7597\u672f",
            "/items/rejuvenate": "\u7fa4\u4f53\u6cbb\u7597\u672f",
            "/items/taunt": "\u5632\u8bbd",
            "/items/provoke": "\u6311\u8845",
            "/items/toughness": "\u575a\u97e7",
            "/items/elusiveness": "\u95ea\u907f",
            "/items/precision": "\u7cbe\u786e",
            "/items/berserk": "\u72c2\u66b4",
            "/items/elemental_affinity": "\u5143\u7d20\u589e\u5e45",
            "/items/frenzy": "\u72c2\u901f",
            "/items/spike_shell": "\u5c16\u523a\u9632\u62a4",
            "/items/retribution": "\u60e9\u6212",
            "/items/vampirism": "\u5438\u8840",
            "/items/revive": "\u590d\u6d3b",
            "/items/insanity": "\u75af\u72c2",
            "/items/invincible": "\u65e0\u654c",
            "/items/speed_aura": "\u901f\u5ea6\u5149\u73af",
            "/items/guardian_aura": "\u5b88\u62a4\u5149\u73af",
            "/items/fierce_aura": "\u7269\u7406\u5149\u73af",
            "/items/critical_aura": "\u66b4\u51fb\u5149\u73af",
            "/items/mystic_aura": "\u5143\u7d20\u5149\u73af",
            "/items/gobo_stabber": "\u54e5\u5e03\u6797\u957f\u5251",
            "/items/gobo_slasher": "\u54e5\u5e03\u6797\u5173\u5200",
            "/items/gobo_smasher": "\u54e5\u5e03\u6797\u72fc\u7259\u68d2",
            "/items/spiked_bulwark": "\u5c16\u523a\u91cd\u76fe",
            "/items/werewolf_slasher": "\u72fc\u4eba\u5173\u5200",
            "/items/griffin_bulwark": "\u72ee\u9e6b\u91cd\u76fe",
            "/items/griffin_bulwark_refined": "\u72ee\u9e6b\u91cd\u76fe \u2605",
            "/items/gobo_shooter": "\u54e5\u5e03\u6797\u5f39\u5f13",
            "/items/vampiric_bow": "\u5438\u8840\u5f13",
            "/items/cursed_bow": "\u5492\u6028\u4e4b\u5f13",
            "/items/cursed_bow_refined": "\u5492\u6028\u4e4b\u5f13 \u2605",
            "/items/gobo_boomstick": "\u54e5\u5e03\u6797\u706b\u68cd",
            "/items/cheese_bulwark": "\u5976\u916a\u91cd\u76fe",
            "/items/verdant_bulwark": "\u7fe0\u7eff\u91cd\u76fe",
            "/items/azure_bulwark": "\u851a\u84dd\u91cd\u76fe",
            "/items/burble_bulwark": "\u6df1\u7d2b\u91cd\u76fe",
            "/items/crimson_bulwark": "\u7edb\u7ea2\u91cd\u76fe",
            "/items/rainbow_bulwark": "\u5f69\u8679\u91cd\u76fe",
            "/items/holy_bulwark": "\u795e\u5723\u91cd\u76fe",
            "/items/wooden_bow": "\u6728\u5f13",
            "/items/birch_bow": "\u6866\u6728\u5f13",
            "/items/cedar_bow": "\u96ea\u677e\u5f13",
            "/items/purpleheart_bow": "\u7d2b\u5fc3\u5f13",
            "/items/ginkgo_bow": "\u94f6\u674f\u5f13",
            "/items/redwood_bow": "\u7ea2\u6749\u5f13",
            "/items/arcane_bow": "\u795e\u79d8\u5f13",
            "/items/stalactite_spear": "\u77f3\u949f\u957f\u67aa",
            "/items/granite_bludgeon": "\u82b1\u5c97\u5ca9\u5927\u68d2",
            "/items/furious_spear": "\u72c2\u6012\u957f\u67aa",
            "/items/furious_spear_refined": "\u72c2\u6012\u957f\u67aa \u2605",
            "/items/regal_sword": "\u541b\u738b\u4e4b\u5251",
            "/items/regal_sword_refined": "\u541b\u738b\u4e4b\u5251 \u2605",
            "/items/chaotic_flail": "\u6df7\u6c8c\u8fde\u67b7",
            "/items/chaotic_flail_refined": "\u6df7\u6c8c\u8fde\u67b7 \u2605",
            "/items/soul_hunter_crossbow": "\u7075\u9b42\u730e\u624b\u5f29",
            "/items/sundering_crossbow": "\u88c2\u7a7a\u4e4b\u5f29",
            "/items/sundering_crossbow_refined": "\u88c2\u7a7a\u4e4b\u5f29 \u2605",
            "/items/frost_staff": "\u51b0\u971c\u6cd5\u6756",
            "/items/infernal_battlestaff": "\u70bc\u72f1\u6cd5\u6756",
            "/items/jackalope_staff": "\u9e7f\u89d2\u5154\u4e4b\u6756",
            "/items/rippling_trident": "\u6d9f\u6f2a\u4e09\u53c9\u621f",
            "/items/rippling_trident_refined": "\u6d9f\u6f2a\u4e09\u53c9\u621f \u2605",
            "/items/blooming_trident": "\u7efd\u653e\u4e09\u53c9\u621f",
            "/items/blooming_trident_refined": "\u7efd\u653e\u4e09\u53c9\u621f \u2605",
            "/items/blazing_trident": "\u70bd\u7130\u4e09\u53c9\u621f",
            "/items/blazing_trident_refined": "\u70bd\u7130\u4e09\u53c9\u621f \u2605",
            "/items/cheese_sword": "\u5976\u916a\u5251",
            "/items/verdant_sword": "\u7fe0\u7eff\u5251",
            "/items/azure_sword": "\u851a\u84dd\u5251",
            "/items/burble_sword": "\u6df1\u7d2b\u5251",
            "/items/crimson_sword": "\u7edb\u7ea2\u5251",
            "/items/rainbow_sword": "\u5f69\u8679\u5251",
            "/items/holy_sword": "\u795e\u5723\u5251",
            "/items/cheese_spear": "\u5976\u916a\u957f\u67aa",
            "/items/verdant_spear": "\u7fe0\u7eff\u957f\u67aa",
            "/items/azure_spear": "\u851a\u84dd\u957f\u67aa",
            "/items/burble_spear": "\u6df1\u7d2b\u957f\u67aa",
            "/items/crimson_spear": "\u7edb\u7ea2\u957f\u67aa",
            "/items/rainbow_spear": "\u5f69\u8679\u957f\u67aa",
            "/items/holy_spear": "\u795e\u5723\u957f\u67aa",
            "/items/cheese_mace": "\u5976\u916a\u9489\u5934\u9524",
            "/items/verdant_mace": "\u7fe0\u7eff\u9489\u5934\u9524",
            "/items/azure_mace": "\u851a\u84dd\u9489\u5934\u9524",
            "/items/burble_mace": "\u6df1\u7d2b\u9489\u5934\u9524",
            "/items/crimson_mace": "\u7edb\u7ea2\u9489\u5934\u9524",
            "/items/rainbow_mace": "\u5f69\u8679\u9489\u5934\u9524",
            "/items/holy_mace": "\u795e\u5723\u9489\u5934\u9524",
            "/items/wooden_crossbow": "\u6728\u5f29",
            "/items/birch_crossbow": "\u6866\u6728\u5f29",
            "/items/cedar_crossbow": "\u96ea\u677e\u5f29",
            "/items/purpleheart_crossbow": "\u7d2b\u5fc3\u5f29",
            "/items/ginkgo_crossbow": "\u94f6\u674f\u5f29",
            "/items/redwood_crossbow": "\u7ea2\u6749\u5f29",
            "/items/arcane_crossbow": "\u795e\u79d8\u5f29",
            "/items/wooden_water_staff": "\u6728\u5236\u6c34\u6cd5\u6756",
            "/items/birch_water_staff": "\u6866\u6728\u6c34\u6cd5\u6756",
            "/items/cedar_water_staff": "\u96ea\u677e\u6c34\u6cd5\u6756",
            "/items/purpleheart_water_staff": "\u7d2b\u5fc3\u6c34\u6cd5\u6756",
            "/items/ginkgo_water_staff": "\u94f6\u674f\u6c34\u6cd5\u6756",
            "/items/redwood_water_staff": "\u7ea2\u6749\u6c34\u6cd5\u6756",
            "/items/arcane_water_staff": "\u795e\u79d8\u6c34\u6cd5\u6756",
            "/items/wooden_nature_staff": "\u6728\u5236\u81ea\u7136\u6cd5\u6756",
            "/items/birch_nature_staff": "\u6866\u6728\u81ea\u7136\u6cd5\u6756",
            "/items/cedar_nature_staff": "\u96ea\u677e\u81ea\u7136\u6cd5\u6756",
            "/items/purpleheart_nature_staff": "\u7d2b\u5fc3\u81ea\u7136\u6cd5\u6756",
            "/items/ginkgo_nature_staff": "\u94f6\u674f\u81ea\u7136\u6cd5\u6756",
            "/items/redwood_nature_staff": "\u7ea2\u6749\u81ea\u7136\u6cd5\u6756",
            "/items/arcane_nature_staff": "\u795e\u79d8\u81ea\u7136\u6cd5\u6756",
            "/items/wooden_fire_staff": "\u6728\u5236\u706b\u6cd5\u6756",
            "/items/birch_fire_staff": "\u6866\u6728\u706b\u6cd5\u6756",
            "/items/cedar_fire_staff": "\u96ea\u677e\u706b\u6cd5\u6756",
            "/items/purpleheart_fire_staff": "\u7d2b\u5fc3\u706b\u6cd5\u6756",
            "/items/ginkgo_fire_staff": "\u94f6\u674f\u706b\u6cd5\u6756",
            "/items/redwood_fire_staff": "\u7ea2\u6749\u706b\u6cd5\u6756",
            "/items/arcane_fire_staff": "\u795e\u79d8\u706b\u6cd5\u6756",
            "/items/eye_watch": "\u638c\u4e0a\u76d1\u5de5",
            "/items/snake_fang_dirk": "\u86c7\u7259\u77ed\u5251",
            "/items/vision_shield": "\u89c6\u89c9\u76fe",
            "/items/gobo_defender": "\u54e5\u5e03\u6797\u9632\u5fa1\u8005",
            "/items/vampire_fang_dirk": "\u5438\u8840\u9b3c\u77ed\u5251",
            "/items/knights_aegis": "\u9a91\u58eb\u76fe",
            "/items/knights_aegis_refined": "\u9a91\u58eb\u76fe \u2605",
            "/items/treant_shield": "\u6811\u4eba\u76fe",
            "/items/manticore_shield": "\u874e\u72ee\u76fe",
            "/items/tome_of_healing": "\u6cbb\u7597\u4e4b\u4e66",
            "/items/tome_of_the_elements": "\u5143\u7d20\u4e4b\u4e66",
            "/items/watchful_relic": "\u8b66\u6212\u9057\u7269",
            "/items/bishops_codex": "\u4e3b\u6559\u6cd5\u5178",
            "/items/bishops_codex_refined": "\u4e3b\u6559\u6cd5\u5178 \u2605",
            "/items/cheese_buckler": "\u5976\u916a\u5706\u76fe",
            "/items/verdant_buckler": "\u7fe0\u7eff\u5706\u76fe",
            "/items/azure_buckler": "\u851a\u84dd\u5706\u76fe",
            "/items/burble_buckler": "\u6df1\u7d2b\u5706\u76fe",
            "/items/crimson_buckler": "\u7edb\u7ea2\u5706\u76fe",
            "/items/rainbow_buckler": "\u5f69\u8679\u5706\u76fe",
            "/items/holy_buckler": "\u795e\u5723\u5706\u76fe",
            "/items/wooden_shield": "\u6728\u76fe",
            "/items/birch_shield": "\u6866\u6728\u76fe",
            "/items/cedar_shield": "\u96ea\u677e\u76fe",
            "/items/purpleheart_shield": "\u7d2b\u5fc3\u76fe",
            "/items/ginkgo_shield": "\u94f6\u674f\u76fe",
            "/items/redwood_shield": "\u7ea2\u6749\u76fe",
            "/items/arcane_shield": "\u795e\u79d8\u76fe",
            "/items/gatherer_cape": "\u91c7\u96c6\u8005\u62ab\u98ce",
            "/items/gatherer_cape_refined": "\u91c7\u96c6\u8005\u62ab\u98ce \u2605",
            "/items/artificer_cape": "\u5de5\u5320\u62ab\u98ce",
            "/items/artificer_cape_refined": "\u5de5\u5320\u62ab\u98ce \u2605",
            "/items/culinary_cape": "\u53a8\u5e08\u62ab\u98ce",
            "/items/culinary_cape_refined": "\u53a8\u5e08\u62ab\u98ce \u2605",
            "/items/chance_cape": "\u673a\u7f18\u62ab\u98ce",
            "/items/chance_cape_refined": "\u673a\u7f18\u62ab\u98ce \u2605",
            "/items/sinister_cape": "\u9634\u68ee\u62ab\u98ce",
            "/items/sinister_cape_refined": "\u9634\u68ee\u62ab\u98ce \u2605",
            "/items/chimerical_quiver": "\u5947\u5e7b\u7bad\u888b",
            "/items/chimerical_quiver_refined": "\u5947\u5e7b\u7bad\u888b \u2605",
            "/items/enchanted_cloak": "\u79d8\u6cd5\u62ab\u98ce",
            "/items/enchanted_cloak_refined": "\u79d8\u6cd5\u62ab\u98ce \u2605",
            "/items/red_culinary_hat": "\u7ea2\u8272\u53a8\u5e08\u5e3d",
            "/items/snail_shell_helmet": "\u8717\u725b\u58f3\u5934\u76d4",
            "/items/vision_helmet": "\u89c6\u89c9\u5934\u76d4",
            "/items/fluffy_red_hat": "\u84ec\u677e\u7ea2\u5e3d\u5b50",
            "/items/corsair_helmet": "\u63a0\u593a\u8005\u5934\u76d4",
            "/items/corsair_helmet_refined": "\u63a0\u593a\u8005\u5934\u76d4 \u2605",
            "/items/acrobatic_hood": "\u6742\u6280\u5e08\u515c\u5e3d",
            "/items/acrobatic_hood_refined": "\u6742\u6280\u5e08\u515c\u5e3d \u2605",
            "/items/magicians_hat": "\u9b54\u672f\u5e08\u5e3d",
            "/items/magicians_hat_refined": "\u9b54\u672f\u5e08\u5e3d \u2605",
            "/items/cheese_helmet": "\u5976\u916a\u5934\u76d4",
            "/items/verdant_helmet": "\u7fe0\u7eff\u5934\u76d4",
            "/items/azure_helmet": "\u851a\u84dd\u5934\u76d4",
            "/items/burble_helmet": "\u6df1\u7d2b\u5934\u76d4",
            "/items/crimson_helmet": "\u7edb\u7ea2\u5934\u76d4",
            "/items/rainbow_helmet": "\u5f69\u8679\u5934\u76d4",
            "/items/holy_helmet": "\u795e\u5723\u5934\u76d4",
            "/items/rough_hood": "\u7c97\u7cd9\u515c\u5e3d",
            "/items/reptile_hood": "\u722c\u884c\u52a8\u7269\u515c\u5e3d",
            "/items/gobo_hood": "\u54e5\u5e03\u6797\u515c\u5e3d",
            "/items/beast_hood": "\u91ce\u517d\u515c\u5e3d",
            "/items/umbral_hood": "\u6697\u5f71\u515c\u5e3d",
            "/items/cotton_hat": "\u68c9\u5e3d",
            "/items/linen_hat": "\u4e9a\u9ebb\u5e3d",
            "/items/bamboo_hat": "\u7af9\u5e3d",
            "/items/silk_hat": "\u4e1d\u5e3d",
            "/items/radiant_hat": "\u5149\u8f89\u5e3d",
            "/items/dairyhands_top": "\u6324\u5976\u5de5\u4e0a\u8863",
            "/items/foragers_top": "\u91c7\u6458\u8005\u4e0a\u8863",
            "/items/lumberjacks_top": "\u4f10\u6728\u5de5\u4e0a\u8863",
            "/items/cheesemakers_top": "\u5976\u916a\u5e08\u4e0a\u8863",
            "/items/crafters_top": "\u5de5\u5320\u4e0a\u8863",
            "/items/tailors_top": "\u88c1\u7f1d\u4e0a\u8863",
            "/items/chefs_top": "\u53a8\u5e08\u4e0a\u8863",
            "/items/brewers_top": "\u996e\u54c1\u5e08\u4e0a\u8863",
            "/items/alchemists_top": "\u70bc\u91d1\u5e08\u4e0a\u8863",
            "/items/enhancers_top": "\u5f3a\u5316\u5e08\u4e0a\u8863",
            "/items/gator_vest": "\u9cc4\u9c7c\u9a6c\u7532",
            "/items/turtle_shell_body": "\u9f9f\u58f3\u80f8\u7532",
            "/items/colossus_plate_body": "\u5de8\u50cf\u80f8\u7532",
            "/items/demonic_plate_body": "\u6076\u9b54\u80f8\u7532",
            "/items/anchorbound_plate_body": "\u951a\u5b9a\u80f8\u7532",
            "/items/anchorbound_plate_body_refined": "\u951a\u5b9a\u80f8\u7532 \u2605",
            "/items/maelstrom_plate_body": "\u6012\u6d9b\u80f8\u7532",
            "/items/maelstrom_plate_body_refined": "\u6012\u6d9b\u80f8\u7532 \u2605",
            "/items/marine_tunic": "\u6d77\u6d0b\u76ae\u8863",
            "/items/revenant_tunic": "\u4ea1\u7075\u76ae\u8863",
            "/items/griffin_tunic": "\u72ee\u9e6b\u76ae\u8863",
            "/items/kraken_tunic": "\u514b\u62c9\u80af\u76ae\u8863",
            "/items/kraken_tunic_refined": "\u514b\u62c9\u80af\u76ae\u8863 \u2605",
            "/items/icy_robe_top": "\u51b0\u971c\u888d\u670d",
            "/items/flaming_robe_top": "\u70c8\u7130\u888d\u670d",
            "/items/luna_robe_top": "\u6708\u795e\u888d\u670d",
            "/items/royal_water_robe_top": "\u7687\u5bb6\u6c34\u7cfb\u888d\u670d",
            "/items/royal_water_robe_top_refined": "\u7687\u5bb6\u6c34\u7cfb\u888d\u670d \u2605",
            "/items/royal_nature_robe_top": "\u7687\u5bb6\u81ea\u7136\u7cfb\u888d\u670d",
            "/items/royal_nature_robe_top_refined": "\u7687\u5bb6\u81ea\u7136\u7cfb\u888d\u670d \u2605",
            "/items/royal_fire_robe_top": "\u7687\u5bb6\u706b\u7cfb\u888d\u670d",
            "/items/royal_fire_robe_top_refined": "\u7687\u5bb6\u706b\u7cfb\u888d\u670d \u2605",
            "/items/cheese_plate_body": "\u5976\u916a\u80f8\u7532",
            "/items/verdant_plate_body": "\u7fe0\u7eff\u80f8\u7532",
            "/items/azure_plate_body": "\u851a\u84dd\u80f8\u7532",
            "/items/burble_plate_body": "\u6df1\u7d2b\u80f8\u7532",
            "/items/crimson_plate_body": "\u7edb\u7ea2\u80f8\u7532",
            "/items/rainbow_plate_body": "\u5f69\u8679\u80f8\u7532",
            "/items/holy_plate_body": "\u795e\u5723\u80f8\u7532",
            "/items/rough_tunic": "\u7c97\u7cd9\u76ae\u8863",
            "/items/reptile_tunic": "\u722c\u884c\u52a8\u7269\u76ae\u8863",
            "/items/gobo_tunic": "\u54e5\u5e03\u6797\u76ae\u8863",
            "/items/beast_tunic": "\u91ce\u517d\u76ae\u8863",
            "/items/umbral_tunic": "\u6697\u5f71\u76ae\u8863",
            "/items/cotton_robe_top": "\u68c9\u888d\u670d",
            "/items/linen_robe_top": "\u4e9a\u9ebb\u888d\u670d",
            "/items/bamboo_robe_top": "\u7af9\u888d\u670d",
            "/items/silk_robe_top": "\u4e1d\u7ef8\u888d\u670d",
            "/items/radiant_robe_top": "\u5149\u8f89\u888d\u670d",
            "/items/dairyhands_bottoms": "\u6324\u5976\u5de5\u4e0b\u88c5",
            "/items/foragers_bottoms": "\u91c7\u6458\u8005\u4e0b\u88c5",
            "/items/lumberjacks_bottoms": "\u4f10\u6728\u5de5\u4e0b\u88c5",
            "/items/cheesemakers_bottoms": "\u5976\u916a\u5e08\u4e0b\u88c5",
            "/items/crafters_bottoms": "\u5de5\u5320\u4e0b\u88c5",
            "/items/tailors_bottoms": "\u88c1\u7f1d\u4e0b\u88c5",
            "/items/chefs_bottoms": "\u53a8\u5e08\u4e0b\u88c5",
            "/items/brewers_bottoms": "\u996e\u54c1\u5e08\u4e0b\u88c5",
            "/items/alchemists_bottoms": "\u70bc\u91d1\u5e08\u4e0b\u88c5",
            "/items/enhancers_bottoms": "\u5f3a\u5316\u5e08\u4e0b\u88c5",
            "/items/turtle_shell_legs": "\u9f9f\u58f3\u817f\u7532",
            "/items/colossus_plate_legs": "\u5de8\u50cf\u817f\u7532",
            "/items/demonic_plate_legs": "\u6076\u9b54\u817f\u7532",
            "/items/anchorbound_plate_legs": "\u951a\u5b9a\u817f\u7532",
            "/items/anchorbound_plate_legs_refined": "\u951a\u5b9a\u817f\u7532 \u2605",
            "/items/maelstrom_plate_legs": "\u6012\u6d9b\u817f\u7532",
            "/items/maelstrom_plate_legs_refined": "\u6012\u6d9b\u817f\u7532 \u2605",
            "/items/marine_chaps": "\u822a\u6d77\u76ae\u88e4",
            "/items/revenant_chaps": "\u4ea1\u7075\u76ae\u88e4",
            "/items/griffin_chaps": "\u72ee\u9e6b\u76ae\u88e4",
            "/items/kraken_chaps": "\u514b\u62c9\u80af\u76ae\u88e4",
            "/items/kraken_chaps_refined": "\u514b\u62c9\u80af\u76ae\u88e4 \u2605",
            "/items/icy_robe_bottoms": "\u51b0\u971c\u888d\u88d9",
            "/items/flaming_robe_bottoms": "\u70c8\u7130\u888d\u88d9",
            "/items/luna_robe_bottoms": "\u6708\u795e\u888d\u88d9",
            "/items/royal_water_robe_bottoms": "\u7687\u5bb6\u6c34\u7cfb\u888d\u88d9",
            "/items/royal_water_robe_bottoms_refined": "\u7687\u5bb6\u6c34\u7cfb\u888d\u88d9 \u2605",
            "/items/royal_nature_robe_bottoms": "\u7687\u5bb6\u81ea\u7136\u7cfb\u888d\u88d9",
            "/items/royal_nature_robe_bottoms_refined": "\u7687\u5bb6\u81ea\u7136\u7cfb\u888d\u88d9 \u2605",
            "/items/royal_fire_robe_bottoms": "\u7687\u5bb6\u706b\u7cfb\u888d\u88d9",
            "/items/royal_fire_robe_bottoms_refined": "\u7687\u5bb6\u706b\u7cfb\u888d\u88d9 \u2605",
            "/items/cheese_plate_legs": "\u5976\u916a\u817f\u7532",
            "/items/verdant_plate_legs": "\u7fe0\u7eff\u817f\u7532",
            "/items/azure_plate_legs": "\u851a\u84dd\u817f\u7532",
            "/items/burble_plate_legs": "\u6df1\u7d2b\u817f\u7532",
            "/items/crimson_plate_legs": "\u7edb\u7ea2\u817f\u7532",
            "/items/rainbow_plate_legs": "\u5f69\u8679\u817f\u7532",
            "/items/holy_plate_legs": "\u795e\u5723\u817f\u7532",
            "/items/rough_chaps": "\u7c97\u7cd9\u76ae\u88e4",
            "/items/reptile_chaps": "\u722c\u884c\u52a8\u7269\u76ae\u88e4",
            "/items/gobo_chaps": "\u54e5\u5e03\u6797\u76ae\u88e4",
            "/items/beast_chaps": "\u91ce\u517d\u76ae\u88e4",
            "/items/umbral_chaps": "\u6697\u5f71\u76ae\u88e4",
            "/items/cotton_robe_bottoms": "\u68c9\u888d\u88d9",
            "/items/linen_robe_bottoms": "\u4e9a\u9ebb\u888d\u88d9",
            "/items/bamboo_robe_bottoms": "\u7af9\u888d\u88d9",
            "/items/silk_robe_bottoms": "\u4e1d\u7ef8\u888d\u88d9",
            "/items/radiant_robe_bottoms": "\u5149\u8f89\u888d\u88d9",
            "/items/enchanted_gloves": "\u9644\u9b54\u624b\u5957",
            "/items/pincer_gloves": "\u87f9\u94b3\u624b\u5957",
            "/items/panda_gloves": "\u718a\u732b\u624b\u5957",
            "/items/magnetic_gloves": "\u78c1\u529b\u624b\u5957",
            "/items/dodocamel_gauntlets": "\u6e21\u6e21\u9a7c\u62a4\u624b",
            "/items/dodocamel_gauntlets_refined": "\u6e21\u6e21\u9a7c\u62a4\u624b \u2605",
            "/items/sighted_bracers": "\u7784\u51c6\u62a4\u8155",
            "/items/marksman_bracers": "\u795e\u5c04\u62a4\u8155",
            "/items/marksman_bracers_refined": "\u795e\u5c04\u62a4\u8155 \u2605",
            "/items/chrono_gloves": "\u65f6\u7a7a\u624b\u5957",
            "/items/cheese_gauntlets": "\u5976\u916a\u62a4\u624b",
            "/items/verdant_gauntlets": "\u7fe0\u7eff\u62a4\u624b",
            "/items/azure_gauntlets": "\u851a\u84dd\u62a4\u624b",
            "/items/burble_gauntlets": "\u6df1\u7d2b\u62a4\u624b",
            "/items/crimson_gauntlets": "\u7edb\u7ea2\u62a4\u624b",
            "/items/rainbow_gauntlets": "\u5f69\u8679\u62a4\u624b",
            "/items/holy_gauntlets": "\u795e\u5723\u62a4\u624b",
            "/items/rough_bracers": "\u7c97\u7cd9\u62a4\u8155",
            "/items/reptile_bracers": "\u722c\u884c\u52a8\u7269\u62a4\u8155",
            "/items/gobo_bracers": "\u54e5\u5e03\u6797\u62a4\u8155",
            "/items/beast_bracers": "\u91ce\u517d\u62a4\u8155",
            "/items/umbral_bracers": "\u6697\u5f71\u62a4\u8155",
            "/items/cotton_gloves": "\u68c9\u624b\u5957",
            "/items/linen_gloves": "\u4e9a\u9ebb\u624b\u5957",
            "/items/bamboo_gloves": "\u7af9\u624b\u5957",
            "/items/silk_gloves": "\u4e1d\u624b\u5957",
            "/items/radiant_gloves": "\u5149\u8f89\u624b\u5957",
            "/items/collectors_boots": "\u6536\u85cf\u5bb6\u9774",
            "/items/shoebill_shoes": "\u9cb8\u5934\u9e73\u978b",
            "/items/black_bear_shoes": "\u9ed1\u718a\u978b",
            "/items/grizzly_bear_shoes": "\u68d5\u718a\u978b",
            "/items/polar_bear_shoes": "\u5317\u6781\u718a\u978b",
            "/items/pathbreaker_boots": "\u5f00\u8def\u8005\u9774",
            "/items/pathbreaker_boots_refined": "\u5f00\u8def\u8005\u9774 \u2605",
            "/items/centaur_boots": "\u534a\u4eba\u9a6c\u9774",
            "/items/pathfinder_boots": "\u63a2\u8def\u8005\u9774",
            "/items/pathfinder_boots_refined": "\u63a2\u8def\u8005\u9774 \u2605",
            "/items/sorcerer_boots": "\u5deb\u5e08\u9774",
            "/items/pathseeker_boots": "\u5bfb\u8def\u8005\u9774",
            "/items/pathseeker_boots_refined": "\u5bfb\u8def\u8005\u9774 \u2605",
            "/items/cheese_boots": "\u5976\u916a\u9774",
            "/items/verdant_boots": "\u7fe0\u7eff\u9774",
            "/items/azure_boots": "\u851a\u84dd\u9774",
            "/items/burble_boots": "\u6df1\u7d2b\u9774",
            "/items/crimson_boots": "\u7edb\u7ea2\u9774",
            "/items/rainbow_boots": "\u5f69\u8679\u9774",
            "/items/holy_boots": "\u795e\u5723\u9774",
            "/items/rough_boots": "\u7c97\u7cd9\u9774",
            "/items/reptile_boots": "\u722c\u884c\u52a8\u7269\u9774",
            "/items/gobo_boots": "\u54e5\u5e03\u6797\u9774",
            "/items/beast_boots": "\u91ce\u517d\u9774",
            "/items/umbral_boots": "\u6697\u5f71\u9774",
            "/items/cotton_boots": "\u68c9\u9774",
            "/items/linen_boots": "\u4e9a\u9ebb\u9774",
            "/items/bamboo_boots": "\u7af9\u9774",
            "/items/silk_boots": "\u4e1d\u9774",
            "/items/radiant_boots": "\u5149\u8f89\u9774",
            "/items/small_pouch": "\u5c0f\u888b\u5b50",
            "/items/medium_pouch": "\u4e2d\u888b\u5b50",
            "/items/large_pouch": "\u5927\u888b\u5b50",
            "/items/giant_pouch": "\u5de8\u5927\u888b\u5b50",
            "/items/gluttonous_pouch": "\u8d2a\u98df\u4e4b\u888b",
            "/items/guzzling_pouch": "\u66b4\u996e\u4e4b\u56ca",
            "/items/necklace_of_efficiency": "\u6548\u7387\u9879\u94fe",
            "/items/fighter_necklace": "\u6218\u58eb\u9879\u94fe",
            "/items/ranger_necklace": "\u5c04\u624b\u9879\u94fe",
            "/items/wizard_necklace": "\u5deb\u5e08\u9879\u94fe",
            "/items/necklace_of_wisdom": "\u7ecf\u9a8c\u9879\u94fe",
            "/items/necklace_of_speed": "\u901f\u5ea6\u9879\u94fe",
            "/items/philosophers_necklace": "\u8d24\u8005\u9879\u94fe",
            "/items/earrings_of_gathering": "\u91c7\u96c6\u8033\u73af",
            "/items/earrings_of_essence_find": "\u7cbe\u534e\u53d1\u73b0\u8033\u73af",
            "/items/earrings_of_armor": "\u62a4\u7532\u8033\u73af",
            "/items/earrings_of_regeneration": "\u6062\u590d\u8033\u73af",
            "/items/earrings_of_resistance": "\u6297\u6027\u8033\u73af",
            "/items/earrings_of_rare_find": "\u7a00\u6709\u53d1\u73b0\u8033\u73af",
            "/items/earrings_of_critical_strike": "\u66b4\u51fb\u8033\u73af",
            "/items/philosophers_earrings": "\u8d24\u8005\u8033\u73af",
            "/items/ring_of_gathering": "\u91c7\u96c6\u6212\u6307",
            "/items/ring_of_essence_find": "\u7cbe\u534e\u53d1\u73b0\u6212\u6307",
            "/items/ring_of_armor": "\u62a4\u7532\u6212\u6307",
            "/items/ring_of_regeneration": "\u6062\u590d\u6212\u6307",
            "/items/ring_of_resistance": "\u6297\u6027\u6212\u6307",
            "/items/ring_of_rare_find": "\u7a00\u6709\u53d1\u73b0\u6212\u6307",
            "/items/ring_of_critical_strike": "\u66b4\u51fb\u6212\u6307",
            "/items/philosophers_ring": "\u8d24\u8005\u6212\u6307",
            "/items/trainee_milking_charm": "\u5b9e\u4e60\u6324\u5976\u62a4\u7b26",
            "/items/basic_milking_charm": "\u57fa\u7840\u6324\u5976\u62a4\u7b26",
            "/items/advanced_milking_charm": "\u9ad8\u7ea7\u6324\u5976\u62a4\u7b26",
            "/items/expert_milking_charm": "\u4e13\u5bb6\u6324\u5976\u62a4\u7b26",
            "/items/master_milking_charm": "\u5927\u5e08\u6324\u5976\u62a4\u7b26",
            "/items/grandmaster_milking_charm": "\u5b97\u5e08\u6324\u5976\u62a4\u7b26",
            "/items/trainee_foraging_charm": "\u5b9e\u4e60\u91c7\u6458\u62a4\u7b26",
            "/items/basic_foraging_charm": "\u57fa\u7840\u91c7\u6458\u62a4\u7b26",
            "/items/advanced_foraging_charm": "\u9ad8\u7ea7\u91c7\u6458\u62a4\u7b26",
            "/items/expert_foraging_charm": "\u4e13\u5bb6\u91c7\u6458\u62a4\u7b26",
            "/items/master_foraging_charm": "\u5927\u5e08\u91c7\u6458\u62a4\u7b26",
            "/items/grandmaster_foraging_charm": "\u5b97\u5e08\u91c7\u6458\u62a4\u7b26",
            "/items/trainee_woodcutting_charm": "\u5b9e\u4e60\u4f10\u6728\u62a4\u7b26",
            "/items/basic_woodcutting_charm": "\u57fa\u7840\u4f10\u6728\u62a4\u7b26",
            "/items/advanced_woodcutting_charm": "\u9ad8\u7ea7\u4f10\u6728\u62a4\u7b26",
            "/items/expert_woodcutting_charm": "\u4e13\u5bb6\u4f10\u6728\u62a4\u7b26",
            "/items/master_woodcutting_charm": "\u5927\u5e08\u4f10\u6728\u62a4\u7b26",
            "/items/grandmaster_woodcutting_charm": "\u5b97\u5e08\u4f10\u6728\u62a4\u7b26",
            "/items/trainee_cheesesmithing_charm": "\u5b9e\u4e60\u5976\u916a\u953b\u9020\u62a4\u7b26",
            "/items/basic_cheesesmithing_charm": "\u57fa\u7840\u5976\u916a\u953b\u9020\u62a4\u7b26",
            "/items/advanced_cheesesmithing_charm": "\u9ad8\u7ea7\u5976\u916a\u953b\u9020\u62a4\u7b26",
            "/items/expert_cheesesmithing_charm": "\u4e13\u5bb6\u5976\u916a\u953b\u9020\u62a4\u7b26",
            "/items/master_cheesesmithing_charm": "\u5927\u5e08\u5976\u916a\u953b\u9020\u62a4\u7b26",
            "/items/grandmaster_cheesesmithing_charm": "\u5b97\u5e08\u5976\u916a\u953b\u9020\u62a4\u7b26",
            "/items/trainee_crafting_charm": "\u5b9e\u4e60\u5236\u4f5c\u62a4\u7b26",
            "/items/basic_crafting_charm": "\u57fa\u7840\u5236\u4f5c\u62a4\u7b26",
            "/items/advanced_crafting_charm": "\u9ad8\u7ea7\u5236\u4f5c\u62a4\u7b26",
            "/items/expert_crafting_charm": "\u4e13\u5bb6\u5236\u4f5c\u62a4\u7b26",
            "/items/master_crafting_charm": "\u5927\u5e08\u5236\u4f5c\u62a4\u7b26",
            "/items/grandmaster_crafting_charm": "\u5b97\u5e08\u5236\u4f5c\u62a4\u7b26",
            "/items/trainee_tailoring_charm": "\u5b9e\u4e60\u7f1d\u7eab\u62a4\u7b26",
            "/items/basic_tailoring_charm": "\u57fa\u7840\u7f1d\u7eab\u62a4\u7b26",
            "/items/advanced_tailoring_charm": "\u9ad8\u7ea7\u7f1d\u7eab\u62a4\u7b26",
            "/items/expert_tailoring_charm": "\u4e13\u5bb6\u7f1d\u7eab\u62a4\u7b26",
            "/items/master_tailoring_charm": "\u5927\u5e08\u7f1d\u7eab\u62a4\u7b26",
            "/items/grandmaster_tailoring_charm": "\u5b97\u5e08\u7f1d\u7eab\u62a4\u7b26",
            "/items/trainee_cooking_charm": "\u5b9e\u4e60\u70f9\u996a\u62a4\u7b26",
            "/items/basic_cooking_charm": "\u57fa\u7840\u70f9\u996a\u62a4\u7b26",
            "/items/advanced_cooking_charm": "\u9ad8\u7ea7\u70f9\u996a\u62a4\u7b26",
            "/items/expert_cooking_charm": "\u4e13\u5bb6\u70f9\u996a\u62a4\u7b26",
            "/items/master_cooking_charm": "\u5927\u5e08\u70f9\u996a\u62a4\u7b26",
            "/items/grandmaster_cooking_charm": "\u5b97\u5e08\u70f9\u996a\u62a4\u7b26",
            "/items/trainee_brewing_charm": "\u5b9e\u4e60\u51b2\u6ce1\u62a4\u7b26",
            "/items/basic_brewing_charm": "\u57fa\u7840\u51b2\u6ce1\u62a4\u7b26",
            "/items/advanced_brewing_charm": "\u9ad8\u7ea7\u51b2\u6ce1\u62a4\u7b26",
            "/items/expert_brewing_charm": "\u4e13\u5bb6\u51b2\u6ce1\u62a4\u7b26",
            "/items/master_brewing_charm": "\u5927\u5e08\u51b2\u6ce1\u62a4\u7b26",
            "/items/grandmaster_brewing_charm": "\u5b97\u5e08\u51b2\u6ce1\u62a4\u7b26",
            "/items/trainee_alchemy_charm": "\u5b9e\u4e60\u70bc\u91d1\u62a4\u7b26",
            "/items/basic_alchemy_charm": "\u57fa\u7840\u70bc\u91d1\u62a4\u7b26",
            "/items/advanced_alchemy_charm": "\u9ad8\u7ea7\u70bc\u91d1\u62a4\u7b26",
            "/items/expert_alchemy_charm": "\u4e13\u5bb6\u70bc\u91d1\u62a4\u7b26",
            "/items/master_alchemy_charm": "\u5927\u5e08\u70bc\u91d1\u62a4\u7b26",
            "/items/grandmaster_alchemy_charm": "\u5b97\u5e08\u70bc\u91d1\u62a4\u7b26",
            "/items/trainee_enhancing_charm": "\u5b9e\u4e60\u5f3a\u5316\u62a4\u7b26",
            "/items/basic_enhancing_charm": "\u57fa\u7840\u5f3a\u5316\u62a4\u7b26",
            "/items/advanced_enhancing_charm": "\u9ad8\u7ea7\u5f3a\u5316\u62a4\u7b26",
            "/items/expert_enhancing_charm": "\u4e13\u5bb6\u5f3a\u5316\u62a4\u7b26",
            "/items/master_enhancing_charm": "\u5927\u5e08\u5f3a\u5316\u62a4\u7b26",
            "/items/grandmaster_enhancing_charm": "\u5b97\u5e08\u5f3a\u5316\u62a4\u7b26",
            "/items/trainee_stamina_charm": "\u5b9e\u4e60\u8010\u529b\u62a4\u7b26",
            "/items/basic_stamina_charm": "\u57fa\u7840\u8010\u529b\u62a4\u7b26",
            "/items/advanced_stamina_charm": "\u9ad8\u7ea7\u8010\u529b\u62a4\u7b26",
            "/items/expert_stamina_charm": "\u4e13\u5bb6\u8010\u529b\u62a4\u7b26",
            "/items/master_stamina_charm": "\u5927\u5e08\u8010\u529b\u62a4\u7b26",
            "/items/grandmaster_stamina_charm": "\u5b97\u5e08\u8010\u529b\u62a4\u7b26",
            "/items/trainee_intelligence_charm": "\u5b9e\u4e60\u667a\u529b\u62a4\u7b26",
            "/items/basic_intelligence_charm": "\u57fa\u7840\u667a\u529b\u62a4\u7b26",
            "/items/advanced_intelligence_charm": "\u9ad8\u7ea7\u667a\u529b\u62a4\u7b26",
            "/items/expert_intelligence_charm": "\u4e13\u5bb6\u667a\u529b\u62a4\u7b26",
            "/items/master_intelligence_charm": "\u5927\u5e08\u667a\u529b\u62a4\u7b26",
            "/items/grandmaster_intelligence_charm": "\u5b97\u5e08\u667a\u529b\u62a4\u7b26",
            "/items/trainee_attack_charm": "\u5b9e\u4e60\u653b\u51fb\u62a4\u7b26",
            "/items/basic_attack_charm": "\u57fa\u7840\u653b\u51fb\u62a4\u7b26",
            "/items/advanced_attack_charm": "\u9ad8\u7ea7\u653b\u51fb\u62a4\u7b26",
            "/items/expert_attack_charm": "\u4e13\u5bb6\u653b\u51fb\u62a4\u7b26",
            "/items/master_attack_charm": "\u5927\u5e08\u653b\u51fb\u62a4\u7b26",
            "/items/grandmaster_attack_charm": "\u5b97\u5e08\u653b\u51fb\u62a4\u7b26",
            "/items/trainee_defense_charm": "\u5b9e\u4e60\u9632\u5fa1\u62a4\u7b26",
            "/items/basic_defense_charm": "\u57fa\u7840\u9632\u5fa1\u62a4\u7b26",
            "/items/advanced_defense_charm": "\u9ad8\u7ea7\u9632\u5fa1\u62a4\u7b26",
            "/items/expert_defense_charm": "\u4e13\u5bb6\u9632\u5fa1\u62a4\u7b26",
            "/items/master_defense_charm": "\u5927\u5e08\u9632\u5fa1\u62a4\u7b26",
            "/items/grandmaster_defense_charm": "\u5b97\u5e08\u9632\u5fa1\u62a4\u7b26",
            "/items/trainee_melee_charm": "\u5b9e\u4e60\u8fd1\u6218\u62a4\u7b26",
            "/items/basic_melee_charm": "\u57fa\u7840\u8fd1\u6218\u62a4\u7b26",
            "/items/advanced_melee_charm": "\u9ad8\u7ea7\u8fd1\u6218\u62a4\u7b26",
            "/items/expert_melee_charm": "\u4e13\u5bb6\u8fd1\u6218\u62a4\u7b26",
            "/items/master_melee_charm": "\u5927\u5e08\u8fd1\u6218\u62a4\u7b26",
            "/items/grandmaster_melee_charm": "\u5b97\u5e08\u8fd1\u6218\u62a4\u7b26",
            "/items/trainee_ranged_charm": "\u5b9e\u4e60\u8fdc\u7a0b\u62a4\u7b26",
            "/items/basic_ranged_charm": "\u57fa\u7840\u8fdc\u7a0b\u62a4\u7b26",
            "/items/advanced_ranged_charm": "\u9ad8\u7ea7\u8fdc\u7a0b\u62a4\u7b26",
            "/items/expert_ranged_charm": "\u4e13\u5bb6\u8fdc\u7a0b\u62a4\u7b26",
            "/items/master_ranged_charm": "\u5927\u5e08\u8fdc\u7a0b\u62a4\u7b26",
            "/items/grandmaster_ranged_charm": "\u5b97\u5e08\u8fdc\u7a0b\u62a4\u7b26",
            "/items/trainee_magic_charm": "\u5b9e\u4e60\u9b54\u6cd5\u62a4\u7b26",
            "/items/basic_magic_charm": "\u57fa\u7840\u9b54\u6cd5\u62a4\u7b26",
            "/items/advanced_magic_charm": "\u9ad8\u7ea7\u9b54\u6cd5\u62a4\u7b26",
            "/items/expert_magic_charm": "\u4e13\u5bb6\u9b54\u6cd5\u62a4\u7b26",
            "/items/master_magic_charm": "\u5927\u5e08\u9b54\u6cd5\u62a4\u7b26",
            "/items/grandmaster_magic_charm": "\u5b97\u5e08\u9b54\u6cd5\u62a4\u7b26",
            "/items/basic_task_badge": "\u57fa\u7840\u4efb\u52a1\u5fbd\u7ae0",
            "/items/advanced_task_badge": "\u9ad8\u7ea7\u4efb\u52a1\u5fbd\u7ae0",
            "/items/expert_task_badge": "\u4e13\u5bb6\u4efb\u52a1\u5fbd\u7ae0",
            "/items/celestial_brush": "\u661f\u7a7a\u5237\u5b50",
            "/items/cheese_brush": "\u5976\u916a\u5237\u5b50",
            "/items/verdant_brush": "\u7fe0\u7eff\u5237\u5b50",
            "/items/azure_brush": "\u851a\u84dd\u5237\u5b50",
            "/items/burble_brush": "\u6df1\u7d2b\u5237\u5b50",
            "/items/crimson_brush": "\u7edb\u7ea2\u5237\u5b50",
            "/items/rainbow_brush": "\u5f69\u8679\u5237\u5b50",
            "/items/holy_brush": "\u795e\u5723\u5237\u5b50",
            "/items/celestial_shears": "\u661f\u7a7a\u526a\u5200",
            "/items/cheese_shears": "\u5976\u916a\u526a\u5200",
            "/items/verdant_shears": "\u7fe0\u7eff\u526a\u5200",
            "/items/azure_shears": "\u851a\u84dd\u526a\u5200",
            "/items/burble_shears": "\u6df1\u7d2b\u526a\u5200",
            "/items/crimson_shears": "\u7edb\u7ea2\u526a\u5200",
            "/items/rainbow_shears": "\u5f69\u8679\u526a\u5200",
            "/items/holy_shears": "\u795e\u5723\u526a\u5200",
            "/items/celestial_hatchet": "\u661f\u7a7a\u65a7\u5934",
            "/items/cheese_hatchet": "\u5976\u916a\u65a7\u5934",
            "/items/verdant_hatchet": "\u7fe0\u7eff\u65a7\u5934",
            "/items/azure_hatchet": "\u851a\u84dd\u65a7\u5934",
            "/items/burble_hatchet": "\u6df1\u7d2b\u65a7\u5934",
            "/items/crimson_hatchet": "\u7edb\u7ea2\u65a7\u5934",
            "/items/rainbow_hatchet": "\u5f69\u8679\u65a7\u5934",
            "/items/holy_hatchet": "\u795e\u5723\u65a7\u5934",
            "/items/celestial_hammer": "\u661f\u7a7a\u9524\u5b50",
            "/items/cheese_hammer": "\u5976\u916a\u9524\u5b50",
            "/items/verdant_hammer": "\u7fe0\u7eff\u9524\u5b50",
            "/items/azure_hammer": "\u851a\u84dd\u9524\u5b50",
            "/items/burble_hammer": "\u6df1\u7d2b\u9524\u5b50",
            "/items/crimson_hammer": "\u7edb\u7ea2\u9524\u5b50",
            "/items/rainbow_hammer": "\u5f69\u8679\u9524\u5b50",
            "/items/holy_hammer": "\u795e\u5723\u9524\u5b50",
            "/items/celestial_chisel": "\u661f\u7a7a\u51ff\u5b50",
            "/items/cheese_chisel": "\u5976\u916a\u51ff\u5b50",
            "/items/verdant_chisel": "\u7fe0\u7eff\u51ff\u5b50",
            "/items/azure_chisel": "\u851a\u84dd\u51ff\u5b50",
            "/items/burble_chisel": "\u6df1\u7d2b\u51ff\u5b50",
            "/items/crimson_chisel": "\u7edb\u7ea2\u51ff\u5b50",
            "/items/rainbow_chisel": "\u5f69\u8679\u51ff\u5b50",
            "/items/holy_chisel": "\u795e\u5723\u51ff\u5b50",
            "/items/celestial_needle": "\u661f\u7a7a\u9488",
            "/items/cheese_needle": "\u5976\u916a\u9488",
            "/items/verdant_needle": "\u7fe0\u7eff\u9488",
            "/items/azure_needle": "\u851a\u84dd\u9488",
            "/items/burble_needle": "\u6df1\u7d2b\u9488",
            "/items/crimson_needle": "\u7edb\u7ea2\u9488",
            "/items/rainbow_needle": "\u5f69\u8679\u9488",
            "/items/holy_needle": "\u795e\u5723\u9488",
            "/items/celestial_spatula": "\u661f\u7a7a\u9505\u94f2",
            "/items/cheese_spatula": "\u5976\u916a\u9505\u94f2",
            "/items/verdant_spatula": "\u7fe0\u7eff\u9505\u94f2",
            "/items/azure_spatula": "\u851a\u84dd\u9505\u94f2",
            "/items/burble_spatula": "\u6df1\u7d2b\u9505\u94f2",
            "/items/crimson_spatula": "\u7edb\u7ea2\u9505\u94f2",
            "/items/rainbow_spatula": "\u5f69\u8679\u9505\u94f2",
            "/items/holy_spatula": "\u795e\u5723\u9505\u94f2",
            "/items/celestial_pot": "\u661f\u7a7a\u58f6",
            "/items/cheese_pot": "\u5976\u916a\u58f6",
            "/items/verdant_pot": "\u7fe0\u7eff\u58f6",
            "/items/azure_pot": "\u851a\u84dd\u58f6",
            "/items/burble_pot": "\u6df1\u7d2b\u58f6",
            "/items/crimson_pot": "\u7edb\u7ea2\u58f6",
            "/items/rainbow_pot": "\u5f69\u8679\u58f6",
            "/items/holy_pot": "\u795e\u5723\u58f6",
            "/items/celestial_alembic": "\u661f\u7a7a\u84b8\u998f\u5668",
            "/items/cheese_alembic": "\u5976\u916a\u84b8\u998f\u5668",
            "/items/verdant_alembic": "\u7fe0\u7eff\u84b8\u998f\u5668",
            "/items/azure_alembic": "\u851a\u84dd\u84b8\u998f\u5668",
            "/items/burble_alembic": "\u6df1\u7d2b\u84b8\u998f\u5668",
            "/items/crimson_alembic": "\u7edb\u7ea2\u84b8\u998f\u5668",
            "/items/rainbow_alembic": "\u5f69\u8679\u84b8\u998f\u5668",
            "/items/holy_alembic": "\u795e\u5723\u84b8\u998f\u5668",
            "/items/celestial_enhancer": "\u661f\u7a7a\u5f3a\u5316\u5668",
            "/items/cheese_enhancer": "\u5976\u916a\u5f3a\u5316\u5668",
            "/items/verdant_enhancer": "\u7fe0\u7eff\u5f3a\u5316\u5668",
            "/items/azure_enhancer": "\u851a\u84dd\u5f3a\u5316\u5668",
            "/items/burble_enhancer": "\u6df1\u7d2b\u5f3a\u5316\u5668",
            "/items/crimson_enhancer": "\u7edb\u7ea2\u5f3a\u5316\u5668",
            "/items/rainbow_enhancer": "\u5f69\u8679\u5f3a\u5316\u5668",
            "/items/holy_enhancer": "\u795e\u5723\u5f3a\u5316\u5668",
            "/items/milk": "\u725b\u5976",
            "/items/verdant_milk": "\u7fe0\u7eff\u725b\u5976",
            "/items/azure_milk": "\u851a\u84dd\u725b\u5976",
            "/items/burble_milk": "\u6df1\u7d2b\u725b\u5976",
            "/items/crimson_milk": "\u7edb\u7ea2\u725b\u5976",
            "/items/rainbow_milk": "\u5f69\u8679\u725b\u5976",
            "/items/holy_milk": "\u795e\u5723\u725b\u5976",
            "/items/cheese": "\u5976\u916a",
            "/items/verdant_cheese": "\u7fe0\u7eff\u5976\u916a",
            "/items/azure_cheese": "\u851a\u84dd\u5976\u916a",
            "/items/burble_cheese": "\u6df1\u7d2b\u5976\u916a",
            "/items/crimson_cheese": "\u7edb\u7ea2\u5976\u916a",
            "/items/rainbow_cheese": "\u5f69\u8679\u5976\u916a",
            "/items/holy_cheese": "\u795e\u5723\u5976\u916a",
            "/items/log": "\u539f\u6728",
            "/items/birch_log": "\u767d\u6866\u539f\u6728",
            "/items/cedar_log": "\u96ea\u677e\u539f\u6728",
            "/items/purpleheart_log": "\u7d2b\u5fc3\u539f\u6728",
            "/items/ginkgo_log": "\u94f6\u674f\u539f\u6728",
            "/items/redwood_log": "\u7ea2\u6749\u539f\u6728",
            "/items/arcane_log": "\u795e\u79d8\u539f\u6728",
            "/items/lumber": "\u6728\u677f",
            "/items/birch_lumber": "\u767d\u6866\u6728\u677f",
            "/items/cedar_lumber": "\u96ea\u677e\u6728\u677f",
            "/items/purpleheart_lumber": "\u7d2b\u5fc3\u6728\u677f",
            "/items/ginkgo_lumber": "\u94f6\u674f\u6728\u677f",
            "/items/redwood_lumber": "\u7ea2\u6749\u6728\u677f",
            "/items/arcane_lumber": "\u795e\u79d8\u6728\u677f",
            "/items/rough_hide": "\u7c97\u7cd9\u517d\u76ae",
            "/items/reptile_hide": "\u722c\u884c\u52a8\u7269\u76ae",
            "/items/gobo_hide": "\u54e5\u5e03\u6797\u76ae",
            "/items/beast_hide": "\u91ce\u517d\u76ae",
            "/items/umbral_hide": "\u6697\u5f71\u76ae",
            "/items/rough_leather": "\u7c97\u7cd9\u76ae\u9769",
            "/items/reptile_leather": "\u722c\u884c\u52a8\u7269\u76ae\u9769",
            "/items/gobo_leather": "\u54e5\u5e03\u6797\u76ae\u9769",
            "/items/beast_leather": "\u91ce\u517d\u76ae\u9769",
            "/items/umbral_leather": "\u6697\u5f71\u76ae\u9769",
            "/items/cotton": "\u68c9\u82b1",
            "/items/flax": "\u4e9a\u9ebb",
            "/items/bamboo_branch": "\u7af9\u5b50",
            "/items/cocoon": "\u8695\u8327",
            "/items/radiant_fiber": "\u5149\u8f89\u7ea4\u7ef4",
            "/items/cotton_fabric": "\u68c9\u82b1\u5e03\u6599",
            "/items/linen_fabric": "\u4e9a\u9ebb\u5e03\u6599",
            "/items/bamboo_fabric": "\u7af9\u5b50\u5e03\u6599",
            "/items/silk_fabric": "\u4e1d\u7ef8",
            "/items/radiant_fabric": "\u5149\u8f89\u5e03\u6599",
            "/items/egg": "\u9e21\u86cb",
            "/items/wheat": "\u5c0f\u9ea6",
            "/items/sugar": "\u7cd6",
            "/items/blueberry": "\u84dd\u8393",
            "/items/blackberry": "\u9ed1\u8393",
            "/items/strawberry": "\u8349\u8393",
            "/items/mooberry": "\u54de\u8393",
            "/items/marsberry": "\u706b\u661f\u8393",
            "/items/spaceberry": "\u592a\u7a7a\u8393",
            "/items/apple": "\u82f9\u679c",
            "/items/orange": "\u6a59\u5b50",
            "/items/plum": "\u674e\u5b50",
            "/items/peach": "\u6843\u5b50",
            "/items/dragon_fruit": "\u706b\u9f99\u679c",
            "/items/star_fruit": "\u6768\u6843",
            "/items/arabica_coffee_bean": "\u4f4e\u7ea7\u5496\u5561\u8c46",
            "/items/robusta_coffee_bean": "\u4e2d\u7ea7\u5496\u5561\u8c46",
            "/items/liberica_coffee_bean": "\u9ad8\u7ea7\u5496\u5561\u8c46",
            "/items/excelsa_coffee_bean": "\u7279\u7ea7\u5496\u5561\u8c46",
            "/items/fieriosa_coffee_bean": "\u706b\u5c71\u5496\u5561\u8c46",
            "/items/spacia_coffee_bean": "\u592a\u7a7a\u5496\u5561\u8c46",
            "/items/green_tea_leaf": "\u7eff\u8336\u53f6",
            "/items/black_tea_leaf": "\u9ed1\u8336\u53f6",
            "/items/burble_tea_leaf": "\u7d2b\u8336\u53f6",
            "/items/moolong_tea_leaf": "\u54de\u9f99\u8336\u53f6",
            "/items/red_tea_leaf": "\u7ea2\u8336\u53f6",
            "/items/emp_tea_leaf": "\u865a\u7a7a\u8336\u53f6",
            "/items/catalyst_of_coinification": "\u70b9\u91d1\u50ac\u5316\u5242",
            "/items/catalyst_of_decomposition": "\u5206\u89e3\u50ac\u5316\u5242",
            "/items/catalyst_of_transmutation": "\u8f6c\u5316\u50ac\u5316\u5242",
            "/items/prime_catalyst": "\u81f3\u9ad8\u50ac\u5316\u5242",
            "/items/snake_fang": "\u86c7\u7259",
            "/items/shoebill_feather": "\u9cb8\u5934\u9e73\u7fbd\u6bdb",
            "/items/snail_shell": "\u8717\u725b\u58f3",
            "/items/crab_pincer": "\u87f9\u94b3",
            "/items/turtle_shell": "\u4e4c\u9f9f\u58f3",
            "/items/marine_scale": "\u6d77\u6d0b\u9cde\u7247",
            "/items/treant_bark": "\u6811\u76ae",
            "/items/centaur_hoof": "\u534a\u4eba\u9a6c\u8e44",
            "/items/luna_wing": "\u6708\u795e\u7ffc",
            "/items/gobo_rag": "\u54e5\u5e03\u6797\u62b9\u5e03",
            "/items/goggles": "\u62a4\u76ee\u955c",
            "/items/magnifying_glass": "\u653e\u5927\u955c",
            "/items/eye_of_the_watcher": "\u89c2\u5bdf\u8005\u4e4b\u773c",
            "/items/icy_cloth": "\u51b0\u971c\u7ec7\u7269",
            "/items/flaming_cloth": "\u70c8\u7130\u7ec7\u7269",
            "/items/sorcerers_sole": "\u9b54\u6cd5\u5e08\u978b\u5e95",
            "/items/chrono_sphere": "\u65f6\u7a7a\u7403",
            "/items/frost_sphere": "\u51b0\u971c\u7403",
            "/items/panda_fluff": "\u718a\u732b\u7ed2",
            "/items/black_bear_fluff": "\u9ed1\u718a\u7ed2",
            "/items/grizzly_bear_fluff": "\u68d5\u718a\u7ed2",
            "/items/polar_bear_fluff": "\u5317\u6781\u718a\u7ed2",
            "/items/red_panda_fluff": "\u5c0f\u718a\u732b\u7ed2",
            "/items/magnet": "\u78c1\u94c1",
            "/items/stalactite_shard": "\u949f\u4e73\u77f3\u788e\u7247",
            "/items/living_granite": "\u82b1\u5c97\u5ca9",
            "/items/colossus_core": "\u5de8\u50cf\u6838\u5fc3",
            "/items/vampire_fang": "\u5438\u8840\u9b3c\u4e4b\u7259",
            "/items/werewolf_claw": "\u72fc\u4eba\u4e4b\u722a",
            "/items/revenant_anima": "\u4ea1\u8005\u4e4b\u9b42",
            "/items/soul_fragment": "\u7075\u9b42\u788e\u7247",
            "/items/infernal_ember": "\u5730\u72f1\u4f59\u70ec",
            "/items/demonic_core": "\u6076\u9b54\u6838\u5fc3",
            "/items/griffin_leather": "\u72ee\u9e6b\u4e4b\u76ae",
            "/items/manticore_sting": "\u874e\u72ee\u4e4b\u523a",
            "/items/jackalope_antler": "\u9e7f\u89d2\u5154\u4e4b\u89d2",
            "/items/dodocamel_plume": "\u6e21\u6e21\u9a7c\u4e4b\u7fce",
            "/items/griffin_talon": "\u72ee\u9e6b\u4e4b\u722a",
            "/items/chimerical_refinement_shard": "\u5947\u5e7b\u7cbe\u70bc\u788e\u7247",
            "/items/acrobats_ribbon": "\u6742\u6280\u5e08\u5f69\u5e26",
            "/items/magicians_cloth": "\u9b54\u672f\u5e08\u7ec7\u7269",
            "/items/chaotic_chain": "\u6df7\u6c8c\u9501\u94fe",
            "/items/cursed_ball": "\u8bc5\u5492\u4e4b\u7403",
            "/items/sinister_refinement_shard": "\u9634\u68ee\u7cbe\u70bc\u788e\u7247",
            "/items/royal_cloth": "\u7687\u5bb6\u7ec7\u7269",
            "/items/knights_ingot": "\u9a91\u58eb\u4e4b\u952d",
            "/items/bishops_scroll": "\u4e3b\u6559\u5377\u8f74",
            "/items/regal_jewel": "\u541b\u738b\u5b9d\u77f3",
            "/items/sundering_jewel": "\u88c2\u7a7a\u5b9d\u77f3",
            "/items/enchanted_refinement_shard": "\u79d8\u6cd5\u7cbe\u70bc\u788e\u7247",
            "/items/marksman_brooch": "\u795e\u5c04\u80f8\u9488",
            "/items/corsair_crest": "\u63a0\u593a\u8005\u5fbd\u7ae0",
            "/items/damaged_anchor": "\u7834\u635f\u8239\u951a",
            "/items/maelstrom_plating": "\u6012\u6d9b\u7532\u7247",
            "/items/kraken_leather": "\u514b\u62c9\u80af\u76ae\u9769",
            "/items/kraken_fang": "\u514b\u62c9\u80af\u4e4b\u7259",
            "/items/pirate_refinement_shard": "\u6d77\u76d7\u7cbe\u70bc\u788e\u7247",
            "/items/pathbreaker_lodestone": "\u5f00\u8def\u8005\u78c1\u77f3",
            "/items/pathfinder_lodestone": "\u63a2\u8def\u8005\u78c1\u77f3",
            "/items/pathseeker_lodestone": "\u5bfb\u8def\u8005\u78c1\u77f3",
            "/items/labyrinth_refinement_shard": "\u8ff7\u5bab\u7cbe\u70bc\u788e\u7247",
            "/items/butter_of_proficiency": "\u7cbe\u901a\u4e4b\u6cb9",
            "/items/thread_of_expertise": "\u4e13\u7cbe\u4e4b\u7ebf",
            "/items/branch_of_insight": "\u6d1e\u5bdf\u4e4b\u679d",
            "/items/gluttonous_energy": "\u8d2a\u98df\u80fd\u91cf",
            "/items/guzzling_energy": "\u66b4\u996e\u80fd\u91cf",
            "/items/milking_essence": "\u6324\u5976\u7cbe\u534e",
            "/items/foraging_essence": "\u91c7\u6458\u7cbe\u534e",
            "/items/woodcutting_essence": "\u4f10\u6728\u7cbe\u534e",
            "/items/cheesesmithing_essence": "\u5976\u916a\u953b\u9020\u7cbe\u534e",
            "/items/crafting_essence": "\u5236\u4f5c\u7cbe\u534e",
            "/items/tailoring_essence": "\u7f1d\u7eab\u7cbe\u534e",
            "/items/cooking_essence": "\u70f9\u996a\u7cbe\u534e",
            "/items/brewing_essence": "\u51b2\u6ce1\u7cbe\u534e",
            "/items/alchemy_essence": "\u70bc\u91d1\u7cbe\u534e",
            "/items/enhancing_essence": "\u5f3a\u5316\u7cbe\u534e",
            "/items/swamp_essence": "\u6cbc\u6cfd\u7cbe\u534e",
            "/items/aqua_essence": "\u6d77\u6d0b\u7cbe\u534e",
            "/items/jungle_essence": "\u4e1b\u6797\u7cbe\u534e",
            "/items/gobo_essence": "\u54e5\u5e03\u6797\u7cbe\u534e",
            "/items/eyessence": "\u773c\u7cbe\u534e",
            "/items/sorcerer_essence": "\u6cd5\u5e08\u7cbe\u534e",
            "/items/bear_essence": "\u718a\u718a\u7cbe\u534e",
            "/items/golem_essence": "\u9b54\u50cf\u7cbe\u534e",
            "/items/twilight_essence": "\u66ae\u5149\u7cbe\u534e",
            "/items/abyssal_essence": "\u5730\u72f1\u7cbe\u534e",
            "/items/chimerical_essence": "\u5947\u5e7b\u7cbe\u534e",
            "/items/sinister_essence": "\u9634\u68ee\u7cbe\u534e",
            "/items/enchanted_essence": "\u79d8\u6cd5\u7cbe\u534e",
            "/items/pirate_essence": "\u6d77\u76d7\u7cbe\u534e",
            "/items/labyrinth_essence": "\u8ff7\u5bab\u7cbe\u534e",
            "/items/task_crystal": "\u4efb\u52a1\u6c34\u6676",
            "/items/star_fragment": "\u661f\u5149\u788e\u7247",
            "/items/pearl": "\u73cd\u73e0",
            "/items/amber": "\u7425\u73c0",
            "/items/garnet": "\u77f3\u69b4\u77f3",
            "/items/jade": "\u7fe1\u7fe0",
            "/items/amethyst": "\u7d2b\u6c34\u6676",
            "/items/moonstone": "\u6708\u4eae\u77f3",
            "/items/sunstone": "\u592a\u9633\u77f3",
            "/items/philosophers_stone": "\u8d24\u8005\u4e4b\u77f3",
            "/items/crushed_pearl": "\u73cd\u73e0\u788e\u7247",
            "/items/crushed_amber": "\u7425\u73c0\u788e\u7247",
            "/items/crushed_garnet": "\u77f3\u69b4\u77f3\u788e\u7247",
            "/items/crushed_jade": "\u7fe1\u7fe0\u788e\u7247",
            "/items/crushed_amethyst": "\u7d2b\u6c34\u6676\u788e\u7247",
            "/items/crushed_moonstone": "\u6708\u4eae\u77f3\u788e\u7247",
            "/items/crushed_sunstone": "\u592a\u9633\u77f3\u788e\u7247",
            "/items/crushed_philosophers_stone": "\u8d24\u8005\u4e4b\u77f3\u788e\u7247",
            "/items/shard_of_protection": "\u4fdd\u62a4\u788e\u7247",
            "/items/mirror_of_protection": "\u4fdd\u62a4\u4e4b\u955c",
            "/items/philosophers_mirror": "\u8d24\u8005\u4e4b\u955c",
            "/items/basic_torch": "\u57fa\u7840\u706b\u628a",
            "/items/advanced_torch": "\u8fdb\u9636\u706b\u628a",
            "/items/expert_torch": "\u4e13\u5bb6\u706b\u628a",
            "/items/basic_shroud": "\u57fa\u7840\u6597\u7bf7",
            "/items/advanced_shroud": "\u8fdb\u9636\u6597\u7bf7",
            "/items/expert_shroud": "\u4e13\u5bb6\u6597\u7bf7",
            "/items/basic_beacon": "\u57fa\u7840\u63a2\u7167\u706f",
            "/items/advanced_beacon": "\u8fdb\u9636\u63a2\u7167\u706f",
            "/items/expert_beacon": "\u4e13\u5bb6\u63a2\u7167\u706f",
            "/items/basic_food_crate": "\u57fa\u7840\u98df\u7269\u7bb1",
            "/items/advanced_food_crate": "\u8fdb\u9636\u98df\u7269\u7bb1",
            "/items/expert_food_crate": "\u4e13\u5bb6\u98df\u7269\u7bb1",
            "/items/basic_tea_crate": "\u57fa\u7840\u8336\u53f6\u7bb1",
            "/items/advanced_tea_crate": "\u8fdb\u9636\u8336\u53f6\u7bb1",
            "/items/expert_tea_crate": "\u4e13\u5bb6\u8336\u53f6\u7bb1",
            "/items/basic_coffee_crate": "\u57fa\u7840\u5496\u5561\u7bb1",
            "/items/advanced_coffee_crate": "\u8fdb\u9636\u5496\u5561\u7bb1",
            "/items/expert_coffee_crate": "\u4e13\u5bb6\u5496\u5561\u7bb1"
    });

    // 所有装备槽位：统一从身上找穿着的 itemHrid，再从背包+身上取同名最高强化等级
    const ALL_EQUIPMENT_SLOTS = [
      "/item_locations/head",
      "/item_locations/body",
      "/item_locations/legs",
      "/item_locations/feet",
      "/item_locations/hands",
      "/item_locations/off_hand",
      "/item_locations/back",
      "/item_locations/neck",
      "/item_locations/earrings",
      "/item_locations/ring",
      "/item_locations/pouch",
      "/item_locations/enhancing_tool",
      "/item_locations/charm"
    ];

    // ═══════════════════════════════════════════════
    //  游戏数据缓存
    // ═══════════════════════════════════════════════
    let cachedInitClientData = null;
    let cachedInitClientDataRaw = null;

    // ═══════════════════════════════════════════════
    //  基础工具
    // ═══════════════════════════════════════════════
    function getInitClientData() {
      const keys = ["initClientData", "game-game-data"];
      for (const key of keys) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        if (cachedInitClientData && cachedInitClientDataRaw === raw) return cachedInitClientData;
        const lz = typeof LZString !== "undefined" ? LZString : null;
        const parsers = [
          () => JSON.parse(raw),
          () => lz?.decompressFromUTF16 ? JSON.parse(lz.decompressFromUTF16(raw)) : null,
          () => lz?.decompressFromBase64 ? JSON.parse(lz.decompressFromBase64(raw)) : null
        ];
        for (const parser of parsers) {
          try {
            const parsed = parser();
            if (parsed && typeof parsed === "object" && (parsed.itemDetailMap || parsed.actionDetailMap)) {
              cachedInitClientData = parsed;
              cachedInitClientDataRaw = raw;
              return cachedInitClientData;
            }
          } catch (_) {}
        }
      }
      return null;
    }

    function isLikelyGameState(state) {
      return Boolean(
        state && typeof state === "object" &&
        (state.characterSkillMap || state.characterItemMap || state.combatUnit || state.gameConn)
      );
    }

    function findGameStateFromFiber(rootFiber) {
      if (!rootFiber || typeof rootFiber !== "object") return null;
      const queue = [rootFiber];
      const visited = new Set();
      let steps = 0;
      while (queue.length > 0 && steps < 20000) {
        const fiber = queue.shift();
        if (!fiber || typeof fiber !== "object" || visited.has(fiber)) continue;
        visited.add(fiber);
        steps++;
        const st = fiber.stateNode?.state;
        if (isLikelyGameState(st)) return st;
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      return null;
    }

    function getGameState() {
      const gamePage = document.querySelector('[class^="GamePage"]');
      if (gamePage) {
        const reactKey = Object.keys(gamePage).find(k => k.startsWith("__reactFiber$"));
        if (reactKey) {
          const fiberNode = gamePage[reactKey];
          const directState = fiberNode?.return?.stateNode?.state || null;
          if (isLikelyGameState(directState)) return directState;
        }
      }
      const rootEl = document.getElementById("root");
      let rootContainer = rootEl?._reactRootContainer || null;
      if (!rootContainer) {
        const fallback = Array.from(document.querySelectorAll("div")).find(
          el => Object.prototype.hasOwnProperty.call(el, "_reactRootContainer")
        );
        rootContainer = fallback?._reactRootContainer || null;
      }
      return findGameStateFromFiber(rootContainer?.current || null);
    }

    function getSkillLevel(state, skillHrid) {
      const skillMap = state?.characterSkillMap;
      if (!skillMap) return 0;
      const entry = skillMap instanceof Map ? skillMap.get(skillHrid) : skillMap[skillHrid];
      return Number(entry?.level || 0);
    }

    function getItemDetail(hrid, state) {
      return state?.itemDetailDict?.[hrid]
        || getInitClientData()?.itemDetailMap?.[hrid]
        || null;
    }

    function getAllItems(state) {
      const itemMap = state?.characterItemMap;
      if (!itemMap) return [];
      return itemMap instanceof Map ? Array.from(itemMap.values()) : Object.values(itemMap);
    }

    // ═══════════════════════════════════════════════
    //  装备读取
    // ═══════════════════════════════════════════════

    // 槽位 → 装备类型映射
    const SLOT_TO_EQUIP_TYPE = {
      "/item_locations/head": "/equipment_types/head",
      "/item_locations/body": "/equipment_types/body",
      "/item_locations/legs": "/equipment_types/legs",
      "/item_locations/feet": "/equipment_types/feet",
      "/item_locations/hands": "/equipment_types/hands",
      "/item_locations/off_hand": "/equipment_types/off_hand",
      "/item_locations/back": "/equipment_types/back",
      "/item_locations/neck": "/equipment_types/neck",
      "/item_locations/earrings": "/equipment_types/earrings",
      "/item_locations/ring": "/equipment_types/ring",
      "/item_locations/pouch": "/equipment_types/pouch",
      "/item_locations/enhancing_tool": "/equipment_types/enhancing_tool",
      "/item_locations/charm": "/equipment_types/charm"
    };

    /**
     * 比较两件装备，返回更好的那一件
     * 优先级：精炼 > 普通，高强化 > 低强化，高物品等级 > 低物品等级
     * 逻辑应该还能优化，但是暂时够用
     */
    function compareBestEquipment(a, b, aDetail, bDetail) {
      // 精炼优先
      const aRefined = a.itemHrid.includes("_refined");
      const bRefined = b.itemHrid.includes("_refined");
      if (aRefined && !bRefined) return -1;
      if (!aRefined && bRefined) return 1;
      // 强化等级
      const aLevel = Math.max(0, Number(a.enhancementLevel) || 0);
      const bLevel = Math.max(0, Number(b.enhancementLevel) || 0);
      if (aLevel !== bLevel) return bLevel - aLevel;
      // 物品等级
      const aItemLevel = aDetail?.itemLevel || 0;
      const bItemLevel = bDetail?.itemLevel || 0;
      return bItemLevel - aItemLevel;
    }

    /**
     * 为指定槽位找到最好的装备（优先身上穿的，否则从背包找）
     * 返回 { item, detail, enhancementLevel }
     */
    function findBestEquipmentForSlot(slot, state) {
      const items = getAllItems(state);
      const equipType = SLOT_TO_EQUIP_TYPE[slot];
      if (!equipType) return null;

      // 找身上穿的
      const equipped = items.find(item =>
        item.itemLocationHrid === slot && Number(item.count || 0) > 0
      );

      // 找背包中该槽位能穿的所有装备（包括身上的）
      const candidates = [];
      for (const item of items) {
        if (!item?.itemHrid || Number(item.count || 0) <= 0) continue;
        const detail = getItemDetail(item.itemHrid, state);
        if (!detail?.equipmentDetail) continue;
        // 检查装备类型是否匹配该槽位
        if (detail.equipmentDetail.type !== equipType) continue;
        // 检查是否有强化相关的 noncombatStats
        const ncs = detail.equipmentDetail.noncombatStats || {};
        if (Object.keys(ncs).length === 0) continue;
        candidates.push({ item, detail, enhancementLevel: Math.max(0, Number(item.enhancementLevel) || 0) });
      }

      if (candidates.length === 0) return null;

      // 按优先级排序
      candidates.sort((a, b) => compareBestEquipment(a.item, b.item, a.detail, b.detail));
      return candidates[0];
    }

    // ═══════════════════════════════════════════════
    //  Buff 计算
    // ═══════════════════════════════════════════════

    function computeEnhancingBuffs(state) {
      const icd = getInitClientData();
      if (!icd || !state) return null;

      const enhanceMultiplier = icd.enhancementLevelTotalBonusMultiplierTable || [];
      const buffs = {};

      // 装备：每个槽位找最好的装备（优先身上穿的，否则从背包找）
      for (const slot of ALL_EQUIPMENT_SLOTS) {
        const best = findBestEquipmentForSlot(slot, state);
        if (!best) continue;

        const { detail, enhancementLevel } = best;
        const ncs = detail.equipmentDetail.noncombatStats || {};
        const nceb = detail.equipmentDetail.noncombatEnhancementBonuses || {};
        const mult = enhanceMultiplier[enhancementLevel] || 0;

        for (const [key, value] of Object.entries(ncs)) {
          const bonus = Number(value) + (Number(nceb[key] || 0) * mult);
          buffs[key] = (buffs[key] || 0) + bonus;
        }
      }

      // 社区 buff
      const communityBuffs = state.communityActionTypeBuffsDict?.[ENHANCE_ACTION_TYPE];
      if (Array.isArray(communityBuffs)) {
        for (const buff of communityBuffs) {
          const amount = (buff.flatBoost || 0)
            + (buff.flatBoostLevelBonus || 0) * Math.max(0, (buff.level || 1) - 1);
          applyBuffToMap(buffs, buff.typeHrid, amount, "enhancing");
        }
      }

      // 房子 buff
      const houseBuffs = state.houseActionTypeBuffsDict?.[ENHANCE_ACTION_TYPE];
      if (Array.isArray(houseBuffs)) {
        for (const buff of houseBuffs) {
          const amount = (buff.flatBoost || 0)
            + (buff.flatBoostLevelBonus || 0) * Math.max(0, (buff.level || 1) - 1)
            + (buff.ratioBoost || 0)
            + (buff.ratioBoostLevelBonus || 0) * Math.max(0, (buff.level || 1) - 1);
          applyBuffToMap(buffs, buff.typeHrid, amount, "enhancing");
        }
      }

      // 成就 buff
      const achieveBuffs = state.achievementActionTypeBuffsDict?.[ENHANCE_ACTION_TYPE];
      if (Array.isArray(achieveBuffs)) {
        for (const buff of achieveBuffs) {
          const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
          applyBuffToMap(buffs, buff.typeHrid, amount, "enhancing");
        }
      }

      // MooPass buff
      const mooPassBuffs = state.mooPassActionTypeBuffsDict?.[ENHANCE_ACTION_TYPE];
      if (Array.isArray(mooPassBuffs)) {
        for (const buff of mooPassBuffs) {
          const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
          applyBuffToMap(buffs, buff.typeHrid, amount, "enhancing");
        }
      }

      // 封印 buff
      const personalBuffs = state.personalActionTypeBuffsDict?.[ENHANCE_ACTION_TYPE];
      if (Array.isArray(personalBuffs)) {
        for (const buff of personalBuffs) {
          const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
          applyBuffToMap(buffs, buff.typeHrid, amount, "enhancing");
        }
      }

      // 茶 buff
      const drinkConc = buffs.drinkConcentration || 0;
      for (const teaHrid of DEFAULT_TEAS) {
        const teaDetail = getItemDetail(teaHrid, state);
        if (!teaDetail?.consumableDetail?.buffs) continue;
        for (const buff of teaDetail.consumableDetail.buffs) {
          applyTeaBuffToMap(buffs, buff, "enhancing", drinkConc);
        }
      }

      return buffs;
    }

    function applyBuffToMap(buffs, typeHrid, amount, action) {
      if (!amount || !Number.isFinite(amount)) return;
      const mapping = {
        "/buff_types/action_speed": `${action}Speed`,
        "/buff_types/efficiency": `${action}Efficiency`,
        "/buff_types/enhancing_success": `${action}Success`,
        "/buff_types/wisdom": `${action}Experience`,
        "/buff_types/blessed": `${action}Blessed`,
        "/buff_types/rare_find": `skillingRareFind`,
        "/buff_types/enhancing_essence_find": `${action}EssenceFind`,
        "/buff_types/experience": `skillingExperience`,
        "/buff_types/skilling_experience": `skillingExperience`,
        "/buff_types/enhancing_level": `${action}Level`
      };
      const key = mapping[typeHrid];
      if (key) {
        buffs[key] = (buffs[key] || 0) + amount;
      }
    }

    function applyTeaBuffToMap(buffs, buff, action, drinkConc) {
      const conc = 1 + drinkConc;
      const typeHrid = buff.typeHrid;
      if (typeHrid === `/buff_types/${action}_level`) {
        buffs[`${action}Level`] = (buffs[`${action}Level`] || 0) + (buff.flatBoost || 0) * conc;
      } else if (typeHrid === "/buff_types/action_level") {
        buffs[`${action}Level`] = (buffs[`${action}Level`] || 0) - (buff.flatBoost || 0) * conc;
      } else if (typeHrid === `/buff_types/${action}_success`) {
        buffs[`${action}Success`] = (buffs[`${action}Success`] || 0) + (buff.ratioBoost || 0) * conc;
      } else if (typeHrid === "/buff_types/blessed") {
        buffs[`${action}Blessed`] = (buffs[`${action}Blessed`] || 0) + (buff.flatBoost || 0) * conc;
      } else if (typeHrid === "/buff_types/action_speed") {
        buffs[`${action}Speed`] = (buffs[`${action}Speed`] || 0) + (buff.flatBoost || 0) * conc;
      } else if (typeHrid === "/buff_types/wisdom") {
        buffs[`${action}Experience`] = (buffs[`${action}Experience`] || 0) + (buff.flatBoost || 0) * conc;
      } else if (typeHrid === "/buff_types/efficiency") {
        buffs[`${action}Efficiency`] = (buffs[`${action}Efficiency`] || 0) + (buff.flatBoost || 0) * conc;
      }
    }

    function getBuffOf(buffs, key) {
      return (buffs[`enhancing${key}`] || 0) + (buffs[`skilling${key}`] || 0);
    }

    // ═══════════════════════════════════════════════
    //  强化计算
    // ═══════════════════════════════════════════════

    function invertMatrix(M) {
      const n = M.length;
      const aug = M.map((row, i) => {
        const r = new Array(2 * n).fill(0);
        for (let j = 0; j < n; j++) r[j] = row[j];
        r[n + i] = 1;
        return r;
      });
      for (let col = 0; col < n; col++) {
        let maxRow = col;
        for (let row = col + 1; row < n; row++) {
          if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
        }
        [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
        const pivot = aug[col][col];
        if (Math.abs(pivot) < 1e-15) return null;
        for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;
        for (let row = 0; row < n; row++) {
          if (row === col) continue;
          const factor = aug[row][col];
          for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
        }
      }
      return aug.map(row => row.slice(n));
    }

    function matVecMul(inv, vec) {
      return inv.map(row => row.reduce((s, v, j) => s + v * vec[j], 0));
    }

    function enhancelate(itemHrid, targetLevel, protectLevel, originLevel, escapeLevel, buffs, state) {
      const icd = getInitClientData();
      if (!icd) return null;
      const item = getItemDetail(itemHrid, state);
      if (!item) return null;
      const successRateTable = icd.enhancementLevelSuccessRateTable;
      if (!successRateTable || successRateTable.length === 0) return null;

      const rawLevel = getSkillLevel(state, ENHANCE_SKILL_HRID);
      const playerLevel = rawLevel + getBuffOf(buffs, "Level");
      const successBuff = getBuffOf(buffs, "Success");
      const blessedBuff = getBuffOf(buffs, "Blessed");

      function enhanceSuccessRatio() {
        const itemLevel = item.itemLevel || 0;
        const levelRatio = playerLevel >= itemLevel
          ? (playerLevel - itemLevel) * 0.0005
          : -0.5 * (1 - playerLevel / itemLevel);
        return levelRatio + successBuff;
      }
      // Buffs may otherwise push the total outgoing probability above 1.
      // Clamp before splitting a success into normal and blessed outcomes.
      function successRateEnhance(rate) {
        return Math.min(1, Math.max(0, rate * (1 + enhanceSuccessRatio())));
      }
      function levelUpRate(rate) { return Math.min(1, successRateEnhance(rate) * (1 - blessedBuff)); }
      function levelLeapRate(rate) { return successRateEnhance(rate) * blessedBuff; }
      function failRate(rate) { return Math.max(0, 1 - successRateEnhance(rate)); }

      const stMatrix = [];
      for (let i = 0; i < targetLevel; i++) stMatrix[i] = new Array(targetLevel).fill(0);
      for (let i = 0; i < targetLevel; i++) {
        if (i < targetLevel - 1) stMatrix[i][i + 1] = levelUpRate(successRateTable[i]);
        if (i < targetLevel - 2) stMatrix[i][i + 2] = levelLeapRate(successRateTable[i]);
        const failTarget = i >= protectLevel ? i - 1 : 0;
        stMatrix[i][failTarget] += failRate(successRateTable[i]);
      }

      const offset = escapeLevel + 1;
      const size = targetLevel - offset;
      if (size <= 0) return null;

      const IminusP = [];
      for (let i = 0; i < size; i++) {
        IminusP[i] = new Array(size).fill(0);
        IminusP[i][i] = 1;
        for (let j = 0; j < size; j++) IminusP[i][j] -= stMatrix[i + offset][j + offset];
      }

      const inv = invertMatrix(IminusP);
      if (!inv) return null;

      const onesVec = new Array(size).fill(1);
      const allActions = matVecMul(inv, onesVec);

      const protectVec = new Array(size).fill(0);
      for (let i = protectLevel; i < targetLevel; i++) {
        const ri = i - offset;
        if (ri >= 0 && ri < size) protectVec[ri] = failRate(successRateTable[i]);
      }
      const allProtects = matVecMul(inv, protectVec);

      const expVec = new Array(size).fill(0);
      for (let i = 0; i < targetLevel; i++) {
        const ri = i - offset;
        if (ri < 0 || ri >= size) continue;
        const sr = successRateEnhance(successRateTable[i]);
        const baseExp = 1.4 * (1 + i) * (10 + (item.itemLevel || 0));
        expVec[ri] = (sr + 0.1 * (1 - sr)) * baseExp;
      }
      const allExp = matVecMul(inv, expVec);

      const originIdx = originLevel - offset;
      if (originIdx < 0 || originIdx >= size) return null;

      const actions = allActions[originIdx];
      const protects = allProtects[originIdx];
      const exp = allExp[originIdx];
      if (!Number.isFinite(actions) || actions < 0) return null;

      const targetRate = levelLeapRate(successRateTable[targetLevel - 2])
          * (size > 1 ? inv[originIdx][size - 2] : 0)
        + levelUpRate(successRateTable[targetLevel - 1])
          * inv[originIdx][size - 1];
      const leapRate = levelLeapRate(successRateTable[targetLevel - 1])
        * inv[originIdx][size - 1];
      let escapeRate = 1 - targetRate - leapRate;
      if (Math.abs(escapeRate) < 1e-10) escapeRate = 0;

      // ─── 项目级方差 / 协方差（解析公式） ───
      // h  = N·1  (期望次数), π = N·b (期望保护), b_i = pFail_i · [i ≥ protectLevel]
      // h2 = N·(2h-1)               => Var[actions] = h2 - h²
      // c_i = b_i·(1 + 2π_{fd(i)})  , σ2 = N·c   => Var[protects] = σ2 - π²
      // d_i = π_i + b_i·h_{fd(i)}   , γ  = N·d   => Cov[a,p] = γ - h·π
      // 这里默认 escapeLevel = -1，调用方不需要 Var[I_reached] 等项
      const bArr = new Array(size).fill(0);
      for (let i = Math.max(protectLevel, offset); i < targetLevel; i++) {
        bArr[i - offset] = failRate(successRateTable[i]);
      }
      const fdIdx = new Array(size).fill(-1);
      for (let idx = 0; idx < size; idx++) {
        const level = idx + offset;
        const failLevel = level >= protectLevel ? level - 1 : 0;
        fdIdx[idx] = (failLevel >= offset && failLevel < targetLevel) ? (failLevel - offset) : -1;
      }
      const valAt = (vec, idx) => idx >= 0 ? vec[idx] : 0;

      const twoHminus1 = allActions.map(h => 2 * h - 1);
      const h2Arr = matVecMul(inv, twoHminus1);
      const cArr = new Array(size).fill(0);
      for (let i = 0; i < size; i++) cArr[i] = bArr[i] * (1 + 2 * valAt(allProtects, fdIdx[i]));
      const sigma2Arr = matVecMul(inv, cArr);
      const dArr = new Array(size).fill(0);
      for (let i = 0; i < size; i++) dArr[i] = allProtects[i] + bArr[i] * valAt(allActions, fdIdx[i]);
      const gammaArr = matVecMul(inv, dArr);

      const h0 = allActions[originIdx];
      const p0 = allProtects[originIdx];
      const varActions = Math.max(0, h2Arr[originIdx] - h0 * h0);
      const varProtects = Math.max(0, sigma2Arr[originIdx] - p0 * p0);
      const covActProt = gammaArr[originIdx] - h0 * p0;

      return {
        actions, protects, exp, targetRate, leapRate, escapeRate,
        varActions, varProtects, covActProt
      };
    }

    // ═══════════════════════════════════════════════
    //  市场价格缓存（官方API + ABwayidle兼容（考虑可能合并@AlphB） + WebSocket实时更新）
    // ═══════════════════════════════════════════════

    const MARKET_CACHE_KEY = "MWITools_marketAPI_json";
    const OWN_CACHE_KEY = "HourlyRate_marketCache";

    function getMarketApiUrl() {
      const host = location.hostname;
      if (host.includes("test.milkywayidle.com")) {
        return "https://test.milkywayidle.com/game_data/marketplace.json";
      } else if (host.includes("test.milkywayidlecn.com")) {
        return "https://test.milkywayidlecn.com/game_data/marketplace.json";
      } else if (host.includes("milkywayidlecn.com")) {
        return "https://www.milkywayidlecn.com/game_data/marketplace.json";
      }
      return "https://www.milkywayidle.com/game_data/marketplace.json";
    }

    let marketDataCache = null;
    let marketDataLoaded = false;

    async function fetchMarketApi() {
      try {
        const url = getMarketApiUrl();
        console.log("[HourlyRate] Fetching market API:", url);
        // 公开只读快照；明确不携带游戏登录 Cookie/凭据。
        // 该请求仅在脚本初始化时执行一次，不按物品循环请求。
        const resp = await fetch(url, { credentials: "omit", cache: "default" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data?.marketData) {
          marketDataCache = data.marketData;
          window.__MWI_PRIVATE_MARKET_SNAPSHOT__ = data;
          marketDataLoaded = true;
          console.log("[HourlyRate] Market API loaded, items:", Object.keys(data.marketData).length);
        }
      } catch (e) {
        console.warn("[HourlyRate] Failed to fetch market API:", e);
      }
    }

    function getMarketCache() {
      if (marketDataCache) return marketDataCache;
      try {
        const abCache = localStorage.getItem(MARKET_CACHE_KEY);
        if (abCache) {
          const parsed = JSON.parse(abCache);
          if (parsed?.marketData) return parsed.marketData;
        }
      } catch (_) {}
      try {
        const ownCache = localStorage.getItem(OWN_CACHE_KEY);
        if (ownCache) return JSON.parse(ownCache);
      } catch (_) {}
      return {};
    }

    function saveOwnMarketCache(marketData) {
      try {
        localStorage.setItem(OWN_CACHE_KEY, JSON.stringify(marketData));
      } catch (_) {}
    }

    let lastOrderBooksCache = {};

    function updateMarketCacheFromWS(marketItemOrderBooks) {
      if (!marketItemOrderBooks?.itemHrid || !marketItemOrderBooks?.orderBooks) return;
      const itemHrid = marketItemOrderBooks.itemHrid;
      const orderBooks = marketItemOrderBooks.orderBooks;

      if (!marketDataCache) marketDataCache = {};
      if (!marketDataCache[itemHrid]) marketDataCache[itemHrid] = {};

      lastOrderBooksCache[itemHrid] = orderBooks;

      for (let level = 0; level <= 20; level++) {
        const book = orderBooks[level];
        if (book) {
          const asks = book.asks || [];
          const bids = book.bids || [];
          const askPrice = asks.length > 0 ? Math.min(...asks.map(l => l.price)) : -1;
          const bidPrice = bids.length > 0 ? Math.max(...bids.map(l => l.price)) : -1;
          if (askPrice !== -1 || bidPrice !== -1) {
            marketDataCache[itemHrid][level] = { a: askPrice, b: bidPrice };
          }
        }
      }
    }

    function getOrderBookListings(itemHrid, enhanceLevel, isAskSide) {
      const books = lastOrderBooksCache[itemHrid];
      if (!books || !books[enhanceLevel]) return [];
      return isAskSide ? (books[enhanceLevel].asks || []) : (books[enhanceLevel].bids || []);
    }

    // ═══════════════════════════════════════════════
    //  工时费计算
    // ═══════════════════════════════════════════════

    const SELL_TAX_FACTOR = 0.98;

    function getShopPrice(hrid) {
      const icd = getInitClientData();
      if (!icd?.shopItemDetailMap) return 0;
      const itemKey = hrid.split("/").pop();
      const shopItem = icd.shopItemDetailMap[`/shop_items/${itemKey}`];
      if (!shopItem?.costs) return 0;
      const coinCost = shopItem.costs.find(c => c.itemHrid === "/items/coin");
      return coinCost ? (coinCost.count || 0) : 0;
    }

    function getMarketAskPrice(hrid, enhanceLevel = 0) {
      if (hrid === "/items/coin") return 1;

      const cache = getMarketCache();
      const itemCache = cache[hrid];
      let marketAsk = 0;
      if (itemCache && itemCache[enhanceLevel]) {
        const ask = itemCache[enhanceLevel].a;
        if (ask > 0) marketAsk = ask;
      }

      if (enhanceLevel === 0) {
        const shopPrice = getShopPrice(hrid);
        if (shopPrice > 0) {
          return marketAsk > 0 ? Math.min(marketAsk, shopPrice) : shopPrice;
        }
      }
      return marketAsk;
    }

    function getMarketBidPrice(hrid, enhanceLevel = 0) {
      const cache = getMarketCache();
      const itemCache = cache[hrid];
      if (itemCache && itemCache[enhanceLevel]) {
        const bid = itemCache[enhanceLevel].b;
        if (bid > 0) return bid;
      }
      return 0;
    }

    // Expose the ranking script's live enhanced-item buy order for the loot tracker.
    window.__MWI_PRIVATE_GET_MARKET_BID__ = (hrid, enhanceLevel = 0) => {
      const bid = getMarketBidPrice(hrid, enhanceLevel);
      return Number.isFinite(bid) && bid > 0 ? bid : null;
    };
    window.__MWI_PRIVATE_GET_MARKET_ASK__ = (hrid, enhanceLevel = 0) => {
      const ask = getMarketAskPrice(hrid, enhanceLevel);
      return Number.isFinite(ask) && ask > 0 ? ask : null;
    };

    // ═══════════════════════════════════════════════
    //  制造成本计算（Best Crafting Plan）
    // ═══════════════════════════════════════════════

    const MANUFACTURE_ACTIONS = ["cheesesmithing", "crafting", "tailoring"];
    const MANUFACTURE_NAMES = { cheesesmithing: "锻造", crafting: "制造", tailoring: "裁缝" };
    const MAX_CRAFT_DEPTH = 7;
    const ARTISAN_TEA_HRID = "/items/artisan_tea";

    /**
     * 获取工匠茶的 artisan buff（考虑饮料浓度）
     */
    function getArtisanBuff(state, drinkConcentration = 0) {
      const teaDetail = getItemDetail(ARTISAN_TEA_HRID, state);
      if (!teaDetail?.consumableDetail?.buffs) return 0;

      for (const buff of teaDetail.consumableDetail.buffs) {
        if (buff.typeHrid === "/buff_types/artisan") {
          return (buff.flatBoost || 0) * (1 + drinkConcentration);
        }
      }
      return 0;
    }

    /**
     * 查找物品的制造配方
     * @returns { actionDetail, actionType } 或 null
     */
    function findManufactureAction(itemHrid) {
      const icd = getInitClientData();
      if (!icd?.actionDetailMap) return null;

      const itemKey = itemHrid.split("/").pop();
      for (const action of MANUFACTURE_ACTIONS) {
        const actionHrid = `/actions/${action}/${itemKey}`;
        const actionDetail = icd.actionDetailMap[actionHrid];
        if (actionDetail && actionDetail.inputItems) {
          return { actionDetail, actionType: action };
        }
      }
      return null;
    }

    /**
     * 递归计算制造成本（Best Crafting Plan，考虑工匠茶）
     * @param artisanBuff 工匠茶减少材料消耗的比例
     * @returns { cost, steps, actionType } 或 null
     */
    function calcManufactureCost(itemHrid, artisanBuff = 0, depth = 0) {
      if (depth > MAX_CRAFT_DEPTH) return null;

      // 查找制造配方
      const found = findManufactureAction(itemHrid);
      if (!found) return null;

      const { actionDetail, actionType } = found;
      let totalCost = 0;
      let maxSteps = 1;

      // 如果有 upgradeItemHrid（精炼需要的基础装备）
      if (actionDetail.upgradeItemHrid) {
        const marketPrice = getMarketAskPrice(actionDetail.upgradeItemHrid, 0);
        const sub = calcManufactureCost(actionDetail.upgradeItemHrid, artisanBuff, depth + 1);

        // 比较市场价和制造成本，选择更低的
        if (marketPrice > 0 && sub && sub.cost > 0) {
          if (sub.cost < marketPrice) {
            totalCost += sub.cost;
            maxSteps = Math.max(maxSteps, sub.steps + 1);
          } else {
            totalCost += marketPrice;
          }
        } else if (marketPrice > 0) {
          totalCost += marketPrice;
        } else if (sub && sub.cost > 0) {
          totalCost += sub.cost;
          maxSteps = Math.max(maxSteps, sub.steps + 1);
        } else {
          return null;
        }
      }

      // 计算所有输入材料的成本（应用工匠茶减少材料消耗）
      // 材料只看市场价，不递归制造
      const materialMultiplier = 1 - artisanBuff;
      for (const input of actionDetail.inputItems) {
        const count = (input.count || 1) * materialMultiplier;
        const marketPrice = getMarketAskPrice(input.itemHrid, 0);
        if (marketPrice > 0) {
          totalCost += marketPrice * count;
        } else {
          return null;
        }
      }

      return { cost: totalCost, steps: maxSteps, actionType };
    }

    /**
     * 获取白板价格（选择市场价和制造成本中更低的）
     * @param state 游戏状态（用于获取工匠茶buff）
     * @param drinkConcentration 饮料浓度
     * @returns { price, source } - source: "市场价" 或 "N步锻造/制造/裁缝"
     */
    function getWhiteItemPriceWithSource(itemHrid, state, drinkConcentration = 0) {
      const marketPrice = getMarketAskPrice(itemHrid, 0);
      const artisanBuff = getArtisanBuff(state, drinkConcentration);
      const craftResult = calcManufactureCost(itemHrid, artisanBuff, 0);

      const hasMarket = marketPrice > 0;
      const hasCraft = craftResult && craftResult.cost > 0;

      if (hasMarket && hasCraft) {
        // 两者都有，选更便宜的
        if (craftResult.cost < marketPrice) {
          const actionName = MANUFACTURE_NAMES[craftResult.actionType] || craftResult.actionType;
          return { price: craftResult.cost, source: `${craftResult.steps}步${actionName}` };
        } else {
          return { price: marketPrice, source: "市场价" };
        }
      } else if (hasMarket) {
        return { price: marketPrice, source: "市场价" };
      } else if (hasCraft) {
        const actionName = MANUFACTURE_NAMES[craftResult.actionType] || craftResult.actionType;
        return { price: craftResult.cost, source: `${craftResult.steps}步${actionName}` };
      }
      return { price: 0, source: null };
    }

    function computeEnhanceMetrics(itemHrid, targetLevel, protectLevel, originLevel, buffs, state) {
      const result = enhancelate(itemHrid, targetLevel, protectLevel, originLevel, -1, buffs, state);
      if (!result) return null;

      const icd = getInitClientData();
      const actionDetail = icd?.actionDetailMap?.[ENHANCE_ACTION_HRID];
      const baseTimeCostNs = actionDetail?.baseTimeCost || 8e9;

      const item = getItemDetail(itemHrid, state);
      const rawLevel = getSkillLevel(state, ENHANCE_SKILL_HRID);
      const playerLevel = rawLevel + getBuffOf(buffs, "Level");
      const itemLevel = item?.itemLevel || 0;

      const speedBuff = getBuffOf(buffs, "Speed");
      const speedFromLevel = Math.max(0, playerLevel - itemLevel) * 0.01;
      // Keep the time model finite if a malformed/negative buff is received.
      const totalSpeed = Math.max(0.01, 1 + speedBuff + speedFromLevel);

      const timeCostNs = baseTimeCostNs / totalSpeed;
      const effectiveTimeCostNs = Math.max(timeCostNs, MIN_TIME_COST_NS);
      const actionsPH = NS_PER_HOUR / effectiveTimeCostNs;

      const {
        actions, protects, exp, targetRate, leapRate, escapeRate,
        varActions, varProtects, covActProt
      } = result;
      const successRate = targetRate + leapRate;

      // 检查材料价格是否完整
      const enhancementCosts = item?.enhancementCosts || [];
      let matCostPerAction = 0;
      for (const mat of enhancementCosts) {
        const price = getMarketAskPrice(mat.itemHrid, 0);
        if (price <= 0) return null; // 材料价格缺失
        matCostPerAction += (mat.count || 0) * price;
      }

      // 检查白板价格（选择市场价和制造成本中更低的，制造成本考虑工匠茶）
      const drinkConcentration = buffs.drinkConcentration || 0;
      const whitePriceInfo = getWhiteItemPriceWithSource(itemHrid, state, drinkConcentration);
      if (whitePriceInfo.price <= 0) return null; // 白板价格缺失且无法制造
      const whitePrice = whitePriceInfo.price;
      const whiteSource = whitePriceInfo.source;

      // 保护材料选择：专属保护材料（或白板本体） + 保护之镜，取最便宜的
      const MIRROR_HRID = "/items/mirror_of_protection";
      const protectionCandidates = [];
      if (item?.protectionItemHrids && item.protectionItemHrids.length > 0) {
        for (const hrid of item.protectionItemHrids) {
          const price = getMarketAskPrice(hrid, 0);
          if (price > 0) protectionCandidates.push({ hrid, price });
        }
      } else {
        const selfPrice = getMarketAskPrice(itemHrid, 0);
        if (selfPrice > 0) protectionCandidates.push({ hrid: itemHrid, price: selfPrice });
      }
      const mirrorPrice = getMarketAskPrice(MIRROR_HRID, 0);
      if (mirrorPrice > 0) protectionCandidates.push({ hrid: MIRROR_HRID, price: mirrorPrice });

      // 如果需要保护但没有可用的保护材料价格，返回 null
      if (protectionCandidates.length === 0) return null;

      const bestProtection = protectionCandidates.reduce((a, b) => a.price < b.price ? a : b);
      const protectionPrice = bestProtection.price;

      // 消耗 = 材料成本 + 保护材料成本
      const consumeCost = matCostPerAction * actions + protectionPrice * protects;
      const totalCostNoHourly = consumeCost + whitePrice;

      const expBuff = getBuffOf(buffs, "Experience");
      const totalExp = exp * (1 + expBuff);
      const totalTimeHours = actions / actionsPH;
      const expPerHour = totalTimeHours > 0 ? totalExp / totalTimeHours : 0;

      return {
        actions, protects, actionsPH, successRate, escapeRate,
        totalCostNoHourly, totalTimeHours, expPerHour,
        consumeCost, whitePrice, whiteSource,
        // 风险调整所需的中间量（材料/保护单价视为确定性市场价）
        matCostPerAction, protectionPrice,
        varActions, varProtects, covActProt
      };
    }

    /**
     * 根据市场挂单价格（productPrice）计算工时费
     * 使用 enhancer 页面的简单公式：
     * hourlyCost = (productPrice * 0.98 - totalCostNoHourly) / actions * actionsPH
     */
    function calcHourlyCost(metrics, productPrice) {
      const profit = productPrice * SELL_TAX_FACTOR - metrics.totalCostNoHourly;
      return profit / metrics.actions * metrics.actionsPH;
    }

    /**
     * 风险调整工时费 = (利润/项目 - γ·Var[利润/项目]/(2W)) · 项目数/小时
     * 等价写法：= 工时费 - γ·Var[利润/小时]/(2W)
     * 只把 actions / protects 视作随机量（材料单价、保护单价、白板价、产出价均视为确定性市场价）。
     * W 为玩家流动资产，缺失或非正数则返回 null。
     */
    function calcRiskAdjustedHourlyCost(metrics, productPrice, totalAsset, riskAversion = 1) {
      if (!Number.isFinite(totalAsset) || totalAsset <= 0) return null;
      const hourly = calcHourlyCost(metrics, productPrice);
      if (!Number.isFinite(hourly)) return null;

      const cm = metrics.matCostPerAction || 0;
      const cp = metrics.protectionPrice || 0;
      const varProj = cm * cm * (metrics.varActions || 0)
        + cp * cp * (metrics.varProtects || 0)
        + 2 * cm * cp * (metrics.covActProt || 0);
      if (!Number.isFinite(varProj) || varProj < 0) return hourly;

      const projectsPerHour = metrics.actions > 0 ? metrics.actionsPH / metrics.actions : 0;
      const varHourly = varProj * projectsPerHour;
      const penalty = riskAversion * varHourly / (2 * totalAsset);
      return hourly - penalty;
    }

    /**
     * 遍历所有合理的 protectLevel，返回 hourlyCost 最大的（和 milkonomy 高亮逻辑一致）
     */
    function computeBestMetrics(itemHrid, targetLevel, buffs, state, productPrice = null) {
      if (productPrice === null) {
        productPrice = getMarketAskPrice(itemHrid, targetLevel);
      }

      let best = null;
      let bestHourlyCost = -Infinity;
      for (let pl = 1; pl <= targetLevel; pl++) {
        const d = computeEnhanceMetrics(itemHrid, targetLevel, pl, 0, buffs, state);
        if (!d) continue;
        const hourlyCost = calcHourlyCost(d, productPrice);
        if (hourlyCost > bestHourlyCost) {
          bestHourlyCost = hourlyCost;
          best = { ...d, protectLevel: pl };
        }
      }
      return best;
    }

    // ═══════════════════════════════════════════════
    //  自定义 Tooltip
    // ═══════════════════════════════════════════════

    let tooltipStyleInjected = false;
    let tooltipEl = null;
    let tooltipHideTimer = null;

    function injectTooltipStyle() {
      if (tooltipStyleInjected) return;
      tooltipStyleInjected = true;
      const style = document.createElement("style");
      style.textContent = `
        .hrshow-tooltip {
          position: fixed;
          z-index: 99999;
          pointer-events: none;
          background: rgba(20, 20, 30, 0.95);
          color: #e0e0e0;
          border: 1px solid #555;
          border-radius: 6px;
          padding: 8px 12px;
          font-size: 12px;
          line-height: 1.6;
          white-space: pre-line;
          max-width: 360px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.5);
          opacity: 0;
          transition: opacity 0.15s ease;
        }
        .hrshow-tooltip.visible { opacity: 1; }
        .hrshow-tooltip .tt-label { color: #aaa; }
        .hrshow-tooltip .tt-value { color: #FFD700; }
        .hrshow-tooltip .tt-profit-pos { color: #67c23a; }
        .hrshow-tooltip .tt-profit-neg { color: #FF6666; }
        .hrshow-tooltip .tt-header {
          color: #fff;
          font-weight: bold;
          margin-bottom: 4px;
          border-bottom: 1px solid #444;
          padding-bottom: 4px;
        }
      `;
      document.head.appendChild(style);
    }

    function getTooltipEl() {
      if (tooltipEl && document.body.contains(tooltipEl)) return tooltipEl;
      tooltipEl = document.createElement("div");
      tooltipEl.className = "hrshow-tooltip";
      document.body.appendChild(tooltipEl);
      return tooltipEl;
    }

    function clearTooltipHideTimer() {
      if (!tooltipHideTimer) return;
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }

    function scheduleTooltipHide(delay = 3000) {
      clearTooltipHideTimer();
      tooltipHideTimer = setTimeout(() => {
        hideTooltip();
      }, delay);
    }

    function getEventPoint(e) {
      if (e?.touches?.[0]) {
        return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
      }
      if (e?.changedTouches?.[0]) {
        return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
      }
      if (Number.isFinite(e?.clientX) && Number.isFinite(e?.clientY)) {
        return { clientX: e.clientX, clientY: e.clientY };
      }
      return null;
    }

    function showTooltip(e, html, anchorEl = null) {
      const tip = getTooltipEl();
      tip.innerHTML = html;
      tip.classList.add("visible");
      positionTooltip(e, tip, anchorEl);
    }

    function positionTooltip(e, tip, anchorEl = null) {
      const pad = 12;
      const point = getEventPoint(e);
      let x;
      let y;
      if (point) {
        x = point.clientX + pad;
        y = point.clientY + pad;
      } else if (anchorEl?.getBoundingClientRect) {
        const anchorRect = anchorEl.getBoundingClientRect();
        x = anchorRect.left + anchorRect.width / 2 + pad;
        y = anchorRect.top + anchorRect.height / 2 + pad;
      } else {
        x = pad;
        y = pad;
      }
      const rect = tip.getBoundingClientRect();
      if (x + rect.width > window.innerWidth - pad) {
        x = point ? point.clientX - rect.width - pad : window.innerWidth - rect.width - pad;
      }
      if (y + rect.height > window.innerHeight - pad) {
        y = point ? point.clientY - rect.height - pad : window.innerHeight - rect.height - pad;
      }
      tip.style.left = Math.max(pad, x) + "px";
      tip.style.top = Math.max(pad, y) + "px";
    }

    function hideTooltip() {
      clearTooltipHideTimer();
      const tip = getTooltipEl();
      tip.classList.remove("visible");
    }

    function bindTooltip(el, htmlContent) {
      el.addEventListener("click", e => {
        e.stopPropagation();
        showTooltip(e, htmlContent, el);
        scheduleTooltipHide(3000);
      });
    }

    function buildTooltipHtml(enhancementLevel, metrics, price, totalAsset) {
      const afterTax = price * SELL_TAX_FACTOR;
      const profitPerItem = afterTax - metrics.totalCostNoHourly;
      const hourlyCost = calcHourlyCost(metrics, price);
      const profitClass = profitPerItem >= 0 ? "tt-profit-pos" : "tt-profit-neg";
      let html = `<div class="tt-header">0→+${enhancementLevel} (保护+${metrics.protectLevel})</div>`
        + `<span class="tt-label">挂单价:</span> <span class="tt-value">${formatMoney(price)}</span>\n`
        + `<span class="tt-label">税后:</span> <span class="tt-value">${formatMoney(afterTax)}</span>\n`
        + `<span class="tt-label">白板(${metrics.whiteSource}):</span> <span class="tt-value">${formatMoney(metrics.whitePrice)}</span>\n`
        + `<span class="tt-label">强化消耗:</span> <span class="tt-value">${formatMoney(metrics.consumeCost)}</span>\n`
        + `<span class="tt-label">总成本:</span> <span class="tt-value">${formatMoney(metrics.totalCostNoHourly)}</span>\n`
        + `<span class="tt-label">单件利润:</span> <span class="${profitClass}">${formatMoney(profitPerItem)}</span>\n`
        + `<span class="tt-label">工时费/h:</span> <span class="${hourlyCost >= 0 ? "tt-profit-pos" : "tt-profit-neg"}">${formatMoney(hourlyCost)}</span>\n`;

      const riskHourly = calcRiskAdjustedHourlyCost(metrics, price, totalAsset);
      if (Number.isFinite(riskHourly)) {
        html += `<span class="tt-label">风控工时费/h:</span> <span class="${riskHourly >= 0 ? "tt-profit-pos" : "tt-profit-neg"}">${formatMoney(riskHourly)}</span>\n`
          + `<span class="tt-label">流动资产W:</span> <span class="tt-value">${formatMoney(totalAsset)}</span>\n`;
      }

      html += `<span class="tt-label">期望动作:</span> <span class="tt-value">${Math.round(metrics.actions)}</span>\n`
        + `<span class="tt-label">每小时动作:</span> <span class="tt-value">${metrics.actionsPH.toFixed(1)}</span>`;
      return html;
    }

    // ═══════════════════════════════════════════════
    //  DOM 操作
    // ═══════════════════════════════════════════════

    const MARKER_CLASS = "HourlyRateShowInfo";
    const MARKER_SET_CLASS = "HourlyRateShowInfoSet";

    function clearAllInserted() {
      document.querySelectorAll(`.${MARKER_SET_CLASS}`).forEach(n => n.classList.remove(MARKER_SET_CLASS));
      document.querySelectorAll(`.${MARKER_CLASS}`).forEach(n => n.remove());
      hideTooltip();
    }

    function formatMoney(value) {
      if (!Number.isFinite(value)) return "N/A";
      const abs = Math.abs(value);
      const sign = value < 0 ? "-" : "";
      if (abs < 1000) return sign + Math.round(abs).toString();
      if (abs < 1e6) return sign + (abs / 1000).toFixed(1) + "K";
      if (abs < 1e9) return sign + (abs / 1e6).toFixed(2) + "M";
      return sign + (abs / 1e9).toFixed(2) + "B";
    }

    function parsePrice(priceText) {
      if (!priceText) return 0;
      const text = String(priceText).replace(/[^\d.KMBkmb]/g, "").toUpperCase();
      const number = parseFloat(text.replace(/[KMB]/g, ""));
      if (!Number.isFinite(number)) return 0;
      if (text.includes("B")) return number * 1e9;
      if (text.includes("M")) return number * 1e6;
      if (text.includes("K")) return number * 1e3;
      return number;
    }

    // ═══════════════════════════════════════════════
    //  读取 MWITools 插件注入的流动资产
    //  DOM 结构：在 div[class*="Header_totalLevel"] 之后紧跟一个 div，
    //  内容形如 "Current Assets: 12.34B / 9.87B ..."
    //  取左侧 networthAsk 作为 W。找不到/解析失败返回 null。
    // ═══════════════════════════════════════════════
    let _currentAssetsCache = { value: null, time: 0 };
    function getCurrentAssetsFromMWITools() {
      const now = Date.now();
      if (now - _currentAssetsCache.time < 5000) return _currentAssetsCache.value;

      let value = null;
      try {
        const header = document.querySelector('div[class*="Header_totalLevel"]');
        let el = header?.nextElementSibling;
        // 若 MWITools 还未注入，兜底扫描一次
        const assetPattern = /(?:Current Assets|当前资产)\s*[:：]\s*([\d.,]+\s*[KMBkmb]?)/i;
        if (!el || !assetPattern.test(el.textContent || "")) {
          el = null;
          const candidates = document.querySelectorAll('div,span');
          for (const c of candidates) {
            const t = c.textContent || "";
            if (assetPattern.test(t) && t.length < 200) { el = c; break; }
          }
        }
        if (el) {
          const text = el.textContent || "";
          const m = text.match(assetPattern);
          if (m) {
            const v = parsePrice(m[1]);
            if (Number.isFinite(v) && v > 0) value = v;
          }
        }
      } catch (_) {
        value = null;
      }
      _currentAssetsCache = { value, time: now };
      return value;
    }

    function formatExp(exp) {
      if (!Number.isFinite(exp) || exp < 0) return "N/A";
      if (exp < 1000) return Math.round(exp).toString();
      if (exp < 1e6) return (exp / 1000).toFixed(1) + "K";
      return (exp / 1e6).toFixed(2) + "M";
    }

    function insertOrderBooksInfo(rootNode) {
      const container = rootNode.querySelector('[class*="MarketplacePanel_orderBooksContainer"]');
      if (!container) return;

      const askTable = container.firstChild?.firstChild;
      const bidTable = container.lastChild?.firstChild;
      if (!askTable || !bidTable) return;

      if (askTable.classList.contains(MARKER_SET_CLASS)) return;

      const itemNode = rootNode.querySelector('[class*="MarketplacePanel_currentItem"] [class*="Item_item"]');
      if (!itemNode) return;

      const svgUse = itemNode.querySelector("use");
      if (!svgUse) return;
      const svgHref = svgUse.href?.baseVal || svgUse.getAttribute("href") || "";
      const itemKey = svgHref.split("#")[1];
      if (!itemKey) return;
      const itemHrid = "/items/" + itemKey;

      const enhanceLevelNode = itemNode.querySelector('[class*="Item_enhancementLevel"]');
      const enhancementLevel = enhanceLevelNode
        ? Number(enhanceLevelNode.textContent.replace(/\+/g, ""))
        : 0;

      if (enhancementLevel < 1) return;

      const state = getGameState();
      if (!state) { console.warn("[HourlyRate] gameState not found"); return; }

      const item = getItemDetail(itemHrid, state);
      if (!item?.enhancementCosts) return;

      clearAllInserted();

      const buffs = computeEnhancingBuffs(state);
      if (!buffs) return;

      // 缓存不同价格对应的最优 metrics
      const metricsCache = new Map();
      function getMetricsForPrice(price) {
        if (metricsCache.has(price)) return metricsCache.get(price);
        const m = computeBestMetrics(itemHrid, enhancementLevel, buffs, state, price);
        metricsCache.set(price, m);
        return m;
      }

      function createInfoCell(text = "") {
        const td = document.createElement("td");
        td.classList.add(MARKER_CLASS);
        td.style.cssText = "font-size:0.7rem;white-space:nowrap;text-align:center;padding:2px 4px;";
        td.textContent = text;
        return td;
      }

      function setPendingCell(td) {
        td.textContent = "...";
        td.style.color = "#888";
      }

      function setUnavailableCell(td) {
        td.textContent = "-";
        td.style.color = "#888";
      }

      function scheduleFillCells(fn) {
        setTimeout(fn, 0);
      }

      function injectTable(tableNode, isAskSide) {
        tableNode.classList.add(MARKER_SET_CLASS);

        const thead = tableNode.querySelector("thead tr");
        if (!thead) return;

        const rateTh = document.createElement("th");
        rateTh.textContent = "工时费/h";
        rateTh.classList.add(MARKER_CLASS);
        rateTh.style.cssText = "font-size:0.7rem;color:#FFD700;white-space:nowrap;text-align:center;padding:2px 4px;";
        thead.insertBefore(rateTh, thead.lastChild);

        const riskTh = document.createElement("th");
        riskTh.textContent = "风控工时费/h";
        riskTh.classList.add(MARKER_CLASS);
        riskTh.style.cssText = "font-size:0.7rem;color:#FFB86B;white-space:nowrap;text-align:center;padding:2px 4px;";
        thead.insertBefore(riskTh, thead.lastChild);

        const expTh = document.createElement("th");
        expTh.textContent = "经验/h";
        expTh.classList.add(MARKER_CLASS);
        expTh.style.cssText = "font-size:0.7rem;color:#AAFFAA;white-space:nowrap;text-align:center;padding:2px 4px;";
        thead.insertBefore(expTh, thead.lastChild);

        // 行渲染里会用到；为整块表格只读取一次 W
        const totalAsset = getCurrentAssetsFromMWITools();

        const listings = getOrderBookListings(itemHrid, enhancementLevel, isAskSide);

        const rows = tableNode.querySelectorAll("tbody tr");
        const fillJobs = [];
        let lastPrice = null;
        let rowIndex = 0;

        for (const row of rows) {
          const listing = listings[rowIndex];
          const price = listing?.price || 0;
          const isFirstOfPrice = price !== lastPrice;
          lastPrice = price;

          const rateTd = createInfoCell();
          const riskTd = createInfoCell();
          const expTd = createInfoCell();
          if (isFirstOfPrice) {
            setPendingCell(rateTd);
            setPendingCell(expTd);
            if (totalAsset) setPendingCell(riskTd);
          }
          row.insertBefore(rateTd, row.lastChild);
          row.insertBefore(riskTd, row.lastChild);
          row.insertBefore(expTd, row.lastChild);

          fillJobs.push({ rateTd, riskTd, expTd, price, isFirstOfPrice });

          rowIndex++;
        }

        scheduleFillCells(() => {
          if (!tableNode.isConnected || !tableNode.classList.contains(MARKER_SET_CLASS)) return;
          for (const job of fillJobs) {
            if (!job.isFirstOfPrice) continue;
            const { rateTd, riskTd, expTd, price } = job;
            if (!Number.isFinite(price) || price <= 0) {
              setUnavailableCell(rateTd);
              setUnavailableCell(expTd);
              continue;
            }

            // 针对每个价格计算最优保护等级；列已经占位，这里只回填内容。
            const metrics = getMetricsForPrice(price);
            if (!metrics) {
              setUnavailableCell(rateTd);
              setUnavailableCell(expTd);
              continue;
            }

            const hourlyCost = calcHourlyCost(metrics, price);
            rateTd.textContent = formatMoney(hourlyCost);
            rateTd.style.color = hourlyCost >= 0 ? "#FFD700" : "#FF6666";
            rateTd.style.cursor = "help";
            bindTooltip(rateTd, buildTooltipHtml(enhancementLevel, metrics, price, totalAsset));

            // 风控工时费列：检测到流动资产才计算，否则留空
            const riskHourly = calcRiskAdjustedHourlyCost(metrics, price, totalAsset);
            if (Number.isFinite(riskHourly)) {
              riskTd.textContent = formatMoney(riskHourly);
              riskTd.style.color = riskHourly >= 0 ? "#FFB86B" : "#FF6666";
              riskTd.style.cursor = "help";
              bindTooltip(riskTd, buildTooltipHtml(enhancementLevel, metrics, price, totalAsset));
            } else {
              riskTd.textContent = "";
            }

            // 经验列也使用该价格对应的 metrics
            expTd.textContent = formatExp(metrics.expPerHour);
            expTd.style.color = "#AAFFAA";
          }
        });
      }

      injectTable(askTable, true);
      injectTable(bidTable, false);
    }

    // ═══════════════════════════════════════════════
    //  私人功能：侧栏“强化榜”标签页
    //  只读取已缓存的公开市场快照与本地游戏状态。
    //  不调用游戏 API、不发送 WebSocket 消息、不逐物品请求订单簿。
    // ═══════════════════════════════════════════════

    const rankingUi = {
      tab: null,
      panel: null,
      hiddenSidebarNodes: [],
      rows: [],
      calculating: false,
      calculationToken: 0,
      integrationTimer: null,
      activationScheduled: false
    };

    function escapeRankingHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function createRankingPanel() {
      const panel = document.createElement("section");
      panel.id = "enhance-hourly-ranking-panel";
      panel.innerHTML = `
        <style>
          #enhance-hourly-ranking-panel[hidden]{display:none!important}
          #enhance-hourly-ranking-panel{height:100%;min-height:0;overflow:hidden;color:#e7e8f5;background:#171824;font-size:12px}
          #enhance-hourly-ranking-panel *{box-sizing:border-box}
          #enhance-hourly-ranking-panel .ehr-wrap{height:100%;display:flex;flex-direction:column;min-height:0;padding:10px}
          #enhance-hourly-ranking-panel .ehr-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
          #enhance-hourly-ranking-panel h3{margin:0;color:#fff;font-size:15px}
          #enhance-hourly-ranking-panel .ehr-note{margin:0 0 8px;color:#aeb1ca;line-height:1.45}
          #enhance-hourly-ranking-panel .ehr-controls{display:grid;grid-template-columns:minmax(120px,1fr) minmax(95px,.65fr) 82px auto;gap:6px;margin-bottom:8px}
          #enhance-hourly-ranking-panel input,#enhance-hourly-ranking-panel select,#enhance-hourly-ranking-panel button{min-height:30px;border:1px solid #454864;border-radius:4px;background:#25273a;color:#f3f3fa;padding:4px 7px}
          #enhance-hourly-ranking-panel button{border-color:#43c4ad;background:#43c4ad;color:#10201f;font-weight:700;cursor:pointer}
          #enhance-hourly-ranking-panel button:disabled{opacity:.55;cursor:wait}
          #enhance-hourly-ranking-panel .ehr-status{min-height:18px;margin-bottom:6px;color:#c9cbeb}
          #enhance-hourly-ranking-panel .ehr-table-wrap{flex:1;min-height:0;overflow:auto;border:1px solid #35384f;border-radius:4px}
          #enhance-hourly-ranking-panel table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:11px}
          #enhance-hourly-ranking-panel th{position:sticky;top:0;z-index:1;background:#25273a;color:#dfe1f4;text-align:right;padding:6px;border-bottom:1px solid #4a4d69}
          #enhance-hourly-ranking-panel th:nth-child(1),#enhance-hourly-ranking-panel th:nth-child(2){text-align:left}
          #enhance-hourly-ranking-panel td{padding:5px 6px;text-align:right;border-bottom:1px solid #2c2e42}
          #enhance-hourly-ranking-panel td:nth-child(1),#enhance-hourly-ranking-panel td:nth-child(2){text-align:left}
          #enhance-hourly-ranking-panel tbody tr:hover{background:#242638}
          #enhance-hourly-ranking-panel .ehr-positive{color:#7be0bc}
          #enhance-hourly-ranking-panel .ehr-negative{color:#ff7b82}
          #enhance-hourly-ranking-panel .ehr-muted{color:#888ca7}
          [data-enhance-ranking-tab="true"]{user-select:none;pointer-events:auto!important;cursor:pointer!important}
          @media (max-width:900px){#enhance-hourly-ranking-panel .ehr-controls{grid-template-columns:1fr 1fr}#enhance-hourly-ranking-panel .ehr-controls button{grid-column:span 2}}
        </style>
        <div class="ehr-wrap">
          <div class="ehr-title"><h3>强化收购价排行榜</h3><span>0 → 目标等级</span></div>
          <p class="ehr-note">仅使用公开市场快照中的最高收购价（Bid），按税后 98% 收入计算。排行榜计算完全在本地完成。</p>
          <div class="ehr-controls">
            <input data-role="ranking-search" type="search" placeholder="筛选物品名称 / HRID">
            <select data-role="ranking-sort" title="排序指标">
              <option value="hourly">工时费/h 从高到低</option>
              <option value="risk">风控工时费/h 从高到低</option>
              <option value="exp">经验/h 从高到低</option>
            </select>
            <select data-role="ranking-limit" title="显示数量">
              <option value="50">前 50</option>
              <option value="100">前 100</option>
              <option value="250">前 250</option>
              <option value="0">全部</option>
            </select>
            <button data-role="ranking-refresh" type="button">本地重算</button>
          </div>
          <div class="ehr-status" data-role="ranking-status">打开标签页后开始计算。</div>
          <div class="ehr-table-wrap">
            <table>
              <thead><tr>
                <th>#</th><th>物品</th><th>目标</th><th>最高收购价</th><th>工时费/h</th><th>风控工时费/h</th><th>经验/h</th><th>保护起点</th><th>预计成本</th><th>预计耗时</th>
              </tr></thead>
              <tbody data-role="ranking-body"></tbody>
            </table>
          </div>
        </div>`;

      panel.querySelector('[data-role="ranking-sort"]').addEventListener("change", () => renderRankingRows(panel));
      panel.querySelector('[data-role="ranking-limit"]').addEventListener("change", () => renderRankingRows(panel));
      panel.querySelector('[data-role="ranking-search"]').addEventListener("input", () => renderRankingRows(panel));
      panel.querySelector('[data-role="ranking-refresh"]').addEventListener("click", () => calculateRanking(panel, true));
      return panel;
    }

    function rankingValueClass(value) {
      if (!Number.isFinite(value)) return "ehr-muted";
      return value >= 0 ? "ehr-positive" : "ehr-negative";
    }

    function formatRankingHours(hours) {
      if (!Number.isFinite(hours)) return "N/A";
      if (hours < 1 / 60) return `${Math.max(1, Math.round(hours * 3600))}秒`;
      if (hours < 1) return `${(hours * 60).toFixed(1)}分`;
      return `${hours.toFixed(hours < 10 ? 2 : 1)}时`;
    }

    function renderRankingRows(panel) {
      if (!panel || !panel.isConnected) return;
      const body = panel.querySelector('[data-role="ranking-body"]');
      const status = panel.querySelector('[data-role="ranking-status"]');
      const sortKey = panel.querySelector('[data-role="ranking-sort"]').value;
      const limit = Number(panel.querySelector('[data-role="ranking-limit"]').value);
      const query = panel.querySelector('[data-role="ranking-search"]').value.trim().toLowerCase();
      const valueKey = sortKey === "risk" ? "riskHourly" : sortKey === "exp" ? "expPerHour" : "hourly";

      let rows = rankingUi.rows.filter((row) => {
        if (sortKey === "risk" && !Number.isFinite(row.riskHourly)) return false;
        return !query || row.itemName.toLowerCase().includes(query) || row.itemHrid.toLowerCase().includes(query);
      });
      rows.sort((a, b) => {
        const av = Number.isFinite(a[valueKey]) ? a[valueKey] : -Infinity;
        const bv = Number.isFinite(b[valueKey]) ? b[valueKey] : -Infinity;
        return bv - av || b.bidPrice - a.bidPrice;
      });
      const totalMatched = rows.length;
      if (limit > 0) rows = rows.slice(0, limit);

      body.innerHTML = rows.map((row, index) => `
        <tr title="${escapeRankingHtml(row.itemHrid)}">
          <td>${index + 1}</td>
          <td>${escapeRankingHtml(row.itemName)}</td>
          <td>+${row.targetLevel}</td>
          <td>${formatMoney(row.bidPrice)}</td>
          <td class="${rankingValueClass(row.hourly)}">${formatMoney(row.hourly)}</td>
          <td class="${rankingValueClass(row.riskHourly)}">${Number.isFinite(row.riskHourly) ? formatMoney(row.riskHourly) : "N/A"}</td>
          <td>${formatExp(row.expPerHour)}</td>
          <td>+${row.protectLevel}</td>
          <td>${formatMoney(row.totalCost)}</td>
          <td>${formatRankingHours(row.totalTimeHours)}</td>
        </tr>`).join("");

      if (!rankingUi.calculating) {
        const riskNote = sortKey === "risk" && totalMatched === 0
          ? "；未从 MWITools 识别到流动资产，无法计算风控时薪"
          : "";
        status.textContent = `共 ${rankingUi.rows.length} 个有效收购项目，当前显示 ${rows.length} 个${riskNote}`;
      }
    }

    function getRankingJobs(state) {
      const market = getMarketCache();
      const jobs = [];
      for (const [itemHrid, levels] of Object.entries(market || {})) {
        const item = getItemDetail(itemHrid, state);
        if (!item?.enhancementCosts || !levels || typeof levels !== "object") continue;
        for (const [levelText, quote] of Object.entries(levels)) {
          const targetLevel = Number(levelText);
          const bidPrice = Number(quote?.b);
          if (!Number.isInteger(targetLevel) || targetLevel < 1 || targetLevel > 20) continue;
          if (!Number.isFinite(bidPrice) || bidPrice <= 0) continue;
          jobs.push({ itemHrid, targetLevel, bidPrice, item });
        }
      }
      return jobs;
    }

    function yieldRankingCalculation() {
      return new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    async function calculateRanking(panel, force = false) {
      if (!panel || !panel.isConnected || rankingUi.calculating) return;
      if (!force && rankingUi.rows.length > 0) {
        renderRankingRows(panel);
        return;
      }

      const refreshButton = panel.querySelector('[data-role="ranking-refresh"]');
      const status = panel.querySelector('[data-role="ranking-status"]');
      const state = getGameState();
      if (!state) {
        status.textContent = "无法读取游戏状态。请刷新游戏后重试。";
        return;
      }
      const buffs = computeEnhancingBuffs(state);
      if (!buffs) {
        status.textContent = "无法读取游戏基础数据。请等待游戏加载完成后重试。";
        return;
      }
      const jobs = getRankingJobs(state);
      if (jobs.length === 0) {
        status.textContent = "公开市场快照尚未加载，或没有有效的强化收购报价。";
        return;
      }

      rankingUi.calculating = true;
      rankingUi.rows = [];
      const token = ++rankingUi.calculationToken;
      refreshButton.disabled = true;
      const totalAsset = getCurrentAssetsFromMWITools();
      status.textContent = `准备本地计算 ${jobs.length} 个项目…`;

      try {
        // 先让浏览器完成标签页绘制，再分成短时间片执行强化模拟，避免长时间占用主线程。
        await yieldRankingCalculation();
        let sliceStartedAt = performance.now();
        for (let index = 0; index < jobs.length; index++) {
          if (token !== rankingUi.calculationToken || !panel.isConnected) return;
          const job = jobs[index];
          const metrics = computeBestMetrics(job.itemHrid, job.targetLevel, buffs, state, job.bidPrice);
          if (metrics) {
            const hourly = calcHourlyCost(metrics, job.bidPrice);
            const riskHourly = calcRiskAdjustedHourlyCost(metrics, job.bidPrice, totalAsset);
            if (Number.isFinite(hourly) && Number.isFinite(metrics.expPerHour)) {
              rankingUi.rows.push({
                itemHrid: job.itemHrid,
                itemName: PRIVATE_ZH_ITEM_HRIDS[job.itemHrid]
                  || window.MwiGuildCreditChineseItems?.[job.item?.name]
                  || PRIVATE_ZH_ITEM_NAMES[job.item?.name]
                  || job.item?.name
                  || job.itemHrid.split("/").pop().replaceAll("_", " "),
                targetLevel: job.targetLevel,
                bidPrice: job.bidPrice,
                hourly,
                riskHourly: Number.isFinite(riskHourly) ? riskHourly : null,
                expPerHour: metrics.expPerHour,
                protectLevel: metrics.protectLevel,
                totalCost: metrics.totalCostNoHourly,
                totalTimeHours: metrics.totalTimeHours
              });
            }
          }

          if (performance.now() - sliceStartedAt >= 8 || index === jobs.length - 1) {
            status.textContent = `本地计算中 ${index + 1}/${jobs.length}；没有发送物品或订单请求…`;
            await yieldRankingCalculation();
            sliceStartedAt = performance.now();
          }
        }
      } catch (error) {
        console.error("[HourlyRate Ranking]", error);
        status.textContent = `排行榜计算失败：${error?.message || error}`;
      } finally {
        if (token === rankingUi.calculationToken) {
          rankingUi.calculating = false;
          refreshButton.disabled = false;
          renderRankingRows(panel);
        }
      }
    }

    function findRankingPanelHostNear(tabBar) {
      let current = tabBar;
      for (let depth = 0; current && depth < 8; depth++) {
        const parent = current.parentElement;
        if (!parent) break;
        const direct = Array.from(parent.children).find((node) =>
          node !== current && /tabPanelsContainer/.test(String(node.className))
        );
        if (direct) return direct;
        current = parent;
      }
      const allHosts = document.querySelectorAll('[class*="tabPanelsContainer"]');
      return allHosts.length === 1 ? allHosts[0] : null;
    }

    function findRankingSidebarTabBar() {
      const expectedTabs = new Set([
        "库存", "装备", "技能", "房屋", "配装", "收获",
        "Inventory", "Equipment", "Skills", "House", "Loadout", "Gathering"
      ]);
      const elements = document.getElementsByTagName("*");
      for (let index = 0; index < elements.length; index++) {
        const candidate = elements[index];
        const children = Array.from(candidate.children);
        if (children.length < 4) continue;
        const tabs = children.map((child) => ({
          element: child,
          label: String(child.innerText || child.textContent || "").replaceAll("\n", "").trim()
        }));
        const recognized = tabs.filter((tab) => expectedTabs.has(tab.label));
        if (recognized.length < 4) continue;
        const prototype = recognized.find((tab) => tab.label === "库存" || tab.label === "Inventory") || recognized[0];
        const panelHost = findRankingPanelHostNear(candidate);
        if (panelHost) return { tabBar: candidate, tabPrototype: prototype.element, panelHost };
      }

      // 游戏改版或语言文本变化时，退回到 ARIA 标签结构识别。
      const roleTabLists = document.querySelectorAll('[role="tablist"]');
      for (const tabBar of roleTabLists) {
        const tabs = Array.from(tabBar.children).filter((node) =>
          node.getAttribute("role") === "tab" || /MuiTab-root/.test(String(node.className))
        );
        if (tabs.length < 4) continue;
        const panelHost = findRankingPanelHostNear(tabBar);
        if (!panelHost) continue;
        const prototype = tabs.find((node) => node.classList.contains("Mui-selected")) || tabs[0];
        return { tabBar, tabPrototype: prototype, panelHost };
      }
      return null;
    }

    function hideRankingPanel() {
      if (rankingUi.panel) rankingUi.panel.hidden = true;
      if (rankingUi.tab) {
        rankingUi.tab.classList.remove("Mui-selected");
        rankingUi.tab.setAttribute("aria-selected", "false");
      }
      for (const node of rankingUi.hiddenSidebarNodes) {
        if (!node.isConnected) continue;
        node.style.display = node.dataset.enhanceRankingPreviousDisplay || "";
        delete node.dataset.enhanceRankingPreviousDisplay;
      }
      rankingUi.hiddenSidebarNodes = [];
    }

    function showRankingPanel(panelHost, tabBar) {
      if (!rankingUi.panel?.isConnected || !rankingUi.tab?.isConnected) return;
      hideRankingPanel();
      rankingUi.hiddenSidebarNodes = Array.from(panelHost.children).filter((node) => node !== rankingUi.panel);
      for (const node of rankingUi.hiddenSidebarNodes) {
        node.dataset.enhanceRankingPreviousDisplay = node.style.display;
        node.style.display = "none";
      }
      rankingUi.panel.hidden = false;
      for (const tab of tabBar.children) {
        tab.classList.remove("Mui-selected");
        tab.setAttribute("aria-selected", "false");
      }
      rankingUi.tab.classList.add("Mui-selected");
      rankingUi.tab.setAttribute("aria-selected", "true");
      renderRankingRows(rankingUi.panel);
      window.requestAnimationFrame(() => {
        window.setTimeout(() => calculateRanking(rankingUi.panel), 0);
      });
    }

    function eventHitsRankingTab(event, tab) {
      if (tab.contains(event.target)) return true;
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
      const rect = tab.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
    }

    function prepareRankingTabSwitch(event) {
      const tab = rankingUi.tab;
      if (!tab?.isConnected) return false;
      const tabBar = tab.parentElement;
      if (!tabBar) return false;

      // 在捕获阶段、其他标签处理点击之前退出强化榜，避免覆盖信用榜刚设置的面板状态。
      if (!eventHitsRankingTab(event, tab) && tabBar.contains(event.target)) {
        if (!rankingUi.panel?.hidden) hideRankingPanel();
        return false;
      }
      return eventHitsRankingTab(event, tab);
    }

    function activateRankingTabAfterOthers(event) {
      if (!prepareRankingTabSwitch(event)) return false;
      event.preventDefault();
      if (rankingUi.activationScheduled) return true;
      rankingUi.activationScheduled = true;
      // 不阻断事件；先让信用榜自己的退出监听器完成，再显示强化榜。
      window.setTimeout(() => {
        rankingUi.activationScheduled = false;
        const tab = rankingUi.tab;
        const tabBar = tab?.parentElement;
        const panelHost = tabBar && findRankingPanelHostNear(tabBar);
        if (tabBar && panelHost) showRankingPanel(panelHost, tabBar);
      }, 0);
      return true;
    }

    function ensureRankingSidebarIntegration() {
      if (rankingUi.panel?.isConnected && rankingUi.tab?.isConnected) return;
      const integration = findRankingSidebarTabBar();
      if (!integration) return;
      const { tabBar, tabPrototype, panelHost } = integration;
      const existing = tabBar.querySelector('[data-enhance-ranking-tab="true"]');
      if (existing) existing.remove();

      const tab = tabPrototype.cloneNode(true);
      tab.dataset.enhanceRankingTab = "true";
      tab.classList.remove("Mui-selected");
      tab.removeAttribute("id");
      tab.removeAttribute("disabled");
      tab.removeAttribute("aria-disabled");
      tab.setAttribute("aria-selected", "false");
      tab.setAttribute("role", "tab");
      if ("disabled" in tab) tab.disabled = false;
      tab.replaceChildren(document.createTextNode("强化榜"));
      tabBar.append(tab);

      const panel = createRankingPanel();
      panel.hidden = true;
      panelHost.append(panel);
      rankingUi.tab = tab;
      rankingUi.panel = panel;
    }

    function startRankingTabIntegration() {
      // window 捕获早于两个脚本在 document 上的监听器，确保交接顺序稳定。
      window.addEventListener("pointerdown", prepareRankingTabSwitch, true);
      window.addEventListener("click", activateRankingTabAfterOthers, true);
      rankingUi.integrationTimer = window.setInterval(ensureRankingSidebarIntegration, 3000);
      window.setTimeout(ensureRankingSidebarIntegration, 700);
    }

    // ═══════════════════════════════════════════════
    //  WebSocket Hook（缓存市场数据）
    // ═══════════════════════════════════════════════

    let wsHookInstalled = false;

    function installWsHook() {
      if (wsHookInstalled) return;
      const descriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
      if (!descriptor || typeof descriptor.get !== "function") return;
      const originalGetter = descriptor.get;

      Object.defineProperty(MessageEvent.prototype, "data", {
        ...descriptor,
        get: function () {
          const data = originalGetter.call(this);
          if (this.currentTarget instanceof WebSocket && typeof data === "string") {
            try {
              const msg = JSON.parse(data);
              if (msg?.type === "market_item_order_books_updated" && msg.marketItemOrderBooks) {
                updateMarketCacheFromWS(msg.marketItemOrderBooks);
                clearAllInserted();
              }
            } catch (_) {}
          }
          return data;
        }
      });
      wsHookInstalled = true;
    }

    // ═══════════════════════════════════════════════
    //  DOM Observer
    // ═══════════════════════════════════════════════

    let debounceTimer = null;

    function initObserver() {
      const observer = new MutationObserver(() => {
        if (debounceTimer) return;
        const schedule = typeof queueMicrotask === "function" ? queueMicrotask : (cb) => setTimeout(cb, 0);
        debounceTimer = true;
        schedule(() => {
          debounceTimer = null;
          try {
            insertOrderBooksInfo(document);
          } catch (e) {
            console.error("[HourlyRate]", e);
          }
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    // ═══════════════════════════════════════════════
    //  入口
    // ═══════════════════════════════════════════════

    async function init() {
      console.log("[MWI Private Tools] combined enhance + credit ranking v1.4.0 loaded");
      injectTooltipStyle();
      document.addEventListener("click", hideTooltip);
      window.addEventListener("scroll", hideTooltip, true);
      window.addEventListener("resize", hideTooltip);
      // 标签页不再等待市场网络请求，游戏 UI 出现后即可生成。
      startRankingTabIntegration();
      window.__MWI_PRIVATE_MARKET_PROMISE__ = window.__MWI_PRIVATE_MARKET_PROMISE__ || fetchMarketApi();
      await window.__MWI_PRIVATE_MARKET_PROMISE__;
      if (!legacyHourlyRateAlreadyRunning) {
        installWsHook();
        initObserver();
      }
      if (rankingUi.panel?.isConnected && !rankingUi.panel.hidden && rankingUi.rows.length === 0) {
        calculateRanking(rankingUi.panel, true);
      }
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
      setTimeout(init, 500);
    } else {
      document.addEventListener("DOMContentLoaded", () => setTimeout(init, 500));
    }
  })();

// ===== 内置：银河奶牛公会信用点性价比 v0.4.9（合并优化） =====
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.MwiGuildCreditLocalization = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CHARM_TIERS = Object.freeze({
    Trainee: "实习",
    Basic: "基础",
    Advanced: "高级",
    Expert: "专家",
    Master: "大师",
    Grandmaster: "宗师"
  });
  const CHARM_ATTRIBUTES = Object.freeze({
    Milking: "挤奶",
    Foraging: "采摘",
    Woodcutting: "伐木",
    Crafting: "制作",
    Tailoring: "缝纫",
    Cooking: "烹饪",
    Brewing: "冲泡",
    Alchemy: "炼金",
    Enhancing: "强化",
    Stamina: "耐力",
    Intelligence: "智力",
    Attack: "攻击",
    Defense: "防御",
    Melee: "近战",
    Ranged: "远程",
    Magic: "魔法"
  });

  function simpleItemName(itemHrid) {
    return String(itemHrid || "").split("/").pop().replaceAll("_", " ");
  }

  function titleCase(value) {
    return String(value || "").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function normalizeLocale(locale) {
    const value = String(locale || "").toLowerCase();
    if (value.startsWith("zh")) return "zh-CN";
    if (value.startsWith("en")) return "en";
    return "en";
  }

  function chineseItemName(englishName, dictionary) {
    if (dictionary[englishName]) return dictionary[englishName];

    const refined = englishName.match(/^(.*) Refined$/);
    if (refined && dictionary[refined[1]]) return `${dictionary[refined[1]]}（精）`;

    const ultraTea = englishName.match(/^Ultra (.+ Tea)$/);
    if (ultraTea && dictionary[ultraTea[1]]) return `究极${dictionary[ultraTea[1]]}`;

    const charm = englishName.match(/^(Trainee|Basic|Advanced|Expert|Master|Grandmaster) (Milking|Foraging|Woodcutting|Crafting|Tailoring|Cooking|Brewing|Alchemy|Enhancing|Stamina|Intelligence|Attack|Defense|Melee|Ranged|Magic) Charm$/);
    if (charm) return `${CHARM_TIERS[charm[1]]}${CHARM_ATTRIBUTES[charm[2]]}护符`;

    return englishName;
  }

  function localizeItemName(options) {
    const itemName = options && options.itemName;
    const itemHrid = options && options.itemHrid;
    const dictionary = options && options.chineseNames || {};
    const englishName = itemName && !String(itemName).startsWith("/items/") ? String(itemName) : titleCase(simpleItemName(itemHrid));
    if (/[\u3400-\u9fff]/.test(englishName) || normalizeLocale(options && options.locale) !== "zh-CN") return englishName;
    return chineseItemName(englishName, dictionary);
  }

  return { normalizeLocale, localizeItemName };
});


(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.MwiGuildCreditCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function positiveInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  function normalizeAsks(orderBook) {
    if (!orderBook || !Array.isArray(orderBook.asks)) return [];
    return orderBook.asks
      .map((ask) => ({ price: Number(ask.price), quantity: Number(ask.quantity) }))
      .filter((ask) => Number.isFinite(ask.price) && ask.price >= 0 && Number.isSafeInteger(ask.quantity) && ask.quantity > 0)
      .sort((left, right) => left.price - right.price);
  }

  function quoteAsks(orderBook, requestedQuantity) {
    const quantity = positiveInteger(requestedQuantity);
    if (!quantity) return { status: "invalid_quantity", requestedQuantity, availableQuantity: 0, cost: null, fills: [] };

    let remaining = quantity;
    let cost = 0;
    let availableQuantity = 0;
    const fills = [];

    for (const ask of normalizeAsks(orderBook)) {
      availableQuantity += ask.quantity;
      if (remaining === 0) continue;
      const take = Math.min(remaining, ask.quantity);
      cost += take * ask.price;
      fills.push({ price: ask.price, quantity: take });
      remaining -= take;
    }

    if (remaining > 0) {
      return { status: "insufficient_depth", requestedQuantity: quantity, availableQuantity, cost: null, fills };
    }
    return { status: "ok", requestedQuantity: quantity, availableQuantity, cost, fills };
  }

  function evaluateConversion(conversion, orderBook, targetCredits) {
    const target = positiveInteger(targetCredits);
    const itemCount = positiveInteger(conversion && conversion.itemCount);
    const creditCount = positiveInteger(conversion && conversion.creditCount);
    if (!target || !itemCount || !creditCount) {
      return { status: "invalid_conversion", conversion, targetCredits };
    }

    const batches = Math.ceil(target / creditCount);
    const requiredItems = batches * itemCount;
    const actualCredits = batches * creditCount;
    const quote = quoteAsks(orderBook, requiredItems);
    const base = {
      status: quote.status,
      itemHrid: conversion.itemHrid,
      itemName: conversion.itemName || conversion.itemHrid,
      creditItemHrid: conversion.creditItemHrid,
      itemCount,
      creditCount,
      targetCredits: target,
      batches,
      requiredItems,
      actualCredits,
      availableQuantity: quote.availableQuantity,
      fills: quote.fills,
      buyerFee: 0
    };
    if (quote.status !== "ok") return { ...base, cost: null, costPerCredit: null };
    return { ...base, cost: quote.cost, costPerCredit: quote.cost / actualCredits };
  }

  function rankConversions(conversions, orderBooks, targetCredits) {
    return conversions
      .map((conversion) => evaluateConversion(conversion, orderBooks[conversion.itemHrid], targetCredits))
      .sort((left, right) => {
        if (left.status === "ok" && right.status !== "ok") return -1;
        if (right.status === "ok" && left.status !== "ok") return 1;
        if (left.status !== "ok" || right.status !== "ok") return left.itemName.localeCompare(right.itemName, "zh-CN");
        return left.costPerCredit - right.costPerCredit || left.cost - right.cost || left.itemName.localeCompare(right.itemName, "zh-CN");
      });
  }

  function aggregateGuildBuffLevelCosts(levelCosts, startLevel, targetLevel) {
    const start = Number(startLevel);
    const target = Number(targetLevel);
    const costs = Array.isArray(levelCosts) ? levelCosts : levelCosts && typeof levelCosts === "object" ? levelCosts : null;
    if (!costs || !Number.isSafeInteger(start) || !Number.isSafeInteger(target) || start < 0 || target <= start) {
      return { status: "invalid_range", startLevel, targetLevel, totals: [] };
    }

    const maxLevel = Array.isArray(costs)
      ? costs.length - 1
      : Math.max(...Object.keys(costs).map(Number).filter(Number.isSafeInteger));
    if (!Number.isSafeInteger(maxLevel) || target > maxLevel) {
      return { status: "invalid_range", startLevel: start, targetLevel: target, maxLevel, totals: [] };
    }

    const totals = new Map();
    const add = (itemHrid, count) => {
      const quantity = Number(count);
      if (!itemHrid || !Number.isFinite(quantity) || quantity <= 0) return;
      totals.set(itemHrid, (totals.get(itemHrid) || 0) + quantity);
    };

    for (let level = start + 1; level <= target; level += 1) {
      const cost = costs[level];
      if (!cost || typeof cost !== "object") {
        return { status: "missing_cost", startLevel: start, targetLevel: target, maxLevel, missingLevel: level, totals: [] };
      }
      add("/items/guild_token", cost.guildTokenCost);
      for (const creditCost of cost.creditCosts || []) add(creditCost.itemHrid, creditCost.count);
    }

    return {
      status: "ok",
      startLevel: start,
      targetLevel: target,
      maxLevel,
      totals: [...totals.entries()]
        .map(([itemHrid, count]) => ({ itemHrid, count }))
        .sort((left, right) => left.itemHrid.localeCompare(right.itemHrid))
    };
  }

  function aggregateGuildBuffPlans(plans) {
    if (!Array.isArray(plans) || plans.length === 0) return { status: "invalid_plans", plans: [], totals: [] };

    const totals = new Map();
    const results = [];
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      const result = aggregateGuildBuffLevelCosts(plan && plan.levelCosts, plan && plan.startLevel, plan && plan.targetLevel);
      if (result.status !== "ok") return { status: "invalid_plan", planIndex: index, result, plans: results, totals: [] };
      results.push({ ...result, id: plan && plan.id, guildBuffHrid: plan && plan.guildBuffHrid });
      for (const item of result.totals) totals.set(item.itemHrid, (totals.get(item.itemHrid) || 0) + item.count);
    }

    return {
      status: "ok",
      plans: results,
      totals: [...totals.entries()]
        .map(([itemHrid, count]) => ({ itemHrid, count }))
        .sort((left, right) => left.itemHrid.localeCompare(right.itemHrid))
    };
  }

  function conversionsFromItemDetails(itemDetails, creditItemHrid) {
    const details = Array.isArray(itemDetails)
      ? itemDetails.map((detail) => [detail && (detail.itemHrid || detail.hrid), detail])
      : Object.entries(itemDetails || {});
    return details.flatMap(([itemKey, detail]) => (detail && Array.isArray(detail.guildCreditConversions) ? detail.guildCreditConversions : [])
      .filter((conversion) => conversion.creditItemHrid === creditItemHrid)
      .map((conversion) => ({
        itemHrid: detail.itemHrid || detail.hrid || itemKey,
        itemName: detail.name || detail.itemHrid || detail.hrid || itemKey,
        creditItemHrid: conversion.creditItemHrid,
        itemCount: conversion.itemCount,
        creditCount: conversion.creditCount
      }))
      .filter((conversion) => conversion.itemHrid && positiveInteger(conversion.itemCount) && positiveInteger(conversion.creditCount)));
  }

  return { normalizeAsks, quoteAsks, evaluateConversion, rankConversions, aggregateGuildBuffLevelCosts, aggregateGuildBuffPlans, conversionsFromItemDetails };
});


(function () {
  "use strict";

  const core = window.MwiGuildCreditCore;
  const localization = window.MwiGuildCreditLocalization;
  if (!core || !localization) return;
  const pageWindow = typeof unsafeWindow === "undefined" ? window : unsafeWindow;

  const CREDIT_TYPES = [
    ["/items/green_guild_credit", "绿色", "#42c59f"],
    ["/items/brown_guild_credit", "棕色", "#c58a42"],
    ["/items/white_guild_credit", "白色", "#e8e9ef"],
    ["/items/blue_guild_credit", "蓝色", "#4c99e8"],
    ["/items/purple_guild_credit", "紫色", "#9567da"],
    ["/items/red_guild_credit", "红色", "#df4c5a"],
    ["/items/silver_guild_credit", "银色", "#c4cad5"],
    ["/items/gold_guild_credit", "金色", "#d8a33c"]
  ];
  const GUILD_SHRINE_NAMES = {
    "/guild_shrines/force": "力量神龛",
    "/guild_shrines/tempo": "节奏神龛",
    "/guild_shrines/spirit": "精神神龛",
    "/guild_shrines/rarity": "稀有神龛",
    "/guild_shrines/scholar": "学者神龛"
  };
  // Recent game items are not present in the historical public translation map.
  // Keep these overrides small and explicit so a new game item falls back to English
  // instead of receiving an unreliable machine translation.
  const chineseItemNames = {
    ...(window.MwiGuildCreditChineseItems || {}),
    "Shield Bash": "盾击",
    "Fracturing Impact": "碎裂冲击",
    "Life Drain": "生命汲取",
    "Retribution": "复仇",
    "Crippling Slash": "致残斩",
    "Catalytic Tea": "催化茶",
    "Red Culinary Hat": "红色厨师帽",
    "Philosopher's Necklace": "哲学家项链",
    "Philosopher's Ring": "哲学家戒指",
    "Necklace Of Speed": "速度项链",
    "Philosopher's Earrings": "哲学家耳环",
    "Advanced Melee Charm": "高级近战护符",
    "Advanced Defense Charm": "高级防御护符",
    "Advanced Intelligence Charm": "高级智力护符",
    "Expert Melee Charm": "专家近战护符",
    "Basic Attack Charm": "基础攻击护符",
    "Labyrinth Refinement Shard": "迷宫精炼碎片",
    "Thread Of Expertise": "专精丝线",
    "Butter Of Proficiency": "熟练黄油",
    "Guild Token": "公会代币",
    "Master Magic Charm": "大师魔法护符",
    "Master Ranged Charm": "大师远程护符",
    "Master Stamina Charm": "大师体力护符",
    "Philosopher's Mirror": "贤者之镜",
    "Philosopher's Stone": "贤者之石"
  };
  const state = { itemDetails: null, guildBuffDetails: null, guildBuffLevels: null, pageItemNames: Object.create(null), upgradePlans: [], nextUpgradePlanId: 1, snapshot: null, panel: null, creditTab: null, hiddenSidebarNodes: [], refreshTimer: null, refreshInFlight: false, refreshQueued: false, panelSearchTimer: null, activationScheduled: false, creditRendered: false };

  function simpleItemName(itemHrid) {
    return String(itemHrid || "未知物品").split("/").pop().replaceAll("_", " ");
  }

  function titleCase(value) {
    return String(value || "").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  // The Chinese UI translation writes the localized item name to the game's icon.
  // Reuse that live, user-visible value instead of maintaining a second translation.
  function refreshPageItemNames() {
    const uses = document.querySelectorAll('svg[role="img"][aria-label] use');
    for (const use of uses) {
      if (use.closest("#mwi-credit-optimizer")) continue;
      const icon = use.closest('svg[role="img"][aria-label]');
      const name = icon && icon.getAttribute("aria-label") && icon.getAttribute("aria-label").trim();
      const href = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
      const itemId = href.slice(href.lastIndexOf("#") + 1);
      if (!itemId || !name || !/[\u3400-\u9fff]/.test(name)) continue;
      state.pageItemNames[`/items/${itemId}`] = name;
    }
  }

  function localizedItemName(itemName, itemHrid) {
    const visibleName = itemHrid && state.pageItemNames[itemHrid];
    if (visibleName) return visibleName;
    let locale = "zh-CN";
    try {
      locale = pageWindow.localStorage && pageWindow.localStorage.getItem("i18nextLng") || document.documentElement.lang || locale;
    } catch (_) {
      // Keep Chinese as the personal plugin's default if browser storage is unavailable.
    }
    return localization.localizeItemName({ itemName, itemHrid, chineseNames: chineseItemNames, locale });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  }

  function setItemDetails(candidate) {
    if (candidate && (Array.isArray(candidate) || typeof candidate === "object")) {
      state.itemDetails = candidate;
      return true;
    }
    return false;
  }

  function setGuildBuffDetails(candidate) {
    if (candidate && (Array.isArray(candidate) || typeof candidate === "object")) {
      state.guildBuffDetails = candidate;
      return true;
    }
    return false;
  }

  function setGuildBuffLevels(candidate) {
    if (candidate && (Array.isArray(candidate) || typeof candidate === "object")) {
      state.guildBuffLevels = candidate;
      return true;
    }
    return false;
  }

  // The game persists initClientData with LZString.compressToUTF16. Reading it
  // avoids depending on the timing of the one-time WebSocket initialization.
  function decompressFromUtf16(compressed) {
    if (compressed == null) return "";
    if (compressed === "") return null;
    const dictionary = [0, 1, 2];
    let next;
    let enlargeIn = 4;
    let dictionarySize = 4;
    let numBits = 3;
    let entry = "";
    const result = [];
    let dataValue = compressed.charCodeAt(0) - 32;
    let dataPosition = 16384;
    let dataIndex = 1;

    const readBits = (count) => {
      let value = 0;
      let bit = 1;
      for (let power = 1, maxPower = 1 << count; power !== maxPower; power <<= 1) {
        const residue = dataValue & dataPosition;
        dataPosition >>= 1;
        if (dataPosition === 0) {
          dataPosition = 16384;
          dataValue = dataIndex < compressed.length ? compressed.charCodeAt(dataIndex) - 32 : 0;
          dataIndex += 1;
        }
        if (residue > 0) value |= bit;
        bit <<= 1;
      }
      return value;
    };

    const firstToken = readBits(2);
    if (firstToken === 0) entry = String.fromCharCode(readBits(8));
    else if (firstToken === 1) entry = String.fromCharCode(readBits(16));
    else return "";

    dictionary[3] = entry;
    let previous = entry;
    result.push(entry);

    while (true) {
      if (dataIndex > compressed.length) return "";
      const token = readBits(numBits);
      if (token === 0) {
        dictionary[dictionarySize] = String.fromCharCode(readBits(8));
        dictionarySize += 1;
        enlargeIn -= 1;
        next = dictionarySize - 1;
      } else if (token === 1) {
        dictionary[dictionarySize] = String.fromCharCode(readBits(16));
        dictionarySize += 1;
        enlargeIn -= 1;
        next = dictionarySize - 1;
      } else if (token === 2) {
        return result.join("");
      } else {
        next = token;
      }

      if (enlargeIn === 0) {
        enlargeIn = 1 << numBits;
        numBits += 1;
      }
      if (dictionary[next]) entry = dictionary[next];
      else if (next === dictionarySize) entry = previous + previous.charAt(0);
      else return null;

      result.push(entry);
      dictionary[dictionarySize] = previous + entry.charAt(0);
      dictionarySize += 1;
      enlargeIn -= 1;
      previous = entry;

      if (enlargeIn === 0) {
        enlargeIn = 1 << numBits;
        numBits += 1;
      }
    }
  }

  function hydrateLocalInitData() {
    if (state.itemDetails && state.guildBuffDetails && state.guildBuffLevels) return true;
    let raw;
    try {
      raw = pageWindow.localStorage && pageWindow.localStorage.getItem("initClientData");
    } catch (_) {
      return false;
    }
    if (!raw) return false;
    try {
      const decoded = decompressFromUtf16(raw) || raw;
      const data = JSON.parse(decoded);
      const hasItems = setItemDetails(data.itemDetailMap || data.itemDetailDict);
      const hasGuildBuffs = setGuildBuffDetails(data.guildBuffDetailMap || data.guildBuffDetailDict);
      const hasGuildBuffLevels = setGuildBuffLevels(data.characterGuildBuffMap || data.characterGuildBuffDict);
      return hasItems || hasGuildBuffs || hasGuildBuffLevels;
    } catch (_) {
      return false;
    }
  }

  function extractItemDetailsFromReact() {
    if (state.itemDetails && state.guildBuffDetails && state.guildBuffLevels) return true;
    const roots = [document.getElementById("root"), document.body].filter(Boolean);
    const visited = new Set();
    const stack = [];
    for (const root of roots) {
      for (const key of Object.keys(root)) {
        if (key.startsWith("__reactFiber$") || key.startsWith("__reactContainer$") || key.startsWith("__reactInternalInstance$")) stack.push(root[key]);
      }
    }
    let scanned = 0;
    let found = false;
    while (stack.length && scanned < 6000) {
      const fiber = stack.pop();
      if (!fiber || typeof fiber !== "object" || visited.has(fiber)) continue;
      visited.add(fiber);
      scanned += 1;
      const stateValue = fiber.stateNode && fiber.stateNode.state;
      const candidates = [fiber.memoizedProps, fiber.pendingProps, stateValue, fiber.memoizedState];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        found = setItemDetails(candidate.itemDetailMap || candidate.itemDetailDict) || found;
        found = setGuildBuffDetails(candidate.guildBuffDetailMap || candidate.guildBuffDetailDict) || found;
        found = setGuildBuffLevels(candidate.characterGuildBuffMap || candidate.characterGuildBuffDict) || found;
        if (state.itemDetails && state.guildBuffDetails && state.guildBuffLevels) return true;
      }
      // React 18 containers point at a FiberRoot whose active tree is .current.
      if (fiber.current) stack.push(fiber.current);
      if (fiber.stateNode && fiber.stateNode.current) stack.push(fiber.stateNode.current);
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return found;
  }

  function scanMessage(value, depth) {
    if (!value || typeof value !== "object" || depth > 8) return;
    setItemDetails(value.itemDetailMap || value.itemDetailDict);
    setGuildBuffDetails(value.guildBuffDetailMap || value.guildBuffDetailDict);
    setGuildBuffLevels(value.characterGuildBuffMap || value.characterGuildBuffDict);
    for (const child of Object.values(value)) scanMessage(child, depth + 1);
  }

  function hydrateBridgeData() {
    const bridge = pageWindow.__mwiGuildCreditBridge;
    if (!bridge || typeof bridge !== "object") return;
    setItemDetails(bridge.itemDetails);
    setGuildBuffLevels(bridge.characterGuildBuffMap || bridge.characterGuildBuffDict);
    if (Array.isArray(bridge.messages) && (!state.itemDetails || !state.guildBuffDetails || !state.guildBuffLevels)) {
      for (let index = bridge.messages.length - 1; index >= 0 && (!state.itemDetails || !state.guildBuffDetails || !state.guildBuffLevels); index -= 1) {
        try {
          scanMessage(JSON.parse(bridge.messages[index]), 0);
        } catch (_) {
          // Ignore non-JSON protocol frames.
        }
      }
    }
  }

  async function loadSnapshot(force) {
    if (state.snapshot && !force) return state.snapshot;
    if (!force && window.__MWI_PRIVATE_MARKET_SNAPSHOT__) {
      state.snapshot = window.__MWI_PRIVATE_MARKET_SNAPSHOT__;
      return state.snapshot;
    }
    if (!force && window.__MWI_PRIVATE_MARKET_PROMISE__) {
      await window.__MWI_PRIVATE_MARKET_PROMISE__;
      if (window.__MWI_PRIVATE_MARKET_SNAPSHOT__) {
        state.snapshot = window.__MWI_PRIVATE_MARKET_SNAPSHOT__;
        return state.snapshot;
      }
    }
    const response = await fetch("/game_data/marketplace.json", {
      cache: force ? "no-store" : "default",
      credentials: "omit"
    });
    if (!response.ok) throw new Error(`公开市场快照请求失败 (${response.status})`);
    state.snapshot = await response.json();
    window.__MWI_PRIVATE_MARKET_SNAPSHOT__ = state.snapshot;
    return state.snapshot;
  }

  function snapshotOrderBook(itemHrid) {
    const entry = state.snapshot && state.snapshot.marketData && state.snapshot.marketData[itemHrid] && state.snapshot.marketData[itemHrid]["0"];
    return entry && Number.isFinite(Number(entry.a)) ? { asks: [{ price: Number(entry.a), quantity: Number.MAX_SAFE_INTEGER }] } : null;
  }

  function allConversions(creditItemHrid) {
    hydrateLocalInitData();
    hydrateBridgeData();
    extractItemDetailsFromReact();
    return core.conversionsFromItemDetails(state.itemDetails, creditItemHrid).map((conversion) => ({
      ...conversion,
      itemName: localizedItemName(conversion.itemName, conversion.itemHrid)
    }));
  }

  function itemSpriteHref(itemHrid) {
    const spriteUse = document.querySelector('use[href*="items_sprite"]');
    const href = spriteUse && spriteUse.getAttribute("href");
    if (!href || !href.includes("#")) return "";
    return `${href.slice(0, href.indexOf("#"))}#${String(itemHrid || "").split("/").pop()}`;
  }

  function iconMarkup(itemHrid, label) {
    const href = itemSpriteHref(itemHrid);
    if (!href) return '<span class="mwi-item-icon mwi-item-icon-fallback" aria-hidden="true"></span>';
    return `<svg class="mwi-item-icon" role="img" aria-label="${escapeHtml(label)}"><use href="${escapeHtml(href)}"></use></svg>`;
  }

  function formatNumber(value, digits) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "-";
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits === undefined ? 0 : digits }).format(value);
  }

  function guildBuffEntries() {
    hydrateLocalInitData();
    hydrateBridgeData();
    extractItemDetailsFromReact();
    const details = Array.isArray(state.guildBuffDetails)
      ? state.guildBuffDetails.map((detail) => [detail && (detail.hrid || detail.guildBuffHrid), detail])
      : Object.entries(state.guildBuffDetails || {});
    return details
      .map(([hrid, detail]) => ({ hrid: detail && (detail.hrid || detail.guildBuffHrid) || hrid, detail }))
      .filter(({ hrid, detail }) => hrid && detail && detail.levelCosts)
      .map(({ hrid, detail }) => ({ hrid, detail, maxLevel: Array.isArray(detail.levelCosts) ? detail.levelCosts.length - 1 : Math.max(...Object.keys(detail.levelCosts).map(Number).filter(Number.isSafeInteger)) }))
      .filter(({ maxLevel }) => Number.isSafeInteger(maxLevel) && maxLevel > 0)
      .sort((left, right) => guildBuffLabel(left.detail, left.hrid).localeCompare(guildBuffLabel(right.detail, right.hrid), "zh-CN"));
  }

  function guildBuffLabel(detail, fallbackHrid) {
    const shrineName = GUILD_SHRINE_NAMES[detail && detail.shrineHrid] || titleCase(simpleItemName(detail && detail.shrineHrid || fallbackHrid));
    const domain = detail && detail.isCombat === true ? "战斗" : detail && detail.isCombat === false ? "生活" : "";
    return domain ? `${shrineName}（${domain}）` : shrineName;
  }

  function itemNameForMaterial(itemHrid) {
    const credit = CREDIT_TYPES.find(([hrid]) => hrid === itemHrid);
    if (credit) return `${credit[1]}公会信用点`;
    const details = Array.isArray(state.itemDetails)
      ? state.itemDetails.map((detail) => [detail && (detail.itemHrid || detail.hrid), detail])
      : Object.entries(state.itemDetails || {});
    const detail = details.find(([hrid]) => hrid === itemHrid);
    return localizedItemName(detail && detail[1] && detail[1].name, itemHrid);
  }

  function materialOrder(left, right) {
    if (left.itemHrid === "/items/guild_token") return -1;
    if (right.itemHrid === "/items/guild_token") return 1;
    const leftCredit = CREDIT_TYPES.findIndex(([hrid]) => hrid === left.itemHrid);
    const rightCredit = CREDIT_TYPES.findIndex(([hrid]) => hrid === right.itemHrid);
    if (leftCredit >= 0 && rightCredit >= 0) return leftCredit - rightCredit;
    if (leftCredit >= 0) return -1;
    if (rightCredit >= 0) return 1;
    return itemNameForMaterial(left.itemHrid).localeCompare(itemNameForMaterial(right.itemHrid), "zh-CN");
  }

  function currentGuildBuffLevel(entry) {
    const stored = Array.isArray(state.guildBuffLevels)
      ? state.guildBuffLevels.find((value) => value && (value.guildBuffHrid || value.hrid) === entry.hrid)
      : state.guildBuffLevels && state.guildBuffLevels[entry.hrid];
    const value = stored && typeof stored === "object" ? stored.level : stored;
    const level = Number(value);
    return Number.isSafeInteger(level) && level >= 0 ? Math.min(level, entry.maxLevel) : 0;
  }

  function normalizeUpgradePlan(plan, entries) {
    const entry = entries.find((candidate) => candidate.hrid === plan.guildBuffHrid);
    if (!entry) return null;
    const currentLevel = currentGuildBuffLevel(entry);
    const rawStart = Number(plan.startLevel);
    const startLevel = Number.isSafeInteger(rawStart) && rawStart >= 0 && rawStart < entry.maxLevel ? rawStart : currentLevel;
    const rawTarget = Number(plan.targetLevel);
    const targetLevel = Number.isSafeInteger(rawTarget) && rawTarget > startLevel && rawTarget <= entry.maxLevel
      ? rawTarget
      : Math.min(startLevel + 1, entry.maxLevel);
    return { ...plan, guildBuffHrid: entry.hrid, startLevel, targetLevel };
  }

  function addGuildUpgradePlan(entries) {
    const plannedHrids = new Set(state.upgradePlans.map((plan) => plan.guildBuffHrid));
    const entry = entries.find((candidate) => !plannedHrids.has(candidate.hrid) && currentGuildBuffLevel(candidate) < candidate.maxLevel);
    if (!entry) return false;
    const startLevel = currentGuildBuffLevel(entry);
    state.upgradePlans.push({ id: `plan-${state.nextUpgradePlanId++}`, guildBuffHrid: entry.hrid, startLevel, targetLevel: startLevel + 1 });
    return true;
  }

  function ensureGuildUpgradePlans(entries) {
    state.upgradePlans = state.upgradePlans.map((plan) => normalizeUpgradePlan(plan, entries)).filter(Boolean);
    if (!state.upgradePlans.length) addGuildUpgradePlan(entries);
  }

  function levelOptionMarkup(start, end, selected) {
    return Array.from({ length: Math.max(end - start + 1, 0) }, (_, index) => start + index)
      .map((level) => `<option value="${level}" ${level === selected ? "selected" : ""}>${level} 级</option>`).join("");
  }

  function renderGuildUpgradePlans(panel, entries) {
    const list = panel.querySelector('[data-role="upgrade-plan-list"]');
    const plannedHrids = new Set(state.upgradePlans.map((plan) => plan.guildBuffHrid));
    list.innerHTML = state.upgradePlans.map((plan) => {
      const entry = entries.find((candidate) => candidate.hrid === plan.guildBuffHrid);
      if (!entry) return "";
      const buffOptions = entries.map((candidate) => `<option value="${escapeHtml(candidate.hrid)}" ${candidate.hrid === plan.guildBuffHrid ? "selected" : ""} ${candidate.hrid !== plan.guildBuffHrid && (plannedHrids.has(candidate.hrid) || currentGuildBuffLevel(candidate) >= candidate.maxLevel) ? "disabled" : ""}>${escapeHtml(guildBuffLabel(candidate.detail, candidate.hrid))}</option>`).join("");
      return `<div class="mwi-upgrade-plan" data-plan-id="${escapeHtml(plan.id)}">
        <label>神龛<select data-role="plan-buff">${buffOptions}</select></label>
        <label>起始等级<select data-role="plan-start">${levelOptionMarkup(0, entry.maxLevel - 1, plan.startLevel)}</select></label>
        <label>目标等级<select data-role="plan-target">${levelOptionMarkup(plan.startLevel + 1, entry.maxLevel, plan.targetLevel)}</select></label>
        <button class="mwi-remove-plan" data-role="remove-plan" type="button" title="移除此项" aria-label="移除此项">×</button>
      </div>`;
    }).join("");
  }

  function renderMaterialTotals(results, totals) {
    const planSummary = results.map((plan) => {
      const entry = guildBuffEntries().find((candidate) => candidate.hrid === plan.guildBuffHrid);
      const label = entry ? guildBuffLabel(entry.detail, entry.hrid) : plan.guildBuffHrid;
      return `<span>${escapeHtml(label)} ${plan.startLevel} -> ${plan.targetLevel}</span>`;
    }).join("<span class=\"mwi-plan-separator\">，</span>");
    const materials = totals.sort(materialOrder).map((item) => `<div class="mwi-material-row">${iconMarkup(item.itemHrid, itemNameForMaterial(item.itemHrid))}<span class="mwi-material-name">${escapeHtml(itemNameForMaterial(item.itemHrid))}</span><strong>${formatNumber(item.count)}</strong></div>`).join("");
    return `<div class="mwi-plan-summary">${planSummary}</div><div class="mwi-material-list">${materials}</div>`;
  }

  function refreshGuildUpgrade(panel) {
    refreshPageItemNames();
    const status = panel.querySelector('[data-role="upgrade-status"]');
    const results = panel.querySelector('[data-role="upgrade-results"]');
    const entries = guildBuffEntries();
    if (!entries.length) {
      status.textContent = "未读取到神龛升级规则。请刷新游戏页面后重新打开公会。";
      results.replaceChildren();
      return;
    }
    if (!state.guildBuffLevels) {
      status.textContent = "正在读取当前神龛等级，请稍后重新打开此页。";
      results.replaceChildren();
      return;
    }

    ensureGuildUpgradePlans(entries);
    renderGuildUpgradePlans(panel, entries);
    if (!state.upgradePlans.length) {
      status.textContent = "当前所有神龛增益均已满级。";
      results.replaceChildren();
      return;
    }

    const result = core.aggregateGuildBuffPlans(state.upgradePlans.map((plan) => {
      const entry = entries.find((candidate) => candidate.hrid === plan.guildBuffHrid);
      return { ...plan, levelCosts: entry && entry.detail.levelCosts };
    }));
    if (result.status !== "ok") {
      const failed = result.result || {};
      status.textContent = failed.status === "missing_cost" ? `缺少 ${failed.missingLevel} 级升级成本数据。` : "起始等级或目标等级无效。";
      results.replaceChildren();
      return;
    }
    status.textContent = `已合并 ${result.plans.length} 项神龛升级的材料成本。`;
    results.innerHTML = renderMaterialTotals(result.plans, result.totals);
  }

  function setPanelView(panel, view) {
    const creditView = panel.querySelector('[data-role="credit-view"]');
    const upgradeView = panel.querySelector('[data-role="upgrade-view"]');
    const creditTab = panel.querySelector('[data-role="view-credit"]');
    const upgradeTab = panel.querySelector('[data-role="view-upgrade"]');
    const showUpgrade = view === "upgrade";
    creditView.hidden = showUpgrade;
    upgradeView.hidden = !showUpgrade;
    creditTab.setAttribute("aria-selected", String(!showUpgrade));
    upgradeTab.setAttribute("aria-selected", String(showUpgrade));
    creditTab.classList.toggle("mwi-view-tab-active", !showUpgrade);
    upgradeTab.classList.toggle("mwi-view-tab-active", showUpgrade);
    panel.dataset.activeView = showUpgrade ? "upgrade" : "credit";
    if (showUpgrade) refreshGuildUpgrade(panel);
    else if (!state.creditRendered) refreshPanel(panel);
  }

  function createPanel() {
    const panel = document.createElement("section");
    panel.id = "mwi-credit-optimizer";
    panel.innerHTML = `
      <style>
        #mwi-credit-optimizer{position:relative;z-index:20;flex:1;min-height:0;height:100%;overflow-y:auto;overflow-x:hidden;margin:0;padding:12px;background:#202139;color:#f4f5ff;font:14px system-ui,sans-serif}
        #mwi-credit-optimizer[hidden]{display:none} [data-mwi-credit-tab="true"]{user-select:none;pointer-events:auto!important;cursor:pointer!important}
        #mwi-credit-optimizer *{box-sizing:border-box} #mwi-credit-optimizer h3{margin:0 0 10px;font-size:17px}
        #mwi-credit-optimizer .mwi-view-tabs{display:flex;border-bottom:1px solid #474969;margin:0 0 10px}.mwi-view-tab{min-height:30px!important;border-radius:0!important;background:transparent!important;color:#c9cbeb!important;padding:5px 10px!important}.mwi-view-tab-active{border-bottom:2px solid #43c4ad!important;color:#fff!important}
        #mwi-credit-optimizer .mwi-controls{display:flex;gap:8px;align-items:end;flex-wrap:wrap} #mwi-credit-optimizer label{display:grid;gap:4px;color:#d8d8e8}
        #mwi-credit-optimizer input,#mwi-credit-optimizer select{width:112px;min-height:32px;border:1px solid #7778b4;border-radius:4px;padding:4px 8px;background:#f1f2ff;color:#1f2030;font:inherit}
        #mwi-credit-optimizer button{min-height:32px;border:0;border-radius:4px;padding:5px 12px;background:#43c4ad;color:#10201f;font-weight:700;cursor:pointer}
        #mwi-credit-optimizer button:disabled{opacity:.55;cursor:wait} #mwi-credit-optimizer .mwi-status{margin:10px 0;color:#c9cbeb}
        #mwi-credit-optimizer .mwi-credit-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:10px}
        #mwi-credit-optimizer .mwi-credit-section{min-width:0;border:1px solid #474969;border-top:3px solid var(--mwi-credit-color);border-radius:6px;background:#292a46;overflow:hidden}
        #mwi-credit-optimizer .mwi-credit-heading{display:flex;align-items:center;gap:7px;padding:8px 9px 6px;font-size:13px;font-weight:700;color:#fff}
        #mwi-credit-optimizer .mwi-credit-heading .mwi-item-icon{width:22px;height:22px;flex:0 0 22px}.mwi-credit-section table{width:100%;border-collapse:collapse;font-size:11px}
        #mwi-credit-optimizer th,#mwi-credit-optimizer td{padding:5px 6px;border-top:1px solid #474969;text-align:right;white-space:nowrap}
        #mwi-credit-optimizer th:first-child,#mwi-credit-optimizer td:first-child{text-align:left} #mwi-credit-optimizer th{color:#bfc2de;font-weight:600}
        #mwi-credit-optimizer .mwi-item{display:flex;align-items:center;gap:5px;min-width:0}.mwi-item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #mwi-credit-optimizer .mwi-item-icon{display:inline-block;width:24px;height:24px;flex:0 0 24px;vertical-align:middle}.mwi-item-icon-fallback{border-radius:4px;background:#45476b}
        #mwi-credit-optimizer .mwi-cost{color:#77f3d0;font-weight:700} #mwi-credit-optimizer .mwi-empty{padding:8px;color:#ffd17c;font-size:12px}
        #mwi-credit-optimizer .mwi-upgrade-plan-list{display:grid;gap:8px}#mwi-credit-optimizer .mwi-upgrade-plan{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 32px;gap:8px;align-items:end;padding:8px;border:1px solid #474969;border-radius:4px;background:#292a46}#mwi-credit-optimizer .mwi-upgrade-plan label{min-width:0;text-align:left;justify-items:stretch}#mwi-credit-optimizer .mwi-upgrade-plan label:first-child{grid-column:1/-1;grid-row:1}#mwi-credit-optimizer .mwi-upgrade-plan label:nth-child(2){grid-column:1;grid-row:2}#mwi-credit-optimizer .mwi-upgrade-plan label:nth-child(3){grid-column:2;grid-row:2}#mwi-credit-optimizer .mwi-upgrade-plan select{width:100%!important;max-width:none;min-width:0}#mwi-credit-optimizer .mwi-remove-plan{grid-column:3;grid-row:2;width:32px;min-width:32px;padding:0!important;font-size:20px;line-height:1;background:#555773!important;color:#fff!important}#mwi-credit-optimizer .mwi-upgrade-actions{margin-top:10px}
        #mwi-credit-optimizer .mwi-material-list{border-top:1px solid #474969}.mwi-material-row{display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid #474969}.mwi-material-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mwi-material-row strong{color:#77f3d0;font-size:15px}.mwi-plan-summary{display:flex;flex-wrap:wrap;gap:2px 0;margin:10px 0 6px;color:#c9cbeb;font-size:12px}.mwi-plan-separator{padding-right:4px}.mwi-plugin-footer{margin-top:16px;padding:10px 4px 2px;border-top:1px solid #474969;color:#aeb1d3;font-size:12px;line-height:1.6;text-align:center}
        @media (max-width:430px){#mwi-credit-optimizer .mwi-credit-grid{grid-template-columns:1fr}}
      </style>
      <h3>公会助手</h3>
      <div class="mwi-view-tabs" role="tablist">
        <button class="mwi-view-tab mwi-view-tab-active" data-role="view-credit" role="tab" aria-selected="true" type="button">信用点性价比</button>
        <button class="mwi-view-tab" data-role="view-upgrade" role="tab" aria-selected="false" type="button">神龛升级</button>
      </div>
      <div data-role="credit-view">
        <div class="mwi-controls">
          <label>目标信用点<input data-role="target" type="number" min="1" step="1" value="1"></label>
          <button data-role="refresh" type="button">刷新市场估算</button>
        </div>
        <div class="mwi-status" data-role="status">等待游戏兑换数据...</div>
        <div data-role="results"></div>
      </div>
      <div data-role="upgrade-view" hidden>
        <div class="mwi-upgrade-plan-list" data-role="upgrade-plan-list"></div>
        <div class="mwi-upgrade-actions"><button data-role="add-upgrade-plan" type="button">添加神龛</button></div>
        <div class="mwi-status" data-role="upgrade-status">等待神龛升级数据...</div>
        <div data-role="upgrade-results"></div>
      </div>
      <footer class="mwi-plugin-footer">作者：柆雨<br>有问题请加群反馈：437320340</footer>`;
    panel.querySelector('[data-role="refresh"]').addEventListener("click", () => refreshPanel(panel, true));
    panel.querySelector('[data-role="target"]').addEventListener("change", () => refreshPanel(panel));
    panel.querySelector('[data-role="view-credit"]').addEventListener("click", () => setPanelView(panel, "credit"));
    panel.querySelector('[data-role="view-upgrade"]').addEventListener("click", () => setPanelView(panel, "upgrade"));
    panel.querySelector('[data-role="add-upgrade-plan"]').addEventListener("click", () => { addGuildUpgradePlan(guildBuffEntries()); refreshGuildUpgrade(panel); });
    panel.querySelector('[data-role="upgrade-plan-list"]').addEventListener("change", (event) => {
      const row = event.target.closest("[data-plan-id]");
      const plan = row && state.upgradePlans.find((candidate) => candidate.id === row.dataset.planId);
      if (!plan) return;
      const entries = guildBuffEntries();
      if (event.target.matches('[data-role="plan-buff"]')) {
        const targetHrid = event.target.value;
        if (state.upgradePlans.some((candidate) => candidate.id !== plan.id && candidate.guildBuffHrid === targetHrid)) return;
        const entry = entries.find((candidate) => candidate.hrid === targetHrid);
        if (!entry || currentGuildBuffLevel(entry) >= entry.maxLevel) return;
        plan.guildBuffHrid = entry.hrid;
        plan.startLevel = currentGuildBuffLevel(entry);
        plan.targetLevel = Math.min(plan.startLevel + 1, entry.maxLevel);
      } else if (event.target.matches('[data-role="plan-start"]')) {
        plan.startLevel = Number(event.target.value);
        const entry = entries.find((candidate) => candidate.hrid === plan.guildBuffHrid);
        plan.targetLevel = Math.max(plan.startLevel + 1, Math.min(plan.targetLevel, entry.maxLevel));
      } else if (event.target.matches('[data-role="plan-target"]')) {
        plan.targetLevel = Number(event.target.value);
      }
      refreshGuildUpgrade(panel);
    });
    panel.querySelector('[data-role="upgrade-plan-list"]').addEventListener("click", (event) => {
      const button = event.target.closest('[data-role="remove-plan"]');
      const row = button && button.closest("[data-plan-id]");
      if (!row) return;
      state.upgradePlans = state.upgradePlans.filter((plan) => plan.id !== row.dataset.planId);
      refreshGuildUpgrade(panel);
    });
    return panel;
  }

  function renderCreditSection(creditItemHrid, label, color, ranked) {
    const available = ranked.filter((row) => row.status === "ok").slice(0, 5);
    const icon = iconMarkup(creditItemHrid, `${label}公会信用点`);
    if (!available.length) {
      return `<section class="mwi-credit-section" style="--mwi-credit-color:${color}"><div class="mwi-credit-heading">${icon}<span>${label}信用点</span></div><div class="mwi-empty">暂无可估算的市场价格</div></section>`;
    }
    return `<section class="mwi-credit-section" style="--mwi-credit-color:${color}"><div class="mwi-credit-heading">${icon}<span>${label}信用点</span></div><table><thead><tr><th>物品</th><th>兑换</th><th>每点</th><th>目标成本</th></tr></thead><tbody>${available.map((row) => `<tr><td title="${escapeHtml(row.itemName)}"><span class="mwi-item">${iconMarkup(row.itemHrid, row.itemName)}<span class="mwi-item-name">${escapeHtml(row.itemName)}</span></span></td><td>${row.itemCount} -> ${row.creditCount}</td><td class="mwi-cost">${formatNumber(row.costPerCredit, 2)}</td><td>${formatNumber(row.cost)}</td></tr>`).join("")}</tbody></table></section>`;
  }

  async function refreshPanel(panel, forceSnapshot) {
    refreshPageItemNames();
    if (state.refreshInFlight) {
      state.refreshQueued = true;
      return;
    }
    state.refreshInFlight = true;
    const status = panel.querySelector('[data-role="status"]');
    const results = panel.querySelector('[data-role="results"]');
    const button = panel.querySelector('[data-role="refresh"]');
    const target = Number(panel.querySelector('[data-role="target"]').value);
    button.disabled = true;
    status.hidden = false;
    results.replaceChildren();

    const creditGroups = CREDIT_TYPES.map(([creditItemHrid, label, color]) => ({ creditItemHrid, label, color, conversions: allConversions(creditItemHrid) }));
    const conversionCount = creditGroups.reduce((total, group) => total + group.conversions.length, 0);
    if (!conversionCount) {
      status.textContent = "未读取到兑换规则。请刷新游戏页面后重新打开公会商店。";
      button.disabled = false;
      finishRefresh(panel);
      return;
    }
    status.textContent = `已读取 ${conversionCount} 条兑换规则，正在读取公开市场快照...`;

    try {
      await loadSnapshot(Boolean(forceSnapshot));
      const rankedGroups = creditGroups.map((group) => {
        const books = Object.fromEntries(group.conversions.map((conversion) => [
          conversion.itemHrid,
          snapshotOrderBook(conversion.itemHrid)
        ]));
        return { ...group, ranked: core.rankConversions(group.conversions, books, target) };
      });
      status.textContent = "";
      status.hidden = true;
      results.innerHTML = `<div class="mwi-credit-grid">${rankedGroups.map((group) => renderCreditSection(group.creditItemHrid, group.label, group.color, group.ranked)).join("")}</div>`;
      state.creditRendered = true;
      button.disabled = false;
      finishRefresh(panel);
    } catch (error) {
      status.textContent = `市场快照读取失败：${error.message}`;
      button.disabled = false;
      finishRefresh(panel);
    }
  }

  function finishRefresh(panel) {
    state.refreshInFlight = false;
    if (!state.refreshQueued) return;
    state.refreshQueued = false;
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => refreshPanel(panel), 250);
  }

  function findSidebarTabBar() {
    const expectedTabs = new Set(["库存", "装备", "技能", "房屋", "配装", "收获"]);
    const elements = document.getElementsByTagName("*");
    for (let index = 0; index < elements.length; index += 1) {
      const candidate = elements[index];
      const children = Array.from(candidate.children);
      if (children.length < 4) continue;
      const tabs = children.map((child) => ({
        element: child,
        label: String(child.innerText || child.textContent || "").replaceAll("\n", "").trim()
      }));
      const recognized = tabs.filter((tab) => expectedTabs.has(tab.label));
      if (recognized.length >= 4) {
        const prototype = recognized.find((tab) => tab.label === "库存") || recognized[0];
        const tabsRoot = candidate.parentElement && candidate.parentElement.parentElement && candidate.parentElement.parentElement.parentElement;
        const sidebar = tabsRoot && tabsRoot.parentElement;
        const panelHost = sidebar && Array.from(sidebar.children).find((node) => node !== tabsRoot && /tabPanelsContainer/.test(String(node.className)));
        if (panelHost) return { tabBar: candidate, tabPrototype: prototype.element, panelHost };
      }
    }
    return null;
  }

  function hideCreditPanel() {
    if (state.panel) state.panel.hidden = true;
    if (state.creditTab) {
      state.creditTab.classList.remove("Mui-selected");
      state.creditTab.setAttribute("aria-selected", "false");
    }
    for (const node of state.hiddenSidebarNodes) {
      if (!node.isConnected) continue;
      node.style.display = node.dataset.mwiCreditPreviousDisplay || "";
      delete node.dataset.mwiCreditPreviousDisplay;
    }
    state.hiddenSidebarNodes = [];
  }

  function eventHitsCreditTab(event, tab) {
    if (tab.contains(event.target)) return true;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
    const rect = tab.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }

  function prepareCreditTabSwitch(event) {
    const tab = state.creditTab;
    if (!tab || !tab.isConnected) return false;
    const tabBar = tab.parentElement;
    if (!tabBar) return false;
    if (!eventHitsCreditTab(event, tab) && tabBar.contains(event.target)) {
      if (!state.panel?.hidden) hideCreditPanel();
      return false;
    }
    return eventHitsCreditTab(event, tab);
  }

  function activateCreditTabAfterOthers(event) {
    if (!prepareCreditTabSwitch(event)) return false;
    event.preventDefault();
    if (state.activationScheduled) return true;
    state.activationScheduled = true;
    window.setTimeout(() => {
      state.activationScheduled = false;
      const tab = state.creditTab;
      const tabBar = tab?.parentElement;
      const integration = findSidebarTabBar();
      if (tabBar && integration?.panelHost) showCreditPanel(integration.panelHost, tabBar);
    }, 0);
    return true;
  }

  function showCreditPanel(panelHost, tabBar) {
    if (!state.panel || !state.panel.isConnected) return;
    hideCreditPanel();
    state.hiddenSidebarNodes = Array.from(panelHost.children).filter((node) => node !== state.panel);
    for (const node of state.hiddenSidebarNodes) {
      node.dataset.mwiCreditPreviousDisplay = node.style.display;
      node.style.display = "none";
    }
    state.panel.hidden = false;
    for (const tab of tabBar.children) {
      tab.classList.remove("Mui-selected");
      tab.setAttribute("aria-selected", "false");
    }
    state.creditTab.classList.add("Mui-selected");
    state.creditTab.setAttribute("aria-selected", "true");

    // 切换只显示缓存结果；首次进入或用户主动刷新时才进行数据扫描和计算。
    if (state.panel.dataset.activeView === "credit" && state.creditRendered) return;
    window.requestAnimationFrame(() => window.setTimeout(() => {
      if (!state.panel?.isConnected || state.panel.hidden) return;
      hydrateLocalInitData();
      hydrateBridgeData();
      extractItemDetailsFromReact();
      if (state.panel.dataset.activeView === "upgrade") refreshGuildUpgrade(state.panel);
      else if (!state.creditRendered) refreshPanel(state.panel);
    }, 0));
  }

  function ensureSidebarIntegration() {
    if (state.panel && state.panel.isConnected && state.creditTab && state.creditTab.isConnected) return;
    refreshPageItemNames();
    const integration = findSidebarTabBar();
    if (!integration || !integration.panelHost) return;
    const { tabBar, tabPrototype, panelHost } = integration;
    const existingTab = tabBar.querySelector('[data-mwi-credit-tab="true"]');
    if (existingTab && state.panel && state.panel.isConnected) return;
    if (existingTab) existingTab.remove();

    if (state.panel && !state.panel.isConnected) state.panel = null;
    if (state.creditTab && !state.creditTab.isConnected) state.creditTab = null;

    const creditTab = tabPrototype.cloneNode(true);
    creditTab.dataset.mwiCreditTab = "true";
    creditTab.classList.remove("Mui-selected");
    creditTab.removeAttribute("id");
    creditTab.removeAttribute("disabled");
    creditTab.removeAttribute("aria-disabled");
    creditTab.setAttribute("aria-selected", "false");
    creditTab.setAttribute("role", "tab");
    if ("disabled" in creditTab) creditTab.disabled = false;
    creditTab.replaceChildren(document.createTextNode("信用"));
    tabBar.append(creditTab);

    const panel = createPanel();
    panel.hidden = true;
    panelHost.append(panel);
    state.panel = panel;
    state.creditTab = creditTab;
  }

  hydrateLocalInitData();
  hydrateBridgeData();
  window.addEventListener("pointerdown", prepareCreditTabSwitch, true);
  window.addEventListener("click", activateCreditTabAfterOthers, true);
  state.panelSearchTimer = window.setInterval(ensureSidebarIntegration, 3000);
  window.setTimeout(ensureSidebarIntegration, 1000);
})();
/*
    此插件依赖 MWITools 的市场数据，请确保已安装 MWITools:
    This plugin depends on MWITools for market data. Please install MWITools:
    https://greasyfork.org/en/scripts/494467-mwitools
*/

(function() {
    'use strict';

    // Prevent duplicate execution if an old Better Loot Tracker installation is still enabled.
    if (window.__BETTER_LOOT_TRACKER__) return;
    window.__BETTER_LOOT_TRACKER__ = true;

    const userLanguage = localStorage.getItem('i18nextLng');
    const isZH = userLanguage?.startsWith("zh");

    // ======================
    // 国际化文本
    // ======================
    const i18n = {
        zh: {
            success: '成功',
            failure: '失败',
            target: '目标',
            protectLevel: '保护等级',
            preferredLevels: '偏好等级',
            superEnhanceMinLevel: '超级强化最低起始等级',
            globalSettings: '全局设置',
            alchemyPriceMode: '炼金价格选择',
            alchemyPriceAskBid: '左买右卖',
            alchemyPriceBidAsk: '右买左卖',
            alchemyPriceAskAsk: '左买左卖',
            alchemyPriceBidBid: '右买右卖',
            autoOptimal: '自动(最优)',
            treatAsSuccess: '视为成功',
            material: '材料',
            protection: '保护',
            total: '总消耗',
            superSpend: '强化消耗',
            alchemyCost: '成本',
            alchemyOutput: '产出',
            alchemyProfit: '收益',
            originalCost: '原始成本',
            finalValue: '最终价值',
            profit: '收益',
            aboveExpected: '高于期望',
            belowExpected: '低于期望',
            expected: '期望',
            noMarketData: '市场数据未加载，请确保已安装MWITools'
        },
        en: {
            success: 'Success',
            failure: 'Failure',
            target: 'Target',
            protectLevel: 'Protect Level',
            preferredLevels: 'Preferred Levels',
            superEnhanceMinLevel: 'Super Enhance Min Start',
            globalSettings: 'Global Settings',
            alchemyPriceMode: 'Alchemy Price Mode',
            alchemyPriceAskBid: 'Ask/ Bid',
            alchemyPriceBidAsk: 'Bid/ Ask',
            alchemyPriceAskAsk: 'Ask/ Ask',
            alchemyPriceBidBid: 'Bid/ Bid',
            autoOptimal: 'Auto(Optimal)',
            treatAsSuccess: 'Treat as Success',
            material: 'Material',
            protection: 'Protect',
            total: 'Total',
            superSpend: 'Enhance Spend',
            alchemyCost: 'Cost',
            alchemyOutput: 'Output',
            alchemyProfit: 'Profit',
            originalCost: 'Original Cost',
            finalValue: 'Final Value',
            profit: 'Profit',
            aboveExpected: 'Above expected',
            belowExpected: 'Below expected',
            expected: 'Expected',
            noMarketData: 'Market data not loaded, please ensure MWITools is installed'
        }
    };

    const t = isZH ? i18n.zh : i18n.en;
    const DEBUG = {
        init: false,
        calc: false
    };

    const logInit = (...args) => {
        if (DEBUG.init) console.log(...args);
    };

    const logCalc = (...args) => {
        if (DEBUG.calc) console.log(...args);
    };

    // React CSS-module hashes change across game UI builds; prefixes are stable.
    const LOOT_LOG_PANEL_SELECTOR = '[class*="LootLogPanel_lootLogPanel"]';
    const LOOT_LOG_LIST_SELECTOR = '[class*="LootLogPanel_actionLoots"]';
    const LOOT_LOG_ITEM_SELECTOR = '[class*="LootLogPanel_actionLoot"]';
    const REFRESH_BUTTON_SELECTOR = 'button[class*="Button_button"]';
    const REFRESH_SETTLE_DELAY_MS = 900;
    const REFRESH_PENDING_WINDOW_MS = 15000;
    let refreshRequestedAt = 0;
    let refreshPendingTimer = null;
    let refreshStartFingerprint = '';

    const PREFERENCE_LEVELS_KEY = 'EnhancementLootTracker_preference_levels';
    const SUPER_ENHANCE_MIN_KEY = 'EnhancementLootTracker_super_min_start_level';
    const ALCHEMY_PRICE_MODE_KEY = 'EnhancementLootTracker_alchemy_price_mode';
    const ALCHEMY_PRICE_MODES = ['ask_bid', 'bid_ask', 'ask_ask', 'bid_bid'];
    let globalPreferenceText = localStorage.getItem(PREFERENCE_LEVELS_KEY) || '';
    let globalSuperEnhanceMinLevel = Number(localStorage.getItem(SUPER_ENHANCE_MIN_KEY));
    let globalAlchemyPriceMode = localStorage.getItem(ALCHEMY_PRICE_MODE_KEY) || 'ask_bid';
    if (!Number.isFinite(globalSuperEnhanceMinLevel) || globalSuperEnhanceMinLevel < 0) {
        globalSuperEnhanceMinLevel = 5;
    }
    if (!ALCHEMY_PRICE_MODES.includes(globalAlchemyPriceMode)) {
        globalAlchemyPriceMode = 'ask_bid';
    }

    function getGlobalPreferenceLevels() {
        return parsePreferenceLevels(globalPreferenceText);
    }

    function setGlobalPreferenceText(text) {
        globalPreferenceText = text || '';
        localStorage.setItem(PREFERENCE_LEVELS_KEY, globalPreferenceText);
    }

    function getSuperEnhanceMinLevel() {
        return globalSuperEnhanceMinLevel;
    }

    function setSuperEnhanceMinLevel(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return;
        const normalized = Math.min(Math.max(Math.round(parsed), 0), 20);
        globalSuperEnhanceMinLevel = normalized;
        localStorage.setItem(SUPER_ENHANCE_MIN_KEY, String(normalized));
    }

    function getAlchemyPriceMode() {
        return globalAlchemyPriceMode;
    }

    function setAlchemyPriceMode(value) {
        if (!ALCHEMY_PRICE_MODES.includes(value)) return;
        globalAlchemyPriceMode = value;
        localStorage.setItem(ALCHEMY_PRICE_MODE_KEY, value);
    }

    function getLootLogContainer() {
        return document.querySelector(LOOT_LOG_LIST_SELECTOR);
    }

    function markRefreshRequested() {
        refreshRequestedAt = Date.now();
        refreshStartFingerprint = getLootLogFingerprint();
        clearTimeout(refreshPendingTimer);
        refreshPendingTimer = setTimeout(() => {
            refreshRequestedAt = 0;
            refreshStartFingerprint = '';
        }, REFRESH_PENDING_WINDOW_MS);
    }

    function isRefreshPending() {
        return refreshRequestedAt > 0 && Date.now() - refreshRequestedAt < REFRESH_PENDING_WINDOW_MS;
    }

    function getLootLogFingerprint() {
        const container = getLootLogContainer();
        if (!container) return '';
        return [...container.querySelectorAll(LOOT_LOG_ITEM_SELECTOR)]
            .map((entry) => entry.textContent.replace(/\s+/g, ' ').trim())
            .join('\n');
    }

    function hasRefreshResultRendered() {
        return isRefreshPending() && getLootLogFingerprint() !== refreshStartFingerprint;
    }

    function setupRefreshButtonHook() {
        const panel = document.querySelector(LOOT_LOG_PANEL_SELECTOR);
        if (!panel) return;

        const refreshButton = panel.querySelector(REFRESH_BUTTON_SELECTOR);
        if (!refreshButton || refreshButton.dataset.eltBound === '1') return;

        refreshButton.dataset.eltBound = '1';
        refreshButton.addEventListener('click', () => {
            // Refreshing is asynchronous. Wait for the loot DOM to actually update
            // before recalculating, rather than parsing the old list on this tick.
            markRefreshRequested();
        });
    }

    // ======================
    // 数据访问帮助函数
    // ======================

    function decompressInitClientData(compressedData) {
        try {
            const decompressedJson = LZString.decompressFromUTF16(compressedData);
            if (!decompressedJson) {
                throw new Error("decompressInitClientData: decompressFromUTF16() returned null");
            }
            return JSON.parse(decompressedJson);
        } catch (error) {
            console.error("[Better Loot Tracker] decompressInitClientData: ", error);
            return null;
        }
    }

    let _cachedInitClientData = null;

    function getInitClientData() {
        if (_cachedInitClientData) return _cachedInitClientData;

        const stored = localStorage.getItem("initClientData");
        if (!stored) return null;

        // 解压缩
        const decompressed = decompressInitClientData(stored);
        if (decompressed) {
            _cachedInitClientData = decompressed;
            return decompressed;
        }

        return null;
    }

    // 获取市场数据 (来自MWITools)
    function getMarketData() {
        try {
            const marketDataStr = localStorage.getItem('MWITools_marketAPI_json');
            if (marketDataStr) {
                return JSON.parse(marketDataStr);
            }
        } catch (e) {
            console.error('[Better Loot Tracker] Error loading market data:', e);
        }
        // Reuse the public snapshot already fetched by the ranking module. This
        // keeps the tracker operational without a duplicate market-data script.
        const privateSnapshot = window.__MWI_PRIVATE_MARKET_SNAPSHOT__;
        if (privateSnapshot?.marketData) return privateSnapshot;
        return null;
    }

    function getMarketPrice(itemHRID, marketData) {
        if (itemHRID === '/items/coin' || itemHRID === '/items/coins') return 1;
        if (!itemHRID || typeof itemHRID !== 'string') return 0;
        if (!marketData?.marketData) return 0;

        const marketRoot = marketData.marketData[itemHRID];
        if (!marketRoot) return 0;

        const priceObject = marketRoot["0"];
        if (!priceObject) return 0;

        return priceObject.a || priceObject.b || 0;
    }

    function getMarketPriceSide(itemHRID, marketData, side) {
        if (itemHRID === '/items/coin' || itemHRID === '/items/coins') return 1;
        if (!itemHRID || typeof itemHRID !== 'string') return null;
        if (!marketData?.marketData) return null;

        const marketRoot = marketData.marketData[itemHRID];
        if (!marketRoot) return null;

        const priceObject = marketRoot["0"];
        if (!priceObject) return null;

        // Price modes must not silently substitute the other side of the book.
        const price = side === 'bid' ? priceObject.b : priceObject.a;
        const numericPrice = Number(price);
        return Number.isFinite(numericPrice) && numericPrice > 0 ? numericPrice : null;
    }

    /* 官方汉化 */
    const ZHItemNames = {
        "/items/coin": "金币",
        "/items/task_token": "任务代币",
        "/items/labyrinth_token": "迷宫代币",
        "/items/chimerical_token": "奇幻代币",
        "/items/sinister_token": "阴森代币",
        "/items/enchanted_token": "秘法代币",
        "/items/pirate_token": "海盗代币",
        "/items/cowbell": "牛铃",
        "/items/bag_of_10_cowbells": "牛铃袋 (10个)",
        "/items/purples_gift": "小紫牛的礼物",
        "/items/small_meteorite_cache": "小陨石舱",
        "/items/medium_meteorite_cache": "中陨石舱",
        "/items/large_meteorite_cache": "大陨石舱",
        "/items/small_artisans_crate": "小工匠匣",
        "/items/medium_artisans_crate": "中工匠匣",
        "/items/large_artisans_crate": "大工匠匣",
        "/items/small_treasure_chest": "小宝箱",
        "/items/medium_treasure_chest": "中宝箱",
        "/items/large_treasure_chest": "大宝箱",
        "/items/chimerical_chest": "奇幻宝箱",
        "/items/chimerical_refinement_chest": "奇幻精炼宝箱",
        "/items/sinister_chest": "阴森宝箱",
        "/items/sinister_refinement_chest": "阴森精炼宝箱",
        "/items/enchanted_chest": "秘法宝箱",
        "/items/enchanted_refinement_chest": "秘法精炼宝箱",
        "/items/pirate_chest": "海盗宝箱",
        "/items/pirate_refinement_chest": "海盗精炼宝箱",
        "/items/purdoras_box_skilling": "紫多拉之盒（生活）",
        "/items/purdoras_box_combat": "紫多拉之盒（战斗）",
        "/items/labyrinth_refinement_chest": "迷宫精炼宝箱",
        "/items/seal_of_gathering": "采集封印",
        "/items/seal_of_gourmet": "美食封印",
        "/items/seal_of_processing": "加工封印",
        "/items/seal_of_efficiency": "效率封印",
        "/items/seal_of_action_speed": "行动速度封印",
        "/items/seal_of_combat_drop": "战斗掉落封印",
        "/items/seal_of_attack_speed": "攻击速度封印",
        "/items/seal_of_cast_speed": "施法速度封印",
        "/items/seal_of_damage": "伤害封印",
        "/items/seal_of_critical_rate": "暴击率封印",
        "/items/seal_of_wisdom": "经验封印",
        "/items/seal_of_rare_find": "稀有发现封印",
        "/items/blue_key_fragment": "蓝色钥匙碎片",
        "/items/green_key_fragment": "绿色钥匙碎片",
        "/items/purple_key_fragment": "紫色钥匙碎片",
        "/items/white_key_fragment": "白色钥匙碎片",
        "/items/orange_key_fragment": "橙色钥匙碎片",
        "/items/brown_key_fragment": "棕色钥匙碎片",
        "/items/stone_key_fragment": "石头钥匙碎片",
        "/items/dark_key_fragment": "黑暗钥匙碎片",
        "/items/burning_key_fragment": "燃烧钥匙碎片",
        "/items/chimerical_entry_key": "奇幻钥匙",
        "/items/chimerical_chest_key": "奇幻宝箱钥匙",
        "/items/sinister_entry_key": "阴森钥匙",
        "/items/sinister_chest_key": "阴森宝箱钥匙",
        "/items/enchanted_entry_key": "秘法钥匙",
        "/items/enchanted_chest_key": "秘法宝箱钥匙",
        "/items/pirate_entry_key": "海盗钥匙",
        "/items/pirate_chest_key": "海盗宝箱钥匙",
        "/items/donut": "甜甜圈",
        "/items/blueberry_donut": "蓝莓甜甜圈",
        "/items/blackberry_donut": "黑莓甜甜圈",
        "/items/strawberry_donut": "草莓甜甜圈",
        "/items/mooberry_donut": "哞莓甜甜圈",
        "/items/marsberry_donut": "火星莓甜甜圈",
        "/items/spaceberry_donut": "太空莓甜甜圈",
        "/items/cupcake": "纸杯蛋糕",
        "/items/blueberry_cake": "蓝莓蛋糕",
        "/items/blackberry_cake": "黑莓蛋糕",
        "/items/strawberry_cake": "草莓蛋糕",
        "/items/mooberry_cake": "哞莓蛋糕",
        "/items/marsberry_cake": "火星莓蛋糕",
        "/items/spaceberry_cake": "太空莓蛋糕",
        "/items/gummy": "软糖",
        "/items/apple_gummy": "苹果软糖",
        "/items/orange_gummy": "橙子软糖",
        "/items/plum_gummy": "李子软糖",
        "/items/peach_gummy": "桃子软糖",
        "/items/dragon_fruit_gummy": "火龙果软糖",
        "/items/star_fruit_gummy": "杨桃软糖",
        "/items/yogurt": "酸奶",
        "/items/apple_yogurt": "苹果酸奶",
        "/items/orange_yogurt": "橙子酸奶",
        "/items/plum_yogurt": "李子酸奶",
        "/items/peach_yogurt": "桃子酸奶",
        "/items/dragon_fruit_yogurt": "火龙果酸奶",
        "/items/star_fruit_yogurt": "杨桃酸奶",
        "/items/milking_tea": "挤奶茶",
        "/items/foraging_tea": "采摘茶",
        "/items/woodcutting_tea": "伐木茶",
        "/items/cooking_tea": "烹饪茶",
        "/items/brewing_tea": "冲泡茶",
        "/items/alchemy_tea": "炼金茶",
        "/items/enhancing_tea": "强化茶",
        "/items/cheesesmithing_tea": "奶酪锻造茶",
        "/items/crafting_tea": "制作茶",
        "/items/tailoring_tea": "缝纫茶",
        "/items/super_milking_tea": "超级挤奶茶",
        "/items/super_foraging_tea": "超级采摘茶",
        "/items/super_woodcutting_tea": "超级伐木茶",
        "/items/super_cooking_tea": "超级烹饪茶",
        "/items/super_brewing_tea": "超级冲泡茶",
        "/items/super_alchemy_tea": "超级炼金茶",
        "/items/super_enhancing_tea": "超级强化茶",
        "/items/super_cheesesmithing_tea": "超级奶酪锻造茶",
        "/items/super_crafting_tea": "超级制作茶",
        "/items/super_tailoring_tea": "超级缝纫茶",
        "/items/ultra_milking_tea": "究极挤奶茶",
        "/items/ultra_foraging_tea": "究极采摘茶",
        "/items/ultra_woodcutting_tea": "究极伐木茶",
        "/items/ultra_cooking_tea": "究极烹饪茶",
        "/items/ultra_brewing_tea": "究极冲泡茶",
        "/items/ultra_alchemy_tea": "究极炼金茶",
        "/items/ultra_enhancing_tea": "究极强化茶",
        "/items/ultra_cheesesmithing_tea": "究极奶酪锻造茶",
        "/items/ultra_crafting_tea": "究极制作茶",
        "/items/ultra_tailoring_tea": "究极缝纫茶",
        "/items/gathering_tea": "采集茶",
        "/items/gourmet_tea": "美食茶",
        "/items/wisdom_tea": "经验茶",
        "/items/processing_tea": "加工茶",
        "/items/efficiency_tea": "效率茶",
        "/items/artisan_tea": "工匠茶",
        "/items/catalytic_tea": "催化茶",
        "/items/blessed_tea": "福气茶",
        "/items/stamina_coffee": "耐力咖啡",
        "/items/intelligence_coffee": "智力咖啡",
        "/items/defense_coffee": "防御咖啡",
        "/items/attack_coffee": "攻击咖啡",
        "/items/melee_coffee": "近战咖啡",
        "/items/ranged_coffee": "远程咖啡",
        "/items/magic_coffee": "魔法咖啡",
        "/items/super_stamina_coffee": "超级耐力咖啡",
        "/items/super_intelligence_coffee": "超级智力咖啡",
        "/items/super_defense_coffee": "超级防御咖啡",
        "/items/super_attack_coffee": "超级攻击咖啡",
        "/items/super_melee_coffee": "超级近战咖啡",
        "/items/super_ranged_coffee": "超级远程咖啡",
        "/items/super_magic_coffee": "超级魔法咖啡",
        "/items/ultra_stamina_coffee": "究极耐力咖啡",
        "/items/ultra_intelligence_coffee": "究极智力咖啡",
        "/items/ultra_defense_coffee": "究极防御咖啡",
        "/items/ultra_attack_coffee": "究极攻击咖啡",
        "/items/ultra_melee_coffee": "究极近战咖啡",
        "/items/ultra_ranged_coffee": "究极远程咖啡",
        "/items/ultra_magic_coffee": "究极魔法咖啡",
        "/items/wisdom_coffee": "经验咖啡",
        "/items/lucky_coffee": "幸运咖啡",
        "/items/swiftness_coffee": "迅捷咖啡",
        "/items/channeling_coffee": "吟唱咖啡",
        "/items/critical_coffee": "暴击咖啡",
        "/items/poke": "破胆之刺",
        "/items/impale": "透骨之刺",
        "/items/puncture": "破甲之刺",
        "/items/penetrating_strike": "贯心之刺",
        "/items/scratch": "爪影斩",
        "/items/cleave": "分裂斩",
        "/items/maim": "血刃斩",
        "/items/crippling_slash": "致残斩",
        "/items/smack": "重碾",
        "/items/sweep": "重扫",
        "/items/stunning_blow": "重锤",
        "/items/fracturing_impact": "碎裂冲击",
        "/items/shield_bash": "盾击",
        "/items/quick_shot": "快速射击",
        "/items/aqua_arrow": "流水箭",
        "/items/flame_arrow": "烈焰箭",
        "/items/rain_of_arrows": "箭雨",
        "/items/silencing_shot": "沉默之箭",
        "/items/steady_shot": "稳定射击",
        "/items/pestilent_shot": "疫病射击",
        "/items/penetrating_shot": "贯穿射击",
        "/items/water_strike": "流水冲击",
        "/items/ice_spear": "冰枪术",
        "/items/frost_surge": "冰霜爆裂",
        "/items/mana_spring": "法力喷泉",
        "/items/entangle": "缠绕",
        "/items/toxic_pollen": "剧毒粉尘",
        "/items/natures_veil": "自然菌幕",
        "/items/life_drain": "生命吸取",
        "/items/fireball": "火球",
        "/items/flame_blast": "熔岩爆裂",
        "/items/firestorm": "火焰风暴",
        "/items/smoke_burst": "烟爆灭影",
        "/items/minor_heal": "初级自愈术",
        "/items/heal": "自愈术",
        "/items/quick_aid": "快速治疗术",
        "/items/rejuvenate": "群体治疗术",
        "/items/taunt": "嘲讽",
        "/items/provoke": "挑衅",
        "/items/toughness": "坚韧",
        "/items/elusiveness": "闪避",
        "/items/precision": "精确",
        "/items/berserk": "狂暴",
        "/items/elemental_affinity": "元素增幅",
        "/items/frenzy": "狂速",
        "/items/spike_shell": "尖刺防护",
        "/items/retribution": "惩戒",
        "/items/vampirism": "吸血",
        "/items/revive": "复活",
        "/items/insanity": "疯狂",
        "/items/invincible": "无敌",
        "/items/speed_aura": "速度光环",
        "/items/guardian_aura": "守护光环",
        "/items/fierce_aura": "物理光环",
        "/items/critical_aura": "暴击光环",
        "/items/mystic_aura": "元素光环",
        "/items/gobo_stabber": "哥布林长剑",
        "/items/gobo_slasher": "哥布林关刀",
        "/items/gobo_smasher": "哥布林狼牙棒",
        "/items/spiked_bulwark": "尖刺重盾",
        "/items/werewolf_slasher": "狼人关刀",
        "/items/griffin_bulwark": "狮鹫重盾",
        "/items/griffin_bulwark_refined": "狮鹫重盾（精）",
        "/items/gobo_shooter": "哥布林弹弓",
        "/items/vampiric_bow": "吸血弓",
        "/items/cursed_bow": "咒怨之弓",
        "/items/cursed_bow_refined": "咒怨之弓（精）",
        "/items/gobo_boomstick": "哥布林火棍",
        "/items/cheese_bulwark": "奶酪重盾",
        "/items/verdant_bulwark": "翠绿重盾",
        "/items/azure_bulwark": "蔚蓝重盾",
        "/items/burble_bulwark": "深紫重盾",
        "/items/crimson_bulwark": "绛红重盾",
        "/items/rainbow_bulwark": "彩虹重盾",
        "/items/holy_bulwark": "神圣重盾",
        "/items/wooden_bow": "木弓",
        "/items/birch_bow": "桦木弓",
        "/items/cedar_bow": "雪松弓",
        "/items/purpleheart_bow": "紫心弓",
        "/items/ginkgo_bow": "银杏弓",
        "/items/redwood_bow": "红杉弓",
        "/items/arcane_bow": "神秘弓",
        "/items/stalactite_spear": "石钟长枪",
        "/items/granite_bludgeon": "花岗岩大棒",
        "/items/furious_spear": "狂怒长枪",
        "/items/furious_spear_refined": "狂怒长枪（精）",
        "/items/regal_sword": "君王之剑",
        "/items/regal_sword_refined": "君王之剑（精）",
        "/items/chaotic_flail": "混沌连枷",
        "/items/chaotic_flail_refined": "混沌连枷（精）",
        "/items/soul_hunter_crossbow": "灵魂猎手弩",
        "/items/sundering_crossbow": "裂空之弩",
        "/items/sundering_crossbow_refined": "裂空之弩（精）",
        "/items/frost_staff": "冰霜法杖",
        "/items/infernal_battlestaff": "炼狱法杖",
        "/items/jackalope_staff": "鹿角兔之杖",
        "/items/rippling_trident": "涟漪三叉戟",
        "/items/rippling_trident_refined": "涟漪三叉戟（精）",
        "/items/blooming_trident": "绽放三叉戟",
        "/items/blooming_trident_refined": "绽放三叉戟（精）",
        "/items/blazing_trident": "炽焰三叉戟",
        "/items/blazing_trident_refined": "炽焰三叉戟（精）",
        "/items/cheese_sword": "奶酪剑",
        "/items/verdant_sword": "翠绿剑",
        "/items/azure_sword": "蔚蓝剑",
        "/items/burble_sword": "深紫剑",
        "/items/crimson_sword": "绛红剑",
        "/items/rainbow_sword": "彩虹剑",
        "/items/holy_sword": "神圣剑",
        "/items/cheese_spear": "奶酪长枪",
        "/items/verdant_spear": "翠绿长枪",
        "/items/azure_spear": "蔚蓝长枪",
        "/items/burble_spear": "深紫长枪",
        "/items/crimson_spear": "绛红长枪",
        "/items/rainbow_spear": "彩虹长枪",
        "/items/holy_spear": "神圣长枪",
        "/items/cheese_mace": "奶酪钉头锤",
        "/items/verdant_mace": "翠绿钉头锤",
        "/items/azure_mace": "蔚蓝钉头锤",
        "/items/burble_mace": "深紫钉头锤",
        "/items/crimson_mace": "绛红钉头锤",
        "/items/rainbow_mace": "彩虹钉头锤",
        "/items/holy_mace": "神圣钉头锤",
        "/items/wooden_crossbow": "木弩",
        "/items/birch_crossbow": "桦木弩",
        "/items/cedar_crossbow": "雪松弩",
        "/items/purpleheart_crossbow": "紫心弩",
        "/items/ginkgo_crossbow": "银杏弩",
        "/items/redwood_crossbow": "红杉弩",
        "/items/arcane_crossbow": "神秘弩",
        "/items/wooden_water_staff": "木制水法杖",
        "/items/birch_water_staff": "桦木水法杖",
        "/items/cedar_water_staff": "雪松水法杖",
        "/items/purpleheart_water_staff": "紫心水法杖",
        "/items/ginkgo_water_staff": "银杏水法杖",
        "/items/redwood_water_staff": "红杉水法杖",
        "/items/arcane_water_staff": "神秘水法杖",
        "/items/wooden_nature_staff": "木制自然法杖",
        "/items/birch_nature_staff": "桦木自然法杖",
        "/items/cedar_nature_staff": "雪松自然法杖",
        "/items/purpleheart_nature_staff": "紫心自然法杖",
        "/items/ginkgo_nature_staff": "银杏自然法杖",
        "/items/redwood_nature_staff": "红杉自然法杖",
        "/items/arcane_nature_staff": "神秘自然法杖",
        "/items/wooden_fire_staff": "木制火法杖",
        "/items/birch_fire_staff": "桦木火法杖",
        "/items/cedar_fire_staff": "雪松火法杖",
        "/items/purpleheart_fire_staff": "紫心火法杖",
        "/items/ginkgo_fire_staff": "银杏火法杖",
        "/items/redwood_fire_staff": "红杉火法杖",
        "/items/arcane_fire_staff": "神秘火法杖",
        "/items/eye_watch": "掌上监工",
        "/items/snake_fang_dirk": "蛇牙短剑",
        "/items/vision_shield": "视觉盾",
        "/items/gobo_defender": "哥布林防御者",
        "/items/vampire_fang_dirk": "吸血鬼短剑",
        "/items/knights_aegis": "骑士盾",
        "/items/knights_aegis_refined": "骑士盾（精）",
        "/items/treant_shield": "树人盾",
        "/items/manticore_shield": "蝎狮盾",
        "/items/tome_of_healing": "治疗之书",
        "/items/tome_of_the_elements": "元素之书",
        "/items/watchful_relic": "警戒遗物",
        "/items/bishops_codex": "主教法典",
        "/items/bishops_codex_refined": "主教法典（精）",
        "/items/cheese_buckler": "奶酪圆盾",
        "/items/verdant_buckler": "翠绿圆盾",
        "/items/azure_buckler": "蔚蓝圆盾",
        "/items/burble_buckler": "深紫圆盾",
        "/items/crimson_buckler": "绛红圆盾",
        "/items/rainbow_buckler": "彩虹圆盾",
        "/items/holy_buckler": "神圣圆盾",
        "/items/wooden_shield": "木盾",
        "/items/birch_shield": "桦木盾",
        "/items/cedar_shield": "雪松盾",
        "/items/purpleheart_shield": "紫心盾",
        "/items/ginkgo_shield": "银杏盾",
        "/items/redwood_shield": "红杉盾",
        "/items/arcane_shield": "神秘盾",
        "/items/gatherer_cape": "采集者披风",
        "/items/gatherer_cape_refined": "采集者披风（精）",
        "/items/artificer_cape": "工匠披风",
        "/items/artificer_cape_refined": "工匠披风（精）",
        "/items/culinary_cape": "烹饪披风",
        "/items/culinary_cape_refined": "烹饪披风（精）",
        "/items/chance_cape": "机缘披风",
        "/items/chance_cape_refined": "机缘披风（精）",
        "/items/sinister_cape": "阴森斗篷",
        "/items/sinister_cape_refined": "阴森斗篷（精）",
        "/items/chimerical_quiver": "奇幻箭袋",
        "/items/chimerical_quiver_refined": "奇幻箭袋（精）",
        "/items/enchanted_cloak": "秘法披风",
        "/items/enchanted_cloak_refined": "秘法披风（精）",
        "/items/red_culinary_hat": "红色厨师帽",
        "/items/snail_shell_helmet": "蜗牛壳头盔",
        "/items/vision_helmet": "视觉头盔",
        "/items/fluffy_red_hat": "蓬松红帽子",
        "/items/corsair_helmet": "掠夺者头盔",
        "/items/corsair_helmet_refined": "掠夺者头盔（精）",
        "/items/acrobatic_hood": "杂技师兜帽",
        "/items/acrobatic_hood_refined": "杂技师兜帽（精）",
        "/items/magicians_hat": "魔术师帽",
        "/items/magicians_hat_refined": "魔术师帽（精）",
        "/items/cheese_helmet": "奶酪头盔",
        "/items/verdant_helmet": "翠绿头盔",
        "/items/azure_helmet": "蔚蓝头盔",
        "/items/burble_helmet": "深紫头盔",
        "/items/crimson_helmet": "绛红头盔",
        "/items/rainbow_helmet": "彩虹头盔",
        "/items/holy_helmet": "神圣头盔",
        "/items/rough_hood": "粗糙兜帽",
        "/items/reptile_hood": "爬行动物兜帽",
        "/items/gobo_hood": "哥布林兜帽",
        "/items/beast_hood": "野兽兜帽",
        "/items/umbral_hood": "暗影兜帽",
        "/items/cotton_hat": "棉帽",
        "/items/linen_hat": "亚麻帽",
        "/items/bamboo_hat": "竹帽",
        "/items/silk_hat": "丝帽",
        "/items/radiant_hat": "光辉帽",
        "/items/dairyhands_top": "挤奶工上衣",
        "/items/foragers_top": "采摘者上衣",
        "/items/lumberjacks_top": "伐木工上衣",
        "/items/cheesemakers_top": "奶酪师上衣",
        "/items/crafters_top": "工匠上衣",
        "/items/tailors_top": "裁缝上衣",
        "/items/chefs_top": "厨师上衣",
        "/items/brewers_top": "饮品师上衣",
        "/items/alchemists_top": "炼金师上衣",
        "/items/enhancers_top": "强化师上衣",
        "/items/gator_vest": "鳄鱼马甲",
        "/items/turtle_shell_body": "龟壳胸甲",
        "/items/colossus_plate_body": "巨像胸甲",
        "/items/demonic_plate_body": "恶魔胸甲",
        "/items/anchorbound_plate_body": "锚定胸甲",
        "/items/anchorbound_plate_body_refined": "锚定胸甲（精）",
        "/items/maelstrom_plate_body": "怒涛胸甲",
        "/items/maelstrom_plate_body_refined": "怒涛胸甲（精）",
        "/items/marine_tunic": "海洋皮衣",
        "/items/revenant_tunic": "亡灵皮衣",
        "/items/griffin_tunic": "狮鹫皮衣",
        "/items/kraken_tunic": "克拉肯皮衣",
        "/items/kraken_tunic_refined": "克拉肯皮衣（精）",
        "/items/icy_robe_top": "冰霜袍服",
        "/items/flaming_robe_top": "烈焰袍服",
        "/items/luna_robe_top": "月神袍服",
        "/items/royal_water_robe_top": "皇家水系袍服",
        "/items/royal_water_robe_top_refined": "皇家水系袍服（精）",
        "/items/royal_nature_robe_top": "皇家自然系袍服",
        "/items/royal_nature_robe_top_refined": "皇家自然系袍服（精）",
        "/items/royal_fire_robe_top": "皇家火系袍服",
        "/items/royal_fire_robe_top_refined": "皇家火系袍服（精）",
        "/items/cheese_plate_body": "奶酪胸甲",
        "/items/verdant_plate_body": "翠绿胸甲",
        "/items/azure_plate_body": "蔚蓝胸甲",
        "/items/burble_plate_body": "深紫胸甲",
        "/items/crimson_plate_body": "绛红胸甲",
        "/items/rainbow_plate_body": "彩虹胸甲",
        "/items/holy_plate_body": "神圣胸甲",
        "/items/rough_tunic": "粗糙皮衣",
        "/items/reptile_tunic": "爬行动物皮衣",
        "/items/gobo_tunic": "哥布林皮衣",
        "/items/beast_tunic": "野兽皮衣",
        "/items/umbral_tunic": "暗影皮衣",
        "/items/cotton_robe_top": "棉袍服",
        "/items/linen_robe_top": "亚麻袍服",
        "/items/bamboo_robe_top": "竹袍服",
        "/items/silk_robe_top": "丝绸袍服",
        "/items/radiant_robe_top": "光辉袍服",
        "/items/dairyhands_bottoms": "挤奶工下装",
        "/items/foragers_bottoms": "采摘者下装",
        "/items/lumberjacks_bottoms": "伐木工下装",
        "/items/cheesemakers_bottoms": "奶酪师下装",
        "/items/crafters_bottoms": "工匠下装",
        "/items/tailors_bottoms": "裁缝下装",
        "/items/chefs_bottoms": "厨师下装",
        "/items/brewers_bottoms": "饮品师下装",
        "/items/alchemists_bottoms": "炼金师下装",
        "/items/enhancers_bottoms": "强化师下装",
        "/items/turtle_shell_legs": "龟壳腿甲",
        "/items/colossus_plate_legs": "巨像腿甲",
        "/items/demonic_plate_legs": "恶魔腿甲",
        "/items/anchorbound_plate_legs": "锚定腿甲",
        "/items/anchorbound_plate_legs_refined": "锚定腿甲（精）",
        "/items/maelstrom_plate_legs": "怒涛腿甲",
        "/items/maelstrom_plate_legs_refined": "怒涛腿甲（精）",
        "/items/marine_chaps": "航海皮裤",
        "/items/revenant_chaps": "亡灵皮裤",
        "/items/griffin_chaps": "狮鹫皮裤",
        "/items/kraken_chaps": "克拉肯皮裤",
        "/items/kraken_chaps_refined": "克拉肯皮裤（精）",
        "/items/icy_robe_bottoms": "冰霜袍裙",
        "/items/flaming_robe_bottoms": "烈焰袍裙",
        "/items/luna_robe_bottoms": "月神袍裙",
        "/items/royal_water_robe_bottoms": "皇家水系袍裙",
        "/items/royal_water_robe_bottoms_refined": "皇家水系袍裙（精）",
        "/items/royal_nature_robe_bottoms": "皇家自然系袍裙",
        "/items/royal_nature_robe_bottoms_refined": "皇家自然系袍裙（精）",
        "/items/royal_fire_robe_bottoms": "皇家火系袍裙",
        "/items/royal_fire_robe_bottoms_refined": "皇家火系袍裙（精）",
        "/items/cheese_plate_legs": "奶酪腿甲",
        "/items/verdant_plate_legs": "翠绿腿甲",
        "/items/azure_plate_legs": "蔚蓝腿甲",
        "/items/burble_plate_legs": "深紫腿甲",
        "/items/crimson_plate_legs": "绛红腿甲",
        "/items/rainbow_plate_legs": "彩虹腿甲",
        "/items/holy_plate_legs": "神圣腿甲",
        "/items/rough_chaps": "粗糙皮裤",
        "/items/reptile_chaps": "爬行动物皮裤",
        "/items/gobo_chaps": "哥布林皮裤",
        "/items/beast_chaps": "野兽皮裤",
        "/items/umbral_chaps": "暗影皮裤",
        "/items/cotton_robe_bottoms": "棉袍裙",
        "/items/linen_robe_bottoms": "亚麻袍裙",
        "/items/bamboo_robe_bottoms": "竹袍裙",
        "/items/silk_robe_bottoms": "丝绸袍裙",
        "/items/radiant_robe_bottoms": "光辉袍裙",
        "/items/enchanted_gloves": "附魔手套",
        "/items/pincer_gloves": "蟹钳手套",
        "/items/panda_gloves": "熊猫手套",
        "/items/magnetic_gloves": "磁力手套",
        "/items/dodocamel_gauntlets": "渡渡驼护手",
        "/items/dodocamel_gauntlets_refined": "渡渡驼护手（精）",
        "/items/sighted_bracers": "瞄准护腕",
        "/items/marksman_bracers": "神射护腕",
        "/items/marksman_bracers_refined": "神射护腕（精）",
        "/items/chrono_gloves": "时空手套",
        "/items/cheese_gauntlets": "奶酪护手",
        "/items/verdant_gauntlets": "翠绿护手",
        "/items/azure_gauntlets": "蔚蓝护手",
        "/items/burble_gauntlets": "深紫护手",
        "/items/crimson_gauntlets": "绛红护手",
        "/items/rainbow_gauntlets": "彩虹护手",
        "/items/holy_gauntlets": "神圣护手",
        "/items/rough_bracers": "粗糙护腕",
        "/items/reptile_bracers": "爬行动物护腕",
        "/items/gobo_bracers": "哥布林护腕",
        "/items/beast_bracers": "野兽护腕",
        "/items/umbral_bracers": "暗影护腕",
        "/items/cotton_gloves": "棉手套",
        "/items/linen_gloves": "亚麻手套",
        "/items/bamboo_gloves": "竹手套",
        "/items/silk_gloves": "丝手套",
        "/items/radiant_gloves": "光辉手套",
        "/items/collectors_boots": "收藏家靴",
        "/items/shoebill_shoes": "鲸头鹳鞋",
        "/items/black_bear_shoes": "黑熊鞋",
        "/items/grizzly_bear_shoes": "棕熊鞋",
        "/items/polar_bear_shoes": "北极熊鞋",
        "/items/pathbreaker_boots": "开路者靴",
        "/items/pathbreaker_boots_refined": "开路者靴（精）",
        "/items/centaur_boots": "半人马靴",
        "/items/pathfinder_boots": "探路者靴",
        "/items/pathfinder_boots_refined": "探路者靴（精）",
        "/items/sorcerer_boots": "巫师靴",
        "/items/pathseeker_boots": "寻路者靴",
        "/items/pathseeker_boots_refined": "寻路者靴（精）",
        "/items/cheese_boots": "奶酪靴",
        "/items/verdant_boots": "翠绿靴",
        "/items/azure_boots": "蔚蓝靴",
        "/items/burble_boots": "深紫靴",
        "/items/crimson_boots": "绛红靴",
        "/items/rainbow_boots": "彩虹靴",
        "/items/holy_boots": "神圣靴",
        "/items/rough_boots": "粗糙靴",
        "/items/reptile_boots": "爬行动物靴",
        "/items/gobo_boots": "哥布林靴",
        "/items/beast_boots": "野兽靴",
        "/items/umbral_boots": "暗影靴",
        "/items/cotton_boots": "棉靴",
        "/items/linen_boots": "亚麻靴",
        "/items/bamboo_boots": "竹靴",
        "/items/silk_boots": "丝靴",
        "/items/radiant_boots": "光辉靴",
        "/items/small_pouch": "小袋子",
        "/items/medium_pouch": "中袋子",
        "/items/large_pouch": "大袋子",
        "/items/giant_pouch": "巨大袋子",
        "/items/gluttonous_pouch": "贪食之袋",
        "/items/guzzling_pouch": "暴饮之囊",
        "/items/necklace_of_efficiency": "效率项链",
        "/items/fighter_necklace": "战士项链",
        "/items/ranger_necklace": "射手项链",
        "/items/wizard_necklace": "巫师项链",
        "/items/necklace_of_wisdom": "经验项链",
        "/items/necklace_of_speed": "速度项链",
        "/items/philosophers_necklace": "贤者项链",
        "/items/earrings_of_gathering": "采集耳环",
        "/items/earrings_of_essence_find": "精华发现耳环",
        "/items/earrings_of_armor": "护甲耳环",
        "/items/earrings_of_regeneration": "恢复耳环",
        "/items/earrings_of_resistance": "抗性耳环",
        "/items/earrings_of_rare_find": "稀有发现耳环",
        "/items/earrings_of_critical_strike": "暴击耳环",
        "/items/philosophers_earrings": "贤者耳环",
        "/items/ring_of_gathering": "采集戒指",
        "/items/ring_of_essence_find": "精华发现戒指",
        "/items/ring_of_armor": "护甲戒指",
        "/items/ring_of_regeneration": "恢复戒指",
        "/items/ring_of_resistance": "抗性戒指",
        "/items/ring_of_rare_find": "稀有发现戒指",
        "/items/ring_of_critical_strike": "暴击戒指",
        "/items/philosophers_ring": "贤者戒指",
        "/items/trainee_milking_charm": "实习挤奶护符",
        "/items/basic_milking_charm": "基础挤奶护符",
        "/items/advanced_milking_charm": "高级挤奶护符",
        "/items/expert_milking_charm": "专家挤奶护符",
        "/items/master_milking_charm": "大师挤奶护符",
        "/items/grandmaster_milking_charm": "宗师挤奶护符",
        "/items/trainee_foraging_charm": "实习采摘护符",
        "/items/basic_foraging_charm": "基础采摘护符",
        "/items/advanced_foraging_charm": "高级采摘护符",
        "/items/expert_foraging_charm": "专家采摘护符",
        "/items/master_foraging_charm": "大师采摘护符",
        "/items/grandmaster_foraging_charm": "宗师采摘护符",
        "/items/trainee_woodcutting_charm": "实习伐木护符",
        "/items/basic_woodcutting_charm": "基础伐木护符",
        "/items/advanced_woodcutting_charm": "高级伐木护符",
        "/items/expert_woodcutting_charm": "专家伐木护符",
        "/items/master_woodcutting_charm": "大师伐木护符",
        "/items/grandmaster_woodcutting_charm": "宗师伐木护符",
        "/items/trainee_cheesesmithing_charm": "实习奶酪锻造护符",
        "/items/basic_cheesesmithing_charm": "基础奶酪锻造护符",
        "/items/advanced_cheesesmithing_charm": "高级奶酪锻造护符",
        "/items/expert_cheesesmithing_charm": "专家奶酪锻造护符",
        "/items/master_cheesesmithing_charm": "大师奶酪锻造护符",
        "/items/grandmaster_cheesesmithing_charm": "宗师奶酪锻造护符",
        "/items/trainee_crafting_charm": "实习制作护符",
        "/items/basic_crafting_charm": "基础制作护符",
        "/items/advanced_crafting_charm": "高级制作护符",
        "/items/expert_crafting_charm": "专家制作护符",
        "/items/master_crafting_charm": "大师制作护符",
        "/items/grandmaster_crafting_charm": "宗师制作护符",
        "/items/trainee_tailoring_charm": "实习缝纫护符",
        "/items/basic_tailoring_charm": "基础缝纫护符",
        "/items/advanced_tailoring_charm": "高级缝纫护符",
        "/items/expert_tailoring_charm": "专家缝纫护符",
        "/items/master_tailoring_charm": "大师缝纫护符",
        "/items/grandmaster_tailoring_charm": "宗师缝纫护符",
        "/items/trainee_cooking_charm": "实习烹饪护符",
        "/items/basic_cooking_charm": "基础烹饪护符",
        "/items/advanced_cooking_charm": "高级烹饪护符",
        "/items/expert_cooking_charm": "专家烹饪护符",
        "/items/master_cooking_charm": "大师烹饪护符",
        "/items/grandmaster_cooking_charm": "宗师烹饪护符",
        "/items/trainee_brewing_charm": "实习冲泡护符",
        "/items/basic_brewing_charm": "基础冲泡护符",
        "/items/advanced_brewing_charm": "高级冲泡护符",
        "/items/expert_brewing_charm": "专家冲泡护符",
        "/items/master_brewing_charm": "大师冲泡护符",
        "/items/grandmaster_brewing_charm": "宗师冲泡护符",
        "/items/trainee_alchemy_charm": "实习炼金护符",
        "/items/basic_alchemy_charm": "基础炼金护符",
        "/items/advanced_alchemy_charm": "高级炼金护符",
        "/items/expert_alchemy_charm": "专家炼金护符",
        "/items/master_alchemy_charm": "大师炼金护符",
        "/items/grandmaster_alchemy_charm": "宗师炼金护符",
        "/items/trainee_enhancing_charm": "实习强化护符",
        "/items/basic_enhancing_charm": "基础强化护符",
        "/items/advanced_enhancing_charm": "高级强化护符",
        "/items/expert_enhancing_charm": "专家强化护符",
        "/items/master_enhancing_charm": "大师强化护符",
        "/items/grandmaster_enhancing_charm": "宗师强化护符",
        "/items/trainee_stamina_charm": "实习耐力护符",
        "/items/basic_stamina_charm": "基础耐力护符",
        "/items/advanced_stamina_charm": "高级耐力护符",
        "/items/expert_stamina_charm": "专家耐力护符",
        "/items/master_stamina_charm": "大师耐力护符",
        "/items/grandmaster_stamina_charm": "宗师耐力护符",
        "/items/trainee_intelligence_charm": "实习智力护符",
        "/items/basic_intelligence_charm": "基础智力护符",
        "/items/advanced_intelligence_charm": "高级智力护符",
        "/items/expert_intelligence_charm": "专家智力护符",
        "/items/master_intelligence_charm": "大师智力护符",
        "/items/grandmaster_intelligence_charm": "宗师智力护符",
        "/items/trainee_attack_charm": "实习攻击护符",
        "/items/basic_attack_charm": "基础攻击护符",
        "/items/advanced_attack_charm": "高级攻击护符",
        "/items/expert_attack_charm": "专家攻击护符",
        "/items/master_attack_charm": "大师攻击护符",
        "/items/grandmaster_attack_charm": "宗师攻击护符",
        "/items/trainee_defense_charm": "实习防御护符",
        "/items/basic_defense_charm": "基础防御护符",
        "/items/advanced_defense_charm": "高级防御护符",
        "/items/expert_defense_charm": "专家防御护符",
        "/items/master_defense_charm": "大师防御护符",
        "/items/grandmaster_defense_charm": "宗师防御护符",
        "/items/trainee_melee_charm": "实习近战护符",
        "/items/basic_melee_charm": "基础近战护符",
        "/items/advanced_melee_charm": "高级近战护符",
        "/items/expert_melee_charm": "专家近战护符",
        "/items/master_melee_charm": "大师近战护符",
        "/items/grandmaster_melee_charm": "宗师近战护符",
        "/items/trainee_ranged_charm": "实习远程护符",
        "/items/basic_ranged_charm": "基础远程护符",
        "/items/advanced_ranged_charm": "高级远程护符",
        "/items/expert_ranged_charm": "专家远程护符",
        "/items/master_ranged_charm": "大师远程护符",
        "/items/grandmaster_ranged_charm": "宗师远程护符",
        "/items/trainee_magic_charm": "实习魔法护符",
        "/items/basic_magic_charm": "基础魔法护符",
        "/items/advanced_magic_charm": "高级魔法护符",
        "/items/expert_magic_charm": "专家魔法护符",
        "/items/master_magic_charm": "大师魔法护符",
        "/items/grandmaster_magic_charm": "宗师魔法护符",
        "/items/basic_task_badge": "基础任务徽章",
        "/items/advanced_task_badge": "高级任务徽章",
        "/items/expert_task_badge": "专家任务徽章",
        "/items/celestial_brush": "星空刷子",
        "/items/cheese_brush": "奶酪刷子",
        "/items/verdant_brush": "翠绿刷子",
        "/items/azure_brush": "蔚蓝刷子",
        "/items/burble_brush": "深紫刷子",
        "/items/crimson_brush": "绛红刷子",
        "/items/rainbow_brush": "彩虹刷子",
        "/items/holy_brush": "神圣刷子",
        "/items/celestial_shears": "星空剪刀",
        "/items/cheese_shears": "奶酪剪刀",
        "/items/verdant_shears": "翠绿剪刀",
        "/items/azure_shears": "蔚蓝剪刀",
        "/items/burble_shears": "深紫剪刀",
        "/items/crimson_shears": "绛红剪刀",
        "/items/rainbow_shears": "彩虹剪刀",
        "/items/holy_shears": "神圣剪刀",
        "/items/celestial_hatchet": "星空斧头",
        "/items/cheese_hatchet": "奶酪斧头",
        "/items/verdant_hatchet": "翠绿斧头",
        "/items/azure_hatchet": "蔚蓝斧头",
        "/items/burble_hatchet": "深紫斧头",
        "/items/crimson_hatchet": "绛红斧头",
        "/items/rainbow_hatchet": "彩虹斧头",
        "/items/holy_hatchet": "神圣斧头",
        "/items/celestial_hammer": "星空锤子",
        "/items/cheese_hammer": "奶酪锤子",
        "/items/verdant_hammer": "翠绿锤子",
        "/items/azure_hammer": "蔚蓝锤子",
        "/items/burble_hammer": "深紫锤子",
        "/items/crimson_hammer": "绛红锤子",
        "/items/rainbow_hammer": "彩虹锤子",
        "/items/holy_hammer": "神圣锤子",
        "/items/celestial_chisel": "星空凿子",
        "/items/cheese_chisel": "奶酪凿子",
        "/items/verdant_chisel": "翠绿凿子",
        "/items/azure_chisel": "蔚蓝凿子",
        "/items/burble_chisel": "深紫凿子",
        "/items/crimson_chisel": "绛红凿子",
        "/items/rainbow_chisel": "彩虹凿子",
        "/items/holy_chisel": "神圣凿子",
        "/items/celestial_needle": "星空针",
        "/items/cheese_needle": "奶酪针",
        "/items/verdant_needle": "翠绿针",
        "/items/azure_needle": "蔚蓝针",
        "/items/burble_needle": "深紫针",
        "/items/crimson_needle": "绛红针",
        "/items/rainbow_needle": "彩虹针",
        "/items/holy_needle": "神圣针",
        "/items/celestial_spatula": "星空锅铲",
        "/items/cheese_spatula": "奶酪锅铲",
        "/items/verdant_spatula": "翠绿锅铲",
        "/items/azure_spatula": "蔚蓝锅铲",
        "/items/burble_spatula": "深紫锅铲",
        "/items/crimson_spatula": "绛红锅铲",
        "/items/rainbow_spatula": "彩虹锅铲",
        "/items/holy_spatula": "神圣锅铲",
        "/items/celestial_pot": "星空壶",
        "/items/cheese_pot": "奶酪壶",
        "/items/verdant_pot": "翠绿壶",
        "/items/azure_pot": "蔚蓝壶",
        "/items/burble_pot": "深紫壶",
        "/items/crimson_pot": "绛红壶",
        "/items/rainbow_pot": "彩虹壶",
        "/items/holy_pot": "神圣壶",
        "/items/celestial_alembic": "星空蒸馏器",
        "/items/cheese_alembic": "奶酪蒸馏器",
        "/items/verdant_alembic": "翠绿蒸馏器",
        "/items/azure_alembic": "蔚蓝蒸馏器",
        "/items/burble_alembic": "深紫蒸馏器",
        "/items/crimson_alembic": "绛红蒸馏器",
        "/items/rainbow_alembic": "彩虹蒸馏器",
        "/items/holy_alembic": "神圣蒸馏器",
        "/items/celestial_enhancer": "星空强化器",
        "/items/cheese_enhancer": "奶酪强化器",
        "/items/verdant_enhancer": "翠绿强化器",
        "/items/azure_enhancer": "蔚蓝强化器",
        "/items/burble_enhancer": "深紫强化器",
        "/items/crimson_enhancer": "绛红强化器",
        "/items/rainbow_enhancer": "彩虹强化器",
        "/items/holy_enhancer": "神圣强化器",
        "/items/milk": "牛奶",
        "/items/verdant_milk": "翠绿牛奶",
        "/items/azure_milk": "蔚蓝牛奶",
        "/items/burble_milk": "深紫牛奶",
        "/items/crimson_milk": "绛红牛奶",
        "/items/rainbow_milk": "彩虹牛奶",
        "/items/holy_milk": "神圣牛奶",
        "/items/cheese": "奶酪",
        "/items/verdant_cheese": "翠绿奶酪",
        "/items/azure_cheese": "蔚蓝奶酪",
        "/items/burble_cheese": "深紫奶酪",
        "/items/crimson_cheese": "绛红奶酪",
        "/items/rainbow_cheese": "彩虹奶酪",
        "/items/holy_cheese": "神圣奶酪",
        "/items/log": "原木",
        "/items/birch_log": "白桦原木",
        "/items/cedar_log": "雪松原木",
        "/items/purpleheart_log": "紫心原木",
        "/items/ginkgo_log": "银杏原木",
        "/items/redwood_log": "红杉原木",
        "/items/arcane_log": "神秘原木",
        "/items/lumber": "木板",
        "/items/birch_lumber": "白桦木板",
        "/items/cedar_lumber": "雪松木板",
        "/items/purpleheart_lumber": "紫心木板",
        "/items/ginkgo_lumber": "银杏木板",
        "/items/redwood_lumber": "红杉木板",
        "/items/arcane_lumber": "神秘木板",
        "/items/rough_hide": "粗糙兽皮",
        "/items/reptile_hide": "爬行动物皮",
        "/items/gobo_hide": "哥布林皮",
        "/items/beast_hide": "野兽皮",
        "/items/umbral_hide": "暗影皮",
        "/items/rough_leather": "粗糙皮革",
        "/items/reptile_leather": "爬行动物皮革",
        "/items/gobo_leather": "哥布林皮革",
        "/items/beast_leather": "野兽皮革",
        "/items/umbral_leather": "暗影皮革",
        "/items/cotton": "棉花",
        "/items/flax": "亚麻",
        "/items/bamboo_branch": "竹子",
        "/items/cocoon": "蚕茧",
        "/items/radiant_fiber": "光辉纤维",
        "/items/cotton_fabric": "棉花布料",
        "/items/linen_fabric": "亚麻布料",
        "/items/bamboo_fabric": "竹子布料",
        "/items/silk_fabric": "丝绸",
        "/items/radiant_fabric": "光辉布料",
        "/items/egg": "鸡蛋",
        "/items/wheat": "小麦",
        "/items/sugar": "糖",
        "/items/blueberry": "蓝莓",
        "/items/blackberry": "黑莓",
        "/items/strawberry": "草莓",
        "/items/mooberry": "哞莓",
        "/items/marsberry": "火星莓",
        "/items/spaceberry": "太空莓",
        "/items/apple": "苹果",
        "/items/orange": "橙子",
        "/items/plum": "李子",
        "/items/peach": "桃子",
        "/items/dragon_fruit": "火龙果",
        "/items/star_fruit": "杨桃",
        "/items/arabica_coffee_bean": "低级咖啡豆",
        "/items/robusta_coffee_bean": "中级咖啡豆",
        "/items/liberica_coffee_bean": "高级咖啡豆",
        "/items/excelsa_coffee_bean": "特级咖啡豆",
        "/items/fieriosa_coffee_bean": "火山咖啡豆",
        "/items/spacia_coffee_bean": "太空咖啡豆",
        "/items/green_tea_leaf": "绿茶叶",
        "/items/black_tea_leaf": "黑茶叶",
        "/items/burble_tea_leaf": "紫茶叶",
        "/items/moolong_tea_leaf": "哞龙茶叶",
        "/items/red_tea_leaf": "红茶叶",
        "/items/emp_tea_leaf": "虚空茶叶",
        "/items/catalyst_of_coinification": "点金催化剂",
        "/items/catalyst_of_decomposition": "分解催化剂",
        "/items/catalyst_of_transmutation": "转化催化剂",
        "/items/prime_catalyst": "至高催化剂",
        "/items/snake_fang": "蛇牙",
        "/items/shoebill_feather": "鲸头鹳羽毛",
        "/items/snail_shell": "蜗牛壳",
        "/items/crab_pincer": "蟹钳",
        "/items/turtle_shell": "乌龟壳",
        "/items/marine_scale": "海洋鳞片",
        "/items/treant_bark": "树皮",
        "/items/centaur_hoof": "半人马蹄",
        "/items/luna_wing": "月神翼",
        "/items/gobo_rag": "哥布林抹布",
        "/items/goggles": "护目镜",
        "/items/magnifying_glass": "放大镜",
        "/items/eye_of_the_watcher": "观察者之眼",
        "/items/icy_cloth": "冰霜织物",
        "/items/flaming_cloth": "烈焰织物",
        "/items/sorcerers_sole": "魔法师鞋底",
        "/items/chrono_sphere": "时空球",
        "/items/frost_sphere": "冰霜球",
        "/items/panda_fluff": "熊猫绒",
        "/items/black_bear_fluff": "黑熊绒",
        "/items/grizzly_bear_fluff": "棕熊绒",
        "/items/polar_bear_fluff": "北极熊绒",
        "/items/red_panda_fluff": "小熊猫绒",
        "/items/magnet": "磁铁",
        "/items/stalactite_shard": "钟乳石碎片",
        "/items/living_granite": "花岗岩",
        "/items/colossus_core": "巨像核心",
        "/items/vampire_fang": "吸血鬼之牙",
        "/items/werewolf_claw": "狼人之爪",
        "/items/revenant_anima": "亡者之魂",
        "/items/soul_fragment": "灵魂碎片",
        "/items/infernal_ember": "地狱余烬",
        "/items/demonic_core": "恶魔核心",
        "/items/griffin_leather": "狮鹫之皮",
        "/items/manticore_sting": "蝎狮之刺",
        "/items/jackalope_antler": "鹿角兔之角",
        "/items/dodocamel_plume": "渡渡驼之翎",
        "/items/griffin_talon": "狮鹫之爪",
        "/items/chimerical_refinement_shard": "奇幻精炼碎片",
        "/items/acrobats_ribbon": "杂技师彩带",
        "/items/magicians_cloth": "魔术师织物",
        "/items/chaotic_chain": "混沌锁链",
        "/items/cursed_ball": "诅咒之球",
        "/items/sinister_refinement_shard": "阴森精炼碎片",
        "/items/royal_cloth": "皇家织物",
        "/items/knights_ingot": "骑士之锭",
        "/items/bishops_scroll": "主教卷轴",
        "/items/regal_jewel": "君王宝石",
        "/items/sundering_jewel": "裂空宝石",
        "/items/enchanted_refinement_shard": "秘法精炼碎片",
        "/items/marksman_brooch": "神射胸针",
        "/items/corsair_crest": "掠夺者徽章",
        "/items/damaged_anchor": "破损船锚",
        "/items/maelstrom_plating": "怒涛甲片",
        "/items/kraken_leather": "克拉肯皮革",
        "/items/kraken_fang": "克拉肯之牙",
        "/items/pirate_refinement_shard": "海盗精炼碎片",
        "/items/pathbreaker_lodestone": "开路者磁石",
        "/items/pathfinder_lodestone": "探路者磁石",
        "/items/pathseeker_lodestone": "寻路者磁石",
        "/items/labyrinth_refinement_shard": "迷宫精炼碎片",
        "/items/butter_of_proficiency": "精通之油",
        "/items/thread_of_expertise": "专精之线",
        "/items/branch_of_insight": "洞察之枝",
        "/items/gluttonous_energy": "贪食能量",
        "/items/guzzling_energy": "暴饮能量",
        "/items/milking_essence": "挤奶精华",
        "/items/foraging_essence": "采摘精华",
        "/items/woodcutting_essence": "伐木精华",
        "/items/cheesesmithing_essence": "奶酪锻造精华",
        "/items/crafting_essence": "制作精华",
        "/items/tailoring_essence": "缝纫精华",
        "/items/cooking_essence": "烹饪精华",
        "/items/brewing_essence": "冲泡精华",
        "/items/alchemy_essence": "炼金精华",
        "/items/enhancing_essence": "强化精华",
        "/items/swamp_essence": "沼泽精华",
        "/items/aqua_essence": "海洋精华",
        "/items/jungle_essence": "丛林精华",
        "/items/gobo_essence": "哥布林精华",
        "/items/eyessence": "眼精华",
        "/items/sorcerer_essence": "法师精华",
        "/items/bear_essence": "熊熊精华",
        "/items/golem_essence": "魔像精华",
        "/items/twilight_essence": "暮光精华",
        "/items/abyssal_essence": "地狱精华",
        "/items/chimerical_essence": "奇幻精华",
        "/items/sinister_essence": "阴森精华",
        "/items/enchanted_essence": "秘法精华",
        "/items/pirate_essence": "海盗精华",
        "/items/labyrinth_essence": "迷宫精华",
        "/items/task_crystal": "任务水晶",
        "/items/star_fragment": "星光碎片",
        "/items/pearl": "珍珠",
        "/items/amber": "琥珀",
        "/items/garnet": "石榴石",
        "/items/jade": "翡翠",
        "/items/amethyst": "紫水晶",
        "/items/moonstone": "月亮石",
        "/items/sunstone": "太阳石",
        "/items/philosophers_stone": "贤者之石",
        "/items/crushed_pearl": "珍珠碎片",
        "/items/crushed_amber": "琥珀碎片",
        "/items/crushed_garnet": "石榴石碎片",
        "/items/crushed_jade": "翡翠碎片",
        "/items/crushed_amethyst": "紫水晶碎片",
        "/items/crushed_moonstone": "月亮石碎片",
        "/items/crushed_sunstone": "太阳石碎片",
        "/items/crushed_philosophers_stone": "贤者之石碎片",
        "/items/shard_of_protection": "保护碎片",
        "/items/mirror_of_protection": "保护之镜",
        "/items/philosophers_mirror": "贤者之镜",
        "/items/basic_torch": "基础火炬",
        "/items/advanced_torch": "进阶火炬",
        "/items/expert_torch": "专家火炬",
        "/items/basic_shroud": "基础斗篷",
        "/items/advanced_shroud": "进阶斗篷",
        "/items/expert_shroud": "专家斗篷",
        "/items/basic_beacon": "基础信标",
        "/items/advanced_beacon": "进阶信标",
        "/items/expert_beacon": "专家信标",
        "/items/basic_food_crate": "基础食物箱",
        "/items/advanced_food_crate": "进阶食物箱",
        "/items/expert_food_crate": "专家食物箱",
        "/items/basic_tea_crate": "基础茶叶箱",
        "/items/advanced_tea_crate": "进阶茶叶箱",
        "/items/expert_tea_crate": "专家茶叶箱",
        "/items/basic_coffee_crate": "基础咖啡箱",
        "/items/advanced_coffee_crate": "进阶咖啡箱",
        "/items/expert_coffee_crate": "专家咖啡箱"
        };
    // ======================
    // 物品名称映射
    // ======================

    let itemNameToHrid = {};
    let itemHridToName = {};
    let zhNameToHrid = {};

    function buildItemMaps() {
        if (!itemDetailMap) {
            const initData = getInitClientData();
            if (initData?.itemDetailMap) {
                itemDetailMap = initData.itemDetailMap;
            } else {
                logInit('[Better Loot Tracker] No itemDetailMap available for building item maps');
                return;
            }
        }

        // 由 itemDetailMap 构建英文名映射
        for (const [hrid, item] of Object.entries(itemDetailMap)) {
            if (item.name) {
                itemNameToHrid[item.name] = hrid;
                itemHridToName[hrid] = item.name;
            }
        }

        // 由 ZHItemNames 构建中文名映射（反转映射）
        for (const [hrid, zhName] of Object.entries(ZHItemNames)) {
            zhNameToHrid[zhName] = hrid;
        }

        logInit('[Better Loot Tracker] 物品映射构建完成，英文', Object.keys(itemNameToHrid).length, '中文:', Object.keys(zhNameToHrid).length);
    }

    // 根据物品名称获取HRID（支持中英文）
    function getItemHrid(itemName) {
        // 先去掉末尾的强化等级标记（如 "+1" 或 "+5"）
        const cleanName = itemName.replace(/\s*\+\d+$/, '').trim();

        // Chinese loot logs render refined equipment as "Name ★", while the
        // built-in Chinese map uses "Name（精）". Resolve this display alias first.
        const refinedStarMatch = cleanName.match(/^(.*?)\s*★$/);
        if (refinedStarMatch) {
            const refinedName = `${refinedStarMatch[1].trim()}（精）`;
            if (zhNameToHrid[refinedName]) return zhNameToHrid[refinedName];
            for (const [hrid, zhName] of Object.entries(ZHItemNames)) {
                if (zhName === refinedName) {
                    zhNameToHrid[refinedName] = hrid;
                    return hrid;
                }
            }
        }

        // 先尝试英文名
        if (itemNameToHrid[cleanName]) {
            return itemNameToHrid[cleanName];
        }

        // 再尝试中文名
        if (zhNameToHrid[cleanName]) {
            return zhNameToHrid[cleanName];
        }

        // 尝试用 itemDetailMap 动态查找（遍历所有物品）
        if (itemDetailMap) {
            for (const [hrid, item] of Object.entries(itemDetailMap)) {
                // 检查英文名
                if (item.name === cleanName) {
                    itemNameToHrid[cleanName] = hrid;
                    return hrid;
                }
            }
        }

        // 通过 ZHItemNames 查找
        for (const [hrid, zhName] of Object.entries(ZHItemNames)) {
            if (zhName === cleanName) {
                zhNameToHrid[cleanName] = hrid;
                return hrid;
            }
        }

        return null;
    }

    // ======================
    // 强化计算
    // ======================

    const SUCCESS_RATE = [
        50, 45, 45, 40, 40, 40, 35, 35, 35, 35,
        30, 30, 30, 30, 30, 30, 30, 30, 30, 30
    ];
    const ITEM_ENHANCE_LEVEL_TO_BUFF_BONUS_MAP = {
        0: 0, 1: 2, 2: 4.2, 3: 6.6, 4: 9.2, 5: 12, 6: 15, 7: 18.2, 8: 21.6, 9: 25.2, 10: 29,
        11: 33.4, 12: 38.4, 13: 44, 14: 50.2, 15: 57, 16: 64.4, 17: 72.4, 18: 81, 19: 90.2, 20: 100
    };
    const ENHANCE_DEFAULT_PARAMS = {
        enhancing_level: 125,
        laboratory_level: 6,
        enhancer_bonus: 5.42,
        glove_bonus: 12.9,
        tea_enhancing: false,
        tea_super_enhancing: false,
        tea_ultra_enhancing: true,
        tea_blessed: true
    };

    function getBaseItemLevel(itemHRID) {
        if (!itemDetailMap) {
            const initData = getInitClientData();
            if (initData?.itemDetailMap) {
                itemDetailMap = initData.itemDetailMap;
            } else {
                return 0;
            }
        }
        const itemDetails = itemDetailMap[itemHRID];
        return itemDetails?.itemLevel || 0;
    }

    function getEnhancementCosts(itemHRID) {
        if (!itemDetailMap) {
            const initData = getInitClientData();
            if (initData?.itemDetailMap) {
                itemDetailMap = initData.itemDetailMap;
            } else {
                return null;
            }
        }

        const itemData = itemDetailMap[itemHRID];
        if (!itemData?.enhancementCosts) return null;

        return itemData.enhancementCosts;
    }

    function getProtectionItems(itemHRID) {
        if (!itemDetailMap) {
            const initData = getInitClientData();
            if (initData?.itemDetailMap) {
                itemDetailMap = initData.itemDetailMap;
            } else {
                return [itemHRID, "/items/mirror_of_protection"];
            }
        }

        const itemData = itemDetailMap[itemHRID];
        let protectHrids = [itemHRID, "/items/mirror_of_protection"];

        if (itemData?.protectionItemHrids) {
            protectHrids = protectHrids.concat(itemData.protectionItemHrids);
        }

        return protectHrids;
    }

    // ======================
    // 数据获取和管理
    // ======================

    // 存储角色数据
    let characterItems = null;
    let characterBuffs = null;
    let characterSkills = null;
    let characterHouseRoomMap = null;
    let itemDetailMap = null;

    // 存储选择的强化记录（用于合并计算）
    const selectedEnhancements = new Map();

    // Completed-record snapshots are intentionally immutable: live market prices
    // remain useful for the next record, but must never rewrite old comparisons.
    const ENHANCEMENT_HISTORY_KEY = 'MWI_Integrated_EnhancementHistory_v2';
    const ENHANCEMENT_HISTORY_LIMIT = 500;
    const TRACKER_SELL_TAX_FACTOR = 0.98;

    function getEnhancementHistory() {
        try {
            const history = JSON.parse(localStorage.getItem(ENHANCEMENT_HISTORY_KEY) || '[]');
            return Array.isArray(history) ? history : [];
        } catch {
            return [];
        }
    }

    function saveEnhancementHistory(history) {
        localStorage.setItem(ENHANCEMENT_HISTORY_KEY, JSON.stringify(history.slice(-ENHANCEMENT_HISTORY_LIMIT)));
    }

    function removeLegacyUnconfirmedSnapshots() {
        const history = getEnhancementHistory();
        // Keep the raw old snapshots: a user may need them to compare with an
        // external notification.  The ledger readers independently exclude
        // rows without a server-confirmed final level, so they cannot be
        // merged, valued, or matched to a sale by mistake.
        return { removed: 0, kept: history.length };
    }

    function getEnhancementSnapshotKey(parsedData) {
        const path = (parsedData.progression || [])
            .map(({ level, count }) => `${level}:${count}`)
            .join(',');
        return [parsedData.completedAt || 'time-unknown', parsedData.itemHrid, parsedData.startLevel, parsedData.enhanceCount, parsedData.duration, path].join('|');
    }

    function enhancementLedgerState(parsedData) {
        const key = getEnhancementSnapshotKey(parsedData);
        const history = getEnhancementHistory();
        const entry = history.find((row) => row?.key === key) || null;
        if (entry) return { state: 'recorded', entry };
        if (parsedData?.serverCompletion) return { state: 'unrecorded', entry: null };
        const actionLogEnded = Boolean(parsedData?.startedAt
            && window.__MWI_COMPLETED_ENHANCE_LOG_TIMES__?.has(parsedData.startedAt.slice(0, 19)));
        return { state: actionLogEnded ? 'awaiting_final_level' : 'pending', entry: null };
    }

    function removeInProgressEnhancementSnapshots(parsedData) {
        const startedAt = new Date(parsedData?.startedAt || '').getTime();
        if (!parsedData?.itemHrid || !Number.isFinite(startedAt)) return 0;
        const history = getEnhancementHistory();
        const kept = history.filter((entry) => {
            if (entry?.itemHrid !== parsedData.itemHrid) return true;
            const entryStartedAt = new Date(entry.startedAt || '').getTime()
                || (new Date(entry.completedAt || entry.archivedAt || '').getTime() - Number(entry.duration || 0) * 1000);
            // A pending log can be re-rendered once per action. All snapshots
            // with its same start time are interim progress artifacts, not
            // completed enhancement batches.
            return !Number.isFinite(entryStartedAt) || Math.abs(entryStartedAt - startedAt) > 2000;
        });
        if (kept.length !== history.length) saveEnhancementHistory(kept);
        return history.length - kept.length;
    }

    function isPotentiallyRunningLootEntry(lootElement) {
        const container = getLootLogContainer();
        if (!container) return false;
        const entries = container.querySelectorAll(LOOT_LOG_ITEM_SELECTOR);
        // Only the newest record overall can still be running. This function is
        // called only after an entry has already been identified as enhancement.
        return entries[0] === lootElement;
    }

    function getLiveEnhancedBidPrice(itemHrid, enhancementLevel, marketData) {
        const rankingBid = window.__MWI_PRIVATE_GET_MARKET_BID__?.(itemHrid, enhancementLevel);
        if (Number.isFinite(rankingBid) && rankingBid > 0) return rankingBid;

        const marketBid = marketData?.marketData?.[itemHrid]?.[String(enhancementLevel)]?.b;
        return Number.isFinite(marketBid) && marketBid > 0 ? marketBid : null;
    }

    function getLiveEnhancedAskPrice(itemHrid, enhancementLevel, marketData) {
        const rankingAsk = window.__MWI_PRIVATE_GET_MARKET_ASK__?.(itemHrid, enhancementLevel);
        if (Number.isFinite(rankingAsk) && rankingAsk > 0) return rankingAsk;

        const marketAsk = marketData?.marketData?.[itemHrid]?.[String(enhancementLevel)]?.a;
        return Number.isFinite(marketAsk) && marketAsk > 0 ? marketAsk : null;
    }

    function buildEnhancementSnapshot(parsedData, costs, targetLevel, protectAt, marketData) {
        const finalLevel = Number.isInteger(parsedData.finalLevel) && parsedData.finalLevel >= 0 ? parsedData.finalLevel : null;
        const observedLevels = Object.keys(parsedData.drops || {}).map(Number).filter(Number.isInteger);
        const observedMaxLevel = observedLevels.length ? Math.max(...observedLevels) : null;

        const bidPrice = finalLevel === null ? null : getLiveEnhancedBidPrice(parsedData.itemHrid, finalLevel, marketData);
        const startingItemCost = getLiveEnhancedAskPrice(parsedData.itemHrid, parsedData.startLevel, marketData);
        // 强化事实不能因为某一侧市场报价暂缺而丢失；缺价只影响估值完整度。
        const revenue = bidPrice === null ? null : bidPrice * TRACKER_SELL_TAX_FACTOR;
        const netCashFlow = revenue === null || startingItemCost === null ? null : revenue - startingItemCost - costs.total;
        const sideMaterialCost = (side) => {
            const materials = getEnhancementCosts(parsedData.itemHrid);
            if (!Array.isArray(materials)) return null;
            let perAction = 0;
            for (const material of materials) {
                const price = getMarketPriceSide(material.itemHrid, marketData, side);
                if (price === null) return null;
                perAction += price * material.count;
            }
            return perAction * parsedData.enhanceCount;
        };
        const sideProtectionCost = (side) => {
            if (!costs.protectionCount) return 0;
            const prices = getProtectionItems(parsedData.itemHrid)
                .map((hrid) => getMarketPriceSide(hrid, marketData, side))
                .filter((price) => Number.isFinite(price) && price > 0);
            return prices.length ? Math.min(...prices) * costs.protectionCount : null;
        };
        const startingItemAsk = getLiveEnhancedAskPrice(parsedData.itemHrid, parsedData.startLevel, marketData);
        const startingItemBid = getLiveEnhancedBidPrice(parsedData.itemHrid, parsedData.startLevel, marketData);
        const outputAskPrice = finalLevel === null ? null : getLiveEnhancedAskPrice(parsedData.itemHrid, finalLevel, marketData);
        const outputBidPrice = finalLevel === null ? null : getLiveEnhancedBidPrice(parsedData.itemHrid, finalLevel, marketData);
        const materialAskCost = sideMaterialCost('ask');
        const materialBidCost = sideMaterialCost('bid');
        const protectionAskCost = sideProtectionCost('ask');
        const protectionBidCost = sideProtectionCost('bid');
        return {
            characterId: String(window.__MWI_PROFIT_CURRENT_CHARACTER_ID__ || 'unknown'),
            startedAt: parsedData.startedAt || null,
            completedAt: parsedData.completedAt || new Date().toISOString(),
            key: getEnhancementSnapshotKey(parsedData),
            archivedAt: new Date().toISOString(),
            itemHrid: parsedData.itemHrid,
            itemName: parsedData.itemName,
            startLevel: parsedData.startLevel,
            finalLevel,
            observedMaxLevel,
            finalLevelSource: parsedData.finalLevelSource || (parsedData.serverCompletion ? 'server' : 'unknown'),
            enhanceCount: parsedData.enhanceCount,
            duration: parsedData.duration,
            targetLevel,
            protectAt,
            materialCost: costs.material,
            protectionCost: costs.protection,
            totalCost: costs.total,
            protectionCount: costs.protectionCount,
            startingItemCost,
            startingItemAsk,
            startingItemBid,
            materialAskCost,
            materialBidCost,
            protectionAskCost,
            protectionBidCost,
            outputAskPrice,
            outputBidPrice,
            bidPrice,
            revenue,
            netCashFlow
        };
    }

    function getOrArchiveEnhancementSnapshot(parsedData, costs, targetLevel, protectAt, marketData, allowArchive = true) {
        const key = getEnhancementSnapshotKey(parsedData);
        const history = getEnhancementHistory();
        const existingIndex = history.findIndex((entry) => entry.key === key || (entry.completedAt && parsedData.completedAt && entry.completedAt === parsedData.completedAt && entry.itemHrid === parsedData.itemHrid && Number(entry.enhanceCount) === Number(parsedData.enhanceCount) && Number(entry.duration) === Number(parsedData.duration)) || (!entry.completedAt && entry.itemHrid === parsedData.itemHrid && Number(entry.startLevel) === Number(parsedData.startLevel) && Number(entry.finalLevel) === Number(parsedData.finalLevel) && Number(entry.enhanceCount) === Number(parsedData.enhanceCount) && Number(entry.duration) === Number(parsedData.duration)));
        const existing = existingIndex >= 0 ? history[existingIndex] : null;
        const shouldCorrectStart = existing && parsedData.startLevelSource === 'loot_title' && Number(existing.startLevel) !== Number(parsedData.startLevel);
        const shouldUpgradeFinal = existing && (existing.finalLevel === null || existing.finalLevel === undefined) && Number.isInteger(parsedData.finalLevel);
        if (shouldCorrectStart || shouldUpgradeFinal) {
            const upgraded = buildEnhancementSnapshot(parsedData, costs, targetLevel, protectAt, marketData);
            if (upgraded) { history[existingIndex] = { ...existing, ...upgraded, archivedAt: existing.archivedAt || upgraded.archivedAt }; saveEnhancementHistory(history); return history[existingIndex]; }
        }
        if (existing) return existing;
        if (!allowArchive) return { pendingArchive: true };

        const snapshot = buildEnhancementSnapshot(parsedData, costs, targetLevel, protectAt, marketData);
        if (!snapshot) return null;
        history.push(snapshot);
        saveEnhancementHistory(history);
        return snapshot;
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>'"]/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[char]);
    }

    function showEnhancementHistory() {
        document.querySelector('.elt-history-overlay')?.remove();
        document.querySelector('.elt-history-dialog')?.remove();

        const history = getEnhancementHistory().slice().reverse();
        const overlay = document.createElement('div');
        overlay.className = 'elt-history-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998;';

        const dialog = document.createElement('div');
        dialog.className = 'elt-history-dialog';
        dialog.style.cssText = 'position:fixed;z-index:9999;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1000px,94vw);max-height:80vh;overflow:auto;background:#20232d;color:#e8e8e8;border:1px solid #666;border-radius:8px;padding:14px;font-size:12px;';
        const rows = history.map((entry) => `
            <tr><td>${new Date(entry.archivedAt).toLocaleString()}</td><td>${escapeHtml(entry.itemName)} +${entry.startLevel} → +${entry.finalLevel}</td><td>${formatNumber(entry.startingItemCost)}</td><td>${formatNumber(entry.totalCost)}</td><td>${formatNumber(entry.bidPrice)}</td><td>${formatNumber(entry.revenue)}</td><td style="color:${entry.netCashFlow >= 0 ? '#8fef8f' : '#ff9999'}">${formatNumber(entry.netCashFlow)}</td></tr>`
        ).join('') || '<tr><td colspan="7" style="text-align:center;color:#aaa">暂无已完成估价的强化记录</td></tr>';
        dialog.innerHTML = `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:10px"><strong>强化收益历史快照</strong><span><button class="elt-history-clear">清空</button> <button class="elt-history-close">关闭</button></span></div><div style="overflow:auto"><table style="width:100%;border-collapse:collapse;white-space:nowrap"><thead><tr><th>存档时间</th><th>物品</th><th>起始装备成本</th><th>耗材估值</th><th>最终收购价</th><th>税后收入</th><th>预计净收益</th></tr></thead><tbody>${rows}</tbody></table></div>`;
        dialog.querySelectorAll('th,td').forEach((cell) => { cell.style.cssText = 'padding:6px;border-bottom:1px solid #444;text-align:right;'; });
        dialog.querySelector('.elt-history-close').addEventListener('click', () => { overlay.remove(); dialog.remove(); });
        dialog.querySelector('.elt-history-clear').addEventListener('click', () => {
            if (confirm('清空全部强化历史快照？')) {
                localStorage.removeItem(ENHANCEMENT_HISTORY_KEY);
                overlay.remove();
                dialog.remove();
            }
        });
        overlay.addEventListener('click', () => { overlay.remove(); dialog.remove(); });
        document.body.append(overlay, dialog);
    }

    // 合并计算选择的强化记录
    function calculateMergedEnhancements() {
        const marketData = getMarketData();
        if (!marketData) {
            alert(t.noMarketData);
            return;
        }

        const selectedItems = [];
        selectedEnhancements.forEach((data, element) => {
            selectedItems.push(data);
        });

        if (selectedItems.length === 0) {
            alert('请先选择要合并计算的强化记录');
            return;
        }

        // 验证所有选择的记录是否是同一物品
        const firstItemData = selectedItems[0].parsedData;
        const firstItemName = firstItemData.itemName;

        for (const item of selectedItems) {
            // 由于我们已经在parseEnhancementLoot中统一了物品名称格式（去除了强化等级后缀）
            // 所以现在可以直接比较itemName
            if (item.parsedData.itemHrid !== firstItemData.itemHrid) {
                alert('只能合并计算同一物品的强化记录');
                return;
            }
        }

        const firstItemHrid = firstItemData.itemHrid;

        // 合并等级数量
        const mergedDrops = {};
        let totalEnhanceCount = 0;
        let maxStartLevel = 0;
        let totalDuration = 0;

        for (const item of selectedItems) {
            const { drops, enhanceCount, startLevel, duration } = item.parsedData;
            totalEnhanceCount += enhanceCount;
            maxStartLevel = Math.max(maxStartLevel, startLevel);
            totalDuration += duration || 0;

            for (const [level, count] of Object.entries(drops)) {
                mergedDrops[level] = (mergedDrops[level] || 0) + count;
            }
        }

        // 创建合并后的解析数据
        const mergedParsedData = {
            itemName: firstItemName,
            itemHrid: firstItemHrid,
            enhanceCount: totalEnhanceCount,
            startLevel: maxStartLevel,
            duration: totalDuration,
            drops: mergedDrops
        };

        // 分析合并结果
        const mergedAnalysis = analyzeEnhancementResult(mergedParsedData);

        // 应用偏好等级判定（复用一般场景的逻辑）
        const preferenceLevels = getGlobalPreferenceLevels();
        const preferredAnalysis = applyPreferredTarget(mergedAnalysis, preferenceLevels);

        // 使用偏好等级判定后的目标等级和成功状态
        let targetLevel = preferredAnalysis.targetLevel;
        let success = preferredAnalysis.success;

        // 重新判断成功状态：合并后的掉落中有目标等级的物品
        // 只要合并统计后有目标等级的掉落，就认为整体成功
        if (targetLevel > maxStartLevel && mergedDrops[targetLevel] && mergedDrops[targetLevel] > 0) {
            success = true;
        }
        const bestStrategy = findBestProtectLevel(firstItemHrid, targetLevel, marketData);
        if (!bestStrategy) {
            alert('无法计算最佳强化策略');
            return;
        }

        const protectAt = bestStrategy.protectAt;
        const sim = Enhancelate(firstItemHrid, targetLevel, protectAt);
        const baseItemPrice = getMarketPrice(firstItemHrid, marketData);
        const originalCost = baseItemPrice + getExpectedTotalCostToLevel(firstItemHrid, maxStartLevel, marketData);

        const expectedMaterialCost = bestStrategy.perActionCost * sim.actions;
        const expectedProtectCost = bestStrategy.minProtectCost * sim.protectCount;
        const expectedTotalCost = expectedMaterialCost + expectedProtectCost + originalCost;

        const actualMaterialCost = bestStrategy.perActionCost * totalEnhanceCount;
        const actualProtectTargetLevel = targetLevel;
        const actualProtectSuccess = success;
        const actualProtectCount = calculateActualProtections(mergedDrops, protectAt, actualProtectTargetLevel, actualProtectSuccess);
        const actualProtectCost = bestStrategy.minProtectCost * actualProtectCount;
        const actualTotalCost = actualMaterialCost + actualProtectCost + originalCost;

        const diff = actualTotalCost - expectedTotalCost;
        const diffText = diff >= 0 ? `${t.aboveExpected}: ${formatNumber(diff)}` : `${t.belowExpected}: ${formatNumber(Math.abs(diff))}`;
        const diffColor = diff >= 0 ? 'rgb(255, 100, 100)' : 'rgb(100, 255, 100)';

        // 计算最终价值
        let finalValue = baseItemPrice; // 默认值为基础物品价格

        if (success && targetLevel > 0) {
            // 尝试从市场数据中获取对应等级的ask价格
            if (marketData?.marketData && marketData.marketData[firstItemHrid]) {
                const marketRoot = marketData.marketData[firstItemHrid];
                const levelKey = targetLevel.toString();

                // 优先使用对应等级的ask价格
                if (marketRoot[levelKey] && marketRoot[levelKey].a) {
                    finalValue = marketRoot[levelKey].a;
                } else {
                    // 计算理论成本
                    const theoreticalCost = baseItemPrice + getExpectedTotalCostToLevel(firstItemHrid, targetLevel, marketData);

                    // 获取对应等级或基础等级的bid价格
                    let bidPrice = baseItemPrice;
                    if (marketRoot[levelKey] && marketRoot[levelKey].b) {
                        bidPrice = marketRoot[levelKey].b;
                    } else if (marketRoot["0"] && marketRoot["0"].b) {
                        bidPrice = marketRoot["0"].b;
                    }

                    // 理论成本与bid价格取较高者
                    finalValue = Math.max(theoreticalCost, bidPrice);
                }
            } else {
                // 如果市场数据不可用，使用原来的计算方式
                finalValue = baseItemPrice + getExpectedTotalCostToLevel(firstItemHrid, targetLevel, marketData);
            }
        }

        // 确保finalValue不为负数或-1，如果为0或负数，使用预期成本
        if (finalValue <= 0) {
            finalValue = baseItemPrice + getExpectedTotalCostToLevel(firstItemHrid, targetLevel, marketData);
        }
        // 计算收益时考虑98%的交易手续费
        const profit = (finalValue * 0.98) - actualTotalCost;
        const profitColor = profit >= 0 ? 'rgb(100, 255, 100)' : 'rgb(255, 100, 100)';

        // 计算预期收益
        const expectedProfit = (finalValue * 0.98) - expectedTotalCost;

        // 计算预期持续时间
        const expectedDuration = totalEnhanceCount > 0 ? (sim.actions / totalEnhanceCount) * totalDuration : 0;

        // 计算预期工时费（每小时收益）
        const expectedHourlyWage = expectedDuration > 0 ? expectedProfit / (expectedDuration / 3600) : 0;

        // 显示弹出框
        showMergeResultPopup({
            itemName: firstItemName,
            itemHrid: firstItemHrid,
            totalEnhanceCount,
            maxStartLevel,
            duration: totalDuration,
            mergedDrops,
            targetLevel,
            success,
            actualMaterialCost,
            actualProtectCost,
            actualProtectCount,
            actualTotalCost,
            expectedMaterialCost,
            expectedProtectCost,
            expectedProtectCount: sim.protectCount,
            expectedTotalCost,
            diffText,
            diffColor,
            originalCost,
            finalValue,
            profit,
            profitColor,
            expectedProfit,
            expectedDuration,
            expectedHourlyWage
        });
    }

    // 显示合并结果弹出框
    function showMergeResultPopup(initialData) {
        // 使用闭包保存当前配置
        let currentTargetLevel = initialData.targetLevel;
        let currentSuccess = initialData.success;
        let currentProtectAt = null; // null表示使用自动最优

        const marketData = getMarketData();
        if (!marketData) {
            alert(t.noMarketData);
            return;
        }

        // 创建更新函数
        const updateDisplay = () => {
            const data = recalculateMergeData(initialData, currentTargetLevel, currentSuccess, currentProtectAt, marketData);
            renderMergePopup(data, currentTargetLevel, currentSuccess, currentProtectAt);
        };

        // 初始渲染
        updateDisplay();

        function recalculateMergeData(baseData, targetLevel, success, protectAt, marketData) {
            const { itemHrid, totalEnhanceCount, maxStartLevel, mergedDrops } = baseData;

            const bestStrategy = findBestProtectLevel(itemHrid, targetLevel, marketData);
            if (!bestStrategy) return baseData;

            const actualProtectAt = protectAt !== null ? Math.min(protectAt, targetLevel) : bestStrategy.protectAt;
            const sim = Enhancelate(itemHrid, targetLevel, actualProtectAt);
            const baseItemPrice = getMarketPrice(itemHrid, marketData);
            const originalCost = baseItemPrice + getExpectedTotalCostToLevel(itemHrid, maxStartLevel, marketData);

            const expectedMaterialCost = bestStrategy.perActionCost * sim.actions;
            const expectedProtectCost = bestStrategy.minProtectCost * sim.protectCount;
            const expectedTotalCost = expectedMaterialCost + expectedProtectCost + originalCost;

            const actualMaterialCost = bestStrategy.perActionCost * totalEnhanceCount;
            const actualProtectCount = calculateActualProtections(mergedDrops, actualProtectAt, targetLevel, success);
            const actualProtectCost = bestStrategy.minProtectCost * actualProtectCount;
            const actualTotalCost = actualMaterialCost + actualProtectCost + originalCost;

            const diff = actualTotalCost - expectedTotalCost;
            const diffText = diff >= 0 ? `${t.aboveExpected}: ${formatNumber(diff)}` : `${t.belowExpected}: ${formatNumber(Math.abs(diff))}`;
            const diffColor = diff >= 0 ? 'rgb(255, 100, 100)' : 'rgb(100, 255, 100)';

            let finalValue = baseItemPrice;
            if (success && targetLevel > 0) {
                if (marketData?.marketData && marketData.marketData[itemHrid]) {
                    const marketRoot = marketData.marketData[itemHrid];
                    const levelKey = targetLevel.toString();

                    if (marketRoot[levelKey] && marketRoot[levelKey].a) {
                        finalValue = marketRoot[levelKey].a;
                    } else {
                        const theoreticalCost = baseItemPrice + getExpectedTotalCostToLevel(itemHrid, targetLevel, marketData);
                        let bidPrice = baseItemPrice;
                        if (marketRoot[levelKey] && marketRoot[levelKey].b) {
                            bidPrice = marketRoot[levelKey].b;
                        } else if (marketRoot["0"] && marketRoot["0"].b) {
                            bidPrice = marketRoot["0"].b;
                        }
                        finalValue = Math.max(theoreticalCost, bidPrice);
                    }
                } else {
                    finalValue = baseItemPrice + getExpectedTotalCostToLevel(itemHrid, targetLevel, marketData);
                }
            }

            if (finalValue <= 0) {
                finalValue = baseItemPrice + getExpectedTotalCostToLevel(itemHrid, targetLevel, marketData);
            }

            const profit = (finalValue * 0.98) - actualTotalCost;
            const profitColor = profit >= 0 ? 'rgb(100, 255, 100)' : 'rgb(255, 100, 100)';
            const expectedProfit = (finalValue * 0.98) - expectedTotalCost;
            const expectedDuration = totalEnhanceCount > 0 ? (sim.actions / totalEnhanceCount) * baseData.duration : 0;
            const expectedHourlyWage = expectedDuration > 0 ? expectedProfit / (expectedDuration / 3600) : 0;

            return {
                ...baseData,
                targetLevel,
                success,
                actualMaterialCost,
                actualProtectCost,
                actualProtectCount,
                actualTotalCost,
                expectedMaterialCost,
                expectedProtectCost,
                expectedProtectCount: sim.protectCount,
                expectedTotalCost,
                diffText,
                diffColor,
                originalCost,
                finalValue,
                profit,
                profitColor,
                expectedProfit,
                expectedDuration,
                expectedHourlyWage,
                bestStrategy,
                actualProtectAt
            };
        }

        function renderMergePopup(data, targetLevel, success, protectAt) {
            const {
                itemName,
                actualMaterialCost, actualProtectCost, actualProtectCount, actualTotalCost,
                expectedMaterialCost, expectedProtectCost, expectedProtectCount, expectedTotalCost,
                diffText, diffColor, originalCost, finalValue, profit, profitColor,
                expectedProfit, expectedDuration, expectedHourlyWage, bestStrategy, actualProtectAt
            } = data;

            // 使用实际持续时间并格式化为标准格式
            const durationSeconds = data.duration || 0;
            const hours = Math.floor(durationSeconds / 3600);
            const minutes = Math.floor((durationSeconds % 3600) / 60);
            const seconds = durationSeconds % 60;

            // 构建持续时间字符串：4h 28m 55s
            let durationText = '';
            if (hours > 0) {
                durationText += `${hours}h `;
            }
            if (minutes > 0 || hours > 0) {
                durationText += `${minutes}m `;
            }
            durationText += `${seconds}s`;
            durationText = durationText.trim();

            // 计算记录数量
            const recordCount = selectedEnhancements.size;

            // 移除旧的弹出框（如果存在）
            const oldPopup = document.querySelector('.merge-result-popup');
            const oldOverlay = document.querySelector('.merge-result-overlay');
            if (oldPopup) oldPopup.remove();
            if (oldOverlay) oldOverlay.remove();

            // 创建弹出框
            const popup = document.createElement('div');
            popup.className = 'merge-result-popup';
            popup.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(0, 0, 0, 0.9);
                border: 1px solid #555;
                border-radius: 10px;
                padding: 20px;
                width: 80%;
                max-width: 600px;
                max-height: 80vh;
                overflow-y: auto;
                z-index: 10000;
                color: #e0e0e0;
            `;

            // 生成目标等级选项
            let targetOptions = '';
            for (let i = 1; i <= 20; i++) {
                const selected = i === targetLevel ? 'selected' : '';
                targetOptions += `<option value="${i}" ${selected}>+${i}</option>`;
            }

            // 生成保护等级选项
            const autoProtectLabel = isZH ? `自动(+${bestStrategy.protectAt})` : `Auto(+${bestStrategy.protectAt})`;
            let protectOptions = `<option value="auto">${autoProtectLabel}</option>`;
            for (let i = 2; i <= targetLevel; i++) {
                const selected = (protectAt !== null && i === actualProtectAt) ? 'selected' : '';
                protectOptions += `<option value="${i}" ${selected}>+${i}</option>`;
            }
            if (protectAt === null) {
                protectOptions = protectOptions.replace('value="auto"', 'value="auto" selected');
            }

            // 生成等级分布HTML（参考原行动记录的形式）
        let dropsHtml = '<div style="margin-top: 15px; margin-bottom: 15px;"><strong>等级分布:</strong></div>';
        dropsHtml += '<div style="display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; padding: 10px; background: rgba(30,30,30,0.8); border-radius: 6px;">';

        // 添加等级分布项（参考原行动记录的Item_itemContainer__x7kH1结构）
        const sortedLevels = Object.keys(data.mergedDrops).map(Number).sort((a, b) => a - b);
        for (const level of sortedLevels) {
            const count = data.mergedDrops[level];

            // 获取物品图标（使用第一个选择的记录的第二个图标，避免干扰）
            let itemIconHtml = '';
            selectedEnhancements.forEach((itemData, element) => {
                const itemContainers = element.querySelectorAll('.Item_itemContainer__x7kH1');
                if (itemContainers.length >= 2 && !itemIconHtml) {
                    // 使用第二个物品容器（索引为1）
                    const secondItemContainer = itemContainers[1];
                    const itemElement = secondItemContainer.querySelector('.Item_item__2De2O');
                    if (itemElement) {
                        // 克隆整个物品元素的HTML结构
                        const clonedElement = itemElement.cloneNode(true);
                        // 更新数量
                        const countDiv = clonedElement.querySelector('.Item_count__1HVvv');
                        if (countDiv) {
                            countDiv.textContent = count;
                        }
                        // 添加或更新强化等级
                        if (level > 0) {
                            let levelDiv = clonedElement.querySelector('.Item_enhancementLevel__19g-e');
                            if (!levelDiv) {
                                levelDiv = document.createElement('div');
                                levelDiv.className = `Item_enhancementLevel__19g-e enhancementProcessed enhancementLevel_${level}`;
                                clonedElement.appendChild(levelDiv);
                            }
                            levelDiv.textContent = `+${level}`;
                        } else {
                            // 移除强化等级（如果有）
                            const levelDiv = clonedElement.querySelector('.Item_enhancementLevel__19g-e');
                            if (levelDiv) {
                                levelDiv.remove();
                            }
                        }
                        itemIconHtml = clonedElement.outerHTML;
                    }
                }
            });

            if (itemIconHtml) {
                dropsHtml += `<div class="Item_itemContainer__x7kH1" style="margin: 0;">${itemIconHtml}</div>`;
            } else {
                // 备用方案
                dropsHtml += `<div style="display: flex; flex-direction: column; align-items: center; min-width: 60px;">
                    <div style="width: 40px; height: 40px; background: rgba(50,50,50,0.8); border-radius: 4px; display: flex; align-items: center; justify-content: center; margin-bottom: 4px;">
                        📦
                        ${level > 0 ? `<div style="position: absolute; bottom: 0; right: 0; background: rgba(0,0,0,0.7); border-radius: 50%; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #fff;">+${level}</div>` : ''}
                    </div>
                    <div style="font-size: 12px; text-align: center;">${count}</div>
                </div>`;
            }
        }
            dropsHtml += '</div>';

            // 生成HTML内容
            popup.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <h3 style="margin: 0; color: #fff; font-size: 17px;">合并${recordCount}行记录 强化 - ${itemName}</h3>
                    <button class="merge-popup-close" style="
                        background: rgba(255,100,100,0.5);
                        border: 1px solid #666;
                        border-radius: 4px;
                        color: #fff;
                        cursor: pointer;
                        padding: 4px 8px;
                        font-size: 12px;
                    ">关闭</button>
                </div>

                <!-- 配置控制区域 -->
                <div style="margin-bottom: 12px; padding: 8px; background: rgba(30,30,30,0.8); border-radius: 6px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
                    <label style="display: flex; align-items: center; gap: 4px;">
                        ${t.target}:
                        <select class="merge-target-select" style="background: rgba(50,50,50,0.8); color: #e0e0e0; border: 1px solid #555; border-radius: 4px; padding: 2px 4px; font-size: 11px;">
                            ${targetOptions}
                        </select>
                    </label>
                    <label style="display: flex; align-items: center; gap: 4px;">
                        ${t.protectLevel}:
                        <select class="merge-protect-select" style="background: rgba(50,50,50,0.8); color: #e0e0e0; border: 1px solid #555; border-radius: 4px; padding: 2px 4px; font-size: 11px;">
                            ${protectOptions}
                        </select>
                    </label>
                    <label style="display: flex; align-items: center; gap: 4px;">
                        <input type="checkbox" class="merge-success-checkbox" ${success ? 'checked' : ''} style="margin: 0;">
                        <span>${t.treatAsSuccess}</span>
                    </label>
                </div>

                <div style="font-size: 13px;">
                    <div style="margin-bottom: 8px;">
                        <span style="color: ${success ? 'rgb(100,255,100)' : 'rgb(255,100,100)' };">
                            [${success ? t.success : t.failure}] 起始等级: +${data.maxStartLevel}   ---->  目标等级: +${targetLevel}
                        </span>
                    </div>
                    <div style="margin-bottom: 8px; display: flex; justify-content: space-between;">
                        <div><strong>总强化次数:</strong> ${data.totalEnhanceCount}</div>
                        <div><strong>总持续时间:</strong> ${durationText}</div>
                    </div>
                    ${dropsHtml}
                    <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #555;">
                        <strong>收益成本分析:</strong>
                        <table style="width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px;">
                            <tr>
                                <th style="text-align: left; padding: 4px; border-bottom: 1px solid #555; color: #ccc; font-size: 12px;">项目</th>
                                <th style="text-align: right; padding: 4px; border-bottom: 1px solid #555; color: #ccc; font-size: 12px;">实际</th>
                                <th style="text-align: right; padding: 4px; border-bottom: 1px solid #555; color: #ccc; font-size: 12px;">预期</th>
                            </tr>
                            <tr>
                                <td style="padding: 4px; color: #e0e0e0;">装备成本</td>
                                <td style="text-align: right; padding: 4px; color: #e0e0e0;">${formatNumber(originalCost)}</td>
                                <td style="text-align: right; padding: 4px; color: #e0e0e0;">-</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px; color: #e0e0e0;">材料成本</td>
                                <td style="text-align: right; padding: 4px; color: #e0e0e0;">${formatNumber(actualMaterialCost)}</td>
                                <td style="text-align: right; padding: 4px; color: #e0e0e0;">${formatNumber(expectedMaterialCost)}</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px; color: #e0e0e0;">保护成本</td>
                                <td style="text-align: right; padding: 4px; color: #e0e0e0;">${formatNumber(actualProtectCost)} / ${actualProtectCount || 0}个</td>
                                <td style="text-align: right; padding: 4px; color: #e0e0e0;">${formatNumber(expectedProtectCost)} / ${(expectedProtectCount || 0).toFixed(2)}个</td>
                            </tr>
                            <tr style="font-weight: bold;">
                                <td style="padding: 4px; color: #e0e0e0;">成本合计</td>
                                <td style="text-align: right; padding: 4px; color: #e0e0e0;">${formatNumber(originalCost + actualMaterialCost + actualProtectCost)}</td>
                                <td style="text-align: right; padding: 4px; color: #e0e0e0;">${formatNumber(expectedMaterialCost + expectedProtectCost + originalCost)}</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px; color: ${diffColor}; font-weight: bold;">${diffText.includes(t.aboveExpected) ? t.aboveExpected : t.belowExpected}</td>
                                <td style="text-align: right; padding: 4px; color: ${diffColor}; font-weight: bold;">${diffText.replace(t.aboveExpected + ': ', '').replace(t.belowExpected + ': ', '')}</td>
                                <td style="text-align: right; padding: 4px; color: #e0e0e0;">-</td>
                            </tr>
                            <tr style="border-top: 1px solid #555;">
                                <td style="padding: 4px; color: #e0e0e0;">最终价值</td>
                                <td style="text-align: right; padding: 4px; color: #e0e0e0;">${formatNumber(finalValue)} (税后: ${formatNumber(finalValue * 0.98)})</td>
                                <td style="text-align: right; padding: 4px; color: #e0e0e0;">-</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px; color: #e0e0e0;">收益</td>
                                <td style="text-align: right; padding: 4px; color: ${profitColor}; font-weight: bold;">${formatNumber(profit)}</td>
                                <td style="text-align: right; padding: 4px; color: #e0e0e0;">${formatNumber(expectedProfit)}</td>
                            </tr>
                            ${(() => {
                                const durationSeconds = data.duration || 0;
                                const hours = durationSeconds / 3600;
                                let hourlyWage = 0;
                                if (hours > 0) {
                                    hourlyWage = profit / hours;
                                }
                                return `<tr>
                                    <td style="padding: 4px; color: #e0e0e0;">工时费/h</td>
                                    <td style="text-align: right; padding: 4px; color: #e0e0e0;">${formatNumber(hourlyWage)}</td>
                                    <td style="text-align: right; padding: 4px; color: #e0e0e0;">${formatNumber(expectedHourlyWage)}</td>
                                </tr>`;
                            })()}
                        </table>
                    </div>
                </div>
            `;

            // 添加点击外部关闭功能
            const overlay = document.createElement('div');
            overlay.className = 'merge-result-overlay';
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                z-index: 9999;
            `;
            overlay.onclick = () => {
                popup.remove();
                overlay.remove();
            };
            document.body.appendChild(overlay);

            // 添加到页面
            document.body.appendChild(popup);

            // 添加关闭按钮事件监听器
            const closeButtons = popup.querySelectorAll('.merge-popup-close');
            closeButtons.forEach(button => {
                button.addEventListener('click', () => {
                    popup.remove();
                    overlay.remove();
                });
            });

            // 添加控件事件监听器
            const targetSelect = popup.querySelector('.merge-target-select');
            const protectSelect = popup.querySelector('.merge-protect-select');
            const successCheckbox = popup.querySelector('.merge-success-checkbox');

            targetSelect.addEventListener('change', () => {
                currentTargetLevel = parseInt(targetSelect.value);
                updateDisplay();
            });

            protectSelect.addEventListener('change', () => {
                const value = protectSelect.value;
                currentProtectAt = value === 'auto' ? null : parseInt(value);
                updateDisplay();
            });

            successCheckbox.addEventListener('change', () => {
                currentSuccess = successCheckbox.checked;
                updateDisplay();
            });
        }
    }

    // Hook WebSocket消息获取数据
    function hookWebSocket() {
        logInit('[Better Loot Tracker] Starting WebSocket hook installation...');

        // MessageEvent.prototype is shared by the page and every userscript.  Do not
        // stack identical getter wrappers when the script is re-evaluated.
        if (window.__BETTER_LOOT_TRACKER_WS_HOOKED__) return;
        window.__BETTER_LOOT_TRACKER_WS_HOOKED__ = true;

        try {
            const dataProperty = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
            if (!dataProperty) {
                console.error('[Better Loot Tracker] Failed to get MessageEvent.prototype.data property');
                return;
            }

            const oriGet = dataProperty.get;
            if (!oriGet) {
                console.error('[Better Loot Tracker] Failed to get original data getter');
                return;
            }

            dataProperty.get = function hookedGet() {
                const socket = this.currentTarget;
                if (!(socket instanceof WebSocket)) {
                    return oriGet.call(this);
                }

                const url = socket.url;
                logCalc('[Better Loot Tracker] WebSocket message from:', url);

                if (url.indexOf("api.milkywayidle.com/ws") <= -1 && url.indexOf("api-test.milkywayidle.com/ws") <= -1) {
                    return oriGet.call(this);
                }

                const message = oriGet.call(this);
                Object.defineProperty(this, "data", { value: message }); // Anti-loop

                try {
                    const obj = JSON.parse(message);
                    window.__MWI_CAPTURE_ENHANCEMENT_MESSAGE__?.(obj);
                    logCalc('[Better Loot Tracker] WebSocket message type:', obj.type);

                    if (obj && obj.type === "init_character_data") {
                        logInit('[Better Loot Tracker] Received init_character_data');
                        characterItems = obj.characterItems;
                        characterBuffs = obj.characterBuffs;
                        characterSkills = obj.characterSkills;
                        characterHouseRoomMap = obj.characterHouseRoomMap;
                        logInit('[Better Loot Tracker] Updated characterItems:', !!characterItems, characterItems?.length);
                        logInit('[Better Loot Tracker] Updated characterBuffs:', !!characterBuffs, characterBuffs?.length);
                        logInit('[Better Loot Tracker] Updated characterSkills:', !!characterSkills, Object.keys(characterSkills || {}).length);
                        logInit('[Better Loot Tracker] Updated characterHouseRoomMap:', !!characterHouseRoomMap, Object.keys(characterHouseRoomMap || {}).length);

                        // 延迟调用调试函数，确保所有数据都已更新
                        setTimeout(() => {
                            debugShowAllData();
                        }, 1000);
                    } else if (obj && obj.type === "init_client_data") {
                        logInit('[Better Loot Tracker] Received init_client_data');
                        itemDetailMap = obj.itemDetailMap;
                        logInit('[Better Loot Tracker] Updated itemDetailMap:', !!itemDetailMap, Object.keys(itemDetailMap || {}).length);
                    }
                } catch (e) {
                    console.error('[Better Loot Tracker] Error parsing WebSocket message:', e);
                }

                return message;
            };

            Object.defineProperty(MessageEvent.prototype, "data", dataProperty);
            logInit('[Better Loot Tracker] WebSocket hook installed successfully');
        } catch (error) {
            console.error('[Better Loot Tracker] Error installing WebSocket hook:', error);
        }
    }

    // 获取暴饮之囊的饮料浓度加成
    function getDrinkConcentrationBonus() {
        logCalc('[Better Loot Tracker] getDrinkConcentrationBonus - characterItems:', !!characterItems);
        if (!characterItems || !itemDetailMap) return 0;


        logCalc('[Better Loot Tracker] characterItems length:', characterItems.length);

        for (const item of characterItems) {
            if (item.itemLocationHrid === "/item_locations/pouch" && item.itemHrid === "/items/guzzling_pouch") {
                logCalc('[Better Loot Tracker] Found guzzling pouch:', item);
                const itemDetail = itemDetailMap[item.itemHrid];
                logCalc('[Better Loot Tracker] Guzzling pouch detail:', itemDetail);

                if (itemDetail?.equipmentDetail?.noncombatStats?.drinkConcentration) {
                    const enhanceBonus = 1 + (ITEM_ENHANCE_LEVEL_TO_BUFF_BONUS_MAP[item.enhancementLevel || 0] || 0) / 100;
                    const result = itemDetail.equipmentDetail.noncombatStats.drinkConcentration * enhanceBonus * 100;
                    logCalc('[Better Loot Tracker] Drink concentration bonus:', result);
                    return result;
                }
            }
        }
        logCalc('[Better Loot Tracker] No guzzling pouch found');
        return 0;
    }

    // 获取强化等级
    function getPlayerEnhanceParams() {
        const res = {
            ...ENHANCE_DEFAULT_PARAMS,
            drink_concentration_bonus: getDrinkConcentrationBonus(),
            enhancers_top_speed: 0,
            enhancers_bottom_speed: 0,
            necklace_speed: 0
        };

        if (characterSkills && Array.isArray(characterSkills)) {
            for (const s of characterSkills) {
                if (s.skillHrid && s.skillHrid.includes("enhancing")) {
                    res.enhancing_level = s.level;
                    break;
                }
            }
        }

        let foundObservatory = false;
        if (characterHouseRoomMap) {
            for (const key in characterHouseRoomMap) {
                const hrid = characterHouseRoomMap[key].houseRoomHrid || "";
                if (hrid.includes("observatory")) {
                    const observatoryLevel = characterHouseRoomMap[key].level;
                    if (observatoryLevel !== undefined && observatoryLevel !== null) {
                        res.laboratory_level = observatoryLevel;
                        foundObservatory = true;
                        break;
                    }
                }
            }
            if (!foundObservatory) {
                for (const key in characterHouseRoomMap) {
                    const hrid = characterHouseRoomMap[key].houseRoomHrid || "";
                    if (hrid.includes("laboratory")) {
                        const laboratoryLevel = characterHouseRoomMap[key].level;
                        if (laboratoryLevel !== undefined && laboratoryLevel !== null) {
                            res.laboratory_level = laboratoryLevel;
                            break;
                        }
                    }
                }
            }
        }

        let foundEnhancer = false;
        if (characterItems && Array.isArray(characterItems)) {
            for (const it of characterItems) {
                if (!it.itemLocationHrid || it.itemLocationHrid === "/item_locations/inventory") continue;
                const hrid = it.itemHrid;
                const detail = itemDetailMap?.[hrid];
                if (!detail) continue;
                const noncombat = detail.equipmentDetail && detail.equipmentDetail.noncombatStats;
                if (noncombat && noncombat.enhancingSuccess && !foundEnhancer) {
                    const ENHANCER_LEVEL_BONUS = [
                        0.0, 2.0, 4.2, 6.6, 9.2, 12.0, 15.0, 18.2, 21.6, 25.2, 29.0,
                        33.4, 38.4, 44.0, 50.2, 57.0, 64.4, 72.4, 81.0, 90.2, 100.0
                    ];
                    const instanceLevel = Math.min(Math.max(Number(it.enhancementLevel ?? 0), 0), 20);
                    const baseFraction = noncombat.enhancingSuccess || 0.0;
                    if (instanceLevel >= 1) {
                        const multiplier = 1 + ENHANCER_LEVEL_BONUS[instanceLevel] / 100.0;
                        const finalFraction = baseFraction * multiplier;
                        res.enhancer_bonus = Number((finalFraction * 100).toFixed(4));
                    } else {
                        res.enhancer_bonus = Number((baseFraction * 100).toFixed(4));
                    }
                    foundEnhancer = true;
                }
                if (hrid && (hrid.includes("glove") || hrid.includes("gloves") || hrid.includes("gauntlets"))) {
                    if (it.enhancementLevel !== undefined && it.enhancementLevel !== null) {
                        const lvl = Number(it.enhancementLevel);
                        if (lvl >= 10) res.glove_bonus = 12.9;
                        else if (lvl >= 5) res.glove_bonus = 11.2;
                        else res.glove_bonus = 10.0;
                    } else {
                        res.glove_bonus = ENHANCE_DEFAULT_PARAMS.glove_bonus;
                    }
                }
                if (hrid === "/items/enhancers_top") {
                    const enhancingSpeed = detail?.equipmentDetail?.noncombatStats?.enhancingSpeed;
                    if (enhancingSpeed) {
                        const enhanceBonus = 1 + (ITEM_ENHANCE_LEVEL_TO_BUFF_BONUS_MAP[it.enhancementLevel || 0] || 0) / 100;
                        res.enhancers_top_speed = enhancingSpeed * enhanceBonus * 100;
                    }
                }
                if (hrid === "/items/enhancers_bottoms") {
                    const enhancingSpeed = detail?.equipmentDetail?.noncombatStats?.enhancingSpeed;
                    if (enhancingSpeed) {
                        const enhanceBonus = 1 + (ITEM_ENHANCE_LEVEL_TO_BUFF_BONUS_MAP[it.enhancementLevel || 0] || 0) / 100;
                        res.enhancers_bottom_speed = enhancingSpeed * enhanceBonus * 100;
                    }
                }
                if (hrid === "/items/necklace_of_speed" || hrid === "/items/philosophers_necklace") {
                    const enhancingSpeed = detail?.equipmentDetail?.noncombatStats?.enhancingSpeed;
                    if (enhancingSpeed) {
                        const enhanceBonus = 1 + (ITEM_ENHANCE_LEVEL_TO_BUFF_BONUS_MAP[it.enhancementLevel || 0] || 0) * 5 / 100;
                        res.necklace_speed = enhancingSpeed * enhanceBonus * 100;
                    }
                }
            }
        }

        return res;
    }

    // ======================
    // 调试函数 - 显示所有获取到的数据
    // ======================

    function debugShowAllData() {
        if (!DEBUG.calc) return;
        logCalc('=== [Better Loot Tracker] 调试信息 - 所有数据===');

        // 基础数据
        logCalc('1. 基础数据状态');
        logCalc('   - itemDetailMap available:', !!itemDetailMap);
        logCalc('   - characterItems available:', !!characterItems);
        logCalc('   - characterBuffs available:', !!characterBuffs);
        logCalc('   - characterSkills available:', !!characterSkills);

        if (itemDetailMap) {
            logCalc('   - itemDetailMap size:', Object.keys(itemDetailMap).length);
        }

        if (characterSkills) {
            logCalc('   - characterSkills length:', characterSkills.length);
            const enhancingSkill = characterSkills.find(skill => skill.skillHrid === '/skills/enhancing');
            const observatorySkill = characterSkills.find(skill => skill.skillHrid === '/skills/observatory');
            logCalc('   - 强化技能等级', enhancingSkill?.level || '未找到');
            logCalc('   - 天文台技能等级', observatorySkill?.level || '未找到');
        }

        if (characterItems) {
            logCalc('   - characterItems length:', characterItems.length);
            logCalc('   - characterItems sample:', characterItems.slice(0, 3));

            // 查找暴饮之囊
            const guzzlingPouch = characterItems.find(item =>
                item.itemLocationHrid === "/item_locations/pouch" &&
                item.itemHrid === "/items/guzzling_pouch"
            );
            logCalc('   - 暴饮之囊:', guzzlingPouch);

            // 查找强化器
            const enhancers = characterItems.filter(item =>
                item.itemLocationHrid &&
                item.itemLocationHrid !== "/item_locations/inventory" &&
                itemDetailMap[item.itemHrid]?.equipmentDetail?.noncombatStats?.enhancingSuccess
            );
            logCalc('   - 强化器数量', enhancers.length);
            logCalc('   - 强化器列表', enhancers);
        }

        if (characterBuffs) {
            logCalc('   - characterBuffs length:', characterBuffs.length);
            logCalc('   - characterBuffs sample:', characterBuffs.slice(0, 3));

            // 查找茶类buff
            const teaBuffs = characterBuffs.filter(buff =>
                buff.itemHrid && (
                    buff.itemHrid.includes('tea') ||
                    buff.itemHrid.includes('enhancing') ||
                    buff.itemHrid.includes('blessed')
                )
            );
            logCalc('   - 茶类buff数量:', teaBuffs.length);
            logCalc('   - 茶类buff列表:', teaBuffs);
        }

        // 计算结果
        logCalc('2. 计算结果:');
        const playerParams = getPlayerEnhanceParams();
        const drinkMultiplier = playerParams.drink_concentration_bonus ? (1 + playerParams.drink_concentration_bonus / 100) : 1;
        const effectiveLevel = playerParams.enhancing_level +
            (playerParams.tea_enhancing ? 3 * drinkMultiplier : 0) +
            (playerParams.tea_super_enhancing ? 6 * drinkMultiplier : 0) +
            (playerParams.tea_ultra_enhancing ? 8 * drinkMultiplier : 0);
        const enhancingLevel = playerParams.enhancing_level;
        const observatoryLevel = playerParams.laboratory_level;
        const drinkBonus = playerParams.drink_concentration_bonus;
        const enhancerBonus = playerParams.enhancer_bonus;
        const teaEffects = {
            enhancing: playerParams.tea_enhancing,
            superEnhancing: playerParams.tea_super_enhancing,
            ultraEnhancing: playerParams.tea_ultra_enhancing,
            blessed: playerParams.tea_blessed
        };

        logCalc('   - 强化技能等级', enhancingLevel);
        logCalc('   - 天文台技能等级', observatoryLevel);
        logCalc('   - 暴饮之囊加成:', drinkBonus);
        logCalc('   - 强化器加成', enhancerBonus);
        logCalc('   - 茶效果', teaEffects);

        // 测试强化计算
        logCalc('3. 测试强化计算 (以星空针+5为例):');
        const testItemHrid = '/items/celestial_needle';
        if (itemDetailMap && itemDetailMap[testItemHrid]) {
            const testResult = Enhancelate(testItemHrid, 5, 2);
            logCalc('   - 测试物品:', testItemHrid);
            logCalc('   - 物品等级:', getBaseItemLevel(testItemHrid));
            logCalc('   - 期望强化次数:', testResult.actions);
            logCalc('   - 期望保护次数:', testResult.protectCount);
        } else {
            logCalc('   - 测试物品不存在于itemDetailMap')
        }

        logCalc('=== 调试信息结束 ===');
    }

    // 计算期望强化次数和保护次数
    function Enhancelate(itemHrid, stopAt, protectAt, overrideParams = null) {
        logCalc('[Better Loot Tracker] Enhancelate called with:', { itemHrid, stopAt, protectAt, overrideParams });

        const itemLevel = getBaseItemLevel(itemHrid);
        logCalc('[Better Loot Tracker] Item level:', itemLevel);
        const playerParams = { ...getPlayerEnhanceParams(), ...(overrideParams || {}) };

        // 获取实际的强化等级和天文台等级
        const actualEnhancingLevel = playerParams.enhancing_level;
        const actualObservatoryLevel = playerParams.laboratory_level;

        logCalc('[Better Loot Tracker] Using enhancing level:', actualEnhancingLevel);
        logCalc('[Better Loot Tracker] Using observatory level:', actualObservatoryLevel);

        // 获取暴饮之囊加成
        const drinkConcentrationBonus = playerParams.drink_concentration_bonus;
        const drinkConcentrationMultiplier = drinkConcentrationBonus ? (1 + drinkConcentrationBonus / 100) : 1;
        logCalc('[Better Loot Tracker] Drink concentration multiplier:', drinkConcentrationMultiplier);

        // 获取茶效果
        const teaEffects = {
            enhancing: playerParams.tea_enhancing,
            superEnhancing: playerParams.tea_super_enhancing,
            ultraEnhancing: playerParams.tea_ultra_enhancing,
            blessed: playerParams.tea_blessed
        };

        // 计算有效强化等级（包含茶的加成和暴饮之囊加成影响）
        const effectiveLevel = actualEnhancingLevel +
            (teaEffects.enhancing ? 3 * drinkConcentrationMultiplier : 0) +
            (teaEffects.superEnhancing ? 6 * drinkConcentrationMultiplier : 0) +
            (teaEffects.ultraEnhancing ? 8 * drinkConcentrationMultiplier : 0);
        logCalc('[Better Loot Tracker] Effective level:', effectiveLevel, 'base:', actualEnhancingLevel);

        // 获取强化器加成
        const enhancerBonus = playerParams.enhancer_bonus;

        // 计算总加成
        let totalBonus;
        if (effectiveLevel >= itemLevel) {
            totalBonus = 1 + (0.05 * (effectiveLevel + actualObservatoryLevel - itemLevel) + enhancerBonus) / 100;
        } else {
            totalBonus = 1 - 0.5 * (1 - effectiveLevel / itemLevel) + (0.05 * actualObservatoryLevel + enhancerBonus) / 100;
        }
        logCalc('[Better Loot Tracker] Total bonus:', totalBonus);

        // 建立马尔可夫矩阵
        let markov = math.zeros(21, 21);
        for (let i = 0; i < stopAt; i++) {
            // A probability cannot exceed 100% or become negative.  Without
            // this clamp, large equipment/buff bonuses make the Markov row sum
            // exceed one and corrupt expected attempts and protection usage.
            const successChance = Math.min(1, Math.max(0, (SUCCESS_RATE[i] / 100.0) * totalBonus));
            const destination = i >= protectAt ? i - 1 : 0;

            if (teaEffects.blessed) {
                // 祝福茶效果也受暴饮之囊加成影响
                const blessedEffect = Math.min(1, Math.max(0, 0.01 * drinkConcentrationMultiplier));
                markov.set([i, Math.min(i + 2, 20)], successChance * blessedEffect);
                markov.set([i, i + 1], successChance * (1 - blessedEffect));
                markov.set([i, destination], 1 - successChance);
            } else {
                markov.set([i, i + 1], successChance);
                markov.set([i, destination], 1.0 - successChance);
            }
        }
        markov.set([stopAt, stopAt], 1.0);

        // 计算期望强化次数
        let Q = markov.subset(math.index(math.range(0, stopAt), math.range(0, stopAt)));
        const M = math.inv(math.subtract(math.identity(stopAt), Q));
        const attemptsArray = M.subset(math.index(math.range(0, 1), math.range(0, stopAt)));
        const attempts = typeof attemptsArray === "number"
            ? attemptsArray
            : math.flatten(math.row(attemptsArray, 0).valueOf()).reduce((a, b) => a + b, 0);

        // 计算期望保护次数
        let protects = 0;
        if (protectAt >= 1 && protectAt < stopAt) {
            const protectAttempts = M.subset(math.index(math.range(0, 1), math.range(protectAt, stopAt)));
            const protectAttemptsArray = typeof protectAttempts === "number"
                ? [protectAttempts]
                : math.flatten(math.row(protectAttempts, 0).valueOf());
            protects = protectAttemptsArray.map((a, i) =>
                a * markov.get([i + protectAt, i + protectAt - 1])
            ).reduce((a, b) => a + b, 0);
        }

        const result = {
            actions: attempts,
            protectCount: protects
        };
        logCalc('[Better Loot Tracker] Enhancelate result:', result);
        return result;
    }

    // 找到最佳保护等级
    function findBestProtectLevel(itemHrid, targetLevel, marketData) {
        const enhancementCosts = getEnhancementCosts(itemHrid);
        if (!enhancementCosts) return { protectAt: 2, materialCost: 0, protectCost: 0 };

        // 计算每次强化的材料成本
        let perActionCost = 0;
        for (const cost of enhancementCosts) {
            const price = getMarketPrice(cost.itemHrid, marketData);
            perActionCost += price * cost.count;
        }

        // 计算保护成本
        const protectionItems = getProtectionItems(itemHrid);
        let minProtectCost = Infinity;
        for (const protectHrid of protectionItems) {
            const price = getMarketPrice(protectHrid, marketData);
            if (price > 0 && price < minProtectCost) {
                minProtectCost = price;
            }
        }
        if (minProtectCost === Infinity) minProtectCost = 0;

        // 遍历所有可能的保护等级找到最优
        let bestResult = null;
        const startProtect = targetLevel === 1 ? 1 : 2;

        for (let protectAt = startProtect; protectAt <= targetLevel; protectAt++) {
            const sim = Enhancelate(itemHrid, targetLevel, protectAt);
            const totalCost = perActionCost * sim.actions + minProtectCost * sim.protectCount;

            if (!bestResult || totalCost < bestResult.totalCost) {
                bestResult = {
                    protectAt: protectAt,
                    expectedActions: sim.actions,
                    expectedProtects: sim.protectCount,
                    perActionCost: perActionCost,
                    minProtectCost: minProtectCost,
                    totalCost: totalCost
                };
            }
        }

        return bestResult;
    }

    // ======================
    // 解析掉落记录
    // ======================

    function parseEnhancementLoot(lootElement) {
        // 获取标题信息
        const titleSpan = Array.from(lootElement.querySelectorAll('div > span:not(.loot-log-index)'))
            .find((span) => /^(?:强化|Enhancing)\s*[-—–]/i.test(span.textContent.trim()));
        if (!titleSpan) return null;

        const titleText = titleSpan.textContent.trim();

        // 解析强化次数：格式如 "强化 - 星空针(104)" 或 "Enhancing - Celestial Needle (104)"
        const countMatch = titleText.match(/\((\d+)\)/);
        if (!countMatch) return null;
        const enhanceCount = parseInt(countMatch[1]);
        const startLevelMatch = titleText.match(/\+(\d+)\s*\(\d+\)\s*$/);
        let startLevel = startLevelMatch ? parseInt(startLevelMatch[1]) : 0;

        // 解析持续时间
        let duration = 0;

        // 尝试从专门的持续时间元素中获取
        const durationElement = lootElement.querySelector('div');
        if (durationElement) {
            // 查找包含"持续时间:"的div
            let durationText = '';
            const divs = lootElement.querySelectorAll('div');
            for (const div of divs) {
                if (div.textContent.includes('持续时间:')) {
                    durationText = div.textContent;
                    break;
                }
            }

            if (durationText) {
                // 解析完整格式：2h 10m 26s
                const hoursMatch = durationText.match(/(\d+)\s*h/);
                const minutesMatch = durationText.match(/(\d+)\s*m/);
                const secondsMatch = durationText.match(/(\d+)\s*s/);

                const hours = hoursMatch ? parseInt(hoursMatch[1]) : 0;
                const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
                const seconds = secondsMatch ? parseInt(secondsMatch[1]) : 0;

                duration = hours * 3600 + minutes * 60 + seconds;
            } else {
                // 尝试从标题文本中获取
                const durationMatch = titleText.match(/持续时间:\s*(\d+)\s*秒/);
                if (!durationMatch) {
                    // 尝试匹配其他格式
                    const durationMatch2 = titleText.match(/(\d+)\s*秒/);
                    if (durationMatch2) {
                        duration = parseInt(durationMatch2[1]);
                    }
                } else {
                    duration = parseInt(durationMatch[1]);
                }
            }
        }

        // 解析物品名称 - 同时尝试中英文格式
        let itemName = null;

        // 尝试中文格式
        const zhMatch = titleText.match(/强化\s*-\s*(.+?)\s*\(/);
        if (zhMatch) {
            itemName = zhMatch[1].trim();
        }

        // 如果中文没匹配到，尝试英文格式
        if (!itemName) {
            const enMatch = titleText.match(/Enhancing\s*-\s*(.+?)\s*\(/i);
            if (enMatch) {
                itemName = enMatch[1].trim();
            }
        }

        if (!itemName) return null;

        // 提取基础物品名称，去除强化等级后缀
        itemName = itemName.replace(/ \+\d+$/, '').trim();

        // 获取物品HRID（支持中英文，自动去掉强化等级）
        const itemHrid = getItemHrid(itemName);
        if (!itemHrid) {
            logCalc('[Better Loot Tracker] 未找到物品HRID:', itemName);
            return null;
        }
        const logDateText = Array.from(lootElement.querySelectorAll('div')).map((node) => node.textContent).find((value) => /\d{4}\/\d{1,2}\/\d{1,2}/.test(value || ''));
        const logDateMatch = logDateText?.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})[^\d]*(\d{1,2}):(\d{2}):(\d{2})/);
        const logStartedAt = logDateMatch ? new Date(Number(logDateMatch[1]), Number(logDateMatch[2]) - 1, Number(logDateMatch[3]), Number(logDateMatch[4]), Number(logDateMatch[5]), Number(logDateMatch[6])).toISOString() : null;
        const logCompletedAt = logStartedAt ? new Date(new Date(logStartedAt).getTime() + duration * 1000).toISOString() : null;
        const serverCompletion = window.__MWI_FIND_ENHANCEMENT_COMPLETION__?.(itemHrid, enhanceCount, logStartedAt, logCompletedAt) || null;

        // 解析各等级掉落
        const drops = {};
        const progression = [];
        const itemContainers = lootElement.querySelectorAll('[class*="Item_itemContainer"]');

        for (const container of itemContainers) {
            const countDiv = container.querySelector('[class*="Item_count"]');
            const levelDiv = container.querySelector('[class*="Item_enhancementLevel"]');

            if (countDiv) {
                const count = parseInt(countDiv.textContent) || 0;
                let level = 0;

                if (levelDiv) {
                    const levelMatch = levelDiv.textContent.match(/\+(\d+)/);
                    level = levelMatch ? parseInt(levelMatch[1]) : 0;
                }

                // 检查是否是强化精华（排除它）
                const itemIcon = container.querySelector('svg use');
                if (itemIcon) {
                    const href = itemIcon.getAttribute('href') || '';
                    if (href.includes('enhancing_essence')) {
                        continue; // 跳过强化精华
                    }
                }

                // 检查是否是工匠匣（排除它）
                const svg = container.querySelector('svg[aria-label]');
                if (svg) {
                    const ariaLabel = svg.getAttribute('aria-label') || '';
                    if (ariaLabel.includes('工匠匣') || ariaLabel.includes('craftsman')) {
                        continue; // 跳过工匠匣
                    }
                }

                drops[level] = (drops[level] || 0) + count;
                progression.push({ level, count });
            }
        }

        return {
            startedAt: logStartedAt,
            completedAt: logCompletedAt,
            itemName,
            itemHrid,
            enhanceCount,
            startLevel,
            duration,
            drops,
            progression,
            // 等级分布只说明各等级出现过多少次，不能推出停止时装备停在哪一级。
            // 优先采用服务器 action_completed；缺失时由下一段起始等级或明确成功目标回填。
            serverCompletion,
            startLevelSource: 'loot_title',
            finalLevelSource: serverCompletion?.finalLevelSource || 'unknown',
            finalLevel: serverCompletion?.finalLevel ?? null
        };
    }

    function parseAlchemyLoot(lootElement) {
        const titleSpan = lootElement.querySelector('div > span:not(.loot-log-index)');
        if (!titleSpan) return null;

        const titleText = titleSpan.textContent;
        if (!titleText.includes('炼金') && !titleText.toLowerCase().includes('alchemy')) {
            return null;
        }

        const costMatch = titleText.match(/:\s*(.+?)\s*\((\d+)\)\s*$/);
        if (!costMatch) return null;

        const costItemName = costMatch[1].trim();
        const costCount = parseInt(costMatch[2], 10);
        if (!costItemName || !Number.isFinite(costCount)) return null;

        const costItemHrid = getItemHrid(costItemName);
        if (!costItemHrid) {
            logCalc('[Better Loot Tracker] 未找到炼金消耗物品HRID:', costItemName);
            return null;
        }

        const outputs = {};
        const itemContainers = lootElement.querySelectorAll('[class*="Item_itemContainer"]');
        for (const container of itemContainers) {
            const countDiv = container.querySelector('[class*="Item_count"]');
            if (!countDiv) continue;
            const count = parseInt(countDiv.textContent, 10) || 0;
            if (count <= 0) continue;

            const itemIcon = container.querySelector('svg use');
            const href = itemIcon?.getAttribute('href') || '';
            const idMatch = href.match(/#(.+)$/);
            if (!idMatch) continue;

            const itemId = idMatch[1].trim();
            if (!itemId) continue;

            const itemHrid = `/items/${itemId}`;
            outputs[itemHrid] = (outputs[itemHrid] || 0) + count;
        }

        return {
            costItemHrid,
            costCount,
            outputs
        };
    }

    function analyzeEnhancementResult(parsedData) {
        const { drops } = parsedData;
        const serverCompletion = parsedData.serverCompletion;
        if (serverCompletion && Number.isInteger(Number(serverCompletion.finalLevel))) {
            const targetLevel = Number(serverCompletion.targetLevel);
            const finalLevel = Number(serverCompletion.finalLevel);
            parsedData.finalLevel = finalLevel;
            // A completion packet always proves the final level.  Older payload
            // variants can omit enhancingMaxLevel, in which case preserve the
            // normal inferred target while still marking the result confirmed.
            const observedLevels = Object.keys(drops).map(Number).filter(Number.isFinite);
            const maxLevel = Math.max(0, ...observedLevels, finalLevel);
            const resolvedTarget = Number.isInteger(targetLevel) && targetLevel >= 0 ? targetLevel : maxLevel;
            return { targetLevel: resolvedTarget, success: finalLevel >= resolvedTarget, maxLevel, maxLevelCount: drops[finalLevel] || 0, serverConfirmed: true };
        }

        // 找到最高等级和其数量
        let maxLevel = 0;
        let maxLevelCount = 0;

        for (const [levelStr, count] of Object.entries(drops)) {
            const level = parseInt(levelStr);
            if (level > maxLevel) {
                maxLevel = level;
                maxLevelCount = count;
            }
        }

        // 判断目标等级和是否成功
        let targetLevel, success;
        if (maxLevelCount === 1) {
            targetLevel = maxLevel;
            success = true;
        } else {
            targetLevel = maxLevel + 1;
            success = false;
        }

        return {
            targetLevel,
            success,
            maxLevel,
            maxLevelCount
        };
    }

    function parsePreferenceLevels(text) {
        if (!text) return [];
        const matches = text.match(/\d+/g) || [];
        const levels = matches
            .map((value) => parseInt(value, 10))
            .filter((level) => Number.isFinite(level) && level >= 1 && level <= 20);
        return Array.from(new Set(levels)).sort((a, b) => a - b);
    }

    function applyPreferredTarget(analysisResult, preferenceLevels) {
        if (!preferenceLevels || preferenceLevels.length === 0) return analysisResult;
        // 使用targetLevel而不是maxLevel来判断偏好等级
        // 因为targetLevel是分析后的目标等级（例如有两个+8说明目标是+9）
        const { targetLevel } = analysisResult;
        if (preferenceLevels.includes(targetLevel)) return analysisResult;

        const nextPreferred = preferenceLevels.find((level) => level > targetLevel);
        if (!nextPreferred) return analysisResult;

        return {
            ...analysisResult,
            targetLevel: nextPreferred,
            success: false
        };
    }

    function getAlchemyPriceSides(mode) {
        switch (mode) {
            case 'bid_ask':
                return { costSide: 'bid', outputSide: 'ask' };
            case 'ask_ask':
                return { costSide: 'ask', outputSide: 'ask' };
            case 'bid_bid':
                return { costSide: 'bid', outputSide: 'bid' };
            case 'ask_bid':
            default:
                return { costSide: 'ask', outputSide: 'bid' };
        }
    }

    function hasSuperEnhanceGap(drops, protectAt) {
        if (!protectAt || protectAt < 2) return false;
        let missingStreak = 0;
        for (let level = 1; level < protectAt; level++) {
            if ((drops[level] || 0) > 0) {
                missingStreak = 0;
                continue;
            }
            missingStreak += 1;
            if (missingStreak >= 2) return true;
        }
        return false;
    }

    function getExpectedTotalCostToLevel(itemHrid, level, marketData) {
        if (!level || level <= 0) return 0;
        const strategy = findBestProtectLevel(itemHrid, level, marketData);
        return strategy ? strategy.totalCost : 0;
    }

    function applySuperEnhanceFailurePadding(drops, startLevel) {
        const padded = { ...drops };
        const cap = Math.max(0, Math.min(Math.floor(startLevel), 20));
        for (let level = 0; level <= cap; level++) {
            padded[level] = (padded[level] || 0) + 1;
        }
        return padded;
    }

    function displayAlchemyInfo(lootElement, alchemyData, marketData) {
        const { costItemHrid, costCount, outputs } = alchemyData;
        const priceSides = getAlchemyPriceSides(globalAlchemyPriceMode);
        const costPrice = getMarketPriceSide(costItemHrid, marketData, priceSides.costSide);
        const totalCost = costPrice === null ? null : costPrice * costCount;

        let totalOutput = 0;
        let unavailable = totalCost === null;
        for (const [itemHrid, count] of Object.entries(outputs)) {
            const outputPrice = getMarketPriceSide(itemHrid, marketData, priceSides.outputSide);
            if (outputPrice === null) {
                unavailable = true;
                break;
            }
            totalOutput += outputPrice * count;
        }
        if (!unavailable) totalOutput *= 0.98;

        const profit = unavailable ? null : totalOutput - totalCost;
        const profitColor = profit >= 0 ? 'rgb(100, 255, 100)' : 'rgb(255, 100, 100)';

        const titleSpan = lootElement.querySelector('div > span:not(.loot-log-index)');
        if (!titleSpan) return;

        const existingTitleInfo = titleSpan.parentElement.querySelector('.alchemy-title-info');
        if (existingTitleInfo) {
            existingTitleInfo.remove();
        }

        const titleInfo = document.createElement('span');
        titleInfo.className = 'alchemy-title-info';
        titleInfo.style.cssText = 'margin-left: 8px;';
        titleInfo.innerHTML = unavailable ? `
            <span style="margin-left: 8px; color: #ffcc66;">${t.alchemyProfit}: ${isZH ? '无法估计（缺少所选买/卖报价）' : 'Unavailable (missing selected bid/ask quote)'}</span>
        ` : `
            <span style="margin-left: 8px; color: #e0e0e0;">${t.alchemyCost}: ${formatNumber(totalCost)}</span>
            <span style="margin-left: 8px; color: #e0e0e0;">${t.alchemyOutput}: ${formatNumber(totalOutput)}</span>
            <span style="margin-left: 8px; color: ${profitColor};">${t.alchemyProfit}: ${formatNumber(profit)}</span>
        `;

        titleSpan.after(titleInfo);
    }

    function renderGlobalSettingsPanel(container) {
        // The old per-loot configuration, manual merge and duplicate history
        // views were superseded by the single enhancement-profit ledger.
        // Remove remnants injected by an older running version and expose no
        // replacement UI in the loot list.
        document.querySelectorAll('.enhancement-loot-tracker-global-settings-wrapper').forEach((node) => node.remove());
        return;

        if (!container) return;

        let wrapper = container.querySelector('.enhancement-loot-tracker-global-settings-wrapper');
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = 'enhancement-loot-tracker-global-settings-wrapper';
            wrapper.style.cssText = `
                margin: 6px 0 10px 0;
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
            `;

            wrapper.innerHTML = `
                <button class="elt-global-settings-toggle" style="background: rgba(100,100,100,0.5); border: 1px solid #666; border-radius: 6px; color: #ddd; cursor: pointer; padding: 4px 10px; font-size: 12px;">
                    ⚙️ ${t.globalSettings}
                </button>
                <button class="elt-global-calculate-merge" style="background: rgba(100,100,100,0.5); border: 1px solid #666; border-radius: 6px; color: #ddd; cursor: pointer; padding: 4px 10px; font-size: 12px;">
                    🧮 合并计算
                </button>
                <button class="elt-global-clear-merge" style="background: rgba(100,100,100,0.5); border: 1px solid #666; border-radius: 6px; color: #ddd; cursor: pointer; padding: 4px 10px; font-size: 12px;">
                    🗑️ 清除选择
                </button>
                <div class="enhancement-loot-tracker-global-settings" style="
                    padding: 8px 12px;
                    background: rgba(0, 0, 0, 0.35);
                    border-radius: 8px;
                    font-size: 12px;
                    color: #e0e0e0;
                    display: none;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 8px;
                ">
                    <label style="display: flex; align-items: center; gap: 6px;">
                        ${t.preferredLevels}:
                        <input class="elt-global-preference" placeholder="使用空格分隔，如‘7 8 10’" style="width: 140px; background: rgba(50,50,50,0.8); color: #e0e0e0; border: 1px solid #555; border-radius: 4px; padding: 2px 6px; font-size: 11px;">
                    </label>
                    <label style="display: flex; align-items: center; gap: 6px;">
                        ${t.superEnhanceMinLevel}:
                        <input class="elt-global-super-min" type="number" min="0" max="20" style="width: 64px; background: rgba(50,50,50,0.8); color: #e0e0e0; border: 1px solid #555; border-radius: 4px; padding: 2px 6px; font-size: 11px;">
                    </label>
                    <label style="display: flex; align-items: center; gap: 6px;">
                        ${t.alchemyPriceMode}:
                        <select class="elt-global-alchemy-price" style="background: rgba(50,50,50,0.8); color: #e0e0e0; border: 1px solid #555; border-radius: 4px; padding: 2px 6px; font-size: 11px;">
                            <option value="ask_bid">${t.alchemyPriceAskBid}</option>
                            <option value="bid_ask">${t.alchemyPriceBidAsk}</option>
                            <option value="ask_ask">${t.alchemyPriceAskAsk}</option>
                            <option value="bid_bid">${t.alchemyPriceBidBid}</option>
                        </select>
                    </label>
                    <span style="font-size: 11px; color: #888;">用于所有掉落记录</span>
                </div>
            `;

            container.prepend(wrapper);

            const historyButton = document.createElement('button');
            historyButton.className = 'elt-global-history';
            historyButton.textContent = isZH ? '强化历史' : 'Enhancement History';
            historyButton.style.cssText = 'background: rgba(100,100,100,0.5); border: 1px solid #666; border-radius: 6px; color: #ddd; cursor: pointer; padding: 4px 10px; font-size: 12px;';
            historyButton.addEventListener('click', showEnhancementHistory);
            wrapper.insertBefore(historyButton, wrapper.querySelector('.enhancement-loot-tracker-global-settings'));

            const toggle = wrapper.querySelector('.elt-global-settings-toggle');
            const panel = wrapper.querySelector('.enhancement-loot-tracker-global-settings');
            toggle.addEventListener('click', () => {
                if (panel) {
                    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
                }
            });

            // 添加计算合并按钮点击事件
            const calculateBtn = wrapper.querySelector('.elt-global-calculate-merge');
            calculateBtn.addEventListener('click', () => {
                calculateMergedEnhancements();
            });

            // 添加清除选择按钮点击事件
            const clearBtn = wrapper.querySelector('.elt-global-clear-merge');
            clearBtn.addEventListener('click', () => {
                // 清空选择的记录
                selectedEnhancements.forEach((data, element) => {
                    const addBtn = element.querySelector('.enhancement-add-to-merge');
                    if (addBtn) {
                        addBtn.style.background = 'rgba(100,100,100,0.5)';
                        addBtn.style.color = '#ccc';
                    }
                    // 移除高亮外框
                    element.style.border = 'none';
                    element.style.boxShadow = 'none';
                    element.style.padding = '';
                });
                selectedEnhancements.clear();
            });
        }

        const input = wrapper.querySelector('.elt-global-preference');
        if (input && input.value !== globalPreferenceText) {
            input.value = globalPreferenceText;
        }
        if (input && !input.dataset.bound) {
            input.dataset.bound = '1';
            input.addEventListener('change', () => {
                setGlobalPreferenceText(input.value);
                processLootLogs({ force: true });
            });
        }

        const superInput = wrapper.querySelector('.elt-global-super-min');
        if (superInput && superInput.value !== String(globalSuperEnhanceMinLevel)) {
            superInput.value = String(globalSuperEnhanceMinLevel);
        }
        if (superInput && !superInput.dataset.bound) {
            superInput.dataset.bound = '1';
            superInput.addEventListener('change', () => {
                setSuperEnhanceMinLevel(superInput.value);
                processLootLogs({ force: true });
            });
        }

        const alchemySelect = wrapper.querySelector('.elt-global-alchemy-price');
        if (alchemySelect && alchemySelect.value !== globalAlchemyPriceMode) {
            alchemySelect.value = globalAlchemyPriceMode;
        }
        if (alchemySelect && !alchemySelect.dataset.bound) {
            alchemySelect.dataset.bound = '1';
            alchemySelect.addEventListener('change', () => {
                setAlchemyPriceMode(alchemySelect.value);
                processLootLogs({ force: true });
            });
        }
    }

    /**
     * 计算实际保护次数
     *
     * 算法说明
     * 1. 从保护等级x开始，累加x, x+2, x+4...的掉落次数
     * 2. 如果成功，再减去保护等级和目标等级之间包含的"奇数位置"等级数量
     *    这里“奇数位置”是指：从protectAt开始数，第1个、第2个..等级
     *    例如 protectAt=5, targetLevel=7:
     *    需要累加 +5 和 +7 的次数
     *    成功时减去（因为成功到达+7需要经过+5和+7这两个保护点各一次成功）
     *
     * @param {Object} drops - 各等级掉落数据{0: 46, 1: 27, 2: 12, ...}
     * @param {number} protectAt - 保护起始等级
     * @param {number} targetLevel - 目标等级
     * @param {boolean} success - 是否成功到达目标
     * @returns {number} 实际保护次数
     */
    function calculateActualProtections(drops, protectAt, targetLevel, success) {
        if (!protectAt || protectAt < 1) return 0;
        // 按保护等级的奇偶性统计保护位掉落
        let protectCount = 0;
        const parity = protectAt % 2;
        for (let level = protectAt; level <= targetLevel; level++) {
            if (level % 2 !== parity) continue;
            protectCount += (drops[level] || 0);
        }

        // 成功时扣掉一路通过的保护位次数
        if (success) {
            let successPassCount = 0;
            for (let level = protectAt; level <= targetLevel; level++) {
                if (level % 2 !== parity) continue;
                successPassCount++;
            }
            protectCount -= successPassCount;
        }

        return Math.max(0, protectCount);
    }

    // ======================
    // 格式化数据
    // ======================

    function formatNumber(num) {
        if (num === undefined || num === null || isNaN(num)) return '0';

        const absNum = Math.abs(num);
        let formatted;

        if (absNum >= 1e9) {
            formatted = (num / 1e9).toFixed(2) + 'B';
        } else if (absNum >= 1e6) {
            formatted = (num / 1e6).toFixed(2) + 'M';
        } else if (absNum >= 1e3) {
            formatted = (num / 1e3).toFixed(2) + 'K';
        } else {
            formatted = Math.round(num).toString();
        }

        return formatted;
    }

    // ======================
    // 显示增强信息
    // ======================

    // 存储每个掉落记录的配置
    const lootConfigs = new WeakMap();

    function displayEnhancementInfo(lootElement, parsedData, analysisResult, marketData, customConfig = null) {
        logCalc('[Better Loot Tracker] displayEnhancementInfo called with:', parsedData);

        const { itemHrid, enhanceCount, drops, startLevel } = parsedData;
        const targetLevel = analysisResult.targetLevel;
        const success = analysisResult.success;
        const bestStrategy = findBestProtectLevel(itemHrid, targetLevel, marketData);
        if (!bestStrategy) return;
        const protectAt = bestStrategy.protectAt;
        const sim = Enhancelate(itemHrid, targetLevel, protectAt);
        if (!sim) return;
        const actualMaterialCost = bestStrategy.perActionCost * enhanceCount;
        const actualProtectCount = calculateActualProtections(drops, protectAt, targetLevel, success);
        const actualProtectCost = bestStrategy.minProtectCost * actualProtectCount;
        const actualTotalCost = actualMaterialCost + actualProtectCost;
        const expectedTotalCost = bestStrategy.perActionCost * sim.actions + bestStrategy.minProtectCost * sim.protectCount;
        const completionConfirmed = Boolean(parsedData.serverCompletion);
        if (!completionConfirmed) removeInProgressEnhancementSnapshots(parsedData);
        const archivedSnapshot = getOrArchiveEnhancementSnapshot(parsedData, {
            material: actualMaterialCost,
            protection: actualProtectCost,
            total: actualTotalCost,
            protectionCount: actualProtectCount
        }, targetLevel, protectAt, marketData, completionConfirmed);
        const ledgerState = enhancementLedgerState(parsedData);
        const titleSpan = lootElement.querySelector('div > span:not(.loot-log-index)');
        if (!titleSpan) return;
        titleSpan.parentElement.querySelector('.enhancement-title-info')?.remove();
        lootElement.querySelectorAll('.enhancement-loot-tracker-info').forEach((node) => node.remove());
        const finalLevel = archivedSnapshot?.finalLevel ?? parsedData.finalLevel;
        const outcomeKnown = Number.isInteger(finalLevel);
        const status = outcomeKnown ? (finalLevel >= targetLevel ? t.success : t.failure) : (isZH ? '结果待确认' : 'Outcome pending');
        const statusColor = !outcomeKnown ? '#ffcc66' : (finalLevel >= targetLevel ? 'rgb(100,255,100)' : 'rgb(255,100,100)');
        const ledgerText = ledgerState.state === 'recorded'
            ? (isZH ? '收益账本：已入账' : 'Ledger: recorded')
            : ledgerState.state === 'unrecorded'
                ? (isZH ? '收益账本：已完成但尚未入账；请刷新掉落记录' : 'Ledger: completed but not recorded; refresh loot logs')
                : ledgerState.state === 'awaiting_final_level'
                    ? (isZH ? '收益账本：服务器已记录完成，但缺少最终等级（未入账）' : 'Ledger: action ended, but the final level packet is missing (not recorded)')
                    : (isZH ? '收益账本：等待强化队列结束确认（未入账）' : 'Ledger: waiting for queue completion (not recorded)');
        const ledgerColor = ledgerState.state === 'recorded' ? '#7be0bc' : '#ffcc66';
        const info = document.createElement('span');
        info.className = 'enhancement-title-info';
        info.style.cssText = 'margin-left:8px;';
        info.innerHTML = `<span style="color:${statusColor};font-weight:bold">[${status}]</span><span style="margin-left:8px;color:#e0e0e0">${t.material}: ${formatNumber(actualMaterialCost)}</span><span style="margin-left:8px;color:#e0e0e0">${t.protection}: ${formatNumber(actualProtectCost)}</span><span style="margin-left:8px;color:#e0e0e0">${t.total}: ${formatNumber(actualTotalCost)} (${formatNumber(actualTotalCost - expectedTotalCost)} ${isZH ? '相对预期' : 'vs expected'})</span><br><span style="margin-left:8px;color:${ledgerColor}">${ledgerText}</span>`;
        titleSpan.after(info);
        return;

        /* Legacy manual per-loot configuration and merge UI, retired in 1.5.3.
        // 获取或初始化配置
        let config = customConfig || lootConfigs.get(lootElement);
        if (!config) {
            const preferenceLevels = getGlobalPreferenceLevels();
            const preferredAnalysis = applyPreferredTarget(analysisResult, preferenceLevels);
            config = {
                targetLevel: preferredAnalysis.targetLevel,
                success: preferredAnalysis.success,
                protectAt: null,
                hasCustomTarget: false,
                hasCustomSuccess: false
            };
            lootConfigs.set(lootElement, config);
        }

        const preferredAnalysis = applyPreferredTarget(analysisResult, getGlobalPreferenceLevels());
        const targetLevel = config.hasCustomTarget ? config.targetLevel : preferredAnalysis.targetLevel;
        const success = config.hasCustomSuccess ? config.success : preferredAnalysis.success;
        if (!config.hasCustomTarget) config.targetLevel = targetLevel;
        if (!config.hasCustomSuccess) config.success = success;

        logCalc('[Better Loot Tracker] Config:', config);

        // 获取最佳强化策略
        const bestStrategy = findBestProtectLevel(itemHrid, targetLevel, marketData);
        if (!bestStrategy) {
            logCalc('[Better Loot Tracker] No best strategy found');
            return;
        }

        logCalc('[Better Loot Tracker] Best strategy:', bestStrategy);

        // 使用用户自定义保护等级或最佳保护等级
        const protectAt = config.protectAt !== null
            ? Math.min(config.protectAt, targetLevel)
            : bestStrategy.protectAt;

        const maxLevel = analysisResult.maxLevel;
        const hasZeroDrop = (drops[0] || 0) > 0;
        const superMinLevel = getSuperEnhanceMinLevel();
        let isSuperEnhance = false;
        let superSuccess = false;
        let superTargetLevel = targetLevel;
        if (startLevel > 0 && startLevel >= superMinLevel) {
            if (!hasZeroDrop) {
                isSuperEnhance = true;
                superSuccess = true;
                superTargetLevel = maxLevel;
            } else if (hasSuperEnhanceGap(drops, protectAt)) {
                isSuperEnhance = true;
                superSuccess = false;
                superTargetLevel = 0;
            }
        }

        // 重新计算使用用户选择的保护等级的期望值
        const sim = Enhancelate(itemHrid, targetLevel, protectAt);
        const expectedMaterialCost = bestStrategy.perActionCost * sim.actions;
        const expectedProtectCost = bestStrategy.minProtectCost * sim.protectCount;
        const expectedTotalCost = expectedMaterialCost + expectedProtectCost;

        logCalc('[Better Loot Tracker] Expected costs:', {
            materialCost: expectedMaterialCost,
            protectCost: expectedProtectCost,
            totalCost: expectedTotalCost
        });

        // 计算实际消耗
        const actualMaterialCost = bestStrategy.perActionCost * enhanceCount;
        const actualProtectTargetLevel = isSuperEnhance ? maxLevel : targetLevel;
        const actualProtectSuccess = isSuperEnhance ? superSuccess : success;
        const dropsForProtect = isSuperEnhance && startLevel > 0
            ? applySuperEnhanceFailurePadding(drops, startLevel)
            : drops;
        const actualProtectCount = calculateActualProtections(dropsForProtect, protectAt, actualProtectTargetLevel, actualProtectSuccess);
        const actualProtectCost = bestStrategy.minProtectCost * actualProtectCount;
        const actualTotalCost = actualMaterialCost + actualProtectCost;

        logCalc('[Better Loot Tracker] Actual costs:', {
            materialCost: actualMaterialCost,
            protectCost: actualProtectCost,
            totalCost: actualTotalCost,
            protectCount: actualProtectCount
        });

        if (parsedData.serverCompletion) parsedData.finalLevelSource = 'server';

        // Only a completion packet that includes the final equipped level can
        // create a ledger batch.  A completed loot-log line alone is not
        // sufficient: its level distribution is the history of attempts.
        const completionConfirmed = Boolean(parsedData.serverCompletion);
        if (!completionConfirmed) removeInProgressEnhancementSnapshots(parsedData);
        const archivedSnapshot = getOrArchiveEnhancementSnapshot(parsedData, {
            material: actualMaterialCost,
            protection: actualProtectCost,
            total: actualTotalCost,
            protectionCount: actualProtectCount
        }, targetLevel, protectAt, marketData, completionConfirmed);
        const ledgerState = enhancementLedgerState(parsedData);
        const displayedMaterialCost = archivedSnapshot?.materialCost ?? actualMaterialCost;
        const displayedProtectCost = archivedSnapshot?.protectionCost ?? actualProtectCost;
        const displayedTotalCost = archivedSnapshot?.totalCost ?? actualTotalCost;

        // 计算比例
        const materialRatioNum = expectedMaterialCost > 0 ? displayedMaterialCost / expectedMaterialCost : 0;
        const protectRatioNum = expectedProtectCost > 0 ? displayedProtectCost / expectedProtectCost : 0;
        const totalRatioNum = expectedTotalCost > 0 ? displayedTotalCost / expectedTotalCost : 0;

        const materialRatio = materialRatioNum.toFixed(2);
        const protectRatio = protectRatioNum.toFixed(2);
        const totalRatio = totalRatioNum.toFixed(2);

        // 根据比例决定颜色：>1红色、<1绿色、=1白色
        const getRatioColor = (ratio) => {
            if (ratio > 1) return 'rgb(255, 100, 100)';
            if (ratio < 1) return 'rgb(100, 255, 100)';
            return '#e0e0e0';
        };
        const materialColor = getRatioColor(materialRatioNum);
        const protectColor = getRatioColor(protectRatioNum);
        const totalColor = getRatioColor(totalRatioNum);

        // 计算差值
        const diff = displayedTotalCost - expectedTotalCost;
        const diffText = diff >= 0 ? `${t.aboveExpected}: ${formatNumber(diff)}` : `${t.belowExpected}: ${formatNumber(Math.abs(diff))}`;
        const diffColor = diff >= 0 ? 'rgb(255, 100, 100)' : 'rgb(100, 255, 100)';

        // 成功/失败状态
        const hasConfirmedOutcome = Boolean(parsedData.serverCompletion) || Number.isInteger(parsedData.finalLevel);
        const statusText = !hasConfirmedOutcome ? (isZH ? '结果待确认' : 'Outcome pending') : (isSuperEnhance ? (superSuccess ? t.success : t.failure) : (success ? t.success : t.failure));
        const statusColor = !hasConfirmedOutcome ? '#ffcc66' : (isSuperEnhance
            ? (superSuccess ? 'rgb(100, 255, 100)' : 'rgb(255, 100, 100)')
            : (success ? 'rgb(100, 255, 100)' : 'rgb(255, 100, 100)'));

        // 生成唯一ID
        const uniqueId = `elt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // ========== 标题行信息（显示在标题后面） ==========
        const titleSpan = lootElement.querySelector('div > span:not(.loot-log-index)');
        if (titleSpan) {
            // 移除旧的标题行信息
            const existingTitleInfo = titleSpan.parentElement.querySelector('.enhancement-title-info');
            if (existingTitleInfo) {
                existingTitleInfo.remove();
            }

            // 创建标题行信息
            const titleInfo = document.createElement('span');
            titleInfo.className = 'enhancement-title-info';
            titleInfo.style.cssText = 'margin-left: 8px;';

            // 只有成功时才显示差值信息
            const diffHtml = success ? `<span style="margin-left: 8px; color: ${diffColor}; font-weight: bold;">${diffText}</span>` : '';
            const superOriginalCost = baseItemPrice + getExpectedTotalCostToLevel(itemHrid, startLevel, marketData);
            const superFinalValue = superSuccess
                ? baseItemPrice + getExpectedTotalCostToLevel(itemHrid, superTargetLevel, marketData)
                : baseItemPrice;
            const superProfit = superFinalValue - superOriginalCost - actualTotalCost;
            const superProfitColor = superProfit >= 0 ? 'rgb(100, 255, 100)' : 'rgb(255, 100, 100)';
            const finalLevel = archivedSnapshot?.finalLevel ?? parsedData.finalLevel;
            const financeHtml = ledgerState.state === 'pending' ? `
                <br><span style="margin-left: 8px; color: #ffcc66;">${isZH ? '收益账本：等待强化队列结束确认（未入账）' : 'Ledger: waiting for queue completion (not recorded)'}</span>
            ` : ledgerState.state === 'unrecorded' ? `
                <br><span style="margin-left: 8px; color: #ffcc66;">${isZH ? '收益账本：已完成但尚未入账；请刷新掉落记录' : 'Ledger: completed but not recorded; refresh loot logs'}</span>
            ` : archivedSnapshot?.pendingArchive ? `
                <br><span style="margin-left: 8px; color: #ffcc66;">${isZH ? '收益账本：等待归档' : 'Ledger: waiting to archive'}</span>
            ` : archivedSnapshot ? `
                <br><span style="margin-left: 8px; color: #7be0bc;">${isZH ? '收益账本：已入账' : 'Ledger: recorded'}</span>
                <span style="margin-left: 8px; color: #a8d8ff;">${isZH ? '历史最终成品' : 'Archived final item'}: ${finalLevel == null ? (isZH ? `待回填（记录最高曾到+${archivedSnapshot.observedMaxLevel ?? '?'}）` : `Pending (observed max +${archivedSnapshot.observedMaxLevel ?? '?'})`) : `+${finalLevel}`}</span>
                <span style="margin-left: 8px; color: #a8d8ff;">${isZH ? '起始装备成本' : 'Starting item cost'}: ${archivedSnapshot.startingItemCost == null ? '缺价' : formatNumber(archivedSnapshot.startingItemCost)}</span>
                <span style="margin-left: 8px; color: #a8d8ff;">${isZH ? '收购价' : 'Buy order'}: ${archivedSnapshot.bidPrice == null ? '缺价' : formatNumber(archivedSnapshot.bidPrice)}</span>
                <span style="margin-left: 8px; color: #a8d8ff;">${isZH ? '税后收入' : 'After-tax revenue'}: ${archivedSnapshot.revenue == null ? '缺价' : formatNumber(archivedSnapshot.revenue)}</span>
                <span style="margin-left: 8px; color: ${archivedSnapshot.netCashFlow >= 0 ? 'rgb(100, 255, 100)' : 'rgb(255, 100, 100)'};">${isZH ? '预计净收益' : 'Estimated net profit'}: ${archivedSnapshot.netCashFlow == null ? '等待价格' : formatNumber(archivedSnapshot.netCashFlow)}</span>
            ` : `
                <span style="margin-left: 8px; color: #ffcc66;">${isZH ? `记录解析失败，未存档` : 'Record parsing failed; not archived'}</span>
            `;

            const normalHtml = `
                <span style="color: ${statusColor}; font-weight: bold;">[${statusText}]</span>
                <span style="margin-left: 8px; color: ${materialColor};">${t.material}: ${formatNumber(displayedMaterialCost)} (${materialRatio}x ${formatNumber(expectedMaterialCost)})</span>
                <span style="margin-left: 8px; color: ${protectColor};">${t.protection}: ${formatNumber(displayedProtectCost)} (${protectRatio}x ${formatNumber(expectedProtectCost)})</span>
                <span style="margin-left: 8px; color: ${totalColor};">${t.total}: ${formatNumber(displayedTotalCost)} (${totalRatio}x ${formatNumber(expectedTotalCost)})</span>
                ${diffHtml}
            `;

            const superHtml = `
                <span style="color: ${statusColor}; font-weight: bold;">[${statusText}]</span>
                <span style="margin-left: 8px; color: #e0e0e0;">${t.superSpend}: ${formatNumber(actualTotalCost)}</span>
                <span style="margin-left: 8px; color: #e0e0e0;">${t.originalCost}: ${formatNumber(superOriginalCost)}</span>
                <span style="margin-left: 8px; color: #e0e0e0;">${t.finalValue}: ${formatNumber(superFinalValue)}</span>
                <span style="margin-left: 8px; color: ${superProfitColor};">${t.profit}: ${formatNumber(superProfit)}</span>
            `;

            titleInfo.innerHTML = `
                ${isSuperEnhance ? superHtml : normalHtml}
                ${financeHtml}
                <button class="enhancement-toggle-settings" style="margin-left: 8px; background: rgba(100,100,100,0.5); border: 1px solid #666; border-radius: 4px; color: #ccc; cursor: pointer; padding: 1px 6px; font-size: 12px; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; vertical-align: middle;">⚙</button>
                <button class="enhancement-add-to-merge" style="margin-left: 4px; background: rgba(100,100,100,0.5); border: 1px solid #666; border-radius: 4px; color: #ccc; cursor: pointer; padding: 1px 6px; font-size: 12px; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; vertical-align: middle;">+</button>
            `;

            // 插入到标题后面
            titleSpan.after(titleInfo);

            // 添加设置按钮点击事件
            const toggleBtn = titleInfo.querySelector('.enhancement-toggle-settings');
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const settingsPanel = lootElement.querySelector('.enhancement-loot-tracker-info');
                if (settingsPanel) {
                    settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
                }
            });

            // 添加加号选择按钮点击事件
            const addBtn = titleInfo.querySelector('.enhancement-add-to-merge');
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isSelected = selectedEnhancements.has(lootElement);
                if (isSelected) {
                    selectedEnhancements.delete(lootElement);
                    addBtn.style.background = 'rgba(100,100,100,0.5)';
                    addBtn.style.color = '#ccc';
                    // 移除高亮外框
                    lootElement.style.border = 'none';
                    lootElement.style.boxShadow = 'none';
                } else {
                    // 检查是否与之前选择的装备类型相同
                    let sameItem = true;
                    let firstItemHrid = null;

                    // 获取第一个选择的装备名称
                    selectedEnhancements.forEach((data, element) => {
                        if (!firstItemHrid) {
                            firstItemHrid = data.parsedData.itemHrid;
                        }
                    });

                    // 检查当前装备是否与第一个选择的装备相同
                    // 由于我们已经在parseEnhancementLoot中统一了物品名称格式（去除了强化等级后缀）
                    // 所以现在可以直接比较itemName
                    if (firstItemHrid && parsedData.itemHrid !== firstItemHrid) {
                        sameItem = false;
                    }

                    if (sameItem) {
                        selectedEnhancements.set(lootElement, { parsedData, analysisResult });
                        addBtn.style.background = 'rgba(255,165,0,0.5)';
                        addBtn.style.color = '#fff';
                        // 添加高亮外框
                        lootElement.style.border = '2px solid var(--color-orange-300)';
                        lootElement.style.boxShadow = '0 0 10px rgba(255, 165, 0, 0.5)';
                        lootElement.style.borderRadius = '6px';
                        lootElement.style.padding = '6px';
                    } else {
                        // 直接忽略不同装备的选择，不显示弹窗
                        // 可以在这里添加一个短暂的视觉反馈，比如按钮闪烁
                        addBtn.style.background = 'rgba(255,100,100,0.5)';
                        addBtn.style.color = '#fff';
                        setTimeout(() => {
                            addBtn.style.background = 'rgba(100,100,100,0.5)';
                            addBtn.style.color = '#ccc';
                        }, 500);
                    }
                }
            });
        }

        // ========== 底部配置区域（默认隐藏） ==========
        // 创建显示元素
        const infoSpan = document.createElement('div');
        infoSpan.className = 'enhancement-loot-tracker-info';
        infoSpan.style.cssText = `
            margin-top: 8px;
            padding: 6px 10px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 6px;
            font-size: 12px;
            color: #e0e0e0;
            display: none;
        `;

        // 生成目标等级选项
        let targetOptions = '';
        for (let i = 1; i <= 20; i++) {
            const selected = i === targetLevel ? 'selected' : '';
            targetOptions += `<option value="${i}" ${selected}>+${i}</option>`;
        }

        // 生成保护等级选项
        const autoProtectLabel = isZH ? `自动(+${bestStrategy.protectAt})` : `Auto(+${bestStrategy.protectAt})`;
        let protectOptions = `<option value="auto">${autoProtectLabel}</option>`;
        for (let i = 2; i <= targetLevel; i++) {
            const selected = (config.protectAt !== null && i === protectAt) ? 'selected' : '';
            protectOptions += `<option value="${i}" ${selected}>+${i}</option>`;
        }
        if (config.protectAt === null) {
            protectOptions = protectOptions.replace('value="auto"', 'value="auto" selected');
        }

        infoSpan.innerHTML = `
            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
                <label style="display: flex; align-items: center; gap: 4px;">
                    ${t.target}:
                    <select id="${uniqueId}-target" style="background: rgba(50,50,50,0.8); color: #e0e0e0; border: 1px solid #555; border-radius: 4px; padding: 2px 4px; font-size: 11px;">
                        ${targetOptions}
                    </select>
                </label>
                <label style="display: flex; align-items: center; gap: 4px;">
                    ${t.protectLevel}:
                    <select id="${uniqueId}-protect" style="background: rgba(50,50,50,0.8); color: #e0e0e0; border: 1px solid #555; border-radius: 4px; padding: 2px 4px; font-size: 11px;">
                        ${protectOptions}
                    </select>
                </label>
                <label style="display: flex; align-items: center; gap: 4px;">
                    <input type="checkbox" id="${uniqueId}-success" ${success ? 'checked' : ''} style="margin: 0;">
                    ${t.treatAsSuccess}
                </label>
                <span style="margin-left: 8px; font-size: 11px; color: #888;">
                    ${t.expected}: ${formatNumber(expectedTotalCost)}
                </span>
            </div>
        `;

        // 检查是否已经添加过
        const existingInfo = lootElement.querySelector('.enhancement-loot-tracker-info');
        if (existingInfo) {
            existingInfo.remove();
        }

        // 添加到掉落记录底部
        const dropsContainer = lootElement.querySelector('[class*="LootLogPanel_itemDrops"]');
        if (dropsContainer) {
            dropsContainer.before(infoSpan);
        } else {
            lootElement.prepend(infoSpan);
        }

        // 添加事件监听器
        const targetSelect = infoSpan.querySelector(`#${uniqueId}-target`);
        const protectSelect = infoSpan.querySelector(`#${uniqueId}-protect`);
        const successCheckbox = infoSpan.querySelector(`#${uniqueId}-success`);

        const updateDisplay = (options = {}) => {
            // 记住当前设置面板的显示状态
            const currentPanel = lootElement.querySelector('.enhancement-loot-tracker-info');
            const wasVisible = currentPanel && currentPanel.style.display !== 'none';

            const hasCustomTarget = options.targetChanged ? true : config.hasCustomTarget;
            const hasCustomSuccess = options.successChanged ? true : config.hasCustomSuccess;
            const preferredAnalysis = applyPreferredTarget(analysisResult, getGlobalPreferenceLevels());
            const resolvedTargetLevel = hasCustomTarget ? parseInt(targetSelect.value) : preferredAnalysis.targetLevel;
            const resolvedSuccess = hasCustomSuccess ? successCheckbox.checked : preferredAnalysis.success;

            const newConfig = {
                targetLevel: resolvedTargetLevel,
                success: resolvedSuccess,
                protectAt: protectSelect.value === 'auto' ? null : parseInt(protectSelect.value),
                hasCustomTarget,
                hasCustomSuccess
            };

            // 如果目标等级改变，更新保护等级选项
            if (newConfig.targetLevel !== config.targetLevel) {
                const refreshedBest = findBestProtectLevel(parsedData.itemHrid, newConfig.targetLevel, marketData) || { protectAt: 2 };
                const refreshedAutoLabel = isZH ? `自动(+${refreshedBest.protectAt})` : `Auto(+${refreshedBest.protectAt})`;
                let newProtectOptions = `<option value="auto" selected>${refreshedAutoLabel}</option>`;
                for (let i = 2; i <= newConfig.targetLevel; i++) {
                    newProtectOptions += `<option value="${i}">+${i}</option>`;
                }
                protectSelect.innerHTML = newProtectOptions;
                newConfig.protectAt = null;
            }

            lootConfigs.set(lootElement, newConfig);
            displayEnhancementInfo(lootElement, parsedData, analysisResult, marketData, newConfig);

            // 恢复设置面板的显示状态
            if (wasVisible) {
                const newPanel = lootElement.querySelector('.enhancement-loot-tracker-info');
                if (newPanel) {
                    newPanel.style.display = 'block';
                }
            }
        };

        targetSelect.addEventListener('change', () => updateDisplay({ targetChanged: true }));
        protectSelect.addEventListener('change', () => updateDisplay());
        successCheckbox.addEventListener('change', () => updateDisplay({ successChanged: true }));
        */
    }

    // ======================
    // 主处理函数
    // ======================

    function processLootLogs(options = {}) {
        logCalc('[Better Loot Tracker] processLootLogs 开始执行..');
        const force = !!options.force;

        const marketData = getMarketData();
        if (!marketData) {
            logCalc(`[Better Loot Tracker] ${t.noMarketData}`);
            return;
        }
        logCalc('[Better Loot Tracker] 市场数据已加载');

        const container = getLootLogContainer();
        if (!container) {
            logCalc('[Better Loot Tracker] 没有找到掉落记录容器');
            return;
        }

        setupRefreshButtonHook();

        const lootLogList = container.querySelectorAll(LOOT_LOG_ITEM_SELECTOR);
        logCalc('[Better Loot Tracker] 找到掉落记录数量:', lootLogList.length);

        if (!lootLogList.length) {
            logCalc('[Better Loot Tracker] 没有找到掉落记录元素');
            return;
        }

        let processedCount = 0;
        lootLogList.forEach((lootElement, index) => {
            logCalc(`[Better Loot Tracker] 处理第${index + 1}个掉落记录..`);

            const hasStrictEnhancementTitle = Array.from(lootElement.querySelectorAll('div > span:not(.loot-log-index)'))
                .some((span) => /^(?:强化|Enhancing)\s*[-—–]/i.test(span.textContent.trim()));
            if (!hasStrictEnhancementTitle && lootElement.querySelector('.enhancement-title-info, .enhancement-loot-tracker-info')) {
                lootElement.querySelectorAll('.enhancement-title-info, .enhancement-loot-tracker-info').forEach((node) => node.remove());
                selectedEnhancements.delete(lootElement);
                lootElement.style.border = '';
                lootElement.style.boxShadow = '';
                lootElement.style.borderRadius = '';
                lootElement.style.padding = '';
                delete lootElement.dataset.eltProcessed;
            }

            if (!force && lootElement.dataset.eltProcessed === '1') {
                return;
            }

            // 解析掉落数据
            const parsedData = parseEnhancementLoot(lootElement);
            if (parsedData) {
                logCalc(`[Better Loot Tracker] 第${index + 1}个记录是强化记录:`, parsedData);

                // 分析强化结果
                const analysisResult = analyzeEnhancementResult(parsedData);
                logCalc(`[Better Loot Tracker] 分析结果:`, analysisResult);

                // 显示信息
                displayEnhancementInfo(lootElement, parsedData, analysisResult, marketData);
                lootElement.dataset.eltProcessed = '1';
                processedCount++;
                return;
            }

            const alchemyData = parseAlchemyLoot(lootElement);
            if (alchemyData) {
                logCalc(`[Better Loot Tracker] 第${index + 1}个记录是炼金记录:`, alchemyData);
                displayAlchemyInfo(lootElement, alchemyData, marketData);
                lootElement.dataset.eltProcessed = '1';
                processedCount++;
                return;
            }

            logCalc(`[Better Loot Tracker] 第${index + 1}个记录不是强化或炼金记录`);
        });

        logCalc(`[Better Loot Tracker] 处理完成，共处理${processedCount}个强化记录`);
    }

    // ======================
    // 观察DOM变化
    // ======================

    function setupObserver() {
        let processingTimer = null;
        const scheduleProcess = () => {
            clearTimeout(processingTimer);
            const settleDelay = isRefreshPending() ? REFRESH_SETTLE_DELAY_MS : 200;
            processingTimer = setTimeout(() => {
                processingTimer = null;
                // Keep the refresh window alive. React can make an intermediate DOM
                // update before the server response; the later real list update must
                // still be observed and trigger its own settled recalculation.
                processLootLogs({ force: true });
                if (isRefreshPending()) {
                    refreshStartFingerprint = getLootLogFingerprint();
                }
            }, settleDelay);
        };

        const isTrackerUiNode = (node) => {
            const element = node.nodeType === 1 ? node : node.parentElement;
            return Boolean(element?.closest?.('.enhancement-title-info, .enhancement-loot-tracker-info, .alchemy-title-info, .enhancement-loot-tracker-global-settings-wrapper, .merge-result-popup, .merge-result-overlay'));
        };
        logInit('[Better Loot Tracker] 设置DOM观察器..');

        const observer = new MutationObserver((mutations) => {
            let shouldProcess = false;

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    const addedNodes = [...mutation.addedNodes];
                    const mutationElement = mutation.target.nodeType === 1
                        ? mutation.target
                        : mutation.target.parentElement;

                    // During a user-initiated refresh React may replace only text or
                    // children inside an existing row. Treat that as a real update,
                    // but ignore markup injected by this tracker itself.
                    if (hasRefreshResultRendered() && addedNodes.length > 0 &&
                        !addedNodes.every(isTrackerUiNode) &&
                        mutationElement?.closest?.(LOOT_LOG_LIST_SELECTOR)) {
                        shouldProcess = true;
                        break;
                    }

                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            if (node.matches?.(LOOT_LOG_ITEM_SELECTOR) ||
                                node.querySelector?.(LOOT_LOG_ITEM_SELECTOR) ||
                                node.matches?.(LOOT_LOG_LIST_SELECTOR)) {
                                shouldProcess = true;
                                logCalc('[Better Loot Tracker] 检测到新的掉落记录');
                                break;
                            }
                        }
                    }
                }
                if (shouldProcess) break;
            }

            if (shouldProcess) {
                // A normal React update often adds a new record while selected cards
                // are still in the DOM. Keep that selection; clear only stale nodes.
                if ([...selectedEnhancements.keys()].every((element) => element.isConnected)) {
                    scheduleProcess();
                    return;
                }
                logCalc('[Better Loot Tracker] 延迟处理新的掉落记录...');

                // 清除合并计算的选择缓存
                selectedEnhancements.forEach((data, element) => {
                    const addBtn = element.querySelector('.enhancement-add-to-merge');
                    if (addBtn) {
                        addBtn.style.background = 'rgba(100,100,100,0.5)';
                        addBtn.style.color = '#ccc';
                    }
                    // 移除高亮外框
                    element.style.border = 'none';
                    element.style.boxShadow = 'none';
                    element.style.padding = '';
                });
                selectedEnhancements.clear();

                scheduleProcess();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        logInit('[Better Loot Tracker] DOM观察器已设置');
    }

    // ======================
    // 初始化
    // ======================

    function init() {
        logInit('[Better Loot Tracker] 初始化开始..');
        logInit('[Better Loot Tracker] 当前URL:', window.location.href);
        logInit('[Better Loot Tracker] 用户代理:', navigator.userAgent);

        const cleanup = removeLegacyUnconfirmedSnapshots();
        if (cleanup.removed) {
            console.info(`[Better Loot Tracker] 已清理 ${cleanup.removed} 条旧版未确认的强化中间账本记录`);
        }
        // Retire settings that only belonged to the removed manual merge UI.
        for (const key of [PREFERENCE_LEVELS_KEY, SUPER_ENHANCE_MIN_KEY, ALCHEMY_PRICE_MODE_KEY]) {
            try { localStorage.removeItem(key); } catch (_) {}
        }
        selectedEnhancements.clear();

        // 安装WebSocket hook
        hookWebSocket();

        // 等待initClientData加载
        let checkCount = 0;
        const checkData = setInterval(() => {
            checkCount++;
            const initData = getInitClientData();
            logCalc(`[Better Loot Tracker] 检查数据(${checkCount}/60):`, !!initData, !!initData?.itemDetailMap);

            if (initData?.itemDetailMap) {
                clearInterval(checkData);

                // 初始化itemDetailMap
                itemDetailMap = initData.itemDetailMap;

                logInit('[Better Loot Tracker] InitData loaded, itemDetailMap size:', Object.keys(itemDetailMap).length);
                logInit('[Better Loot Tracker] CharacterItems from WebSocket:', !!characterItems);
                logInit('[Better Loot Tracker] CharacterBuffs from WebSocket:', !!characterBuffs);
                logInit('[Better Loot Tracker] CharacterSkills from WebSocket:', !!characterSkills);

                buildItemMaps();
                setupObserver();

                // 首次处理
                setTimeout(() => {
                    logCalc('[Better Loot Tracker] 开始首次处理掉落记录..');
                    processLootLogs();
                }, 1000);

                // 显示调试信息
                setTimeout(() => {
                    logCalc('[Better Loot Tracker] 显示调试信息...');
                    debugShowAllData();
                }, 2000);

                logInit('[Better Loot Tracker] 初始化完毕..');
            }

            if (checkCount >= 60) {
                clearInterval(checkData);
                logInit('[Better Loot Tracker] 初始化超时，但继续尝试..');

                // 即使超时也尝试安装observer
                setupObserver();

                // The client data can arrive after the initial 30-second wait. Keep a
                // bounded, low-frequency retry so existing loot logs become usable.
                let lateChecks = 0;
                const lateCheck = setInterval(() => {
                    lateChecks += 1;
                    const lateData = getInitClientData();
                    if (lateData?.itemDetailMap) {
                        clearInterval(lateCheck);
                        itemDetailMap = lateData.itemDetailMap;
                        buildItemMaps();
                        processLootLogs({ force: true });
                    } else if (lateChecks >= 300) {
                        clearInterval(lateCheck);
                    }
                }, 1000);
                setTimeout(() => {
                    debugShowAllData();
                }, 1000);
            }
        }, 500);
    }

    // 等待页面加载完成
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
        logInit('[Better Loot Tracker] Waiting for DOMContentLoaded');
    } else {
        logInit('[Better Loot Tracker] DOM already loaded, initializing immediately');
        init();
    }

    // 添加一个全局标识，确认插件已加载
    window.EnhancementLootTrackerLoaded = true;
    logInit('[Better Loot Tracker] Plugin loaded successfully');

    // 添加全局测试函数
    window.testEnhancementLootTracker = function() {
        logCalc('[Better Loot Tracker] 手动测试开始..');
        debugShowAllData();
        processLootLogs({ force: true });
    };

})();



