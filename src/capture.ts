import { domToCanvas, type Options as ScreenshotOptions } from "modern-screenshot";
import { delay, nextFrame } from "./utils";

/** canvas 尺寸上限（Chromium 单边上限 65535，面积上限约 2.68 亿像素，这里留出安全余量） */
export const MAX_CANVAS_DIM = 32000;
export const MAX_CANVAS_AREA = 150_000_000;

/**
 * 单块截图的输出高度上限（像素）。
 *
 * 实测：单块输出高度 16000 px 时与「整页一次成像」完全一致，18000 px 起 Chromium
 * 会先缩放再放大，出现约 0.4% 的像素色差（很可能撞上了 16384 的光栅化上限）。
 * 这里取 16384 的 75%，既明显减少块数，又给不同内容留出余量。
 */
const MAX_CHUNK_PX = 12288;

export interface CapturePlan {
	scale: number;
	widthPx: number;
	heightPx: number;
	chunked: boolean;
	chunkCount: number;
	/** 实际采用的单块高度（CSS px） */
	chunkHeightCss: number;
}

export interface CaptureOptions {
	scale: number;
	backgroundColor: string;
	/**
	 * 单块高度（CSS px）的上限。仅供基准测试覆盖，正常导出不要传：
	 * 最优块高完全由 canvas 与光栅化上限推导（见 planCapture）。
	 */
	chunkHeightCss?: number;
	timeoutMs?: number;
	/**
	 * 承载「一级块」的容器（即 sizer）。传入后，分块截图会把落在裁剪窗口之外的块
	 * 临时掏空成等高空盒，让每次截图的克隆开销与「块高」成正比而不是与「全文长度」成正比。
	 */
	blocks?: HTMLElement;
	onProgress?: (done: number, total: number, label: string) => void;
}

export interface CaptureResult {
	canvas: HTMLCanvasElement;
	/** 实际使用的倍率（可能因尺寸保护被下调） */
	scale: number;
	widthCss: number;
	heightCss: number;
}

/**
 * 计算实际可用的截图倍率与单块高度。
 *
 * 倍率：内容极长时自动降级，避免最终 canvas 超出上限。
 * 单块高度：由 canvas 上限推导，块越大块数越少；固定的小块会把长笔记切成几十块，
 * 而每块都要重新克隆一次 DOM，这正是「页数一多就慢」的主要原因之一。
 */
export function planCapture(
	requestedScale: number,
	widthCss: number,
	heightCss: number,
	chunkHeightCss = 0
): CapturePlan {
	const fits = (scale: number) => {
		const widthPx = Math.round(widthCss * scale);
		const heightPx = Math.round(heightCss * scale);
		return (
			widthPx > 0 &&
			heightPx > 0 &&
			widthPx <= MAX_CANVAS_DIM &&
			heightPx <= MAX_CANVAS_DIM &&
			widthPx * heightPx <= MAX_CANVAS_AREA
		);
	};

	let scale = requestedScale;
	while (scale > 0.5 && !fits(scale)) {
		scale = Math.max(0.5, Math.round((scale - 0.25) * 100) / 100);
	}
	if (!fits(scale)) {
		throw new Error(
			`笔记内容过长（约 ${Math.round(heightCss)} px），超出 canvas 上限，无法一次性截取`
		);
	}

	const widthPx = Math.round(widthCss * scale);
	const heightPx = Math.round(heightCss * scale);

	const limits = [
		MAX_CANVAS_DIM / scale,
		MAX_CANVAS_AREA / Math.max(1, widthPx) / scale,
		MAX_CHUNK_PX / scale,
	];
	if (chunkHeightCss > 0) limits.push(chunkHeightCss);
	const chunk = Math.max(200, Math.floor(Math.min(...limits)));

	const chunked = heightCss > chunk;
	const chunkCount = chunked ? Math.ceil(heightCss / chunk) : 1;
	return { scale, widthPx, heightPx, chunked, chunkCount, chunkHeightCss: chunk };
}

function shotOptions(
	opts: CaptureOptions,
	widthCss: number,
	heightCss: number,
	scale: number
): ScreenshotOptions {
	return {
		scale,
		width: Math.round(widthCss),
		height: Math.round(heightCss),
		backgroundColor: opts.backgroundColor,
		timeout: opts.timeoutMs ?? 30000,
		fetch: { bypassingCache: true },
		// 避免现代主题里 oklch()/color-mix() 之类的异常色值打断渲染
		features: { removeAbnormalAttributes: true, removeControlCharacter: true },
	};
}

function shiftContent(content: HTMLElement, offsetCss: number): void {
	content.style.marginTop = offsetCss > 0 ? `-${offsetCss}px` : "0px";
}

