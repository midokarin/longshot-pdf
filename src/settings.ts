export type PaperId = "a4" | "a5" | "b5" | "letter" | "custom";
export type QualityLevel = "high" | "medium" | "low";
export type ImageFormat = "jpeg" | "png";
export type AlignMode = "left" | "center" | "right";
export type RenderTheme = "light" | "dark" | "theme";
export type CaptureBackground = "paper" | "theme";
/** 水印排布：平铺（整页斜向重复）或居中单个 */
export type WatermarkLayout = "tile" | "center";
/**
 * 水印字体。前半部分面向中文（各自带中文回退），后半部分是常见的西文字体；
 * 中英文混排时都会自动回退到系统中文字体，不会出现方框。
 */
export type WatermarkFont =
	// 中文
	| "sans"
	| "serif"
	| "kai"
	| "fangsong"
	| "round"
	| "mono"
	| "pingfang"
	| "yahei"
	// 西文
	| "helvetica"
	| "verdana"
	| "georgia"
	| "garamond"
	| "times"
	| "courier"
	| "optima"
	| "baskerville"
	| "didot"
	| "futura"
	| "avenir"
	| "palatino"
	| "menlo";
/** 头像图片的呈现方式 */
export type AvatarFit = "cover" | "contain" | "fill";
/** 头像外框形状 */
export type AvatarShape = "circle" | "rounded" | "square";
/** 署名带的装饰元素 */
export type AuthorDecor = "none" | "bar" | "rule" | "card" | "frame";
/** 姓名的字重（canvas font-weight） */
export type AuthorNameWeight = 400 | 500 | 600 | 700;
/** 单个水印的落点（九宫格） */
export type WatermarkAnchor =
	| "top-left"
	| "top-center"
	| "top-right"
	| "middle-left"
	| "middle-center"
	| "middle-right"
	| "bottom-left"
	| "bottom-center"
	| "bottom-right";
/** 导出类型：按纸张自动分页，还是整篇一张长截图 */
export type ExportType = "paged" | "long";
/** 导出格式：PDF / JPG / PNG */
export type ExportFormat = "pdf" | "jpeg" | "png";
/** 实际执行的任务：类型 + 格式的组合 */
export type ExportMode = "pdf" | "pages" | "long" | "longPdf";

export const EXPORT_TYPE_LABELS: Record<ExportType, string> = {
	paged: "自动分页（按纸张分页排版）",
	long: "长截图（整篇拼成一张长图）",
};

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
	pdf: "PDF",
	jpeg: "JPG（体积小）",
	png: "PNG（无损，文件大）",
};

/** 类型 + 格式 → 具体任务 */
export function resolveExportMode(settings: {
	exportType: ExportType;
	exportFormat: ExportFormat;
}): ExportMode {
	if (settings.exportType === "long") {
		return settings.exportFormat === "pdf" ? "longPdf" : "long";
	}
	return settings.exportFormat === "pdf" ? "pdf" : "pages";
}

/** 图片编码格式（PDF 之外都用它） */
export function imageFormatOf(settings: { exportFormat: ExportFormat }): ImageFormat {
	return settings.exportFormat === "png" ? "png" : "jpeg";
}

/** 从命令面板直接执行时，把用到的任务回填成设置里的类型 + 格式 */
export function applyModeToSettings(
	settings: { exportType: ExportType; exportFormat: ExportFormat },
	mode: ExportMode
): void {
	settings.exportType = mode === "long" || mode === "longPdf" ? "long" : "paged";
	if (mode === "pdf" || mode === "longPdf") {
		settings.exportFormat = "pdf";
	} else if (settings.exportFormat === "pdf") {
		settings.exportFormat = "jpeg";
	}
}

export interface PaperSize {
	widthMm: number;
	heightMm: number;
}

export const PAPER_PRESETS: Record<Exclude<PaperId, "custom">, PaperSize> = {
	a4: { widthMm: 210, heightMm: 297 },
	a5: { widthMm: 148, heightMm: 210 },
	b5: { widthMm: 176, heightMm: 250 },
	letter: { widthMm: 215.9, heightMm: 279.4 },
};

export const PAPER_LABELS: Record<PaperId, string> = {
	a4: "A4 (210 × 297 mm)",
	a5: "A5 (148 × 210 mm)",
	b5: "B5 (176 × 250 mm)",
	letter: "Letter (215.9 × 279.4 mm)",
	custom: "自定义尺寸",
};

