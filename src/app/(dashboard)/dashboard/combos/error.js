"use client";
import { useEffect } from "react";
import { translate } from "@/i18n/runtime";

export default function CombosError({ error, reset }) {
  useEffect(() => {
    console.error("[CombosPage] render error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center gap-4 p-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="material-symbols-outlined text-[48px] text-text-muted">error_outline</span>
        <h2 className="text-lg font-semibold text-text-main">{translate("combos.errorTitle")}</h2>
        <p className="text-sm text-text-muted max-w-md">{translate("combos.errorMessage")}</p>
      </div>
      <button
        onClick={() => reset()}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
      >
        <span className="material-symbols-outlined text-[16px]">refresh</span>
        {translate("combos.retry")}
      </button>
    </div>
  );
}
