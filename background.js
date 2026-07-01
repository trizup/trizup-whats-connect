importScripts("vendor/wa-store-migrate.bundle.js");

const IMPORT_CHUNK_ITEMS = 1000;
const IMPORT_HISTORY_CHAT_LIMIT = Number.POSITIVE_INFINITY;
const CLIENT_BASE_DOMAIN = "uazapi.com";
const WHATSAPP_WEB_URL_PREFIX = "https://web.whatsapp.com/";
const runningImports = new Set();

async function executeScriptInPage(tabId, func, args = []) {
  try {
    return await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func,
      args
    });
  } catch (error) {
    if (!String((error && error.message) || "").includes("world")) {
      throw error;
    }
    return await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args
    });
  }
}

async function extractInventoryFromTab(tabId) {
  const [result] = await executeScriptInPage(tabId, extractWhatsAppWebStorageInventory);
  if (!result || !result.result) {
    throw new Error("Não foi possível diagnosticar o armazenamento");
  }
  if (result.result.error) {
    throw new Error(result.result.error);
  }
  return result.result.inventory;
}

async function extractSidecarFromTab(tabId) {
  const [result] = await executeScriptInPage(tabId, extractWhatsAppWebSidecarDump);
  if (!result || !result.result) {
    throw new Error("Não foi possível capturar o histórico");
  }
  if (result.result.error) {
    throw new Error(result.result.error);
  }
  return result.result.dump;
}

async function extractMainDumpFromTab(tabId, options = {}) {
  const [result] = await executeScriptInPage(tabId, extractWhatsAppWebMainDump, [options]);
  if (!result || !result.result) {
    throw new Error("Não foi possível capturar a sessão");
  }
  if (result.result.error) {
    throw new Error(result.result.error);
  }
  if (options.includeDump && result.result.dump && result.result.dump.dump) {
    return result.result.dump.dump;
  }
  return result.result.dump;
}

function normalizeClientHost(value) {
  const host = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+|\.+$/g, "");
  if (!host) {
    return "";
  }
  if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?$/.test(host)) {
    throw new Error("Cliente invalido. Use apenas o nome do cliente ou uma URL completa.");
  }
  return host;
}

function isLocalHost(host) {
  return host === "localhost" || host.startsWith("localhost:") || host.startsWith("127.");
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) {
    return "";
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  const host = normalizeClientHost(raw);
  if (!host) {
    return "";
  }
  if (isLocalHost(host)) {
    return `http://${host}`;
  }
  if (host.includes(".")) {
    return `https://${host}`;
  }
  return `https://${host}.${CLIENT_BASE_DOMAIN}`;
}

function importPayloadForOptions(payload, options = {}) {
  if (options.includeHistory !== false) {
    return payload;
  }
  const copy = { ...payload };
  delete copy.history;
  return copy;
}

function countRows(value) {
  return Array.isArray(value) ? value.length : 0;
}

function appStateCollectionVersionKey(value) {
  const collection = String(value?.collection || "").trim();
  const version = Number(value?.version || 0);
  if (!collection || !Number.isFinite(version) || version <= 0) {
    return "";
  }
  return `${collection}\u0000${Math.floor(version)}`;
}

function countAppStateMutationMacsWithVersions(payload) {
  const versionKeys = new Set(
    (Array.isArray(payload?.appStateVersions) ? payload.appStateVersions : [])
      .map(appStateCollectionVersionKey)
      .filter(Boolean)
  );
  if (versionKeys.size === 0) {
    return 0;
  }
  return (Array.isArray(payload?.appStateMutationMacs) ? payload.appStateMutationMacs : [])
    .filter((mac) => versionKeys.has(appStateCollectionVersionKey(mac))).length;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function mergeByKey(existing, incoming, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const key = keyFn(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeHistoryTimestampMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return numeric < 100000000000 ? Math.floor(numeric * 1000) : Math.floor(numeric);
}

function limitHistoryAnchors(history, limit = IMPORT_HISTORY_CHAT_LIMIT) {
  if (!history || typeof history !== "object") {
    return history;
  }
  const rawChats = Array.isArray(history.chats) ? history.chats : [];
  const rawMessages = Array.isArray(history.messages) ? history.messages : [];
  const latestMessageByChat = new Map();
  const messagesByChat = new Map();
  const seenMessages = new Set();

  for (const message of rawMessages) {
    const chatJid = String(message?.chatJid || "").trim();
    const id = String(message?.id || "").trim();
    if (!chatJid || !id) {
      continue;
    }
    const messageKey = `${chatJid}\u0000${id}`;
    if (seenMessages.has(messageKey)) {
      continue;
    }
    seenMessages.add(messageKey);
    const normalized = { ...message, id, chatJid, timestampMs: normalizeHistoryTimestampMs(message.timestampMs) };
    if (!messagesByChat.has(chatJid)) {
      messagesByChat.set(chatJid, []);
    }
    messagesByChat.get(chatJid).push(normalized);
    const existing = latestMessageByChat.get(chatJid);
    if (!existing || normalized.timestampMs > normalizeHistoryTimestampMs(existing.timestampMs)) {
      latestMessageByChat.set(chatJid, normalized);
    }
  }

  const chatByJid = new Map();
  for (const chat of rawChats) {
    const jid = String(chat?.jid || "").trim();
    if (!jid) {
      continue;
    }
    const normalized = {
      ...chat,
      jid,
      lid: String(chat?.lid || "").trim(),
      lastMessageTimestampMs: normalizeHistoryTimestampMs(chat.lastMessageTimestampMs)
    };
    const existing = chatByJid.get(jid);
    if (!existing || normalized.lastMessageTimestampMs > normalizeHistoryTimestampMs(existing.lastMessageTimestampMs)) {
      chatByJid.set(jid, normalized);
    }
  }

  for (const message of latestMessageByChat.values()) {
    if (!chatByJid.has(message.chatJid)) {
      chatByJid.set(message.chatJid, {
        jid: message.chatJid,
        isGroup: message.chatJid.endsWith("@g.us"),
        lastMessageTimestampMs: normalizeHistoryTimestampMs(message.timestampMs)
      });
    }
  }

  const chats = Array.from(chatByJid.values());
  chats.sort((left, right) => {
    const leftMessage = latestMessageByChat.get(left.jid) || latestMessageByChat.get(left.lid);
    const rightMessage = latestMessageByChat.get(right.jid) || latestMessageByChat.get(right.lid);
    const leftTimestamp = Math.max(
      normalizeHistoryTimestampMs(left.lastMessageTimestampMs),
      normalizeHistoryTimestampMs(leftMessage?.timestampMs)
    );
    const rightTimestamp = Math.max(
      normalizeHistoryTimestampMs(right.lastMessageTimestampMs),
      normalizeHistoryTimestampMs(rightMessage?.timestampMs)
    );
    return rightTimestamp - leftTimestamp;
  });

  const selectedChats = chats.slice(0, Math.max(0, limit));
  const selectedMessages = [];
  const selectedMessageKeys = new Set();
  for (const chat of selectedChats) {
    for (const chatKey of [chat.jid, chat.lid].filter(Boolean)) {
      for (const message of messagesByChat.get(chatKey) || []) {
        const messageKey = `${message.chatJid}\u0000${message.id}`;
        if (!selectedMessageKeys.has(messageKey)) {
          selectedMessageKeys.add(messageKey);
          selectedMessages.push(message);
        }
      }
    }
  }
  selectedMessages.sort((left, right) => normalizeHistoryTimestampMs(right.timestampMs) - normalizeHistoryTimestampMs(left.timestampMs));

  return { chats: selectedChats, messages: selectedMessages };
}

function bytesToBase64Browser(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (value instanceof Uint8Array) {
    let binary = "";
    const step = 0x8000;
    for (let index = 0; index < value.length; index += step) {
      binary += String.fromCharCode.apply(null, value.subarray(index, index + step));
    }
    return btoa(binary);
  }
  if (Array.isArray(value)) {
    return bytesToBase64Browser(new Uint8Array(value));
  }
  if (value && value.type === "Buffer") {
    if (typeof value.data === "string") {
      return value.data.trim();
    }
    if (Array.isArray(value.data)) {
      return bytesToBase64Browser(new Uint8Array(value.data));
    }
  }
  return "";
}

function normalizeContactForWhatsmeow(row) {
  const jid = String(row?.jid || row?.phoneNumber || row?.id || "").trim();
  if (!jid) {
    return null;
  }
  return {
    jid,
    ...(row.firstName ? { firstName: String(row.firstName).trim() } : {}),
    ...((row.fullName || row.displayName || row.name) ? { fullName: String(row.fullName || row.displayName || row.name).trim() } : {}),
    ...((row.pushName || row.pushname) ? { pushName: String(row.pushName || row.pushname).trim() } : {}),
    ...((row.businessName || row.verifiedName) ? { businessName: String(row.businessName || row.verifiedName).trim() } : {}),
    ...(row.redactedPhone ? { redactedPhone: String(row.redactedPhone).trim() } : {})
  };
}

function normalizePrivacyTokenForWhatsmeow(row) {
  const userJid = String(row?.userJid || row?.jid || "").trim();
  const token = bytesToBase64Browser(row?.token);
  const timestampS = Number.isFinite(row?.timestampS)
    ? Math.floor(row.timestampS)
    : Math.floor(Number(row?.timestampMs || 0) / 1000);
  if (!userJid || !token || !timestampS) {
    return null;
  }
  const senderTimestampS = Number.isFinite(row?.senderTimestampS)
    ? Math.floor(row.senderTimestampS)
    : Number.isFinite(row?.senderTimestampMs)
      ? Math.floor(row.senderTimestampMs / 1000)
      : undefined;
  return {
    userJid,
    token,
    timestampS,
    ...(senderTimestampS ? { senderTimestampS } : {})
  };
}

function normalizeMessageSecretForWhatsmeow(row) {
  const chatJid = String(row?.chatJid || row?.senderJid || "").trim();
  const senderJid = String(row?.senderJid || "").trim();
  const messageId = String(row?.messageId || "").trim();
  const key = bytesToBase64Browser(row?.key || row?.secret);
  if (!chatJid || !senderJid || !messageId || !key) {
    return null;
  }
  return { chatJid, senderJid, messageId, key };
}

function normalizeRows(source, key, mapper) {
  const rows = Array.isArray(source?.[key]) ? source[key] : [];
  return rows.map(mapper).filter(Boolean);
}

function attachSidecarPayload(whatsmeowPayload, sidecar, waWebDump) {
  const output = { ...whatsmeowPayload };
  const sources = [sidecar, waWebDump].filter(Boolean);

  const baseContacts = normalizeRows(output, "contacts", normalizeContactForWhatsmeow);
  const contacts = sources.flatMap((source) => normalizeRows(source, "contacts", normalizeContactForWhatsmeow));
  if (baseContacts.length > 0 || contacts.length > 0) {
    output.contacts = mergeByKey(baseContacts, contacts, (item) => item.jid);
  }

  const basePrivacyTokens = normalizeRows(output, "privacyTokens", normalizePrivacyTokenForWhatsmeow);
  const privacyTokens = sources.flatMap((source) => normalizeRows(source, "privacyTokens", normalizePrivacyTokenForWhatsmeow));
  if (basePrivacyTokens.length > 0 || privacyTokens.length > 0) {
    output.privacyTokens = mergeByKey(basePrivacyTokens, privacyTokens, (item) => item.userJid);
  }

  const baseMessageSecrets = normalizeRows(output, "messageSecrets", normalizeMessageSecretForWhatsmeow);
  const messageSecrets = sources.flatMap((source) => normalizeRows(source, "messageSecrets", normalizeMessageSecretForWhatsmeow));
  if (baseMessageSecrets.length > 0 || messageSecrets.length > 0) {
    output.messageSecrets = mergeByKey(baseMessageSecrets, messageSecrets, (item) => `${item.chatJid}\u0000${item.senderJid}\u0000${item.messageId}`);
  }

  const history = firstDefined(...sources.map((source) => source.history));
  if (history && typeof history === "object") {
    output.history = limitHistoryAnchors(history);
  }

  const nctSalt = firstDefined(...sources.map((source) => source.nctSalt));
  if (typeof nctSalt === "string" && nctSalt.trim()) {
    output.nctSalt = nctSalt.trim();
  }
  delete output.deviceLists;
  delete output.lidMappings;
  return output;
}

function buildWhatsmeowPayload(mainDump, sidecar) {
  if (!globalThis.WAStoreMigrate) {
    throw new Error("Conversor wa-store-migrate não carregado");
  }
  const waWebDump = WAStoreMigrate.coerceBufferJson(mainDump);
  const migrated = WAStoreMigrate.migrate({
    from: "wa-web",
    to: "whatsmeow",
    data: waWebDump,
    validate: false
  });
  return {
    payload: attachSidecarPayload(WAStoreMigrate.snapshot.toJSON("whatsmeow", migrated.snapshot), sidecar, waWebDump),
    losses: migrated.losses
  };
}

function countExpectedRows(payload) {
  return {
    preKeys: countRows(payload.preKeys),
    identityKeys: countRows(payload.identities),
    sessions: countRows(payload.sessions),
    senderKeys: countRows(payload.senderKeys),
    appStateSyncKeys: countRows(payload.appStateSyncKeys),
    appStateVersions: countRows(payload.appStateVersions),
    appStateMutationMACs: countAppStateMutationMacsWithVersions(payload),
    contacts: countRows(payload.contacts),
    privacyTokens: countRows(payload.privacyTokens),
    messageSecrets: countRows(payload.messageSecrets),
    nctSalt: payload.nctSalt ? 1 : 0,
    validatedHistoryChats: countRows(payload.history?.chats),
    validatedHistoryMessages: countRows(payload.history?.messages)
  };
}

function pushArrayChunks(chunks, section, key, rows, limit = IMPORT_CHUNK_ITEMS) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }
  for (let index = 0; index < rows.length; index += limit) {
    const slice = rows.slice(index, index + limit);
    chunks.push({ section, count: slice.length, payload: { [key]: slice } });
  }
}

