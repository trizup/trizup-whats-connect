// @ts-nocheck
import { IMPORT_HISTORY_CHAT_LIMIT, WHATSAPP_LOGGED_IN_SELECTORS, WHATSAPP_QR_HINTS } from "../shared/config";
import { clearWhatsAppWebLocalSessionData } from "./page-scripts/clear-local-session";
import { extractWhatsAppWebSidecarDump } from "./page-scripts/extract-history";
import { extractWhatsAppWebMainDump } from "./page-scripts/extract-session";
import { extractWhatsAppWebStorageInventory } from "./page-scripts/storage-inventory";

export async function executeScriptInPage(tabId, func, args = []) {
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

export async function isWhatsAppWebLoggedInTab(tabId) {
  const [result] = await executeScriptInPage(tabId, (selectors, qrHints) => {
    const text = String(document.body?.innerText || "").toLowerCase();
    const hasQrCanvas = Array.from(document.querySelectorAll("canvas, [data-testid], [aria-label]")).some((element) => {
      const testId = String(element.getAttribute("data-testid") || "").toLowerCase();
      const aria = String(element.getAttribute("aria-label") || "").toLowerCase();
      return testId.includes("qr") || aria.includes("qr") || aria.includes("scan");
    });
    if (hasQrCanvas || qrHints.some((hint) => text.includes(hint))) {
      return false;
    }
    return selectors.some((selector) => {
      try {
        return Boolean(document.querySelector(selector));
      } catch {
        return false;
      }
    });
  }, [WHATSAPP_LOGGED_IN_SELECTORS, WHATSAPP_QR_HINTS]);
  return result?.result === true;
}

export async function extractInventoryFromTab(tabId) {
  const [result] = await executeScriptInPage(tabId, extractWhatsAppWebStorageInventory);
  if (!result || !result.result) {
    throw new Error("Não foi possível diagnosticar o armazenamento");
  }
  if (result.result.error) {
    throw new Error(result.result.error);
  }
  return result.result.inventory;
}

export async function extractSidecarFromTab(tabId, options = {}) {
  const [result] = await executeScriptInPage(tabId, extractWhatsAppWebSidecarDump, [{
    historyChatLimit: IMPORT_HISTORY_CHAT_LIMIT,
    ...options
  }]);
  if (!result || !result.result) {
    throw new Error("Não foi possível capturar o histórico");
  }
  if (result.result.error) {
    throw new Error(result.result.error);
  }
  return result.result.dump;
}

export async function extractMainDumpFromTab(tabId, options = {}) {
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

export async function clearWhatsAppWebLocalSessionFromTab(tab) {
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
  return result.result.summary || { method: "page" };
}
