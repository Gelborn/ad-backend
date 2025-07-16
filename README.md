# 🍔 Backend Arcos Dourados – Supabase MVP

> Backend enxuto para a plataforma de doações Arcos Dourados, usando Supabase (Postgres + Auth + Storage + Edge Functions) com CI/CD via GitHub Actions.

---

## 📑 Sumário

* [Tecnologias](#tecnologias)
* [Pré-requisitos](#pré-requisitos)
* [Variáveis de Ambiente](#variáveis-de-ambiente)
* [Instalação & Configuração](#instalação--configuração)
* [Migrações de Banco de Dados](#migrações-de-banco-de-dados)
* [Seed de Dados](#seed-de-dados)
* [Functions (Edge)](#functions-edge)

  * [Funções Privadas (JWT)](#funções-privadas-jwt)
  * [Funções Públicas (sem JWT)](#funções-públicas-sem-jwt)
* [Desenvolvimento Local](#desenvolvimento-local)
* [CI/CD (GitHub Actions)](#cicd-github-actions)
* [Contribuição](#contribuição)

---

## 🛠 Tecnologias

* **Supabase** (PostgreSQL, Auth, Storage, Edge Functions)
* **Deno / Sift** para execução das funções (TypeScript)
* **GitHub Actions** via `supabase/setup-cli` para CI/CD

---

## ⚙️ Pré-requisitos

* [Supabase CLI](https://supabase.com/docs/guides/cli) (v1+)
* [Deno](https://deno.land/) (para lint/build local das Edge Functions)
* Docker & Docker Compose (se quiser emular Supabase local com `supabase start`)

---

## 🗝 Variáveis de Ambiente

Crie um arquivo `.env` na raiz do projeto com:

```dotenv
# Supabase
SUPABASE_URL=…  
SUPABASE_ANON_KEY=…  
SUPABASE_SERVICE_ROLE_KEY=…  
SUPABASE_DB_PASSWORD=…  
SUPABASE_REF=…           # project ref (ex: abcdef123456)
SUPABASE_ACCESS_TOKEN=…  # token de deploy CI/CD

# Integrações
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/…"
VIACEP_URL="https://viacep.com.br/ws"
NOMINATIM_URL="https://nominatim.openstreetmap.org/search"
```

---

## 🚀 Instalação & Configuração

```bash
# 1) Clone o repositório
git clone git@github.com:SeuOrg/ad-backend.git
cd ad-backend

# 2) Instale o Supabase CLI (se ainda não tiver)
npm install -g supabase

# 3) Configure variáveis de ambiente
cp .env.example .env
# preencha .env com suas credenciais

# 4) Linka seu projeto Supabase
supabase link --project-ref "$SUPABASE_REF" --password "$SUPABASE_DB_PASSWORD"
```

---

## 📂 Migrações de Banco de Dados

Todos os scripts versionados ficam em `supabase/migrations/`:

```bash
# Aplicar todas as migrations no BD
supabase db push --password "$SUPABASE_DB_PASSWORD"
```

* **0001\_init.sql**: schema inicial (tabelas e extensões).

---

## 🌱 Seed de Dados

Temos um arquivo com dados fake para desenvolvimento:

```bash
# Executar seed (precisa do CLI v1.135+)
supabase db seed run
```

Isso popula tabelas como OSCs, restaurantes de exemplo etc.

---

## 🧩 Functions (Edge)

As Edge Functions ficam em `supabase/functions/`. O deploy delas é feito via CLI:

### 🛡 Funções Privadas (exigem JWT)

* `liberate_donation`
* `register_restaurant`
* `release_donation`
* `send_notifications`

```bash
supabase functions deploy \
  liberate_donation \
  register_restaurant \
  release_donation \
  send_notifications
```

### 🔓 Funções Públicas (sem verificação JWT)

* `geocode_address`
* `accept_donation`
* `deny_donation`

```bash
supabase functions deploy \
  geocode_address \
  accept_donation \
  deny_donation \
  --no-verify-jwt
```

---

## 🖥 Desenvolvimento Local

1. Inicie o emulador Supabase (opcional):

   ```bash
   supabase start
   ```
2. Em outro terminal, aplique migrations e seed:

   ```bash
   supabase db push
   supabase db seed run
   ```
3. Para testar uma Edge Function localmente (direto no Deno):

   ```bash
   cd supabase/functions/geocode_address
   deno run --allow-env --allow-net index.ts
   ```

---

## 🤖 CI/CD (GitHub Actions)

No push para `main`, acionamos o workflow em `.github/workflows/deploy.yml`:

1. **Checkout** do código
2. **Setup Supabase CLI**
3. **Link** no projeto (`supabase link`)
4. **Push migrations** (`supabase db push`)
5. **Deploy funções privadas**
6. **Deploy funções públicas** (com `--no-verify-jwt`)

As credenciais (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_REF`) devem estar definidas nos **Secrets** do GitHub.

---

## 🤝 Contribuição

Sinta-se à vontade para:

* Abrir **issues** para bugs ou sugestões
* Enviar **pull requests** com melhorias ou correções

Por favor, siga o **Padrão de Commits** e crie novas migrations sempre que alterar o schema.

---

> Desenvolvido com ♥️ pelo time Arcos Dourados.