function pushHistoryChunks(chunks, section, key, rows, limit = IMPORT_CHUNK_ITEMS) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }
  for (let index = 0; index < rows.length; index += limit) {
    const slice = rows.slice(index, index + limit);
    chunks.push({ section, count: slice.length, payload: { history: { [key]: slice } } });
  }
}

function buildAppStateChunks(payload) {
  const versions = Array.isArray(payload.appStateVersions) ? payload.appStateVersions : [];
  const macs = Array.isArray(payload.appStateMutationMacs) ? payload.appStateMutationMacs : [];
  if (versions.length === 0 && macs.length === 0) {
    return [];
  }
  const macsByVersion = new Map();
  for (const mac of macs) {
    const key = appStateCollectionVersionKey(mac);
    if (!key) {
      continue;
    }
    if (!macsByVersion.has(key)) {
      macsByVersion.set(key, []);
    }
    macsByVersion.get(key).push(mac);
  }
  if (versions.length === 0) {
    return [];
  }
  return versions.map((version) => {
    const key = appStateCollectionVersionKey(version);
    const versionMacs = macsByVersion.get(key) || [];
    return {
      section: "appState",
      count: 1 + versionMacs.length,
      payload: { appStateVersions: [version], appStateMutationMacs: versionMacs }
    };
  });
}

function buildImportChunks(payload) {
  const chunks = [];
  pushArrayChunks(chunks, "sessions", "sessions", payload.sessions);
  pushArrayChunks(chunks, "identities", "identities", payload.identities);
  pushArrayChunks(chunks, "senderKeys", "senderKeys", payload.senderKeys);
  pushArrayChunks(chunks, "preKeys", "preKeys", payload.preKeys);
  pushArrayChunks(chunks, "appStateSyncKeys", "appStateSyncKeys", payload.appStateSyncKeys);
  chunks.push(...buildAppStateChunks(payload));
  pushArrayChunks(chunks, "contacts", "contacts", payload.contacts);
  pushArrayChunks(chunks, "privacyTokens", "privacyTokens", payload.privacyTokens);
  pushArrayChunks(chunks, "messageSecrets", "messageSecrets", payload.messageSecrets);
  if (payload.nctSalt) {
    chunks.push({ section: "nctSalt", count: 1, payload: { nctSalt: payload.nctSalt } });
  }
  pushHistoryChunks(chunks, "historyChats", "chats", payload.history?.chats);
  pushHistoryChunks(chunks, "historyMessages", "messages", payload.history?.messages);
  return chunks;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encodeRequestBody(json) {
  if (!("CompressionStream" in globalThis)) {
    return { body: json, encoding: "" };
  }
  const stream = new Blob([json], { type: "application/json" }).stream().pipeThrough(new CompressionStream("gzip"));
  return { body: await new Response(stream).arrayBuffer(), encoding: "gzip" };
}

async function postJSON(url, token, payload, failureLabel) {
  const json = JSON.stringify(payload);
  const encoded = await encodeRequestBody(json);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    token
  };
  if (encoded.encoding) {
    headers["Content-Encoding"] = encoded.encoding;
  }
  const response = await fetch(url, { method: "POST", headers, body: encoded.body });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const reason = body.error || body.message || text || `HTTP ${response.status}`;
    throw new Error(`${failureLabel}: ${reason}`);
  }
  return body;
}

async function postJSONWithRetry(url, token, payload, failureLabel) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await postJSON(url, token, payload, failureLabel);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function getJSON(url, token, failureLabel) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      token
    }
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const reason = body.error || body.message || text || `HTTP ${response.status}`;
    throw new Error(`${failureLabel}: ${reason}`);
  }
  return body;
}

async function verifyInstanceForImport(serverUrl, token) {
  const payload = await getJSON(`${normalizeBaseUrl(serverUrl)}/instance/status`, token, "Falha ao validar instância");
  const status = payload.status || {};
  const instanceStatus = String(payload.instance?.status || "").trim().toLowerCase();
  const importableStatuses = new Set(["disconnected", "importing"]);
  if (status.connected || status.loggedIn || (instanceStatus && !importableStatuses.has(instanceStatus))) {
    throw new Error(`A instância precisa estar desconectada antes da importação (status atual: ${instanceStatus || "ativa"})`);
  }
  return payload;
}

async function uploadWhatsmeowPayload(serverUrl, token, payload, options = {}) {
  const base = `${normalizeBaseUrl(serverUrl)}/instance/import-web-session`;
  const start = await postJSONWithRetry(
    `${base}/start`,
    token,
    {
      device: payload.device,
      expected: countExpectedRows(payload)
    },
    "Falha ao iniciar importação"
  );
  const jobId = start.jobId || start.job_id;
  if (!jobId) {
    throw new Error("API não retornou jobId");
  }
  const chunks = buildImportChunks(payload);
  for (let seq = 0; seq < chunks.length; seq += 1) {
    const chunk = chunks[seq];
    const chunkPayloadJSON = JSON.stringify(chunk.payload);
    await postJSONWithRetry(
      `${base}/chunk`,
      token,
      {
        jobId,
        section: chunk.section,
        seq,
        count: chunk.count,
        sha256: await sha256Hex(chunkPayloadJSON),
        payload: chunk.payload
      },
      `Falha ao enviar chunk ${seq + 1}/${chunks.length}`
    );
    options.onProgress?.(seq + 1, chunks.length, chunk.section);
  }
  return postJSONWithRetry(`${base}/finish`, token, { jobId }, "Falha ao finalizar importação");
}

async function connectImportedInstance(serverUrl, token) {
  return postJSONWithRetry(
    `${normalizeBaseUrl(serverUrl)}/instance/connect`,
    token,
    {},
    "Falha ao conectar instância importada"
  );
}

async function clearWhatsAppWebLocalSessionFromTab(tab) {
  if (!tab || !tab.id) {
    throw new Error("Aba do WhatsApp Web indisponível para limpeza local");
  }
  const [result] = await executeScriptInPage(tab.id, clearWhatsAppWebLocalSessionData);
  if (!result || !result.result) {
    throw new Error("Não foi possível limpar os dados locais do WhatsApp Web");
  }
  if (result.result.error) {
    throw new Error(result.result.error);
  }
  await chrome.tabs.reload(tab.id, { bypassCache: true });
  return result.result.summary || { method: "page" };
}

function clearWhatsAppWebLocalSessionData() {
  function deleteDatabase(name) {
    return new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve({ name, deleted: true });
      request.onerror = () => resolve({ name, deleted: false, error: request.error ? request.error.message : "delete failed" });
      request.onblocked = () => resolve({ name, deleted: false, blocked: true });
    });
  }

  async function run() {
    const localStorageKeys = Object.keys(localStorage || {});
    const sessionStorageKeys = Object.keys(sessionStorage || {});
    localStorage.clear();
    sessionStorage.clear();

    let databaseNames = [];
    if (indexedDB.databases) {
      const databases = await indexedDB.databases();
      databaseNames = databases.map((database) => database && database.name).filter(Boolean);
    }
    for (const name of ["signal-storage", "model-storage", "wawc_db_enc"]) {
      if (!databaseNames.includes(name)) {
        databaseNames.push(name);
      }
    }
    const deletedDatabases = await Promise.all(databaseNames.map(deleteDatabase));

    let deletedCaches = [];
    if ("caches" in globalThis) {
      const cacheNames = await caches.keys();
      deletedCaches = await Promise.all(cacheNames.map(async (name) => ({ name, deleted: await caches.delete(name) })));
    }

    return {
      method: "page",
      localStorageKeys: localStorageKeys.length,
      sessionStorageKeys: sessionStorageKeys.length,
      indexedDB: deletedDatabases,
      caches: deletedCaches
    };
  }

  return run()
    .then((summary) => ({ summary }))
    .catch((error) => ({ error: error.message || "Falha ao limpar dados locais" }));
}

