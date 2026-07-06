# Chrome Web Store — Listagem "Trizup Whats Connect"

Pacote pronto: `C:\tmp\trizup-whats-connect-0.2.2.zip` (manifest na raiz ✅).
Dashboard: https://chrome.google.com/webstore/devconsole

---

## Aba "Store listing" (público — PT-BR)

**Nome do produto**
```
Trizup Whats Connect
```

**Resumo / Summary** (máx 132 caracteres)
```
Conecte seu número ao Trizup com segurança e sem QR Code de API, com a sua aprovação.
```

**Descrição detalhada**
```
O Trizup Whats Connect conecta a sua sessão já autenticada do WhatsApp Web a uma
instância autorizada da sua conta Trizup, sem precisar reescanear QR Code de API.

Como funciona:
1. Você entra normalmente no WhatsApp Web (login oficial).
2. Informa a conta e o token da sua instância Trizup (ou o Trizup preenche por você).
3. A extensão valida a instância, conecta a sessão com verificação de integridade
   e encerra a sessão local do navegador para evitar uso duplicado.

Feito para equipes autorizadas que já usam o Trizup. A extensão não faz publicidade,
rastreamento ou qualquer uso fora dessa finalidade. Todo o tráfego é por HTTPS.

Aviso: não é um produto oficial do WhatsApp. WhatsApp é marca de seus respectivos
proprietários.
```

**Categoria:** Produtividade (Productivity)
**Idioma:** Português (Brasil)

**Ícone da loja (128x128):** usar `dist/icons/icon-128.png` (logo Trizup).
> NÃO usar `store-assets/store-icon-128.png` (é o ícone da UAZAPI).

**Screenshots (1280x800, mínimo 1):**
- Prontos no repo: `store-assets/screenshot-flow-1280x800.png` e `screenshot-panel-1280x800.png`.
- ⚠️ Eles estão com a identidade da UAZAPI. Ideal regenerar com a marca Trizup
  (os templates `store-assets/screenshot-*.html` dá pra rebrandar). Posso fazer.

---

## Aba "Privacy practices"

**Single purpose (colar em inglês — revisor lê em inglês)**
```
Connect an authenticated WhatsApp Web session to a backend the user explicitly
authorizes (a Trizup/UAZAPI instance), so the number can operate without
re-scanning an API QR code. The extension performs no other function.
```

**Justificativa de cada permissão (inglês):**

- `activeTab`
```
Runs the connection only on the WhatsApp Web tab the user is actively viewing,
after the user clicks to start. No background access to other tabs.
```
- `scripting`
```
Reads the authenticated WhatsApp Web session data from the active tab (page
context) to build the connection payload, and clears the local session after a
successful connection.
```
- `storage`
```
Stores the user's connection settings (instance URL/token and UI preferences)
locally via chrome.storage.local.
```
- Host `https://web.whatsapp.com/*`
```
Required to read the authenticated WhatsApp Web session the user chooses to connect.
```
- Host `https://*.uazapi.com/*`
```
The authorized backend that receives the session (the instance the user connects to).
```
- Host `https://painel.trizup.app/*`
```
Allows the Trizup panel to initiate the connection, with the user's approval.
```

**Remote code:** No (todo o código está no pacote; nenhum JS/WASM remoto).

**Data usage (declarar com honestidade — SIM, coleta):**
- Authentication information — ✅ Sim
- Personal communications (contatos/mensagens p/ ancorar histórico) — ✅ Sim
- Personally identifiable information (identificadores da conta) — ✅ Sim
- Website content — ✅ Sim

**Certificações (marcar as 3):**
- ✅ Não vendo/transfiro dados a terceiros fora dos usos aprovados
- ✅ Não uso os dados para finalidade não relacionada à função única
- ✅ Não uso os dados para avaliação de crédito/empréstimo

**Privacy policy URL (obrigatória):** ver seção abaixo.

---

## Política de privacidade — onde hospedar

A `PRIVACY.md` do fork já está rebrandeada pro Trizup. Opções de URL pública:
1. **(Rápido)** subir o fork num repo GitHub do Trizup e usar a URL raw:
   `https://raw.githubusercontent.com/<org>/<repo>/main/PRIVACY.md`
2. **(Melhor)** publicar como página no Trizup, ex.: `https://trizup.app/privacidade-extensao`.

Para o primeiro envio, a opção 1 é aceita pela Web Store.

---

## Aba "Distribution"

- **Visibilidade:** recomendo **"Não listada" (Unlisted)** — só quem tem o link
  instala. Como é ferramenta interna dos clientes Trizup (não um app de massa),
  isso reduz exposição/trademark e evita instalações aleatórias. Dá pra virar
  pública depois.
- **Regiões:** Brasil (ou todas).

---

## Passo a passo do upload
1. https://chrome.google.com/webstore/devconsole → "Novo item".
2. Subir `trizup-whats-connect-0.2.2.zip`.
3. Preencher "Store listing" (textos acima) + ícone + ≥1 screenshot.
4. Preencher "Privacy practices" (single purpose, justificativas, data usage, política).
5. "Distribution" → Unlisted.
6. Enviar para revisão. (Extensões que leem conteúdo/PII costumam ter revisão
   mais atenta — as justificativas acima cobrem isso.)
7. Atualizações futuras: mesmo item, subir zip com `version` incrementada — os
   usuários recebem auto-update.
```
