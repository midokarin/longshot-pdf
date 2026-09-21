import type { PageSlice } from "./paginate";
import {
	type AlignMode,
	type LongshotSettings,
	resolvePaperSize,
	resolveQualityDpi,
} from "./settings";
import { MM_PER_INCH, PAGE_FONT_STACK, clamp, mmToPx, ptToPx } from "./utils";
import {
	authorBandMm,
	drawAuthorBlock,
	drawWatermark,
	type AuthorSpec,
	type WatermarkSpec,
} from "./watermark";

const MAX_PAGE_AREA = 26_000_000;

export interface PageGeometry {
	paperWidthMm: number;
	paperHeightMm: number;
	dpi: number;
	pageWidthPx: number;
	pageHeightPx: number;
	marginTopPx: number;
	marginRightPx: number;
	marginBottomPx: number;
	marginLeftPx: number;
	contentXPx: number;
	contentYPx: number;
	contentWidthPx: number;
	contentHeightPx: number;
	/** 源图 px → 页面 px 的缩放比 */
	scale: number;
	/** 每页可容纳的源图高度（源图 px） */
	capacitySrcPx: number;
	headerBandPx: number;
	footerBandPx: number;
	/** 作者信息占用的一条横带（在正文下方、页脚上方） */
	authorBandPx: number;
}

export interface PageTextSpec {
	text: string;
	align: AlignMode;
	sizePx: number;
	color: string;
}

export interface PageBorderSpec {
	widthPx: number;
	insetPx: number;
	color: string;
}

export interface PageRenderSpec {
	geometry: PageGeometry;
	paperColor: string;
	border: PageBorderSpec | null;
	header: PageTextSpec | null;
	footer: PageTextSpec | null;
	/** 可见水印（整页平铺或居中） */
	watermark: WatermarkSpec | null;
	/** 作者信息（头像 / 名称 / 附加文本） */
	author: AuthorSpec | null;
}

function headerBandMm(settings: LongshotSettings): number {
	// 页眉/页脚留白 = 文字高度 + 与正文的间距
	return (settings.footerSizePt * 1.6 * MM_PER_INCH) / 72 + 2;
}

/** 计算纸张、内容区与缩放比 */
export function computeGeometry(
	settings: LongshotSettings,
	srcWidthPx: number
): PageGeometry {
	const paper = resolvePaperSize(settings);
	const nominalDpi = resolveQualityDpi(settings.quality);
	const band = headerBandMm(settings);
	const headerMm = settings.headerTemplate.trim() ? band : 0;
	const footerMm = settings.footerTemplate.trim() ? band : 0;
	const authorMm = authorBandMm(settings);

	const contentMmW = Math.max(20, paper.widthMm - settings.marginLeftMm - settings.marginRightMm);
	const contentMmH = Math.max(
		20,
		paper.heightMm -
			settings.marginTopMm -
			settings.marginBottomMm -
			headerMm -
			footerMm -
			authorMm
	);

	// 1) 不超过名义 DPI；2) 不做放大（避免正文发虚）；3) 限制单页画布面积
	const dpiFor1to1 = (srcWidthPx * MM_PER_INCH) / contentMmW;
	const dpiByArea = Math.sqrt(
		MAX_PAGE_AREA / ((paper.widthMm / MM_PER_INCH) * (paper.heightMm / MM_PER_INCH))
	);
	const dpi = clamp(Math.min(nominalDpi, dpiFor1to1, dpiByArea), 72, 600);

	const pageWidthPx = Math.round(mmToPx(paper.widthMm, dpi));
	const pageHeightPx = Math.round(mmToPx(paper.heightMm, dpi));
	const marginTopPx = Math.round(mmToPx(settings.marginTopMm, dpi));
	const marginRightPx = Math.round(mmToPx(settings.marginRightMm, dpi));
	const marginBottomPx = Math.round(mmToPx(settings.marginBottomMm, dpi));
	const marginLeftPx = Math.round(mmToPx(settings.marginLeftMm, dpi));

	const headerBandPx = Math.round(mmToPx(band, dpi));
	const footerBandPx = Math.round(mmToPx(band, dpi));
	const authorBandPx = Math.round(mmToPx(authorMm, dpi));
	const contentXPx = marginLeftPx;
	const contentYPx = marginTopPx + (headerMm ? headerBandPx : 0);
	const contentWidthPx = pageWidthPx - marginLeftPx - marginRightPx;
	const contentHeightPx =
		pageHeightPx - marginBottomPx - (footerMm ? footerBandPx : 0) - authorBandPx - contentYPx;

	const scale = contentWidthPx / srcWidthPx;
	return {
		paperWidthMm: paper.widthMm,
		paperHeightMm: paper.heightMm,
		dpi,
		pageWidthPx,
		pageHeightPx,
		marginTopPx,
		marginRightPx,
		marginBottomPx,
		marginLeftPx,
		contentXPx,
		contentYPx,
		contentWidthPx,
		contentHeightPx,
		scale,
		capacitySrcPx: contentHeightPx / scale,
		headerBandPx,
		footerBandPx,
		authorBandPx,
	};
}