function extractWhatsAppWebSidecarDump() {
  const LIMITS = {
    contacts: 15000,
    chats: Number.POSITIVE_INFINITY,
    messages: 50000,
    messageScan: 250000,
    historyChats: Number.POSITIVE_INFINITY
  };

  function openDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(`Falha ao abrir ${name}`));
      request.onblocked = () => reject(new Error(`Abertura bloqueada: ${name}`));
    });
  }

  async function readStore(dbName, storeName, limit, direction = "next") {
    const db = await openDatabase(dbName);
    try {
      if (!Array.from(db.objectStoreNames || []).includes(storeName)) {
        return [];
      }
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const rows = [];
      await new Promise((resolve, reject) => {
        const request = store.openCursor(null, direction);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || rows.length >= limit) {
            resolve();
            return;
          }
          rows.push(cursor.value);
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error(`Falha ao ler ${storeName}`));
      });
      return rows;
    } finally {
      db.close();
    }
  }

  function getWaModule(name) {
    try {
      if (typeof require === "function") {
        return require(name);
      }
    } catch {}
    try {
      if (typeof __d === "function") {
        let captured;
        const sentinel = `__waSidecarProbe_${Math.random().toString(36).slice(2)}`;
        __d(sentinel, [name], function (_target, _namespace, _require, moduleRequire) {
          captured = moduleRequire(name);
        });
        if (!captured && typeof __d.require === "function") {
          captured = __d.require(name);
        }
        if (captured) {
          return captured;
        }
      }
    } catch {}
    return null;
  }

  function normalizeWhatsAppUserJID(value) {
    const trimmed = String(value || "").trim();
    const at = trimmed.lastIndexOf("@");
    if (at < 0) {
      return trimmed;
    }
    const server = trimmed.slice(at + 1);
    if (server === "c.us") {
      return `${trimmed.slice(0, at)}@s.whatsapp.net`;
    }
    return trimmed;
  }

  function jidToString(value) {
    if (!value) {
      return "";
    }
    if (typeof value === "string") {
      return normalizeWhatsAppUserJID(value);
    }
    if (typeof value === "object") {
      if (typeof value._serialized === "string") {
        return normalizeWhatsAppUserJID(value._serialized);
      }
      if (typeof value.user === "string" && typeof value.server === "string") {
        return normalizeWhatsAppUserJID(`${value.user}@${value.server}`);
      }
      if (typeof value.toString === "function" && value.toString !== Object.prototype.toString) {
        const serialized = value.toString();
        if (typeof serialized === "string" && serialized.includes("@")) {
          return normalizeWhatsAppUserJID(serialized);
        }
      }
    }
    return "";
  }

  function text(value) {
    if (typeof value === "string") {
      return value.trim();
    }
    return "";
  }

  function timestampMs(value) {
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }
    return value < 100000000000 ? Math.floor(value * 1000) : Math.floor(value);
  }

  function messageIDToString(value) {
    if (!value) {
      return "";
    }
    if (typeof value === "object") {
      const nestedID = text(value.id);
      if (nestedID) {
        return nestedID;
      }
      const serialized = text(value._serialized);
      if (serialized) {
        return messageIDToString(serialized);
      }
    }
    if (typeof value !== "string") {
      return "";
    }
    const trimmed = value.trim();
    const parts = trimmed.split("_");
    if ((parts[0] === "true" || parts[0] === "false") && parts.length >= 3) {
      return parts[2];
    }
    return trimmed;
  }

  function messageChatJIDFromID(value) {
    if (!value) {
      return "";
    }
    if (typeof value === "object") {
      const remote = jidToString(value.remote);
      if (remote) {
        return remote;
      }
      const serialized = text(value._serialized);
      if (serialized) {
        return messageChatJIDFromID(serialized);
      }
    }
    if (typeof value !== "string") {
      return "";
    }
    const parts = value.trim().split("_");
    if ((parts[0] === "true" || parts[0] === "false") && parts.length >= 3) {
      return jidToString(parts[1]);
    }
    return "";
  }

  function bytesToUint8Array(value) {
    if (!value) {
      return null;
    }
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value)) {
      return new Uint8Array(value);
    }
    return null;
  }

  function bytesToBase64(value) {
    const bytes = bytesToUint8Array(value);
    if (!bytes || bytes.length === 0) {
      return "";
    }
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== 0 && item !== undefined && item !== null));
  }

  function firstDefined(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
    return undefined;
  }

  function firstText(...values) {
    for (const value of values) {
      const trimmed = text(value);
      if (trimmed) {
        return trimmed;
      }
    }
    return "";
  }

  function primitiveContentValue(value) {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    if (typeof value === "string") {
      return value.trim() || undefined;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Array.isArray(value)) {
      return bytesToBase64(value) || undefined;
    }
    if (typeof value === "object" && typeof value.toNumber === "function") {
      const numeric = value.toNumber();
      return Number.isFinite(numeric) ? numeric : undefined;
    }
    return undefined;
  }

  function firstContentValue(...values) {
    for (const value of values) {
      const normalized = primitiveContentValue(value);
      if (normalized !== undefined && normalized !== "") {
        return normalized;
      }
    }
    return undefined;
  }

  const MESSAGE_TEXT_FIELDS = new Set([
    "body",
    "caption",
    "clienturl",
    "content",
    "contenttext",
    "conversation",
    "description",
    "eventdescription",
    "eventname",
    "footertext",
    "hydratedcontenttext",
    "hydratedfootertext",
    "hydratedtitletext",
    "loc",
    "matchedtext",
    "messagetext",
    "name",
    "paymentnotemsgbody",
    "pollname",
    "quarantineextractedtext",
    "selecteddisplaytext",
    "text",
    "title"
  ]);
  const MESSAGE_NESTED_FIELDS = [
    "message",
    "_message",
    "msg",
    "msgOpaqueData",
    "opaqueData",
    "plainText",
    "plaintext",
    "payload",
    "data",
    "extendedTextMessage",
    "imageMessage",
    "videoMessage",
    "documentMessage",
    "audioMessage",
    "stickerMessage",
    "buttonsMessage",
    "listMessage",
    "pollCreationMessage",
    "pollCreationMessageV2",
    "pollCreationMessageV3",
    "pollCreationMessageV4",
    "pollCreationMessageV5",
    "pollCreationMessageV6",
    "eventMessage",
    "locationMessage",
    "liveLocationMessage",
    "contactMessage",
    "contactsArrayMessage",
    "productMessage",
    "orderMessage",
    "templateMessage",
    "interactiveMessage",
    "interactiveResponseMessage"
  ];
  const MESSAGE_TEXT_EXCLUDED_FIELDS = new Set([
    "contextInfo",
    "quotedMessage",
    "quotedMsg",
    "quotedPaymentInfo",
    "quotedStickerData",
    "statusQuotedMessage"
  ]);

  function normalizedFieldName(key) {
    return String(key || "")
      .replace(/^__x_/, "")
      .replace(/^_+/, "")
      .toLowerCase();
  }

  function isMessageTextFieldName(key) {
    const normalized = normalizedFieldName(key);
    if (MESSAGE_TEXT_FIELDS.has(normalized)) {
      return true;
    }
    if (normalized.includes("context")) {
      return false;
    }
    return normalized.endsWith("text") ||
      normalized.endsWith("body") ||
      normalized.endsWith("caption") ||
      normalized.endsWith("description");
  }

  function safeGetField(value, key) {
    try {
      return value && value[key];
    } catch {
      return undefined;
    }
  }

  function objectFieldNames(value) {
    if (!value || typeof value !== "object") {
      return [];
    }
    const names = new Set(Object.keys(value));
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name !== "constructor") {
          names.add(name);
        }
      }
    }
    return Array.from(names).filter((name) => !MESSAGE_TEXT_EXCLUDED_FIELDS.has(name));
  }

  function serializedObjectView(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    for (const method of ["toJSON", "toObject"]) {
      if (typeof value[method] !== "function") {
        continue;
      }
      try {
        const converted = value[method]();
        if (converted && converted !== value && typeof converted === "object") {
          return converted;
        }
      } catch {}
    }
    return null;
  }

  function textFromKnownFields(value, depth = 0, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || depth > 6 || bytesToUint8Array(value)) {
      return "";
    }
    if (seen.has(value)) {
      return "";
    }
    seen.add(value);

    const converted = serializedObjectView(value);
    if (converted) {
      const convertedText = textFromKnownFields(converted, depth + 1, seen);
      if (convertedText) {
        return convertedText;
      }
    }

    const names = objectFieldNames(value);
    for (const key of names) {
      if (!isMessageTextFieldName(key)) {
        continue;
      }
      const fieldValue = safeGetField(value, key);
      const fieldText = text(fieldValue);
      if (fieldText) {
        return fieldText;
      }
      const nestedText = textFromKnownFields(fieldValue, depth + 1, seen);
      if (nestedText) {
        return nestedText;
      }
    }

    for (const key of MESSAGE_NESTED_FIELDS) {
      const nested = safeGetField(value, key);
      const nestedText = textFromKnownFields(nested, depth + 1, seen);
      if (nestedText) {
        return nestedText;
      }
    }

    return "";
  }

  function isLID(jid) {
    return typeof jid === "string" && jid.endsWith("@lid");
  }

  function isPN(jid) {
    return typeof jid === "string" && (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@c.us"));
  }

  function pnFromContact(row) {
    const phone = jidToString(row.phoneNumber);
    if (phone) {
      return phone;
    }
    const id = jidToString(row.id);
    return isPN(id) ? id : "";
  }

  function mapContact(row) {
    const id = jidToString(row.id);
    const pn = pnFromContact(row);
    const lid = isLID(id) ? id : jidToString(row.lid);
    const jid = pn || id || lid;
    if (!jid && !lid) {
      return null;
    }
    return compactObject({
      jid,
      lid,
      fullName: text(row.name || row.displayName),
      pushName: text(row.pushname || row.pushName),
      businessName: text(row.verifiedName || row.businessName),
      phoneNumber: pn
    });
  }

  function mapChat(row) {
    const jid = jidToString(row.id);
    if (!jid) {
      return null;
    }
    return compactObject({
      jid,
      lid: jidToString(row.accountLid),
      name: text(row.name || row.formattedTitle),
      isGroup: jid.endsWith("@g.us"),
      archived: Boolean(row.archive),
      pinned: Boolean(row.pin),
      mutedUntilMs: timestampMs(row.muteExpiration),
      lastMessageTimestampMs: timestampMs(row.t)
    });
  }

  function mapPrivacyToken(row) {
    const token = row.tcToken || row.token;
    const tokenBytes = token && typeof token === "object" && "_data" in token ? token._data : token;
    const encoded = bytesToBase64(tokenBytes);
    if (!encoded) {
      return null;
    }
    const userJid = jidToString(row.accountLid || row.id || row.userJid);
    if (!userJid) {
      return null;
    }
    const tokenTimestampMS = timestampMs(row.tcTokenTimestamp || row.timestampMs || row.timestamp);
    return compactObject({
      userJid,
      token: encoded,
      timestampS: Math.floor(tokenTimestampMS / 1000),
      senderTimestampS: row.tcTokenSenderTimestamp ? Math.floor(timestampMs(row.tcTokenSenderTimestamp) / 1000) : undefined
    });
  }

  function deserializeMessageRow(row, serializer) {
    const fromRow = serializer && serializer.messageFromDbRow;
    if (typeof fromRow !== "function") {
      return null;
    }
    try {
      const message = fromRow(row);
      if (message && message.msgRowOpaqueData && typeof serializer.movFieldFromOpaqueDataBackToMsg === "function") {
        try {
          serializer.movFieldFromOpaqueDataBackToMsg(message);
        } catch {}
      }
      return message;
    } catch {
      return null;
    }
  }

  function serializedMessageKey(message) {
    if (!message || typeof message !== "object") {
      return {};
    }
    return message.key || message.id || message.msgKey || {};
  }

  function unwrapMessagePayload(value) {
    if (!value || typeof value !== "object") {
      return value;
    }
    const wrappers = [
      "ephemeralMessage",
      "viewOnceMessage",
      "viewOnceMessageV2",
      "viewOnceMessageV2Extension",
      "documentWithCaptionMessage",
      "editedMessage"
    ];
    for (const key of wrappers) {
      const nested = value[key];
      if (nested && typeof nested === "object") {
        if (nested.message) {
          return unwrapMessagePayload(nested.message);
        }
        return unwrapMessagePayload(nested);
      }
    }
    if (value.protocolMessage && value.protocolMessage.editedMessage) {
      return unwrapMessagePayload(value.protocolMessage.editedMessage);
    }
    return value;
  }

  function textFromMessagePayload(value, depth = 0) {
    if (!value || depth > 5) {
      return "";
    }
    const direct = text(value);
    if (direct) {
      return direct;
    }
    if (typeof value !== "object") {
      return "";
    }

    const payload = unwrapMessagePayload(value);
    if (payload !== value) {
      const nestedText = textFromMessagePayload(payload, depth + 1);
      if (nestedText) {
        return nestedText;
      }
    }

    const knownText = firstText(
      payload.conversation,
      payload.text,
      payload.caption,
      payload.body,
      payload.content,
      payload.contentText,
      payload.footerText,
      payload.title,
      payload.description,
      payload.name,
      payload.selectedDisplayText
    );
    if (knownText) {
      return knownText;
    }

    const knownFieldText = textFromKnownFields(payload);
    if (knownFieldText) {
      return knownFieldText;
    }

    const nestedCandidates = [
      payload.extendedTextMessage,
      payload.imageMessage,
      payload.videoMessage,
      payload.documentMessage,
      payload.audioMessage,
      payload.stickerMessage,
      payload.buttonsMessage,
      payload.listMessage,
      payload.pollCreationMessage,
      payload.pollCreationMessageV2,
      payload.pollCreationMessageV3,
      payload.eventMessage,
      payload.locationMessage,
      payload.liveLocationMessage,
      payload.contactMessage,
      payload.contactsArrayMessage,
      payload.productMessage,
      payload.orderMessage,
      payload.templateMessage && payload.templateMessage.hydratedTemplate,
      payload.templateMessage && payload.templateMessage.hydratedFourRowTemplate,
      payload.templateMessage && payload.templateMessage.fourRowTemplate,
      payload.interactiveMessage,
      payload.interactiveMessage && payload.interactiveMessage.body,
      payload.interactiveMessage && payload.interactiveMessage.footer,
      payload.interactiveMessage && payload.interactiveMessage.header
    ];
    for (const candidate of nestedCandidates) {
      const nestedText = textFromMessagePayload(candidate, depth + 1);
      if (nestedText) {
        return nestedText;
      }
    }

    return "";
  }

  function textFromSerializedMessage(message) {
    if (!message || typeof message !== "object") {
      return "";
    }
    return firstText(message.body, message.caption, message.text, message.messageText) ||
      textFromMessagePayload(message.message || message.msg || message._message) ||
      textFromMessagePayload(message.msgOpaqueData || message.opaqueData || message.data || message.payload) ||
      textFromKnownFields(message);
  }

  function messageGetterValue(getters, name, message) {
    const getter = getters && getters[name];
    if (typeof getter !== "function" || !message) {
      return undefined;
    }
    try {
      return getter(message);
    } catch {
      return undefined;
    }
  }

  function messageGetterText(getters, message, names) {
    for (const name of names) {
      const value = messageGetterValue(getters, name, message);
      const candidate = text(value);
      if (candidate) {
        return candidate;
      }
    }
    return "";
  }

  function messageAnchorFromRow(row, serializer, messageGetters) {
    const serializedMessage = deserializeMessageRow(row, serializer);
    const mapped = mapMessage(row, serializedMessage, messageGetters);
    const getterID = messageGetterValue(messageGetters, "getId", serializedMessage);
    const key = serializedMessageKey(serializedMessage);
    const anchor = getterID || (key && Object.keys(key).length > 0 ? key : serializedMessage?.id || row?.id);
    if (!mapped || !anchor) {
      return null;
    }
    return {
      anchor,
      mapped,
      timestampMs: timestampMs(mapped.timestampMs)
    };
  }

  function upsertChatAnchor(anchorByChat, item) {
    const chatJid = text(item?.mapped?.chatJid);
    if (!chatJid) {
      return;
    }
    const current = anchorByChat.get(chatJid) || {};
    if (!current.latest || item.timestampMs > current.latest.timestampMs) {
      current.latest = item;
    }
    if (!current.oldest || item.timestampMs < current.oldest.timestampMs) {
      current.oldest = item;
    }
    anchorByChat.set(chatJid, current);
  }

  async function findMessagesByDirection(dbMessageFind, anchor, count, direction) {
    const direct = direction === "after" ? dbMessageFind?.msgFindAfter : dbMessageFind?.msgFindBefore;
    if (typeof direct === "function") {
      const result = await direct({ anchor, count });
      if (Array.isArray(result?.messages)) {
        return result.messages;
      }
      if (Array.isArray(result)) {
        return result;
      }
    }
    if (typeof dbMessageFind?.msgFindByDirection === "function") {
      const result = await dbMessageFind.msgFindByDirection({ anchor, count, direction });
      if (Array.isArray(result?.messages)) {
        return result.messages;
      }
      if (Array.isArray(result)) {
        return result;
      }
    }
    return [];
  }

  async function readDecryptedMessageModels(messageRows, serializer, messageGetters, limit) {
    const dbMessageFind = getWaModule("WAWebDBMessageFindLocal");
    if (!dbMessageFind || (!dbMessageFind.msgFindBefore && !dbMessageFind.msgFindAfter && !dbMessageFind.msgFindByDirection)) {
      return [];
    }

    const anchorByChat = new Map();
    for (const row of messageRows) {
      const item = messageAnchorFromRow(row, serializer, messageGetters);
      if (item) {
        upsertChatAnchor(anchorByChat, item);
      }
    }

    const modelByKey = new Map();
    const addModel = (model) => {
      const mapped = mapMessage({}, model, messageGetters);
      const key = `${text(mapped?.chatJid)}\u0000${text(mapped?.id)}`;
      if (key !== "\u0000" && !modelByKey.has(key)) {
        modelByKey.set(key, model);
      }
    };

    const count = Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : Math.max(1, messageRows.length + 10);
    for (const anchors of anchorByChat.values()) {
      const latest = anchors.latest?.anchor;
      const oldest = anchors.oldest?.anchor;
      if (latest) {
        for (const model of await findMessagesByDirection(dbMessageFind, latest, count, "before")) {
          addModel(model);
        }
      }
      if (oldest && oldest !== latest) {
        for (const model of await findMessagesByDirection(dbMessageFind, oldest, count, "after")) {
          addModel(model);
        }
      }
    }

    return Array.from(modelByKey.values());
  }

  function mediaMessageFromPayload(value) {
    const payload = unwrapMessagePayload(value);
    if (!payload || typeof payload !== "object") {
      return {};
    }
    return payload.imageMessage ||
      payload.videoMessage ||
      payload.documentMessage ||
      (payload.documentWithCaptionMessage && payload.documentWithCaptionMessage.message && payload.documentWithCaptionMessage.message.documentMessage) ||
      payload.audioMessage ||
      payload.stickerMessage ||
      {};
  }

  const WEB_MESSAGE_TYPE_TO_STORED_TYPE = Object.freeze({
    audio: "AudioMessage",
    audiomessage: "AudioMessage",
    chat: "Conversation",
    contactmessage: "ContactMessage",
    contactsarraymessage: "ContactsArrayMessage",
    conversation: "Conversation",
    document: "DocumentMessage",
    documentmessage: "DocumentMessage",
    extendedtextmessage: "ExtendedTextMessage",
    image: "ImageMessage",
    imagemessage: "ImageMessage",
    live_location: "LiveLocationMessage",
    livelocationmessage: "LiveLocationMessage",
    location: "LocationMessage",
    locationmessage: "LocationMessage",
    multi_vcard: "ContactsArrayMessage",
    ptt: "AudioMessage",
    protocolmessage: "ProtocolMessage",
    reaction: "ReactionMessage",
    reactionmessage: "ReactionMessage",
    revoked: "ProtocolMessage",
    sticker: "StickerMessage",
    stickermessage: "StickerMessage",
    vcard: "ContactMessage",
    video: "VideoMessage",
    videomessage: "VideoMessage"
  });

  const EXPORTABLE_MESSAGE_TYPES = new Set([
    "AudioMessage",
    "ContactMessage",
    "ContactsArrayMessage",
    "Conversation",
    "DocumentMessage",
    "ExtendedTextMessage",
    "ImageMessage",
    "LiveLocationMessage",
    "LocationMessage",
    "ReactionMessage",
    "StickerMessage",
    "VideoMessage"
  ]);

  function hasObjectKeys(value) {
    return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
  }

  function lowerCamelMessageKey(messageType) {
    const value = text(messageType);
    return value ? value.charAt(0).toLowerCase() + value.slice(1) : "";
  }

  function storedMessageTypeFromWebType(rawType, hasContextInfo = false) {
    const value = text(rawType);
    if (!value) {
      return hasContextInfo ? "ExtendedTextMessage" : "Conversation";
    }
    const lower = value.toLowerCase();
    const mapped = WEB_MESSAGE_TYPE_TO_STORED_TYPE[lower] || value;
    if (mapped === "Conversation" && hasContextInfo) {
      return "ExtendedTextMessage";
    }
    return mapped;
  }

  function isFilteredHistoryChatJID(jid) {
    const value = text(jid).toLowerCase();
    return value === "0@s.whatsapp.net" || value === "status@broadcast";
  }

  function isNonZeroMessageStubType(...values) {
    const value = firstContentValue(...values);
    if (value === undefined) {
      return false;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric !== 0;
    }
    return Boolean(text(value));
  }

  function firstObjectFieldValue(value, names) {
    const sources = [value];
    const converted = serializedObjectView(value);
    if (converted && converted !== value) {
      sources.push(converted);
    }
    for (const source of sources) {
      for (const name of names) {
        const field = safeGetField(source, name);
        if (field !== undefined && field !== null && field !== "") {
          return field;
        }
      }
    }
    return undefined;
  }

  function jidListFromValue(value) {
    if (!value) {
      return [];
    }
    const values = Array.isArray(value)
      ? value
      : typeof value !== "string" && typeof value[Symbol.iterator] === "function"
        ? Array.from(value)
        : [value];
    return values
      .map((item) => jidToString(item?.jid || item?.id || item))
      .filter(Boolean);
  }

  function uniqueItems(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function quotedMessagePayloadFromWebMessage(quotedMessage, quotedType, messageGetters) {
    if (!quotedMessage) {
      return undefined;
    }
    const quotedText = messageGetterText(messageGetters, quotedMessage, ["getBody", "getCaption"]) ||
      textFromSerializedMessage(quotedMessage) ||
      textFromKnownFields(quotedMessage);
    const storedType = storedMessageTypeFromWebType(quotedType || messageGetterValue(messageGetters, "getType", quotedMessage));
    if (storedType === "Conversation") {
      return quotedText ? { conversation: quotedText } : undefined;
    }
    const key = lowerCamelMessageKey(storedType);
    if (!key) {
      return undefined;
    }
    const content = messageContentForStoredType(storedType, quotedText, {}, undefined, quotedType);
    return { [key]: content && typeof content === "object" ? content : {} };
  }

  function contextInfoFromMessage(row, serializedMessage, messageGetters, chatJid) {
    const quotedMessage = messageGetterValue(messageGetters, "getQuotedMsg", serializedMessage) ||
      firstObjectFieldValue(serializedMessage, ["quotedMsg", "quotedMessage"]) ||
      firstObjectFieldValue(row, ["quotedMsg", "quotedMessage"]);
    const stanzaID = text(firstObjectFieldValue(serializedMessage, ["quotedStanzaID", "quotedStanzaId", "quotedStanzaid"])) ||
      text(firstObjectFieldValue(row, ["quotedStanzaID", "quotedStanzaId", "quotedStanzaid"])) ||
      messageIDToString(messageGetterValue(messageGetters, "getId", quotedMessage));
    const participant = jidToString(messageGetterValue(messageGetters, "getQuotedParticipant", serializedMessage)) ||
      jidToString(firstObjectFieldValue(serializedMessage, ["quotedParticipant", "quotedAuthor", "quotedSender"])) ||
      jidToString(firstObjectFieldValue(row, ["quotedParticipant", "quotedAuthor", "quotedSender"]));
    const remoteJID = jidToString(messageGetterValue(messageGetters, "getQuotedRemoteJid", serializedMessage)) ||
      jidToString(firstObjectFieldValue(serializedMessage, ["quotedRemoteJid", "quotedRemoteJID", "quotedRemote"])) ||
      jidToString(firstObjectFieldValue(row, ["quotedRemoteJid", "quotedRemoteJID", "quotedRemote"]));
    const mentionedJID = uniqueItems([
      ...jidListFromValue(messageGetterValue(messageGetters, "getMentionedJidList", serializedMessage)),
      ...jidListFromValue(firstObjectFieldValue(serializedMessage, ["mentionedJidList", "mentionedJID", "mentions"])),
      ...jidListFromValue(firstObjectFieldValue(row, ["mentionedJidList", "mentionedJID", "mentions"]))
    ]);
    const quotedType = text(messageGetterValue(messageGetters, "getQuotedType", serializedMessage)) ||
      text(firstObjectFieldValue(serializedMessage, ["quotedType"])) ||
      text(firstObjectFieldValue(row, ["quotedType"]));
    const contextInfo = compactObject({
      stanzaID,
      participant,
      remoteJID: stanzaID ? (remoteJID || chatJid) : "",
      mentionedJID: mentionedJID.length > 0 ? mentionedJID : undefined,
      quotedMessage: quotedMessagePayloadFromWebMessage(quotedMessage, quotedType, messageGetters)
    });
    return hasObjectKeys(contextInfo) ? contextInfo : undefined;
  }

  function messageContentForStoredType(messageType, messageText, mediaContent, contextInfo, rawType) {
    if (messageType === "Conversation") {
      return messageText || undefined;
    }
    if (messageType === "ExtendedTextMessage") {
      const content = compactObject({
        text: messageText,
        contextInfo
      });
      return hasObjectKeys(content) ? content : undefined;
    }

    const mediaTypesWithCaption = new Set(["DocumentMessage", "ImageMessage", "VideoMessage"]);
    const content = compactObject({
      ...mediaContent,
      caption: mediaTypesWithCaption.has(messageType) ? messageText : undefined,
      PTT: text(rawType).toLowerCase() === "ptt" ? true : undefined,
      contextInfo
    });
    return hasObjectKeys(content) ? content : undefined;
  }

  function messagePayloadForWebMessage(messageType, content) {
    if (messageType === "Conversation") {
      return typeof content === "string" && content ? { conversation: content } : undefined;
    }
    const key = lowerCamelMessageKey(messageType);
    if (!key) {
      return undefined;
    }
    return { [key]: content && typeof content === "object" ? content : {} };
  }

  function webMessageStatusFromAck(ack) {
    const value = Number(ack);
    switch (value) {
      case 1:
        return "PENDING";
      case 2:
        return "SERVER_ACK";
      case 3:
        return "DELIVERY_ACK";
      case 4:
        return "READ";
      case 5:
        return "PLAYED";
      default:
        return undefined;
    }
  }

  function webMessageFromStoredContent({ id, chatJid, senderJid, fromMe, timestampMs: rawTimestampMs, messageType, content, ack }) {
    if (!EXPORTABLE_MESSAGE_TYPES.has(messageType)) {
      return undefined;
    }
    const message = messagePayloadForWebMessage(messageType, content);
    if (!message) {
      return undefined;
    }
    const isGroup = chatJid.endsWith("@g.us");
    const timestampSeconds = Math.floor(timestampMs(rawTimestampMs) / 1000);
    return compactObject({
      key: compactObject({
        remoteJID: chatJid,
        fromMe,
        ID: id,
        participant: isGroup && senderJid ? senderJid : undefined
      }),
      message,
      messageTimestamp: timestampSeconds > 0 ? timestampSeconds : undefined,
      status: webMessageStatusFromAck(ack),
      participant: isGroup && senderJid ? senderJid : undefined
    });
  }

  function mapMessage(row, serializedMessage = null, messageGetters = null) {
    const key = serializedMessageKey(serializedMessage);
    const getterId = messageGetterValue(messageGetters, "getId", serializedMessage);
    const id = messageIDToString(row.id) ||
      messageIDToString(row.messageId) ||
      text(row.externalId) ||
      text(row.internalId) ||
      text(key.id) ||
      messageIDToString(getterId);
    const fromMe = row.id && typeof row.id === "object" && typeof row.id.fromMe === "boolean"
      ? row.id.fromMe
      : typeof row.id === "string"
        ? row.id.startsWith("true_")
        : typeof key.fromMe === "boolean"
          ? key.fromMe
          : Boolean(row.fromMe);
    const chatJid = jidToString(row.chatId || (row.id && row.id.remote)) ||
      jidToString(key.remoteJid || key.remote) ||
      jidToString(messageGetterValue(messageGetters, "getRemote", serializedMessage)) ||
      messageChatJIDFromID(row.id) ||
      (fromMe ? jidToString(row.to || row.from) : jidToString(row.from || row.to));
    if (!id || !chatJid || isFilteredHistoryChatJID(chatJid)) {
      return null;
    }
    if (isNonZeroMessageStubType(row.messageStubType, serializedMessage?.messageStubType, serializedMessage?.stubType)) {
      return null;
    }
    const mediaMessage = mediaMessageFromPayload(serializedMessage && (serializedMessage.message || serializedMessage.msg || serializedMessage._message));
    const senderJid = jidToString(row.author || row.sender || (row.id && row.id.participant) || key.participant || serializedMessage?.author || messageGetterValue(messageGetters, "getSender", serializedMessage) || messageGetterValue(messageGetters, "getAuthor", serializedMessage) || row.from);
    const getterText = messageGetterText(messageGetters, serializedMessage, ["getBody", "getCaption", "getTitle", "getComment", "getPollName", "getEventName", "getEventDescription"]);
    const messageText = firstText(row.body, row.caption, row.text) || getterText || textFromSerializedMessage(serializedMessage) || textFromKnownFields(row);
    const contextInfo = contextInfoFromMessage(row, serializedMessage, messageGetters, chatJid);
    const rawType = text(row.type) || text(messageGetterValue(messageGetters, "getType", serializedMessage));
    const messageType = storedMessageTypeFromWebType(rawType, Boolean(contextInfo));
    if (!EXPORTABLE_MESSAGE_TYPES.has(messageType)) {
      return null;
    }
    const ack = firstContentValue(row.ack, messageGetterValue(messageGetters, "getAck", serializedMessage));
    const mediaContent = compactObject({
      URL: firstContentValue(row.deprecatedMms3Url, messageGetterValue(messageGetters, "getDeprecatedMms3Url", serializedMessage), mediaMessage.url),
      mimetype: firstContentValue(row.mimetype, messageGetterValue(messageGetters, "getMimetype", serializedMessage), mediaMessage.mimetype),
      fileSHA256: firstContentValue(row.filehash, messageGetterValue(messageGetters, "getFilehash", serializedMessage), mediaMessage.fileSha256, mediaMessage.filehash),
      mediaKey: firstContentValue(row.mediaKey, mediaMessage.mediaKey),
      fileLength: firstContentValue(row.size, mediaMessage.fileLength, mediaMessage.size),
      seconds: firstContentValue(row.duration, mediaMessage.seconds, mediaMessage.duration),
      directPath: firstContentValue(row.directPath, mediaMessage.directPath),
      title: firstContentValue(row.title, mediaMessage.title),
      fileName: firstContentValue(row.fileName, row.filename, mediaMessage.fileName),
      pageCount: firstContentValue(row.pageCount, mediaMessage.pageCount)
    });
    const content = messageContentForStoredType(messageType, messageText, mediaContent, contextInfo, rawType);
    const webMessage = webMessageFromStoredContent({
      id,
      chatJid,
      senderJid,
      fromMe,
      timestampMs: timestampMs(firstDefined(row.t, messageGetterValue(messageGetters, "getT", serializedMessage), serializedMessage?.messageTimestamp, serializedMessage?.timestamp)),
      messageType,
      content,
      ack
    });
    if (!webMessage) {
      return null;
    }
    return compactObject({
      id,
      chatJid,
      senderJid,
      fromMe,
      timestampMs: timestampMs(firstDefined(row.t, messageGetterValue(messageGetters, "getT", serializedMessage), serializedMessage?.messageTimestamp, serializedMessage?.timestamp)),
      type: messageType,
      text: messageText,
      content,
      webMessage
    });
  }

  function selectRecentHistoryChats(chats, limit) {
    const out = Array.isArray(chats) ? [...chats] : [];
    out.sort((left, right) => {
      const leftTimestamp = timestampMs(left?.lastMessageTimestampMs);
      const rightTimestamp = timestampMs(right?.lastMessageTimestampMs);
      if (leftTimestamp === rightTimestamp) {
        return text(left?.jid).localeCompare(text(right?.jid));
      }
      return rightTimestamp - leftTimestamp;
    });
    return out.slice(0, Math.max(0, limit));
  }

  function messageTimestampIndexName(store) {
    const names = Array.from(store.indexNames || []);
    const preferred = ["t", "timestamp", "timestampMs", "messageTimestamp", "rowId"];
    for (const preferredName of preferred) {
      const found = names.find((name) => name.toLowerCase() === preferredName.toLowerCase());
      if (found) {
        return found;
      }
    }
    return "";
  }

  async function readRecentMessageRowsForChats(dbName, storeName, chats, limit, maxScanned) {
    const targetChats = new Set();
    for (const chat of Array.isArray(chats) ? chats : []) {
      const jid = text(chat?.jid);
      const lid = text(chat?.lid);
      if (jid) {
        targetChats.add(jid);
      }
      if (lid) {
        targetChats.add(lid);
      }
    }
    if (targetChats.size === 0) {
      return readStore(dbName, storeName, limit, "prev");
    }

    const db = await openDatabase(dbName);
    try {
      if (!Array.from(db.objectStoreNames || []).includes(storeName)) {
        return [];
      }
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const indexName = messageTimestampIndexName(store);
      const source = indexName ? store.index(indexName) : store;
      const orderedByTimestamp = Boolean(indexName);
      const selectedByKey = new Map();
      let scanned = 0;
      await new Promise((resolve, reject) => {
        const request = source.openCursor(null, "prev");
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || scanned >= maxScanned || (orderedByTimestamp && selectedByKey.size >= limit)) {
            resolve();
            return;
          }
          scanned += 1;
          const mapped = mapMessage(cursor.value);
          const chatJid = text(mapped?.chatJid);
          if (chatJid && targetChats.has(chatJid)) {
            const messageKey = `${chatJid}\u0000${text(mapped.id)}`;
            if (!selectedByKey.has(messageKey)) {
              selectedByKey.set(messageKey, { row: cursor.value, message: mapped });
            }
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error(`Falha ao ler ${storeName}`));
      });
      const selectedRows = Array.from(selectedByKey.values())
        .sort((left, right) => timestampMs(right.message.timestampMs) - timestampMs(left.message.timestampMs))
        .slice(0, Math.max(0, limit))
        .map((item) => item.row);
      if (selectedRows.length === 0) {
        return readStore(dbName, storeName, limit, "prev");
      }
      return selectedRows;
    } finally {
      db.close();
    }
  }

  function limitHistoryAnchors(history, limit) {
    const rawChats = Array.isArray(history?.chats) ? history.chats : [];
    const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
    const latestMessageByChat = new Map();
    const messagesByChat = new Map();
    const seenMessages = new Set();
    for (const message of rawMessages) {
      const chatJid = text(message.chatJid);
      const id = text(message.id);
      if (!chatJid || !id) {
        continue;
      }
      const messageKey = `${chatJid}\u0000${id}`;
      if (seenMessages.has(messageKey)) {
        continue;
      }
      seenMessages.add(messageKey);
      const normalized = { ...message, id, chatJid, timestampMs: timestampMs(message.timestampMs) };
      if (!messagesByChat.has(chatJid)) {
        messagesByChat.set(chatJid, []);
      }
      messagesByChat.get(chatJid).push(normalized);
      const existing = latestMessageByChat.get(chatJid);
      if (!existing || normalized.timestampMs > timestampMs(existing.timestampMs)) {
        latestMessageByChat.set(chatJid, normalized);
      }
    }

    const chatByJid = new Map();
    for (const chat of rawChats) {
      const jid = text(chat.jid);
      if (!jid) {
        continue;
      }
      const normalized = {
        ...chat,
        jid,
        lid: text(chat.lid),
        lastMessageTimestampMs: timestampMs(chat.lastMessageTimestampMs)
      };
      const existing = chatByJid.get(jid);
      if (!existing || normalized.lastMessageTimestampMs > timestampMs(existing.lastMessageTimestampMs)) {
        chatByJid.set(jid, normalized);
      }
    }

    for (const message of latestMessageByChat.values()) {
      if (!chatByJid.has(message.chatJid)) {
        chatByJid.set(message.chatJid, {
          jid: message.chatJid,
          isGroup: message.chatJid.endsWith("@g.us"),
          lastMessageTimestampMs: timestampMs(message.timestampMs)
        });
      }
    }

    const chats = Array.from(chatByJid.values());
    chats.sort((left, right) => {
      const leftMessage = latestMessageByChat.get(left.jid) || latestMessageByChat.get(left.lid);
      const rightMessage = latestMessageByChat.get(right.jid) || latestMessageByChat.get(right.lid);
      const leftTimestamp = Math.max(timestampMs(left.lastMessageTimestampMs), timestampMs(leftMessage?.timestampMs));
      const rightTimestamp = Math.max(timestampMs(right.lastMessageTimestampMs), timestampMs(rightMessage?.timestampMs));
      return rightTimestamp - leftTimestamp;
    });

    const selectedChats = chats.slice(0, Math.max(0, limit));
    const selectedMessages = [];
    const selectedMessageKeys = new Set();
    for (const chat of selectedChats) {
      for (const chatKey of [chat.jid, chat.lid].filter(Boolean)) {
        for (const message of messagesByChat.get(chatKey) || []) {
          const messageKey = `${message.chatJid}\u0000${message.id}`;
          if (!selectedMessageKeys.has(messageKey)) {
            selectedMessageKeys.add(messageKey);
            selectedMessages.push(message);
          }
        }
      }
    }
    selectedMessages.sort((left, right) => timestampMs(right.timestampMs) - timestampMs(left.timestampMs));
    return { chats: selectedChats, messages: selectedMessages };
  }

  async function run() {
    const contactRows = await readStore("model-storage", "contact", LIMITS.contacts);
    const chatRows = await readStore("model-storage", "chat", LIMITS.chats);

    const contacts = contactRows.map(mapContact).filter(Boolean);
    const chats = chatRows.map(mapChat).filter(Boolean);
    const recentChats = selectRecentHistoryChats(chats, LIMITS.historyChats);
    const messageRows = await readRecentMessageRowsForChats(
      "model-storage",
      "message",
      recentChats,
      LIMITS.messages,
      LIMITS.messageScan
    );
    const messageSerializer = getWaModule("WAWebDBMessageSerialization");
    const messageGetters = getWaModule("WAWebMsgGetters");
    let serializedMessageRows = 0;
    let serializedMessageRowsWithText = 0;
    const decryptedMessageModels = await readDecryptedMessageModels(messageRows, messageSerializer, messageGetters, LIMITS.messages);
    const messageByKey = new Map();
    const addMessage = (mapped) => {
      const key = `${text(mapped?.chatJid)}\u0000${text(mapped?.id)}`;
      if (key === "\u0000") {
        return;
      }
      const existing = messageByKey.get(key);
      if (!existing || (!text(existing.text) && text(mapped.text))) {
        messageByKey.set(key, mapped);
      }
    };
    for (const model of decryptedMessageModels) {
      addMessage(mapMessage({}, model, messageGetters));
    }
    for (const row of messageRows) {
      const serializedMessage = deserializeMessageRow(row, messageSerializer);
      if (serializedMessage) {
        serializedMessageRows += 1;
      }
      const mapped = mapMessage(row, serializedMessage, messageGetters);
      if (serializedMessage && text(mapped?.text)) {
        serializedMessageRowsWithText += 1;
      }
      addMessage(mapped);
    }
    const messages = Array.from(messageByKey.values())
      .sort((left, right) => timestampMs(right.timestampMs) - timestampMs(left.timestampMs));
    const history = limitHistoryAnchors({ chats: recentChats.length > 0 ? recentChats : chats, messages }, LIMITS.historyChats);
    const privacyTokens = chatRows.map(mapPrivacyToken).filter(Boolean);

    return {
      capturedAt: new Date().toISOString(),
      source: "whatsapp-web-sidecar-v1",
      url: location.href,
      contacts,
      privacyTokens,
      history: {
        chats: history.chats,
        messages: history.messages
      },
      counts: {
        contactRows: contactRows.length,
        chatRows: chatRows.length,
        messageRows: messageRows.length,
        messageRowsSerialized: serializedMessageRows,
        messageRowsSerializedWithText: serializedMessageRowsWithText,
        messageRowsDecrypted: decryptedMessageModels.length,
        messageRowsDecryptedWithText: decryptedMessageModels
          .map((model) => mapMessage({}, model, messageGetters))
          .filter((message) => text(message?.text)).length,
        contacts: contacts.length,
        privacyTokens: privacyTokens.length,
        historyChatsRaw: chats.length,
        historyMessagesRaw: messages.length,
        historyChats: history.chats.length,
        historyMessages: history.messages.length,
        historyMessagesWithText: history.messages.filter((message) => text(message.text)).length
      }
    };
  }

  return run()
    .then((dump) => ({ dump }))
    .catch((error) => ({ error: error.message || "Falha ao capturar histórico" }));
}