export const QUALITY_LABELS: Record<QualityLevel, string> = {
	high: "高 · 300 DPI",
	medium: "中 · 200 DPI",
	low: "低 · 150 DPI",
};

export const WATERMARK_LAYOUT_LABELS: Record<WatermarkLayout, string> = {
	tile: "整页平铺",
	center: "单个",
};

export const WATERMARK_FONT_LABELS: Record<WatermarkFont, string> = {
	sans: "中文 · 黑体（无衬线）",
	serif: "中文 · 宋体",
	kai: "中文 · 楷体",
	fangsong: "中文 · 仿宋",
	round: "中文 · 圆体",
	mono: "中文 · 等宽黑体",
	pingfang: "中文 · 苹方",
	yahei: "中文 · 微软雅黑",
	helvetica: "西文 · Helvetica / Arial",
	verdana: "西文 · Verdana",
	georgia: "西文 · Georgia",
	garamond: "西文 · Garamond",
	times: "西文 · Times New Roman",
	courier: "西文 · Courier New",
	optima: "西文 · Optima",
	baskerville: "西文 · Baskerville",
	didot: "西文 · Didot（高对比衬线）",
	futura: "西文 · Futura（几何无衬线）",
	avenir: "西文 · Avenir Next",
	palatino: "西文 · Palatino",
	menlo: "西文 · Menlo（等宽）",
};

export const AVATAR_SHAPE_LABELS: Record<AvatarShape, string> = {
	circle: "圆形",
	rounded: "圆角方形",
	square: "正方形",
};

export const AUTHOR_DECOR_LABELS: Record<AuthorDecor, string> = {
	none: "无（纯文字落款）",
	bar: "左侧竖条（引用感）",
	rule: "上方细线（杂志感）",
	card: "卡片底纹",
	frame: "细边框（印章感）",
};

export const AUTHOR_NAME_WEIGHT_LABELS: Record<AuthorNameWeight, string> = {
	400: "常规",
	500: "中等",
	600: "半粗",
	700: "粗体",
};

export const AVATAR_FIT_LABELS: Record<AvatarFit, string> = {
	cover: "裁剪填满（不变形，推荐）",
	contain: "完整显示（四周留白）",
	fill: "拉伸填满（会变形）",
};

export const WATERMARK_ANCHOR_LABELS: Record<WatermarkAnchor, string> = {
	"top-left": "左上",
	"top-center": "上中",
	"top-right": "右上",
	"middle-left": "左中",
	"middle-center": "正中",
	"middle-right": "右中",
	"bottom-left": "左下",
	"bottom-center": "下中",
	"bottom-right": "右下",
};

/** 作者信息里可以一键套用的样式（不含名字、附加文字、头像这些内容） */
export type AuthorDesign = "legacy" | "minimal" | "terminal" | "literary" | "blog" | "newsletter" | "research" | "photo" | "podcast" | "journal" | "studio";

export interface AuthorStyle {
	design: AuthorDesign;
	font: WatermarkFont;
	sizePt: number;
	color: string;
	align: AlignMode;
	avatarSizeMm: number;
	/** 头像外框形状 */
	avatarShape: AvatarShape;
	/** 头像是否描一圈强调色细边 */
	avatarRing: boolean;
	/** 署名带的装饰元素 */
	decor: AuthorDecor;
	/** 装饰与强调色（竖条 / 细线 / 卡片 / 描边） */
	accentColor: string;
	/** 姓名的字重，比附加文字更重一些才分得出主次 */
	nameWeight: AuthorNameWeight;
	/** 字符间距（em），小字号或西文标题拉开一些更精致 */
	letterSpacingEm: number;
	/** 附加文字的浓淡：1 = 与姓名同色，越小越淡 */
	textOpacity: number;
}

/** 新增样式字段的兜底值：老的自定义模板没有这些字段，套用时补齐 */
export const DEFAULT_AUTHOR_STYLE: AuthorStyle = {
	design: "legacy",
	font: "sans",
	sizePt: 9,
	color: "#8a8a8a",
	align: "right",
	avatarSizeMm: 8,
	avatarShape: "circle",
	avatarRing: false,
	decor: "none",
	accentColor: "#3b82f6",
	nameWeight: 600,
	letterSpacingEm: 0,
	textOpacity: 0.72,
};

