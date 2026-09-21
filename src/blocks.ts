/** 正文里单独成行的 /// 会被渲染成这个零高度标记，用作强制分页点 */
export const PAGEBREAK_CLASS = "longshot-pagebreak";

/** 供分页使用的块框（坐标已换算为源图 px） */
export interface BlockBox {
	top: number;
	bottom: number;
	heading: boolean;
	/** 标题层级 1–6；不是标题时为 0 */
	level: number;
	/** 标题文字（用于 PDF 书签）；不是标题时为空串 */
	text: string;
	depth: number;
	tag: string;
}

export interface BlockIndex {
	/** 所有可用作分页断点的块（块顶 = 断点位置） */
	candidates: BlockBox[];
	/** 顶层块，用于识别「页面末尾只剩一个标题」的孤行 */
	topLevel: BlockBox[];
	/** 不可拆分的内容块（图片/视频/内嵌对象），只要整页放得下就应整体推到下一页 */
	atoms: BlockBox[];
	/** 标题（带层级与文字），按位置升序，用于生成 PDF 书签 */
	headings: BlockBox[];
	/** 正文里 /// 标记的位置（源图 px） */
	forcedBreaks: number[];
}

/** 允许继续向下钻取的元素：内部子块也是合法的分页断点 */
const CONTAINER_TAGS = new Set([
	"UL",
	"OL",
	"LI",
	"BLOCKQUOTE",
	"TABLE",
	"THEAD",
	"TBODY",
	"TFOOT",
	"TR",
	"DL",
	"DD",
	"DT",
	"DIV",
	"SECTION",
	"ARTICLE",
	"FIGURE",
	"DETAILS",
	"SUMMARY",
]);

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

/** 不可拆分的内容块：切在中间会破图，宁可在页尾留白也要整体挪到下一页 */
const ATOMIC_TAGS = new Set(["IMG", "PICTURE", "VIDEO", "IFRAME", "CANVAS", "SVG", "OBJECT", "EMBED"]);

function isHeading(el: HTMLElement): boolean {
	return (
		/^H[1-6]$/.test(el.tagName) || el.classList.contains("heading")
	);
}

/** 标题层级：h1–h6 取数字，阅读视图的内联标题按 1 级处理；不是标题返回 0 */
function headingLevel(el: HTMLElement): number {
	const matched = el.tagName.match(/^H([1-6])$/);
	if (matched) return Number(matched[1]);
	if (el.classList.contains("inline-title")) return 1;
	return 0;
}

const MAX_HEADING_TEXT = 120;

function headingText(el: HTMLElement): string {
	const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
	return text.length > MAX_HEADING_TEXT ? `${text.slice(0, MAX_HEADING_TEXT - 1)}…` : text;
}

/**
 * 从预览容器里收集分页断点。
 * 顶层块 + 容器内部的子块（列表项、表格行、引用段落…）都会成为候选断点，
 * 这样「一个跨页的长列表 / 长表格」也能在合适的位置切开。
 */
export function collectBlocks(sizer: HTMLElement, stage: HTMLElement, scale: number): BlockIndex {
	const stageTop = stage.getBoundingClientRect().top;
	const collected: BlockBox[] = [];
	const topLevel: BlockBox[] = [];
	const atoms: BlockBox[] = [];
	const headings: BlockBox[] = [];

	// /// 强制分页：标记元素是零高度的，先单独取一次坐标
	const forcedBreaks: number[] = [];
	for (const marker of Array.from(sizer.querySelectorAll<HTMLElement>(`.${PAGEBREAK_CLASS}`))) {
		forcedBreaks.push((marker.getBoundingClientRect().top - stageTop) * scale);
	}
	forcedBreaks.sort((a, b) => a - b);

	const visit = (parent: HTMLElement, depth: number): void => {
		for (const child of Array.from(parent.children)) {
			if (!(child instanceof HTMLElement)) continue;
			if (SKIP_TAGS.has(child.tagName)) continue;
			const style = getComputedStyle(child);
			if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
				continue;
			}
			const rect = child.getBoundingClientRect();
			if (rect.height < 2 || rect.width < 2) continue;
			const level = headingLevel(child);
			const box: BlockBox = {
				top: (rect.top - stageTop) * scale,
				bottom: (rect.bottom - stageTop) * scale,
				heading: isHeading(child),
				level,
				text: level > 0 ? headingText(child) : "",
				depth,
				tag: child.tagName.toLowerCase(),
			};
			collected.push(box);
			if (level > 0 && box.text) headings.push(box);
			if (depth === 0) topLevel.push(box);
			if (ATOMIC_TAGS.has(child.tagName)) {
				atoms.push({ ...box });
				continue;
			}

			// 代码块内部没有子元素，用 Range 的逐行矩形补上「按行断页」的候选点
			if (child.tagName === "PRE") {
				collected.push(...lineBoxes(child, stageTop, scale, depth + 1, box.top));
				continue;
			}

			const heightCss = (box.bottom - box.top) / scale;
			if (depth < 6 && (CONTAINER_TAGS.has(child.tagName) || heightCss > 600)) {
				visit(child, depth + 1);
			}
		}
	};
	visit(sizer, 0);

	collected.sort((a, b) => a.top - b.top);

	// 同一纵坐标上的多个块合并成一个断点，保留最外层信息
	const candidates: BlockBox[] = [];
	for (const box of collected) {
		const last = candidates[candidates.length - 1];
		if (last && Math.abs(last.top - box.top) < 1) {
			last.heading = last.heading || box.heading;
			if (box.depth < last.depth) {
				last.depth = box.depth;
				last.tag = box.tag;
			}
			last.bottom = Math.max(last.bottom, box.bottom);
			continue;
		}
		candidates.push({ ...box });
	}

	headings.sort((a, b) => a.top - b.top || a.depth - b.depth);
	const uniqueHeadings: BlockBox[] = [];
	for (const box of headings) {
		const last = uniqueHeadings[uniqueHeadings.length - 1];
		if (last && Math.abs(last.top - box.top) < 1) continue;
		uniqueHeadings.push(box);
	}

	return { candidates, topLevel, atoms, headings: uniqueHeadings, forcedBreaks };
}

/**
 * 用 Range 逐行矩形，为 `<pre>` 里的每一行文本生成断点，
 * 这样长代码块只会在行与行之间被切开，不会拦腰截断一行代码。
 */
function lineBoxes(
	el: HTMLElement,
	stageTop: number,
	scale: number,
	depth: number,
	firstTop: number
): BlockBox[] {
	const range = document.createRange();
	range.selectNodeContents(el);
	const boxes: BlockBox[] = [];
	for (const rect of Array.from(range.getClientRects())) {
		if (rect.height < 2 || rect.width < 2) continue;
		const top = (rect.top - stageTop) * scale;
		if (Math.abs(top - firstTop) < 1) continue;
		boxes.push({
			top,
			bottom: (rect.bottom - stageTop) * scale,
			heading: false,
			level: 0,
			text: "",
			depth,
			tag: "#line",
		});
	}
	return boxes;
}