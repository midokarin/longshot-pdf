import { t } from "./i18n";
import { AUTHOR_DESIGNS, designHeight, measureDesign, paintDesign } from "./author-design";
import { App, TFile } from "obsidian";
import { promises as fs } from "fs";
import type {
	AlignMode,
	AuthorDecor,
	AuthorDesign,
	AuthorNameWeight,
	AuthorStyle,
	AvatarFit,
	AvatarShape,
	LongshotSettings,
	WatermarkAnchor,
	WatermarkLayout,
} from "./settings";
import {
	MM_PER_INCH,
	PAGE_FONT_STACK,
	WATERMARK_FONT_STACKS,
	clamp,
	fillTemplate,
	isAbsolutePath,
	mmToPx,
	ptToPx,
} from "./utils";

/* ────────────────────────────── 可见水印 ────────────────────────────── */

export interface WatermarkSpec {
	text: string;
	image: HTMLImageElement | null;
	imageScale: number;
	layout: WatermarkLayout;
	anchor: WatermarkAnchor;
	opacity: number;
	sizePx: number;
	font: string;
	color: string;
	rotationDeg: number;
}

/** 是否配置了任何水印内容 */
export function hasWatermark(settings: LongshotSettings): boolean {
	if (!settings.watermarkEnabled) return false;
	return settings.watermarkText.trim().length > 0 || settings.watermarkImagePath.trim().length > 0;
}

/** 由设置生成水印样式（dpi 决定字号像素） */
export function buildWatermarkSpec(
	settings: LongshotSettings,
	dpi: number,
	vars: Record<string, string>,
	image: HTMLImageElement | null = null
): WatermarkSpec | null {
	if (!hasWatermark(settings)) return null;
	return {
		text: fillTemplate(settings.watermarkText.trim(), vars).trim(),
		image,
		imageScale: clamp(settings.watermarkImageScale, 0.05, 1),
		layout: settings.watermarkLayout,
		anchor: settings.watermarkAnchor,
		opacity: clamp(settings.watermarkOpacity, 0.01, 1),
		sizePx: Math.max(6, Math.round(ptToPx(settings.watermarkSizePt, dpi))),
		font: WATERMARK_FONT_STACKS[settings.watermarkFont] ?? PAGE_FONT_STACK,
		color: settings.watermarkColor,
		rotationDeg: settings.watermarkRotationDeg,
	};
}

/** 九宫格落点在 [0,1] 区间里的相对位置 */
function anchorFactor(anchor: WatermarkAnchor, axis: "x" | "y"): number {
	const [vertical, horizontal] = anchor.split("-") as [string, string];
	if (axis === "x") {
		return horizontal === "left" ? 0 : horizontal === "right" ? 1 : 0.5;
	}
	return vertical === "top" ? 0 : vertical === "bottom" ? 1 : 0.5;
}

/** 在整块画布上绘制水印（分页时画在每页上，长截图时画在整图上） */
export function drawWatermark(
	ctx: CanvasRenderingContext2D,
	spec: WatermarkSpec,
	width: number,
	height: number
): void {
	if (width <= 0 || height <= 0) return;
	if (!spec.image && !spec.text) return;

	if (spec.layout === "center") {
		drawSingleWatermark(ctx, spec, width, height);
		return;
	}

	// 平铺：旋转后按对角线长度铺满，保证四角都有水印
	ctx.save();
	ctx.globalAlpha = spec.opacity;
	ctx.translate(width / 2, height / 2);
	ctx.rotate((spec.rotationDeg * Math.PI) / 180);
	const diag = Math.sqrt(width * width + height * height);
	const half = diag / 2;
	if (spec.image) {
		const tile = tileSizeOf(spec, width);
		const stepX = tile.width + tile.width * 0.5;
		const stepY = tile.height + tile.height * 0.6;
		for (let y = -half; y <= half; y += stepY) {
			for (let x = -half; x <= half; x += stepX) {
				drawImageAt(ctx, spec.image, x, y, tile.width, tile.height);
			}
		}
	} else {
		applyTextStyle(ctx, spec);
		ctx.textAlign = "left";
		const textWidth = Math.max(1, ctx.measureText(spec.text).width);
		const stepX = textWidth + spec.sizePx * 6;
		const stepY = spec.sizePx * 4;
		let row = 0;
		for (let y = -half; y <= half; y += stepY) {
			const offset = row % 2 === 0 ? 0 : stepX / 2;
			for (let x = -half - offset; x <= half; x += stepX) {
				ctx.fillText(spec.text, x, y);
			}
			row += 1;
		}
	}
	ctx.restore();
}

/**
 * 「单个」排布：按九宫格把「整块水印」贴进纸张的安全区，
 * 并留出 6% 的边距，免得水印压到纸张边缘被裁掉。
 */
function drawSingleWatermark(
	ctx: CanvasRenderingContext2D,
	spec: WatermarkSpec,
	width: number,
	height: number
): void {
	// 先量出水印自身的尺寸，才能按「整块」对齐（否则左对齐时文字会有一半挂在纸外）
	const metrics = measureSingleWatermark(ctx, spec, width);

	const marginX = width * 0.06;
	const marginY = height * 0.06;
	const left = placeInSpan(marginX, width, metrics.width, anchorFactor(spec.anchor, "x"));
	const top = placeInSpan(marginY, height, metrics.height, anchorFactor(spec.anchor, "y"));

	ctx.save();
	ctx.globalAlpha = spec.opacity;
	ctx.translate(left + metrics.width / 2, top + metrics.height / 2);
	ctx.rotate((spec.rotationDeg * Math.PI) / 180);
	if (spec.image) {
		drawImageAt(ctx, spec.image, 0, 0, metrics.width, metrics.height);
	} else {
		applyTextStyle(ctx, spec);
		ctx.textAlign = "center";
		ctx.fillText(spec.text, 0, 0);
	}
	ctx.restore();
}

