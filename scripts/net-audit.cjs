// Comprehensive network performance audit script.
// Runs INSIDE the 9router container; uses only Node built-ins (no undici).
// Collects results into a JSON file to avoid stdout buffering issues.

const dns = require("dns");
const net = require("net");
const tls = require("tls");
const http = require("http");
const fs = require("fs");
const { URL } = require("url");

const PROXY_URL = process.env.HTTPS_PROXY || "http://host.docker.internal:7890";
const TARGETS = [
  { name: "api.openai.com", path: "/v1/models" },
  { name: "api.anthropic.com", path: "/v1/models" },
  { name: "api.deepseek.com", path: "/v1/models" },
  { name: "www.google.com", path: "/" },
];

function fmtMs(n) {
  if (n == null) return null;
  return Math.round(n);
}

function resolveDns(hostname) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    dns.lookup(hostname, { family: 4 }, (err, address) => {
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      if (err) resolve({ ok: false, error: err.message, elapsedMs });
      else resolve({ ok: true, address, elapsedMs });
    });
  });
}

function tcpConnect(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      socket.destroy();
      resolve({ ok: true, elapsedMs });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    socket.once("error", (err) => {
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ ok: false, error: err.message, elapsedMs });
    });
    socket.connect(port, host);
  });
}

// Direct HTTPS request — DNS+TCP+TLS+TTFB. Aggressively destroys sockets.
function directRequest(hostname, path, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const timings = {};
    const t0 = process.hrtime.bigint();
    let settled = false;
    let socket = null;

    const done = (result) => {
      if (settled) return;
      settled = true;
      try { socket && socket.destroy(); } catch {}
      resolve(result);
    };

    dns.lookup(hostname, { family: 4 }, (err, address) => {
      timings.dnsMs = err ? null : Number(process.hrtime.bigint() - t0) / 1e6;
      if (err) {
        done({ ok: false, error: `DNS: ${err.message}`, timings });
        return;
      }
      timings.resolvedIp = address;

      const tTcp0 = process.hrtime.bigint();
      socket = new tls.TLSSocket();
      socket.setTimeout(timeoutMs);

      socket.once("secureConnect", () => {
        timings.tcpTlsMs = Number(process.hrtime.bigint() - tTcp0) / 1e6;
        timings.alpn = socket.alpnProtocol;
        timings.tlsProtocol = socket.getProtocol();
        timings.tlsSessionReused = socket.isSessionReused();

        const tReq0 = process.hrtime.bigint();
        const req = http.request(
          {
            createConnection: () => socket,
            method: "GET",
            host: address,
            port: 443,
            path,
            headers: { Host: hostname, "User-Agent": "9router-audit/1.0" },
          },
          (res) => {
            timings.ttfbMs = Number(process.hrtime.bigint() - tReq0) / 1e6;
            timings.status = res.statusCode;
            timings.httpVersion = res.httpVersion;
            res.resume();
            res.once("end", () => {
              timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
              done({ ok: true, timings });
            });
            res.once("error", (e) => {
              timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
              done({ ok: true, timings, warning: `res err: ${e.message}` });
            });
          }
        );
        req.on("error", (e) => {
          timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
          done({ ok: false, error: `req: ${e.message}`, timings });
        });
        // Add an explicit request timeout — if no response in timeoutMs
        req.setTimeout(timeoutMs, () => {
          done({ ok: false, error: "req timeout (no response)", timings });
        });
        req.end();
      });

      socket.once("timeout", () => {
        done({ ok: false, error: "tls/req timeout", timings });
      });
      socket.once("error", (err) => {
        timings.tcpTlsMs = Number(process.hrtime.bigint() - tTcp0) / 1e6;
        done({ ok: false, error: `tls: ${err.message}`, timings });
      });

      socket.connect({
        host: address,
        port: 443,
        servername: hostname,
        ALPNProtocols: ["h2", "http/1.1"],
      });
    });
  });
}