/** 记录被掏空的块，用于截图后原样还原 */
interface PrunedBlock {
	el: HTMLElement;
	nodes: Node[];
	height: string;
	overflow: string;
	marginTop: string;
	marginBottom: string;
}

/** 元素自身的竖向 padding + border：把 border-box 高度换算成 content-box 高度时要用 */
function verticalBoxExtra(el: HTMLElement): { boxSizing: string; extra: number } {
	const style = getComputedStyle(el);
	const extra =
		parseFloat(style.paddingTop) +
		parseFloat(style.paddingBottom) +
		parseFloat(style.borderTopWidth) +
		parseFloat(style.borderBottomWidth);
	return { boxSizing: style.boxSizing, extra: extra || 0 };
}

/**
 * 元素在页面上「实际占位」的上/下外边距。
 *
 * 相邻块的间距是 max(前块 margin-bottom, 后块 margin-top) 折叠出来的，而且
 * 父元素与首/末子元素的边距还会折叠穿透。掏空一个块会连它子元素贡献的那部分
 * 边距一起丢掉（例如 h2 的 26px margin-top 折叠穿透到 section 上），
 * 于是后面所有块整体上移。这里先把折叠后的真实值算出来，掏空时写回去。
 */
function effectiveMargin(el: HTMLElement, side: "top" | "bottom"): number {
	const style = getComputedStyle(el);
	const own = parseFloat(side === "top" ? style.marginTop : style.marginBottom) || 0;
	const blockStart = side === "top" ? style.paddingTop : style.paddingBottom;
	const blockBorder = side === "top" ? style.borderTopWidth : style.borderBottomWidth;
	if (parseFloat(blockStart) > 0 || parseFloat(blockBorder) > 0) return own;
	if (style.overflow !== "visible") return own;
	if (style.display.startsWith("flex") || style.display.startsWith("grid")) return own;

	const child = side === "top" ? el.firstElementChild : el.lastElementChild;
	if (!(child instanceof HTMLElement)) return own;
	const childStyle = getComputedStyle(child);
	if (childStyle.position !== "static" || childStyle.float !== "none") return own;
	if (childStyle.display.startsWith("inline")) return own;
	return Math.max(own, effectiveMargin(child, side));
}

/**
 * 掏空时给裁剪窗口留出的安全边距（CSS px）。
 *
 * 实测发现：块的绘制范围可能超出它的 border-box（modern-screenshot 克隆渲染时，
 * 一个 `pre` 的背景会比 getBoundingClientRect 的底边多画约一行高，约 20px）。
 * 所以紧贴窗口边缘的块一律不掏空，避免把它们超出边框的那部分画到窗口里又丢掉。
 */
const PRUNE_SAFETY_CSS = 128;

/**
 * 把完全落在 [fromCss, toCss] 之外的一级块掏空，只保留一个等高的空盒子。
 *
 * modern-screenshot 每次截图都会克隆整棵 DOM，并对每个元素调 getComputedStyle
 * （元素本身 + ::before + ::after）。所以单次开销 ≈ O(全文长度)，与裁剪高度无关；
 * 分块截图做 N 次就是 N 倍开销，内容越长越慢。掏空视窗外的块之后，
 * 克隆的节点数与「块高」成正比，整条链路从超线性退回线性。
 *
 * 为了像素完全一致，掏空时必须同时顶住「块高」和「折叠后的上下外边距」，
 * 否则后面所有块会整体位移。返回还原函数。
 */
export function pruneOutsideBlocks(container: HTMLElement, fromCss: number, toCss: number): () => void {
	const stashed: PrunedBlock[] = [];
	const containerTop = container.getBoundingClientRect().top;
	const keepFrom = fromCss - PRUNE_SAFETY_CSS;
	const keepTo = toCss + PRUNE_SAFETY_CSS;
	const boxes = Array.from(container.children)
		.filter((child): child is HTMLElement => child instanceof HTMLElement)
		.map((el) => {
			const rect = el.getBoundingClientRect();
			return { el, top: rect.top - containerTop, bottom: rect.bottom - containerTop, height: rect.height };
		});

	for (const box of boxes) {
		if (box.bottom > keepFrom && box.top < keepTo) continue;

		const { boxSizing, extra } = verticalBoxExtra(box.el);
		// 必须在掏空之前读：折叠边距要靠子元素才能算出来
		const marginTop = effectiveMargin(box.el, "top");
		const marginBottom = effectiveMargin(box.el, "bottom");
		stashed.push({
			el: box.el,
			nodes: Array.from(box.el.childNodes),
			height: box.el.style.height,
			overflow: box.el.style.overflow,
			marginTop: box.el.style.marginTop,
			marginBottom: box.el.style.marginBottom,
		});
		box.el.replaceChildren();
		box.el.style.height = `${boxSizing === "border-box" ? box.height : box.height - extra}px`;
		box.el.style.overflow = "hidden";
		box.el.style.marginTop = `${marginTop}px`;
		box.el.style.marginBottom = `${marginBottom}px`;
	}

	return () => {
		for (const item of stashed) {
			item.el.replaceChildren(...item.nodes);
			item.el.style.height = item.height;
			item.el.style.overflow = item.overflow;
			item.el.style.marginTop = item.marginTop;
			item.el.style.marginBottom = item.marginBottom;
		}
	};
}