function extractWhatsAppWebMainDump(options = {}) {
  function bytesToB64(bytes) {
    if (!bytes) {
      return null;
    }
    let u;
    if (bytes instanceof Uint8Array) {
      u = bytes;
    } else if (bytes instanceof ArrayBuffer) {
      u = new Uint8Array(bytes);
    } else if (typeof bytes === "string") {
      u = Uint8Array.from(bytes, (c) => c.charCodeAt(0));
    } else {
      return null;
    }
    const chunks = [];
    const step = 0x8000;
    for (let i = 0; i < u.length; i += step) {
      chunks.push(String.fromCharCode.apply(null, u.subarray(i, i + step)));
    }
    return btoa(chunks.join(""));
  }

  function bufWrap(bytes) {
    const data = bytesToB64(bytes);
    return data == null ? null : { type: "Buffer", data };
  }

  function deepBufWrap(value) {
    if (value == null) {
      return value;
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      return bufWrap(value);
    }
    if (Array.isArray(value)) {
      return value.map(deepBufWrap);
    }
    if (typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value)) {
        if (key !== "$$unknownFieldCount") {
          out[key] = deepBufWrap(value[key]);
        }
      }
      return out;
    }
    return value;
  }

  function openDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(`Falha ao abrir ${name}`));
      request.onblocked = () => reject(new Error(`Abertura bloqueada: ${name}`));
    });
  }

  function getAll(db, storeName) {
    return new Promise((resolve, reject) => {
      if (!Array.from(db.objectStoreNames || []).includes(storeName)) {
        resolve([]);
        return;
      }
      const tx = db.transaction(storeName, "readonly");
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error(`Falha ao ler ${storeName}`));
    });
  }

  async function decryptRegMaterial(value) {
    if (!value || !value.encKey || !value.value) {
      return null;
    }
    const counter = new Uint8Array(16);
    const cipher = value.value instanceof Uint8Array ? value.value : new Uint8Array(value.value);
    const plain = await crypto.subtle.decrypt({ name: "AES-CTR", length: 128, counter }, value.encKey, cipher);
    return new Uint8Array(plain);
  }

  function getWaModule(name) {
    try {
      if (typeof require === "function") {
        return require(name);
      }
    } catch {}
    try {
      if (typeof __d === "function") {
        let captured;
        const sentinel = `__waDumpProbe_${Math.random().toString(36).slice(2)}`;
        __d(sentinel, [name], function (_target, _namespace, _require, moduleRequire) {
          captured = moduleRequire(name);
        });
        if (!captured && typeof __d.require === "function") {
          captured = __d.require(name);
        }
        if (captured) {
          return captured;
        }
      }
    } catch {}
    return null;
  }

  async function getNoiseInfoViaInternalModule() {
    const infoStore = getWaModule("WAWebUserPrefsInfoStore");
    if (!infoStore || !infoStore.waNoiseInfo || typeof infoStore.waNoiseInfo.get !== "function") {
      return null;
    }
    try {
      const decrypted = await infoStore.waNoiseInfo.get();
      if (!decrypted || !decrypted.staticKeyPair) {
        return null;
      }
      return {
        pubKey: new Uint8Array(decrypted.staticKeyPair.pubKey),
        privKey: new Uint8Array(decrypted.staticKeyPair.privKey)
      };
    } catch (error) {
      console.warn("[wa-web-dump] internal noise lookup failed", error);
      return null;
    }
  }

  async function getNoiseInfoFallback() {
    const saltJson = localStorage.getItem("WAWebEncKeySalt");
    const noiseJson = localStorage.getItem("WANoiseInfo");
    const ivJson = localStorage.getItem("WANoiseInfoIv");
    if (!saltJson || !noiseJson || !ivJson) {
      return null;
    }

    const saltBytes = Uint8Array.from(atob(JSON.parse(saltJson)), (c) => c.charCodeAt(0));
    const noiseObj = JSON.parse(noiseJson);
    const ivs = JSON.parse(ivJson).map((value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
    const encPub = Uint8Array.from(atob(noiseObj.pubKey), (c) => c.charCodeAt(0));
    const encPriv = Uint8Array.from(atob(noiseObj.privKey), (c) => c.charCodeAt(0));
    const db = await openDatabase("wawc_db_enc");
    const baseRows = await getAll(db, "keys");
    db.close();

    for (const row of baseRows || []) {
      try {
        const aesKey = await crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: new Uint8Array(1) },
          row.key,
          { name: "AES-CBC", length: 128 },
          false,
          ["decrypt"]
        );
        const pub = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivs[1] }, aesKey, encPub);
        const priv = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivs[2] }, aesKey, encPriv);
        return { pubKey: new Uint8Array(pub), privKey: new Uint8Array(priv) };
      } catch {}
    }
    return null;
  }

  async function getNoiseKey() {
    return (await getNoiseInfoViaInternalModule()) || (await getNoiseInfoFallback());
  }

  function parseAddress(addr) {
    const raw = String(addr || "");
    const dot = raw.lastIndexOf(".");
    const head = dot >= 0 ? raw.slice(0, dot) : raw;
    const parsedDevice = dot >= 0 ? Number(raw.slice(dot + 1)) : 0;
    const jid = head.includes("@") ? head : `${head}@s.whatsapp.net`;
    return { jid, device: Number.isFinite(parsedDevice) ? parsedDevice : 0 };
  }

  function parseSenderKeyName(name) {
    const raw = String(name || "");
    const sep = raw.indexOf("::");
    if (sep < 0) {
      return null;
    }
    const groupId = raw.slice(0, sep);
    const senderPart = raw.slice(sep + 2);
    const parsed = parseAddress(senderPart);
    return { groupId, senderJid: parsed.jid, senderDevice: parsed.device };
  }

  async function getModelTable(schemaModuleName, tableGetterName) {
    const mod = getWaModule(schemaModuleName);
    const getter = mod && mod[tableGetterName];
    if (typeof getter !== "function") {
      return [];
    }
    try {
      const rows = await getter().all();
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      console.warn(`[wa-web-dump] ${schemaModuleName}.${tableGetterName}().all() failed`, error);
      return [];
    }
  }

  function toUint8(value) {
    if (value == null) {
      return null;
    }
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (typeof value === "object" && value.buffer instanceof ArrayBuffer) {
      return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength || value.buffer.byteLength);
    }
    if (typeof value === "string") {
      return Uint8Array.from(value, (c) => c.charCodeAt(0));
    }
    return null;
  }

  function timestampMs(value) {
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }
    return value < 100000000000 ? Math.floor(value * 1000) : Math.floor(value);
  }

  function normalizeWhatsAppUserJID(value) {
    const trimmed = String(value || "").trim();
    const at = trimmed.lastIndexOf("@");
    if (at < 0) {
      return trimmed;
    }
    const server = trimmed.slice(at + 1);
    if (server === "c.us") {
      return `${trimmed.slice(0, at)}@s.whatsapp.net`;
    }
    return trimmed;
  }

  function jidToString(value) {
    if (!value) {
      return "";
    }
    if (typeof value === "string") {
      return normalizeWhatsAppUserJID(value);
    }
    if (typeof value === "object") {
      if (typeof value._serialized === "string") {
        return normalizeWhatsAppUserJID(value._serialized);
      }
      if (typeof value.user === "string" && typeof value.server === "string") {
        return normalizeWhatsAppUserJID(`${value.user}@${value.server}`);
      }
    }
    return "";
  }

  function widToJid(wid) {
    if (!wid || typeof wid !== "string") {
      return null;
    }
    const at = wid.lastIndexOf("@");
    const head = at >= 0 ? wid.slice(0, at) : wid;
    const server = at >= 0 ? wid.slice(at + 1) : "s.whatsapp.net";
    const colon = head.indexOf(":");
    const userAndAgent = colon >= 0 ? head.slice(0, colon) : head;
    const device = colon >= 0 ? Number(head.slice(colon + 1)) : 0;
    const dot = userAndAgent.indexOf(".");
    const user = dot >= 0 ? userAndAgent.slice(0, dot) : userAndAgent;
    return `${user}:${Number.isFinite(device) ? device : 0}@${server}`;
  }

  function readJSONLocalStorage(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  }

  function downloadInPage(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function run() {
    const signalDB = await openDatabase("signal-storage");
    const [meta, identity, prekey, signedPrekey, session, senderkey] = await Promise.all([
      getAll(signalDB, "signal-meta-store"),
      getAll(signalDB, "identity-store"),
      getAll(signalDB, "prekey-store"),
      getAll(signalDB, "signed-prekey-store"),
      getAll(signalDB, "session-store"),
      getAll(signalDB, "senderkey-store")
    ]);
    signalDB.close();

    const metaMap = {};
    for (const row of meta) {
      metaMap[row.key] = row.value;
    }

    const staticPub = await decryptRegMaterial(metaMap.signal_static_pubkey);
    const staticPriv = await decryptRegMaterial(metaMap.signal_static_privkey);
    const noise = await getNoiseKey();
    const advSignedIdentity = metaMap.adv_signed_identity ? deepBufWrap(metaMap.adv_signed_identity) : null;

    const [
      syncKeysRows,
      collectionVersionRows,
      syncActionsRows,
      contactRows,
      tcTokenRows,
      messageRows,
      userPrefsRows
    ] = await Promise.all([
      getModelTable("WAWebSchemaSyncKeys", "getSyncKeysTable"),
      getModelTable("WAWebSchemaCollectionVersion", "getCollectionVersionTable"),
      getModelTable("WAWebSchemaSyncActions", "getSyncActionsTable"),
      getModelTable("WAWebSchemaContact_DO_NOT_USE_DIRECTLY", "getContactTable"),
      getModelTable("WAWebSchemaOrphanTcToken", "getOrphanTcTokenTable"),
      getModelTable("WAWebSchemaMessage", "getMessageTable"),
      getModelTable("WAWebSchemaUserPrefs", "getUserPrefsTable")
    ]);

    const userPrefs = {};
    for (const row of userPrefsRows) {
      if (row && row.key) {
        userPrefs[String(row.key)] = row.value;
      }
    }
    if (userPrefsRows.length === 0) {
      try {
        const modelDB = await openDatabase("model-storage");
        const rows = await getAll(modelDB, "user-prefs");
        for (const row of rows) {
          if (row && row.key) {
            userPrefs[String(row.key)] = row.value;
          }
        }
        modelDB.close();
      } catch (error) {
        console.warn("[wa-web-dump] user-prefs raw fallback failed", error);
      }
    }

    let advSecretKey = null;
    try {
      const value = await (getWaModule("WAWebUserPrefsMultiDevice") || {}).getADVSecretKey?.();
      if (typeof value === "string") {
        advSecretKey = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
      } else if (value) {
        advSecretKey = toUint8(value);
      }
    } catch {}

    const appStateSyncKeys = syncKeysRows
      .map((row) => {
        const keyId = toUint8(row.keyId);
        const keyData = toUint8(row.keyData);
        if (!keyId || !keyData) {
          return null;
        }
        return {
          keyId: bufWrap(keyId),
          keyData: bufWrap(keyData),
          timestamp: row.timestamp || 0,
          ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
          ...(row.keyEpoch !== undefined ? { keyEpoch: row.keyEpoch } : {})
        };
      })
      .filter(Boolean);

    const indexValueByCollection = new Map();
    for (const action of syncActionsRows) {
      const indexMac = toUint8(action.indexMac);
      const valueMac = toUint8(action.valueMac);
      if (!action.collection || !indexMac || !valueMac) {
        continue;
      }
      const map = indexValueByCollection.get(action.collection) || {};
      map[bytesToB64(indexMac)] = bufWrap(valueMac);
      indexValueByCollection.set(action.collection, map);
    }

    const appStateVersions = collectionVersionRows
      .map((row) => {
        const hash = toUint8(row.ltHash);
        if (!row.collection || !hash) {
          return null;
        }
        return {
          collection: row.collection,
          version: row.version || 0,
          hash: bufWrap(hash),
          indexValueMap: indexValueByCollection.get(row.collection) || {}
        };
      })
      .filter(Boolean);

    const contacts = contactRows
      .map((row) => {
        const jid = jidToString(row.id);
        if (!jid) {
          return null;
        }
        return {
          jid,
          ...(row.name ? { displayName: String(row.name) } : {}),
          ...(row.pushname ? { pushName: String(row.pushname) } : {}),
          ...(row.verifiedName ? { verifiedName: String(row.verifiedName) } : {}),
          ...(row.phoneNumber ? { phoneNumber: jidToString(row.phoneNumber) || String(row.phoneNumber) } : {})
        };
      })
      .filter(Boolean);

    const privacyTokens = tcTokenRows
      .map((row) => {
        const token = toUint8(row.tcToken);
        const jid = jidToString(row.chatId || row.id);
        if (!jid || !token) {
          return null;
        }
        return {
          jid,
          token: bufWrap(token),
          timestampMs: timestampMs(row.tcTokenTimestamp || row.timestampMs || row.timestamp)
        };
      })
      .filter(Boolean);

    const messageSecrets = [];
    if (messageRows.length > 0) {
      const serializer = getWaModule("WAWebDBMessageSerialization");
      const fromRow = serializer && serializer.messageFromDbRow;
      if (typeof fromRow === "function") {
        for (const row of messageRows) {
          let msg;
          try {
            msg = fromRow(row);
          } catch {
            continue;
          }
          const secret = toUint8(msg && msg.messageSecret);
          const key = (msg && (msg.id || msg.msgKey)) || {};
          const messageId = key.id != null ? String(key.id) : "";
          if (!secret || !messageId) {
            continue;
          }
          const remote = key.remote;
          const participant = key.participant;
          const author = msg.author;
          const senderJid =
            (participant && participant.toString && participant.toString()) ||
            (author && author.toString && author.toString()) ||
            (remote && remote.toString && remote.toString()) ||
            "";
          const chatJid = remote && remote.toString && remote.toString();
          if (!senderJid) {
            continue;
          }
          messageSecrets.push({
            messageId,
            senderJid,
            ...(chatJid ? { chatJid } : {}),
            secret: bufWrap(secret)
          });
        }
      }
    }

    const signedPreKeyRow = signedPrekey[signedPrekey.length - 1] || null;
    const dump = {
      device: {
        registrationId: metaMap.signal_reg_id || null,
        noiseKey: noise ? { pubKey: bufWrap(noise.pubKey), privKey: bufWrap(noise.privKey) } : null,
        identityKey:
          staticPub && staticPriv ? { pubKey: bufWrap(staticPub), privKey: bufWrap(staticPriv) } : null,
        signedPreKey: signedPreKeyRow
          ? {
              keyId: signedPreKeyRow.keyId,
              keyPair: {
                pubKey: bufWrap(signedPreKeyRow.keyPair.pubKey),
                privKey: bufWrap(signedPreKeyRow.keyPair.privKey)
              },
              signature: bufWrap(signedPreKeyRow.signature)
            }
          : null,
        advSecretKey: advSecretKey ? bufWrap(advSecretKey) : bufWrap(new Uint8Array(0)),
        account: advSignedIdentity,
        meJid: widToJid(readJSONLocalStorage("last-wid-md")),
        meLid: widToJid(readJSONLocalStorage("WALid")),
        pushName: readJSONLocalStorage("me-display-name") || "",
        platform: "web"
      },
      preKeys: prekey.map((row) => ({
        keyId: row.keyId,
        keyPair: { pubKey: bufWrap(row.keyPair.pubKey), privKey: bufWrap(row.keyPair.privKey) },
        uploaded: Boolean(row.uploaded)
      })),
      identities: identity.map((row) => {
        const parsed = parseAddress(row.identifier);
        return { jid: parsed.jid, device: parsed.device, identityKey: bufWrap(row.identityKey) };
      }),
      sessions: session.map((row) => {
        const parsed = parseAddress(row.address);
        return { jid: parsed.jid, device: parsed.device, session: deepBufWrap(row.session) };
      }),
      senderKeys: senderkey
        .map((row) => {
          const parsed = parseSenderKeyName(row.senderKeyName);
          if (!parsed) {
            return null;
          }
          return {
            groupId: parsed.groupId,
            senderJid: parsed.senderJid,
            senderDevice: parsed.senderDevice,
            record: deepBufWrap(row.senderKey)
          };
        })
        .filter(Boolean),
      appStateSyncKeys,
      appStateVersions,
      privacyTokens,
      contacts,
      messageSecrets
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `wa-web-dump-${timestamp}.json`;
    if (options.download !== false) {
      downloadInPage(filename, dump);
    }
    window.__waWebDumpResult = dump;

    const result = {
      filename,
      meJid: dump.device.meJid,
      meLid: dump.device.meLid,
      hasNoiseKey: Boolean(dump.device.noiseKey),
      hasIdentityKey: Boolean(dump.device.identityKey),
      hasSignedPreKey: Boolean(dump.device.signedPreKey),
      preKeys: dump.preKeys.length,
      identities: dump.identities.length,
      sessions: dump.sessions.length,
      senderKeys: dump.senderKeys.length,
      appStateSyncKeys: dump.appStateSyncKeys.length,
      appStateVersions: dump.appStateVersions.length,
      privacyTokens: dump.privacyTokens.length,
      contacts: dump.contacts.length,
      messageSecrets: dump.messageSecrets.length
    };
    if (options.includeDump) {
      result.dump = dump;
    }
    return result;
  }

  return run()
    .then((dump) => ({ dump }))
    .catch((error) => ({ error: error.message || "Falha ao capturar sessão" }));
}

function extractWhatsAppWebStorageInventory() {
  const MAX_SAMPLES = 3;
  const MAX_DEPTH = 2;
  const knownDatabaseNames = ["signal-storage", "model-storage", "wawc_db_enc"];

  function redactText(value) {
    return String(value || "")
      .replace(/[0-9]{4,}/g, (match) => `<digits:${match.length}>`)
      .replace(/[A-Za-z0-9+/=_-]{80,}/g, (match) => `<encoded:${match.length}>`);
  }

  function isBytes(value) {
    return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
  }

  function byteLength(value) {
    if (value instanceof ArrayBuffer) {
      return value.byteLength;
    }
    if (ArrayBuffer.isView(value)) {
      return value.byteLength;
    }
    return 0;
  }

  function describeValue(value, depth = 0) {
    if (value == null || typeof value === "number" || typeof value === "boolean") {
      return { type: String(value), value };
    }
    if (typeof value === "string") {
      return { type: "string", length: value.length, preview: redactText(value.slice(0, 120)) };
    }
    if (value instanceof Date) {
      return { type: "Date", value: value.toISOString() };
    }
    if (isBytes(value)) {
      return { type: value.constructor ? value.constructor.name : "Bytes", byteLength: byteLength(value) };
    }
    if (Array.isArray(value)) {
      return {
        type: "Array",
        length: value.length,
        items: depth >= MAX_DEPTH ? [] : value.slice(0, MAX_SAMPLES).map((item) => describeValue(item, depth + 1))
      };
    }
    if (typeof value === "object") {
      const keys = Object.keys(value);
      const fields = {};
      if (depth < MAX_DEPTH) {
        for (const key of keys.slice(0, 20)) {
          fields[key] = describeValue(value[key], depth + 1);
        }
      }
      return { type: value.constructor ? value.constructor.name : "Object", keys: keys.slice(0, 40), fields };
    }
    return { type: typeof value };
  }

  function openDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(`Falha ao abrir ${name}`));
      request.onblocked = () => reject(new Error(`Abertura bloqueada: ${name}`));
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  async function listDatabaseNames() {
    const discovered = new Set(knownDatabaseNames);
    if (typeof indexedDB.databases === "function") {
      const databases = await indexedDB.databases();
      for (const db of databases || []) {
        if (db && db.name) {
          discovered.add(db.name);
        }
      }
    }
    return Array.from(discovered).sort();
  }

  async function inspectStore(db, storeName) {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const count = await requestToPromise(store.count()).catch(() => null);
    const samples = [];
    await new Promise((resolve, reject) => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || samples.length >= MAX_SAMPLES) {
          resolve();
          return;
        }
        samples.push({
          key: describeValue(cursor.key),
          primaryKey: describeValue(cursor.primaryKey),
          value: describeValue(cursor.value)
        });
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error(`Falha ao ler ${storeName}`));
    }).catch((error) => {
      samples.push({ error: error.message || String(error) });
    });
    return {
      name: storeName,
      count,
      keyPath: store.keyPath || null,
      autoIncrement: Boolean(store.autoIncrement),
      indexes: Array.from(store.indexNames || []),
      samples
    };
  }

  async function inspectDatabase(name) {
    const db = await openDatabase(name);
    try {
      const stores = [];
      for (const storeName of Array.from(db.objectStoreNames || [])) {
        stores.push(await inspectStore(db, storeName));
      }
      return { name, version: db.version, stores };
    } finally {
      db.close();
    }
  }

  async function run() {
    const localStorageKeys = Object.keys(localStorage || {}).sort();
    const indexedDBResults = [];
    for (const name of await listDatabaseNames()) {
      try {
        indexedDBResults.push(await inspectDatabase(name));
      } catch (error) {
        indexedDBResults.push({ name, error: error.message || String(error) });
      }
    }
    return {
      capturedAt: new Date().toISOString(),
      url: location.href,
      localStorageKeys: localStorageKeys.map(redactText),
      indexedDB: indexedDBResults
    };
  }

  return run()
    .then((inventory) => ({ inventory }))
    .catch((error) => ({ error: error.message || "Falha ao diagnosticar armazenamento" }));
}

