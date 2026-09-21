import { App, TFile, normalizePath } from "obsidian";
import { promises as fs } from "fs";
import {
	dateStamp,
	fillTemplate,
	isAbsolutePath,
	sanitizeBaseName,
	timeStamp,
	trimTrailingSlash,
} from "./utils";
import type { LongshotSettings } from "./settings";

/** 导出目标：系统绝对路径走 Node fs，库内相对路径走 vault API */
export interface OutputTarget {
	kind: "fs" | "vault";
	/** fs 时是绝对路径；vault 时是库内相对路径（空串表示库根目录） */
	folder: string;
}

/** 逐级创建库内文件夹，已存在的层级跳过 */
async function ensureFolderPath(app: App, folder: string): Promise<void> {
	const path = normalizePath(folder);
	if (!path || path === "/" || path === ".") return;
	const parts = path.split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			await app.vault.createFolder(current);
		}
	}
}

/**
 * 解析当前设置下的导出目标：
 * - 输出位置留空 → 跟随笔记所在目录（没有笔记时落到库根目录）
 * - 输出位置是绝对路径 → 直接写系统文件系统
 * - 其余按库内相对路径处理
 */
export function resolveOutputTarget(
	settings: LongshotSettings,
	file: TFile | null
): OutputTarget {
	const dir = settings.outputDir.trim();
	if (!dir) return { kind: "vault", folder: file?.parent?.path ?? "" };
	return isAbsolutePath(dir)
		? { kind: "fs", folder: trimTrailingSlash(dir) }
		: { kind: "vault", folder: normalizePath(dir) };
}

/** 目标文件夹不存在时创建它 */
export async function ensureTarget(app: App, target: OutputTarget): Promise<void> {
	if (target.kind === "fs") {
		await fs.mkdir(target.folder, { recursive: true });
		return;
	}
	await ensureFolderPath(app, target.folder);
}

/** 设置页 / 快速面板里展示的「当前会存到哪里」 */
export function describeTarget(target: OutputTarget, file: TFile | null): string {
	if (target.kind === "fs") return target.folder;
	if (target.folder) return `（库内：${target.folder}）`;
	return file ? `（跟随笔记：${file.parent?.path || "库根目录"}）` : "（跟随笔记所在目录）";
}

/** 库在磁盘上的根目录；系统文件选择框用它当默认位置 */
export function vaultRootPath(app: App): string {
	return app.vault?.adapter?.getBasePath?.() ?? "";
}

/** 文件名模板可用变量 */
export function templateVars(file: TFile): Record<string, string> {
	return { name: file.basename, date: dateStamp(), time: timeStamp() };
}

/** 按「文件名模板」生成文件名（不含目录） */
export function buildFileName(
	settings: LongshotSettings,
	file: TFile,
	ext: string,
	suffix = ""
): string {
	return `${sanitizeBaseName(fillTemplate(settings.fileTemplate, templateVars(file)))}${suffix}.${ext}`;
}

/** 写入二进制文件并返回最终路径；同名文件直接覆盖 */
export async function writeBinary(
	app: App,
	target: OutputTarget,
	name: string,
	data: ArrayBuffer
): Promise<string> {
	if (target.kind === "fs") {
		const fullPath = `${target.folder}/${name}`;
		await fs.writeFile(fullPath, new Uint8Array(data));
		return fullPath;
	}
	const path = normalizePath(target.folder ? `${target.folder}/${name}` : name);
	const existing = app.vault.getAbstractFileByPath(path);
	return existing instanceof TFile
		? (await app.vault.modifyBinary(existing, data), existing.path)
		: (await app.vault.createBinary(path, data)).path;
}