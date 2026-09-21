/**
 * 浏览器 harness 用的 fs 桩件。
 * 水印 / 输出模块会 import "fs" 来读 vault 之外的绝对路径图片，
 * 这在 Obsidian（Electron）里没问题，但 harness 跑在浏览器里，只能顶替掉。
 * 走到的路径都只该是「系统绝对路径」，浏览器里本就不该出现，所以直接抛错。
 */
export const promises = {
	async readFile(path: string): Promise<Uint8Array> {
		throw new Error(`浏览器 harness 不支持读取系统路径：${path}`);
	},
};

export default { promises };