/** 单个水印占多大：图片按纸张宽度占比，文字按当前字号的实测宽度 */
function measureSingleWatermark(
	ctx: CanvasRenderingContext2D,
	spec: WatermarkSpec,
	width: number
): { width: number; height: number } {
	if (spec.image) {
		const w = Math.max(16, width * spec.imageScale);
		const h = (w / Math.max(1, spec.image.naturalWidth)) * Math.max(1, spec.image.naturalHeight);
		return { width: w, height: h };
	}
	applyTextStyle(ctx, spec);
	return { width: Math.max(1, ctx.measureText(spec.text).width), height: spec.sizePx };
}

/** 在 [margin, total - margin] 里按 factor 摆放下宽/高为 size 的整块；放不下就居中 */
function placeInSpan(margin: number, total: number, size: number, factor: number): number {
	const span = total - margin * 2 - size;
	if (span >= 0) return margin + span * factor;
	return (total - size) / 2;
}

function applyTextStyle(ctx: CanvasRenderingContext2D, spec: WatermarkSpec): void {
	ctx.font = `400 ${spec.sizePx}px ${spec.font}`;
	ctx.fillStyle = spec.color;
	ctx.textBaseline = "middle";
}

function tileSizeOf(spec: WatermarkSpec, width: number): { width: number; height: number } {
	const img = spec.image;
	if (!img) return { width: 0, height: 0 };
	const w = Math.max(8, width * spec.imageScale * 0.5);
	const h = (w / Math.max(1, img.naturalWidth)) * Math.max(1, img.naturalHeight);
	return { width: Math.round(w), height: Math.round(h) };
}

function drawImageAt(
	ctx: CanvasRenderingContext2D,
	img: HTMLImageElement,
	x: number,
	y: number,
	w: number,
	h: number
): void {
	ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
}

/* ───────────────────────── 设置页里的水印预览 ───────────────────────── */

export interface WatermarkPreviewSize {
	/** 预览画布的显示宽度（CSS px） */
	widthCss: number;
	paperWidthMm: number;
	paperHeightMm: number;
	paperColor: string;
	dpi: number;
}

/**
 * 设置页里的水印预览：按纸张比例画一张小纸，再叠加当前水印。
 *
 * 用的是和真实导出完全相同的 buildWatermarkSpec + drawWatermark，
 * 只把字号按「预览宽 / 实际页宽」等比缩放，所以预览里看到的浓淡、
 * 大小、落点和导出结果一致。
 */
export function drawWatermarkPreview(
	canvas: HTMLCanvasElement,
	spec: WatermarkSpec | null,
	size: WatermarkPreviewSize
): void {
	const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
	const cssWidth = Math.max(80, Math.round(size.widthCss));
	const cssHeight = Math.max(
		1,
		Math.round((cssWidth * size.paperHeightMm) / Math.max(1, size.paperWidthMm))
	);
	canvas.width = Math.round(cssWidth * dpr);
	canvas.height = Math.round(cssHeight * dpr);
	canvas.style.width = `${cssWidth}px`;
	canvas.style.height = `${cssHeight}px`;

	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.fillStyle = size.paperColor;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	drawPreviewLines(ctx, canvas.width, canvas.height);

	if (!spec) return;
	const pageWidthPx = Math.max(1, mmToPx(size.paperWidthMm, size.dpi));
	const k = canvas.width / pageWidthPx;
	drawWatermark(ctx, { ...spec, sizePx: Math.max(3, spec.sizePx * k) }, canvas.width, canvas.height);
}

/** 示意正文的颜色：跟随设置页文字色，取不到时退回深灰 */
function previewLineColor(canvas: HTMLCanvasElement): string {
	try {
		return getComputedStyle(canvas).color || "#333333";
	} catch {
		return "#333333";
	}
}

/** 预览里的示意正文：给水印一个「背景」，才看得出浓淡是否影响阅读 */
function drawPreviewLines(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	/** 示意正文画到哪为止（默认画到画布底部）；作者信息预览要给它让出底部的署名带 */
	maxY = height
): void {
	const padding = width * 0.1;
	const lineHeight = Math.max(3, height / 34);
	const thickness = Math.max(1, lineHeight * 0.32);
	ctx.save();
	ctx.globalAlpha = 0.32;
	ctx.fillStyle = previewLineColor(ctx.canvas);
	let y = padding;
	let row = 0;
	while (y < maxY - padding) {
		// 每隔几行换一次宽度，模拟段落与标题的差别
		const ratio = row % 7 === 0 ? 0.45 : row % 3 === 0 ? 0.82 : 1;
		ctx.fillRect(padding, y, (width - padding * 2) * ratio, thickness);
		y += lineHeight;
		row += 1;
	}
	ctx.restore();
}

/* ────────────────────────────── 作者信息 ────────────────────────────── */

