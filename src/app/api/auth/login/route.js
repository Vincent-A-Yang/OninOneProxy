import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";
import { isLocalRequest } from "@/dashboardGuard";

const RESET_HINT = "Forgot password? Reset to default via OninOneProxy CLI → Settings → Reset Password to Default.";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function isTunnelRequest(request, settings) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
  const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s. ${RESET_HINT}`, retryAfter: lock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }

    const { password } = await request.json();
    const settings = await getSettings();

    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }

    // No stored password AND no environmental default → login via password is
    // disabled. The operator must set INITIAL_PASSWORD or DASHBOARD_PASSWORD, or
    // configure a password via the Dashboard settings panel first.
    const storedHash = settings.password;

    if (settings.authMode === "oidc" && isOidcConfigured(settings)) {
      return NextResponse.json({ error: "Password login is disabled. Use OIDC sign in." }, { status: 403 });
    }

    let isValid = false;
    if (storedHash) {
      isValid = await bcrypt.compare(password, storedHash);
    } else {
      // No fallback to hardcoded default. Require operator-configured password.
      const initialPassword = process.env.INITIAL_PASSWORD || process.env.DASHBOARD_PASSWORD;
      if (initialPassword) {
        isValid = password === initialPassword;
      } else {
        return NextResponse.json(
          { error: "Password login is disabled. Set INITIAL_PASSWORD or a dashboard password first." },
          { status: 403 }
        );
      }
    }

    if (isValid) {
      recordSuccess(ip);
      const cookieStore = await cookies();
      await setDashboardAuthCookie(cookieStore, request);

      // Default password still in use on a remote client → force a password
      // change before the dashboard is exposed remotely (keeps local UX intact).
      const hasEnvPassword = !!(process.env.INITIAL_PASSWORD || process.env.DASHBOARD_PASSWORD);
      const mustChangePassword = !storedHash && !hasEnvPassword && !isLocalRequest(request);
      // Remind (non-blocking) when no custom password has been set yet.
      const usingDefaultPassword = !storedHash;

      return NextResponse.json({ success: true, mustChangePassword, usingDefaultPassword }, { headers: NO_STORE_HEADERS });
    }

    const { remainingBeforeLock } = recordFail(ip);
    const postLock = checkLock(ip);
    if (postLock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${postLock.retryAfter}s. ${RESET_HINT}`, retryAfter: postLock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(postLock.retryAfter) } }
      );
    }
    return NextResponse.json(
      { error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock },
      { status: 401 }
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
