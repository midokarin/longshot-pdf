/**
 * 用本机缓存里的 Chromium 跑一遍 dev/harness.html，把日志打印出来并截图，
 * 用于在没有 Obsidian 的情况下验证「长截图 → 分页 → 排版 → PDF」整条流程。
 *
 *   node dev/verify.mjs [url]
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:8777/dev/harness.html";
const cacheRoot = path.join(os.homedir(), "Library/Caches/ms-playwright");

function findExecutable() {
	const candidates = fs
		.readdirSync(cacheRoot)
		.filter((name) => name.startsWith("chromium-"))
		.sort()
		.reverse();
	for (const name of candidates) {
		const base = path.join(cacheRoot, name, "chrome-mac-arm64", "Google Chrome for Testing.app");
		const exe = path.join(base, "Contents/MacOS/Google Chrome for Testing");
		if (fs.existsSync(exe)) return exe;
	}
	throw new Error("没有找到可用的 Chromium，请先安装 playwright 浏览器");
}

const browser = await chromium.launch({
	executablePath: findExecutable(),
	args: ["--font-render-hinting=none"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });

const consoleMessages = [];
page.on("console", (message) => consoleMessages.push(`[${message.type()}] ${message.text()}`));
page.on("pageerror", (error) => consoleMessages.push(`[pageerror] ${error.message}`));
page.on("requestfailed", (request) =>
	consoleMessages.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ""}`)
);

await page.goto(url, { waitUntil: "load" });

await page
	.waitForFunction(
		() => {
			const text = document.getElementById("log")?.textContent ?? "";
			return text.includes("验证完成") || text.includes("失败") || text.includes("异常") || text.includes("加载失败");
		},
		{ timeout: 300000 }
	)
	.catch(() => {});

const log = await page.evaluate(() => document.getElementById("log")?.textContent ?? "(空)");
const cards = await page.evaluate(() => document.querySelectorAll(".page-card").length);

console.log("========== harness 日志 ==========");
console.log(log);
console.log("========== 页面卡片数：" + cards + " ==========");
if (consoleMessages.length > 0) {
	console.log("========== 控制台 ==========");
	console.log(consoleMessages.join("\n"));
}

const shotPath = path.join(os.tmpdir(), "longshot-harness.png");
await page.screenshot({ path: shotPath, fullPage: true });
console.log(`截图：${shotPath}`);

/** 把 harness 里的 dataURL 复核图落盘，便于用图片查看器打开检查 */
const artifacts = await page.evaluate(() => {
	const win = window;
	const strip = win.__boundaryStrip;
	const previews = win.__pagePreviews ?? [];
	const thumbs = win.__thumbPreviews ?? [];
	return { strip, previews, thumbs };
});

const longPdfBase64 = await page.evaluate(() => window.__longPdf ?? "");

function saveDataUrl(dataUrl, file) {
	if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return false;
	const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
	fs.writeFileSync(file, Buffer.from(base64, "base64"));
	return true;
}

if (saveDataUrl(artifacts.strip, path.join(os.tmpdir(), "boundary-strip.png"))) {
	console.log(`换页边界复核图：${path.join(os.tmpdir(), "boundary-strip.png")}`);
}
artifacts.previews.forEach((dataUrl, index) => {
	const file = path.join(os.tmpdir(), `page-preview-${index}.png`);
	if (saveDataUrl(dataUrl, file)) console.log(`页面缩略图：${file}`);
});
artifacts.thumbs.forEach((dataUrl, index) => {
	const file = path.join(os.tmpdir(), `preview-thumb-${index}.png`);
	if (saveDataUrl(dataUrl, file)) console.log(`分页预览缩略图：${file}`);
});

if (longPdfBase64) {
	const file = path.join(os.tmpdir(), "long-pdf.pdf");
	fs.writeFileSync(file, Buffer.from(longPdfBase64, "base64"));
	console.log(`长截图 PDF：${file}`);
}

await browser.close();