function drawTextBlock(
	ctx: CanvasRenderingContext2D,
	spec: PageTextSpec,
	x: number,
	width: number,
	y: number,
	baseline: CanvasTextBaseline
): void {
	if (!spec.text) return;
	const lines = spec.text.split("\n");
	ctx.save();
	ctx.font = `400 ${spec.sizePx}px ${PAGE_FONT_STACK}`;
	ctx.fillStyle = spec.color;
	ctx.textBaseline = baseline;
	ctx.textAlign = spec.align;
	const anchors: Record<AlignMode, number> = {
		left: x,
		center: x + width / 2,
		right: x + width,
	};
	const anchorX = anchors[spec.align];
	const lineHeight = spec.sizePx * 1.35;
	if (baseline === "bottom") {
		// 多行页眉：最后一行贴着正文上方
		for (let i = lines.length - 1; i >= 0; i--) {
			ctx.fillText(lines[i], anchorX, y - (lines.length - 1 - i) * lineHeight, width);
		}
	} else {
		for (let i = 0; i < lines.length; i++) {
			ctx.fillText(lines[i], anchorX, y + i * lineHeight, width);
		}
	}
	ctx.restore();
}

/** 把源图的一段裁切，按纸张样式排版成一页 */
export function renderPage(
	source: HTMLCanvasElement,
	slice: PageSlice,
	spec: PageRenderSpec
): HTMLCanvasElement {
	const geo = spec.geometry;
	const canvas = document.createElement("canvas");
	canvas.width = geo.pageWidthPx;
	canvas.height = geo.pageHeightPx;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("无法创建画布上下文");
	}

	ctx.fillStyle = spec.paperColor;
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	if (spec.border && spec.border.widthPx > 0) {
		const inset = spec.border.insetPx + spec.border.widthPx / 2;
		ctx.strokeStyle = spec.border.color;
		ctx.lineWidth = spec.border.widthPx;
		ctx.strokeRect(
			inset,
			inset,
			canvas.width - inset * 2,
			canvas.height - inset * 2
		);
	}

	const sliceHeight = Math.max(1, slice.end - slice.start);
	ctx.save();
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(
		source,
		0,
		slice.start,
		source.width,
		sliceHeight,
		geo.contentXPx,
		geo.contentYPx,
		geo.contentWidthPx,
		sliceHeight * geo.scale
	);
	ctx.restore();

	if (spec.watermark) {
		drawWatermark(ctx, spec.watermark, canvas.width, canvas.height);
	}

	if (spec.author && geo.authorBandPx > 0) {
		drawAuthorBlock(
			ctx,
			spec.author,
			geo.contentXPx,
			geo.contentYPx + geo.contentHeightPx + mmToPx(1.5, geo.dpi),
			geo.contentWidthPx,
			Math.max(0, geo.authorBandPx - mmToPx(1.5, geo.dpi))
		);
	}

	if (spec.header) {
		const y = Math.max(
			geo.marginTopPx + spec.header.sizePx * 1.2,
			geo.contentYPx - mmToPx(2, geo.dpi)
		);
		drawTextBlock(ctx, spec.header, geo.contentXPx, geo.contentWidthPx, y, "bottom");
	}
	if (spec.footer) {
		const y = Math.min(
			geo.pageHeightPx - geo.marginBottomPx - spec.footer.sizePx * 0.4,
			geo.contentYPx + geo.contentHeightPx + geo.authorBandPx + mmToPx(2, geo.dpi)
		);
		drawTextBlock(ctx, spec.footer, geo.contentXPx, geo.contentWidthPx, y, "top");
	}

	return canvas;
}

