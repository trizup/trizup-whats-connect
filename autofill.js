(() => {
  if (window.__sessionConnectorLoaded) {
    return;
  }
  window.__sessionConnectorLoaded = true;

  const CLIENT_PARAM = "client";
  const TOKEN_PARAM = "token";
  const WHATSAPP_WEB_ORIGIN = "https://web.whatsapp.com";
  const PANEL_HOST_ID = "session-connector-panel";
  const LOGIN_CHECK_DELAY_MS = 350;
  const INITIAL_LOGIN_CHECKS = 30;
  const INITIAL_LOGIN_CHECK_INTERVAL_MS = 500;
  const DEV_MODE_TOGGLE_CLICKS = 5;
  const DEV_MODE_TOGGLE_WINDOW_MS = 2500;
  const LOGGED_IN_SELECTORS = [
    "#side",
    "#pane-side",
    '[data-testid="chat-list"]',
    '[data-testid="conversation-panel-wrapper"]',
    '[aria-label="Chat list"]',
    '[aria-label="Lista de conversas"]',
    '[aria-label="Chats"]',
    '[aria-label="Conversas"]'
  ];
  const QR_HINTS = [
    "qr code",
    "scan the qr",
    "use whatsapp on your computer",
    "link with phone number",
    "escaneie",
    "codigo qr",
    "conectar um aparelho",
    "vincular aparelho"
  ];

  const state = {
    host: null,
    root: null,
    autoOpened: false,
    dismissed: false,
    importRunning: false,
    importPort: null,
    loginTimer: null,
    loginPollTimer: null,
    loginPollAttempts: 0,
    themeObserver: null,
    cleanupStarted: false,
    devMode: false,
    devModeClickCount: 0,
    devModeClickTimer: null
  };

  function parseAutofillHash(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl || ""));
    } catch {
      return null;
    }

    if (url.origin !== WHATSAPP_WEB_ORIGIN) {
      return null;
    }

    const rawHash = url.hash ? url.hash.slice(1) : "";
    if (!rawHash) {
      return null;
    }

    const params = new URLSearchParams(rawHash.startsWith("?") ? rawHash.slice(1) : rawHash);
    const hasClient = params.has(CLIENT_PARAM);
    const hasToken = params.has(TOKEN_PARAM);
    if (!hasClient && !hasToken) {
      return null;
    }

    return {
      client: String(params.get(CLIENT_PARAM) || "").trim(),
      token: String(params.get(TOKEN_PARAM) || "").trim(),
      hasClient,
      hasToken
    };
  }

  function cleanAutofillHash() {
    let url;
    try {
      url = new URL(location.href);
    } catch {
      return;
    }

    const rawHash = url.hash ? url.hash.slice(1) : "";
    if (!rawHash) {
      return;
    }

    const params = new URLSearchParams(rawHash.startsWith("?") ? rawHash.slice(1) : rawHash);
    let changed = false;
    for (const key of [CLIENT_PARAM, TOKEN_PARAM]) {
      if (params.has(key)) {
        params.delete(key);
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    const nextHash = params.toString();
    url.hash = nextHash ? nextHash : "";
    history.replaceState(history.state, document.title || "", url.toString());
  }

  async function applyAutofillFromUrl() {
    const autofill = parseAutofillHash(location.href);
    if (!autofill) {
      return false;
    }

    cleanAutofillHash();
    if (!autofill.client) {
      return false;
    }

    await chrome.storage.local.set({
      serverUrl: autofill.client,
      instanceToken: autofill.token || ""
    });
    return true;
  }

  function pageText() {
    return String(document.body?.innerText || "").toLowerCase();
  }

  function hasQrCanvas() {
    return Array.from(document.querySelectorAll("canvas, [data-testid], [aria-label]")).some((element) => {
      const testId = String(element.getAttribute("data-testid") || "").toLowerCase();
      const aria = String(element.getAttribute("aria-label") || "").toLowerCase();
      return testId.includes("qr") || aria.includes("qr") || aria.includes("scan");
    });
  }

  function isQrLoginScreen() {
    const text = pageText();
    return hasQrCanvas() || QR_HINTS.some((hint) => text.includes(hint));
  }

  function isWhatsAppLoggedIn() {
    if (isQrLoginScreen()) {
      return false;
    }
    return LOGGED_IN_SELECTORS.some((selector) => {
      try {
        return Boolean(document.querySelector(selector));
      } catch {
        return false;
      }
    });
  }

  function isColorDark(value) {
    const raw = String(value || "").trim();
    let r;
    let g;
    let b;
    const rgb = raw.match(/^rgba?\(([^)]+)\)$/i);
    if (rgb) {
      const parts = rgb[1].split(",").map((part) => parseFloat(part));
      [r, g, b] = parts;
    } else {
      const hex = raw.replace(/^#/, "");
      if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
      } else if (hex.length >= 6) {
        r = parseInt(hex.slice(0, 2), 16);
        g = parseInt(hex.slice(2, 4), 16);
        b = parseInt(hex.slice(4, 6), 16);
      } else {
        return null;
      }
    }
    if (![r, g, b].every(Number.isFinite)) {
      return null;
    }
    const luminance = ((0.2126 * r) + (0.7152 * g) + (0.0722 * b)) / 255;
    return luminance < 0.5;
  }

  function isWhatsAppDarkTheme() {
    // O WhatsApp marca o tema escuro com a classe "dark" no <body>; no claro fica sem classe.
    const classes = `${document.body?.className || ""} ${document.documentElement?.className || ""}`.toLowerCase();
    if (/(^|[\s-])dark($|[\s-])/.test(classes)) {
      return true;
    }
    if (/(^|[\s-])light($|[\s-])/.test(classes)) {
      return false;
    }
    // Sem classe explícita: infere pela cor real da superfície do WhatsApp (não pelo tema do SO).
    const source = document.documentElement || document.body;
    if (source) {
      const style = getComputedStyle(source);
      const surface =
        style.getPropertyValue("--WDS-surface-default") ||
        style.getPropertyValue("--app-background") ||
        (document.body ? getComputedStyle(document.body).backgroundColor : "");
      const dark = isColorDark(surface);
      if (dark != null) {
        return dark;
      }
    }
    return false;
  }

  function applyThemeClass() {
    if (state.host) {
      state.host.dataset.theme = isWhatsAppDarkTheme() ? "dark" : "light";
    }
  }

  function startThemeWatch() {
    applyThemeClass();
    if (!state.themeObserver && typeof MutationObserver === "function") {
      state.themeObserver = new MutationObserver(applyThemeClass);
      for (const target of [document.documentElement, document.body]) {
        if (target) {
          state.themeObserver.observe(target, { attributes: true, attributeFilter: ["class"] });
        }
      }
    }
  }

  function stopThemeWatch() {
    if (state.themeObserver) {
      state.themeObserver.disconnect();
      state.themeObserver = null;
    }
  }

  function iconClose() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    `;
  }

  function iconEye() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
        <circle cx="12" cy="12" r="3" />
        <line class="eye-off" x1="4" y1="20" x2="20" y2="4" />
      </svg>
    `;
  }

  function iconImport() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 4v10" />
        <path d="m8 10 4 4 4-4" />
        <path d="M6 18h12" />
      </svg>
    `;
  }

  function panelTemplate() {
    return `
      <style>
        :host {
          all: initial;
          color-scheme: light;
          /* WhatsApp Web (WDS) - tema claro (valores exatos dos tokens) */
          --connector-panel: #ffffff;
          --connector-topbar: #f7f5f3;
          --connector-input: #f0f2f5;
          --connector-text: #0a0a0a;
          --connector-muted: rgba(0, 0, 0, 0.6);
          --connector-line: rgba(0, 0, 0, 0.1);
          --connector-panel-border: rgba(0, 0, 0, 0.1);
          --connector-accent: #1daa61;
          --connector-accent-hover: #1b8755;
          --connector-accent-text: #ffffff;
          --connector-hover: rgba(194, 189, 184, 0.15);
          --connector-notice: #f7f5f3;
          --connector-focus: rgba(29, 170, 97, 0.3);
          --connector-danger: #ea0038;
          --connector-danger-soft: #fde8eb;
          --connector-ok: #1b8755;
          --connector-ok-soft: #e7fce3;
          --connector-warn: #a5691b;
          --connector-warn-soft: #fff7e5;
          --connector-warn-border: rgba(197, 135, 48, 0.35);
          --connector-shadow: 0 16px 44px rgba(11, 20, 26, 0.22), 0 0 22px rgba(29, 170, 97, 0.18);
          --connector-primary-shadow: rgba(29, 170, 97, 0.2);
          --connector-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          display: block;
          font-family: var(--connector-font);
          pointer-events: auto;
          position: fixed;
          right: 20px;
          top: 20px;
          z-index: 2147483647;
        }

        :host([data-theme="dark"]) {
          color-scheme: dark;
          /* WhatsApp Web (WDS) - tema escuro (valores exatos dos tokens) */
          --connector-panel: #1d1f1f;
          --connector-topbar: #1d1f1f;
          --connector-input: #242626;
          --connector-text: #fafafa;
          --connector-muted: rgba(255, 255, 255, 0.6);
          --connector-line: rgba(255, 255, 255, 0.1);
          --connector-accent: #21c063;
          --connector-accent-hover: #1daa61;
          --connector-accent-text: #0a0a0a;
          --connector-hover: rgba(255, 255, 255, 0.1);
          --connector-notice: #161717;
          --connector-focus: rgba(33, 192, 99, 0.3);
          --connector-danger: #fb5061;
          --connector-danger-soft: #321622;
          --connector-ok: #71eb85;
          --connector-ok-soft: #103529;
          --connector-warn: #ffd279;
          --connector-warn-soft: #362c1f;
          --connector-warn-border: rgba(255, 210, 121, 0.32);
          --connector-panel-border: rgba(33, 192, 99, 0.28);
          --connector-shadow: 0 18px 46px rgba(0, 0, 0, 0.6), 0 0 30px rgba(33, 192, 99, 0.28);
          --connector-primary-shadow: rgba(33, 192, 99, 0.24);
        }

        * {
          box-sizing: border-box;
        }

        [hidden] {
          display: none !important;
        }

        .panel {
          background: var(--connector-panel);
          border: 1px solid var(--connector-panel-border);
          border-radius: 8px;
          box-shadow: var(--connector-shadow);
          color: var(--connector-text);
          display: grid;
          max-height: calc(100vh - 32px);
          overflow: hidden;
          pointer-events: auto;
          width: min(368px, calc(100vw - 32px));
        }

        .topbar {
          align-items: center;
          background: var(--connector-topbar);
          border-bottom: 1px solid var(--connector-line);
          display: flex;
          gap: 12px;
          justify-content: space-between;
          min-height: 68px;
          padding: 14px 16px;
        }

        .brand {
          align-items: center;
          cursor: pointer;
          display: grid;
          gap: 10px;
          grid-template-columns: 36px minmax(0, 1fr);
          min-width: 0;
        }

        .mark {
          align-items: center;
          background: var(--connector-accent);
          border-radius: 8px;
          color: var(--connector-accent-text);
          display: flex;
          font-family: var(--connector-font);
          font-size: 18px;
          font-weight: 700;
          line-height: 1;
          height: 36px;
          justify-content: center;
          width: 36px;
        }

        .mark svg {
          fill: none;
          height: 21px;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 2.2;
          width: 21px;
        }

        .title {
          color: var(--connector-text);
          display: block;
          font-size: 16px;
          font-weight: 700;
          letter-spacing: 0;
          line-height: 1.2;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .subtitle {
          color: var(--connector-muted);
          display: block;
          font-size: 12px;
          letter-spacing: 0;
          line-height: 1.3;
          margin-top: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .icon-button {
          align-items: center;
          background: transparent;
          border: 0;
          border-radius: 6px;
          color: var(--connector-muted);
          cursor: pointer;
          display: inline-flex;
          flex: 0 0 auto;
          height: 34px;
          justify-content: center;
          margin: 0;
          padding: 0;
          width: 34px;
        }

        .icon-button:hover,
        .icon-button:focus-visible {
          background: var(--connector-hover);
          color: var(--connector-text);
          outline: none;
        }

        .icon-button svg,
        .token-toggle svg {
          fill: none;
          height: 18px;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 2;
          width: 18px;
        }

        form {
          display: grid;
          gap: 14px;
          max-height: calc(100vh - 180px);
          overflow-y: auto;
          padding: 16px 18px 18px;
        }

        label {
          color: var(--connector-text);
          display: grid;
          font-size: 12px;
          font-weight: 700;
          gap: 6px;
          letter-spacing: 0;
        }

        input {
          background: var(--connector-input);
          border: 1px solid transparent;
          border-radius: 8px;
          color: var(--connector-text);
          font-family: var(--connector-font);
          font-size: 14px;
          line-height: 1.45;
          height: 40px;
          letter-spacing: 0;
          outline: none;
          padding: 0 11px;
          transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
          width: 100%;
        }

        input:focus {
          background: var(--connector-input);
          border-color: var(--connector-accent);
          box-shadow: 0 0 0 3px var(--connector-focus);
        }

        input:disabled {
          background: var(--connector-input);
          color: var(--connector-muted);
          cursor: not-allowed;
        }

        .token-field {
          display: block;
          position: relative;
        }

        .token-field input {
          padding-right: 44px;
        }

        .token-toggle {
          align-items: center;
          background: transparent;
          border: 0;
          border-radius: 4px;
          color: var(--connector-muted);
          cursor: pointer;
          display: inline-flex;
          height: 34px;
          justify-content: center;
          margin: 0;
          padding: 0;
          position: absolute;
          right: 3px;
          top: 3px;
          width: 38px;
        }

        .token-toggle:hover,
        .token-toggle:focus-visible {
          background: var(--connector-hover);
          box-shadow: 0 0 0 2px var(--connector-focus);
          color: var(--connector-text);
          outline: none;
        }

        .token-toggle .eye-off {
          display: none;
        }

        .token-toggle.is-visible .eye-off {
          display: block;
        }

        .check {
          align-items: center;
          cursor: pointer;
          display: grid;
          font-size: 13px;
          font-weight: 700;
          gap: 9px;
          grid-template-columns: 16px minmax(0, 1fr);
          line-height: 1.35;
          min-height: 20px;
        }

        .check input[type="checkbox"] {
          appearance: none;
          background: transparent;
          border: 1px solid var(--connector-muted);
          border-radius: 3px;
          cursor: pointer;
          display: grid;
          height: 16px;
          margin: 0;
          min-height: 16px;
          min-width: 16px;
          padding: 0;
          place-content: center;
          width: 16px;
        }

        .check input[type="checkbox"]::before {
          border-bottom: 2px solid var(--connector-accent-text);
          border-right: 2px solid var(--connector-accent-text);
          content: "";
          height: 8px;
          margin-bottom: 3px;
          transform: rotate(45deg) scale(0);
          width: 5px;
        }

        .check input[type="checkbox"]:checked {
          background: var(--connector-accent);
          border-color: var(--connector-accent);
        }

        .check input[type="checkbox"]:checked::before {
          transform: rotate(45deg) scale(1);
        }

        .check input[type="checkbox"]:focus-visible {
          box-shadow: 0 0 0 3px var(--connector-focus);
          outline: none;
        }

        .actions {
          display: grid;
          gap: 9px;
        }

        .primary,
        .secondary {
          align-items: center;
          background: var(--connector-accent);
          border: 0;
          border-radius: 6px;
          color: var(--connector-accent-text);
          cursor: pointer;
          display: inline-flex;
          font-family: var(--connector-font);
          font-size: 14px;
          font-weight: 700;
          line-height: 1;
          height: 42px;
          justify-content: center;
          letter-spacing: 0;
          margin: 0;
          padding: 0 14px;
          transition: background 120ms ease, box-shadow 120ms ease, transform 120ms ease;
          width: 100%;
        }

        .primary:hover,
        .primary:focus-visible {
          background: var(--connector-accent-hover);
          box-shadow: 0 8px 18px var(--connector-primary-shadow);
          outline: none;
        }

        .secondary {
          background: transparent;
          border: 1px solid var(--connector-line);
          color: var(--connector-text);
        }

        .secondary:hover,
        .secondary:focus-visible {
          background: var(--connector-hover);
          box-shadow: none;
          outline: none;
        }

        .primary:active,
        .secondary:active {
          transform: translateY(1px);
        }

        .primary:disabled,
        .secondary:disabled {
          background: var(--connector-input);
          color: var(--connector-muted);
          box-shadow: none;
          cursor: not-allowed;
          transform: none;
        }

        .notice {
          background: var(--connector-notice);
          border: 1px solid var(--connector-line);
          border-radius: 8px;
          color: var(--connector-muted);
          font-family: var(--connector-font);
          font-size: 12px;
          line-height: 1.45;
          letter-spacing: 0;
          margin: 0;
          padding: 9px 11px;
        }

        .notice strong {
          color: var(--connector-text);
        }

        .notice.warn {
          background: var(--connector-warn-soft);
          border-color: var(--connector-warn-border);
          color: var(--connector-warn);
        }

        .notice.warn strong {
          color: var(--connector-warn);
        }

        .result {
          background: var(--connector-notice);
          border-top: 1px solid var(--connector-line);
          color: var(--connector-muted);
          font-family: var(--connector-font);
          font-size: 12px;
          line-height: 1.45;
          letter-spacing: 0;
          margin: 0;
          overflow-wrap: anywhere;
          padding: 12px 18px;
        }

        .result:empty {
          display: none;
        }

        .result.ok {
          background: var(--connector-ok-soft);
          color: var(--connector-ok);
        }

        .result.error {
          background: var(--connector-danger-soft);
          color: var(--connector-danger);
        }

        .meta {
          align-items: center;
          border-top: 1px solid var(--connector-line);
          color: var(--connector-muted);
          display: flex;
          font-family: var(--connector-font);
          font-size: 12px;
          line-height: 1.35;
          justify-content: space-between;
          letter-spacing: 0;
          min-height: 38px;
          padding: 9px 18px 10px;
        }

        @media (max-width: 480px) {
          :host {
            top: 12px;
            left: 12px;
            right: 12px;
          }

          .panel {
            width: auto;
          }
        }
      </style>

      <section class="panel" role="dialog" aria-label="Migrar sessão">
        <header class="topbar">
          <div id="devModeToggleArea" class="brand" title="Modo técnico">
            <span class="mark" aria-hidden="true">${iconImport()}</span>
            <span>
              <span class="title">Migrar sessão</span>
              <span id="statusLabel" class="subtitle">WhatsApp Web conectado</span>
            </span>
          </div>
          <button id="closeButton" class="icon-button" type="button" aria-label="Fechar painel" title="Fechar painel">
            ${iconClose()}
          </button>
        </header>

        <form id="importForm">
          <label>
            Cliente
            <input id="serverUrlInput" type="text" autocomplete="off" spellcheck="false" placeholder="cliente" />
          </label>
          <label>
            Token da instância
            <span class="token-field">
              <input id="instanceTokenInput" type="password" autocomplete="off" placeholder="token" />
              <button
                id="tokenVisibilityButton"
                class="token-toggle"
                type="button"
                aria-label="Mostrar token"
                aria-pressed="false"
                title="Mostrar token"
              >
                ${iconEye()}
              </button>
            </span>
          </label>
          <label class="check">
            <input id="includeHistoryCheckbox" type="checkbox" checked />
            <span>Incluir histórico de mensagens</span>
          </label>
          <label id="disconnectLocalOption" class="check dev-only" hidden>
            <input id="disconnectLocalCheckbox" type="checkbox" checked />
            <span>Apagar a sessão local após importar</span>
          </label>
          <div class="actions">
            <button id="importButton" class="primary" type="submit">Migrar sessão</button>
            <button id="diagnoseButton" class="secondary dev-only" type="button" hidden>Baixar diagnóstico</button>
            <button id="dumpButton" class="secondary dev-only" type="button" hidden>Baixar histórico</button>
            <button id="mainDumpButton" class="secondary dev-only" type="button" hidden>Baixar sessão</button>
            <button id="exitDevModeButton" class="secondary dev-only" type="button" hidden>Sair do modo técnico</button>
          </div>
          <p id="cleanupNotice" class="notice"></p>
        </form>

        <p id="result" class="result" aria-live="polite"></p>
        <footer class="meta">
          <span id="modeLabel">Modo padrão</span>
          <span>Versão <span id="extensionVersion">--</span></span>
        </footer>
      </section>
    `;
  }

  function panelEl(id) {
    return state.root?.getElementById(id) || null;
  }

  function setResult(message, kind = "") {
    const result = panelEl("result");
    if (!result) {
      return;
    }
    result.textContent = message || "";
    result.className = kind ? `result ${kind}` : "result";
  }

  function setStatus(message) {
    const label = panelEl("statusLabel");
    if (label) {
      label.textContent = message || "WhatsApp Web conectado";
    }
  }

  function setBusy(busy) {
    state.importRunning = Boolean(busy);
    for (const id of [
      "serverUrlInput",
      "instanceTokenInput",
      "includeHistoryCheckbox",
      "disconnectLocalCheckbox",
      "importButton",
      "diagnoseButton",
      "dumpButton",
      "mainDumpButton",
      "exitDevModeButton",
      "tokenVisibilityButton"
    ]) {
      const element = panelEl(id);
      if (element) {
        element.disabled = state.importRunning || (element.classList.contains("dev-only") && !state.devMode);
      }
    }
  }

  function renderExtensionVersion() {
    const versionEl = panelEl("extensionVersion");
    const version = chrome.runtime.getManifest().version || "";
    if (versionEl) {
      versionEl.textContent = version ? `v${version}` : "--";
    }
  }

  function shouldDisconnectLocalAfterImport() {
    const checkbox = panelEl("disconnectLocalCheckbox");
    return !state.devMode || checkbox?.checked !== false;
  }

  function renderCleanupNotice() {
    const notice = panelEl("cleanupNotice");
    if (!notice) {
      return;
    }
    if (shouldDisconnectLocalAfterImport()) {
      notice.className = "notice";
      notice.innerHTML = "<strong>Atenção:</strong> esta sessão será conectada na instância informada e desconectada deste navegador.";
      return;
    }
    notice.className = "notice warn";
    notice.innerHTML = "<strong>Risco:</strong> manter a sessão neste navegador e na instância ao mesmo tempo roda a mesma conta em dois lugares, o que pode causar desconexões, perda de mensagens e outros bugs. Use apenas para depuração.";
  }

  function setDevMode(enabled) {
    state.devMode = Boolean(enabled);
    for (const element of Array.from(state.root?.querySelectorAll(".dev-only") || [])) {
      element.hidden = !state.devMode;
      element.disabled = state.importRunning || !state.devMode;
    }
    const disconnectLocalCheckbox = panelEl("disconnectLocalCheckbox");
    if (!state.devMode && disconnectLocalCheckbox) {
      disconnectLocalCheckbox.checked = true;
    }
    const modeLabel = panelEl("modeLabel");
    if (modeLabel) {
      modeLabel.textContent = state.devMode ? "Modo técnico" : "Modo padrão";
    }
    renderCleanupNotice();
    setBusy(state.importRunning);
  }

  async function setDevModePreference(enabled) {
    setDevMode(enabled);
    await chrome.storage.local.set({ devMode: state.devMode });
    setResult(state.devMode ? "Modo técnico ativado." : "Modo técnico desativado.", "ok");
  }

  function handleDevModeGesture() {
    state.devModeClickCount += 1;
    if (state.devModeClickTimer) {
      clearTimeout(state.devModeClickTimer);
    }
    if (state.devModeClickCount >= DEV_MODE_TOGGLE_CLICKS) {
      state.devModeClickCount = 0;
      state.devModeClickTimer = null;
      setDevModePreference(!state.devMode).catch((error) => {
        console.warn("Failed to toggle technical mode", error);
      });
      return;
    }
    state.devModeClickTimer = setTimeout(() => {
      state.devModeClickCount = 0;
      state.devModeClickTimer = null;
    }, DEV_MODE_TOGGLE_WINDOW_MS);
  }

  function setTokenVisible(visible) {
    const input = panelEl("instanceTokenInput");
    const button = panelEl("tokenVisibilityButton");
    if (!input || !button) {
      return;
    }
    input.type = visible ? "text" : "password";
    button.classList.toggle("is-visible", visible);
    button.setAttribute("aria-pressed", visible ? "true" : "false");
    button.setAttribute("aria-label", visible ? "Ocultar token" : "Mostrar token");
    button.title = visible ? "Ocultar token" : "Mostrar token";
  }

  async function loadSettings() {
    const values = await chrome.storage.local.get(["serverUrl", "instanceToken", "includeHistory", "disconnectLocal", "devMode"]);
    const serverUrlInput = panelEl("serverUrlInput");
    const instanceTokenInput = panelEl("instanceTokenInput");
    const includeHistoryCheckbox = panelEl("includeHistoryCheckbox");
    const disconnectLocalCheckbox = panelEl("disconnectLocalCheckbox");
    if (serverUrlInput) {
      serverUrlInput.value = values.serverUrl || "";
    }
    if (instanceTokenInput) {
      instanceTokenInput.value = values.instanceToken || "";
    }
    if (includeHistoryCheckbox) {
      includeHistoryCheckbox.checked = values.includeHistory !== false;
    }
    if (disconnectLocalCheckbox) {
      disconnectLocalCheckbox.checked = values.devMode === true ? values.disconnectLocal !== false : true;
    }
    setDevMode(values.devMode === true);
  }

  async function saveSettings() {
    const serverUrlInput = panelEl("serverUrlInput");
    const instanceTokenInput = panelEl("instanceTokenInput");
    const includeHistoryCheckbox = panelEl("includeHistoryCheckbox");
    const disconnectLocalCheckbox = panelEl("disconnectLocalCheckbox");
    await chrome.storage.local.set({
      serverUrl: String(serverUrlInput?.value || "").trim(),
      instanceToken: String(instanceTokenInput?.value || "").trim(),
      includeHistory: includeHistoryCheckbox?.checked !== false,
      disconnectLocal: state.devMode ? disconnectLocalCheckbox?.checked !== false : true
    });
    renderCleanupNotice();
  }

  function closeImportPort() {
    if (!state.importPort) {
      return;
    }
    try {
      state.importPort.disconnect();
    } catch {}
    state.importPort = null;
  }

  function downloadJSON(filename, data) {
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

  function handlePortMessage(message, fallbackMessage) {
    if (!message) {
      return;
    }
    if (message.type === "STATUS") {
      if (String(message.message || "").includes("Desconectando WhatsApp Web local")) {
        state.cleanupStarted = true;
      }
      setResult(message.message || "", message.kind || "");
      return;
    }
    if (message.type === "DONE") {
      const download = message.payload?.download;
      if (download?.filename && download.data !== undefined) {
        downloadJSON(download.filename, download.data);
      }
      setResult(message.message || fallbackMessage, "ok");
      setBusy(false);
      closeImportPort();
      return;
    }
    if (message.type === "ERROR") {
      setResult(message.message || "Falha ao executar comando.", "error");
      setBusy(false);
      closeImportPort();
    }
  }

  function runBackgroundCommand(type, options = {}, fallbackMessage = "Comando concluído.") {
    if (state.importRunning) {
      return;
    }
    closeImportPort();
    state.cleanupStarted = false;
    setBusy(true);
    const port = chrome.runtime.connect({ name: "session-import" });
    state.importPort = port;
    port.onMessage.addListener((message) => handlePortMessage(message, fallbackMessage));
    port.onDisconnect.addListener(() => {
      state.importPort = null;
      if (state.importRunning && !state.cleanupStarted) {
        setResult("A conexão com a extensão foi encerrada.", "error");
        setBusy(false);
      }
    });
    port.postMessage({ type, options });
  }

  async function startImport(event) {
    event.preventDefault();
    if (state.importRunning) {
      return;
    }

    const client = String(panelEl("serverUrlInput")?.value || "").trim();
    const token = String(panelEl("instanceTokenInput")?.value || "").trim();
    const includeHistory = panelEl("includeHistoryCheckbox")?.checked !== false;
    const disconnectLocal = shouldDisconnectLocalAfterImport();
    if (!client || !token) {
      setResult("Informe cliente e token da instância.", "error");
      return;
    }

    setResult("Preparando importação...");
    await saveSettings();
    runBackgroundCommand("START_IMPORT", { client, token, includeHistory, disconnectLocal }, "Importação concluída.");
  }

  function bindPanelEvents() {
    const closeButton = panelEl("closeButton");
    const closeFromUserAction = (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.dismissed = true;
      closePanel();
    };
    closeButton?.addEventListener("pointerdown", closeFromUserAction, { capture: true });
    closeButton?.addEventListener("click", closeFromUserAction);
    panelEl("devModeToggleArea")?.addEventListener("click", handleDevModeGesture);
    panelEl("importForm")?.addEventListener("submit", startImport);
    panelEl("serverUrlInput")?.addEventListener("blur", () => {
      saveSettings().catch((error) => console.warn("Failed to save client", error));
    });
    panelEl("instanceTokenInput")?.addEventListener("blur", () => {
      saveSettings().catch((error) => console.warn("Failed to save token", error));
    });
    panelEl("includeHistoryCheckbox")?.addEventListener("change", () => {
      saveSettings().catch((error) => console.warn("Failed to save history option", error));
    });
    panelEl("disconnectLocalCheckbox")?.addEventListener("change", () => {
      saveSettings().catch((error) => console.warn("Failed to save local cleanup option", error));
    });
    panelEl("tokenVisibilityButton")?.addEventListener("click", () => {
      const input = panelEl("instanceTokenInput");
      setTokenVisible(input?.type === "password");
      input?.focus();
    });
    panelEl("diagnoseButton")?.addEventListener("click", () => {
      runBackgroundCommand("DIAGNOSE", {}, "Diagnóstico gerado.");
    });
    panelEl("dumpButton")?.addEventListener("click", () => {
      runBackgroundCommand("DUMP_HISTORY", {}, "Histórico gerado.");
    });
    panelEl("mainDumpButton")?.addEventListener("click", () => {
      runBackgroundCommand("DUMP_SESSION", {}, "Sessão gerada.");
    });
    panelEl("exitDevModeButton")?.addEventListener("click", () => {
      setDevModePreference(false).catch((error) => {
        console.warn("Failed to disable technical mode", error);
      });
    });
  }

  async function ensurePanel() {
    if (state.host && state.root) {
      return;
    }

    const host = document.getElementById(PANEL_HOST_ID) || document.createElement("div");
    host.id = PANEL_HOST_ID;
    if (!host.isConnected) {
      (document.body || document.documentElement).append(host);
    }
    const root = host.shadowRoot || host.attachShadow({ mode: "open" });
    root.innerHTML = panelTemplate();
    state.host = host;
    state.root = root;
    startThemeWatch();
    bindPanelEvents();
    renderExtensionVersion();
    await loadSettings();
    setTokenVisible(false);
  }

  async function openPanel(options = {}) {
    if (!isWhatsAppLoggedIn()) {
      return false;
    }
    if (options.force) {
      state.dismissed = false;
    }
    if (state.dismissed) {
      return false;
    }
    await ensurePanel();
    if (!state.importRunning) {
      await loadSettings();
    }
    state.host.style.display = "";
    setStatus("WhatsApp Web conectado");
    return true;
  }

  function closePanel() {
    closeImportPort();
    state.host?.remove();
    state.host = null;
    state.root = null;
    state.importRunning = false;
    stopThemeWatch();
  }

  async function checkLoginState() {
    if (isQrLoginScreen()) {
      closePanel();
      return;
    }
    if (!state.autoOpened && !state.dismissed && isWhatsAppLoggedIn()) {
      state.autoOpened = true;
      await openPanel();
    }
  }

  function scheduleLoginCheck() {
    if (state.loginTimer) {
      clearTimeout(state.loginTimer);
    }
    state.loginTimer = setTimeout(() => {
      state.loginTimer = null;
      checkLoginState().catch((error) => console.warn("Failed to check WhatsApp login state", error));
    }, LOGIN_CHECK_DELAY_MS);
  }

  function observeLoginState() {
    const target = document.documentElement || document;
    const observer = new MutationObserver(scheduleLoginCheck);
    observer.observe(target, { childList: true, subtree: true });
    scheduleLoginCheck();
  }

  function startInitialLoginPolling() {
    if (state.loginPollTimer) {
      clearInterval(state.loginPollTimer);
    }
    state.loginPollAttempts = 0;
    state.loginPollTimer = setInterval(() => {
      state.loginPollAttempts += 1;
      checkLoginState().catch((error) => console.warn("Failed to poll WhatsApp login state", error));
      if (state.autoOpened || state.loginPollAttempts >= INITIAL_LOGIN_CHECKS) {
        clearInterval(state.loginPollTimer);
        state.loginPollTimer = null;
      }
    }, INITIAL_LOGIN_CHECK_INTERVAL_MS);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "SESSION_CONNECTOR_OPEN_PANEL") {
      return false;
    }
    openPanel({ force: true })
      .then((opened) => sendResponse({ ok: opened, loggedIn: isWhatsAppLoggedIn() }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Falha ao abrir painel" }));
    return true;
  });

  window.addEventListener("hashchange", () => {
    applyAutofillFromUrl()
      .then((changed) => {
        if (changed) {
          return openPanel({ force: true });
        }
        return false;
      })
      .catch((error) => console.warn("Failed to apply URL autofill", error));
  });

  applyAutofillFromUrl().catch((error) => {
    console.warn("Failed to store URL autofill values", error);
  });
  observeLoginState();
  startInitialLoginPolling();
})();