export interface AuthorSpec {
	design?: AuthorDesign;
	name: string;
	text: string;
	avatar: HTMLImageElement | null;
	avatarSizePx: number;
	/** 头像的呈现方式 */
	avatarFit: AvatarFit;
	/** 「裁剪填满」时的偏移：-1 贴左上、0 居中、1 贴右下 */
	avatarOffsetX: number;
	avatarOffsetY: number;
	/** 「裁剪填满」时先放大原图再裁（1 = 不放大） */
	avatarZoom: number;
	/** 头像外框形状 */
	avatarShape: AvatarShape;
	/** 头像是否描一圈强调色细边 */
	avatarRing: boolean;
	sizePx: number;
	font: string;
	color: string;
	align: AlignMode;
	/** 署名带的装饰元素 */
	decor: AuthorDecor;
	accentColor: string;
	/** 姓名的字重 */
	nameWeight: AuthorNameWeight;
	/** 字符间距（em） */
	letterSpacingEm: number;
	/** 附加文字的浓淡（1 = 与姓名同色） */
	textOpacity: number;
}

/** 作者信息是否有可绘制的内容 */
export function hasAuthorContent(settings: LongshotSettings): boolean {
	if (!settings.authorEnabled) return false;
	return (
		settings.authorName.trim().length > 0 ||
		settings.authorText.trim().length > 0 ||
		settings.authorAvatarPath.trim().length > 0
	);
}

/**
 * 装饰的基准尺寸（pt）：卡片内边距、描边粗细、细线高度都按它成比例。
 *
 * 取「字号」和「头像边长的一半」里较大的那个 —— 只有字号小时卡片才不至于把大头像裹得太紧，
 * 也只有头像小时细线才不至于太粗。导出绘制与署名带预留高度共用这一个基准。
 */
export function authorDecorUnitPt(sizePt: number, avatarSizeMm: number): number {
	return Math.max(sizePt, (avatarSizeMm * 0.5 * 72) / MM_PER_INCH);
}

/**
 * 装饰元素占用的竖向留白（mm）。
 * 卡片 / 边框要留出能包住内容的内边距，上方细线要留出与正文的距离；
 * 署名带的预留高度按它算，绘制时用的是同一套比例（unitPx 的倍数）。
 */
export function authorDecorPadMm(decor: AuthorDecor, sizePt: number, avatarSizeMm: number): number {
	const toMm = (ptValue: number) => (ptValue * MM_PER_INCH) / 72;
	const unit = authorDecorUnitPt(sizePt, avatarSizeMm);
	switch (decor) {
		case "card":
		case "frame":
			return toMm(unit * 0.9);
		case "rule":
			return toMm(unit * 0.72);
		default:
			return 0;
	}
}

/** 作者信息需要的竖向空间（mm）；没有内容时为 0 */
export function authorBandMm(settings: LongshotSettings): number {
	if (!hasAuthorContent(settings)) return 0;
	const avatar = settings.authorAvatarPath.trim() ? settings.authorAvatarSizeMm : 0;
	if (settings.authorDesign && AUTHOR_DESIGNS.includes(settings.authorDesign)) {
		return designHeight(settings.authorDesign, settings.authorSizePt * MM_PER_INCH / 72, avatar) + 3;
	}
	const lineMm = (settings.authorSizePt * 1.5 * MM_PER_INCH) / 72;
	const lines =
		(settings.authorName.trim() ? 1 : 0) + (settings.authorText.trim() ? 1 : 0);
	const textMm = Math.max(lineMm, lines * lineMm);
	const padMm = authorDecorPadMm(settings.authorDecor, settings.authorSizePt, settings.authorAvatarSizeMm);
	return Math.max(avatar, textMm) + padMm * 2 + 3;
}

/** 署名里与内容无关的样式部分，导出与预览共用 */
function authorStyleSpec(settings: LongshotSettings, dpi: number): Pick<
	AuthorSpec,
	| "design"
	| "avatarSizePx"
	| "avatarFit"
	| "avatarOffsetX"
	| "avatarOffsetY"
	| "avatarZoom"
	| "avatarShape"
	| "avatarRing"
	| "sizePx"
	| "font"
	| "color"
	| "align"
	| "decor"
	| "accentColor"
	| "nameWeight"
	| "letterSpacingEm"
	| "textOpacity"
> {
	return {
		design: settings.authorDesign ?? "legacy",
		avatarSizePx: Math.max(0, Math.round((settings.authorAvatarSizeMm * dpi) / MM_PER_INCH)),
		avatarFit: settings.authorAvatarFit,
		avatarOffsetX: clamp(settings.authorAvatarOffsetX, -1, 1),
		avatarOffsetY: clamp(settings.authorAvatarOffsetY, -1, 1),
		avatarZoom: Math.max(1, settings.authorAvatarZoom),
		avatarShape: settings.authorAvatarShape,
		avatarRing: settings.authorAvatarRing,
		sizePx: Math.max(6, Math.round(ptToPx(settings.authorSizePt, dpi))),
		font: WATERMARK_FONT_STACKS[settings.authorFont] ?? PAGE_FONT_STACK,
		color: settings.authorColor,
		align: settings.authorAlign,
		decor: settings.authorDecor,
		accentColor: settings.authorAccentColor,
		nameWeight: settings.authorNameWeight,
		letterSpacingEm: settings.authorLetterSpacingEm,
		textOpacity: clamp(settings.authorTextOpacity, 0.1, 1),
	};
}

