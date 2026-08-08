# Running Toreroflow on a server

One box, five containers, about $6.30 a month. The desktop app stays on your
machine; what moves to the server is the API, the worker, the database and the
queue, so the app works the same from the laptop as from the desktop.

---

## What you need first

| | |
|---|---|
| **A VPS** | Contabo Cloud VPS 4: 4 vCPU, 8 GB, 100 GB NVMe, US region. €5.50/mo. Ubuntu 24.04. |
| **A subdomain** | An `A` record for `api.torerone.com` pointing at the server's IP. **Do this before you start**, because the certificate is issued by proving you control that name. |
| **An SSH key** | Contabo will take one at creation. Take it up on that rather than a root password. |

Anything with 2 GB of RAM will run this. The 8 GB is for ffmpeg: transcoding a
4K upload on a 2 GB box works, slowly, and then falls over the first time two
land at once.

---

## First deploy

Everything below is on the server, as root.

### 1. The box itself

```bash
apt update && apt upgrade -y
apt install -y docker.io docker-compose-v2 git ufw
systemctl enable --now docker
```

Then close everything except SSH and the web ports. This is the single highest
value thing on the page: Postgres publishes no port in the compose file, and
this makes sure nothing else does either.

```bash
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable
```

### 2. The code

```bash
git clone https://github.com/TyroneMadison/toreroflow.git /opt/toreroflow
cd /opt/toreroflow
cp infra/.env.example infra/.env
```

### 3. The secrets

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY
openssl rand -base64 24   # POSTGRES_PASSWORD
```

Put those in `infra/.env` along with `API_DOMAIN`, then `chmod 600 infra/.env`.

**Keep `TOKEN_ENCRYPTION_KEY` somewhere you will still have in a year.** It
encrypts the bank credential. Lose it and the connection has to be remade;
change it and the same.

`POSTGRES_PASSWORD` is only ever applied on the **first** boot of an empty
database. Changing it later does not change Postgres's password, it just stops
the API logging in.

### 4. Up

```bash
docker compose -f infra/docker-compose.prod.yml up -d --build
```

First build is 5-10 minutes, mostly Chromium and ffmpeg. Then:

```bash
docker compose -f infra/docker-compose.prod.yml ps
curl https://api.torerone.com/health
```

Every service should read `healthy` or `Up`, and health should answer
`{"status":"ok", ... "worker":"up"}`. Migrations ran on the way: the API applies
them before it accepts a request, so there is no separate step and nothing to
forget.

If the certificate did not issue, it is almost always DNS. `dig api.torerone.com`
from the server and check it comes back with this box's address.

### 5. Nightly backups

```bash
chmod +x /opt/toreroflow/infra/backup.sh
crontab -e
```

```
17 3 * * * /opt/toreroflow/infra/backup.sh >> /var/log/toreroflow-backup.log 2>&1
```

Run it once by hand to make sure it works before trusting it.

---

## Pointing the app at it

On the laptop, in the repo root `.env`:

```
VITE_API_URL=https://api.torerone.com
```

Then rebuild and reinstall:

```bash
pnpm --filter @toreroflow/desktop tauri build
```

The installer is at
`apps/desktop/src-tauri/target/release/bundle/nsis/Toreroflow_0.1.0_x64-setup.exe`.
Install it on both machines and they will be looking at the same data.

Docker Desktop is no longer needed on either machine.

---

## Moving your existing data up

Once the server is healthy and you have decided to commit, from the repo on the
laptop with the local stack running:

```bash
./infra/cutover.sh root@YOUR_SERVER_IP
```

It dumps the local database, restores it on the server, copies the storage
directory and prints what landed. It does not delete anything locally, so if
the server turns out to be wrong you put the old `VITE_API_URL` back.

**Copy `TOKEN_ENCRYPTION_KEY` from the laptop's `.env` rather than generating a
new one**, and the bank connection survives the move. It is what the stored
credential is encrypted with; a fresh key means the row arrives unreadable and
you reconnect at SimpleFIN. Either is fine, but reusing it is one less thing to
do on the day.

`JWT_SECRET` is the opposite: generate a new one. It only costs you a fresh
login, and if the laptop's is still the dev default the server will refuse to
start with it anyway.

---

## Shipping an update

```bash
cd /opt/toreroflow
git pull
docker compose -f infra/docker-compose.prod.yml up -d --build
```

Migrations apply on start. There is a few seconds of downtime while the API
container swaps, which for one operator is not worth engineering around.

---

## When something is wrong

```bash
# what is running
docker compose -f infra/docker-compose.prod.yml ps

# logs, live
docker compose -f infra/docker-compose.prod.yml logs -f api
docker compose -f infra/docker-compose.prod.yml logs -f worker

# is the API reachable from where Caddy sits
docker compose -f infra/docker-compose.prod.yml exec caddy wget -qO- http://api:4700/health

# database shell
docker compose -f infra/docker-compose.prod.yml exec postgres psql -U toreroflow -d toreroflow

# disk, when uploads stop working
df -h && docker system df
```

| Symptom | Usually |
|---|---|
| API container restarting | A missing secret. It refuses to start rather than run insecurely, and says which one. `logs api`. |
| Certificate never issued | DNS. The name has to resolve to this box before Caddy starts. |
| `Authentication failed` for Postgres | `POSTGRES_PASSWORD` changed after the database was created. Change it back, or `ALTER USER` inside Postgres. |
| Uploads stick at "Queued for processing" | The worker is down. `logs worker`. |
| PDFs fail | Chromium is in the image, so this is nearly always disk. `df -h`. |
| Disk filling | `docker system prune -a` clears old build layers. The weekly sweep already deletes posted source videos after seven days. |

---

## What this costs

| | Monthly |
|---|---|
| Contabo VPS 4 | ~$6.30 |
| Certificates | $0, Let's Encrypt via Caddy |
| Backups | $0, the dump is about 15 MB |
| Object storage | $0, the retention sweep means it is not needed |

Your existing Anthropic, Zernio, Netlify, Monid and SimpleFIN bills do not
change by moving.