/** 由设置生成页眉/页脚/边框样式 */
export function buildPageSpec(
	settings: LongshotSettings,
	geometry: PageGeometry,
	vars: Record<string, string>,
	extras: { watermark?: WatermarkSpec | null; author?: AuthorSpec | null } = {}
): PageRenderSpec {
	const sizePx = Math.round(ptToPx(settings.footerSizePt, geometry.dpi));
	const headerText = settings.headerTemplate.trim();
	const footerText = settings.footerTemplate.trim();
	return {
		geometry,
		paperColor: settings.paperColor,
		border:
			settings.borderEnabled && settings.borderWidthPt > 0
				? {
						widthPx: Math.max(1, Math.round(ptToPx(settings.borderWidthPt, geometry.dpi))),
						insetPx: Math.round(mmToPx(settings.borderInsetMm, geometry.dpi)),
						color: settings.borderColor,
					}
				: null,
		header: headerText
			? {
					text: fillVars(headerText, vars),
					align: settings.headerAlign,
					sizePx,
					color: settings.footerColor,
				}
			: null,
		footer: footerText
			? {
					text: fillVars(footerText, vars),
					align: settings.footerAlign,
					sizePx,
					color: settings.footerColor,
				}
			: null,
		watermark: extras.watermark ?? null,
		author: extras.author ?? null,
	};
}

function fillVars(text: string, vars: Record<string, string>): string {
	return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (match, key: string) =>
		key in vars ? vars[key] : match
	);
}

/**
 * 长截图（不切分）的水印与作者信息：水印直接画在整图上，
 * 作者信息另起一条横带接在图片底部。
 */
export function renderLongImage(
	source: HTMLCanvasElement,
	deco: {
		watermark: WatermarkSpec | null;
		author: AuthorSpec | null;
		authorBandPx: number;
		paperColor: string;
	}
): HTMLCanvasElement {
	const band = Math.max(0, Math.round(deco.authorBandPx));
	if (!deco.watermark && band <= 0) return source;

	const canvas = document.createElement("canvas");
	canvas.width = source.width;
	canvas.height = source.height + band;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("无法创建画布上下文");

	ctx.fillStyle = deco.paperColor;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(source, 0, 0);

	if (deco.watermark) {
		drawWatermark(ctx, deco.watermark, canvas.width, canvas.height);
	}
	if (deco.author && band > 0) {
		const inset = Math.round(source.width * 0.03);
		drawAuthorBlock(ctx, deco.author, inset, source.height, source.width - inset * 2, band);
	}
	return canvas;
}

/** 分页预览缩略图的默认显示宽度（CSS px） */
const THUMB_CSS_WIDTH = 200;

/**
 * 缩略图画布相对 CSS 显示宽度的像素倍率。
 *
 * 下限取 2 是刻意的：就算显示器是 1× 屏，也先按 2 倍绘制再交给浏览器缩小，
 * 文字边缘是被重采样出来的，而不是直接丢像素。
 */
export function thumbnailPixelRatio(): number {
	return Math.min(4, Math.max(2, window.devicePixelRatio || 1));
}

/**
 * 把源画布上的一块区域缩小后画到目标位置。
 *
 * 源画布一行有几千像素，缩略图只有几百像素：一步 drawImage 缩下去时，浏览器的
 * 采样窗口覆盖不到全部源像素，细笔画会被整根漏掉——正文糊成灰条，断点也就看不清。
 * 这里改成逐级折半，每一级的缩小比例都不超过 2:1，笔画才能保留下来。
 */
