import { t } from "./i18n";
import { jsPDF } from "jspdf";
import { MM_PER_INCH, nextFrame } from "./utils";

/** PDF 单页边长上限：14400 pt = 200 inch */
const MAX_PAGE_MM = 5080;

export interface PdfOutlineEntry {
	/** 1–6，越小层级越高 */
	level: number;
	title: string;
	/** 1 起算的页码 */
	page: number;
}

export interface PdfOptions {
	paperWidthMm: number;
	paperHeightMm: number;
	format: "jpeg" | "png";
	jpegQuality: number;
	/** 写入 PDF 的书签大纲（标题层级） */
	outline?: PdfOutlineEntry[];
	onProgress?: (done: number, total: number) => void;
}

/** 依次把每张页面画布写入 PDF（每页一张整页位图，保证与预览完全一致） */
export async function buildPdf(
	pages: HTMLCanvasElement[],
	opts: PdfOptions
): Promise<ArrayBuffer> {
	const landscape = opts.paperWidthMm > opts.paperHeightMm;
	const doc = new jsPDF({
		orientation: landscape ? "landscape" : "portrait",
		unit: "mm",
		format: [opts.paperWidthMm, opts.paperHeightMm],
		compress: true,
	});

	for (let i = 0; i < pages.length; i++) {
		if (i > 0) {
			doc.addPage([opts.paperWidthMm, opts.paperHeightMm], landscape ? "landscape" : "portrait");
		}
		const canvas = pages[i];
		if (opts.format === "png") {
			doc.addImage(
				canvas.toDataURL("image/png"),
				"PNG",
				0,
				0,
				opts.paperWidthMm,
				opts.paperHeightMm,
				undefined,
				"FAST"
			);
		} else {
			doc.addImage(
				canvas.toDataURL("image/jpeg", opts.jpegQuality),
				"JPEG",
				0,
				0,
				opts.paperWidthMm,
				opts.paperHeightMm,
				undefined,
				"FAST"
			);
		}
		opts.onProgress?.(i + 1, pages.length);
		await nextFrame();
	}

	writeOutline(doc, opts.outline, pages.length);
	return doc.output("arraybuffer");
}

interface OutlineNode {
	level: number;
	item: unknown;
}

/** 把标题列表按层级组织成书签树写进 PDF */
function writeOutline(
	doc: jsPDF,
	entries: PdfOutlineEntry[] | undefined,
	pageCount: number
): void {
	if (!entries?.length) return;
	const outline = doc.outline as unknown as {
		add(parent: unknown, title: string, options: { pageNumber: number }): unknown;
	};
	const stack: OutlineNode[] = [];
	for (const entry of entries) {
		while (stack.length > 0 && stack[stack.length - 1].level >= entry.level) {
			stack.pop();
		}
		const parent = stack.length > 0 ? stack[stack.length - 1].item : null;
		const page = Math.min(Math.max(1, Math.round(entry.page)), Math.max(1, pageCount));
		const item = outline.add(parent, entry.title, { pageNumber: page });
		stack.push({ level: entry.level, item });
	}

	// 有书签时让阅读器默认展开大纲面板
	const internal = (doc as unknown as {
		internal?: { events?: { subscribe(name: string, fn: () => void): void }; write?: (data: string) => void };
	}).internal;
	if (typeof internal?.events?.subscribe === "function" && typeof internal.write === "function") {
		internal.events.subscribe("putCatalog", () => {
			internal.write?.("/PageMode /UseOutlines");
		});
	}
}

/**
 * 长截图写成单页 PDF：按纸宽和页边距排版；未指定版面时按 DPI 换算。
 * 超长内容等比缩放，使页面不超过 PDF 的边长上限。
 */
export async function buildLongPdf(
	source: HTMLCanvasElement,
	opts: {
		dpi: number;
		format: "jpeg" | "png";
		jpegQuality: number;
		/** 指定版面后按纸宽等比放置截图，高度随内容延伸。 */
		layout?: {
			paperWidthMm: number;
			marginTopMm: number;
			marginRightMm: number;
			marginBottomMm: number;
			marginLeftMm: number;
			paperColor: string;
		};
	}
): Promise<ArrayBuffer> {
	const layout = opts.layout;
	const left = Math.max(0, layout?.marginLeftMm ?? 0);
	const right = Math.max(0, layout?.marginRightMm ?? 0);
	const top = Math.max(0, layout?.marginTopMm ?? 0);
	const bottom = Math.max(0, layout?.marginBottomMm ?? 0);
	// 不重采样源图：仅调整 PDF 中的放置尺寸，清晰度不受边距影响。
	const imageWidth = layout
		? Math.max(20, layout.paperWidthMm - left - right)
		: source.width / opts.dpi * MM_PER_INCH;
	const imageHeight = imageWidth * source.height / source.width;
	const pageWidth = imageWidth + left + right;
	const pageHeight = imageHeight + top + bottom;
	// PDF 单边超过 200 英寸时，连同留白一起等比收缩，避免裁切与比例改变。
	const scale = Math.min(1, MAX_PAGE_MM / Math.max(pageWidth, pageHeight));
	const widthMm = pageWidth * scale;
	const heightMm = pageHeight * scale;
	const x = left * scale;
	const y = top * scale;
	const imageWidthMm = imageWidth * scale;
	const imageHeightMm = imageHeight * scale;
	const doc = new jsPDF({
		// jsPDF 会根据 orientation 重排 format 的宽高，必须与截图方向一致。
		orientation: widthMm > heightMm ? "landscape" : "portrait",
		unit: "mm",
		format: [widthMm, heightMm],
		compress: true,
	});
	if (layout) {
		doc.setFillColor(layout.paperColor);
		doc.rect(0, 0, widthMm, heightMm, "F");
	}
	if (opts.format === "png") {
		doc.addImage(source.toDataURL("image/png"), "PNG", x, y, imageWidthMm, imageHeightMm, undefined, "FAST");
	} else {
		doc.addImage(
			source.toDataURL("image/jpeg", opts.jpegQuality),
			"JPEG",
			x,
			y,
			imageWidthMm,
			imageHeightMm,
			undefined,
			"FAST"
		);
	}
	await nextFrame();
	return doc.output("arraybuffer");
}

export function canvasToBlob(
	canvas: HTMLCanvasElement,
	format: "jpeg" | "png",
	quality: number
): Promise<Blob> {
	const mime = format === "png" ? "image/png" : "image/jpeg";
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) {
					resolve(blob);
				} else {
					reject(new Error(t("导出图片失败")));
				}
			},
			mime,
			format === "png" ? undefined : quality
		);
	});
}

export async function canvasToArrayBuffer(
	canvas: HTMLCanvasElement,
	format: "jpeg" | "png",
	quality: number
): Promise<ArrayBuffer> {
	const blob = await canvasToBlob(canvas, format, quality);
	return blob.arrayBuffer();
}