/** 一套作者信息样式模板；内置预设不可删除 */
export interface AuthorTemplate {
	/** 内置预设用固定 id，自定义模板用生成的时间戳 id */
	id: string;
	name: string;
	builtin?: boolean;
	style: AuthorStyle;
}

/**
 * 内置的作者信息预设，覆盖从「极简落款」到「名片式署名」的常见风格。
 * 只定义样式；名字与头像仍由用户自己填。
 */
export const AUTHOR_TEMPLATES: AuthorTemplate[] = [
	{
		id: "minimal",
		name: "极简",
		builtin: true,
		style: {
			design: "minimal",
			font: "sans",
			sizePt: 9,
			color: "#27313b",
			align: "right",
			avatarSizeMm: 6,
			avatarShape: "circle",
			avatarRing: false,
			decor: "none",
			accentColor: "#9aa3af",
			nameWeight: 500,
			letterSpacingEm: 0,
			textOpacity: 0.76,
		},
	},
	{
		id: "classic",
		name: "文艺",
		builtin: true,
		style: {
			design: "literary",
			font: "serif",
			sizePt: 10,
			color: "#49376b",
			align: "center",
			avatarSizeMm: 8,
			avatarShape: "circle",
			avatarRing: false,
			decor: "none",
			accentColor: "#8172b9",
			nameWeight: 500,
			letterSpacingEm: 0,
			textOpacity: 0.76,
		},
	},
	{
		id: "card",
		name: "博客",
		builtin: true,
		style: {
			design: "blog",
			font: "sans",
			sizePt: 10,
			color: "#203d67",
			align: "right",
			avatarSizeMm: 10,
			avatarShape: "circle",
			avatarRing: false,
			decor: "none",
			accentColor: "#3875dc",
			nameWeight: 600,
			letterSpacingEm: 0,
			textOpacity: 0.76,
		},
	},
	{
		id: "center",
		name: "声波",
		builtin: true,
		style: {
			design: "podcast",
			font: "avenir",
			sizePt: 10,
			color: "#532e72",
			align: "center",
			avatarSizeMm: 9,
			avatarShape: "circle",
			avatarRing: false,
			decor: "none",
			accentColor: "#9765ca",
			nameWeight: 600,
			letterSpacingEm: 0,
			textOpacity: 0.76,
		},
	},
	{
		id: "mono",
		name: "终端",
		builtin: true,
		style: {
			design: "terminal",
			font: "mono",
			sizePt: 9,
			color: "#263d50",
			align: "right",
			avatarSizeMm: 9,
			avatarShape: "rounded",
			avatarRing: false,
			decor: "none",
			accentColor: "#23856a",
			nameWeight: 600,
			letterSpacingEm: 0,
			textOpacity: 0.76,
		},
	},
	{
		id: "bold",
		name: "取景",
		builtin: true,
		style: {
			design: "photo",
			font: "helvetica",
			sizePt: 10,
			color: "#30353c",
			align: "right",
			avatarSizeMm: 9,
			avatarShape: "square",
			avatarRing: false,
			decor: "none",
			accentColor: "#9e8043",
			nameWeight: 600,
			letterSpacingEm: 0,
			textOpacity: 0.76,
		},
	},
	{
		id: "magazine",
		name: "专栏",
		builtin: true,
		style: {
			design: "newsletter",
			font: "sans",
			sizePt: 11,
			color: "#202834",
			align: "right",
			avatarSizeMm: 9,
			avatarShape: "circle",
			avatarRing: false,
			decor: "none",
			accentColor: "#ee654a",
			nameWeight: 700,
			letterSpacingEm: 0,
			textOpacity: 0.76,
		},
	},
	{
		id: "elegant",
		name: "学术",
		builtin: true,
		style: {
			design: "research",
			font: "sans",
			sizePt: 9.5,
			color: "#344c61",
			align: "right",
			avatarSizeMm: 8,
			avatarShape: "square",
			avatarRing: false,
			decor: "none",
			accentColor: "#66879e",
			nameWeight: 600,
			letterSpacingEm: 0,
			textOpacity: 0.76,
		},
	},
	{
		id: "ink",
		name: "手账",
		builtin: true,
		style: {
			design: "journal",
			font: "round",
			sizePt: 10,
			color: "#625039",
			align: "right",
			avatarSizeMm: 9,
			avatarShape: "rounded",
			avatarRing: false,
			decor: "none",
			accentColor: "#d4a04a",
			nameWeight: 500,
			letterSpacingEm: 0,
			textOpacity: 0.76,
		},
	},
	{
		id: "studio",
		name: "设计",
		builtin: true,
		style: {
			design: "studio",
			font: "avenir",
			sizePt: 11,
			color: "#253e38",
			align: "right",
			avatarSizeMm: 10,
			avatarShape: "square",
			avatarRing: false,
			decor: "none",
			accentColor: "#ff784f",
			nameWeight: 700,
			letterSpacingEm: 0,
			textOpacity: 0.76,
		},
	},
];

