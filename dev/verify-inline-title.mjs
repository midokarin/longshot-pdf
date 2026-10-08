/**
 * Issue #1: compare the real offscreen renderer and capture pipeline with a
 * reading-view reference. Only the Obsidian host/Markdown parser is stubbed.
 *
 * node dev/verify-inline-title.mjs
 * node dev/verify-inline-title.mjs --baseline=0.2.4  # should fail before the fix
 * CHROMIUM_PATH=/path/to/chrome node dev/verify-inline-title.mjs
 * PNG evidence and JSON results are written under work/inline-title/.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice(11);
const pluginCss = baseline
	? execFileSync("git", ["show", `${baseline}:styles.css`], { cwd: repo, encoding: "utf8" })
	: fs.readFileSync(path.join(repo, "styles.css"), "utf8");
const output = path.join(repo, "work", "inline-title", baseline ? "baseline" : "current");
fs.mkdirSync(output, { recursive: true });

function findChromium() {
	if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
	if (fs.existsSync(chromium.executablePath())) return chromium.executablePath();
	const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH,
		path.join(os.homedir(), "Library/Caches/ms-playwright"),
		path.join(os.homedir(), ".cache/ms-playwright"),
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright")].filter(Boolean);
	for (const cache of caches) {
		if (!fs.existsSync(cache)) continue;
		for (const dir of fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
			for (const suffix of ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
				"chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
				"chrome-linux/chrome", "chrome-linux64/chrome", "chrome-win/chrome.exe", "chrome-win64/chrome.exe"]) {
				const candidate = path.join(cache, dir, suffix);
				if (fs.existsSync(candidate)) return candidate;
			}
		}
	}
	throw new Error("Chromium not found. Set CHROMIUM_PATH or install the Playwright Chromium browser.");
}

const bundle = await build({
	stdin: { contents: 'export { renderPreviewOffscreen } from "./src/render"; export { captureViewport, resolveBackgroundColor } from "./src/capture";', resolveDir: repo },
	bundle: true, write: false, format: "iife", globalName: "titleTest",
	plugins: [{
		name: "obsidian-render-host",
		setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "title-test" }));
			builder.onLoad({ filter: /.*/, namespace: "title-test" }, () => ({ contents: `
				export class Component { load() {} unload() {} }
				export class MarkdownView {}
				export function getLanguage() { return "en"; }
				export class MarkdownRenderer {
					static async render(app, markdown, el) {
						const p = document.createElement("p");
						p.textContent = markdown;
						el.appendChild(p);
					}
				}
			` }));
		},
	}],
});