/**
 * 对「裁剪视窗 + 可平移内容」做长截图。
 * stage 是固定尺寸的 overflow:hidden 视窗，content 内部通过负 margin 平移，
 * 每块单独渲染后再拼接，可绕开超长 DOM 一次成像时的 canvas 限制。
 */
export async function captureViewport(
	stage: HTMLElement,
	content: HTMLElement,
	heightCss: number,
	opts: CaptureOptions
): Promise<CaptureResult> {
	const widthCss = Math.round(stage.getBoundingClientRect().width);
	if (widthCss <= 0 || heightCss <= 0) {
		throw new Error("截图区域尺寸异常，无法截取");
	}

	const plan = planCapture(opts.scale, widthCss, heightCss, opts.chunkHeightCss);
	const canvas = document.createElement("canvas");
	canvas.width = plan.widthPx;
	canvas.height = plan.heightPx;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("无法创建 canvas 上下文");
	}
	if (opts.backgroundColor) {
		ctx.fillStyle = opts.backgroundColor;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
	}

	if (!plan.chunked) {
		opts.onProgress?.(0, 1, "整页截取");
		stage.style.height = `${Math.ceil(heightCss)}px`;
		shiftContent(content, 0);
		await nextFrame();
		const shot = await domToCanvas(stage, shotOptions(opts, widthCss, heightCss, plan.scale));
		ctx.drawImage(shot, 0, 0, canvas.width, canvas.height);
		opts.onProgress?.(1, 1, "整页截取");
		return { canvas, scale: plan.scale, widthCss, heightCss };
	}

	const chunkCss = plan.chunkHeightCss;
	let done = 0;
	for (let offset = 0; offset < heightCss; offset += chunkCss) {
		const sliceCss = Math.min(chunkCss, heightCss - offset);
		shiftContent(content, offset);
		stage.style.height = `${Math.ceil(sliceCss)}px`;
		await nextFrame();
		await delay(20);
		const restore = opts.blocks
			? pruneOutsideBlocks(opts.blocks, offset, offset + sliceCss)
			: null;
		let shot: HTMLCanvasElement;
		try {
			shot = await domToCanvas(stage, shotOptions(opts, widthCss, sliceCss, plan.scale));
		} finally {
			restore?.();
		}
		const destY = Math.round(offset * plan.scale);
		const destH = Math.min(canvas.height - destY, Math.round(sliceCss * plan.scale));
		if (destH > 0) {
			ctx.drawImage(shot, 0, 0, shot.width, destH, 0, destY, canvas.width, destH);
		}
		shot.width = 0;
		shot.height = 0;
		done += 1;
		opts.onProgress?.(done, plan.chunkCount, `分块截图 ${done}/${plan.chunkCount}`);
	}
	shiftContent(content, 0);
	return { canvas, scale: plan.scale, widthCss, heightCss };
}

function isTransparentColor(color: string): boolean {
	if (!color) return true;
	if (color === "transparent") return true;
	const m = color.match(/^rgba?\(([^)]+)\)$/);
	if (m) {
		const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
		return parts.length === 4 && parts[3] === 0;
	}
	return false;
}

function isValidCssColor(value: string): string | null {
	const probe = document.createElement("canvas").getContext("2d");
	if (!probe) return null;
	probe.fillStyle = "rgb(1, 2, 3)";
	probe.fillStyle = value;
	return probe.fillStyle === "rgb(1, 2, 3)" ? null : String(probe.fillStyle);
}

/** 推断截图应使用的底色：元素自身背景 → 主题变量 → 白色 */
export function resolveBackgroundColor(el: HTMLElement): string {
	const style = getComputedStyle(el);
	if (!isTransparentColor(style.backgroundColor)) {
		return style.backgroundColor;
	}
	const fromVar = isValidCssColor(style.getPropertyValue("--background-primary").trim());
	if (fromVar) return fromVar;
	const bodyColor = getComputedStyle(document.body).backgroundColor;
	if (!isTransparentColor(bodyColor)) return bodyColor;
	return "#ffffff";
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
		reader.readAsDataURL(blob);
	});
}

