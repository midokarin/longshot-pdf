import type { BlockBox, BlockIndex } from "./blocks";
import type { PdfOutlineEntry } from "./output";
import { clamp } from "./utils";

export interface PageSlice {
	start: number;
	end: number;
}

export interface PaginateInput {
	totalHeight: number;
	/** 每页可容纳的源图高度（源图 px） */
	capacity: number;
	candidates: BlockBox[];
	topLevel: BlockBox[];
	/** 不可拆分块（图片/媒体）：切点落进去就整体挪到下一页 */
	atoms?: BlockBox[];
	minFillRatio: number;
	smartBreak: boolean;
	avoidHeadingOrphan: boolean;
	/** 在 [fromY, toY] 区间里找一条安全空白行，返回最靠下的可用位置 */
	findBlankRow?: (fromY: number, toY: number) => number | null;
	/** 正文里 /// 标记的强制分页位置（源图 px）：先在这些位置切开，再在每段里正常分页 */
	forcedBreaks?: number[];
}

export interface PaginateResult {
	slices: PageSlice[];
	/** 被硬切（无法避开内容）的次数 */
	hardSplits: number;
}

/** 在 [minY, limit] 中找最接近 target 的候选断点 */
function pickBreak(
	candidates: BlockBox[],
	minY: number,
	limit: number,
	target: number
): number | null {
	let best: number | null = null;
	let bestDist = Infinity;
	for (const box of candidates) {
		const y = box.top;
		if (y < minY) continue;
		if (y > limit) break;
		const dist = Math.abs(y - target);
		if (dist < bestDist) {
			bestDist = dist;
			best = y;
		}
	}
	return best;
}

/** 如果页尾刚好只剩标题，就把整组标题推到下一页 */
function shiftHeadingOrphan(cut: number, topLevel: BlockBox[], minY: number): number {
	let lastIndex = -1;
	for (let i = 0; i < topLevel.length; i++) {
		if (topLevel[i].bottom <= cut + 0.5) {
			lastIndex = i;
		} else {
			break;
		}
	}
	if (lastIndex < 0 || !topLevel[lastIndex].heading) return cut;
	let firstIndex = lastIndex;
	while (
		firstIndex - 1 >= 0 &&
		topLevel[firstIndex - 1].heading &&
		topLevel[firstIndex - 1].bottom <= cut + 0.5
	) {
		firstIndex -= 1;
	}
	const newCut = topLevel[firstIndex].top;
	return newCut >= minY ? newCut : cut;
}

/**
 * 如果切点落在某个「整页放得下的不可拆分块」内部，
 * 就把切点提到该块顶部，宁可本页留白也不把图片拦腰截断。
 */
function avoidSplittingAtom(
	cut: number,
	start: number,
	capacity: number,
	atoms: BlockBox[] | undefined
): number {
	if (!atoms?.length) return cut;
	for (const atom of atoms) {
		if (atom.bottom - atom.top > capacity * 0.95) continue;
		if (cut <= atom.top + 0.5 || cut >= atom.bottom - 0.5) continue;
		// 保证本页仍有起码的填充率，同时避免切点不前进导致死循环
		if (atom.top - start < capacity * 0.2) continue;
		return atom.top;
	}
	return cut;
}

export function paginate(input: PaginateInput): PaginateResult {
	const capacity = Math.max(50, input.capacity);
	const minFill = clamp(input.minFillRatio, 0.2, 0.95);
	const boundaries = normalizeBreaks(input.forcedBreaks, input.totalHeight);
	const slices: PageSlice[] = [];
	let hardSplits = 0;

	let cursor = 0;
	for (const boundary of [...boundaries, input.totalHeight]) {
		const part = paginateRange(input, cursor, boundary, capacity, minFill);
		slices.push(...part.slices);
		hardSplits += part.hardSplits;
		cursor = boundary;
	}

	return { slices, hardSplits };
}

/** 排序、去重并丢掉无效 / 过近的强制分页点 */
function normalizeBreaks(breaks: number[] | undefined, totalHeight: number): number[] {
	if (!breaks?.length) return [];
	const sorted = [...breaks].filter((y) => Number.isFinite(y) && y > 40 && y < totalHeight - 40).sort((a, b) => a - b);
	const result: number[] = [];
	for (const y of sorted) {
		const last = result[result.length - 1];
		if (last !== undefined && y - last < 40) continue;
		result.push(y);
	}
	return result;
}

