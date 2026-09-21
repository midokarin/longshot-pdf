import type { WatermarkFont } from "./settings";

export const MM_PER_INCH = 25.4;

/** 导出页面与页眉页脚统一使用的字体栈 */
export const PAGE_FONT_STACK =
	'"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/**
 * 水印可选字体。中文各款各自带一套中文字体回退；西文后面也挂上中文字体，
 * 这样中英混排时英文走西文字形、中文仍然能正常显示（而不是变成方框）。
 */
export const WATERMARK_FONT_STACKS: Record<WatermarkFont, string> = {
	// ── 中文 ──────────────────────────────────────────────
	sans: PAGE_FONT_STACK,
	serif:
		'"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", SimSun, Georgia, "Times New Roman", serif',
	kai: '"Kaiti SC", KaiTi, STKaiti, "Kaiti TC", "Noto Serif CJK SC", "Songti SC", serif',
	fangsong: '"FangSong", STFangsong, "Fangsong SC", "Noto Serif CJK SC", SimSun, serif',
	round: '"Yuanti SC", "Yuanti TC", "Hiragino Maru Gothic ProN", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
	mono: '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Noto Sans Mono CJK SC", "Courier New", monospace',
	pingfang: '"PingFang SC", "PingFang TC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
	yahei: '"Microsoft YaHei", "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif',
	// ── 西文 ──────────────────────────────────────────────
	helvetica: '"Helvetica Neue", Helvetica, Arial, "PingFang SC", "Noto Sans CJK SC", sans-serif',
	verdana: 'Verdana, Geneva, Tahoma, "PingFang SC", "Noto Sans CJK SC", sans-serif',
	georgia: 'Georgia, "Songti SC", "Noto Serif CJK SC", "Times New Roman", serif',
	garamond: 'Garamond, "EB Garamond", "Palatino Linotype", "Songti SC", "Noto Serif CJK SC", serif',
	times: '"Times New Roman", Times, "Songti SC", "Noto Serif CJK SC", serif',
	courier: '"Courier New", Courier, "SF Mono", Menlo, "Noto Sans Mono CJK SC", monospace',
	optima: 'Optima, "Optima Nova", Candara, "Avenir Next", "PingFang SC", "Noto Sans CJK SC", sans-serif',
	baskerville:
		'Baskerville, "Libre Baskerville", "Baskerville Old Face", "Times New Roman", "Songti SC", "Noto Serif CJK SC", serif',
	didot: 'Didot, "Didot LT STD", "Playfair Display", "Bodoni 72", Georgia, "Songti SC", "Noto Serif CJK SC", serif',
	futura: 'Futura, "Century Gothic", "Avenir Next", "Futura PT", "PingFang SC", "Noto Sans CJK SC", sans-serif',
	avenir: '"Avenir Next", Avenir, "Helvetica Neue", "PingFang SC", "Noto Sans CJK SC", sans-serif',
	palatino: '"Palatino Linotype", Palatino, "Book Antiqua", "Palatino LT STD", Georgia, "Songti SC", "Noto Serif CJK SC", serif',
	menlo: 'Menlo, "SF Mono", "JetBrains Mono", Consolas, "PingFang SC", "Noto Sans Mono CJK SC", monospace',
};

/** 磅(pt) → 像素(px) */
export function ptToPx(pt: number, dpi: number): number {
	return (pt / 72) * dpi;
}

/** 毫米(mm) → 像素(px) */
export function mmToPx(mm: number, dpi: number): number {
	return (mm / MM_PER_INCH) * dpi;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 2): number {
	const f = 10 ** digits;
	return Math.round(value * f) / f;
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function nextFrame(): Promise<void> {
	return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

export async function waitFrames(count = 2): Promise<void> {
	for (let i = 0; i < count; i++) {
		await nextFrame();
	}
}

/** 把 {{name}} 这类占位符替换为变量值（未知占位符保持原样） */
export function fillTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (match, key: string) =>
		key in vars ? vars[key] : match
	);
}

export function dateStamp(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function timeStamp(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 去掉文件名里 vault 不接受的字符 */
export function sanitizeBaseName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|#^[\]]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 0 ? cleaned : "untitled";
}

/** 是否是绝对路径（POSIX 的 /、Windows 盘符、UNC） */
export function isAbsolutePath(path: string): boolean {
	return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path.trim());
}

/** 去掉路径末尾的分隔符（保留根目录） */
export function trimTrailingSlash(path: string): string {
	const trimmed = path.trim().replace(/[\\/]+$/, "");
	return trimmed || path.trim();
}

export function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message || error.name;
	}
	if (typeof error === "string") {
		return error;
	}
	if (error && typeof error === "object" && "message" in error) {
		return String((error as { message: unknown }).message);
	}
	return String(error);
}