/** 取出当前设置里的作者样式 */
export function authorStyleOf(settings: {
	authorDesign?: AuthorDesign;
	authorFont: WatermarkFont;
	authorSizePt: number;
	authorColor: string;
	authorAlign: AlignMode;
	authorAvatarSizeMm: number;
	authorAvatarShape: AvatarShape;
	authorAvatarRing: boolean;
	authorDecor: AuthorDecor;
	authorAccentColor: string;
	authorNameWeight: AuthorNameWeight;
	authorLetterSpacingEm: number;
	authorTextOpacity: number;
}): AuthorStyle {
	return {
		design: settings.authorDesign ?? "legacy",
		font: settings.authorFont,
		sizePt: settings.authorSizePt,
		color: settings.authorColor,
		align: settings.authorAlign,
		avatarSizeMm: settings.authorAvatarSizeMm,
		avatarShape: settings.authorAvatarShape,
		avatarRing: settings.authorAvatarRing,
		decor: settings.authorDecor,
		accentColor: settings.authorAccentColor,
		nameWeight: settings.authorNameWeight,
		letterSpacingEm: settings.authorLetterSpacingEm,
		textOpacity: settings.authorTextOpacity,
	};
}

/** 把一套模板样式写回设置（不动名字、附加文字与头像）；缺字段的旧模板用默认值补齐 */
export function applyAuthorStyle(settings: LongshotSettings, style: AuthorStyle): void {
	const merged: AuthorStyle = { ...DEFAULT_AUTHOR_STYLE, ...style };
	settings.authorDesign = merged.design;
	settings.authorFont = merged.font;
	settings.authorSizePt = merged.sizePt;
	settings.authorColor = merged.color;
	settings.authorAlign = merged.align;
	settings.authorAvatarSizeMm = merged.avatarSizeMm;
	settings.authorAvatarShape = merged.avatarShape;
	settings.authorAvatarRing = merged.avatarRing;
	settings.authorDecor = merged.decor;
	settings.authorAccentColor = merged.accentColor;
	settings.authorNameWeight = merged.nameWeight;
	settings.authorLetterSpacingEm = merged.letterSpacingEm;
	settings.authorTextOpacity = merged.textOpacity;
}

/** 头像缩放的上限（裁剪填满时放大原图后再裁） */
export const AVATAR_ZOOM_MAX = 3;

/**
 * 九宫格落点 → 裁剪偏移。
 * 偏移取值 -1 / 0 / 1：-1 表示贴左边（上边），0 居中，1 贴右边（下边）。
 */
export function anchorToOffset(anchor: WatermarkAnchor): { x: number; y: number } {
	const [vertical, horizontal] = anchor.split("-") as [string, string];
	const axis = (value: string, low: string, high: string): number =>
		value === low ? -1 : value === high ? 1 : 0;
	return { x: axis(horizontal, "left", "right"), y: axis(vertical, "top", "bottom") };
}

/** 反向找最近的九宫格落点：拖动过之后，下拉框仍要显示一个合理的选择 */
export function nearestAnchor(offsetX: number, offsetY: number): WatermarkAnchor {
	let best: WatermarkAnchor = "middle-center";
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const anchor of Object.keys(WATERMARK_ANCHOR_LABELS) as WatermarkAnchor[]) {
		const point = anchorToOffset(anchor);
		const distance = (point.x - offsetX) ** 2 + (point.y - offsetY) ** 2;
		if (distance < bestDistance) {
			bestDistance = distance;
			best = anchor;
		}
	}
	return best;
}