/** 把 [from, to] 这一段按容量切页（段内自己平衡末页，不跨越强制分页点） */
function paginateRange(
	input: PaginateInput,
	from: number,
	to: number,
	capacity: number,
	minFill: number
): PaginateResult {
	const minFillPx = capacity * minFill;
	const slices: PageSlice[] = [];
	let hardSplits = 0;
	let start = from;
	let guard = 0;

	while (to - start > capacity && guard < 500) {
		guard += 1;
		const limit = start + capacity;
		const minY = Math.min(start + minFillPx, limit - 1);
		let end: number | null = null;

		if (input.smartBreak) {
			end = pickBreak(input.candidates, minY, limit, limit);
			if (end !== null && input.avoidHeadingOrphan) {
				end = shiftHeadingOrphan(end, input.topLevel, minY);
			}
		}

		if (end === null || end <= start) {
			const blankFrom = Math.max(start + capacity * 0.5, minY);
			const blank = input.findBlankRow?.(blankFrom, limit) ?? null;
			if (blank !== null && blank > start && blank <= limit) {
				end = blank;
			} else {
				end = limit;
				hardSplits += 1;
			}
		}

		if (end <= start) {
			end = Math.min(to, start + capacity);
			hardSplits += 1;
		}

		end = avoidSplittingAtom(end, start, capacity, input.atoms);
		slices.push({ start, end });
		start = end;
	}

	slices.push({ start, end: to });
	rebalanceTail(slices, input, capacity, minFill);

	return { slices, hardSplits };
}

/** 手动调整分页时，相邻两页之间至少保留的内容高度（源图 px） */
const MIN_PAGE_PX = 80;

/** 取所有内部边界（第 i 页的结束位置） */
export function boundariesOf(slices: PageSlice[]): number[] {
	return slices.slice(0, -1).map((slice) => slice.end);
}

/** 用显式边界重建分页结果（边界是每页的结束位置，最后一页收在 totalHeight） */
export function slicesFromBoundaries(boundaries: number[], totalHeight: number): PageSlice[] {
	const slices: PageSlice[] = [];
	let start = 0;
	for (const end of boundaries) {
		if (end > start) {
			slices.push({ start, end });
			start = end;
		}
	}
	slices.push({ start, end: totalHeight });
	return slices;
}

/**
 * 把第 index 条边界（第 index 页的末尾）上移 / 下移到最近的候选断点。
 * 返回新的边界位置；没有可用断点时返回 null。
 */
export function nudgeBoundary(
	slices: PageSlice[],
	index: number,
	direction: "up" | "down",
	candidates: BlockBox[]
): number | null {
	if (index < 0 || index >= slices.length - 1) return null;
	const current = slices[index].end;
	const lowerBound = slices[index].start + MIN_PAGE_PX;
	const upperBound = slices[index + 1].end - MIN_PAGE_PX;
	if (upperBound <= lowerBound) return null;

	let best: number | null = null;
	for (const box of candidates) {
		const y = box.top;
		if (y <= lowerBound || y >= upperBound) continue;
		if (direction === "up") {
			if (y < current - 1 && (best === null || y > best)) best = y;
		} else if (y > current + 1 && (best === null || y < best)) {
			best = y;
		}
	}
	return best;
}

/**
 * 把标题映射到它所在的页码（1 基），生成 PDF 书签。
 * 标题位置按源图坐标记录，这里换算成页号。
 */
export function buildOutline(blocks: BlockIndex, slices: PageSlice[]): PdfOutlineEntry[] {
	const entries: PdfOutlineEntry[] = [];
	let page = 0;
	for (const heading of blocks.headings) {
		while (page < slices.length - 1 && heading.top >= slices[page].end) {
			page += 1;
		}
		// 正文里的 H1 常常和内联标题同名，避免出现两条一模一样的书签
		const prev = entries[entries.length - 1];
		if (prev && prev.level === heading.level && prev.title === heading.text) continue;
		entries.push({ level: heading.level, title: heading.text, page: page + 1 });
	}
	return entries;
}

/** 末页只剩一点点内容时，把最后一页与前一页重新对半分 */
function rebalanceTail(
	slices: PageSlice[],
	input: PaginateInput,
	capacity: number,
	minFill: number
): void {
	if (slices.length < 2) return;
	const last = slices[slices.length - 1];
	const prev = slices[slices.length - 2];
	const lastHeight = last.end - last.start;
	if (lastHeight >= capacity * 0.4) return;

	const spanStart = prev.start;
	const spanEnd = last.end;
	if (spanEnd - spanStart <= capacity * 1.1) return;

	const target = spanEnd - capacity * 0.55;
	const minY = Math.max(spanStart + capacity * minFill, spanEnd - capacity);
	const limit = Math.min(spanEnd - capacity * 0.2, spanStart + capacity);
	if (target < minY || limit <= minY + 1) return;

	const cut = pickBreak(input.candidates, minY, limit, target);
	if (cut === null || cut <= spanStart || cut >= spanEnd) return;
	prev.end = cut;
	last.start = cut;
}