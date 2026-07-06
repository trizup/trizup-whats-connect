# Trizup Whats Connect — Fork da extensão UAZAPI

Fork white-label de `uazapi/whatsapp-web-session-importer` (Session Migration Connector).
Objetivo: conectar o WhatsApp do cliente ao Trizup (via UAZAPI) sem QR de API, driblando o passkey da Meta.

## Princípio de manutenção (para NÃO ficar pra trás)

**Toda customização vive em apenas 2 arquivos:**
- `manifest.json` — nome, descrição, ícones, `host_permissions`, `content_scripts` (adição de `painel.trizup.app`).
- `src/customization.ts` — textos do painel (`panelText`), `appBridge.matches`.

O resto (`src/background`, `src/content`, `src/shared`, `vendor`) fica **idêntico ao upstream**. Assim o merge de novas versões quase nunca dá conflito — e, quando dá, é só nesses 2 arquivos.

### Fluxo de sincronização com o repo oficial

```bash
# 1. Buscar novidades do repo oficial (já configurado como 'upstream')
git fetch upstream

# 2. Ver o que mudou desde a última sync
git log --oneline HEAD..upstream/main

# 3. Trazer as mudanças para o nosso branch
git checkout trizup
git merge upstream/main         # (ou: git rebase upstream/main)

# 4. Se houver conflito, será só em manifest.json / customization.ts.
#    Resolver mantendo NOSSAS strings + as mudanças estruturais deles.

# 5. Rebuildar e testar
npm install       # caso package.json tenha mudado
npm run build

# 6. Se subiram versão (ex: 0.2.3), publicar a nova versão na Web Store
```

> **Dica:** acompanhar o `CHANGELOG.md` do upstream e a versão do `vendor/wa-store-migrate.bundle.js` — é ele que quebra quando o WhatsApp muda o Store interno. Toda bump de versão do upstream geralmente = re-sync obrigatório.

### Por que o usuário final NÃO precisa reinstalar
A Chrome Web Store **auto-atualiza** extensões publicadas. Quando publicamos uma versão nova (mesmo ID de extensão), todos os clientes recebem sozinhos em algumas horas. Reinstalar só é necessário durante os testes locais (unpacked).

## O que foi customizado neste fork

| Arquivo | Mudança |
|---|---|
| `manifest.json` | `name` = "Trizup Whats Connect"; `description` PT; `default_title`; `host_permissions` + `content_scripts` ganharam `https://painel.trizup.app/*` |
| `src/customization.ts` | `panelText.*` com wording Trizup; `appBridge.matches` inclui `painel.trizup.app` |
| `icons/` | **PENDENTE:** trocar pelos PNGs do logo Trizup (16/32/48/128) |

## Build & teste local (unpacked)

```bash
npm install
npm run build          # gera a pasta dist/
```
Depois: `chrome://extensions` → ativar "Modo do desenvolvedor" → "Carregar sem compactação" → apontar para a pasta **`dist/`**.

## Publicar na Chrome Web Store
1. `npm run zip` (typecheck + testes + gera `whatsapp-web-session-importer.zip` a partir de `dist/`).
2. Chrome Web Store Developer Dashboard → novo item → subir o zip.
3. Preencher listagem (nome, descrição, prints de `store-assets/`, política de privacidade).
4. Enviar para revisão. Atualizações futuras: mesmo item, subir zip novo com `version` incrementada.

## Integração com o painel Trizup (próximo passo)
Com `painel.trizup.app` no `app-bridge`, o painel do Trizup pode:
- Detectar a extensão instalada (mensagem `CONNECTOR_READY`).
- Disparar a conexão via `postMessage` `{ target: "whatsapp-session-connector", type: "START_IMPORT", client, token }`.
Ver `DEVELOPERS.md` (upstream) para o contrato completo do app-bridge.
