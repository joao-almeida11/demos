# Fastify API — Production Deployment
## OpenSUSE · systemd + Nginx · 125 MB uploads · 30–100+ concurrent users

---

## Stack

| Layer | Tool | Why |
|---|---|---|
| Reverse proxy | Nginx | TLS termination, rate-limiting, large-file timeout control |
| Process manager | systemd | OS-native, zero overhead, survives reboots, journald logging |
| Clustering | Node.js `cluster` module | One worker per CPU core, sharing port 3000 |
| Runtime | Node.js 22 LTS | Latest LTS; `availableParallelism()` requires v18.14+ |

---

## File layout

```
/opt/api/
├── dist/           ← compiled JS (built from src/)
├── src/
│   └── server.ts   ← Fastify app
├── uploads/        ← temp + final upload files
├── logs/
├── package.json
└── .env            ← secrets (PORT, DATABASE_URL, etc.)

/etc/systemd/system/
└── fastify-api.service

/etc/nginx/
├── nginx.conf           ← add rate-limit zones here
└── conf.d/
    └── api.conf         ← your server{} blocks
```

---

## First-time setup

```bash
# 1. Install Node.js 22 on OpenSUSE
sudo zypper install nodejs22 npm22
node --version   # should be v22.x

# 2. Clone your repo to /opt/api
sudo mkdir -p /opt/api
sudo git clone https://github.com/yourorg/yourrepo /opt/api
cd /opt/api
sudo npm ci

# 3. Copy config files from this directory
sudo bash scripts/deploy.sh install

# 4. Add your secrets
sudo nano /opt/api/.env
# PORT=3000
# NODE_ENV=production
# UPLOAD_DIR=/opt/api/uploads

# 5. Verify everything is running
sudo systemctl status fastify-api
sudo systemctl status nginx
curl http://localhost:3000/health
```

---

## TLS — getting a certificate

**With Let's Encrypt (recommended for public-facing APIs):**
```bash
sudo zypper install certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
# Certbot edits your api.conf automatically
# Auto-renewal: sudo systemctl enable certbot-renew.timer
```

**With an existing certificate:**
```nginx
ssl_certificate     /etc/ssl/certs/api.yourdomain.com.pem;
ssl_certificate_key /etc/ssl/private/api.yourdomain.com.key;
```

---

## Deploying updates

```bash
cd /opt/api
git pull origin main
sudo bash scripts/deploy.sh update
```

The restart flow:
1. `systemctl restart fastify-api` sends SIGTERM to the primary
2. Primary forwards SIGTERM to all workers
3. Workers finish in-flight requests (up to 300s — covers slow 125 MB uploads)
4. Workers exit; systemd starts fresh primary with new code

---

## Scaling beyond one server

When you need to go past what a single server can handle:

1. **Vertical first** — add CPU cores, the cluster auto-picks them up on restart
2. **Horizontal (multiple servers)** — put a load balancer (Nginx, HAProxy, or cloud LB) in front of N identical servers. No code changes needed.
3. **Upload coordination** — if you move to multiple servers, uploads must go to shared storage (S3/MinIO/NFS) not local disk, so any server can handle the request.

---

## Useful commands

```bash
# Watch live logs
journalctl -u fastify-api -f

# Last 100 lines
journalctl -u fastify-api -n 100 --no-pager

# Check Nginx config is valid before reload
nginx -t

# Reload Nginx config (no downtime)
systemctl reload nginx

# See all worker PIDs
ps aux | grep node

# Check open file descriptors (should be < LimitNOFILE)
cat /proc/$(pgrep -f "node.*server"/1)/limits | grep "open files"

# Disk space on upload directory
df -h /opt/api/uploads

# Nginx upload error?
tail -f /var/log/nginx/api_error.log
```

---

## Tuning for 100+ concurrent users

| Knob | Location | What to change |
|---|---|---|
| CPU workers | `server.ts` | `availableParallelism()` auto-scales |
| Nginx connections | `nginx.conf` | `worker_connections 4096` |
| OS file descriptors | `fastify-api.service` | `LimitNOFILE=65535` |
| Upload concurrency | `nginx/api.conf` | `limit_req zone=upload burst=N` |
| Memory cap | `fastify-api.service` | `MemoryMax=2G` if needed |
| Node heap | `ExecStart` | `--max-old-space-size=1024` |