// A small host stylesheet models Obsidian's reading-view title contract.
// Snippets below are ordinary theme/user CSS; none refer to Longshot classes.
const hostCss = `
body { margin: 0; font: 16px Arial, sans-serif; --h1-color: inherit; --inline-title-color: var(--h1-color); }
.theme-light { --background-primary: #ffffff; --text-normal: #222222; }
.theme-dark { --background-primary: #181c25; --text-normal: #e8edf4; }
.markdown-preview-view { background: var(--background-primary); color: var(--text-normal); display: flow-root; }
.markdown-preview-sizer { display: flow-root; }
.inline-title {
  display: none;
  font-family: var(--inline-title-font, inherit);
  font-size: var(--inline-title-size, 1.8em);
  font-weight: var(--inline-title-weight, 700);
  font-style: var(--inline-title-style, normal);
  line-height: var(--inline-title-line-height, 1.5);
  margin-bottom: var(--inline-title-margin-bottom, 0.5em);
  color: var(--inline-title-color);
}
.show-inline-title .inline-title { display: block; }
p { margin: 0 0 16px; line-height: 24px; }
`;
const snippetCss = `
.inherited-dark-note { background-color: #202020; color: #ececec; }
.dark-note { background-color: #18202b; color: #d2dce8; }
.dark-note .inline-title {
  color: #f4cf83; font-family: Georgia, serif; font-size: 38px;
  font-weight: 500; font-style: italic; line-height: 1.25; margin-bottom: 23px;
}
.variable-note {
  --inline-title-color: #126782; --inline-title-size: 34px;
  --inline-title-font: Georgia, serif; --inline-title-weight: 500;
  --inline-title-style: italic; --inline-title-line-height: 1.3;
  --inline-title-margin-bottom: 21px;
}
.theme-dark .mode-note .inline-title, .theme-dark.mode-note .inline-title { color: #93dfed; }
.theme-light .mode-note .inline-title, .theme-light.mode-note .inline-title { color: #234c66; }
.hide-titles .inline-title { display: none; }
.other-note .inline-title { color: #ff0000; }
`;
const cases = [
	{ name: "inherited-note-title-color", body: "theme-light", note: "inherited-dark-note", theme: "theme" },
	{ name: "dark-note-snippet", body: "theme-light", note: "dark-note", theme: "theme" },
	{ name: "snippet-loaded-before-plugin", body: "theme-light", note: "dark-note", theme: "theme", snippetFirst: true },
	{ name: "inactive-dark-note", body: "theme-light", note: "dark-note", theme: "theme", inactive: true },
	{ name: "dark-body", body: "theme-dark", note: "", theme: "theme" },
	{ name: "light-body", body: "theme-light", note: "", theme: "theme" },
	{ name: "force-dark-from-light", body: "theme-light", note: "", theme: "dark" },
	{ name: "force-light-from-dark", body: "theme-dark", note: "", theme: "light" },
	{ name: "direct-theme-title", body: "theme-light", note: "mode-note", theme: "theme" },
	{ name: "title-css-variables", body: "theme-light", note: "variable-note", theme: "theme" },
	{ name: "include-hidden-title", body: "theme-light hide-titles", note: "dark-note", theme: "theme", hidden: true },
	{ name: "omit-null-title", body: "theme-light", note: "dark-note", theme: "theme", title: null },
	{ name: "omit-empty-title", body: "theme-light", note: "dark-note", theme: "theme", title: "" },
];
const browser = await chromium.launch({ executablePath: findChromium() });
const results = [];
try {
	for (const scenario of cases) {
		const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		try {
			await page.setContent("<!doctype html><meta charset='utf-8'><title>Inline title regression</title>");
			await page.addStyleTag({ content: hostCss });
			await page.addStyleTag({ content: scenario.snippetFirst ? snippetCss : pluginCss });
			await page.addStyleTag({ content: scenario.snippetFirst ? pluginCss : snippetCss });
			await page.addScriptTag({ content: bundle.outputFiles[0].text });
			const result = await page.evaluate(async (scenario) => {
				const { renderPreviewOffscreen, captureViewport, resolveBackgroundColor } = titleTest;
				document.body.className = scenario.body;
				const title = Object.hasOwn(scenario, "title") ? scenario.title : "Longshot title sample";
				const text = "The note keeps its own background and typography when exported.";
				const width = 680;
				const makeReadingView = (classes) => {
					const view = document.createElement("div");
					view.className = `markdown-preview-view markdown-rendered show-inline-title ${classes}`;
					const sizer = document.createElement("div");
					sizer.className = "markdown-preview-sizer markdown-preview-section";
					if (title) {
						const heading = document.createElement("div");
						heading.className = "inline-title";
						heading.textContent = title;
						heading.setAttribute("contenteditable", "false");
						sizer.appendChild(heading);
					}
					const paragraph = document.createElement("p");
					paragraph.textContent = text;
					sizer.appendChild(paragraph);
					view.appendChild(sizer);
					return view;
				};
				const source = makeReadingView(scenario.inactive ? "other-note" : scenario.note);
				const sourceContainer = document.createElement("div");
				sourceContainer.appendChild(source);
				document.body.appendChild(sourceContainer);
				const before = sourceContainer.outerHTML;
				const bodyBefore = document.body.className;
				const file = { path: "Fixture.md" };
				const app = {
					metadataCache: { getFileCache: () => ({ frontmatter: { cssclasses: [scenario.note] } }) },
					workspace: { getActiveViewOfType: () => ({ file: { path: scenario.inactive ? "Other.md" : file.path }, containerEl: sourceContainer }) },
					vault: { cachedRead: async () => text },
				};
				const rendered = await renderPreviewOffscreen(app, file, {
					contentWidth: width, theme: scenario.theme, title, settleDelayMs: 0, renderTimeoutMs: 1000,
				});
				const referenceStage = document.createElement("div");
				referenceStage.style.cssText = `width:${width}px;overflow:hidden;display:flow-root`;
				const reference = makeReadingView(`${scenario.note} ${scenario.theme === "theme" ? "" : `theme-${scenario.theme}`}`);
				// Including a title is an explicit export option even when the host hides it.
				if (scenario.hidden && title) reference.querySelector(".inline-title").style.display = "block";
				referenceStage.appendChild(reference);
				document.body.appendChild(referenceStage);
				const titleStyles = (view) => {
					const heading = view.querySelector(".inline-title");
					if (!heading) return null;
					const style = getComputedStyle(heading);
					return Object.fromEntries(["color", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "marginBottom", "display"].map((property) => [property, style[property]]));
				};
				const expected = titleStyles(reference);
				const actual = titleStyles(rendered.content);
				const expectedHeight = Math.ceil(Math.max(referenceStage.scrollHeight, reference.scrollHeight, reference.getBoundingClientRect().height, reference.firstElementChild.scrollHeight)) + 2;
				const capture = async (stage, content, height) => (await captureViewport(stage, content, height, {
					scale: 1, backgroundColor: resolveBackgroundColor(content),
				})).canvas;
				const exported = await capture(rendered.stage, rendered.content, rendered.heightCss);
				const referenceCanvas = await capture(referenceStage, reference, expectedHeight);
				let differingPixels = 0;
				if (exported.width === referenceCanvas.width && exported.height === referenceCanvas.height) {
					const a = exported.getContext("2d").getImageData(0, 0, exported.width, exported.height).data;
					const b = referenceCanvas.getContext("2d").getImageData(0, 0, referenceCanvas.width, referenceCanvas.height).data;
					for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) differingPixels++;
				} else differingPixels = -1;
				const checks = {
					actual, expected, differingPixels,
					actualSize: [exported.width, exported.height], expectedSize: [referenceCanvas.width, referenceCanvas.height],
					sourceUnchanged: before === sourceContainer.outerHTML && bodyBefore === document.body.className,
					titleCount: rendered.content.querySelectorAll(".inline-title").length,
					pending: rendered.pending,
					exportPng: exported.toDataURL("image/png"), referencePng: referenceCanvas.toDataURL("image/png"),
				};
				rendered.destroy();
				checks.cleanedUp = !document.querySelector(".longshot-offscreen");
				return checks;
			}, scenario);
			for (const [key, filename] of [["exportPng", "export"], ["referencePng", "reading-view"]]) {
				fs.writeFileSync(path.join(output, `${scenario.name}-${filename}.png`), Buffer.from(result[key].split(",")[1], "base64"));
				delete result[key];
			}
			const failures = [];
			for (const [description, check] of [
				["reading-view title styles", () => assert.deepEqual(result.actual, result.expected)],
				["captured dimensions", () => assert.deepEqual(result.actualSize, result.expectedSize)],
				["captured pixels", () => assert.equal(result.differingPixels, 0)],
				["source view unchanged", () => assert.ok(result.sourceUnchanged)],
				["title inclusion", () => assert.equal(result.titleCount, Object.hasOwn(scenario, "title") ? 0 : 1)],
				["render readiness", () => assert.deepEqual(result.pending, [])],
				["cleanup", () => assert.ok(result.cleanedUp)],
				["browser errors", () => assert.deepEqual(errors, [])],
			]) {
				try { check(); } catch (error) { failures.push(`${description}: ${error.message}`); }
			}
			results.push({ name: scenario.name, ...result, failures });
			console.log(`${failures.length ? "FAIL" : "PASS"} ${scenario.name}${failures.length ? `: ${failures.map((failure) => failure.split(":")[0]).join(", ")}` : ""}`);
		} finally { await page.close(); }
	}
} finally { await browser.close(); }
fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ baseline: baseline ?? null, cases: results }, null, 2));
const failures = results.filter((result) => result.failures.length);
if (failures.length) {
	console.error(`${failures.length}/${cases.length} cases failed. Evidence: ${output}`);
	process.exitCode = 1;
} else console.log(`All ${cases.length} inline-title cases passed, including exact captured pixels. Evidence: ${output}`);
