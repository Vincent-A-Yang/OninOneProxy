# Docker

Run OninOneProxy in a container. Build the image from source.

> **Attribution**: OninOneProxy is based on [9Router](https://github.com/decolua/9router) by decolua.

---

# Quick start

## Build image locally

```bash
docker build -t oninoneproxy .
```

## Run container

```bash
docker run -d \
  -p 20130:20130 \
  -v "$HOME/.oninoneproxy:/app/data" \
  -e DATA_DIR=/app/data \
  --name oninoneproxy \
  oninoneproxy:latest
```

App listens on port `20130`. Open: http://localhost:20130

## Using docker-compose

```bash
docker-compose up -d
```

See `docker-compose.yml` for the full compose configuration.

## Manage container

```bash
docker logs -f oninoneproxy        # view logs
docker stop oninoneproxy           # stop
docker start oninoneproxy          # start again
docker rm -f oninoneproxy          # remove
```

## Data persistence

```bash
-v "$HOME/.oninoneproxy:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.oninoneproxy/` (macOS/Linux) or `%APPDATA%\oninoneproxy\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.oninoneproxy/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
docker run -d \
  -p 20130:20130 \
  -v "$HOME/.oninoneproxy:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20130 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name oninoneproxy \
  oninoneproxy:latest
```

## Optional Headroom sidecar

The OninOneProxy image does not bundle Python or Headroom. To use Headroom in Docker, run it as a separate service:

```yaml
services:
  oninoneproxy:
    build: .
    ports:
      - "20130:20130"
    volumes:
      - "$HOME/.oninoneproxy:/app/data"
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787` on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts` entry.

## Update to latest

```bash
git pull
docker build -t oninoneproxy .
docker rm -f oninoneproxy
# re-run the quick start command
```

---

# For Developers

## Build image locally (test)

```bash
docker build -t oninoneproxy .

docker run --rm -p 20130:20130 \
  -v "$HOME/.oninoneproxy:/app/data" \
  -e DATA_DIR=/app/data \
  oninoneproxy
```