/**
 * 把 <img> 预先转成 data URL。
 * modern-screenshot 会自行 fetch 图片，但 Obsidian 的 app:// 资源在部分版本下
 * fetch 会失败，这里补一条「画到 canvas 再导出」的兜底路径。
 */
export async function inlineImages(
	root: HTMLElement,
	onWarn?: (message: string) => void
): Promise<void> {
	const images = Array.from(root.querySelectorAll("img"));
	await Promise.all(
		images.map(async (img) => {
			const src = img.currentSrc || img.getAttribute("src") || "";
			if (!src || src.startsWith("data:")) return;
			try {
				const response = await fetch(src);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const dataUrl = await blobToDataUrl(await response.blob());
				img.removeAttribute("srcset");
				img.removeAttribute("sizes");
				img.setAttribute("src", dataUrl);
				return;
			} catch {
				// 走 canvas 兜底
			}
			try {
				if (!img.complete || img.naturalWidth === 0) {
					await new Promise<void>((resolve) => {
						const done = () => resolve();
						img.addEventListener("load", done, { once: true });
						img.addEventListener("error", done, { once: true });
						window.setTimeout(done, 3000);
					});
				}
				if (!img.naturalWidth) throw new Error("图片未加载");
				const probe = document.createElement("canvas");
				probe.width = img.naturalWidth;
				probe.height = img.naturalHeight;
				const pctx = probe.getContext("2d");
				if (!pctx) throw new Error("无法创建 canvas");
				pctx.drawImage(img, 0, 0);
				const dataUrl = probe.toDataURL("image/png");
				if (!dataUrl.startsWith("data:image")) throw new Error("导出 data URL 失败");
				img.setAttribute("src", dataUrl);
			} catch (error) {
				onWarn?.(`图片内嵌失败：${src}（${String(error)}）`);
			}
		})
	);
}

/** 轮询直到元素高度稳定，用于等待 mermaid / 数学公式 / 嵌入内容渲染完成 */
export async function waitForStableSize(
	el: HTMLElement,
	stableRounds = 2,
	intervalMs = 120,
	timeoutMs = 4000
): Promise<void> {
	const started = Date.now();
	let last = -1;
	let stable = 0;
	while (Date.now() - started < timeoutMs) {
		const height = el.scrollHeight;
		if (height === last && height > 0) {
			stable += 1;
			if (stable >= stableRounds) return;
		} else {
			stable = 0;
			last = height;
		}
		await delay(intervalMs);
	}
}

export interface RenderReadyOptions {
	/** 最长等待时间（ms），超时后返回未完成项 */
	timeoutMs: number;
	intervalMs?: number;
	onProgress?: (pending: string[]) => void;
}

export interface RenderReadyResult {
	/** 所有异步内容都渲染完成 */
	ready: boolean;
	/** 超时仍未完成的内容描述 */
	pending: string[];
}

/**
 * 主动检测异步内容是否渲染完成：Mermaid 图表、数学公式、图片解码、嵌入笔记。
 * 相比固定等待，能在内容就绪后立刻继续，也能在异常时把「谁没画出来」告诉用户。
 */
export async function waitForRenderReady(
	root: HTMLElement,
	opts: RenderReadyOptions
): Promise<RenderReadyResult> {
	const started = Date.now();
	const interval = opts.intervalMs ?? 150;
	let pending = describePending(root);
	while (pending.length > 0 && Date.now() - started < opts.timeoutMs) {
		opts.onProgress?.(pending);
		await delay(interval);
		pending = describePending(root);
	}
	return { ready: pending.length === 0, pending };
}

/** 列出仍在等待渲染的内容（空数组 = 全部就绪） */
export function describePending(root: HTMLElement): string[] {
	const pending: string[] = [];

	const mermaid = Array.from(root.querySelectorAll<HTMLElement>(".mermaid")).filter(
		(el) => !el.querySelector("svg")
	);
	if (mermaid.length > 0) pending.push(`${mermaid.length} 个 Mermaid 图表`);

	const math = Array.from(root.querySelectorAll<HTMLElement>(".math")).filter(
		(el) => !el.querySelector("mjx-container") && (el.textContent ?? "").trim().length > 0
	);
	if (math.length > 0) pending.push(`${math.length} 处数学公式`);

	const images = Array.from(root.querySelectorAll("img")).filter(
		(img) => !img.complete || img.naturalWidth === 0
	);
	if (images.length > 0) pending.push(`${images.length} 张图片`);

	const embeds = Array.from(root.querySelectorAll<HTMLElement>(".markdown-embed")).filter((el) => {
		const body = el.querySelector(".markdown-embed-content");
		return !body || body.children.length === 0;
	});
	if (embeds.length > 0) pending.push(`${embeds.length} 处嵌入笔记`);

	return pending;
}