export function buildAuthorSpec(
	settings: LongshotSettings,
	dpi: number,
	vars: Record<string, string>,
	avatar: HTMLImageElement | null = null
): AuthorSpec | null {
	if (!hasAuthorContent(settings)) return null;
	return {
		name: fillTemplate(settings.authorName.trim(), vars).trim(),
		text: fillTemplate(settings.authorText.trim(), vars).trim(),
		avatar,
		...authorStyleSpec(settings, dpi),
	};
}

/**
 * 设置页预览用：还没填名字 / 附加文字 / 头像时补上示例内容，
 * 这样用户可以先挑好字体、字号、颜色、对齐，再去填内容。
 */
export function buildAuthorPreviewSpec(
	settings: LongshotSettings,
	dpi: number,
	vars: Record<string, string>,
	avatar: HTMLImageElement | null = null
): AuthorSpec {
	return (
		buildAuthorSpec(settings, dpi, vars, avatar) ?? {
			name: t("张三"),
			text: t("2026 年 9 月 · 示例署名"),
			avatar,
			...authorStyleSpec(settings, dpi),
		}
	);
}

/**
 * 模板小样用：把一套样式 + 示例内容拼成署名 spec（不读设置、不落盘）。
 * 模板画廊的缩略图与导出走的是同一条绘制链路，所以小样看到的就是套用后的效果。
 */
export function authorTemplateSpec(
	style: AuthorStyle,
	dpi: number,
	sample: { name: string; text: string }
): AuthorSpec {
	return {
		design: style.design ?? "legacy",
		name: sample.name,
		text: sample.text,
		avatar: null,
		sizePx: Math.max(6, Math.round(ptToPx(style.sizePt, dpi))),
		font: WATERMARK_FONT_STACKS[style.font] ?? PAGE_FONT_STACK,
		color: style.color,
		align: style.align,
		avatarSizePx: Math.max(0, Math.round((style.avatarSizeMm * dpi) / MM_PER_INCH)),
		avatarFit: "cover",
		avatarOffsetX: 0,
		avatarOffsetY: 0,
		avatarZoom: 1,
		avatarShape: style.avatarShape,
		avatarRing: style.avatarRing,
		decor: style.decor,
		accentColor: style.accentColor,
		nameWeight: style.nameWeight,
		letterSpacingEm: style.letterSpacingEm,
		textOpacity: clamp(style.textOpacity, 0.1, 1),
	};
}

/**
 * 「裁剪填满」时图片相对头像框的绘制矩形（左上角 = 0,0），含缩放与拖拽偏移。
 *
 * 设置页的可视裁剪与导出绘制共用这一份几何：偏移 -1 贴左上、0 居中、1 贴右下，
 * zoom 是在「刚好吃满方框」的基础上再放大，用来把人物拉近。
 */
export function coverRect(
	imageWidth: number,
	imageHeight: number,
	size: number,
	zoom: number,
	offsetX: number,
	offsetY: number
): { x: number; y: number; width: number; height: number } {
	const scale = Math.max(size / imageWidth, size / imageHeight) * Math.max(1, zoom);
	const width = imageWidth * scale;
	const height = imageHeight * scale;
	const overX = Math.max(0, width - size);
	const overY = Math.max(0, height - size);
	return {
		x: (-overX * (clamp(offsetX, -1, 1) + 1)) / 2,
		y: (-overY * (clamp(offsetY, -1, 1) + 1)) / 2,
		width,
		height,
	};
}

/** 头像外框路径：圆形 / 圆角方形 / 正方形（调用前不必自行 beginPath） */
export function avatarPath(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	shape: AvatarShape
): void {
	ctx.beginPath();
	if (shape === "circle") {
		ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
		ctx.closePath();
		return;
	}
	if (shape === "rounded") {
		roundRect(ctx, x, y, size, size, size * 0.22);
		return;
	}
	ctx.rect(x, y, size, size);
	ctx.closePath();
}

/**
 * 把头像画进 size×size 的方框里：
 * - cover：从原图裁出一块填满方框（不变形），偏移与缩放在 coverRect 里算
 * - contain：整张图等比缩进方框，四周留白
 * - fill：直接拉伸填满方框（非正方形会变形）
 */
