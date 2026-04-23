# railway-hello-api

Minimal Node.js/Express PoC för GitOps-flöde:
**GitHub → GitHub Actions → GHCR → Railway redeploy**

## Endpoints

| Method | Path      | Svar                                      |
|--------|-----------|-------------------------------------------|
| GET    | `/`       | `{ message, version, timestamp }`         |
| GET    | `/health` | `{ status: 'ok' }`                        |

## Lokal test med Docker

```bash
# Bygg imagen
docker build -t railway-hello-api .

# Kör containern
docker run -p 3000:3000 railway-hello-api

# Testa
curl localhost:3000
curl localhost:3000/health
```

## Deploy-flöde

1. Pusha till `main` → GitHub Actions triggas
2. Docker-imagen byggs och pushas till GHCR som:
   - `ghcr.io/<owner>/<repo>:latest`
   - `ghcr.io/<owner>/<repo>:<commit-sha>`
3. Railway-tjänsten triggas via GraphQL API och startar om med ny image

## GitHub Secrets som krävs

Lägg till dessa under **Settings → Secrets → Actions** i ditt repo:

| Secret                   | Beskrivning                                                                 |
|--------------------------|-----------------------------------------------------------------------------|
| `RAILWAY_TOKEN`          | Account token (format `token_xxx`). Hämtas från Railway → Account Settings → Tokens. **Inte** project token. |
| `RAILWAY_SERVICE_ID`     | ID för Railway-tjänsten. Finns under Service → Settings.                    |
| `RAILWAY_ENVIRONMENT_ID` | ID för Railway-miljön (t.ex. production). Finns under Project → Environments. |

> `GITHUB_TOKEN` sätts automatiskt av GitHub Actions — ingen extra konfiguration behövs.

## Gör GHCR-paketet publikt (viktigt om Railway Free)

Railway Free-planen kan bara dra publika images. Efter första push:

1. Gå till `github.com/<owner>` → **Packages**
2. Klicka på paketet `railway-hello-api`
3. **Package settings** → ändra visibility till **Public**

På Railway Pro kan du hålla paketet privat och konfigurera credentials i Railway.

## Railway: peka på rätt image

I Railway-tjänstens **Settings → Source**, välj:
- Source: **Docker Image**
- Image: `ghcr.io/<owner>/railway-hello-api:latest`
