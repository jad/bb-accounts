// Naming helpers shared by the server and the app bundle. Kept free of
// dependencies so the frontend can import them without pulling in zod.

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
}

/** Parent of new account folders, relative to the home directory. */
export const NEW_ACCOUNTS_DIR = {
  "claude-code": ".claude-accounts",
  codex: ".codex-accounts",
} as const;

/** The folder name a new account gets, or null when the label has no usable characters. */
export function accountFolderName(label: string): string | null {
  const slug = slugify(label);
  return slug === "" ? null : slug;
}