export interface LongshotSettings {
	// ── 截图 ────────────────────────────────────────────────
	/** 离屏渲染宽度（CSS px），决定输出的清晰度与换行位置 */
	contentWidth: number;
	/** 截图倍率：DOM → canvas 的像素比，越大越清晰 */
	captureScale: number;
	/** 渲染完成后额外等待时间（ms），给 mermaid / 数学公式 / 嵌入内容留时间 */
	settleDelayMs: number;
	/** 等待 Mermaid / 公式 / 图片 / 嵌入笔记渲染完成的最长时间（ms） */
	renderTimeoutMs: number;
	/** 截图时的配色主题 */
	renderTheme: RenderTheme;
	/** 截图底色：跟随纸张颜色，或跟随主题背景 */
	captureBackground: CaptureBackground;
	/** 截图里包含笔记标题（阅读视图的内联标题） */
	includeTitle: boolean;

	// ── 纸张 ────────────────────────────────────────────────
	paper: PaperId;
	customWidthMm: number;
	customHeightMm: number;
	landscape: boolean;
	marginTopMm: number;
	marginRightMm: number;
	marginBottomMm: number;
	marginLeftMm: number;
	paperColor: string;
	borderEnabled: boolean;
	borderWidthPt: number;
	borderInsetMm: number;
	borderColor: string;

	// ── 页眉 / 页脚 ─────────────────────────────────────────
	headerTemplate: string;
	footerTemplate: string;
	footerSizePt: number;
	footerColor: string;
	headerAlign: AlignMode;
	footerAlign: AlignMode;

	// ── 分页 ────────────────────────────────────────────────
	smartBreak: boolean;
	avoidHeadingOrphan: boolean;
	/** 图片等不可拆分内容整体推到下一页（代价是上一页可能留白） */
	avoidSplittingImages: boolean;
	minFillRatio: number;
	/** 尊重正文里单独成行的 ///（强制分页标记） */
	respectForcedBreaks: boolean;
	/** 给 PDF 写入标题层级书签（大纲） */
	pdfOutline: boolean;

	// ── 水印 ────────────────────────────────────────────────
	watermarkEnabled: boolean;
	/** 水印文字模板，可用 {{name}} {{title}} {{date}} {{author}} */
	watermarkText: string;
	watermarkLayout: WatermarkLayout;
	/** 单个水印的落点（仅「排布 = 单个」时生效） */
	watermarkAnchor: WatermarkAnchor;
	/** 水印字体 */
	watermarkFont: WatermarkFont;
	/** 0–1，越小越淡 */
	watermarkOpacity: number;
	watermarkSizePt: number;
	watermarkRotationDeg: number;
	watermarkColor: string;
	/** vault 内的图片路径，或系统文件系统的绝对路径；填了就改用图片水印 */
	watermarkImagePath: string;
	/** 图片水印宽度占页面宽度的比例 */
	watermarkImageScale: number;

	// ── 作者信息 ────────────────────────────────────────────
	authorEnabled: boolean;
	authorName: string;
	/** 附加文本，例如「2026 年 9 月 · 内部资料」 */
	authorText: string;
	/** vault 内的头像图片路径，或系统文件系统的绝对路径 */
	authorAvatarPath: string;
	authorAvatarSizeMm: number;
	/** 头像的呈现方式：裁剪填满 / 完整显示 / 拉伸 */
	authorAvatarFit: AvatarFit;
	/** 「裁剪填满」时保留原图的哪一块：-1 贴左上、0 居中、1 贴右下（可在设置页里直接拖拽） */
	authorAvatarOffsetX: number;
	authorAvatarOffsetY: number;
	/** 「裁剪填满」时先放大原图再裁，用来把人物拉近（1 = 不放大） */
	authorAvatarZoom: number;
	/** 头像外框形状 */
	authorAvatarShape: AvatarShape;
	/** 头像是否描一圈强调色细边 */
	authorAvatarRing: boolean;
	authorSizePt: number;
	/** 作者信息的字体 */
	authorFont: WatermarkFont;
	authorColor: string;
	authorAlign: AlignMode;
	/** 内置定制版式；legacy 兼容原有设置和自定义模板 */
	authorDesign: AuthorDesign;
	/** 署名带的装饰元素与强调色 */
	authorDecor: AuthorDecor;
	authorAccentColor: string;
	/** 姓名字重 */
	authorNameWeight: AuthorNameWeight;
	/** 字符间距（em） */
	authorLetterSpacingEm: number;
	/** 附加文字的浓淡（0–1） */
	authorTextOpacity: number;
	/** 用户自己另存的作者信息样式模板（内置预设见 AUTHOR_TEMPLATES） */
	authorTemplates: AuthorTemplate[];

