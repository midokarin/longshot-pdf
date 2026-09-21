/**
 * 截图性能基准：定位「内容越长、截长图越慢」的根因。
 *
 * 假设：modern-screenshot 的每次 domToCanvas 都会克隆整棵 DOM 并对每个元素
 * 调 getComputedStyle（元素本身 + ::before + ::after），还会遍历所有样式表内联字体。
 * 因此单次调用的开销 ≈ O(文档规模)，与裁剪高度无关；
 * 分块截图做 N 次 → 总开销 ≈ N × O(文档规模)，也就是 O(内容长度²)。
 */
import { domToCanvas, type Options as ScreenshotOptions } from "modern-screenshot";
import { captureViewport, pruneOutsideBlocks } from "../src/capture";
import { delay, nextFrame } from "../src/utils";

/** 灌一份「Obsidian 体积」的样式表，模拟真实 vault 里 app.css + 主题 + 各插件 CSS 的规模 */
function injectBigStylesheet(ruleCount: number): void {
	const style = document.createElement("style");
	const chunks: string[] = [];
	for (let i = 0; i < ruleCount; i++) {
		chunks.push(`.ls-fake-${i} .ls-fake-inner-${i} > span { color: #0${i % 10}${(i + 3) % 10}${(i + 7) % 10}; padding: ${i % 7}px; }`);
	}
	style.textContent = chunks.join("\n");
	document.head.appendChild(style);
}

const logEl = document.getElementById("log") as HTMLElement;
const lines: string[] = [];

function log(message: string): void {
	lines.push(message);
	logEl.textContent = lines.join("\n");
}

function paragraph(seed: number): string {
	return `这是第 ${seed} 段示例文本，用来验证分页时不会把段落拦腰截断。中文排版需要关注行高、字距与标点挤压，` +
		`长截图方案的优势在于它完全保留阅读视图的渲染结果：公式、代码高亮、表格样式、主题配色都能原样保留。`;
}

function buildSection(index: number): HTMLElement {
	const wrapper = document.createElement("div");
	const h2 = document.createElement("h2");
	h2.textContent = `第 ${index} 节 · 渲染与分页验证`;
	wrapper.appendChild(h2);
	const h3 = document.createElement("h3");
	h3.textContent = `${index}.1 小节标题`;
	wrapper.appendChild(h3);
	for (let p = 1; p <= 3; p++) {
		const para = document.createElement("p");
		para.textContent = paragraph(index * 10 + p);
		wrapper.appendChild(para);
	}
	const list = document.createElement("ul");
	for (let li = 1; li <= 5; li++) {
		const item = document.createElement("li");
		item.textContent = `列表项 ${index}-${li}：验证列表整体不被拆开，或至少在列表项之间断开。`;
		list.appendChild(item);
	}
	wrapper.appendChild(list);
	const pre = document.createElement("pre");
	const code = document.createElement("code");
	code.textContent = Array.from({ length: 12 }, (_, i) => `  line_${i}: renderPage(source, slice, spec),`).join("\n");
	pre.appendChild(code);
	wrapper.appendChild(pre);
	return wrapper;
}

function options(width: number, height: number, extra: Partial<ScreenshotOptions> = {}): ScreenshotOptions {
	return {
		scale: 1,
		width: Math.round(width),
		height: Math.round(height),
		backgroundColor: "#ffffff",
		timeout: 30000,
		fetch: { bypassingCache: true },
		features: { removeAbnormalAttributes: true, removeControlCharacter: true },
		...extra,
	};
}

async function time(label: string, fn: () => Promise<unknown>): Promise<number> {
	const started = performance.now();
	await fn();
	const ms = Math.round(performance.now() - started);
	log(`  ${label}：${ms} ms`);
	return ms;
}

interface Doc {
	root: HTMLElement;
	stage: HTMLElement;
	content: HTMLElement;
	sizer: HTMLElement;
	heightCss: number;
	elements: number;
}

function buildDoc(sections: number, contentWidth: number): Doc {
	const root = document.createElement("div");
	root.className = "longshot-offscreen";
	const stage = document.createElement("div");
	stage.className = "longshot-stage";
	stage.style.setProperty("--longshot-width", `${contentWidth}px`);
	const content = document.createElement("div");
	content.className = "markdown-preview-view markdown-rendered theme-light";
	const sizer = document.createElement("div");
	sizer.className = "markdown-preview-sizer markdown-preview-section";
	content.appendChild(sizer);
	stage.appendChild(content);
	root.appendChild(stage);
	document.body.appendChild(root);

	for (let i = 1; i <= sections; i++) sizer.appendChild(buildSection(i));
	stage.style.height = "2000px";
	const heightCss = Math.ceil(sizer.scrollHeight);
	return { root, stage, content, sizer, heightCss, elements: sizer.querySelectorAll("*").length };
}

