# Política de Privacidade — Trizup Whats Connect

Data de vigência: 6 de julho de 2026

Esta política descreve como a extensão Chrome **Trizup Whats Connect** processa
dados ao conectar uma sessão já autenticada no WhatsApp Web a uma instância ou
backend autorizado pelo usuário ou pela plataforma Trizup.

## Finalidade única

A extensão existe para permitir que uma equipe autorizada conecte uma sessão
ativa do WhatsApp Web a uma instância ou backend configurado pelo usuário ou pela
plataforma Trizup. Ela não oferece recursos de publicidade, rastreamento,
analytics de comportamento ou uso para qualquer finalidade fora dessa conexão.

## Dados processados

Durante a conexão, a extensão pode processar:

- URL, subdomínio ou identificador da instância ou backend autorizado;
- token, chave de importação ou credencial técnica fornecida para autorizar a
  conexão;
- dados técnicos da sessão local do WhatsApp Web presentes no navegador,
  incluindo dados de autenticação, chaves, metadados e bancos locais usados pelo
  WhatsApp Web;
- identificadores da conta, contatos, conversas, mensagens recentes e metadados
  necessários para validar a sessão e preservar âncoras de histórico durante a
  conexão;
- configurações locais da extensão, como URL/token informados, preferências de
  interface e diagnóstico técnico opcional.

## Como os dados são usados

Os dados são usados apenas para:

- validar se a instância ou backend informado está disponível e autorizado;
- montar e enviar a carga técnica de conexão da sessão;
- enviar partes da conexão em chunks com verificação de integridade;
- enviar histórico recente quando necessário para ancorar a sessão conectada;
- limpar a sessão local do WhatsApp Web após a conclusão, evitando uso duplicado
  da mesma conta no navegador e na instância conectada.

## Compartilhamento e transferência

A extensão envia os dados somente por HTTPS para a instância ou backend
autorizado configurado pelo usuário ou pela plataforma Trizup. Esse backend pode
então processar a conexão conforme a autorização do cliente.

Os dados não são vendidos, alugados ou compartilhados para publicidade,
perfilamento, avaliação de crédito, empréstimos ou finalidades não relacionadas
ao objetivo da extensão.

## Armazenamento local

A extensão usa `chrome.storage.local` para manter configurações e credenciais
técnicas necessárias ao fluxo de conexão. Esses dados ficam no navegador do
usuário até serem substituídos, apagados pela própria extensão, removidos pelo
usuário ou eliminados ao desinstalar a extensão.

Após uma conexão bem-sucedida, a extensão limpa dados locais da sessão do
WhatsApp Web no navegador quando esse comportamento é executado pelo fluxo de
conexão.

## Código remoto

A extensão não carrega nem executa JavaScript ou WebAssembly remoto. O código da
extensão é empacotado no item publicado. As conexões externas são requisições
HTTPS para a instância configurada ou para o backend autorizado.

## Controle do usuário

O usuário pode:

- revisar a instância e o token antes de iniciar a conexão;
- remover dados salvos da extensão pelo controle de limpeza disponível na
  interface;
- interromper o uso removendo a extensão do Chrome;
- solicitar ao responsável pela instância ou à plataforma Trizup a exclusão ou
  revisão dos dados processados no backend.

## Segurança

A extensão limita seu funcionamento aos hosts declarados no manifesto e envia
dados por conexões HTTPS quando se comunica com instâncias ou backends
autorizados. Como a conexão envolve credenciais e dados de sessão, o uso deve
ocorrer apenas em computadores confiáveis e com instâncias autorizadas.

## Contato

Para dúvidas sobre esta política ou sobre o funcionamento da extensão, use o
e-mail suporte@trizup.app.

## Aviso

Trizup Whats Connect não é um produto oficial do WhatsApp. WhatsApp é marca de
seus respectivos proprietários.