export function drawAvatarInBox(
	ctx: CanvasRenderingContext2D,
	image: HTMLImageElement,
	x: number,
	y: number,
	size: number,
	fit: AvatarFit,
	offsetX: number,
	offsetY: number,
	zoom: number
): void {
	const iw = image.naturalWidth || image.width;
	const ih = image.naturalHeight || image.height;
	if (iw <= 0 || ih <= 0 || size <= 0) return;

	if (fit === "fill") {
		ctx.drawImage(image, 0, 0, iw, ih, x, y, size, size);
		return;
	}
	if (fit === "contain") {
		const scale = Math.min(size / iw, size / ih);
		const dw = iw * scale;
		const dh = ih * scale;
		ctx.drawImage(image, 0, 0, iw, ih, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
		return;
	}
	const rect = coverRect(iw, ih, size, zoom, offsetX, offsetY);
	ctx.drawImage(image, 0, 0, iw, ih, x + rect.x, y + rect.y, rect.width, rect.height);
}

/** 署名带里的一行字：姓名与附加文字的字号 / 字重 / 浓淡不同 */
interface AuthorLine {
	text: string;
	size: number;
	weight: number;
	alpha: number;
	spacingEm: number;
	lineHeight: number;
}

/** canvas 的 letterSpacing 在少数旧内核上没有，有就设、没有就跳过（只是少一点精致感） */
function setLetterSpacing(ctx: CanvasRenderingContext2D, em: number, sizePx: number): void {
	if (!("letterSpacing" in ctx)) return;
	(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
		em > 0 ? `${(em * sizePx).toFixed(2)}px` : "0px";
}

/** 署名带的排布结果：内容尺寸、装饰占的留白、整块尺寸 */
interface AuthorLayout {
	lines: AuthorLine[];
	textWidth: number;
	textHeight: number;
	contentWidth: number;
	contentHeight: number;
	barWidth: number;
	ruleHeight: number;
	insetLeft: number;
	insetRight: number;
	insetTop: number;
	insetBottom: number;
	blockWidth: number;
	blockHeight: number;
	/** 装饰的基准尺寸（像素），与 authorDecorUnitPt 同源 */
	unit: number;
	/** 是否画头像（有图且尺寸大于 0） */
	hasAvatar: boolean;
	/** 头像与文字之间的间隙（无头像或无文字时为 0） */
	gap: number;
}

/** 量出署名块要占多大：字形宽度按当前字体实测，装饰留白按基准尺寸成比例 */
function layoutAuthorBlock(ctx: CanvasRenderingContext2D, spec: AuthorSpec): AuthorLayout | null {
	const lines: AuthorLine[] = [];
	if (spec.name) {
		lines.push({
			text: spec.name,
			size: spec.sizePx,
			weight: spec.nameWeight,
			alpha: 1,
			spacingEm: spec.letterSpacingEm,
			lineHeight: spec.sizePx * 1.35,
		});
	}
	if (spec.text) {
		const size = spec.sizePx * 0.88;
		lines.push({
			text: spec.text,
			size,
			weight: 400,
			alpha: spec.textOpacity,
			spacingEm: 0,
			lineHeight: size * 1.5,
		});
	}
	const hasAvatar = spec.avatar !== null && spec.avatarSizePx > 0;
	if (lines.length === 0 && !hasAvatar) return null;

	const measure = (line: AuthorLine): number => {
		ctx.save();
		setLetterSpacing(ctx, line.spacingEm, line.size);
		ctx.font = `${line.weight} ${line.size}px ${spec.font}`;
		const value = ctx.measureText(line.text).width;
		ctx.restore();
		return value;
	};
	const textWidth = lines.reduce((max, line) => Math.max(max, measure(line)), 0);
	const textHeight = lines.reduce((sum, line) => sum + line.lineHeight, 0);

	const gap = hasAvatar && lines.length > 0 ? spec.sizePx * 0.65 : 0;
	const contentWidth = (hasAvatar ? spec.avatarSizePx + gap : 0) + textWidth;
	const contentHeight = Math.max(hasAvatar ? spec.avatarSizePx : 0, textHeight);

	// 装饰占用的四周留白；与 authorDecorPadMm 用的是同一套比例（以 unitPx 为基准）
	const unit = Math.max(spec.sizePx, spec.avatarSizePx * 0.5);
	const barWidth = spec.decor === "bar" ? Math.max(2, unit * 0.28) : 0;
	const barGap = barWidth > 0 ? unit * 0.6 : 0;
	const ruleHeight = spec.decor === "rule" ? Math.max(1, unit * 0.12) : 0;
	const ruleGap = ruleHeight > 0 ? unit * 0.6 : 0;
	let insetLeft = 0;
	let insetRight = 0;
	let insetTop = 0;
	let insetBottom = 0;
	if (spec.decor === "card" || spec.decor === "frame") {
		insetLeft = insetRight = unit * 1.4;
		insetTop = insetBottom = unit * 0.9;
	} else if (spec.decor === "bar") {
		insetLeft = barWidth + barGap;
	} else if (spec.decor === "rule") {
		insetTop = ruleHeight + ruleGap;
	}

	return {
		lines,
		textWidth,
		textHeight,
		contentWidth,
		contentHeight,
		barWidth,
		ruleHeight,
		insetLeft,
		insetRight,
		insetTop,
		insetBottom,
		blockWidth: contentWidth + insetLeft + insetRight,
		blockHeight: contentHeight + insetTop + insetBottom,
		unit,
		hasAvatar,
		gap,
	};
}

/** 署名块实际占多大（不绘制）：模板小样按它等比缩放，才能整块塞进缩略图 */
export function authorBlockSize(
	ctx: CanvasRenderingContext2D,
	spec: AuthorSpec
): { width: number; height: number } {
	if (spec.design && AUTHOR_DESIGNS.includes(spec.design)) return measureDesign(ctx, spec);
	const layout = layoutAuthorBlock(ctx, spec);
	return layout ? { width: layout.blockWidth, height: layout.blockHeight } : { width: 0, height: 0 };
}

/**
 * 在 [x, x+width] × [y, y+bandHeight] 里绘制头像 + 姓名 + 附加文字，
 * 并按设置补上装饰元素（左侧竖条 / 上方细线 / 卡片底纹 / 细边框）。
 *
 * 姓名用设定的字重与字号，附加文字略小、更淡，这样一条署名才有主次。
 */
export function drawAuthorBlock(
	ctx: CanvasRenderingContext2D,
	spec: AuthorSpec,
	x: number,
	y: number,
	width: number,
	bandHeight: number
): void {
	if (spec.design && AUTHOR_DESIGNS.includes(spec.design)) {
		const layout = measureDesign(ctx, spec);
		// 长内容整体缩放以保持版式完整；头像、字体和装饰使用同一比例。
		const k = Math.min(1, width / layout.width, bandHeight / layout.height);
		const left = spec.align === "left" ? x : spec.align === "center" ? x + (width - layout.width * k) / 2 : x + width - layout.width * k;
		ctx.save();
		ctx.translate(left, y + (bandHeight - layout.height * k) / 2);
		ctx.scale(k, k);
		paintDesign(ctx, spec, layout, (ax, ay, size) => {
			if (!spec.avatar) return;
			ctx.save();
			avatarPath(ctx, ax, ay, size, spec.avatarShape);
			ctx.clip();
			drawAvatarInBox(ctx, spec.avatar, ax, ay, size, spec.avatarFit, spec.avatarOffsetX, spec.avatarOffsetY, spec.avatarZoom);
			ctx.restore();
		});
		ctx.restore();
		return;
	}
	const layout = layoutAuthorBlock(ctx, spec);
	if (!layout) return;
	const { lines, textHeight, contentHeight, barWidth, ruleHeight, insetLeft, insetTop } = layout;
	const { blockWidth, blockHeight, unit, hasAvatar, gap } = layout;

	const blockX =
		spec.align === "left"
			? x
			: spec.align === "center"
				? x + (width - blockWidth) / 2
				: x + width - blockWidth;
	const blockY = y + Math.max(0, (bandHeight - blockHeight) / 2);

	// ── 装饰 ──
	if (spec.decor !== "none") {
		ctx.save();
		ctx.fillStyle = spec.accentColor;
		ctx.strokeStyle = spec.accentColor;
		if (spec.decor === "card") {
			ctx.beginPath();
			roundRect(ctx, blockX, blockY, blockWidth, blockHeight, unit * 0.75);
			ctx.globalAlpha = 0.1;
			ctx.fill();
			ctx.globalAlpha = 0.32;
			ctx.lineWidth = Math.max(1, unit * 0.045);
			ctx.stroke();
		} else if (spec.decor === "frame") {
			ctx.beginPath();
			roundRect(ctx, blockX, blockY, blockWidth, blockHeight, unit * 0.45);
			ctx.globalAlpha = 0.62;
			ctx.lineWidth = Math.max(1, unit * 0.055);
			ctx.stroke();
		} else if (spec.decor === "bar") {
			ctx.beginPath();
			roundRect(ctx, blockX, blockY, barWidth, blockHeight, barWidth / 2);
			ctx.globalAlpha = 0.9;
			ctx.fill();
		} else {
			ctx.beginPath();
			roundRect(ctx, blockX, blockY, blockWidth, ruleHeight, ruleHeight / 2);
			ctx.globalAlpha = 0.85;
			ctx.fill();
		}
		ctx.restore();
	}

	const contentX = blockX + insetLeft;
	const contentY = blockY + insetTop;

	// ── 头像 ──
	let textX = contentX;
	if (hasAvatar && spec.avatar) {
		const size = spec.avatarSizePx;
		const boxY = contentY + (contentHeight - size) / 2;
		ctx.save();
		avatarPath(ctx, contentX, boxY, size, spec.avatarShape);
		ctx.clip();
		drawAvatarInBox(
			ctx,
			spec.avatar,
			contentX,
			boxY,
			size,
			spec.avatarFit,
			spec.avatarOffsetX,
			spec.avatarOffsetY,
			spec.avatarZoom
		);
		ctx.restore();

		if (spec.avatarRing) {
			const lineWidth = Math.max(1, size * 0.07);
			ctx.save();
			ctx.globalAlpha = 0.85;
			ctx.strokeStyle = spec.accentColor;
			ctx.lineWidth = lineWidth;
			avatarPath(ctx, contentX + lineWidth / 2, boxY + lineWidth / 2, size - lineWidth, spec.avatarShape);
			ctx.stroke();
			ctx.restore();
		}
		textX = contentX + size + gap;
	}

	// ── 文字 ──
	let lineY = contentY + (contentHeight - textHeight) / 2;
	for (const line of lines) {
		ctx.save();
		ctx.globalAlpha = line.alpha;
		ctx.fillStyle = spec.color;
		ctx.textBaseline = "middle";
		ctx.textAlign = "left";
		setLetterSpacing(ctx, line.spacingEm, line.size);
		ctx.font = `${line.weight} ${line.size}px ${spec.font}`;
		ctx.fillText(line.text, textX, lineY + line.lineHeight / 2);
		ctx.restore();
		lineY += line.lineHeight;
	}
}

function roundRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number
): void {
	const r = Math.min(radius, width / 2, height / 2);
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + width, y, x + width, y + height, r);
	ctx.arcTo(x + width, y + height, x, y + height, r);
	ctx.arcTo(x, y + height, x, y, r);
	ctx.arcTo(x, y, x + width, y, r);
	ctx.closePath();
}