/** 把完全落在 [fromCss, toCss] 之外的一级子块掏空，只留一个等高的空盒子 */
function pruneOutside(sizer: HTMLElement, fromCss: number, toCss: number): () => void {
	const stashed: { el: HTMLElement; nodes: Node[]; height: string; overflow: string }[] = [];
	const sizerTop = sizer.getBoundingClientRect().top;
	for (const child of Array.from(sizer.children)) {
		if (!(child instanceof HTMLElement)) continue;
		const top = child.getBoundingClientRect().top - sizerTop;
		const bottom = top + child.offsetHeight;
		if (bottom <= fromCss || top >= toCss) {
			stashed.push({
				el: child,
				nodes: Array.from(child.childNodes),
				height: child.style.height,
				overflow: child.style.overflow,
			});
			child.replaceChildren();
			child.style.height = `${child.offsetHeight}px`;
			child.style.overflow = "hidden";
		}
	}
	return () => {
		for (const item of stashed) {
			item.el.replaceChildren(...item.nodes);
			item.el.style.height = item.height;
			item.el.style.overflow = item.overflow;
		}
	};
}

/** 记录容器内每个一级块的上下边界（相对容器） */
function geometryOf(container: HTMLElement): { top: number; bottom: number }[] {
	const containerTop = container.getBoundingClientRect().top;
	return Array.from(container.children).map((child) => {
		const rect = child.getBoundingClientRect();
		return { top: rect.top - containerTop, bottom: rect.bottom - containerTop };
	});
}

/** 掏空前后逐块比较几何，指出第一处发生位移的块 */
function geometryDiff(container: HTMLElement, fromCss: number, toCss: number, tolerance = 0.5): string {
	const before = geometryOf(container);
	const restore = pruneOutsideBlocks(container, fromCss, toCss);
	const after = geometryOf(container);
	const heightBefore = container.scrollHeight;
	const heightAfter = container.scrollHeight;
	restore();

	const problems: string[] = [];
	let worst = 0;
	for (let i = 0; i < before.length; i++) {
		const dt = after[i].top - before[i].top;
		const db = after[i].bottom - before[i].bottom;
		worst = Math.max(worst, Math.abs(dt), Math.abs(db));
		if (Math.abs(dt) > tolerance || Math.abs(db) > tolerance) {
			problems.push(`#${i} top ${before[i].top.toFixed(2)}→${after[i].top.toFixed(2)}（${dt > 0 ? "+" : ""}${dt.toFixed(2)}）`);
			if (problems.length >= 3) break;
		}
	}
	const heightNote = `容器高度 ${heightBefore} → ${heightAfter}，最大偏差 ${worst.toFixed(3)}px`;
	if (problems.length === 0) {
		return `几何一致（${heightNote}）✅`;
	}
	return `${problems.join("；")}（${heightNote}）❌`;
}

function canvasSignature(canvas: HTMLCanvasElement): string {
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return "(无上下文)";
	const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
	let hash = 2166136261;
	for (let i = 0; i < data.length; i += 7) {
		hash ^= data[i];
		hash = Math.imul(hash, 16777619);
	}
	return `${canvas.width}×${canvas.height} hash=${(hash >>> 0).toString(16)}`;
}

/** 逐行比较两张画布，返回差异概况（含差异行区间） */
function diffCanvases(a: HTMLCanvasElement, b: HTMLCanvasElement): string {
	if (a.width !== b.width || a.height !== b.height) {
		return `尺寸不同：${a.width}×${a.height} vs ${b.width}×${b.height}`;
	}
	const ctxA = a.getContext("2d", { willReadFrequently: true });
	const ctxB = b.getContext("2d", { willReadFrequently: true });
	if (!ctxA || !ctxB) return "(无上下文)";
	const dataA = ctxA.getImageData(0, 0, a.width, a.height).data;
	const dataB = ctxB.getImageData(0, 0, b.width, b.height).data;
	const ranges: string[] = [];
	let differing = 0;
	let rangeStart = -1;
	let rangeRows = 0;
	let rangePixels = 0;
	const flush = () => {
		if (rangeStart < 0) return;
		ranges.push(`${rangeStart}-${rangeStart + rangeRows - 1}（${rangePixels} 像素）`);
		rangeStart = -1;
		rangeRows = 0;
		rangePixels = 0;
	};
	for (let y = 0; y < a.height; y++) {
		let rowDiff = 0;
		const base = y * a.width * 4;
		for (let x = 0; x < a.width; x++) {
			const i = base + x * 4;
			if (
				Math.abs(dataA[i] - dataB[i]) > 2 ||
				Math.abs(dataA[i + 1] - dataB[i + 1]) > 2 ||
				Math.abs(dataA[i + 2] - dataB[i + 2]) > 2
			) {
				rowDiff += 1;
			}
		}
		if (rowDiff > 0) {
			differing += rowDiff;
			if (rangeStart < 0) rangeStart = y;
			rangeRows += 1;
			rangePixels += rowDiff;
		} else {
			flush();
		}
	}
	flush();
	if (differing === 0) return "完全一致";
	return `差异像素 ${differing}（占 ${((differing / (a.width * a.height)) * 100).toFixed(4)}%），差异行区间：${ranges.slice(0, 6).join("、")}${ranges.length > 6 ? ` 等 ${ranges.length} 段` : ""}`;
}

