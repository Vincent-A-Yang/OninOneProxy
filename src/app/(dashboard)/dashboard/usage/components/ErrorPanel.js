"use client";

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/shared/components";
import { translate } from "@/i18n/runtime";

// ponytail: single-file component, no abstraction needed until >2 consumers
export default function ErrorPanel() {
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  const fetchErrors = useCallback(async () => {
    try {
      const res = await fetch("/api/usage/request-details?status=gte400&limit=50", {
        headers: { "Cache-Control": "no-store" },
      });
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      setErrors(data.details || data.rows || []);
    } catch {
      setErrors([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchErrors(); }, [fetchErrors]);

  if (loading) {
    return <Card padding="md"><p className="text-sm text-text-muted animate-pulse">{translate("Loading errors…")}</p></Card>;
  }

  if (errors.length === 0) {
    return (
      <Card padding="md">
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <span className="material-symbols-outlined text-3xl text-success">check_circle</span>
          <p className="text-sm text-text-muted">{translate("No errors recorded. All requests succeeded.")}</p>
        </div>
      </Card>
    );
  }

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-main flex items-center gap-2">
          <span className="material-symbols-outlined text-[16px] text-error">error</span>
          {translate("Recent Errors")}
          <span className="text-xs font-normal text-text-muted">({errors.length})</span>
        </h3>
        <button onClick={fetchErrors} className="text-xs text-primary hover:underline cursor-pointer">
          {translate("Refresh")}
        </button>
      </div>
      <div className="divide-y divide-border-subtle max-h-[480px] overflow-y-auto custom-scrollbar">
        {errors.map((row, i) => {
          const isExpanded = expanded === i;
          const time = row.createdAt ? new Date(row.createdAt).toLocaleString("zh-CN", { hour12: false }) : "—";
          const provider = row.provider || "—";
          const model = row.model || "—";
          const status = row.status || row.statusCode || "—";
          const key = row.apiKeyMasked || row.maskedKey || "—";
          const errMsg = row.error || row.errorMessage || "";
          const action = row.cascadeAction || row.action || "";

          return (
            <div key={i} className="hover:bg-surface-2/50 transition-colors">
              <button
                onClick={() => setExpanded(isExpanded ? null : i)}
                className="w-full text-left px-4 py-2.5 flex items-center gap-3 cursor-pointer"
              >
                <span className={`material-symbols-outlined text-[14px] shrink-0 ${Number(status) >= 500 ? "text-error" : "text-warning"}`}>
                  {Number(status) >= 500 ? "dangerous" : "warning"}
                </span>
                <span className="text-xs text-text-muted w-[130px] shrink-0 font-mono">{time}</span>
                <span className="text-xs font-medium text-text-main w-[80px] shrink-0 truncate">{provider}</span>
                <span className="text-xs text-text-muted flex-1 truncate">{model}</span>
                <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 ${Number(status) >= 500 ? "bg-error/10 text-error" : "bg-warning/10 text-warning"}`}>
                  {status}
                </span>
                <span className="material-symbols-outlined text-[14px] text-text-muted shrink-0 transition-transform" style={{ transform: isExpanded ? "rotate(180deg)" : "" }}>
                  expand_more
                </span>
              </button>
              {isExpanded && (
                <div className="px-4 pb-3 pl-10 space-y-1.5 text-xs text-text-muted">
                  <p><span className="font-medium text-text-main">API Key: </span><code className="font-mono bg-surface-2 px-1 rounded">{key}</code></p>
                  {errMsg && <p><span className="font-medium text-text-main">{translate("Error")}: </span>{errMsg}</p>}
                  {action && <p><span className="font-medium text-text-main">{translate("Action")}: </span><span className="text-primary">{action}</span></p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
