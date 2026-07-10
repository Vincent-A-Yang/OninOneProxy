// Targeted follow-up tests:
// 1. Direct TLS WITHOUT ALPN h2 (only http/1.1) — verify Clash tun ALPN hypothesis
// 2. Proxy CONNECT with longer timeout (30s) — measure real proxy latency
// 3. Repeated proxy requests — check connection reuse

const dns = require("dns");
const net = require("net");
const tls = require("tls");
const http = require("http");
const fs = require("fs");
const { URL } = require("url");

const PROXY_URL = process.env.HTTPS_PROXY || "http://host.docker.internal:7890";

function resolveDns(hostname) {
  return new Promise((resolve) => {
    dns.lookup(hostname, { family: 4 }, (err, address) => {
      resolve(err ? { ok: false, error: err.message } : { ok: true, address });
    });
  });
}

// Direct TLS with configurable ALPN
function directRequestAlpn(hostname, path, alpnProtocols, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timings = {};
    const t0 = process.hrtime.bigint();
    let settled = false;
    let socket = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try { socket && socket.destroy(); } catch {}
      resolve(r);
    };

    dns.lookup(hostname, { family: 4 }, (err, address) => {
      timings.dnsMs = err ? null : Number(process.hrtime.bigint() - t0) / 1e6;
      if (err) { done({ ok: false, error: `DNS: ${err.message}`, timings }); return; }
      timings.resolvedIp = address;

      const tTcp0 = process.hrtime.bigint();
      socket = new tls.TLSSocket();
      socket.setTimeout(timeoutMs);
      socket.once("secureConnect", () => {
        timings.tcpTlsMs = Number(process.hrtime.bigint() - tTcp0) / 1e6;
        timings.alpn = socket.alpnProtocol;
        timings.tlsProtocol = socket.getProtocol();
        const tReq0 = process.hrtime.bigint();
        const req = http.request({
          createConnection: () => socket,
          method: "GET", host: address, port: 443, path,
          headers: { Host: hostname, "User-Agent": "9router-audit/1.0" },
        }, (res) => {
          timings.ttfbMs = Number(process.hrtime.bigint() - tReq0) / 1e6;
          timings.status = res.statusCode;
          timings.httpVersion = res.httpVersion;
          res.resume();
          res.once("end", () => {
            timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
            done({ ok: true, timings });
          });
          res.once("error", () => {
            timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
            done({ ok: true, timings });
          });
        });
        req.on("error", (e) => {
          timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
          done({ ok: false, error: `req: ${e.message}`, timings });
        });
        req.setTimeout(timeoutMs, () => done({ ok: false, error: "req timeout", timings }));
        req.end();
      });
      socket.once("timeout", () => done({ ok: false, error: "tls/req timeout", timings }));
      socket.once("error", (err) => {
        timings.tcpTlsMs = Number(process.hrtime.bigint() - tTcp0) / 1e6;
        done({ ok: false, error: `tls: ${err.message}`, timings });
      });
      socket.connect({
        host: address, port: 443, servername: hostname,
        ALPNProtocols: alpnProtocols,
      });
    });
  });
}