/* ───────────────────────── 作者信息预览 ───────────────────────── */

export interface AuthorPreviewSize {
	/** 预览画布的显示宽度（CSS px） */
	widthCss: number;
	paperWidthMm: number;
	paperHeightMm: number;
	paperColor: string;
	dpi: number;
	/** 署名带占用的高度（mm），由 authorBandMm() 给出 */
	bandMm: number;
}

/** 预览下方「细节放大」那条横带的显示高度（CSS px） */
const AUTHOR_DETAIL_CSS = 58;

/**
 * 设置页里的作者信息预览，分上下两块：
 *   上：整页缩小图，署名按真实比例画在底部，用来看它占多少竖向空间；
 *   下：署名带的放大细节，用来看字号、字体、颜色、头像大小和对齐。
 *
 * 两块用的都是导出时同一个 drawAuthorBlock，所以样式所见即所得。
 */
export function drawAuthorPreview(
	canvas: HTMLCanvasElement,
	spec: AuthorSpec | null,
	size: AuthorPreviewSize
): void {
	const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
	const cssWidth = Math.max(120, Math.round(size.widthCss));
	const pageHeightDev = Math.round(
		(cssWidth * dpr * size.paperHeightMm) / Math.max(1, size.paperWidthMm)
	);
	const detailHeightDev = Math.round(AUTHOR_DETAIL_CSS * dpr);
	const gapDev = Math.round(AUTHOR_DETAIL_CSS * 0.3 * dpr);

	canvas.width = Math.round(cssWidth * dpr);
	canvas.height = pageHeightDev + gapDev + detailHeightDev;
	canvas.style.width = `${cssWidth}px`;
	canvas.style.height = `${(canvas.height / dpr).toFixed(0)}px`;

	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	// 画布其余部分保持透明，露出设置页底色，两块纸才不会连成一片
	const pageWidthPx = Math.max(1, mmToPx(size.paperWidthMm, size.dpi));
	const bandPx = Math.max(1, mmToPx(size.bandMm, size.dpi));
	const kPage = canvas.width / pageWidthPx;

	// ── 上：整页 + 真实比例的署名 ──
	const bandDev = Math.max(2, bandPx * kPage);
	const bandTop = pageHeightDev - bandDev;
	ctx.save();
	ctx.fillStyle = size.paperColor;
	ctx.fillRect(0, 0, canvas.width, pageHeightDev);
	drawPreviewLines(ctx, canvas.width, pageHeightDev, bandTop - pageHeightDev * 0.04);
	if (spec) {
		// 淡底纹标出署名带占的位置
		ctx.fillStyle = "rgba(127,127,127,0.14)";
		ctx.fillRect(0, bandTop, canvas.width, bandDev);
		drawAuthorBlock(ctx, scaleAuthorSpec(spec, kPage), 0, bandTop, canvas.width, bandDev);
	}
	ctx.restore();

	// ── 下：署名带放大细节 ──
	const detailTop = pageHeightDev + gapDev;
	ctx.save();
	ctx.fillStyle = size.paperColor;
	ctx.fillRect(0, detailTop, canvas.width, detailHeightDev);
	// 顶边一条细线，暗示这是从页面底部截下来的一段
	ctx.fillStyle = "rgba(127,127,127,0.45)";
	ctx.fillRect(0, detailTop, canvas.width, Math.max(1, dpr));
	if (spec) {
		// 放大到能看清字号与字体；对齐在放大的画布里单独表现，所以留出两侧内边距
		const padX = canvas.width * 0.06;
		const measured = authorBlockSize(ctx, spec);
		const kDetail = Math.min((detailHeightDev * 0.78) / Math.max(1, measured.height), (canvas.width - padX * 2) / Math.max(1, measured.width));
		drawAuthorBlock(
			ctx,
			scaleAuthorSpec(spec, kDetail),
			padX,
			detailTop,
			canvas.width - padX * 2,
			detailHeightDev
		);
	}
	ctx.restore();
}