function drawDownscaled(
	ctx: CanvasRenderingContext2D,
	source: CanvasImageSource,
	sx: number,
	sy: number,
	sw: number,
	sh: number,
	dx: number,
	dy: number,
	dw: number,
	dh: number
): void {
	let src = source;
	let x = sx;
	let y = sy;
	let w = sw;
	let h = sh;
	while (w > dw * 2 && w > 2) {
		const nextW = Math.max(Math.ceil(dw), Math.floor(w / 2));
		const nextH = Math.max(1, Math.round((h * nextW) / w));
		const step = document.createElement("canvas");
		step.width = nextW;
		step.height = nextH;
		const stepCtx = step.getContext("2d");
		if (!stepCtx) break;
		stepCtx.imageSmoothingEnabled = true;
		stepCtx.imageSmoothingQuality = "high";
		stepCtx.drawImage(src, x, y, w, h, 0, 0, nextW, nextH);
		src = step;
		x = 0;
		y = 0;
		w = nextW;
		h = nextH;
	}
	ctx.drawImage(src, x, y, w, h, dx, dy, dw, dh);
}

/**
 * 分页预览用的缩略图：按页面比例把这一页的内容画小，用于确认断点位置。
 *
 * 画布按「显示宽度 × 像素倍率」绘制并显式写回 CSS 宽度，这样缩略图在高分屏上是
 * 1:1 的设备像素，不会被浏览器放大而发虚；正文的缩小走逐级折半，避免笔画丢失。
 */
export function renderPageThumbnail(
	source: HTMLCanvasElement,
	slice: PageSlice,
	spec: PageRenderSpec,
	displayWidth = THUMB_CSS_WIDTH
): HTMLCanvasElement {
	const geo = spec.geometry;
	const cssWidth = Math.max(40, Math.round(displayWidth));
	const dpr = thumbnailPixelRatio();
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(cssWidth * dpr));
	canvas.height = Math.max(
		1,
		Math.round((cssWidth * dpr * geo.pageHeightPx) / geo.pageWidthPx)
	);
	canvas.style.width = `${cssWidth}px`;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("无法创建画布上下文");

	// 版面 px → 缩略图 px 的换算系数
	const k = canvas.width / geo.pageWidthPx;

	ctx.fillStyle = spec.paperColor;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	if (spec.border && spec.border.widthPx > 0) {
		const inset = spec.border.insetPx * k;
		ctx.strokeStyle = spec.border.color;
		ctx.lineWidth = Math.max(1, spec.border.widthPx * k);
		ctx.strokeRect(inset, inset, canvas.width - inset * 2, canvas.height - inset * 2);
	}

	const sliceHeight = Math.max(1, slice.end - slice.start);
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	drawDownscaled(
		ctx,
		source,
		0,
		slice.start,
		source.width,
		sliceHeight,
		geo.contentXPx * k,
		geo.contentYPx * k,
		geo.contentWidthPx * k,
		sliceHeight * geo.scale * k
	);

	// 页眉 / 页脚 / 作者信息在缩略图里只用浅灰条示意
	ctx.fillStyle = "rgba(128, 128, 128, 0.35)";
	if (spec.header) {
		ctx.fillRect(geo.contentXPx * k, (geo.contentYPx - geo.headerBandPx * 0.7) * k, geo.contentWidthPx * k, Math.max(1, geo.headerBandPx * 0.35 * k));
	}
	if (spec.author && geo.authorBandPx > 0) {
		ctx.fillRect(geo.contentXPx * k, (geo.contentYPx + geo.contentHeightPx) * k, geo.contentWidthPx * k, Math.max(1, geo.authorBandPx * 0.4 * k));
	}
	if (spec.footer) {
		ctx.fillRect(geo.contentXPx * k, (geo.contentYPx + geo.contentHeightPx + geo.authorBandPx + geo.footerBandPx * 0.2) * k, geo.contentWidthPx * k, Math.max(1, geo.footerBandPx * 0.35 * k));
	}
	return canvas;
}