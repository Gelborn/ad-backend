# 🍔 Backend Arcos Dourados – Supabase MVP

**Objetivo:** facilitar a criação, manutenção e deploy rápidos do backend (Supabase) para a plataforma de doações.

---

## 📁 Estrutura do repositório

```text
backend/
├─ supabase/
│  ├─ config.toml                # liga CLI ao project‑ref (preencher depois)
│  ├─ migrations/
│  │   └─ 20250711_init.sql      # schema inicial – editar
│  ├─ seed/
│  │   ├─ seed.sql               # dados fictícios p/ dev
│  │   └─ osc_seed.csv           # lista inicial de OSCs (lat/lng)
│  └─ functions/                 # Edge Functions (Deno / TypeScript)
│     ├─ geocode_address/
│     │   ├─ index.ts            # CEP ➜ lat/lng (ViaCEP + Nominatim)
│     │   └─ deno.json
│     ├─ liberate_donation/
│     │   ├─ index.ts            # escolhe OSC + cria doação
│     │   └─ deno.json
│     ├─ pickup_donation/
│     │   ├─ index.ts            # valida código, muda status, recibo
│     │   └─ deno.json
│     └─ send_notifications/
│         ├─ index.ts            # WhatsApp / e-mail
│         └─ deno.json
├─ .github/
│  └─ workflows/
│     └─ deploy.yml              # CI/CD – migrations + functions
├─ .env.example                  # variáveis (Supabase URL, keys, APIs)
├─ .gitignore                    # node_modules, .env, supabase/.temp
└─ README.md                     # este arquivo
```

> **Tip:** use `supabase start` para rodar Postgres + API locais.

---

## 🛠️ Passos de configuração rápida

1. **Clonar & instalar CLI**

   ```bash
   git clone <repo-url> && cd backend
   brew install supabase/tap/supabase   # macOS (ou use `npx supabase --help` sem instalar)
   supabase link --project-ref YOUR_REF   # deixar vazio por enquanto
   cp .env.example .env                   # preencher chaves
   ```
2. **Rodar local**

   ```bash
   supabase start     # Postgres local + Studio
   supabase db reset  # aplica migrations + seed
   ```
3. **Criar nova migration**

   ```bash
   supabase migration new add_table_x
   # editar arquivo gerado em supabase/migrations/
   supabase db push   # aplica + gera diff
   ```
4. **Nova Edge Function**

   ```bash
   supabase functions new my_function --no-open
   supabase functions deploy my_function
   ```

---

## 🚀 Deploy (GitHub Actions)

*Push na branch ****main**** ➜* workflow executa:

```yaml
name: Deploy Supabase

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: supabase/setup-cli@v1
        with:
          version: latest

      # 1️⃣ Vincula o projeto usando token/ref (não fica salvo no repositório)
      - name: Supabase link
        run: supabase link --project-ref ${{ secrets.SUPABASE_REF }} --access-token ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      # 2️⃣ Aplica migrations
      - name: Push migrations
        run: supabase db push

      # 3️⃣ Deploy das Edge Functions
      - name: Deploy functions
        run: supabase functions deploy --verify-jwt
``

> Configure `SUPABASE_ACCESS_TOKEN` e `SUPABASE_REF` em *Settings → Secrets*.

---

## 🔐 Convenções de segurança

| Key                         | Contexto de uso       | Onde fica                            |
| --------------------------- | --------------------- | ------------------------------------ |
| `anon`                      | browser / front‑end   | `.env.example` (exposto)             |
| `service_role`              | Edge Functions, CI/CD | **NUNCA** commit; colocar em secrets |
| Outras APIs (WhatsApp etc.) | Edge Functions        | secrets                              |

Policies RLS ficam versionadas nos scripts SQL.

---

## 📚 Referências

- [Supabase Docs](https://supabase.com/docs)
- [earthdistance / cube](https://postgis.net/docs/)
- [ViaCEP](https://viacep.com.br) + [Nominatim](https://nominatim.org)

---

## ✍️ Próximos arquivos a preencher

- `functions/*/index.ts` – lógica
- `migrations/` subsequentes
- `deploy.yml` – copiar template completo do roteiro
- `seed/` – gerar CSVs para testes

Feel free to abrir issues ou PRs para qualquer modificação.

```