// HTTPS via Clash proxy (CONNECT tunnel) — matches undici ProxyAgent behavior
function proxyRequest(hostname, path, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const timings = {};
    const t0 = process.hrtime.bigint();
    let settled = false;
    let tunnel = null;
    let tlsSocket = null;

    const done = (result) => {
      if (settled) return;
      settled = true;
      try { tlsSocket && tlsSocket.destroy(); } catch {}
      try { tunnel && tunnel.destroy(); } catch {}
      resolve(result);
    };

    const proxyUrl = new URL(PROXY_URL);
    const proxyHost = proxyUrl.hostname;
    const proxyPort = proxyUrl.port || 8080;

    dns.lookup(proxyHost, { family: 4 }, (err, proxyIp) => {
      timings.proxyDnsMs = err ? null : Number(process.hrtime.bigint() - t0) / 1e6;
      if (err) {
        done({ ok: false, error: `proxy DNS: ${err.message}`, timings });
        return;
      }
      timings.proxyIp = proxyIp;

      const tTunnel0 = process.hrtime.bigint();
      tunnel = new net.Socket();
      tunnel.setTimeout(timeoutMs);

      tunnel.once("connect", () => {
        timings.proxyTcpMs = Number(process.hrtime.bigint() - tTunnel0) / 1e6;
        tunnel.write(
          `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nUser-Agent: 9router-audit/1.0\r\n\r\n`
        );
      });

      let buf = Buffer.alloc(0);
      let headersParsed = false;
      tunnel.on("data", (chunk) => {
        if (headersParsed) return;
        buf = Buffer.concat([buf, chunk]);
        const text = buf.toString();
        const headerEnd = text.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        headersParsed = true;
        const statusLine = text.split("\r\n")[0];
        const m = statusLine.match(/HTTP\/\d\.\d (\d+)/);
        if (!m || m[1] !== "200") {
          done({ ok: false, error: `proxy CONNECT failed: ${statusLine}`, timings });
          return;
        }
        timings.proxyConnectMs = Number(process.hrtime.bigint() - tTunnel0) / 1e6;

        const tTls0 = process.hrtime.bigint();
        tlsSocket = new tls.TLSSocket(tunnel, { isServer: false });
        tlsSocket.setTimeout(timeoutMs);
        tlsSocket.once("secureConnect", () => {
          timings.tlsMs = Number(process.hrtime.bigint() - tTls0) / 1e6;
          timings.alpn = tlsSocket.alpnProtocol;
          timings.tlsProtocol = tlsSocket.getProtocol();
          timings.tlsSessionReused = tlsSocket.isSessionReused();

          const tReq0 = process.hrtime.bigint();
          const req = http.request(
            {
              createConnection: () => tlsSocket,
              method: "GET",
              host: hostname,
              port: 443,
              path,
              headers: { Host: hostname, "User-Agent": "9router-audit/1.0" },
            },
            (res) => {
              timings.ttfbMs = Number(process.hrtime.bigint() - tReq0) / 1e6;
              timings.status = res.statusCode;
              timings.httpVersion = res.httpVersion;
              res.resume();
              res.once("end", () => {
                timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
                done({ ok: true, timings });
              });
              res.once("error", (e) => {
                timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
                done({ ok: true, timings, warning: `res err: ${e.message}` });
              });
            }
          );
          req.on("error", (e) => {
            timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
            done({ ok: false, error: `req: ${e.message}`, timings });
          });
          req.setTimeout(timeoutMs, () => {
            done({ ok: false, error: "req timeout (via proxy)", timings });
          });
          req.end();
        });
        tlsSocket.once("error", (err) => {
          timings.tlsMs = Number(process.hrtime.bigint() - tTls0) / 1e6;
          done({ ok: false, error: `tls: ${err.message}`, timings });
        });
        tlsSocket.once("timeout", () => {
          done({ ok: false, error: "tls/req timeout via proxy", timings });
        });
        tlsSocket.connect({
          socket: tunnel,
          servername: hostname,
          ALPNProtocols: ["h2", "http/1.1"],
        });
      });
      tunnel.once("timeout", () => {
        done({ ok: false, error: "proxy timeout", timings });
      });
      tunnel.once("error", (err) => {
        done({ ok: false, error: `proxy socket: ${err.message}`, timings });
      });
      tunnel.connect(proxyPort, proxyIp);
    });
  });
}

function hardTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: `HARD TIMEOUT ${label} (${ms}ms)`, timings: {} }), ms)),
  ]);
}

(async () => {
  const report = {
    startedAt: new Date().toISOString(),
    proxyUrl: PROXY_URL,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    hostDockerInternal: null,
    proxyTcp: null,
    targets: [],
  };

  // 1. host.docker.internal resolution
  report.hostDockerInternal = await hardTimeout(resolveDns("host.docker.internal"), 5000, "dns-hdi");

  // 2. Clash proxy TCP reachability
  report.proxyTcp = await hardTimeout(tcpConnect("host.docker.internal", 7890, 4000), 5000, "tcp-proxy");

  // 3. Per-target measurements
  for (const t of TARGETS) {
    const entry = { name: t.name, path: t.path };
    entry.dns = await hardTimeout(resolveDns(t.name), 5000, "dns-" + t.name);
    entry.direct = await hardTimeout(directRequest(t.name, t.path, 5000), 8000, "direct-" + t.name);
    entry.viaProxy = await hardTimeout(proxyRequest(t.name, t.path, 6000), 10000, "proxy-" + t.name);
    report.targets.push(entry);
  }

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync("/tmp/audit.json", JSON.stringify(report, null, 2));
  process.exit(0);
})();
