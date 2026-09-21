import * as obsidian from "obsidian";
import { en } from "./locales/en";

export type Locale = "zh" | "en";
export type MessageKey = keyof typeof en;

/** Obsidian 1.8.7+ exposes getLanguage; older supported releases store it locally. */
export function detectLocale(): Locale {
	let language: string | null | undefined;
	try {
		language = (obsidian as unknown as { getLanguage?: () => string }).getLanguage?.();
	} catch { /* Fall back to the older language setting. */ }
	if (!language) {
		try { language = localStorage.getItem("language"); } catch { /* Storage may be unavailable. */ }
	}
	language ||= typeof navigator === "undefined" ? "en" : navigator.language;
	return /^zh(?:[-_]|$)/i.test(language) ? "zh" : "en";
}

// Obsidian reloads when its language changes. Resolve once so labels, menus and
// progress messages use the same language throughout an export.
export const locale = detectLocale();
export const listSeparator = locale === "zh" ? "、" : ", ";

export function translate(language: Locale, key: MessageKey, ...values: unknown[]): string {
	const message = language === "zh" ? key : en[key];
	// Function replacement keeps user text (including $&, braces and Chinese)
	// literal, and does not interfere with export variables such as {{name}}.
	return message.replace(/\{(\d+)\}/g, (token, index: string) =>
		Number(index) < values.length ? String(values[Number(index)]) : token
	);
}

export function t(key: MessageKey, ...values: unknown[]): string {
	return translate(locale, key, ...values);
}
