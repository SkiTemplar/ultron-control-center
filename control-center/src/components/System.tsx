import { useState } from "react";
import { Diagnostics } from "./system/Diagnostics";
import { type SystemSubTab } from "./system/system-tab/types";
import { SystemHeader } from "./system/system-tab/SystemHeader";
import { AppsPanel } from "./system/system-tab/AppsPanel";

// v2.7 cleanup (internal audit 2026-05-24):
//   - Bloatware sub-tab DROPPED: most catalog entries weren't present on his
//     box. He wants the same card-driven layout applied to his REAL apps so
//     he can spot abandoned installs instead.
//   - Troubleshooting sub-tab DROPPED: merged into Diagnostics under the
//     new "Diagnostics & Fixes" tab.
//   - Apps panel REDESIGNED: Library-style cartillas grouped by usage
//     category (Development / Games / Media / Productivity / System / Other)
//     with bigger type + horizontal cards. Each app exposes Folder + Uninstall.
//   - Hooks sub-tab REMOVED from System: Hooks now lives exclusively in
//     Library (Library > Hooks). Keeping it in two places caused confusion.

export function System() {
  const [subTab, setSubTab] = useState<SystemSubTab>("diagnostics");

  return (
    <div className="pb-8">
      <SystemHeader subTab={subTab} setSubTab={setSubTab} />
      <div className="px-10">
        {subTab === "apps" && <AppsPanel />}
        {subTab === "diagnostics" && <Diagnostics />}
      </div>
    </div>
  );
}
