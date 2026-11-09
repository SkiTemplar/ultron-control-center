// Auth status types. Mirrors `AuthStatusEntry` / `AuthStatusReport` in
// src-tauri/src/auth.rs.

export type AuthStatusEntry = {
  provider: string;
  logged_in: boolean;
  credential_path: string;
  last_modified: string | null;
  age_days: number | null;
  binary_present: boolean;
  binary_path: string | null;
  note: string | null;
  /** Real validity from the credential file's expiry timestamp. null = the
   *  file carries no expiry, so validity is genuinely unverified (amber). */
  expires_at?: string | null;
  expired?: boolean | null;
};

export type AuthStatusReport = {
  entries: AuthStatusEntry[];
};