/** 把署名按比例缩放（预览 / 小样用）：字号与头像一起变，相对关系不变 */
export function scaleAuthorSpec(spec: AuthorSpec, k: number): AuthorSpec {
	return {
		...spec,
		sizePx: Math.max(3, spec.sizePx * k),
		avatarSizePx: Math.max(0, spec.avatarSizePx * k),
	};
}

/** 模板小样的画布尺寸（CSS px）与小样专用的固定 dpi */
const THUMB_WIDTH_CSS = 216;
const THUMB_HEIGHT_CSS = 96;
const THUMB_DPI = 96;

/**
 * 模板画廊里的小样：按一套样式 + 示例内容画一张署名，等比缩放到画布大小。
 *
 * 与导出走的是同一条 drawAuthorBlock 链路，所以小样上看到的字体、装饰、字重
 * 就是套用之后导出会得到的效果；背景留空，交给卡片自己的底色。
 */
export function drawAuthorThumb(
	canvas: HTMLCanvasElement,
	style: AuthorStyle,
	sample: { name: string; text: string }
): void {
	const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
	canvas.width = Math.round(THUMB_WIDTH_CSS * dpr);
	canvas.height = Math.round(THUMB_HEIGHT_CSS * dpr);

	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	const spec = authorTemplateSpec(style, THUMB_DPI, sample);
	const size = authorBlockSize(ctx, spec);
	if (size.width <= 0 || size.height <= 0) return;

	// 留一点内边距，整块等比缩放到画布里（装饰与留白按同一比例缩放）
	const pad = canvas.width * 0.07;
	const k = Math.min((canvas.width - pad * 2) / size.width, (canvas.height - pad * 2) / size.height);
	// 对齐也必须在留白以内计算，否则左右对齐的字形和描边会贴住小样边缘。
	drawAuthorBlock(ctx, scaleAuthorSpec(spec, k), pad, 0, canvas.width - pad * 2, canvas.height);
}

/* ─────────────────────────── 图片资源加载 ─────────────────────────── */

