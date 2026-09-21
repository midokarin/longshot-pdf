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
 * 长截图直接写成单页 PDF：页面尺寸按 DPI 换算，
 * 超长内容会自动提高 DPI，使页面不超过 PDF 的边长上限。
 */
export async function buildLongPdf(
	source: HTMLCanvasElement,
	opts: { dpi: number; format: "jpeg" | "png"; jpegQuality: number }
): Promise<ArrayBuffer> {
	// 横向短笔记和纵向长截图都可能触及 PDF 边长上限，等比缩放两边。
	const dpi = Math.max(opts.dpi, (Math.max(source.width, source.height) * MM_PER_INCH) / MAX_PAGE_MM);
	const widthMm = Math.round(((source.width / dpi) * MM_PER_INCH + Number.EPSILON) * 1000) / 1000;
	const heightMm = Math.round(((source.height / dpi) * MM_PER_INCH + Number.EPSILON) * 1000) / 1000;
	const doc = new jsPDF({
		// jsPDF 会根据 orientation 重排 format 的宽高，必须与截图方向一致。
		orientation: source.width > source.height ? "landscape" : "portrait",
		unit: "mm",
		format: [widthMm, heightMm],
		compress: true,
	});
	if (opts.format === "png") {
		doc.addImage(source.toDataURL("image/png"), "PNG", 0, 0, widthMm, heightMm, undefined, "FAST");
	} else {
		doc.addImage(
			source.toDataURL("image/jpeg", opts.jpegQuality),
			"JPEG",
			0,
			0,
			widthMm,
			heightMm,
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
					reject(new Error("导出图片失败"));
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