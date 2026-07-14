"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, Button, Input, Select, Toggle } from "@/shared/components";
import { AI_PROVIDERS, AUTH_METHODS } from "@/shared/constants/config";
import { detectProviderFromKey } from "@/lib/key-prefix-detect";

const providerOptions = Object.values(AI_PROVIDERS).map((p) => ({
  value: p.id,
  label: p.name,
}));

const authMethodOptions = Object.values(AUTH_METHODS).map((m) => ({
  value: m.id,
  label: m.name,
}));

export default function NewProviderPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    provider: "",
    authMethod: "api_key",
    apiKey: "",
    displayName: "",
    isActive: true,
  });
  const [errors, setErrors] = useState({});

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: null }));
    }
  };

  // Auto-detect provider from API key prefix. Recomputes on every apiKey
  // change. Returns null when no known prefix matches. The user can still
  // manually override by picking from the Select — detection only sets
  // the default when the user hasn't chosen one yet, and surfaces a hint
  // banner so they can confirm or override.
  const detectedProvider = useMemo(() => {
    if (formData.authMethod !== "api_key" || !formData.apiKey) return null;
    return detectProviderFromKey(formData.apiKey);
  }, [formData.authMethod, formData.apiKey]);

  const detectedProviderName = detectedProvider
    ? AI_PROVIDERS[detectedProvider]?.name || detectedProvider
    : null;

  // Show the "auto-select" hint only when:
  //   1. We detected a provider from the key prefix, AND
  //   2. The user hasn't manually picked a provider yet (or picked one
  //      that doesn't match — in which case we show a mismatch warning).
  const showDetectionHint =
    formData.authMethod === "api_key" &&
    formData.apiKey &&
    detectedProvider;

  const isMismatch =
    showDetectionHint &&
    formData.provider &&
    formData.provider !== detectedProvider;

  const handleApiKeyChange = (value) => {
    handleChange("apiKey", value);
    // Auto-select the detected provider only when the user hasn't picked
    // one yet. This keeps the UX non-intrusive: if they already chose a
    // provider, we respect that and just show a mismatch warning.
    if (!formData.provider) {
      const detected = detectProviderFromKey(value);
      if (detected && AI_PROVIDERS[detected]) {
        handleChange("provider", detected);
      }
    }
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.provider) newErrors.provider = "Please select a provider";
    if (formData.authMethod === "api_key" && !formData.apiKey) {
      newErrors.apiKey = "API Key is required";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    try {
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (response.ok) {
        router.push("/dashboard/providers");
      } else {
        const data = await response.json();
        setErrors({ submit: data.error || "Failed to create provider" });
      }
    } catch (error) {
      setErrors({ submit: "An error occurred. Please try again." });
    } finally {
      setLoading(false);
    }
  };

  const selectedProvider = AI_PROVIDERS[formData.provider];

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <Link
          href="/dashboard/providers"
          className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary transition-colors mb-4"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          Back to Providers
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Add New Provider</h1>
        <p className="text-text-muted mt-2">
          Configure a new AI provider to use with your applications.
        </p>
      </div>

      {/* Form */}
      <Card>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* Provider Selection */}
          <Select
            label="Provider"
            options={providerOptions}
            value={formData.provider}
            onChange={(e) => handleChange("provider", e.target.value)}
            placeholder="Select a provider"
            error={errors.provider}
            required
          />

          {/* Provider Info */}
          {selectedProvider && (
            <Card.Section className="flex items-center gap-3">
              <div
                className="size-10 rounded-lg flex items-center justify-center bg-bg border border-border"
              >
                <span
                  className="material-symbols-outlined text-xl"
                  style={{ color: selectedProvider.color }}
                >
                  {selectedProvider.icon}
                </span>
              </div>
              <div>
                <p className="font-medium">{selectedProvider.name}</p>
                <p className="text-sm text-text-muted">
                  Selected provider
                </p>
              </div>
            </Card.Section>
          )}

          {/* Auth Method */}
          <div className="flex flex-col gap-3">
            <label className="text-sm font-medium">
              Authentication Method <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-3">
              {authMethodOptions.map((method) => (
                <button
                  key={method.value}
                  type="button"
                  onClick={() => handleChange("authMethod", method.value)}
                  className={`flex-1 flex items-center justify-center gap-2 p-4 rounded-lg border transition-all ${
                    formData.authMethod === method.value
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <span className="material-symbols-outlined">
                    {method.value === "api_key" ? "key" : "lock"}
                  </span>
                  <span className="font-medium">{method.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* API Key Input */}
          {formData.authMethod === "api_key" && (
            <>
              <Input
                label="API Key"
                type="password"
                placeholder="Paste your API key — provider will be auto-detected"
                value={formData.apiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                error={errors.apiKey}
                hint="Your API key will be encrypted and stored securely. Provider is auto-detected from the key prefix."
                required
              />
              {/* Auto-detection visual feedback */}
              {showDetectionHint && (
                <div
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    isMismatch
                      ? "border-yellow-300/50 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                      : "border-emerald-300/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  }`}
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {isMismatch ? "warning" : "auto_awesome"}
                  </span>
                  <span>
                    {isMismatch ? (
                      <>
                        已识别为 <strong>{detectedProviderName}</strong>，但当前选择的是
                        <strong> {AI_PROVIDERS[formData.provider]?.name || formData.provider}</strong>。
                        请确认 Key 与所选 provider 是否匹配。
                      </>
                    ) : (
                      <>
                        已从 Key 前缀自动识别为 <strong>{detectedProviderName}</strong>。
                        如不正确可手动修改。
                      </>
                    )}
                  </span>
                </div>
              )}
              {formData.apiKey && !detectedProvider && (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-muted">
                  <span className="material-symbols-outlined text-[18px]">info</span>
                  <span>
                    未识别到此 Key 的前缀，请手动选择 provider。
                  </span>
                </div>
              )}
            </>
          )}

          {/* OAuth2 Button */}
          {formData.authMethod === "oauth2" && (
            <Card.Section>
              <p className="text-sm text-text-muted mb-4">
                Connect your account using OAuth2 authentication.
              </p>
              <Button type="button" variant="secondary" icon="link">
                Connect with OAuth2
              </Button>
            </Card.Section>
          )}

          {/* Display Name */}
          <Input
            label="Display Name"
            placeholder="e.g., Production API, Dev Environment"
            value={formData.displayName}
            onChange={(e) => handleChange("displayName", e.target.value)}
            hint="Optional. A friendly name to identify this configuration."
          />

          {/* Active Toggle */}
          <Toggle
            checked={formData.isActive}
            onChange={(checked) => handleChange("isActive", checked)}
            label="Active"
            description="Enable this provider for use in your applications"
          />

          {/* Error Message */}
          {errors.submit && (
            <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
              {errors.submit}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-4 border-t border-border">
            <Link href="/dashboard/providers" className="flex-1">
              <Button type="button" variant="ghost" fullWidth>
                Cancel
              </Button>
            </Link>
            <Button type="submit" loading={loading} fullWidth className="flex-1">
              Create Provider
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