function bytesToDataUrl(bytes: Uint8Array, path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const mime =
		ext === "jpg" || ext === "jpeg"
			? "image/jpeg"
			: ext === "gif"
				? "image/gif"
				: ext === "webp"
					? "image/webp"
					: ext === "svg"
						? "image/svg+xml"
						: ext === "bmp"
							? "image/bmp"
							: ext === "avif"
								? "image/avif"
								: "image/png";
	let binary = "";
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		binary += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return `data:${mime};base64,${btoa(binary)}`;
}

async function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
	const image = new Image();
	image.src = dataUrl;
	if (typeof image.decode === "function") {
		await image.decode();
	} else {
		await new Promise<void>((resolve, reject) => {
			image.addEventListener("load", () => resolve(), { once: true });
			image.addEventListener("error", () => reject(new Error(t("图片解码失败"))), { once: true });
		});
	}
	return image;
}

/**
 * 读取一张图片并解码成可直接 drawImage 的 Image（失败返回 null）。
 *
 * 路径支持两种：
 * - vault 内的相对路径（如 assets/logo.png）；
 * - 系统文件系统的绝对路径 —— 由设置页的「选择图片…」写入，vault 之外的图片也能用。
 */
export async function loadImage(
	app: App,
	path: string,
	onWarn?: (message: string) => void
): Promise<HTMLImageElement | null> {
	const trimmed = path.trim();
	if (!trimmed) return null;

	try {
		if (isAbsolutePath(trimmed)) {
			const bytes = await fs.readFile(trimmed);
			return await decodeImage(bytesToDataUrl(new Uint8Array(bytes), trimmed));
		}
		const file = app.vault.getAbstractFileByPath(trimmed);
		if (!(file instanceof TFile)) {
			onWarn?.(t("找不到图片：{0}", trimmed));
			return null;
		}
		const bytes = new Uint8Array(await app.vault.readBinary(file));
		return await decodeImage(bytesToDataUrl(bytes, file.path));
	} catch (error) {
		onWarn?.(t("图片加载失败：{0}（{1}）", trimmed, String(error)));
		return null;
	}
}

/* ───────────────────────── 像素级隐水印（LSB） ───────────────────────── */

const MAGIC = [0x4c, 0x53, 0x50, 0x44]; // "LSPD"
const VERSION = 1;
const HEADER_BYTES = 8; // magic(4) + version(1) + length(2) + checksum(1)
const CHANNEL_OFFSET = 2; // 写进蓝色通道的最低位

function payloadBytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function buildFrame(text: string): Uint8Array {
	const payload = payloadBytes(text);
	const length = Math.min(payload.length, 0xffff);
	const frame = new Uint8Array(HEADER_BYTES + length);
	frame.set(MAGIC, 0);
	frame[4] = VERSION;
	frame[5] = (length >> 8) & 0xff;
	frame[6] = length & 0xff;
	let checksum = 0;
	for (let i = 0; i < length; i++) {
		frame[HEADER_BYTES + i] = payload[i];
		checksum ^= payload[i];
	}
	frame[7] = checksum;
	return frame;
}

/** 需要多少像素才能容纳这段文字 */
export function hiddenWatermarkCapacity(text: string): number {
	return (HEADER_BYTES + payloadBytes(text).length) * 8;
}

/**
 * 把标识写进画布像素的最低位（肉眼不可见）。
 * 仅在 PNG 这类无损编码下可靠：JPEG 压缩会破坏最低位。
 */
export function embedHiddenWatermark(canvas: HTMLCanvasElement, text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return false;

	const frame = buildFrame(trimmed);
	let imageData: ImageData;
	try {
		imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	} catch {
		return false;
	}
	const data = imageData.data;
	const needed = frame.length * 8;
	if (data.length / 4 < needed) return false;

	let bitIndex = 0;
	for (const byte of frame) {
		for (let bit = 7; bit >= 0; bit--) {
			const value = (byte >> bit) & 1;
			const offset = bitIndex * 4 + CHANNEL_OFFSET;
			data[offset] = (data[offset] & 0xfe) | value;
			bitIndex += 1;
		}
	}
	ctx.putImageData(imageData, 0, 0);
	return true;
}

/** 从画布像素里读回隐水印；没有或校验失败返回 null */
export function extractHiddenWatermark(canvas: HTMLCanvasElement): string | null {
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;
	let imageData: ImageData;
	try {
		imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	} catch {
		return null;
	}
	const data = imageData.data;
	const readBit = (index: number): number => {
		const offset = index * 4 + CHANNEL_OFFSET;
		if (offset >= data.length) return -1;
		return data[offset] & 1;
	};

	const readByte = (byteIndex: number): number | null => {
		let value = 0;
		for (let bit = 0; bit < 8; bit++) {
			const b = readBit(byteIndex * 8 + bit);
			if (b < 0) return null;
			value = (value << 1) | b;
		}
		return value;
	};

	for (let i = 0; i < MAGIC.length; i++) {
		if (readByte(i) !== MAGIC[i]) return null;
	}
	if (readByte(4) !== VERSION) return null;
	const high = readByte(5);
	const low = readByte(6);
	const checksum = readByte(7);
	if (high === null || low === null || checksum === null) return null;
	const length = (high << 8) | low;
	const payload = new Uint8Array(length);
	let sum = 0;
	for (let i = 0; i < length; i++) {
		const byte = readByte(HEADER_BYTES + i);
		if (byte === null) return null;
		payload[i] = byte;
		sum ^= byte;
	}
	if (sum !== checksum) return null;
	return new TextDecoder().decode(payload);
}
