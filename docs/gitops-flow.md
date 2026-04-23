# GitOps-flöde: GitHub → GHCR → Railway

> Skapad: 2026-04-23
> Projekt: railway-hello-api (PoC)
> Railway-plan: Hobby ($5/mån)
> GitHub-repo: Publikt
> Syfte: Dokumentera beslut och konfiguration för att kunna återanvända flödet i ett större projekt med separat API och frontend

---

## Varför GitOps?

Manuella deploys (SSH, dashboard-klick) är svåra att spåra och reproducera. Med GitOps är Git den enda källan till sanning — ett push till `main` är det enda som krävs för att trigga hela kedjan. Det ger:

- **Spårbarhet:** Varje deploy är knuten till ett commit-SHA
- **Reproducerbarhet:** Miljön kan återskapas från `main`
- **Säkerhet:** Inga manuella credentials i terminalen

---

## Flödesöversikt

```
git push main
    │
    ▼
GitHub Actions (deploy.yml)
    │
    ├─ 1. Checkout kod
    ├─ 2. Docker Buildx setup
    ├─ 3. Login till GHCR med GITHUB_TOKEN
    ├─ 4. Beräkna lowercase image-namn
    ├─ 5. Build + push image till GHCR
    │      ghcr.io/<owner>/<repo>:latest
    │      ghcr.io/<owner>/<repo>:<sha>
    └─ 6. Trigger Railway redeploy via GraphQL
```

Railway lyssnar inte på GHCR direkt — vi måste explicit be den ladda om via API-anrop (steg 6).

---

## Teknikval och motivering

### Node.js 24
Valt för att följa projektstandarden om "senaste stabila LTS". Node 22 var föregående LTS; Node 24 släpptes april 2025 och är aktuell. Håller oss nära upstream security patches.

### Express 5.2.1
Express 4.x hade aktiva CVE:er i sub-dependencies (`path-to-regexp` ReDoS, `qs` DoS). Express 5 är stable sedan sen 2024, städade upp alla dessa och hanterar async-fel automatiskt i route handlers utan att behöva wrappa i try/catch. Ingen breaking change för en enkel REST-API.

### ES Modules (`"type": "module"`)
Node 22+ kör ESM native utan transpilering. Håller koden modern och slipper CommonJS-arv. Konsekvent med hur nyare Node-kod skrivs.

### Alpine som basimage
`node:24-alpine` är ~60 MB mot ~1 GB för `node:24`. Snabbare push/pull i CI och minimalt attackyta. Tillräckligt för en Express-app som inte behöver system-libs.

---

## Filerna och deras roll

### `server.js`

Två beslut som är kritiska för containeriserad miljö:

**`0.0.0.0` istället för `localhost`**
```js
app.listen(PORT, '0.0.0.0', () => { ... })
```
Inside en Docker-container är `localhost` containerns egna loopback — ej nåbart utifrån. `0.0.0.0` binder på alla nätverksgränssnitt och gör porten synlig för Docker och Railway.

**`PORT` från environment**
```js
const PORT = process.env.PORT || 3000
```
Railway injicerar `PORT` dynamiskt per deploy. Appen får inte anta en fast port. Fallback `3000` används enbart lokalt.

**`APP_VERSION` från environment**
```js
const VERSION = process.env.APP_VERSION || 'dev'
```
Gör det möjligt att se exakt vilken build som körs utan att logga in i Railway. Sätts som miljövariabel i Railway med värdet `${{ github.sha }}` eller ett semantiskt versionsnummer.

---

### `Dockerfile`

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

**`COPY package*.json` före `COPY . .`**
Docker cachar lager i ordning. Om vi kopierade allt på en gång skulle ett tecken i `server.js` ogiltigförklara `npm ci`-lagret och tvinga om en full install. Denna ordning gör att dependencies bara installeras om om `package.json` eller `package-lock.json` ändras.

**`npm ci --omit=dev`**
`npm ci` är deterministisk (använder exakt lockfile), till skillnad från `npm install` som kan uppdatera. `--omit=dev` håller ute test-ramverk och build-verktyg ur produktionsimagen.

