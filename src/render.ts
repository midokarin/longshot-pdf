import { t, listSeparator } from "./i18n";
import { App, Component, MarkdownRenderer, MarkdownView, TFile } from "obsidian";
import { PAGEBREAK_CLASS } from "./blocks";
import { inlineImages, waitForRenderReady, waitForStableSize } from "./capture";
import type { RenderTheme } from "./settings";
import { delay, waitFrames } from "./utils";

export interface OffscreenRenderOptions {
	contentWidth: number;
	theme: RenderTheme;
	settleDelayMs: number;
	/** 等待异步内容渲染完成的最长时间（ms） */
	renderTimeoutMs?: number;
	/** 笔记标题：传入则按阅读视图的内联标题渲染进截图，null / 空表示不包含 */
	title?: string | null;
	onWarn?: (message: string) => void;
	/** 渲染进度提示（等待 Mermaid / 公式 / 图片时） */
	onProgress?: (message: string) => void;
}

export interface OffscreenRender {
	root: HTMLElement;
	/** 裁剪视窗：截图时按块设置高度 */
	stage: HTMLElement;
	/** 预览容器：截图时通过负 margin 平移 */
	content: HTMLElement;
	/** 块容器 */
	sizer: HTMLElement;
	heightCss: number;
	/** 超时仍未渲染完成的内容（空数组 = 全部就绪） */
	pending: string[];
	destroy: () => void;
}

const PAGEBREAK_LINE = /^[ \t]*\/\/\/[ \t]*$/;

/**
 * 把正文里单独成行的 /// 换成零高度的标记元素。
 * 直接在 Markdown 上插入 HTML 是最稳的做法：渲染后标记就在对应位置，
 * 收集分页断点时能拿到它的坐标，不用去反推 Markdown 行号与 DOM 的对应关系。
 */
export function withPagebreakMarkers(markdown: string): string {
	if (!markdown.includes("///")) return markdown;
	const lines = markdown.split("\n");
	let fence: string | null = null;
	return lines
		.map((line) => {
			const fenceMatch = line.match(/^[ \t]*(```+|~~~+)/);
			if (fenceMatch) {
				const marker = fenceMatch[1][0];
				if (!fence) {
					fence = marker;
				} else if (fence === marker) {
					fence = null;
				}
				return line;
			}
			if (!fence && PAGEBREAK_LINE.test(line)) {
				return `<div class="${PAGEBREAK_CLASS}"></div>`;
			}
			return line;
		})
		.join("\n");
}

/** 复刻阅读视图的内联标题元素（主题靠 show-inline-title + inline-title 两个类名生效） */
function createInlineTitle(title: string): HTMLElement {
	const el = document.createElement("div");
	el.className = "inline-title";
	el.setAttribute("contenteditable", "false");
	el.textContent = title;
	return el;
}

/**
 * 笔记 frontmatter 里声明的 cssclasses（也认 cssclass）。
 *
 * 这是笔记级样式（含用户自己的 CSS 片段）唯一的挂载点，必须由我们补上：
 * Obsidian 只会把它加在当前打开的阅读视图 / 源码视图上，离屏新建的容器拿不到，
 * 渲染器也不会把它渲染进内容里。缺了它，笔记自带的片段样式（图片尺寸、
 * callout 版式、字号……）会在导出时整片失效，和预览对不上。
 */
function noteCssClasses(app: App, file: TFile): string[] {
	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as
		| Record<string, unknown>
		| undefined;
	if (!frontmatter) return [];
	const classes: string[] = [];
	for (const [key, value] of Object.entries(frontmatter)) {
		if (!/^cssclass(es)?$/i.test(key)) continue;
		for (const item of Array.isArray(value) ? value : [value]) {
			if (typeof item === "string") {
				classes.push(...item.split(/[\s,]+/).filter(Boolean));
			}
		}
	}
	return classes;
}

/** 把一篇笔记按「阅读视图」的样式渲染到屏幕外的容器里 */
export async function renderPreviewOffscreen(
	app: App,
	file: TFile,
	opts: OffscreenRenderOptions
): Promise<OffscreenRender> {
	const root = document.createElement("div");
	root.className = "longshot-offscreen";

	const stage = document.createElement("div");
	stage.className = "longshot-stage";
	stage.style.setProperty("--longshot-width", `${Math.round(opts.contentWidth)}px`);

	const content = document.createElement("div");
	content.className = "markdown-preview-view markdown-rendered";
	if (opts.theme === "light") content.classList.add("theme-light");
	if (opts.theme === "dark") content.classList.add("theme-dark");

	// 笔记自己的 cssclasses：片段样式靠它生效，缺了就会退回 Obsidian / 主题的默认样式
	noteCssClasses(app, file).forEach((cls) => content.classList.add(cls));

	// 再尽量沿用当前阅读视图上主题附加的 class，保证观感一致；
	// 只在导出的就是当前打开这篇时才抄，否则会把别的笔记的类带过来
	const active = app.workspace.getActiveViewOfType(MarkdownView);
	const live =
		active?.file?.path === file.path
			? active.containerEl.querySelector(".markdown-preview-view")
			: null;
	if (live instanceof HTMLElement) {
		live.classList.forEach((cls) => {
			if (!cls.startsWith("theme-")) content.classList.add(cls);
		});
	}

	const sizer = document.createElement("div");
	sizer.className = "markdown-preview-sizer markdown-preview-section";

	// 阅读视图里标题是 sizer 的第一个子元素，放在正文之前，长截图就会带上标题
	if (opts.title) {
		content.classList.add("show-inline-title");
		sizer.appendChild(createInlineTitle(opts.title));
	}

	content.appendChild(sizer);
	stage.appendChild(content);
	root.appendChild(stage);
	document.body.appendChild(root);

	const component = new Component();
	component.load();

	try {
		const markdown = await app.vault.cachedRead(file);
		const renderer = MarkdownRenderer as unknown as {
			render(
				app: App,
				markdown: string,
				el: HTMLElement,
				sourcePath: string,
				component: Component
			): Promise<void>;
		};
		await renderer.render(app, withPagebreakMarkers(markdown), sizer, file.path, component);

		// 等待异步渲染（mermaid、数学公式、嵌入笔记、图片）：主动检测，就绪即继续
		await waitFrames(2);
		const settle = delay(Math.max(0, opts.settleDelayMs));
		const ready = await waitForRenderReady(content, {
			timeoutMs: Math.max(0, opts.renderTimeoutMs ?? 8000),
			onProgress: (pending) => opts.onProgress?.(t("等待渲染完成：{0}", pending.join(listSeparator))),
		});
		await settle;
		await inlineImages(sizer, opts.onWarn);
		await waitForStableSize(content);
		if (document.fonts?.ready) {
			await document.fonts.ready;
		}

		const heightCss =
			Math.ceil(
				Math.max(
					stage.scrollHeight,
					content.scrollHeight,
					content.getBoundingClientRect().height,
					sizer.scrollHeight
				)
			) + 2;

		return {
			root,
			stage,
			content,
			sizer,
			heightCss,
			pending: ready.pending,
			destroy: () => {
				try {
					component.unload();
				} catch {
					// 忽略卸载异常
				}
				root.remove();
			},
		};
	} catch (error) {
		component.unload();
		root.remove();
		throw error;
	}
}