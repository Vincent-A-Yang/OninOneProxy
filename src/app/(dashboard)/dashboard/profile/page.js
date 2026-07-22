"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, Toggle, Input } from "@/shared/components";
import Modal, { ConfirmModal } from "@/shared/components/Modal";
import LanguageSwitcher from "@/shared/components/LanguageSwitcher";
import { useTheme } from "@/shared/hooks/useTheme";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG } from "@/shared/constants/config";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";
import { LOCALE_FLAGS } from "@/shared/constants/locales";
import { translate } from "@/i18n/runtime";
import ModelSyncCard from "./ModelSyncCard";

function getLocaleFromCookie() {
  if (typeof document === "undefined") return "en";
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : "en";
  return normalizeLocale(value);
}

export default function ProfilePage() {
  const { theme, setTheme, isDark } = useTheme();
  const [locale, setLocale] = useState("en");
  const [langOpen, setLangOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [settings, setSettings] = useState({ fallbackStrategy: "fill-first" });
  const [loading, setLoading] = useState(true);
  const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" });
  const [passStatus, setPassStatus] = useState({ type: "", message: "" });
  const [passLoading, setPassLoading] = useState(false);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbStatus, setDbStatus] = useState({ type: "", message: "" });
  const [dbAuth, setDbAuth] = useState({ open: false, mode: "", password: "" });
  const pendingImportRef = useRef(null);
  const [oidcForm, setOidcForm] = useState({
    authMode: "password",
    oidcIssuerUrl: "",
    oidcClientId: "",
    oidcScopes: "openid profile email",
    oidcLoginLabel: "Sign in with OIDC",
  });
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcStatus, setOidcStatus] = useState({ type: "", message: "" });
  const [oidcLoading, setOidcLoading] = useState(false);
  const [oidcTestLoading, setOidcTestLoading] = useState(false);
  const [oidcTestStatus, setOidcTestStatus] = useState({ type: "", message: "" });
  const [oidcRedirectUri, setOidcRedirectUri] = useState("/api/auth/oidc/callback");
  const [oidcExpanded, setOidcExpanded] = useState(false);
  const importFileRef = useRef(null);
  const [proxyForm, setProxyForm] = useState({
    outboundProxyEnabled: false,
    outboundProxyUrl: "",
    outboundNoProxy: "",
  });
  const [proxyStatus, setProxyStatus] = useState({ type: "", message: "" });
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyTestLoading, setProxyTestLoading] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState(null);

  useEffect(() => {
    setLocale(getLocaleFromCookie());
  }, [langOpen]);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setSettings(data);
        setOidcForm({
          authMode: data?.authMode || "password",
          oidcIssuerUrl: data?.oidcIssuerUrl || "",
          oidcClientId: data?.oidcClientId || "",
          oidcScopes: data?.oidcScopes || "openid profile email",
          oidcLoginLabel: data?.oidcLoginLabel || "Sign in with OIDC",
        });
        setOidcClientSecret("");
        if (data?.authMode === "oidc" || data?.authMode === "both") setOidcExpanded(true);
        setProxyForm({
          outboundProxyEnabled: data?.outboundProxyEnabled === true,
          outboundProxyUrl: data?.outboundProxyUrl || "",
          outboundNoProxy: data?.outboundNoProxy || "",
        });
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch settings:", err);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOidcRedirectUri(`${window.location.origin}/api/auth/oidc/callback`);
    }
  }, []);

  // Fetch cleanup status (lastCleanupAt, nextCleanupAt from _meta table)
  const reloadCleanupStatus = async () => {
    try {
      const res = await fetch("/api/settings/cleanup-status");
      if (res.ok) {
        const data = await res.json();
        setCleanupStatus(data);
      }
    } catch (err) {
      console.error("Failed to fetch cleanup status:", err);
    }
  };

  useEffect(() => {
    reloadCleanupStatus();
  }, [settings.autoCleanupEnabled, settings.dataRetentionDays]);

  const updateOutboundProxy = async (e) => {
    e.preventDefault();
    if (settings.outboundProxyEnabled !== true) return;
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outboundProxyUrl: proxyForm.outboundProxyUrl,
          outboundNoProxy: proxyForm.outboundNoProxy,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setProxyStatus({ type: "success", message: translate("Proxy settings applied") });
      } else {
        setProxyStatus({ type: "error", message: data.error || translate("Failed to update proxy settings") });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: translate("An error occurred") });
    } finally {
      setProxyLoading(false);
    }
  };

  const testOutboundProxy = async () => {
    if (settings.outboundProxyEnabled !== true) return;

    const proxyUrl = (proxyForm.outboundProxyUrl || "").trim();
    if (!proxyUrl) {
      setProxyStatus({ type: "error", message: translate("Please enter a Proxy URL to test") });
      return;
    }

    setProxyTestLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings/proxy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl }),
      });

      const data = await res.json();
      if (res.ok && data?.ok) {
        setProxyStatus({
          type: "success",
          message: translate("profile.proxyTestOk", { status: data.status, elapsedMs: data.elapsedMs }),
        });
      } else {
        setProxyStatus({
          type: "error",
          message: data?.error || translate("Proxy test failed"),
        });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: translate("An error occurred") });
    } finally {
      setProxyTestLoading(false);
    }
  };

  const updateOutboundProxyEnabled = async (outboundProxyEnabled) => {
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outboundProxyEnabled }),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setProxyForm((prev) => ({ ...prev, outboundProxyEnabled: data?.outboundProxyEnabled === true }));
        setProxyStatus({
          type: "success",
          message: outboundProxyEnabled ? translate("Proxy enabled") : translate("Proxy disabled"),
        });
      } else {
        setProxyStatus({ type: "error", message: data.error || translate("Failed to update proxy settings") });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: translate("An error occurred") });
    } finally {
      setProxyLoading(false);
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (passwords.new !== passwords.confirm) {
      setPassStatus({ type: "error", message: translate("Passwords do not match") });
      return;
    }

    setPassLoading(true);
    setPassStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwords.current,
          newPassword: passwords.new,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setPassStatus({ type: "success", message: translate("Password updated successfully") });
        setPasswords({ current: "", new: "", confirm: "" });
      } else {
        setPassStatus({ type: "error", message: data.error || translate("Failed to update password") });
      }
    } catch (err) {
      setPassStatus({ type: "error", message: translate("An error occurred") });
    } finally {
      setPassLoading(false);
    }
  };

  const updateFallbackStrategy = async (strategy) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fallbackStrategy: strategy }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, fallbackStrategy: strategy }));
      }
    } catch (err) {
      console.error("Failed to update settings:", err);
    }
  };

  const updateComboStrategy = async (strategy) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStrategy: strategy }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, comboStrategy: strategy }));
      }
    } catch (err) {
      console.error("Failed to update combo strategy:", err);
    }
  };

  /**
   * F1: Toggle global Fusion primary/backup failover. When ON, combos whose
   * `models` are stored in {primary, backup}[] form will fall back to the
   * backup model if the primary call fails. When OFF, only the primary runs.
   * Persisted via PATCH /api/settings (settingsRepo already defaults this to true).
   */
  const updateFusionFailover = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fusionFailoverEnabled: enabled }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, fusionFailoverEnabled: enabled }));
      }
    } catch (err) {
      console.error("Failed to update fusion failover setting:", err);
    }
  };

  const updateQuotaPoolEnabled = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaPoolEnabled: enabled }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, quotaPoolEnabled: enabled }));
      }
    } catch (err) {
      console.error("Failed to update quota pool setting:", err);
    }
  };

  const updateProviderLimitsEnabled = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerLimitsEnabled: enabled }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, providerLimitsEnabled: enabled }));
      }
    } catch (err) {
      console.error("Failed to update provider limits setting:", err);
    }
  };

  const updateStickyLimit = async (limit) => {
    const numLimit = parseInt(limit);
    if (isNaN(numLimit) || numLimit < 1) return;

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stickyRoundRobinLimit: numLimit }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, stickyRoundRobinLimit: numLimit }));
      }
    } catch (err) {
      console.error("Failed to update sticky limit:", err);
    }
  };

  const updateComboStickyLimit = async (limit) => {
    const numLimit = parseInt(limit);
    if (isNaN(numLimit) || numLimit < 1) return;

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStickyRoundRobinLimit: numLimit }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, comboStickyRoundRobinLimit: numLimit }));
      }
    } catch (err) {
      console.error("Failed to update combo sticky limit:", err);
    }
  };

  const updateRequireLogin = async (requireLogin) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireLogin }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, requireLogin }));
      }
    } catch (err) {
      console.error("Failed to update require login:", err);
    }
  };

  const updateOidcForm = (field, value) => {
    setOidcForm((prev) => ({ ...prev, [field]: value }));
  };

  const saveOidcSettings = async (authMode = oidcForm.authMode || "password") => {
    const issuerUrl = oidcForm.oidcIssuerUrl.trim();
    const clientId = oidcForm.oidcClientId.trim();
    const scopes = oidcForm.oidcScopes.trim();
    const loginLabel = oidcForm.oidcLoginLabel.trim();
    const secret = oidcClientSecret.trim();

    if (authMode !== "password" && (!issuerUrl || !clientId || !secret) && !settings.oidcConfigured) {
      setOidcStatus({ type: "error", message: translate("Issuer URL, client ID, and client secret are required to enable OIDC.") });
      return;
    }

    setOidcLoading(true);
    setOidcStatus({ type: "", message: "" });
    setOidcTestStatus({ type: "", message: "" });

    try {
      const payload = {
        authMode,
        oidcIssuerUrl: issuerUrl,
        oidcClientId: clientId,
        oidcScopes: scopes || "openid profile email",
        oidcLoginLabel: loginLabel || "Sign in with OIDC",
      };
      if (secret) {
        payload.oidcClientSecret = secret;
      }

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setOidcForm({
          authMode: data?.authMode || authMode,
          oidcIssuerUrl: data?.oidcIssuerUrl || issuerUrl,
          oidcClientId: data?.oidcClientId || clientId,
          oidcScopes: data?.oidcScopes || scopes || "openid profile email",
          oidcLoginLabel: data?.oidcLoginLabel || loginLabel || "Sign in with OIDC",
        });
        setOidcClientSecret("");
        setOidcStatus({
          type: "success",
          message:
            authMode === "oidc"
              ? translate("OIDC login enabled")
              : authMode === "both"
                ? translate("Password and OIDC login enabled")
                : translate("OIDC settings saved"),
        });
      } else {
        setOidcStatus({ type: "error", message: data.error || translate("Failed to save OIDC settings") });
      }
    } catch (err) {
      setOidcStatus({ type: "error", message: translate("An error occurred") });
    } finally {
      setOidcLoading(false);
    }
  };

  const testOidcConnection = async () => {
    const issuerUrl = oidcForm.oidcIssuerUrl.trim();
    const clientId = oidcForm.oidcClientId.trim();
    const scopes = oidcForm.oidcScopes.trim();
    const secret = oidcClientSecret.trim();

    if (!issuerUrl || !clientId) {
      setOidcTestStatus({ type: "error", message: translate("Issuer URL and client ID are required to test the connection.") });
      return;
    }

    setOidcTestLoading(true);
    setOidcStatus({ type: "", message: "" });
    setOidcTestStatus({ type: "", message: "" });

    try {
      const saveRes = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authMode: oidcForm.authMode || settings.authMode || "password",
          oidcIssuerUrl: issuerUrl,
          oidcClientId: clientId,
          oidcScopes: scopes || "openid profile email",
          oidcLoginLabel: oidcForm.oidcLoginLabel.trim() || "Sign in with OIDC",
          ...(secret ? { oidcClientSecret: secret } : {}),
        }),
      });

      const saved = await saveRes.json().catch(() => ({}));
      if (!saveRes.ok) {
        setOidcTestStatus({
          type: "error",
          message: saved.error || translate("Failed to save OIDC settings before testing"),
        });
        return;
      }

      const res = await fetch("/api/auth/oidc/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issuerUrl: saved.oidcIssuerUrl || issuerUrl,
          clientId: saved.oidcClientId || clientId,
          scopes: saved.oidcScopes || scopes || "openid profile email",
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        const statusMessage = data.clientSecretTested
          ? data.clientSecretValid === true
            ? translate("profile.oidcConnectionOkSecretValid", { issuerUrl: data.issuerUrl })
            : translate("profile.oidcConnectionOkSecretUnchecked", { issuerUrl: data.issuerUrl })
          : translate("profile.oidcConnectionOk", { issuerUrl: data.issuerUrl });
        setOidcTestStatus({
          type: "success",
          message: statusMessage,
        });
      } else {
        setOidcTestStatus({ type: "error", message: data.error || translate("OIDC connection test failed") });
      }
    } catch (err) {
      setOidcTestStatus({ type: "error", message: translate("An error occurred") });
    } finally {
      setOidcTestLoading(false);
    }
  };

  const updateObservabilityEnabled = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableObservability: enabled }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, enableObservability: enabled }));
      }
    } catch (err) {
      console.error("Failed to update enableObservability:", err);
    }
  };

  const updateAutoCleanupEnabled = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoCleanupEnabled: enabled }),
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(prev => ({ ...prev, autoCleanupEnabled: enabled }));
      }
    } catch (err) {
      console.error("Failed to update autoCleanupEnabled:", err);
    }
  };

  const updateDataRetentionDays = async (days) => {
    const numDays = parseInt(days);
    if (isNaN(numDays) || numDays < 1) return;
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataRetentionDays: numDays }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, dataRetentionDays: numDays }));
      }
    } catch (err) {
      console.error("Failed to update dataRetentionDays:", err);
    }
  };

  const reloadSettings = async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data);
    } catch (err) {
      console.error("Failed to reload settings:", err);
    }
  };

  const handleExportDatabase = async (password) => {
    setDbLoading(true);
    setDbStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings/database", {
        headers: { "x-9r-password": password },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || translate("Failed to export database"));
      }

      const payload = await res.json();
      const content = JSON.stringify(payload, null, 2);
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      anchor.href = url;
      anchor.download = `OninOneProxy-backup-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      setDbStatus({ type: "success", message: translate("Database backup downloaded") });
    } catch (err) {
      setDbStatus({ type: "error", message: err.message || translate("Failed to export database") });
    } finally {
      setDbLoading(false);
    }
  };

  const handleImportDatabase = (event) => {
    const file = event.target.files?.[0];
    if (importFileRef.current) importFileRef.current.value = "";
    if (!file) return;
    pendingImportRef.current = file;
    setDbStatus({ type: "", message: "" });
    setDbAuth({ open: true, mode: "import", password: "" });
  };

  const runImportDatabase = async (password) => {
    const file = pendingImportRef.current;
    if (!file) return;
    setDbLoading(true);
    try {
      const raw = await file.text();
      const payload = JSON.parse(raw);

      const res = await fetch("/api/settings/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, password }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || translate("Failed to import database"));
      }

      await reloadSettings();
      setDbStatus({ type: "success", message: translate("Database imported successfully") });
    } catch (err) {
      setDbStatus({ type: "error", message: err.message || translate("Invalid backup file") });
    } finally {
      pendingImportRef.current = null;
      setDbLoading(false);
    }
  };

  // Confirm password modal, then run export or import.
  const handleDbAuthConfirm = async () => {
    const { mode, password } = dbAuth;
    setDbAuth({ open: false, mode: "", password: "" });
    if (mode === "export") await handleExportDatabase(password);
    else if (mode === "import") await runImportDatabase(password);
  };

  const observabilityEnabled = settings.enableObservability === true;

  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch("/api/version/shutdown", { method: "POST" });
    } catch (e) {
      // Expected to fail as server shuts down; ignore error
    }
    setIsShuttingDown(false);
    setShutdownOpen(false);
  };

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        window.location.assign("/login");
      }
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-0">
      <div className="flex flex-col gap-6">
        {/* Local Mode Info */}
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <div className="flex items-center gap-3 sm:gap-4">
              <div className="size-10 sm:size-12 rounded-lg bg-green-500/10 text-green-500 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-xl sm:text-2xl">computer</span>
              </div>
              <div>
                <h2 className="text-lg sm:text-xl font-semibold">{translate("Local Mode")}</h2>
                <p className="text-sm text-text-muted">{translate("Running on your machine")}</p>
              </div>
            </div>
            <div className="inline-flex p-1 rounded-lg bg-black/5 dark:bg-white/5 w-full sm:w-auto">
              {["light", "dark", "system"].map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setTheme(option)}
                  className={cn(
                    "flex items-center justify-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1.5 rounded-md font-medium transition-all flex-1 sm:flex-initial",
                    theme === option
                      ? "bg-white dark:bg-white/10 text-text-main shadow-sm"
                      : "text-text-muted hover:text-text-main"
                  )}
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {option === "light" ? "light_mode" : option === "dark" ? "dark_mode" : "contrast"}
                  </span>
                  <span className="capitalize text-xs sm:text-sm">{translate(option)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-3 pt-4 border-t border-border">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 rounded-lg bg-bg border border-border gap-2">
              <div>
                <p className="font-medium text-sm sm:text-base">Database Location</p>
                <p className="text-xs sm:text-sm text-text-muted font-mono break-all">~/.OninOneProxy/db/data.sqlite</p>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                variant="secondary"
                icon="download"
                onClick={() => setDbAuth({ open: true, mode: "export", password: "" })}
                loading={dbLoading}
                className="w-full sm:w-auto"
              >
                Download Backup
              </Button>
              <Button
                variant="outline"
                icon="upload"
                onClick={() => importFileRef.current?.click()}
                disabled={dbLoading}
                className="w-full sm:w-auto"
              >
                {translate("Import Backup")}
              </Button>
              <input
                ref={importFileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleImportDatabase}
              />
            </div>
            {dbStatus.message && (
              <p className={`text-sm ${dbStatus.type === "error" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
                {dbStatus.message}
              </p>
            )}
          </div>
        </Card>

        {/* Language */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="size-10 rounded-lg bg-blue-500/10 text-blue-500 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">language</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">{translate("Language")}</h3>
          </div>
          <button
            onClick={() => setLangOpen(true)}
            className="flex items-center justify-between w-full p-3 rounded-lg bg-bg border border-border hover:border-primary/50 transition-colors"
            data-i18n-skip="true"
          >
            <span className="text-sm text-text-muted">{translate("Display language")}</span>
            <span className="text-2xl">{LOCALE_FLAGS[locale] || "🌐"}</span>
          </button>
        </Card>

        {/* Security */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
              <span className="material-symbols-outlined text-[20px]">shield</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">{translate("Security")}</h3>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("Require login")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("When ON, dashboard requires password. When OFF, access without login.")}
                </p>
              </div>
              <Toggle
                checked={settings.requireLogin === true}
                onChange={() => updateRequireLogin(!settings.requireLogin)}
                disabled={loading}
              />
            </div>
            {settings.requireLogin === true && (
              <form onSubmit={handlePasswordChange} className="flex flex-col gap-4 pt-4 border-t border-border/50">
                {settings.hasPassword && (
                  <div className="flex flex-col gap-2">
                    <label className="text-xs sm:text-sm font-medium">{translate("Current Password")}</label>
                    <Input
                      type="password"
                      placeholder={translate("Enter current password")}
                      value={passwords.current}
                      onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                      required
                    />
                  </div>
                )}
                {/* {!settings.hasPassword && (
                  <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <p className="text-sm text-blue-600 dark:text-blue-400">
                      Setting password for the first time. Leave current password empty or use default: <code className="bg-blue-500/20 px-1 rounded">123456</code>
                    </p>
                  </div>
                )} */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-xs sm:text-sm font-medium">{translate("New Password")}</label>
                    <Input
                      type="password"
                      placeholder={translate("Enter new password")}
                      value={passwords.new}
                      onChange={(e) => setPasswords({ ...passwords, new: e.target.value })}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-xs sm:text-sm font-medium">{translate("Confirm New Password")}</label>
                    <Input
                      type="password"
                      placeholder={translate("Confirm new password")}
                      value={passwords.confirm}
                      onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
                      required
                    />
                  </div>
                </div>

                {passStatus.message && (
                  <p className={`text-xs sm:text-sm ${passStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                    {passStatus.message}
                  </p>
                )}

                <div className="pt-2">
                  <Button type="submit" variant="primary" loading={passLoading} className="w-full sm:w-auto">
                    {settings.hasPassword ? translate("Update Password") : translate("Set Password")}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </Card>

        {/* OIDC */}
        <Card>
          <button
            type="button"
            onClick={() => setOidcExpanded((v) => !v)}
            className="w-full flex items-center gap-3 text-left"
          >
            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">lock_open</span>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base sm:text-lg font-semibold">{translate("OIDC Dashboard Login")}</h3>
              <p className="text-xs text-text-muted">
                {settings.authMode === "oidc" ? translate("OIDC active") : settings.authMode === "both" ? translate("Password + OIDC active") : translate("Optional SSO via Authentik/Keycloak/Google")}
              </p>
            </div>
            <span className="material-symbols-outlined text-text-muted shrink-0">
              {oidcExpanded ? "expand_less" : "expand_more"}
            </span>
          </button>
          {oidcExpanded && (
          <div className="flex flex-col gap-4 mt-4">
            <p className="text-xs sm:text-sm text-text-muted">
              {translate("Use Authentik or any OIDC provider to sign in to the dashboard. You can enable password-only, OIDC-only, or both for the dashboard; model API access still uses API keys.")}
            </p>

            <div className="flex flex-col gap-2">
              <label className="font-medium text-sm sm:text-base">{translate("Auth Mode")}</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {[
                  {
                    value: "password",
                    title: translate("Password only"),
                    desc: translate("Keep the legacy password login."),
                  },
                  {
                    value: "oidc",
                    title: translate("OIDC only"),
                    desc: translate("Require OIDC for dashboard access."),
                  },
                  {
                    value: "both",
                    title: translate("Both"),
                    desc: translate("Allow either password or OIDC."),
                  },
                ].map((option) => {
                  const active = oidcForm.authMode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => updateOidcForm("authMode", option.value)}
                      className={cn(
                        "text-left rounded-lg border p-3 transition-colors",
                        active
                          ? "border-primary bg-primary/5"
                          : "border-border bg-bg hover:bg-black/5 dark:hover:bg-white/5"
                      )}
                      disabled={loading || oidcLoading}
                    >
                      <p className="font-medium text-sm sm:text-base">{option.title}</p>
                      <p className="text-xs sm:text-sm text-text-muted mt-1">{option.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4">
              <div className="flex flex-col gap-2">
                <label className="font-medium text-sm sm:text-base">{translate("Issuer URL")}</label>
                <Input
                  placeholder="https://auth.example.com/application/o/oninoneproxy/"
                  value={oidcForm.oidcIssuerUrl}
                  onChange={(e) => updateOidcForm("oidcIssuerUrl", e.target.value)}
                  disabled={loading || oidcLoading}
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="font-medium text-sm sm:text-base">{translate("Client ID")}</label>
                <Input
                  placeholder="OninOneProxy-dashboard"
                  value={oidcForm.oidcClientId}
                  onChange={(e) => updateOidcForm("oidcClientId", e.target.value)}
                  disabled={loading || oidcLoading}
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="font-medium text-sm sm:text-base">{translate("Client Secret")}</label>
                <Input
                  type="password"
                  placeholder={translate("Leave blank to keep existing secret")}
                  value={oidcClientSecret}
                  onChange={(e) => setOidcClientSecret(e.target.value)}
                  disabled={loading || oidcLoading}
                />
                <p className="text-xs sm:text-sm text-text-muted">{translate("This value is write-only after saving.")}</p>
              </div>

              <div className="flex flex-col gap-2">
                <label className="font-medium text-sm sm:text-base">{translate("Scopes")}</label>
                <Input
                  placeholder="openid profile email"
                  value={oidcForm.oidcScopes}
                  onChange={(e) => updateOidcForm("oidcScopes", e.target.value)}
                  disabled={loading || oidcLoading}
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="font-medium text-sm sm:text-base">{translate("Login Button Label")}</label>
                <Input
                  placeholder="Sign in with OIDC"
                  value={oidcForm.oidcLoginLabel}
                  onChange={(e) => updateOidcForm("oidcLoginLabel", e.target.value)}
                  disabled={loading || oidcLoading}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-bg p-3 text-xs sm:text-sm text-text-muted">
              <p className="font-medium text-text-main mb-1">{translate("Redirect URI")}</p>
              <code className="block break-all font-mono">{oidcRedirectUri}</code>
            </div>

            <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-border/50">
              <Button type="button" variant="primary" loading={oidcLoading} onClick={() => saveOidcSettings()} className="w-full sm:w-auto">
                {translate("Save auth mode")}
              </Button>
              <Button type="button" variant="outline" loading={oidcTestLoading} onClick={testOidcConnection} className="w-full sm:w-auto">
                {translate("Test connection")}
              </Button>
            </div>

            {oidcTestStatus.message && (
              <p className={`text-xs sm:text-sm ${oidcTestStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                {oidcTestStatus.message}
              </p>
            )}

            {oidcStatus.message && (
              <p className={`text-xs sm:text-sm ${oidcStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                {oidcStatus.message}
              </p>
            )}

            {settings.authMode === "oidc" && (
              <p className="text-xs sm:text-sm text-amber-600 dark:text-amber-400">
                {translate("OIDC login is currently active. Password login is disabled until you switch back.")}
              </p>
            )}

            {settings.authMode === "both" && (
              <p className="text-xs sm:text-sm text-amber-600 dark:text-amber-400">
                {translate("Password and OIDC login are both active.")}
              </p>
            )}
          </div>
          )}
        </Card>

        {/* Routing Preferences */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">route</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">{translate("Routing Strategy")}</h3>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("Round Robin")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Cycle through accounts to distribute load")}
                </p>
              </div>
              <Toggle
                checked={settings.fallbackStrategy === "round-robin"}
                onChange={() => updateFallbackStrategy(settings.fallbackStrategy === "round-robin" ? "fill-first" : "round-robin")}
                disabled={loading}
              />
            </div>

            {/* Sticky Round Robin Limit */}
            {settings.fallbackStrategy === "round-robin" && (
              <div className="flex items-start sm:items-center justify-between gap-4 pt-2 border-t border-border/50">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm sm:text-base">{translate("Sticky Limit")}</p>
                  <p className="text-xs sm:text-sm text-text-muted">
                    {translate("Calls per account before switching")}
                  </p>
                </div>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={settings.stickyRoundRobinLimit || 3}
                  onChange={(e) => updateStickyLimit(e.target.value)}
                  disabled={loading}
                  className="w-16 sm:w-20 text-center shrink-0"
                />
              </div>
            )}

            {/* Combo Round Robin */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("Combo Round Robin")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Cycle through providers in combos instead of always starting with first")}
                </p>
              </div>
              <Toggle
                checked={settings.comboStrategy === "round-robin"}
                onChange={() => updateComboStrategy(settings.comboStrategy === "round-robin" ? "fallback" : "round-robin")}
                disabled={loading}
              />
            </div>

            {/* Combo Sticky Round Robin Limit */}
            {settings.comboStrategy === "round-robin" && (
              <div className="flex items-center justify-between pt-2 border-t border-border/50">
                <div>
                  <p className="font-medium">{translate("Combo Sticky Limit")}</p>
                  <p className="text-sm text-text-muted">
                    {translate("Calls per combo model before switching")}
                  </p>
                </div>
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={settings.comboStickyRoundRobinLimit || 1}
                  onChange={(e) => updateComboStickyLimit(e.target.value)}
                  disabled={loading}
                  className="w-20 text-center"
                />
              </div>
            )}

            {/* F1: Fusion primary/backup failover — global toggle */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("Fusion Primary/Backup Failover")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("When ON, Fusion combos with")} {`{primary, backup}`} {translate("panel slots fall back to the backup model if the primary call fails. When OFF, only the primary runs.")}
                </p>
              </div>
              <Toggle
                checked={settings.fusionFailoverEnabled !== false}
                onChange={() => updateFusionFailover(!(settings.fusionFailoverEnabled !== false))}
                disabled={loading}
              />
            </div>

            {/* Quota Pool */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">配额池</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  启用后将在多个提供商之间智能分配请求配额
                </p>
              </div>
              <Toggle
                checked={settings.quotaPoolEnabled === true}
                onChange={() => updateQuotaPoolEnabled(!(settings.quotaPoolEnabled === true))}
                disabled={loading}
              />
            </div>

            {/* Provider Limits */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">提供商限额</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  启用后将按配置的速率限制控制各提供商请求频率
                </p>
              </div>
              <Toggle
                checked={settings.providerLimitsEnabled === true}
                onChange={() => updateProviderLimitsEnabled(!(settings.providerLimitsEnabled === true))}
                disabled={loading}
              />
            </div>

            <p className="text-xs text-text-muted italic pt-2 border-t border-border/50">
              {settings.fallbackStrategy === "round-robin"
                ? translate("profile.distributingRequests", { count: settings.stickyRoundRobinLimit || 3 })
                : translate("Currently using accounts in priority order (Fill First).")}
              {settings.comboStrategy === "round-robin"
                ? translate("profile.combosRotate", { count: settings.comboStickyRoundRobinLimit || 1, plural: (settings.comboStickyRoundRobinLimit || 1) === 1 ? "" : "s" })
                : translate(" Combos always start with their first model.")}
            </p>
          </div>
        </Card>

        {/* Network */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">wifi</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">{translate("Network")}</h3>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("Outbound Proxy")}</p>
                <p className="text-xs sm:text-sm text-text-muted">{translate("Enable proxy for OAuth + provider outbound requests.")}</p>
              </div>
              <Toggle
                checked={settings.outboundProxyEnabled === true}
                onChange={() => updateOutboundProxyEnabled(!(settings.outboundProxyEnabled === true))}
                disabled={loading || proxyLoading}
              />
            </div>

            {settings.outboundProxyEnabled === true && (
              <form onSubmit={updateOutboundProxy} className="flex flex-col gap-4 pt-2 border-t border-border/50">
                <div className="flex flex-col gap-2">
                  <label className="font-medium text-sm sm:text-base">{translate("Proxy URL")}</label>
                  <Input
                    placeholder="http://127.0.0.1:7897"
                    value={proxyForm.outboundProxyUrl}
                    onChange={(e) => setProxyForm((prev) => ({ ...prev, outboundProxyUrl: e.target.value }))}
                    disabled={loading || proxyLoading}
                  />
                  <p className="text-xs sm:text-sm text-text-muted">{translate("Leave empty to inherit existing env proxy (if any).")}</p>
                </div>

                <div className="flex flex-col gap-2 pt-2 border-t border-border/50">
                  <label className="font-medium text-sm sm:text-base">{translate("No Proxy")}</label>
                  <Input
                    placeholder="localhost,127.0.0.1"
                    value={proxyForm.outboundNoProxy}
                    onChange={(e) => setProxyForm((prev) => ({ ...prev, outboundNoProxy: e.target.value }))}
                    disabled={loading || proxyLoading}
                  />
                  <p className="text-xs sm:text-sm text-text-muted">{translate("Comma-separated hostnames/domains to bypass the proxy.")}</p>
                </div>

                <div className="pt-2 border-t border-border/50 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    loading={proxyTestLoading}
                    disabled={loading || proxyLoading}
                    onClick={testOutboundProxy}
                    className="w-full sm:w-auto"
                  >
                    {translate("Test proxy URL")}
                  </Button>
                  <Button type="submit" variant="primary" loading={proxyLoading} className="w-full sm:w-auto">
                    {translate("Apply")}
                  </Button>
                </div>
              </form>
            )}

            {proxyStatus.message && (
              <p className={`text-xs sm:text-sm ${proxyStatus.type === "error" ? "text-red-500" : "text-green-500"} pt-2 border-t border-border/50`}>
                {proxyStatus.message}
              </p>
            )}
          </div>
        </Card>

        {/* Observability Settings */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">monitoring</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">{translate("Observability")}</h3>
          </div>
          <div className="flex items-start sm:items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm sm:text-base">{translate("Enable Observability")}</p>
              <p className="text-xs sm:text-sm text-text-muted">
                {translate("Record request details for inspection in the logs view")}
              </p>
            </div>
            <Toggle
              checked={observabilityEnabled}
              onChange={updateObservabilityEnabled}
              disabled={loading}
            />
          </div>
        </Card>

        {/* Auto Cleanup */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-teal-500/10 text-teal-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">cleaning_services</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">{translate("Auto Cleanup")}</h3>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("Enable Auto Cleanup")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Periodically purge old usage data, expired cache, and corrupt DB backups (24h interval)")}
                </p>
              </div>
              <Toggle
                checked={settings.autoCleanupEnabled === true}
                onChange={() => updateAutoCleanupEnabled(!(settings.autoCleanupEnabled === true))}
                disabled={loading}
              />
            </div>

            {settings.autoCleanupEnabled === true && (
              <div className="flex items-start sm:items-center justify-between gap-4 pt-2 border-t border-border/50">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm sm:text-base">{translate("Data Retention (days)")}</p>
                  <p className="text-xs sm:text-sm text-text-muted">
                    {translate("Records older than this are deleted on each sweep")}
                  </p>
                </div>
                <Input
                  type="number"
                  min="1"
                  max="365"
                  value={settings.dataRetentionDays || 30}
                  onChange={(e) => updateDataRetentionDays(e.target.value)}
                  disabled={loading}
                  className="w-20 text-center shrink-0"
                />
              </div>
            )}

            {cleanupStatus && (
              <div className="flex flex-col gap-2 pt-2 border-t border-border/50 text-xs sm:text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">{translate("Last cleanup")}</span>
                  <span className="font-mono">
                    {cleanupStatus.lastCleanupAt
                      ? new Date(cleanupStatus.lastCleanupAt).toLocaleString()
                      : translate("Never")}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">{translate("Next estimated")}</span>
                  <span className="font-mono">
                    {cleanupStatus.nextCleanupAt
                      ? new Date(cleanupStatus.nextCleanupAt).toLocaleString()
                      : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">{translate("Interval")}</span>
                  <span>{cleanupStatus.intervalHours || 24}h</span>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Task 10: Model Sync */}
        <ModelSyncCard
          settings={settings}
          onSettingsPatch={(updates) => setSettings((prev) => ({ ...prev, ...updates }))}
        />

        {/* Account actions */}
        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            fullWidth
            icon="power_settings_new"
            onClick={() => setShutdownOpen(true)}
            className="text-red-500 border-red-200 hover:bg-red-50 hover:border-red-300"
          >
            {translate("Shutdown")}
          </Button>
          <Button
            variant="outline"
            fullWidth
            icon="logout"
            onClick={handleLogout}
          >
            {translate("Logout")}
          </Button>
        </div>

        {/* App Info */}
        <div className="text-center text-xs sm:text-sm text-text-muted py-4">
          <p>{APP_CONFIG.name} v{APP_CONFIG.version}</p>
          <p className="mt-1">{translate("Local Mode - All data stored on your machine")}</p>
        </div>
      </div>

      <LanguageSwitcher
        hideTrigger
        isOpen={langOpen}
        onClose={(next) => {
          setLangOpen(false);
          setLocale(next);
        }}
      />
      <ConfirmModal
        isOpen={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title={translate("Close Proxy")}
        message={translate("Are you sure you want to close the proxy server?")}
        confirmText={translate("Close")}
        cancelText={translate("Cancel")}
        variant="danger"
        loading={isShuttingDown}
      />

      <Modal
        isOpen={dbAuth.open}
        onClose={() => setDbAuth({ open: false, mode: "", password: "" })}
        title={translate("Confirm Password")}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDbAuth({ open: false, mode: "", password: "" })} disabled={dbLoading}>
              {translate("Cancel")}
            </Button>
            <Button variant="primary" onClick={handleDbAuthConfirm} loading={dbLoading} disabled={!dbAuth.password}>
              {translate("Confirm")}
            </Button>
          </>
        }
      >
        <p className="text-text-muted mb-3 text-sm">
          {translate("profile.enterPasswordToAction", { action: dbAuth.mode === "export" ? translate("export") : translate("import") })}
        </p>
        <Input
          type="password"
          value={dbAuth.password}
          onChange={(e) => setDbAuth((s) => ({ ...s, password: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter" && dbAuth.password) handleDbAuthConfirm(); }}
          placeholder={translate("Current password")}
          autoFocus
        />
      </Modal>
    </div>
  );
}
