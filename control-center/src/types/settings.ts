// Settings snapshot / save types.

export type SettingsSnapshot = {
  path: string;
  content: Record<string, unknown>;
  modified: string | null;
  size_bytes: number;
  backup_dir: string;
  recent_backups: string[];
};

export type SettingsSaveResult = {
  success: boolean;
  backup_path: string | null;
  new_size_bytes: number;
};
