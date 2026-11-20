import path from 'node:path';
import { LOCALES } from '@/lib/i18n/locales';

const STORE_LOCALES = LOCALES.map((locale) => locale.code);

/** Export uses a language prefix on the web and a language folder on desktop. */
export function localeOf(file: string, locales: readonly string[] = []): string | null {
  const known = [...new Set([...locales, ...STORE_LOCALES])];
  const name = path.posix.basename(file);
  const prefix = known.find((code) => name.startsWith(`${code}_`));
  if (prefix) return prefix;
  const folders = path.posix.dirname(file).split('/').reverse();
  return folders.find((folder) => known.includes(folder)) ?? null;
}