/** 同一份长文档换不同分块高度各截一次，比较耗时与像素一致性 */
async function sweepChunkHeights(
	sections: number,
	contentWidth: number,
	scale: number,
	heights: number[]
): Promise<void> {
	let reference: HTMLCanvasElement | null = null;
	for (const chunk of heights) {
		const doc = buildDoc(sections, contentWidth);
		const started = performance.now();
		const result = await captureViewport(doc.stage, doc.content, doc.heightCss, {
			scale,
			backgroundColor: "#ffffff",
			chunkHeightCss: chunk,
			blocks: doc.sizer,
		});
		const ms = Math.round(performance.now() - started);
		const diff = reference ? diffCanvases(reference, result.canvas) : "（基准）";
		log(
			`  分块 ${chunk} CSS px → ${Math.ceil(doc.heightCss / chunk)} 块，${ms} ms，像素：${diff}`
		);
		if (reference) {
			result.canvas.width = result.canvas.height = 0;
		} else {
			reference = result.canvas;
		}
		doc.root.remove();
	}
	if (reference) reference.width = reference.height = 0;
}

async function run(): Promise<void> {
	const contentWidth = 800;
	log("假设：单次 domToCanvas 的开销 ≈ O(文档规模)，与裁剪高度无关；分块 N 次即 N 倍开销。\n");

	injectBigStylesheet(20000);
	log(`已注入 20000 条模拟样式规则（模拟 Obsidian 的 app.css + 主题 + 插件 CSS）\n`);

	for (const sections of [8, 32]) {
		const doc = buildDoc(sections, contentWidth);
		const elements = doc.elements;
		log(
			`── 文档规模：${sections} 节，${doc.heightCss} CSS px，${elements} 个元素 ──`
		);

		// 同一份文档，只改裁剪高度：如果耗时基本不变，说明开销由文档规模决定
		await time("裁剪 2000px", () => domToCanvas(doc.stage, options(contentWidth, 2000)));
		await time("裁剪 8000px", () => domToCanvas(doc.stage, options(contentWidth, 8000)));
		await time(`裁剪 ${doc.heightCss}px（整篇）`, () =>
			domToCanvas(doc.stage, options(contentWidth, doc.heightCss))
		);
		await time("裁剪 2000px + font:false", () =>
			domToCanvas(doc.stage, options(contentWidth, 2000, { font: false }))
		);

		// 掏空视窗外的一级子块后再截同一高度
		const restore = pruneOutside(doc.sizer, 0, 2000);
		const prunedElements = doc.sizer.querySelectorAll("*").length;
		const prunedHeight = Math.ceil(doc.sizer.scrollHeight);
		await time(`裁剪 2000px + 掏空视窗外（剩 ${prunedElements} 元素）`, () =>
			domToCanvas(doc.stage, options(contentWidth, 2000))
		);
		log(`  掏空后内容高度：${prunedHeight} CSS px（原 ${doc.heightCss}）`);
		restore();

		// 像素一致性：掏空前后同一裁剪窗口的结果必须完全一致
		const before = await domToCanvas(doc.stage, options(contentWidth, 2000));
		const restore2 = pruneOutside(doc.sizer, 0, 2000);
		const after = await domToCanvas(doc.stage, options(contentWidth, 2000));
		restore2();
		log(
			`  像素一致性：${canvasSignature(before) === canvasSignature(after) ? "一致 ✅" : `不一致 ❌\n    ${canvasSignature(before)}\n    ${canvasSignature(after)}`}`
		);
		before.width = before.height = 0;
		after.width = after.height = 0;

		doc.root.remove();
	}

	// ── 真实链路：captureViewport 掏空优化前后的耗时与像素一致性 ──
	log("\n── 掏空后的几何是否与原来一致（相对容器位置）──");
	for (const [sections, from, to] of [
		[8, 2000, 4000],
		[8, 0, 2000],
		[32, 4000, 6000],
	] as const) {
		const doc = buildDoc(sections, contentWidth);
		log(`  ${sections} 节 · 窗口 [${from}, ${to})：${geometryDiff(doc.sizer, from, to, 0.01)}`);
		doc.root.remove();
	}
	// 逐块扫一遍 64 节文档的每个分块窗口，确认没有累积位移
	{
		const doc = buildDoc(64, contentWidth);
		const bad: string[] = [];
		for (let offset = 0; offset < doc.heightCss; offset += 2000) {
			const result = geometryDiff(doc.sizer, offset, offset + 2000, 0.01);
			if (result.includes("❌")) bad.push(`[${offset}, ${offset + 2000}) ${result}`);
		}
		log(`  64 节 · 全部分块窗口：${bad.length === 0 ? "全部一致 ✅" : `${bad.length} 个窗口有偏差 ❌`}`);
		for (const line of bad.slice(0, 3)) log(`    ${line}`);
		doc.root.remove();
	}

	// 48362 CSS px 的文档在 scale 1 下超出 canvas 单边上限，实际会被降级到 0.5，
	// 所以这里用 0.5 做 sweep，块高按「输出像素 = CSS × 0.5」换算。
	log("\n── 分块高度对耗时的影响（64 节 / 48362 CSS px / 实际 scale 0.5，已掏空）──");
	log("  （推测光栅化上限 16384 输出像素：12288 = 75%，16384 = 100%，18000 应已越界）");
	await sweepChunkHeights(64, contentWidth, 0.5, [2000, 24576, 32768, 36000]);

	log("\n── 真实链路 captureViewport（scale=1）──");
	log("  旧：固定 2000px 块高 + 不掏空；新：自动块高 + 掏空视窗外的块");
	const totals: { sections: number; heightCss: number; before: number; after: number }[] = [];
	for (const sections of [8, 16, 32, 64]) {
		const doc = buildDoc(sections, contentWidth);
		doc.stage.style.height = "2000px";

		const startedBefore = performance.now();
		let beforeChunks = 0;
		const before = await captureViewport(doc.stage, doc.content, doc.heightCss, {
			scale: 1,
			backgroundColor: "#ffffff",
			chunkHeightCss: 2000,
			onProgress: (_done, total) => (beforeChunks = total),
		});
		const msBefore = Math.round(performance.now() - startedBefore);

		const startedAfter = performance.now();
		let afterChunks = 0;
		const after = await captureViewport(doc.stage, doc.content, doc.heightCss, {
			scale: 1,
			backgroundColor: "#ffffff",
			blocks: doc.sizer,
			onProgress: (_done, total) => (afterChunks = total),
		});
		const msAfter = Math.round(performance.now() - startedAfter);

		const diff = diffCanvases(before.canvas, after.canvas);
		const identical = diff === "完全一致";
		totals.push({ sections, heightCss: doc.heightCss, before: msBefore, after: msAfter });
		log(
			`  ${sections} 节 / ${doc.heightCss} CSS px / 倍率 ${after.scale} → ` +
				`旧 ${msBefore} ms（${beforeChunks} 块），新 ${msAfter} ms（${afterChunks} 块）` +
				`（快 ${(msBefore / msAfter).toFixed(1)}×），像素${identical ? "一致 ✅" : "不一致 ❌"}`
		);
		if (!identical) log(`    差异详情：${diff}`);
		before.canvas.width = before.canvas.height = 0;
		after.canvas.width = after.canvas.height = 0;
		doc.root.remove();
	}

	const first = totals[0];
	const last = totals[totals.length - 1];
	const heightRatio = last.heightCss / first.heightCss;
	log(
		`\n  内容高度 ×${heightRatio.toFixed(2)}：掏空前耗时 ×${(last.before / first.before).toFixed(2)}` +
			`（线性 ×${heightRatio.toFixed(2)} / 平方 ×${(heightRatio * heightRatio).toFixed(2)}），` +
			`掏空后耗时 ×${(last.after / first.after).toFixed(2)}`
	);

	log("\n基准完成 ✅");
}

run().catch((error) => {
	log(`失败：${String(error)}\n${(error as Error)?.stack ?? ""}`);
	console.error(error);
});
