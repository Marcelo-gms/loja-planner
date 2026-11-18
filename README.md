# Loja do planner — vendas + pagamento (Asaas) + área de membros

Sistema independente em **Node.js + Express + EJS + MySQL**. Esta pasta sobe sozinha em qualquer hospedagem Node.
A porta vem de `process.env.PORT` (exigida pela Integrator).

```
/                 página de vendas (test-drive, cores, oferta: preço vem do .env)
/checkout         dados da cliente + PIX ou cartão (parcelas sem juros)
/pagamento/:id    PIX: QR code + copia e cola, a página detecta o pagamento sozinha
                  Cartão: a cliente paga na página segura do Asaas e volta para cá
/webhooks/asaas   Asaas avisa: pago → libera acesso + e-mail | reembolso/chargeback → bloqueia
/criar-senha/...  depois de pagar, a cliente cria a senha (também chega por e-mail)
/entrar           área de membros (e-mail + senha) · /esqueci-senha
/area             nome na capa com prévia ao vivo → baixa os 6 PDFs com o nome dela + 30 capas extras
/admin            vendas, pedidos, reenviar acesso, bloquear/liberar, consultar Asaas, acesso manual, webhooks
/termos /privacidade /contato   (revise os textos)
```

- **Cartão:** os dados do cartão nunca passam pelo seu servidor. No PIX, só aparece o QR code gerado pelo Asaas.
- **Confirmação do pagamento:** vem do webhook (header `asaas-access-token`). Se o webhook atrasar, a página de
  pagamento consulta o Asaas direto (`GET /payments/{id}`). Cada evento é processado uma vez só (`id` do evento).
- **Senhas:** guardadas com scrypt. A sessão de login fica no MySQL (tabela `sessions`). Todo formulário tem proteção CSRF.
  Há limite de tentativas no login, no checkout e no "esqueci a senha".
- **PDF personalizado:** o nome vai na capa e "Licença de uso pessoal · nome · e-mail" na página 2. São cerca de 3 s por
  arquivo na primeira vez, um por vez (300 a 450 MB de memória). Depois fica em cache por 7 dias.
- **Banco:** as tabelas são criadas sozinhas na primeira inicialização (`schema.sql`).

## Deploy na Integrator

1. **MySQL:** crie o banco e o usuário no painel.
2. **Produto:** gere o pacote no PC e copie o **conteúdo** de
   `planner/output/entrega/meu-ano-leve-2027/` para `loja/produto/` (cerca de 85 MB).
   ```bash
   docker compose run --rm planner node src/generate.js --bundle
   ```
   O `.gitignore` ignora `produto/`. Se o deploy for via Git, envie essa pasta por FTP ou tire-a do `.gitignore`.
3. **Envie a pasta `loja/`** sem `node_modules/`. No painel Node:
   - versão 18 ou mais nova;
   - arquivo de inicialização `server.js`;
   - comando de start `npm start`;
   - rode `npm install`.
4. **Variáveis:** copie `.env.example` para `.env`, ou cadastre as mesmas variáveis no painel. Obrigatórias:
   - `APP_URL`, `NODE_ENV=production`, `SESSION_SECRET`;
   - `DB_*`;
   - `ASAAS_*`;
   - `SMTP_*`, `MAIL_FROM`, `SUPPORT_EMAIL`;
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`.

   **Não defina `PORT`**: a Integrator define sozinha.
5. **Asaas** (comece no sandbox, `ASAAS_ENV=sandbox`, com a chave do sandbox):
   - Integrações → **Chave de API** → `ASAAS_API_KEY`.
   - Integrações → **Webhooks** → novo webhook:
     - URL `https://SEU-DOMINIO/webhooks/asaas`;
     - versão da API v3;
     - envio sequencial;
     - **token de autenticação**: um texto seu, de 32 ou mais caracteres e sem espaços. Repita o mesmo em `ASAAS_WEBHOOK_TOKEN`.
     - Eventos de **cobrança**:
       - `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`;
       - `PAYMENT_REFUNDED`;
       - `PAYMENT_CHARGEBACK_REQUESTED`, `PAYMENT_CHARGEBACK_DISPUTE`, `PAYMENT_AWAITING_CHARGEBACK_REVERSAL`;
       - `PAYMENT_OVERDUE`, `PAYMENT_DELETED`, `PAYMENT_RESTORED`.
   - Em **Minha conta → Informações**, cadastre o domínio do site. O Asaas pode recusar o retorno do cartão
     (`callback.successUrl`) para domínios que não estão na conta.
6. **Teste no sandbox:**
   1. compre com PIX e "pague" pelo painel do sandbox;
   2. confira se a página muda sozinha, se o e-mail chega, se a senha é criada e se o download sai;
   3. depois teste com cartão de teste parcelado;
   4. por fim, faça um estorno pelo painel e veja o acesso ser bloqueado.

   Tudo aparece em `/admin` e `/admin/webhooks`.
7. **Produção:** troque para `ASAAS_ENV=production` e a chave de produção, crie o webhook também na conta de
   produção e reinicie o app.

## Rodar e testar localmente
```bash
cd loja && npm install
cp .env.example .env          # preencha DB_* (ex.: MySQL do docker da fábrica: 127.0.0.1:3307 root/root)
npm start                     # http://localhost:3000
npm test                      # fluxo completo contra MySQL (banco loja_test) com Asaas simulado
```
Sem `SMTP_HOST`, os e-mails aparecem no console, com o link de criar senha.

## Personalizar
- **Preço, parcelas e garantia:** `PRODUCT_PRICE`, `MAX_INSTALLMENTS`, `GUARANTEE_DAYS` no `.env`. As parcelas são
  limitadas a no mínimo R$ 5,00 cada.
- **Textos da página de vendas:** `views/vendas.ejs`.
- **E-mails:** `views/emails/*.ejs`.
- **Páginas legais:** `views/legal-*.ejs`.
- **Estilo das páginas internas:** `public/css/app.css`.
- **Novo produto ou nova versão:** rode `--bundle` de novo e troque `produto/`. Os PDFs em cache são refeitos
  automaticamente. Imagens e test-drive da página de vendas: `--site` e copie `planner/site/assets/` para `public/assets/`.
