// @ts-nocheck

// Serialized into the WhatsApp Web page; keep this function self-contained.
export function extractWhatsAppWebSidecarDump(options = {}) {
  const configuredHistoryChatLimit = Number(options?.historyChatLimit);
  const HISTORY_CHAT_LIMIT = Number.isFinite(configuredHistoryChatLimit) && configuredHistoryChatLimit >= 0
    ? Math.floor(configuredHistoryChatLimit)
    : 5000;
  const LIMITS = {
    contacts: 15000,
    chats: 10000,
    messages: HISTORY_CHAT_LIMIT,
    messageScan: HISTORY_CHAT_LIMIT * 10,
    historyChats: HISTORY_CHAT_LIMIT
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
      const pageRequire = globalThis.require;
      if (typeof pageRequire === "function") {
        return pageRequire(name);
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

  const serializedObjectViewCache = new WeakMap();

  function serializedObjectView(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    if (serializedObjectViewCache.has(value)) {
      return serializedObjectViewCache.get(value);
    }
    for (const method of ["serialize", "toJSON", "toObject"]) {
      if (typeof value[method] !== "function") {
        continue;
      }
      try {
        const converted = value[method]();
        if (converted && converted !== value && typeof converted === "object") {
          serializedObjectViewCache.set(value, converted);
          return converted;
        }
      } catch {}
    }
    for (const key of ["attributes", "_attributes"]) {
      const converted = safeGetField(value, key);
      if (converted && converted !== value && typeof converted === "object") {
        serializedObjectViewCache.set(value, converted);
        return converted;
      }
    }
    serializedObjectViewCache.set(value, null);
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

  function phoneNumberToPNJID(value) {
    const jid = jidToString(value);
    if (isPN(jid)) {
      return jid;
    }
    const digits = text(value).replace(/\D/g, "");
    return digits ? `${digits}@s.whatsapp.net` : "";
  }

  function pnFromContact(row) {
    const phone = phoneNumberToPNJID(row.phoneNumber);
    if (phone) {
      return phone;
    }
    const id = jidToString(row.id);
    return isPN(id) ? id : "";
  }

  function contactTextFromSource(source, names) {
    if (!source || typeof source !== "object") {
      return "";
    }
    return text(firstWhatsAppFieldValue(source, names));
  }

  function contactTextFromSources(sources, names) {
    for (const source of sources) {
      const value = contactTextFromSource(source, names);
      if (value) {
        return value;
      }
    }
    return "";
  }

  function contactNestedSources(row) {
    const sources = [];
    if (row && typeof row === "object") {
      sources.push(row);
      for (const key of ["contact", "contactObj", "senderObj", "authorObj", "profile", "chat"]) {
        const nested = firstWhatsAppFieldValue(row, [key]);
        if (nested && typeof nested === "object") {
          sources.push(nested);
        }
      }
    }
    return sources;
  }

  function contactFirstName(row) {
    return contactTextFromSources(contactNestedSources(row), ["firstName", "shortName", "formattedShortName"]);
  }

  function contactFullName(row) {
    return contactTextFromSources(contactNestedSources(row), ["fullName", "name", "displayName", "formattedName", "formattedTitle", "title"]);
  }

  function contactPushName(row) {
    return contactTextFromSources(contactNestedSources(row), ["pushName", "pushname", "notifyName", "notify", "senderName", "formattedUser"]);
  }

  function contactBusinessName(row) {
    return contactTextFromSources(contactNestedSources(row), ["businessName", "verifiedName", "verifiedNameForDisplay", "displayBusinessName"]);
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
      firstName: contactFirstName(row),
      fullName: contactFullName(row),
      pushName: contactPushName(row),
      businessName: contactBusinessName(row),
      phoneNumber: pn
    });
  }

  function mapContactFromChat(row) {
    const jid = jidToString(firstWhatsAppFieldValue(row, ["id", "wid"]));
    const lid = jidToString(firstWhatsAppFieldValue(row, ["accountLid", "lid"]));
    if (!jid && !lid) {
      return null;
    }
    if (jid.endsWith("@g.us")) {
      return null;
    }
    return compactObject({
      jid: jid || lid,
      lid,
      firstName: contactFirstName(row),
      fullName: contactFullName(row),
      pushName: contactPushName(row),
      businessName: contactBusinessName(row)
    });
  }

  function mapChat(row) {
    const jid = jidToString(firstWhatsAppFieldValue(row, ["id", "wid"]));
    if (!jid) {
      return null;
    }
    return compactObject({
      jid,
      lid: jidToString(firstWhatsAppFieldValue(row, ["accountLid", "lid"])),
      name: text(firstWhatsAppFieldValue(row, ["name", "formattedTitle", "displayName"])),
      isGroup: jid.endsWith("@g.us"),
      archived: Boolean(firstWhatsAppFieldValue(row, ["archive", "archived"])),
      pinned: Boolean(firstWhatsAppFieldValue(row, ["pin", "pinned"])),
      mutedUntilMs: timestampMs(firstWhatsAppFieldValue(row, ["muteExpiration", "muteExpirationMs"])),
      lastMessageTimestampMs: timestampMs(firstWhatsAppFieldValue(row, ["t", "timestamp", "lastReceivedKeyTimestamp"]))
    });
  }

  function mapContactFromMessage(message) {
    const jid = text(message?.senderJid);
    const pushName = text(message?.senderName);
    if (!jid || !pushName) {
      return null;
    }
    return compactObject({
      jid,
      pushName
    });
  }

  function mergeContacts(...contactLists) {
    const byJid = new Map();
    for (const contact of contactLists.flat()) {
      const jid = text(contact?.jid);
      if (!jid) {
        continue;
      }
      const existing = byJid.get(jid);
      if (!existing) {
        byJid.set(jid, contact);
        continue;
      }
      byJid.set(jid, {
        ...existing,
        ...contact,
        jid,
        lid: text(contact.lid) || text(existing.lid),
        firstName: text(existing.firstName) || text(contact.firstName),
        fullName: text(existing.fullName) || text(contact.fullName),
        pushName: text(existing.pushName) || text(contact.pushName),
        businessName: text(existing.businessName) || text(contact.businessName),
        phoneNumber: text(existing.phoneNumber) || text(contact.phoneNumber)
      });
    }
    return Array.from(byJid.values());
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
    const converted = serializedObjectView(message);
    return message.key || message.id || message.msgKey ||
      converted?.key || converted?.id || converted?.msgKey || {};
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

  function fieldNameAliases(names) {
    const aliases = [];
    for (const name of names) {
      if (!name) {
        continue;
      }
      aliases.push(name, `__x_${name}`, `_${name}`);
      if (name.length <= 3) {
        aliases.push(name.toUpperCase());
      }
      if (name.charAt(0) === name.charAt(0).toLowerCase()) {
        aliases.push(name.charAt(0).toUpperCase() + name.slice(1));
      }
    }
    return aliases;
  }

  function firstWhatsAppFieldValue(value, names) {
    return firstObjectFieldValue(value, fieldNameAliases(names));
  }

  function mediaDataFromSerializedMessage(message) {
    return firstWhatsAppFieldValue(message, ["mediaData"]);
  }

  function firstMessageValue(row, serializedMessage, mediaData, names) {
    const mediaObject = firstWhatsAppFieldValue(serializedMessage, ["mediaObject"]);
    return firstContentValue(
      firstWhatsAppFieldValue(row, names),
      firstWhatsAppFieldValue(serializedMessage, names),
      firstWhatsAppFieldValue(mediaData, names),
      firstWhatsAppFieldValue(mediaObject, names)
    );
  }

  function collectionModels(collection) {
    if (!collection) {
      return [];
    }
    for (const method of ["getModelsArray", "toArray"]) {
      if (typeof collection[method] !== "function") {
        continue;
      }
      try {
        const models = collection[method]();
        if (Array.isArray(models)) {
          return models.filter((item) => item && typeof item === "object");
        }
      } catch {}
    }
    for (const key of ["models", "_models"]) {
      const models = safeGetField(collection, key);
      if (Array.isArray(models)) {
        return models.filter((item) => item && typeof item === "object");
      }
      if (models && typeof models === "object") {
        return Object.values(models).filter((item) => item && typeof item === "object");
      }
    }
    return [];
  }

  function readStoreChatModels(limit) {
    const collections = getWaModule("WAWebCollections");
    const sources = [
      collections?.Chat,
      collections?.ChatCollection,
      globalThis.Store?.Chat
    ];
    const byJid = new Map();
    for (const source of sources) {
      for (const chat of collectionModels(source)) {
        const mapped = mapChat(chat);
        const jid = text(mapped?.jid);
        if (!jid || byJid.has(jid)) {
          continue;
        }
        byJid.set(jid, chat);
      }
    }
    const chats = Array.from(byJid.values());
    chats.sort((left, right) => timestampMs(firstWhatsAppFieldValue(right, ["t", "timestamp"])) - timestampMs(firstWhatsAppFieldValue(left, ["t", "timestamp"])));
    return chats.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : chats.length);
  }

  function readLatestStoreMessageModels(chatModels, messageGetters, totalLimit) {
    const models = [];
    const chats = Array.isArray(chatModels) ? chatModels : [];
    const seenChats = new Set();
    for (const chat of chats) {
      if (models.length >= totalLimit) {
        break;
      }
      const mappedChat = mapChat(chat);
      const chatKeys = uniqueItems([mappedChat?.jid, mappedChat?.lid].map(text));
      const canonicalChat = chatKeys[0];
      if (!canonicalChat || seenChats.has(canonicalChat)) {
        continue;
      }
      const messageCollection = safeGetField(chat, "msgs");
      // Only inspect already-loaded tail items. Calling loadEarlierMsgs here can
      // freeze large accounts and is unnecessary when the backend needs an anchor.
      const candidates = collectionModels(messageCollection).slice(-5);
      let latest = null;
      for (const model of candidates) {
        const mapped = mapMessage({}, model, messageGetters);
        if (!mapped) {
          continue;
        }
        const belongsToChat = [mapped.chatJid, mapped._sourceFromJid, mapped._sourceToJid]
          .map(text)
          .some((candidate) => chatKeys.includes(candidate));
        if (!belongsToChat) {
          continue;
        }
        if (!latest || timestampMs(mapped.timestampMs) > timestampMs(latest.mapped.timestampMs)) {
          latest = { model, mapped };
        }
      }
      if (latest) {
        seenChats.add(canonicalChat);
        models.push(latest.model);
      }
    }
    return models;
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
    const rowID = firstWhatsAppFieldValue(row, ["id"]);
    const serializedID = firstWhatsAppFieldValue(serializedMessage, ["id"]);
    const mediaData = mediaDataFromSerializedMessage(serializedMessage);
    const id = messageIDToString(rowID) ||
      messageIDToString(firstWhatsAppFieldValue(row, ["messageId"])) ||
      text(firstWhatsAppFieldValue(row, ["externalId"])) ||
      text(firstWhatsAppFieldValue(row, ["internalId"])) ||
      text(key.id) ||
      messageIDToString(serializedID) ||
      messageIDToString(getterId);
    const fromMe = rowID && typeof rowID === "object" && typeof rowID.fromMe === "boolean"
      ? rowID.fromMe
      : typeof rowID === "string"
        ? rowID.startsWith("true_")
        : typeof key.fromMe === "boolean"
          ? key.fromMe
          : Boolean(firstWhatsAppFieldValue(row, ["fromMe"]) || firstWhatsAppFieldValue(serializedMessage, ["fromMe", "isMe"]));
    const sourceFromJid = jidToString(firstWhatsAppFieldValue(row, ["from"])) ||
      jidToString(firstWhatsAppFieldValue(serializedMessage, ["from"]));
    const sourceToJid = jidToString(firstWhatsAppFieldValue(row, ["to"])) ||
      jidToString(firstWhatsAppFieldValue(serializedMessage, ["to"]));
    const chatJid = jidToString(firstWhatsAppFieldValue(row, ["chatId"]) || (rowID && rowID.remote)) ||
      jidToString(key.remoteJid || key.remote) ||
      jidToString(firstWhatsAppFieldValue(serializedMessage, ["chatId", "remoteJid", "remote"])) ||
      jidToString(messageGetterValue(messageGetters, "getRemote", serializedMessage)) ||
      messageChatJIDFromID(rowID) ||
      messageChatJIDFromID(serializedID) ||
      (fromMe ? (sourceToJid || sourceFromJid) : (sourceFromJid || sourceToJid));
    if (!id || !chatJid || isFilteredHistoryChatJID(chatJid)) {
      return null;
    }
    if (isNonZeroMessageStubType(firstWhatsAppFieldValue(row, ["messageStubType", "stubType"]), firstWhatsAppFieldValue(serializedMessage, ["messageStubType", "stubType"]))) {
      return null;
    }
    const mediaMessage = mediaMessageFromPayload(serializedMessage && (serializedMessage.message || serializedMessage.msg || serializedMessage._message));
    const senderJid = jidToString(
      firstWhatsAppFieldValue(row, ["author", "sender"]) ||
      (rowID && rowID.participant) ||
      key.participant ||
      firstWhatsAppFieldValue(serializedMessage, ["author", "sender"]) ||
      messageGetterValue(messageGetters, "getSender", serializedMessage) ||
      messageGetterValue(messageGetters, "getAuthor", serializedMessage) ||
      sourceFromJid
    );
    const senderName = firstText(
      contactTextFromSources(contactNestedSources(row), ["senderName", "notifyName", "pushName", "pushname"]),
      contactTextFromSources(contactNestedSources(serializedMessage), ["senderName", "notifyName", "pushName", "pushname"])
    );
    const getterText = messageGetterText(messageGetters, serializedMessage, ["getBody", "getCaption", "getTitle", "getComment", "getPollName", "getEventName", "getEventDescription"]);
    const messageText = firstText(
      firstWhatsAppFieldValue(row, ["body", "caption", "text"]),
      firstWhatsAppFieldValue(serializedMessage, ["body", "caption", "text", "pollName", "eventName", "eventDescription"]),
      getterText
    ) || textFromSerializedMessage(serializedMessage) || textFromKnownFields(row);
    const contextInfo = contextInfoFromMessage(row, serializedMessage, messageGetters, chatJid);
    const rawType = text(firstWhatsAppFieldValue(row, ["type"])) ||
      text(firstWhatsAppFieldValue(serializedMessage, ["type"])) ||
      text(firstWhatsAppFieldValue(mediaData, ["type"])) ||
      text(messageGetterValue(messageGetters, "getType", serializedMessage));
    const messageType = storedMessageTypeFromWebType(rawType, Boolean(contextInfo));
    if (!EXPORTABLE_MESSAGE_TYPES.has(messageType)) {
      return null;
    }
    const ack = firstContentValue(firstWhatsAppFieldValue(row, ["ack"]), firstWhatsAppFieldValue(serializedMessage, ["ack"]), messageGetterValue(messageGetters, "getAck", serializedMessage));
    const mediaContent = compactObject({
      body: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["body"]), mediaMessage.body),
      text: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["text"]), mediaMessage.text),
      caption: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["caption"]), mediaMessage.caption),
      URL: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["deprecatedMms3Url", "url", "URL"]), messageGetterValue(messageGetters, "getDeprecatedMms3Url", serializedMessage), mediaMessage.url),
      mimetype: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["mimetype", "mimeType"]), messageGetterValue(messageGetters, "getMimetype", serializedMessage), mediaMessage.mimetype),
      fileSHA256: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["fileSHA256", "fileSha256", "filehash", "fileHash"]), messageGetterValue(messageGetters, "getFilehash", serializedMessage), mediaMessage.fileSHA256, mediaMessage.fileSha256, mediaMessage.filehash),
      fileEncSHA256: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["fileEncSHA256", "fileEncSha256", "fileEncHash", "encFilehash", "encFileHash"]), mediaMessage.fileEncSHA256, mediaMessage.fileEncSha256, mediaMessage.fileEncHash),
      mediaKey: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["mediaKey"]), mediaMessage.mediaKey),
      fileLength: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["fileLength", "size"]), mediaMessage.fileLength, mediaMessage.size),
      seconds: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["seconds", "duration"]), mediaMessage.seconds, mediaMessage.duration),
      directPath: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["directPath"]), mediaMessage.directPath),
      mediaKeyTimestamp: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["mediaKeyTimestamp", "mediaKeyTimestampMs"]), mediaMessage.mediaKeyTimestamp),
      thumbnail: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["thumbnail"]), mediaMessage.thumbnail),
      JPEGThumbnail: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["JPEGThumbnail", "jpegThumbnail"]), mediaMessage.JPEGThumbnail, mediaMessage.jpegThumbnail),
      thumbnailDirectPath: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["thumbnailDirectPath"]), mediaMessage.thumbnailDirectPath),
      thumbnailSHA256: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["thumbnailSHA256", "thumbnailSha256"]), mediaMessage.thumbnailSHA256, mediaMessage.thumbnailSha256),
      thumbnailEncSHA256: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["thumbnailEncSHA256", "thumbnailEncSha256"]), mediaMessage.thumbnailEncSHA256, mediaMessage.thumbnailEncSha256),
      thumbnailHeight: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["thumbnailHeight"]), mediaMessage.thumbnailHeight),
      thumbnailWidth: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["thumbnailWidth"]), mediaMessage.thumbnailWidth),
      pngThumbnail: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["pngThumbnail"]), mediaMessage.pngThumbnail),
      waveform: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["waveform"]), mediaMessage.waveform),
      title: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["title"]), mediaMessage.title),
      fileName: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["fileName", "filename"]), mediaMessage.fileName),
      pageCount: firstContentValue(firstMessageValue(row, serializedMessage, mediaData, ["pageCount"]), mediaMessage.pageCount)
    });
    const content = messageContentForStoredType(messageType, messageText, mediaContent, contextInfo, rawType);
    const messageTimestampMs = timestampMs(firstDefined(
      firstWhatsAppFieldValue(row, ["t", "timestamp", "messageTimestamp"]),
      messageGetterValue(messageGetters, "getT", serializedMessage),
      firstWhatsAppFieldValue(serializedMessage, ["t", "timestamp", "messageTimestamp"])
    ));
    const webMessage = webMessageFromStoredContent({
      id,
      chatJid,
      senderJid,
      fromMe,
      timestampMs: messageTimestampMs,
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
      senderName,
      fromMe,
      timestampMs: messageTimestampMs,
      type: messageType,
      text: messageText,
      content,
      webMessage,
      _sourceFromJid: sourceFromJid,
      _sourceToJid: sourceToJid
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

  function mergeChatsByJid(...chatLists) {
    const byJid = new Map();
    for (const chat of chatLists.flat()) {
      const jid = text(chat?.jid);
      if (!jid) {
        continue;
      }
      const existing = byJid.get(jid);
      if (!existing) {
        byJid.set(jid, chat);
        continue;
      }
      byJid.set(jid, {
        ...existing,
        ...chat,
        name: text(chat.name) || text(existing.name),
        lid: text(chat.lid) || text(existing.lid),
        lastMessageTimestampMs: Math.max(timestampMs(existing.lastMessageTimestampMs), timestampMs(chat.lastMessageTimestampMs))
      });
    }
    return Array.from(byJid.values());
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

  function messageRowSummary(row) {
    const rowID = firstWhatsAppFieldValue(row, ["id"]);
    const sourceFromJid = jidToString(firstWhatsAppFieldValue(row, ["from"]));
    const sourceToJid = jidToString(firstWhatsAppFieldValue(row, ["to"]));
    const fromMe = rowID && typeof rowID === "object" && typeof rowID.fromMe === "boolean"
      ? rowID.fromMe
      : typeof rowID === "string"
        ? rowID.startsWith("true_")
        : Boolean(firstWhatsAppFieldValue(row, ["fromMe"]));
    const chatJid = jidToString(firstWhatsAppFieldValue(row, ["chatId"]) || (rowID && rowID.remote)) ||
      messageChatJIDFromID(rowID) ||
      (fromMe ? (sourceToJid || sourceFromJid) : (sourceFromJid || sourceToJid));
    const id = messageIDToString(rowID) ||
      messageIDToString(firstWhatsAppFieldValue(row, ["messageId"])) ||
      text(firstWhatsAppFieldValue(row, ["externalId"])) ||
      text(firstWhatsAppFieldValue(row, ["internalId"]));
    return {
      id,
      chatJids: uniqueItems([chatJid, sourceFromJid, sourceToJid].map(text)),
      timestampMs: timestampMs(firstDefined(firstWhatsAppFieldValue(row, ["t", "timestamp", "messageTimestamp"])))
    };
  }

  async function readRecentMessageRowsForChats(dbName, storeName, chats, limit, maxScanned) {
    const targetChatByAlias = new Map();
    const canonicalChats = new Set();
    for (const chat of Array.isArray(chats) ? chats : []) {
      const jid = text(chat?.jid);
      const lid = text(chat?.lid);
      const canonical = jid || lid;
      if (!canonical) {
        continue;
      }
      canonicalChats.add(canonical);
      for (const alias of [jid, lid].filter(Boolean)) {
        targetChatByAlias.set(alias, canonical);
      }
    }
    const wantedCount = Math.max(0, Math.min(Math.floor(limit || 0), canonicalChats.size || Math.floor(limit || 0)));
    if (wantedCount === 0) {
      return [];
    }
    if (targetChatByAlias.size === 0) {
      return readStore(dbName, storeName, wantedCount, "prev");
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
      const selectedByChat = new Map();
      let scanned = 0;
      await new Promise((resolve, reject) => {
        // Prefer recent rows from chats we know about. If the local store has no
        // useful index or no matches, we fall back to a generic recent scan below.
        const request = source.openCursor(null, "prev");
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || scanned >= maxScanned || (orderedByTimestamp && selectedByChat.size >= wantedCount)) {
            resolve();
            return;
          }
          scanned += 1;
          const summary = messageRowSummary(cursor.value);
          const chatAlias = summary.chatJids.find((candidate) => targetChatByAlias.has(candidate));
          const canonicalChat = chatAlias ? targetChatByAlias.get(chatAlias) : "";
          if (canonicalChat && summary.id) {
            const existing = selectedByChat.get(canonicalChat);
            if (!existing || summary.timestampMs > existing.summary.timestampMs) {
              selectedByChat.set(canonicalChat, { row: cursor.value, summary });
            }
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error(`Falha ao ler ${storeName}`));
      });
      const selectedRows = Array.from(selectedByChat.values())
        .sort((left, right) => timestampMs(right.summary.timestampMs) - timestampMs(left.summary.timestampMs))
        .slice(0, wantedCount)
        .map((item) => item.row);
      if (selectedRows.length === 0) {
        return readStore(dbName, storeName, wantedCount, "prev");
      }
      return selectedRows;
    } finally {
      db.close();
    }
  }

  function limitHistoryAnchors(history, limit) {
    // Final safety pass inside the page context: emit recent chats plus one
    // latest message per chat. The message is an anchor, not a full transcript.
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
      if (!existing || normalized.timestampMs > Number(existing.timestampMs || 0)) {
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

    const hasChatForMessageJID = (jid) => {
      if (chatByJid.has(jid)) {
        return true;
      }
      for (const chat of chatByJid.values()) {
        if (text(chat?.lid) === jid) {
          return true;
        }
      }
      return false;
    };

    for (const message of latestMessageByChat.values()) {
      if (!hasChatForMessageJID(message.chatJid)) {
        chatByJid.set(message.chatJid, {
          jid: message.chatJid,
          isGroup: message.chatJid.endsWith("@g.us"),
          lastMessageTimestampMs: timestampMs(message.timestampMs)
        });
      }
    }

    const latestMessageForChat = (chat) => {
      let latest = null;
      for (const chatKey of [chat?.jid, chat?.lid].filter(Boolean)) {
        const candidate = latestMessageByChat.get(chatKey);
        if (!candidate) {
          continue;
        }
        if (!latest || Number(candidate.timestampMs || 0) > Number(latest.timestampMs || 0)) {
          latest = candidate;
        }
      }
      return latest;
    };

    const chats = Array.from(chatByJid.values()).filter((chat) =>
      [chat.jid, chat.lid].filter(Boolean).some((chatKey) => messagesByChat.has(chatKey))
    );
    chats.sort((left, right) => {
      const leftMessage = latestMessageForChat(left);
      const rightMessage = latestMessageForChat(right);
      const leftTimestamp = Math.max(timestampMs(left.lastMessageTimestampMs), Number(leftMessage?.timestampMs || 0));
      const rightTimestamp = Math.max(timestampMs(right.lastMessageTimestampMs), Number(rightMessage?.timestampMs || 0));
      return rightTimestamp - leftTimestamp;
    });

    const selectedChats = chats.slice(0, Math.max(0, limit));
    const selectedMessages = [];
    const selectedMessageKeys = new Set();
    for (const chat of selectedChats) {
      // Do not send every locally discovered message. Other APIs should use this
      // latest message id/timestamp as an anchor and backfill with their library.
      const message = latestMessageForChat(chat);
      if (!message) {
        continue;
      }
      const messageKey = `${message.chatJid}\u0000${message.id}`;
      if (!selectedMessageKeys.has(messageKey)) {
        selectedMessageKeys.add(messageKey);
        selectedMessages.push(message);
      }
    }
    selectedMessages.sort((left, right) => Number(right.timestampMs || 0) - Number(left.timestampMs || 0));
    return { chats: selectedChats, messages: selectedMessages };
  }

  async function run() {
    const contactRows = await readStore("model-storage", "contact", LIMITS.contacts);
    const chatRows = await readStore("model-storage", "chat", LIMITS.chats);
    const contactStoreContacts = contactRows.map(mapContact).filter(Boolean);
    const chatContactHints = chatRows.map(mapContactFromChat).filter(Boolean);
    const privacyTokens = chatRows.map(mapPrivacyToken).filter(Boolean);

    const messageSerializer = getWaModule("WAWebDBMessageSerialization");
    const messageGetters = getWaModule("WAWebMsgGetters");
    const storeChatModels = readStoreChatModels(LIMITS.historyChats);
    const storeChatContactHints = storeChatModels.map(mapContactFromChat).filter(Boolean);
    const dbChats = chatRows.map(mapChat).filter(Boolean);
    const storeChats = storeChatModels.map(mapChat).filter(Boolean);
    const chats = mergeChatsByJid(dbChats, storeChats);
    const recentChats = selectRecentHistoryChats(chats, LIMITS.historyChats);
    const messageRows = await readRecentMessageRowsForChats(
      "model-storage",
      "message",
      recentChats,
      LIMITS.messages,
      LIMITS.messageScan
    );
    let serializedMessageRows = 0;
    let serializedMessageRowsWithText = 0;
    const storeMessageModels = readLatestStoreMessageModels(storeChatModels, messageGetters, LIMITS.messages);
    const messageByChat = new Map();
    const addMessage = (mapped) => {
      const chatJid = text(mapped?.chatJid);
      const id = text(mapped?.id);
      if (!chatJid || !id) {
        return;
      }
      const existing = messageByChat.get(chatJid);
      const mappedTimestamp = timestampMs(mapped.timestampMs);
      const existingTimestamp = timestampMs(existing?.timestampMs);
      if (
        !existing ||
        mappedTimestamp > existingTimestamp ||
        (mappedTimestamp === existingTimestamp && !text(existing.text) && text(mapped.text))
      ) {
        messageByChat.set(chatJid, mapped);
      }
    };
    for (const model of storeMessageModels) {
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
    const messages = Array.from(messageByChat.values())
      .sort((left, right) => timestampMs(right.timestampMs) - timestampMs(left.timestampMs));
    const messageContactHints = messages.map(mapContactFromMessage).filter(Boolean);
    const contacts = mergeContacts(contactStoreContacts, chatContactHints, storeChatContactHints, messageContactHints);
    const history = limitHistoryAnchors({ chats: recentChats.length > 0 ? recentChats : chats, messages }, LIMITS.historyChats);

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
        mode: "history",
        contactRows: contactRows.length,
        chatRows: chatRows.length,
        storeChatModels: storeChatModels.length,
        messageRows: messageRows.length,
        storeMessageModels: storeMessageModels.length,
        messageRowsSerialized: serializedMessageRows,
        messageRowsSerializedWithText: serializedMessageRowsWithText,
        messageRowsDecrypted: 0,
        messageRowsDecryptedWithText: 0,
        contactStoreContacts: contactStoreContacts.length,
        chatContactHints: chatContactHints.length,
        storeChatContactHints: storeChatContactHints.length,
        messageContactHints: messageContactHints.length,
        contacts: contacts.length,
        contactsWithFullName: contacts.filter((contact) => text(contact.fullName)).length,
        contactsWithPushName: contacts.filter((contact) => text(contact.pushName)).length,
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