**`package-lock.json` måste vara committad**
`npm ci` kräver lockfilen. Den ska alltid vara med i repot.

---

### `.dockerignore`

```
node_modules
.git
.env
.github
README.md
npm-debug.log
```

Utan `.dockerignore` kopieras `node_modules` (kan vara hundratals MB) in i build-kontexten och skickas till Docker daemon i onödan. `.git` läcker potentiellt känslig historik. `.env` får aldrig baka in i en image.

---

### `.github/workflows/deploy.yml` — beslut steg för steg

#### GitHub Actions version-pinning
Actions-stegen använder mutable major-tags (`@v4`, `@v5`) istället för SHA-pinning. SHA-pinning är supply-chain best practice för produktionskritiska pipelines, men medvetet utelämnat här eftersom:
- Detta är en PoC med publikt repo och inga känsliga payloads
- SHA-pinning kräver manuell uppdatering vid säkerhetspatchar i actions
- `actions/checkout`, `docker/*`-actions är välkända actions med hög tillit

Beslut: SHA-pinna actions när detta flöde används i det riktiga projektet.

#### Permissions
```yaml
permissions:
  contents: read
  packages: write
```
GitHub Actions-jobbet behöver `packages: write` för att kunna pusha till GHCR med det automatiskt genererade `GITHUB_TOKEN`. Utan det får man 403.

#### Lowercase image-namn
```yaml
- name: Compute lowercase image name
  id: image
  run: |
    echo "name=ghcr.io/$(echo ${{ github.repository }} | tr '[:upper:]' '[:lower:]')" >> $GITHUB_OUTPUT
```
Docker-image-namn måste vara lowercase. GitHub-repo-namn kan innehålla versaler (t.ex. `MyOrg/MyRepo`). Om man bygger direkt med `${{ github.repository }}` kraschar pushen mot GHCR. `tr '[:upper:]' '[:lower:]'` konverterar alltid till säkert format.

#### Dubbla tags
```yaml
tags: |
  ${{ steps.image.outputs.name }}:latest
  ${{ steps.image.outputs.name }}:${{ github.sha }}
```
`:latest` används av Railway för att alltid dra senaste imagen. `:<sha>` ger oföränderlig historik — man kan alltid gå tillbaka till exakt ett commit genom att peka Railway på en specifik SHA-tagg.

#### GHA cache
```yaml
cache-from: type=gha
cache-to: type=gha,mode=max
```
GitHub Actions har inbyggd Docker layer cache. `mode=max` sparar alla mellanliggande lager, inte bara slutimagen. En typisk Express-app utan kodändringar men med oförändrade dependencies bygger på ~5 sek istället för ~45 sek.

#### Railway GraphQL redeploy
```yaml
- name: Trigger Railway redeploy
  run: |
    curl --fail -s -X POST https://backboard.railway.com/graphql/v2 \
      -H "Authorization: Bearer ${{ secrets.RAILWAY_TOKEN }}" \
      -d '{
        "query": "mutation Redeploy($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }",
        "variables": {
          "serviceId": "${{ secrets.RAILWAY_SERVICE_ID }}",
          "environmentId": "${{ secrets.RAILWAY_ENVIRONMENT_ID }}"
        }
      }'
```

**Varför GraphQL och inte webhook?**
Railway erbjuder deploy-webhooks men de triggas av Railway interna händelser, inte utifrån. För att trigga utifrån (från GHA) behövs GraphQL API.

**Varför BÅDA `serviceId` och `environmentId`?**
Railway har stöd för flera miljöer per service (production, staging, etc.). Utan `environmentId` är anropet tvetydigt och misslyckas. Båda krävs av mutationen `serviceInstanceRedeploy`.

**`RAILWAY_TOKEN` — account token, inte project token**
Railway har två tokentyper:
- *Project token* — bara för deploys inifrån Railway-ekosystemet, ej för API-anrop
- *Account token* (format `token_xxx`) — fullständiga API-rättigheter, detta är vad som krävs

Hämtas under: Railway → Avatar (nere till vänster) → Account Settings → Tokens → Create token.

