import { t } from "./i18n";
/** 系统原生文件夹选择框：桌面版 Obsidian 通过 Electron 的 dialog 实现 */

interface OpenDialogResult {
	canceled: boolean;
	filePaths: string[];
}

interface ElectronDialog {
	showOpenDialog(window: unknown, options: Record<string, unknown>): Promise<OpenDialogResult>;
}

interface ElectronRemote {
	dialog?: ElectronDialog;
	getCurrentWindow?: () => unknown;
}

/** Obsidian 渲染进程里要么已经把 remote 挂在 electron 上，要么可以直接 require(@electron/remote) */
function loadRemote(): ElectronRemote | null {
	try {
		const electron = require("electron") as { remote?: ElectronRemote } | undefined;
		if (electron?.remote?.dialog) {
			return electron.remote;
		}
	} catch {
		// 继续尝试下一种方式
	}
	try {
		const remote = require("@electron/remote") as ElectronRemote | undefined;
		if (remote?.dialog) {
			return remote;
		}
	} catch {
		// 都不可用
	}
	return null;
}

export function isFolderPickerAvailable(): boolean {
	return loadRemote() !== null;
}

/** 图片扩展名，供文件选择框过滤 */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

async function openDialog(options: Record<string, unknown>): Promise<string | null> {
	const remote = loadRemote();
	if (!remote?.dialog) {
		throw new Error(t("当前环境打不开系统选择框（需要桌面版 Obsidian）"));
	}
	const result = await remote.dialog.showOpenDialog(remote.getCurrentWindow?.(), options);
	if (!result || result.canceled || result.filePaths.length === 0) {
		return null;
	}
	return result.filePaths[0];
}

/** 打开文件夹选择框，返回绝对路径；用户取消返回 null，环境不支持时抛出可读的错误 */
export async function pickFolder(options: {
	title: string;
	defaultPath?: string;
}): Promise<string | null> {
	return openDialog({
		title: options.title,
		defaultPath: options.defaultPath || undefined,
		buttonLabel: t("选择"),
		properties: ["openDirectory", "createDirectory"],
	});
}

/** 打开文件选择框选一张图片，返回绝对路径 */
export async function pickImageFile(options: {
	title: string;
	defaultPath?: string;
}): Promise<string | null> {
	return openDialog({
		title: options.title,
		defaultPath: options.defaultPath || undefined,
		buttonLabel: t("选用"),
		properties: ["openFile"],
		filters: [{ name: t("图片"), extensions: IMAGE_EXTENSIONS }],
	});
}