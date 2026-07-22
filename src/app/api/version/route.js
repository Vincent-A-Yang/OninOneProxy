import https from "https";
import fs from "fs";
import pkg from "../../../../package.json" with { type: "json" };

const NPM_PACKAGE_NAME = "OninOneProxy";
const GITHUB_RELEASES_URL = "https://github.com/Vincent-A-Yang/OninOneProxy/releases";

// Detect deployment mode: Docker container vs npm global install
function detectDeployMode() {
  if (process.env.DOCKER === "true" || fs.existsSync("/.dockerenv")) return "docker";
  return "npm";
}

// Fetch latest version from npm registry
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`,
      { timeout: 4000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data).version || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export async function GET() {
  const latestVersion = await fetchLatestVersion();
  const currentVersion = pkg.version;
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;
  const deployMode = detectDeployMode();
  const updateCmd = deployMode === "docker"
    ? "docker compose pull && docker compose up -d"
    : `npm i -g ${NPM_PACKAGE_NAME}@latest --prefer-online`;
  const changelogUrl = latestVersion
    ? `${GITHUB_RELEASES_URL}/tag/v${latestVersion}`
    : GITHUB_RELEASES_URL;

  return Response.json({ currentVersion, latestVersion, hasUpdate, deployMode, updateCmd, changelogUrl });
}