---

## GHCR-paket och Railway Hobby

Railway Hobby kan dra **både publika och privata** GHCR-images.

**Enklast (detta projekt):** Publikt repo + publikt GHCR-paket — inga extra credentials behövs i Railway.

GHCR-paket från ett publikt repo är privata som standard men görs enkelt publika:
1. `github.com/<owner>` → **Packages**
2. Klicka paketet → **Package settings**
3. Ändra visibility → **Public**

**Alternativ för känsligare projekt:** Privat repo + privat GHCR-paket. Konfigurera då Railway med GHCR-credentials under Service → Settings → Deploy → Authentication. Kräver ett Personal Access Token (PAT) med `read:packages`-scope.

**Varför publikt repo är säkert här:**
Secrets (Railway-tokens, service-ID:n) lagras i GitHub Secrets, aldrig i koden. Workflowfiler, Dockerfiles och appkod innehåller inga känsliga värden — de är säkra att exponera publikt.

---

## Vem bygger Docker-imagen?

**GitHub Actions bygger, Railway kör bara.**

Det är viktigt att förstå rollfördelningen:

```
GitHub Actions          GHCR                    Railway
──────────────          ────                    ───────
Klonar kod         →    Lagrar imagen      →    Drar imagen
Kör Dockerfile                                  Startar containern
Pushar imagen                                   Injicerar PORT
                                                Sköter TLS + domän
```

Railway bygger aldrig Dockerfilen. Det är en ren runtime — den drar en färdigbyggd image från GHCR och startar den. Det betyder att:

- Bygget är reproducerbart och oberoende av Railway
- Man kan byta hosting (Fly.io, Render, egen VPS) utan att ändra ett enda byggsteg
- Railway-specifik konfiguration påverkar inte hur appen byggs

---

## Sätta upp Railway första gången (manuell initial deploy)

Den allra första deployn görs manuellt i Railway-dashboarden — GHA-workflowen kan inte trigga Railway förrän Secrets är konfigurerade.

**Steg:**

1. Skapa nytt Railway-projekt → **New Service** → **Docker Image**
2. Ange image: `ghcr.io/palhamel/railway-hello-api:latest`
3. Railway drar imagen och deployar direkt
4. Under **Networking → Public Networking** → klicka **Generate Domain**
5. Appen är live på `https://<namn>.up.railway.app`

**Varför fungerar det utan några miljövariabler?**
- `PORT` injiceras automatiskt av Railway för alla tjänster — behöver aldrig sättas manuellt
- `APP_VERSION` har fallback `'dev'` i koden — appen kraschar inte utan den

Första manuella deploy bekräftade att imagen fungerar i Railway-miljön innan automatiseringen kopplades in.

---

## Miljövariabler i Railway

| Variabel | Sätts av | Värde |
|----------|----------|-------|
| `PORT` | Railway (automatiskt) | Dynamisk per deploy, aldrig sätt manuellt |
| `APP_VERSION` | Bakat i imagen av GHA | Commit-SHA, t.ex. `e11b096...` |

### APP_VERSION — bakat i imagen, inte en Railway-variabel

Första deployn visade `version: "dev"` eftersom `APP_VERSION` saknades. Lösningen var att baka in commit-SHA i imagen vid bygget istället för att sätta en Railway-variabel:

**Dockerfile:**
```dockerfile
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
```

**deploy.yml:**
```yaml
build-args: |
  APP_VERSION=${{ github.sha }}
```

Varje image har nu commit-SHA inbakat från byggtillfället. Ingen Railway-variabel behövs, och man kan alltid se exakt vilken kod som kör genom att titta på `/`-endpointen.

---

## Nästa steg: skala till API + frontend

Nedan beskrivs hur flödet replikeras för ett projekt med separata tjänster.

### Repostruktur (monorepo)

```
my-project/
├── api/               ← Node.js/Express backend
│   ├── server.js
│   ├── package.json
│   └── Dockerfile
├── app/               ← React/Vite frontend
│   ├── src/
│   ├── package.json
│   ├── vite.config.js
│   └── Dockerfile
└── .github/
    └── workflows/
        ├── deploy-api.yml
        └── deploy-app.yml
```