// Proxy CONNECT with longer timeout + connection reuse test
function proxyRequestLong(hostname, path, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const timings = {};
    const t0 = process.hrtime.bigint();
    let settled = false;
    let tunnel = null;
    let tlsSocket = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try { tlsSocket && tlsSocket.destroy(); } catch {}
      try { tunnel && tunnel.destroy(); } catch {}
      resolve(r);
    };

    const proxyUrl = new URL(PROXY_URL);
    const proxyHost = proxyUrl.hostname;
    const proxyPort = proxyUrl.port || 8080;

    dns.lookup(proxyHost, { family: 4 }, (err, proxyIp) => {
      if (err) { done({ ok: false, error: `proxy DNS: ${err.message}`, timings }); return; }
      const tTunnel0 = process.hrtime.bigint();
      tunnel = new net.Socket();
      tunnel.setTimeout(timeoutMs);
      tunnel.once("connect", () => {
        timings.proxyTcpMs = Number(process.hrtime.bigint() - tTunnel0) / 1e6;
        tunnel.write(
          `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nProxy-Connection: keep-alive\r\n\r\n`
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
          timings.proxyConnectMs = Number(process.hrtime.bigint() - tTunnel0) / 1e6;
          done({ ok: false, error: `proxy CONNECT: ${statusLine}`, timings, rawHeaders: text.split("\r\n").slice(0, 5) });
          return;
        }
        timings.proxyConnectMs = Number(process.hrtime.bigint() - tTunnel0) / 1e6;
        const tTls0 = process.hrtime.bigint();
        tlsSocket = new tls.TLSSocket(tunnel, { isServer: false });
        tlsSocket.setTimeout(timeoutMs);
        tlsSocket.once("secureConnect", () => {
          timings.tlsMs = Number(process.hrtime.bigint() - tTls0) / 1e6;
          timings.alpn = tlsSocket.alpnProtocol;
          const tReq0 = process.hrtime.bigint();
          const req = http.request({
            createConnection: () => tlsSocket,
            method: "GET", host: hostname, port: 443, path,
            headers: { Host: hostname, "User-Agent": "9router-audit/1.0" },
          }, (res) => {
            timings.ttfbMs = Number(process.hrtime.bigint() - tReq0) / 1e6;
            timings.status = res.statusCode;
            timings.httpVersion = res.httpVersion;
            res.resume();
            res.once("end", () => {
              timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
              done({ ok: true, timings });
            });
            res.once("error", () => {
              timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
              done({ ok: true, timings });
            });
          });
          req.on("error", (e) => {
            timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
            done({ ok: false, error: `req: ${e.message}`, timings });
          });
          req.setTimeout(timeoutMs, () => done({ ok: false, error: "req timeout (proxy)", timings }));
          req.end();
        });
        tlsSocket.once("error", (err) => {
          timings.tlsMs = Number(process.hrtime.bigint() - tTls0) / 1e6;
          done({ ok: false, error: `tls: ${err.message}`, timings });
        });
        tlsSocket.once("timeout", () => done({ ok: false, error: "tls/req timeout (proxy)", timings }));
        tlsSocket.connect({
          socket: tunnel, servername: hostname,
          ALPNProtocols: ["h2", "http/1.1"],
        });
      });
      tunnel.once("timeout", () => done({ ok: false, error: "proxy timeout", timings }));
      tunnel.once("error", (err) => done({ ok: false, error: `proxy socket: ${err.message}`, timings }));
      tunnel.connect(proxyPort, proxyIp);
    });
  });
}

function hardTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((r) => setTimeout(() => r({ ok: false, error: `HARD TIMEOUT ${label} (${ms}ms)`, timings: {} }), ms)),
  ]);
}

(async () => {
  const report = { startedAt: new Date().toISOString(), proxyUrl: PROXY_URL, tests: [] };

  // Test 1: Direct with ALPN h2 (reproduce original failure)
  console.error("T1: direct openai ALPN [h2,http/1.1]");
  const t1 = await hardTimeout(directRequestAlpn("api.openai.com", "/v1/models", ["h2", "http/1.1"], 8000), 12000, "t1");
  report.tests.push({ name: "direct-openai-alpn-h2", result: t1 });

  // Test 2: Direct with ALPN http/1.1 only
  console.error("T2: direct openai ALPN [http/1.1]");
  const t2 = await hardTimeout(directRequestAlpn("api.openai.com", "/v1/models", ["http/1.1"], 8000), 12000, "t2");
  report.tests.push({ name: "direct-openai-alpn-http1", result: t2 });

  // Test 3: Direct with no ALPN
  console.error("T3: direct openai no ALPN");
  const t3 = await hardTimeout(directRequestAlpn("api.openai.com", "/v1/models", [], 8000), 12000, "t3");
  report.tests.push({ name: "direct-openai-no-alpn", result: t3 });

  // Test 4: Direct deepseek ALPN h2
  console.error("T4: direct deepseek ALPN [h2,http/1.1]");
  const t4 = await hardTimeout(directRequestAlpn("api.deepseek.com", "/v1/models", ["h2", "http/1.1"], 8000), 12000, "t4");
  report.tests.push({ name: "direct-deepseek-alpn-h2", result: t4 });

  // Test 5: Direct deepseek ALPN http/1.1
  console.error("T5: direct deepseek ALPN [http/1.1]");
  const t5 = await hardTimeout(directRequestAlpn("api.deepseek.com", "/v1/models", ["http/1.1"], 8000), 12000, "t5");
  report.tests.push({ name: "direct-deepseek-alpn-http1", result: t5 });

  // Test 6: Proxy openai long timeout (25s)
  console.error("T6: proxy openai 25s");
  const t6 = await hardTimeout(proxyRequestLong("api.openai.com", "/v1/models", 25000), 30000, "t6");
  report.tests.push({ name: "proxy-openai-25s", result: t6 });

  // Test 7: Proxy deepseek long timeout
  console.error("T7: proxy deepseek 25s");
  const t7 = await hardTimeout(proxyRequestLong("api.deepseek.com", "/v1/models", 25000), 30000, "t7");
  report.tests.push({ name: "proxy-deepseek-25s", result: t7 });

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync("/tmp/audit2.json", JSON.stringify(report, null, 2));
  process.exit(0);
})();