function postToPort(port, payload) {
  try {
    port.postMessage(payload);
  } catch (error) {
    console.warn("Failed to post import status", error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function importSummaryText(result, importPayload, includeHistory, cleanup, connectResult) {
  const imported = result.imported || {};
  const cleanupWarning = cleanup && cleanup.error ? "; limpeza local falhou: " + cleanup.error : "";
  const connectWarning = connectResult && connectResult.error ? "; conexão API não iniciada: " + connectResult.error : "";
  const connectNote = connectResult && !connectResult.error ? "; conexão API solicitada" : "";
  const historyNote = includeHistory ? "" : "; histórico ignorado";
  return "Importação concluída" + historyNote + cleanupWarning + connectWarning + connectNote + ". jid=" + (result.jid || importPayload.device?.meJid || "n/a") + ", contatos=" + (imported.contacts || 0) + ", chunks=" + (result.chunks || 0);
}

async function runFloatingImport(tab, options, onStatus) {
  if (!tab || !tab.id || !String(tab.url || "").startsWith(WHATSAPP_WEB_URL_PREFIX)) {
    throw new Error("Abra uma aba do WhatsApp Web conectado");
  }
  if (runningImports.has(tab.id)) {
    throw new Error("Já existe uma importação em andamento nesta aba");
  }

  runningImports.add(tab.id);
  try {
    const client = String(options?.client || "").trim();
    const token = String(options?.token || "").trim();
    const includeHistory = options?.includeHistory !== false;
    const disconnectLocal = options?.disconnectLocal !== false;
    if (!client || !token) {
      throw new Error("Informe cliente e token da instância");
    }

    const serverUrl = normalizeBaseUrl(client);
    await chrome.storage.local.set({
      serverUrl: client,
      instanceToken: token,
      includeHistory,
      disconnectLocal
    });

    onStatus({ message: "Validando instância..." });
    await verifyInstanceForImport(serverUrl, token);

    let sidecar = null;
    if (includeHistory) {
      onStatus({ message: "Capturando histórico..." });
      sidecar = await extractSidecarFromTab(tab.id);
    } else {
      onStatus({ message: "Capturando dados auxiliares..." });
      try {
        sidecar = await extractSidecarFromTab(tab.id);
      } catch (sidecarError) {
        console.warn("WhatsApp Web sidecar capture skipped for credential-only import", sidecarError);
        onStatus({ message: "Dados auxiliares indisponíveis. Seguindo sem histórico." });
      }
    }

    onStatus({ message: "Capturando sessão..." });
    const mainDump = await extractMainDumpFromTab(tab.id, { download: false, includeDump: true });
    if (!mainDump || !mainDump.device) {
      throw new Error("Captura da sessão não retornou dados");
    }

    onStatus({ message: "Convertendo para whatsmeow..." });
    const converted = buildWhatsmeowPayload(mainDump, sidecar);
    const importPayload = importPayloadForOptions(converted.payload, { includeHistory });

    onStatus({ message: "Enviando chunks..." });
    const result = await uploadWhatsmeowPayload(serverUrl, token, importPayload, {
      onProgress: (done, total, section) => {
        onStatus({ message: "Enviando chunks " + done + "/" + total + " (" + section + ")..." });
      }
    });

    let cleanup = null;
    if (disconnectLocal) {
      onStatus({ message: "Importação concluída. Desconectando WhatsApp Web local...", kind: "ok" });
      try {
        cleanup = await clearWhatsAppWebLocalSessionFromTab(tab);
        onStatus({ message: "Aguardando encerramento da sessão local..." });
        await sleep(1200);
      } catch (cleanupError) {
        cleanup = { error: cleanupError.message || "Falha ao limpar dados locais do WhatsApp Web" };
        console.warn("WhatsApp Web local cleanup failed after successful import", cleanupError);
      }
    }

    let connectResult = null;
    if (disconnectLocal && !(cleanup && cleanup.error)) {
      onStatus({ message: "Conectando instância na API..." });
      try {
        connectResult = await connectImportedInstance(serverUrl, token);
      } catch (connectError) {
        connectResult = { error: connectError.message || "Falha ao conectar instância importada" };
        console.warn("Imported WhatsApp session was not connected automatically", connectError);
      }
    }

    return {
      message: importSummaryText(result, importPayload, includeHistory, cleanup, connectResult),
      result,
      cleanup,
      connect: connectResult,
      includeHistory,
      losses: converted.losses
    };
  } finally {
    runningImports.delete(tab.id);
  }
}

function ensureWhatsAppTab(tab) {
  if (!tab || !tab.id || !String(tab.url || "").startsWith(WHATSAPP_WEB_URL_PREFIX)) {
    throw new Error("Abra uma aba do WhatsApp Web conectado");
  }
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function runTechnicalCommand(tab, type, onStatus) {
  ensureWhatsAppTab(tab);
  if (type === "DIAGNOSE") {
    onStatus({ message: "Diagnosticando armazenamento..." });
    const inventory = await extractInventoryFromTab(tab.id);
    const dbCount = inventory.indexedDB ? inventory.indexedDB.length : 0;
    const storeCount = (inventory.indexedDB || []).reduce((sum, db) => sum + (db.stores ? db.stores.length : 0), 0);
    return {
      message: `Diagnóstico gerado. bancos=${dbCount}, áreas=${storeCount}`,
      download: {
        filename: `whatsapp-web-storage-inventory-${timestampForFilename()}.json`,
        data: inventory
      }
    };
  }

  if (type === "DUMP_HISTORY") {
    onStatus({ message: "Capturando histórico..." });
    const dump = await extractSidecarFromTab(tab.id);
    const messagesWithText = dump.counts?.historyMessagesWithText || 0;
    return {
      message: `Dump gerado. contatos=${dump.contacts.length}, chats=${dump.history.chats.length}, mensagens=${dump.history.messages.length}, com texto=${messagesWithText}, tokens=${dump.privacyTokens.length}`,
      download: {
        filename: `whatsapp-web-sidecar-${timestampForFilename()}.json`,
        data: dump
      }
    };
  }

  if (type === "DUMP_SESSION") {
    onStatus({ message: "Capturando sessão..." });
    const dump = await extractMainDumpFromTab(tab.id);
    return {
      message: `Sessão gerada. arquivo=${dump.filename}, jid=${dump.meJid || "n/a"}, sessões=${dump.sessions}, preKeys=${dump.preKeys}`
    };
  }

  throw new Error("Comando técnico desconhecido");
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "session-import") {
    return;
  }
  const tab = port.sender?.tab;
  port.onMessage.addListener((message) => {
    if (!message || !message.type) {
      return;
    }
    const runner =
      message.type === "START_IMPORT"
        ? runFloatingImport(tab, message.options || {}, (status) => {
            postToPort(port, { type: "STATUS", ...status });
          })
        : runTechnicalCommand(tab, message.type, (status) => {
            postToPort(port, { type: "STATUS", ...status });
          });
    runner
      .then((payload) => {
        postToPort(port, { type: "DONE", kind: "ok", message: payload.message, payload });
      })
      .catch((error) => {
        postToPort(port, { type: "ERROR", kind: "error", message: error.message || "Falha ao executar comando" });
      });
  });
});

async function openPanelInTab(tab) {
  if (!tab || !tab.id || !String(tab.url || "").startsWith(WHATSAPP_WEB_URL_PREFIX)) {
    return;
  }
  const message = { type: "SESSION_CONNECTOR_OPEN_PANEL" };
  try {
    await chrome.tabs.sendMessage(tab.id, message);
    return;
  } catch {}

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["autofill.js"] });
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    console.warn("Failed to open floating panel", error);
  }
}

chrome.action.onClicked.addListener((tab) => {
  openPanelInTab(tab);
});