	// ── 隐水印 ──────────────────────────────────────────────
	/** 在像素最低位写入不可见标识（仅 PNG / PNG 页面的 PDF 可靠） */
	hiddenWatermarkEnabled: boolean;
	hiddenWatermarkText: string;

	// ── 输出 ───────────────────────────────────────────────
	/** 导出类型 + 格式，决定这次导出产出什么；弹窗打开时默认选中上次的选择 */
	exportType: ExportType;
	exportFormat: ExportFormat;
	quality: QualityLevel;
	jpegQuality: number;
	/** 输出文件夹的绝对路径（由系统文件夹选择框选取）；留空 = 与笔记同目录 */
	outputDir: string;
	fileTemplate: string;
}

export const DEFAULT_SETTINGS: LongshotSettings = {
	contentWidth: 800,
	captureScale: 3,
	settleDelayMs: 500,
	renderTimeoutMs: 8000,
	renderTheme: "light",
	captureBackground: "paper",
	includeTitle: true,

	paper: "a4",
	customWidthMm: 210,
	customHeightMm: 297,
	landscape: false,
	marginTopMm: 18,
	marginRightMm: 18,
	marginBottomMm: 18,
	marginLeftMm: 18,
	paperColor: "#ffffff",
	borderEnabled: false,
	borderWidthPt: 1,
	borderInsetMm: 8,
	borderColor: "#c8c8c8",

	headerTemplate: "",
	footerTemplate: "{{page}} / {{pages}}",
	footerSizePt: 9,
	footerColor: "#8a8a8a",
	headerAlign: "center",
	footerAlign: "center",

	smartBreak: true,
	avoidHeadingOrphan: true,
	avoidSplittingImages: true,
	minFillRatio: 0.6,
	respectForcedBreaks: true,
	pdfOutline: true,

	watermarkEnabled: false,
	watermarkText: "{{name}}",
	watermarkLayout: "tile",
	watermarkAnchor: "middle-center",
	watermarkFont: "sans",
	watermarkOpacity: 0.08,
	watermarkSizePt: 24,
	watermarkRotationDeg: -30,
	watermarkColor: "#000000",
	watermarkImagePath: "",
	watermarkImageScale: 0.35,

	authorEnabled: false,
	authorName: "",
	authorText: "",
	authorAvatarPath: "",
	authorAvatarSizeMm: 8,
	authorAvatarFit: "cover",
	authorAvatarOffsetX: 0,
	authorAvatarOffsetY: 0,
	authorAvatarZoom: 1,
	authorAvatarShape: "circle",
	authorAvatarRing: false,
	authorSizePt: 9,
	authorFont: "sans",
	authorColor: "#8a8a8a",
	authorAlign: "right",
	authorDesign: "legacy",
	authorDecor: "none",
	authorAccentColor: "#3b82f6",
	authorNameWeight: 600,
	authorLetterSpacingEm: 0,
	authorTextOpacity: 0.72,
	authorTemplates: [],

	hiddenWatermarkEnabled: false,
	hiddenWatermarkText: "Longshot PDF · {{name}} · {{date}}",

	exportType: "paged",
	exportFormat: "pdf",
	quality: "high",
	jpegQuality: 0.92,
	outputDir: "",
	fileTemplate: "{{name}}",
};

export function resolvePaperSize(settings: LongshotSettings): PaperSize {
	const base: PaperSize =
		settings.paper === "custom"
			? { widthMm: settings.customWidthMm, heightMm: settings.customHeightMm }
			: PAPER_PRESETS[settings.paper];
	if (!settings.landscape) {
		return base;
	}
	return { widthMm: base.heightMm, heightMm: base.widthMm };
}

export function resolveQualityDpi(quality: QualityLevel): number {
	switch (quality) {
		case "high":
			return 300;
		case "medium":
			return 200;
		default:
			return 150;
	}
}