### Separata workflows med path-filter

Varje workflow triggas bara när dess egna källfiler ändras:

```yaml
# deploy-api.yml
on:
  push:
    branches: [main]
    paths:
      - 'api/**'
      - '.github/workflows/deploy-api.yml'
```

```yaml
# deploy-app.yml
on:
  push:
    branches: [main]
    paths:
      - 'app/**'
      - '.github/workflows/deploy-app.yml'
```

Detta förhindrar att ett CSS-fix triggar en API-rebuild och vice versa.

### Separata Railway-tjänster

Varje service i Railway har egna:
- `RAILWAY_SERVICE_ID`
- `RAILWAY_ENVIRONMENT_ID`

Secrets i GitHub namnges med prefix:

| Secret | Tjänst |
|--------|--------|
| `API_RAILWAY_SERVICE_ID` | Express API |
| `API_RAILWAY_ENVIRONMENT_ID` | Express API |
| `APP_RAILWAY_SERVICE_ID` | React frontend |
| `APP_RAILWAY_ENVIRONMENT_ID` | React frontend |

### Frontend Dockerfile (Nginx-baserad)

Frontend byggs statiskt och serveras av Nginx:

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

Här motiverar multi-stage sig: build-miljön (Node + devDependencies) slängs och bara den statiska outputen kopieras in i Nginx-imagen.

Frontend exponerar port 80, inte 3000. Railway sköter TLS och routing framför.

### GHCR image-namn per tjänst

```
ghcr.io/<owner>/my-project-api:latest
ghcr.io/<owner>/my-project-app:latest
```

I varje workflow:
```yaml
echo "name=ghcr.io/$(echo ${{ github.repository }} | tr '[:upper:]' '[:lower:]')-api" >> $GITHUB_OUTPUT
```

### Kommunikation mellan tjänster

I Railway-projektet exponerar API-tjänsten en intern Railway-URL som frontenden konsumerar via miljövariabel:

```
VITE_API_URL=https://my-project-api.railway.internal
```

Railway-interna URLer (`.railway.internal`) är inte publika — bara nåbara inom samma Railway-projekt. Publika API-anrop exponeras via Railway-domänen.

---

## PoC verifierad — 2026-04-23

Hela flödet verifierat end-to-end:

```
git push main
  → GitHub Actions bygger Docker-imagen
  → Pushar ghcr.io/palhamel/railway-hello-api:latest + :<sha>
  → curl mot Railway GraphQL API svarar {"serviceInstanceRedeploy": true}
  → Railway drar ny image och startar om tjänsten
  → https://railway-hello-api-production.up.railway.app/ svarar med korrekt commit-SHA i version-fältet
```

Bekräftat live-svar:
```json
{
  "message": "Hello from Railway!",
  "version": "8c2b32ebfb797ec54aa7198fb7246eeaa6c28d3c",
  "timestamp": "2026-04-23T15:02:33.124Z"
}
```

`version` matchar exakt commit-SHA → bevis på att rätt kod kör i produktion.

---

## Checklista inför nytt projekt

- [ ] Skapa Railway-projekt med två tjänster: `api` och `app`
- [ ] Notera `serviceId` och `environmentId` för båda
- [ ] Skapa account token i Railway (format `token_xxx`)
- [ ] Lägg till GitHub Secrets: `RAILWAY_TOKEN`, `API_RAILWAY_SERVICE_ID`, `API_RAILWAY_ENVIRONMENT_ID`, `APP_RAILWAY_SERVICE_ID`, `APP_RAILWAY_ENVIRONMENT_ID`
- [ ] Skapa separata Dockerfiles i `api/` och `app/`
- [ ] Skapa `deploy-api.yml` och `deploy-app.yml` med path-filter
- [ ] Gör GHCR-paketen publika efter första push (eller konfigurera Railway med PAT om paketen ska vara privata)
- [ ] Sätt `APP_VERSION` och `VITE_API_URL` som miljövariabler i Railway
