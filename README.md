# Importador de Sessão do WhatsApp Web

Extensão para migrar uma sessão já conectada no WhatsApp Web para a API.

Esta extensão funciona apenas para instâncias Uazapi.

## Versão

### 0.1.0

- Versão inicial da extensão.
- Instalação manual pelo Chrome ou Edge.
- Migração de sessão conectada no WhatsApp Web para a instância Uazapi.
- Abertura automática do painel quando o link enviado pela equipe de suporte contém os parâmetros necessários.

## 1. Instalar a extensão

1. Receba o arquivo `whatsapp-web-session-importer.zip`.
2. Descompacte o arquivo `.zip`.
3. Abra o Chrome ou Edge.
4. Acesse:

```text
chrome://extensions
```

No Edge, use:

```text
edge://extensions
```

5. Ative o `Modo do desenvolvedor`.
6. Clique em `Carregar sem compactação`.
7. Selecione a pasta descompactada da extensão.

A pasta correta é a que contém o arquivo `manifest.json`.

## 2. Abrir o WhatsApp Web

Abra o WhatsApp Web normalmente:

```text
https://web.whatsapp.com
```

Se ainda não estiver conectado, escaneie o QR Code e aguarde o WhatsApp Web carregar as conversas.

## 3. Usar com cliente na URL

A extensão aceita os dados da instância diretamente na URL do WhatsApp Web.

Use o seguinte formato:

```text
https://web.whatsapp.com/#client=CLIENTE&token=TOKEN
```

Troque `CLIENTE` pelo cliente da instância e troque `TOKEN` pelo token da instância.

Exemplo:

```text
https://web.whatsapp.com/#client=minhaempresa&token=550e8400-e29b-41d4-a716-446655440000
```

Não altere letras, números ou símbolos do token da instância.

Depois que a extensão lê os dados, ela remove os parâmetros da barra de endereço automaticamente.

## 4. Migrar a sessão

Ao abrir o WhatsApp Web com os parâmetros na URL, a extensão abre o painel automaticamente.

Antes de continuar:

1. Confira se o `cliente` está correto.
2. Confira se o `token` está correto.
3. Clique em `Migrar sessão`.

A extensão vai capturar a sessão conectada, enviar para a API, limpar a sessão local do WhatsApp Web e iniciar a conexão da instância automaticamente.

Durante esse processo, a aba do WhatsApp Web pode recarregar ou sair da sessão. Isso é esperado.

## Se o painel não abrir

1. Confirme que a extensão está instalada e ativa em `chrome://extensions`.
2. Confirme que o WhatsApp Web está conectado.
3. Clique no ícone da extensão no navegador.
4. Se necessário, abra novamente o link enviado pela equipe de suporte.
