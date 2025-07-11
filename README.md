# 🍔 Backend Arcos Dourados – Supabase MVP

**Objetivo**
: Colocar no ar, de forma rápida e enxuta, o backend da plataforma de doações usando apenas o ecossistema **Supabase** (Postgres + Auth + Storage + Edge Functions) e CI/CD no GitHub.

---

## 📁 Estrutura do repositório

```text
supabase/                 # pasta gerenciada pela Supabase CLI
├─ config.toml            # criado automaticamente pelo `supabase link`
├─ migrations/            # scripts SQL versionados
│   └─ 20250711_init.sql  # schema inicial (edite)
├─ seed/                  # dados fake para desenvolvimento
│   ├─ seed.sql
│   └─ osc_seed.csv
└─ functions/             # Edge Functions (Deno + TypeScript)
    ├─ geocode_address/
    │   └─ index.ts
    ├─ liberate_donation/
    │   └─ index.ts
    ├─ pickup_donation/
    │   └─ index.ts
    └─ send_notifications/
        └─ index.ts

.github/
└─ workflows/
   └─ deploy.yml          # pipeline de deploy

.env.example              # chaves e URLs de referência
.gitignore                # ignora node_modules, .env etc.
README.md                 # este arquivo
```

> **Dica:** `supabase start` sobe Postgres + APIs em Docker para dev offline.

---

## 🛠️ Passo‑a‑passo rápido (local)

```bash
# 1️⃣  Clone do repositório
$ git clone git@github.com:Gelborn/ad-backend.git && cd ad-backend

# 2️⃣  Instalar a CLI (escolha UMA opção)
$ brew install supabase/tap/supabase     # macOS
# ou
$ npx supabase --help                    # zero‑install

# 3️⃣  Vínculo com o projeto (pule enquanto estiver só em dev local)
$ supabase link --project-ref <PROJECT_REF>

# 4️⃣  Ambiente de desenvolvimento
$ supabase start        # containers: Postgres, Auth, Storage, Studio
$ supabase db reset     # aplica migrations + seed.sql
```

### Criar coisas novas

```bash
# Nova migration
supabase migration new add_table_x
# (edite o SQL gerado)
supabase db push        # aplica local + grava histórico

# Nova Edge Function
supabase functions new my_function --no-open
supabase functions serve              # hot‑reload local
```

---

## 🚀 Deploy automático (GitHub Actions)

O workflow **.github/workflows/deploy.yml** roda a cada *push* na branch **main**:

```yaml
name: Deploy Supabase

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Supabase CLI
        uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Supabase link
        run: supabase link --project-ref ${{ secrets.SUPABASE_REF }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Push migrations
        run: supabase db push

      - name: Deploy functions
        run: supabase functions deploy --verify-jwt
```

1. Adicione `SUPABASE_ACCESS_TOKEN` e `SUPABASE_REF` em **Settings → Secrets → Actions**.
2. Ao fazer `git push`, o workflow aplica as migrations e publica/atualiza todas as Edge Functions.

---

## 🔐 Convenções de segurança

| Chave / Token           | Uso                 | Onde armazenar                      |
| ----------------------- | ------------------- | ----------------------------------- |
| `anon`                  | Front‑end / SDK     | `.env.example` (pode ficar público) |
| `service_role`          | Edge Functions / CI | **NUNCA** em código; use secrets    |
| Tokens de APIs externas | Edge Functions      | secrets                             |

*Todas as políticas **RLS** ficam versionadas em `migrations/*.sql`.*

---

## 📚 Referências úteis

* [Supabase Docs](https://supabase.com/docs)
* [Extensões `cube` / `earthdistance`](https://postgis.net/docs/)
* [ViaCEP](https://viacep.com.br) · [Nominatim](https://nominatim.org)

---

## 🚧 Próximos passos

* Implementar lógica em `functions/*/index.ts`.
* Criar novas migrations conforme o modelo evoluir.
* Popular `seed/` com dados de teste realistas.
* Ajustar `deploy.yml` se precisar de etapas extras (testes, lint, etc.).

Sinta‑se à vontade para abrir *issues* ou enviar *PRs*.
