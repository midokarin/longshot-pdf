import { createBlankRowFinder } from "../src/blankrow";
import { collectBlocks } from "../src/blocks";
import { captureViewport } from "../src/capture";
import { buildPageSpec, computeGeometry, renderLongImage, renderPage, renderPageThumbnail, thumbnailPixelRatio } from "../src/compose";
import { createAvatarCropEditor } from "../src/crop";
import { buildLongPdf, buildPdf } from "../src/output";
import {
	boundariesOf,
	buildOutline,
	nudgeBoundary,
	paginate,
	slicesFromBoundaries,
} from "../src/paginate";
import { withPagebreakMarkers } from "../src/render";
import { PaginationPreviewModal } from "../src/preview";
import { ExportOptionsModal } from "../src/modal";
import { LongshotSettingTab } from "../src/settings-tab";
import { DEFAULT_SETTINGS, AUTHOR_TEMPLATES, applyAuthorStyle, anchorToOffset, resolvePaperSize, resolveQualityDpi, EXPORT_TYPE_LABELS, imageFormatOf, resolveExportMode, WATERMARK_ANCHOR_LABELS, WATERMARK_FONT_LABELS, type ExportFormat, type ExportType, type LongshotSettings, type WatermarkAnchor, type WatermarkFont } from "../src/settings";
import { mmToPx } from "../src/utils";
import {
	authorBandMm,	authorBlockSize,
	buildAuthorPreviewSpec,
	buildAuthorSpec,
	buildWatermarkSpec,
	drawAuthorBlock,
	drawAuthorPreview,
	drawAvatarInBox,
	drawWatermark,
	drawWatermarkPreview,
	embedHiddenWatermark,
	extractHiddenWatermark,
	hiddenWatermarkCapacity,
} from "../src/watermark";

const logEl = document.getElementById("log") as HTMLElement;
const pagesEl = document.getElementById("pages") as HTMLElement;
const lines: string[] = [];

function log(message: string): void {
	lines.push(message);
	logEl.textContent = lines.join("\n");
}

function paragraph(seed: number): string {
	return `这是第 ${seed} 段示例文本，用来验证分页时不会把段落拦腰截断。中文排版需要关注行高、字距与标点挤压，` +
		`长截图方案的优势在于它完全保留阅读视图的渲染结果：公式、代码高亮、表格样式、主题配色都能原样保留，` +
		`不像传统的 PDF 导出那样会丢失部分渲染效果。`;
}

function section(index: number, blocks: (parent: HTMLElement) => void): HTMLElement {
	const wrapper = document.createElement("div");
	const h2 = document.createElement("h2");
	h2.textContent = `第 ${index} 节 · 渲染与分页验证`;
	const h3 = document.createElement("h3");
	h3.textContent = `${index}.1 小节标题`;
	wrapper.appendChild(h2);
	wrapper.appendChild(h3);
	blocks(wrapper);
	return wrapper;
}

function imageBlock(width: number, height: number): HTMLImageElement {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
	const gradient = ctx.createLinearGradient(0, 0, width, height);
	gradient.addColorStop(0, "#4a8cf7");
	gradient.addColorStop(1, "#7b5cf0");
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = "rgba(255,255,255,0.85)";
	ctx.font = "28px -apple-system, sans-serif";
	ctx.fillText(`配图 ${width}×${height}`, 24, 48);
	for (let y = 90; y < height; y += 90) {
		ctx.fillStyle = "rgba(255,255,255,0.18)";
		ctx.fillRect(24, y, width - 48, 4);
	}
	const img = document.createElement("img");
	img.src = canvas.toDataURL("image/png");
	img.width = width;
	img.height = height;
	return img;
}

/** 构造一篇足够长、且包含各种块的假笔记 */
function buildSampleContent(sizer: HTMLElement): void {
	const title = document.createElement("h1");
	title.textContent = "AI 时代下的学习困境（验证用长文）";
	sizer.appendChild(title);

	for (let i = 1; i <= 3; i++) {
		sizer.appendChild(
			section(i, (parent) => {
				for (let p = 1; p <= 3; p++) {
					const para = document.createElement("p");
					para.textContent = paragraph(i * 10 + p);
					parent.appendChild(para);
				}
				const list = document.createElement("ul");
				for (let li = 1; li <= 5; li++) {
					const item = document.createElement("li");
					item.textContent = `列表项 ${i}-${li}：验证列表整体不被拆开，或至少在列表项之间断开。`;
					list.appendChild(item);
				}
				parent.appendChild(list);
			})
		);
	}

	// 长表格：用来验证表格行之间的断点
	const table = document.createElement("table");
	const thead = document.createElement("thead");
	const headRow = document.createElement("tr");
	["维度", "传统学习", "AI 辅助"].forEach((text) => {
		const th = document.createElement("th");
		th.textContent = text;
		headRow.appendChild(th);
	});
	thead.appendChild(headRow);
	table.appendChild(thead);
	const tbody = document.createElement("tbody");
	for (let r = 1; r <= 12; r++) {
		const row = document.createElement("tr");
		[`指标 ${r}`, "手工检索、线性阅读", "对话式追问、按需展开"].forEach((text) => {
			const td = document.createElement("td");
			td.textContent = text;
			row.appendChild(td);
		});
		tbody.appendChild(row);
	}
	table.appendChild(tbody);

	const tableSection = section(4, (parent) => {
		const para = document.createElement("p");
		para.textContent = paragraph(41);
		parent.appendChild(para);
		parent.appendChild(table);
	});
	sizer.appendChild(tableSection);

	// 引用块
	sizer.appendChild(
		section(5, (parent) => {
			const quote = document.createElement("blockquote");
			const q1 = document.createElement("p");
			q1.textContent = "长截图的保真度来自「所见即所得」：我们不重新渲染，而是直接复用阅读视图的像素。";
			const q2 = document.createElement("p");
			q2.textContent = "于是分页成了唯一的挑战：既要把内容填满纸张，又不能在段落、表格、代码中间切开。";
			quote.appendChild(q1);
			quote.appendChild(q2);
			parent.appendChild(quote);
			const para = document.createElement("p");
			para.textContent = paragraph(51);
			parent.appendChild(para);
			parent.appendChild(imageBlock(640, 900));
		})
	);

	// 超长代码块：超过一页高度，用来验证「空白行兜底 + 硬切」
	sizer.appendChild(
		section(6, (parent) => {
			const pre = document.createElement("pre");
			const code = document.createElement("code");
			const rows: string[] = [];
			for (let i = 1; i <= 70; i++) {
				rows.push(`  line_${String(i).padStart(3, "0")}: renderPage(source, slice, spec), // 验证超长代码块`);
			}
			code.textContent = rows.join("\n");
			pre.appendChild(code);
			parent.appendChild(pre);
		})
	);

	// 长列表：跨页时应在列表项之间断开
	sizer.appendChild(
		section(7, (parent) => {
			const list = document.createElement("ul");
			for (let li = 1; li <= 60; li++) {
				const item = document.createElement("li");
				item.textContent = `跨页长列表项 ${li}：这一项的内容长度大致固定，用于观察断点是否落在列表项之间。`;
				list.appendChild(item);
			}
			parent.appendChild(list);
		})
	);

	// 提示块 + 收尾段落
	sizer.appendChild(
		section(8, (parent) => {
			const callout = document.createElement("div");
			callout.className = "callout";
			const para = document.createElement("p");
			para.textContent = "提示：纸张样式、页边距、页码都可以在插件设置里调整，这份验证页使用的是 A4 / 上下左右 18mm / 页脚页码。";
			callout.appendChild(para);
			parent.appendChild(callout);
			for (let p = 1; p <= 6; p++) {
				const para2 = document.createElement("p");
				para2.textContent = paragraph(80 + p);
				parent.appendChild(para2);
			}
		})
	);
}

async function run(): Promise<void> {
	const settings: LongshotSettings = {
		...DEFAULT_SETTINGS,
		contentWidth: 800,
		captureScale: 3,
		paperColor: "#ffffff",
		paper: "a4",
		quality: "high",
		headerTemplate: "",
		footerTemplate: "{{page}} / {{pages}}",
	};

	// ── 导出「类型 × 格式」映射自检 ─────────────────────────
	const combos: { exportType: ExportType; exportFormat: ExportFormat }[] = [
		{ exportType: "paged", exportFormat: "pdf" },
		{ exportType: "paged", exportFormat: "jpeg" },
		{ exportType: "paged", exportFormat: "png" },
		{ exportType: "long", exportFormat: "pdf" },
		{ exportType: "long", exportFormat: "jpeg" },
		{ exportType: "long", exportFormat: "png" },
	];
	log(
		"导出组合自检：\n  " +
			combos
				.map((combo) => {
					const type = EXPORT_TYPE_LABELS[combo.exportType].split("（")[0];
					return `${type} + ${combo.exportFormat.toUpperCase()} → mode=${resolveExportMode(combo)}，图片编码=${imageFormatOf(combo)}`;
				})
				.join("\n  ")
	);

	const root = document.createElement("div");
	root.className = "longshot-offscreen";
	const stage = document.createElement("div");
	stage.className = "longshot-stage";
	stage.style.setProperty("--longshot-width", `${settings.contentWidth}px`);
	const content = document.createElement("div");
	content.className = "markdown-preview-view markdown-rendered theme-light";
	const sizer = document.createElement("div");
	sizer.className = "markdown-preview-sizer markdown-preview-section";
	// 与 renderPreviewOffscreen 保持一致：标题是 sizer 的第一个子元素
	content.classList.add("show-inline-title");
	const inlineTitle = document.createElement("div");
	inlineTitle.className = "inline-title";
	inlineTitle.textContent = "AI 时代下的学习困境（验证用长文）";
	sizer.appendChild(inlineTitle);
	content.appendChild(sizer);
	stage.appendChild(content);
	root.appendChild(stage);
	document.body.appendChild(root);

	buildSampleContent(sizer);
	await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

	const heightCss =
		Math.ceil(
			Math.max(
				stage.scrollHeight,
				content.scrollHeight,
				content.getBoundingClientRect().height,
				sizer.scrollHeight
			)
		) + 2;
	log(`内容高度（CSS px）：${heightCss}`);

	const started = performance.now();
	const capture = await captureViewport(stage, content, heightCss, {
		scale: settings.captureScale,
		backgroundColor: settings.paperColor,
		blocks: sizer,
		onProgress: (done, total, label) => log(`${label}（${done}/${total}）`),
	});
	log(
		`长截图：${capture.canvas.width} × ${capture.canvas.height} px，倍率 ${capture.scale}，耗时 ${Math.round(
			performance.now() - started
		)} ms`
	);

	const thumb = document.createElement("img");
	thumb.src = capture.canvas.toDataURL("image/jpeg", 0.6);
	thumb.style.cssText = "max-width:100%;border:1px solid #dfe2e6;margin-bottom:20px;background:#fff";
	pagesEl.parentElement?.insertBefore(thumb, pagesEl);

	const geometry = computeGeometry(settings, capture.canvas.width);
	log(
		`纸张 ${geometry.paperWidthMm}×${geometry.paperHeightMm}mm，页面 ${geometry.pageWidthPx}×${
			geometry.pageHeightPx
		}px，DPI ${geometry.dpi.toFixed(1)}，缩放 ${geometry.scale.toFixed(3)}，每页容量 ${Math.round(
			geometry.capacitySrcPx
		)} px`
	);

	const blocks = collectBlocks(sizer, stage, capture.scale);
	log(
		`断点候选：${blocks.candidates.length} 个，顶层块：${blocks.topLevel.length} 个，不可拆分块（图片等）：${blocks.atoms.length} 个`
	);

	const { slices, hardSplits } = paginate({
		totalHeight: capture.canvas.height,
		capacity: geometry.capacitySrcPx,
		candidates: blocks.candidates,
		topLevel: blocks.topLevel,
		atoms: blocks.atoms,
		minFillRatio: settings.minFillRatio,
		smartBreak: settings.smartBreak,
		avoidHeadingOrphan: settings.avoidHeadingOrphan,
		findBlankRow: createBlankRowFinder(capture.canvas),
	});
	log(`分页结果：${slices.length} 页，硬切 ${hardSplits} 处`);
	log(
		slices
			.map(
				(slice, i) =>
					`  第 ${i + 1} 页：源图 ${Math.round(slice.start)} → ${Math.round(slice.end)}（${
						slice.end - slice.start
					} px，填充率 ${Math.round(((slice.end - slice.start) / geometry.capacitySrcPx) * 100)}%）`
			)
			.join("\n")
	);

	const pages: HTMLCanvasElement[] = [];
	for (let i = 0; i < slices.length; i++) {
		const vars = {
			name: "harness",
			date: "2026-09-17",
			title: "harness",
			page: String(i + 1),
			pages: String(slices.length),
		};
		const page = renderPage(capture.canvas, slices[i], buildPageSpec(settings, geometry, vars));
		pages.push(page);
		const figure = document.createElement("figure");
		figure.className = "page-card";
		const img = document.createElement("img");
		img.src = page.toDataURL("image/jpeg", 0.7);
		const caption = document.createElement("figcaption");
		caption.textContent = `第 ${i + 1} / ${slices.length} 页`;
		figure.appendChild(img);
		figure.appendChild(caption);
		pagesEl.appendChild(figure);
	}

	const pdf = await buildPdf(pages, {
		paperWidthMm: geometry.paperWidthMm,
		paperHeightMm: geometry.paperHeightMm,
		format: "jpeg",
		jpegQuality: settings.jpegQuality,
	});
	const bytes = new Uint8Array(pdf);
	const text = new TextDecoder("latin1").decode(bytes);
	const pageObjects = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
	log(
		`PDF 生成：${(bytes.length / 1024 / 1024).toFixed(2)} MB，含 /Type/Page 对象 ${pageObjects} 个（期望 ${
			pages.length
		}）`
	);

	const header = String.fromCharCode(...bytes.slice(0, 8));
	log(`PDF 文件头：${header}`);

	// ── 验证「长截图 + PDF」组合：整篇一张不切分的超长页面 ──
	const longPdf = await buildLongPdf(capture.canvas, {
		dpi: resolveQualityDpi(settings.quality),
		format: "jpeg",
		jpegQuality: settings.jpegQuality,
	});
	const longBytes = new Uint8Array(longPdf);
	const longText = new TextDecoder("latin1").decode(longBytes);
	const mediaBox = /\/MediaBox\s*\[([^\]]+)\]/.exec(longText)?.[1] ?? "(未找到)";
	const longPages = (longText.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
	log(
		`长截图 PDF：${(longBytes.length / 1024 / 1024).toFixed(2)} MB，页面数 ${longPages}（期望 1），MediaBox [${mediaBox}] pt（上限 14400）`
	);


	// 页面必须严格贴合截图比例，短笔记也可能生成横向画布。
	for (const [width, height, dpi] of [[900, 240, 150], [240, 900, 150], [500, 500, 150], [22000, 20, 96], [20, 22000, 96]]) {
		const sample = document.createElement("canvas");
		sample.width = width;
		sample.height = height;
		const sampleCtx = sample.getContext("2d")!;
		sampleCtx.fillStyle = "#167b8a";
		sampleCtx.fillRect(0, 0, width, height);
		const pdf = await buildLongPdf(sample, { dpi, format: "png", jpegQuality: 0.9 });
		const text = new TextDecoder("latin1").decode(pdf);
		const box = /\/MediaBox\s*\[([^\]]+)\]/.exec(text)?.[1].trim().split(/\s+/).map(Number) ?? [];
		const effectiveDpi = Math.max(dpi, Math.max(width, height) / 200);
		const expectedW = width / effectiveDpi * 72;
		const expectedH = height / effectiveDpi * 72;
		const ok = box.length === 4 && Math.abs(box[2] - expectedW) < 0.01 && Math.abs(box[3] - expectedH) < 0.01 && Math.max(box[2], box[3]) <= 14400;
		log(`长截图 PDF 边界 ${width}×${height}：纸张与图片尺寸一致、无额外留白 ${ok ? "✅" : "❌"}`);
		sample.width = sample.height = 0;
	}

	// ── 自检：源图切点处相邻两行是否都有墨（说明切断了字形） ──
	const seamReports: string[] = [];
	for (let i = 0; i < slices.length - 1; i++) {
		const cut = Math.round(slices[i].end);
		const above = inkColumns(capture.canvas, cut - 1);
		const below = inkColumns(capture.canvas, cut);
		const glyphSplit = above.count > 4 && below.count > 4;
		const inAtom = blocks.atoms.find((a) => cut > a.top + 0.5 && cut < a.bottom - 0.5);
		const atBlockTop = blocks.candidates.some((box) => Math.abs(box.top - cut) < 2);
		const flag = [
			glyphSplit && !atBlockTop ? "⚠️ 疑似切断字形" : null,
			inAtom ? `⚠️ 切在 <${inAtom.tag}> 内部` : null,
		]
			.filter(Boolean)
			.join(" ");
		seamReports.push(
			`页 ${i + 1}→${i + 2}：切点 y=${cut}，上一行墨点 ${above.count}，本行墨点 ${below.count}，${
				atBlockTop ? "对齐块顶" : "非块顶"
			} → ${flag || "安全"}`
		);
	}
	log(`切边自检（源图坐标）：\n  ${seamReports.join("\n  ")}`);

	// ── 生成复核用对比图：每个换页边界 + 分块拼接位置 ──
	(window as unknown as Record<string, unknown>).__boundaryStrip = buildBoundaryStrip(
		pages,
		slices,
		geometry,
		capture.canvas,
		capture.scale
	);
	(window as unknown as Record<string, unknown>).__pagePreviews = [0, 1, 7].map((index) =>
		scaleCanvas(pages[index] ?? pages[0], 1000).toDataURL("image/png")
	);
	// 分页预览弹窗里的缩略图（按 240 CSS px 宽绘制，与弹窗里实际渲染的一致）
	(window as unknown as Record<string, unknown>).__thumbPreviews = [0, 1].map((index) =>
		renderPageThumbnail(
			capture.canvas,
			slices[index] ?? slices[0],
			buildPageSpec(settings, geometry, {
				name: "harness",
				date: "2026-09-18",
				title: "harness",
				page: String(index + 1),
				pages: String(slices.length),
			}),
			240
		).toDataURL("image/png")
	);
	// ── 新增能力自检 ────────────────────────────────────────
	const vars0 = { name: "harness", date: "2026-09-18", title: "harness" };

	// 1) /// 强制分页标记：正文里的替换、代码块里的不动
	const pbText = withPagebreakMarkers("第一段\n\n///\n\n第二段\n\n```\n///\n```\n\n///\n");
	log(
		`强制分页标记：替换 ${(pbText.match(/longshot-pagebreak/g) ?? []).length} 处（期望 2），` +
			`代码块内保留 ${pbText.includes("```\n///\n```") ? "✅" : "❌"}`
	);

	// 2) forcedBreaks：强制分页点必须成为某一页的页尾
	const forcedY = Math.round(capture.canvas.height * 0.55);
	const forced = paginate({
		totalHeight: capture.canvas.height,
		capacity: geometry.capacitySrcPx,
		candidates: blocks.candidates,
		topLevel: blocks.topLevel,
		minFillRatio: settings.minFillRatio,
		smartBreak: settings.smartBreak,
		avoidHeadingOrphan: settings.avoidHeadingOrphan,
		forcedBreaks: [forcedY],
	});
	const hit = forced.slices.some((slice) => Math.abs(slice.end - forcedY) < 0.5);
	log(
		`强制分页：指定 y=${forcedY} → ${forced.slices.length} 页，` +
			`断点${hit ? "命中 ✅" : "未命中 ❌"}`
	);

	// 3) 断点手动微调
	const nudgeDown = nudgeBoundary(slices, 0, "down", blocks.candidates);
	const nudgeUp = nudgeBoundary(slices, 0, "up", blocks.candidates);
	if (nudgeDown !== null) {
		const moved = boundariesOf(slices);
		moved[0] = nudgeDown;
		const adjusted = slicesFromBoundaries(moved, capture.canvas.height);
		log(
			`断点微调：第 1 页末尾 ${Math.round(slices[0].end)} → ${Math.round(nudgeDown)}（下移），` +
				`上移候选 ${nudgeUp === null ? "无" : Math.round(nudgeUp)}，页数 ${slices.length} → ${adjusted.length}，` +
				`末页收在 ${Math.round(adjusted[adjusted.length - 1].end)}（期望 ${capture.canvas.height}）`
		);
	} else {
		log("断点微调：❌ 没找到可下移的候选断点");
	}

	// 3b) 每一页的两个方向都必须能真实判断出可用性（第 1 页上移曾经被界面误禁用）
	const availability = slices.map((_, index) => {
		const up = nudgeBoundary(slices, index, "up", blocks.candidates);
		const down = nudgeBoundary(slices, index, "down", blocks.candidates);
		return `${index + 1}页${up === null ? "—" : "↑"}${down === null ? "—" : "↓"}`;
	});
	log(
		`断点可用方向：${availability.join(" ")}` +
			`（第 1 页上移 ${nudgeUp === null ? "❌ 无候选" : "✅ 有候选"}）`
	);

	// 3c) 预览缩略图：按「显示宽度 × devicePixelRatio」绘制，且保持页面宽高比
	const thumbSpec = buildPageSpec(settings, geometry, {
		name: "harness",
		date: "2026-09-18",
		title: "harness",
		page: "1",
		pages: String(slices.length),
	});
	const thumbProbe = renderPageThumbnail(capture.canvas, slices[0], thumbSpec, 240);
	const dpr = thumbnailPixelRatio();
	const expectedRatio = geometry.pageWidthPx / geometry.pageHeightPx;
	log(
		`预览缩略图：显示宽 ${thumbProbe.style.width}，画布 ${thumbProbe.width}×${thumbProbe.height} px` +
			`（期望宽 ${Math.round(240 * dpr)}），宽高比 ${(thumbProbe.width / thumbProbe.height).toFixed(4)}` +
			`（期望 ${expectedRatio.toFixed(4)}）`
	);
	thumbProbe.width = thumbProbe.height = 0;

	// 3d) 分页预览弹窗本体：第 1 页上移必须可用，缩略图按显示宽度 × dpr 绘制
	const previewModal = new PaginationPreviewModal(
		{} as never,
		{
			source: capture.canvas,
			spec: thumbSpec,
			autoSlices: slices,
			candidates: blocks.candidates,
			totalHeight: capture.canvas.height,
			capacity: geometry.capacitySrcPx,
		},
		() => {}
	);
	previewModal.modalEl.style.width = "640px";
	previewModal.open();
	{
		const cards = Array.from(
			previewModal.contentEl.querySelectorAll(".longshot-preview-card")
		);
		const buttonsOf = (card: Element) =>
			Array.from(card.querySelectorAll<HTMLButtonElement>(".longshot-preview-controls button"));
		const firstCard = cards[0];
		const firstUp = buttonsOf(firstCard)[0];
		const lastButtons = buttonsOf(cards[cards.length - 1]);

		const dprNow = thumbnailPixelRatio();
		const resolution = cards.map((card) => {
			const wrap = card.querySelector<HTMLElement>(".longshot-preview-thumb");
			const canvas = wrap?.querySelector("canvas");
			if (!wrap || !canvas) return "无画布 ❌";
			const style = getComputedStyle(wrap);
			const available =
				wrap.clientWidth -
				(parseFloat(style.paddingLeft) || 0) -
				(parseFloat(style.paddingRight) || 0);
			const expected = Math.round(available) * dprNow;
			return canvas.width === expected ? `${canvas.width}px ✅` : `${canvas.width}px（期望 ${expected}）❌`;
		});
		log(
			`分页预览弹窗：${cards.length} 张卡片，第 1 页上移 ${firstUp.disabled ? "禁用 ❌" : "可用 ✅"}，` +
				`末页按钮 ${lastButtons.every((b) => b.classList.contains("is-hidden")) ? "已隐藏 ✅" : "仍显示 ❌"}`
		);
		log(
			`  缩略图分辨率（显示宽 × dpr=${dprNow}）：${resolution.slice(0, 3).join("，")}` +
				`${resolution.length > 3 ? " …" : ""}`
		);

		// 点一下第 1 页的「断点上移」，填充率必须真的下降
		const labelOf = (card: Element) => card.querySelector(".longshot-preview-label")?.textContent ?? "";
		const beforeLabel = labelOf(firstCard);
		firstUp.click();
		const afterLabel = labelOf(firstCard);
		log(
			`  第 1 页断点上移：${beforeLabel} → ${afterLabel}` +
				`${beforeLabel !== afterLabel ? " ✅" : " ❌ 没有变化"}`
		);
	}
	previewModal.close();

	// 4) 隐水印 LSB 往返
	const lsb = document.createElement("canvas");
	lsb.width = 64;
	lsb.height = 64;
	const lsbCtx = lsb.getContext("2d") as CanvasRenderingContext2D;
	lsbCtx.fillStyle = "#ffffff";
	lsbCtx.fillRect(0, 0, 64, 64);
	const secret = "Longshot PDF · 隐水印往返 · 2026-09-18";
	const wrote = embedHiddenWatermark(lsb, secret);
	const readBack = extractHiddenWatermark(lsb);
	const clean = document.createElement("canvas");
	clean.width = 64;
	clean.height = 64;
	log(
		`隐水印往返：需要 ${hiddenWatermarkCapacity(secret)} bit / 可用 ${64 * 64} bit，写入 ${wrote}，` +
			`读回${readBack === secret ? "一致 ✅" : `不一致 ❌（${readBack}）`}；` +
			`空白画布读出 ${extractHiddenWatermark(clean) === null ? "null ✅" : "❌"}`
	);

	// 5) 可见水印 + 作者信息：确认真的画上了墨
	const wmSettings: LongshotSettings = {
		...settings,
		watermarkEnabled: true,
		watermarkText: "{{name}} · 内部资料",
		watermarkLayout: "tile",
		watermarkOpacity: 0.2,
		watermarkSizePt: 24,
		watermarkRotationDeg: -30,
	};
	const wmSpec = buildWatermarkSpec(wmSettings, geometry.dpi, vars0);
	const wmCanvas = document.createElement("canvas");
	wmCanvas.width = 600;
	wmCanvas.height = 400;
	const wmCtx = wmCanvas.getContext("2d") as CanvasRenderingContext2D;
	wmCtx.fillStyle = "#ffffff";
	wmCtx.fillRect(0, 0, 600, 400);
	if (wmSpec) drawWatermark(wmCtx, wmSpec, 600, 400);
	// 水印是半透明的，检测阈值要放低；整幅统计，避免恰好扫到两条水印之间的空行
	let wmInk = 0;
	for (let y = 0; y < wmCanvas.height; y += 10) wmInk += inkColumns(wmCanvas, y, 20).count;

	const auSettings: LongshotSettings = {
		...settings,
		authorEnabled: true,
		authorName: "张三",
		authorText: "{{date}} · 验证",
		authorAlign: "right",
		authorSizePt: 10,
		authorColor: "#333333",
	};
	const auSpec = buildAuthorSpec(auSettings, geometry.dpi, vars0);
	const bandPx = Math.round(mmToPx(authorBandMm(auSettings), geometry.dpi));
	const auCanvas = document.createElement("canvas");
	auCanvas.width = 1200;
	auCanvas.height = Math.max(40, bandPx);
	const auCtx = auCanvas.getContext("2d") as CanvasRenderingContext2D;
	auCtx.fillStyle = "#ffffff";
	auCtx.fillRect(0, 0, auCanvas.width, auCanvas.height);
	if (auSpec) drawAuthorBlock(auCtx, auSpec, 0, 0, auCanvas.width, auCanvas.height);
	let auInk = 0;
	for (let y = 0; y < auCanvas.height; y++) auInk += inkColumns(auCanvas, y).count;
	log(
		`水印 / 作者：水印文字「${wmSpec?.text ?? "(无)"}」整幅采样墨点 ${wmInk}（>0 即已绘制），` +
			`作者横带 ${bandPx} px，作者区域墨点合计 ${auInk}`
	);

	// 6) PDF 书签大纲
	const outline = buildOutline(blocks, slices);
	const outlinePdf = await buildPdf(pages, {
		paperWidthMm: geometry.paperWidthMm,
		paperHeightMm: geometry.paperHeightMm,
		format: "jpeg",
		jpegQuality: settings.jpegQuality,
		outline,
	});
	const outlineText = new TextDecoder("latin1").decode(new Uint8Array(outlinePdf));
	const outlineObjects = (outlineText.match(/\/Type\s*\/Outlines?/g) ?? []).length;
	log(
		`PDF 书签：${outline.length} 条（${outline
			.slice(0, 4)
			.map((entry) => `h${entry.level}「${entry.title}」→ p${entry.page}`)
			.join("，")}…），` +
			`PDF 含 /Outlines 对象 ${outlineObjects} 个（期望 ≥1），` +
			`${outlineText.includes("/PageMode /UseOutlines") ? "已设为默认展开 ✅" : "未设默认展开 ⚠️"}`
	);

	// 7) 长图装饰（水印 + 作者横带）
	const longDecorated = renderLongImage(capture.canvas, {
		watermark: wmSpec,
		author: auSpec,
		authorBandPx: bandPx,
		paperColor: "#ffffff",
	});
	log(
		`长图装饰：${capture.canvas.width}×${capture.canvas.height} → ${longDecorated.width}×${longDecorated.height} px` +
			`（无水印无作者时返回原图：${
				renderLongImage(capture.canvas, {
					watermark: null,
					author: null,
					authorBandPx: 0,
					paperColor: "#ffffff",
				}) === capture.canvas
					? "✅"
					: "❌"
			}）`
	);

	(window as unknown as Record<string, unknown>).__longPdf = bytesToBase64(longBytes);

	// 8) 水印：九宫格落点 / 字体 / 设置页预览
	{
		const anchors: WatermarkAnchor[] = [
			"top-left",
			"top-center",
			"top-right",
			"middle-left",
			"middle-center",
			"middle-right",
			"bottom-left",
			"bottom-center",
			"bottom-right",
		];
		const reports: string[] = [];
		let misplaced = 0;
		// 画布要明显大于水印本身，否则九个落点会被挤到一起、分不出象限
		const probeWidth = 1600;
		const probeHeight = 1200;
		for (const anchor of anchors) {
			const anchorSettings: LongshotSettings = {
				...settings,
				watermarkEnabled: true,
				watermarkText: "内部资料",
				watermarkImagePath: "",
				watermarkLayout: "center",
				watermarkAnchor: anchor,
				watermarkOpacity: 1,
				watermarkSizePt: 20,
				watermarkRotationDeg: 0,
				watermarkColor: "#000000",
			};
			const spec = buildWatermarkSpec(anchorSettings, geometry.dpi, vars0);
			const canvas = document.createElement("canvas");
			canvas.width = probeWidth;
			canvas.height = probeHeight;
			const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, probeWidth, probeHeight);
			if (spec) drawWatermark(ctx, spec, probeWidth, probeHeight);

			const box = inkBounds(canvas);
			const cx = (box.minX + box.maxX) / 2;
			const cy = (box.minY + box.maxY) / 2;
			const [vertical, horizontal] = anchor.split("-") as [string, string];
			const column = cx < probeWidth / 3 ? "左" : cx > (probeWidth * 2) / 3 ? "右" : "中";
			const row = cy < probeHeight / 3 ? "上" : cy > (probeHeight * 2) / 3 ? "下" : "中";
			const expectedColumn = horizontal === "left" ? "左" : horizontal === "right" ? "右" : "中";
			const expectedRow = vertical === "top" ? "上" : vertical === "bottom" ? "下" : "中";
			const inside =
				box.count > 0 &&
				box.minX >= 0 &&
				box.maxX < probeWidth &&
				box.minY >= 0 &&
				box.maxY < probeHeight;
			const ok = column === expectedColumn && row === expectedRow && inside;
			if (!ok) misplaced += 1;
			reports.push(
				`${WATERMARK_ANCHOR_LABELS[anchor]}→${row}${column}${ok ? "✅" : `❌（墨点 ${box.count}，x[${box.minX},${box.maxX}] y[${box.minY},${box.maxY}]）`}`
			);
		}
		log(
			`水印九宫格落点：9 个位置全部落在对应象限且不出血 ` +
				`${misplaced === 0 ? "✅" : `❌（${misplaced} 个错位）`}\n  ${reports.join("，")}`
		);

		// 字体：三种字体栈必须真的不同，且都能解析（不会全落到同一个 family）
		const fonts = (["sans", "serif", "mono"] as WatermarkFont[]).map((font) => {
			const fontSettings: LongshotSettings = {
				...settings,
				watermarkEnabled: true,
				watermarkText: "内部资料 ABC 123",
				watermarkImagePath: "",
				watermarkLayout: "center",
				watermarkFont: font,
				watermarkSizePt: 24,
				watermarkOpacity: 1,
				watermarkColor: "#000000",
			};
			const spec = buildWatermarkSpec(fontSettings, geometry.dpi, vars0);
			const probe = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
			probe.font = `400 24px ${spec?.font ?? "sans-serif"}`;
			return { label: WATERMARK_FONT_LABELS[font], width: Math.round(probe.measureText("内部资料 ABC 123").width) };
		});
		const distinct = new Set(fonts.map((f) => f.width)).size;
		log(
			`水印字体：${fonts.map((f) => `${f.label} ${f.width}px`).join("，")} → ` +
				`${distinct > 1 ? "宽度各不相同 ✅" : "⚠️ 三种字体渲染宽度一致（可能都没装）"}`
		);

		// 设置页预览：按纸张比例出图，且水印确实画在了预览里
		const previewSettings: LongshotSettings = {
			...settings,
			watermarkEnabled: true,
			watermarkText: "{{name}} · 内部资料",
			watermarkImagePath: "",
			watermarkLayout: "center",
			watermarkAnchor: "middle-center",
			watermarkFont: "serif",
			watermarkOpacity: 0.25,
			watermarkSizePt: 40,
			watermarkRotationDeg: -30,
			watermarkColor: "#000000",
		};
		const previewCanvas = document.createElement("canvas");
		drawWatermarkPreview(previewCanvas, buildWatermarkSpec(previewSettings, geometry.dpi, vars0), {
			widthCss: 240,
			paperWidthMm: geometry.paperWidthMm,
			paperHeightMm: geometry.paperHeightMm,
			paperColor: settings.paperColor,
			dpi: geometry.dpi,
		});
		const previewRatio = previewCanvas.width / previewCanvas.height;
		const paperRatio = geometry.paperWidthMm / geometry.paperHeightMm;
		log(
			`水印预览：画布 ${previewCanvas.width}×${previewCanvas.height} px，宽高比 ${previewRatio.toFixed(4)}` +
				`（纸张 ${paperRatio.toFixed(4)}）${Math.abs(previewRatio - paperRatio) < 0.01 ? " ✅" : " ❌"}，` +
				`墨点 ${inkBounds(previewCanvas).count}（>0 说明水印已画上）`
		);
		(window as unknown as Record<string, unknown>).__watermarkPreview = previewCanvas.toDataURL("image/png");

		// 图片水印按「纸张宽度占比」缩放：同一个 imageScale 下，纸越宽水印越宽
		const fakeImage = document.createElement("img");
		const imgCanvas = document.createElement("canvas");
		imgCanvas.width = 200;
		imgCanvas.height = 100;
		const imgCtx = imgCanvas.getContext("2d") as CanvasRenderingContext2D;
		imgCtx.fillStyle = "#c0392b";
		imgCtx.fillRect(0, 0, 200, 100);
		fakeImage.src = imgCanvas.toDataURL("image/png");
		await new Promise((resolve) => fakeImage.addEventListener("load", () => resolve(null), { once: true }));
		const imageSettings: LongshotSettings = {
			...settings,
			watermarkEnabled: true,
			watermarkText: "",
			watermarkImagePath: "assets/logo.png",
			watermarkLayout: "center",
			watermarkImageScale: 0.4,
			watermarkOpacity: 1,
			watermarkRotationDeg: 0,
		};
		const imageSpec = buildWatermarkSpec(imageSettings, geometry.dpi, vars0, fakeImage);
		const imageBoxes = [400, 800].map((width) => {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = width;
			const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, width, width);
			if (imageSpec) drawWatermark(ctx, imageSpec, width, width);
			const box = inkBounds(canvas);
			return { width, inkWidth: box.maxX - box.minX + 1 };
		});
		const ratioA = imageBoxes[0].inkWidth / imageBoxes[0].width;
		const ratioB = imageBoxes[1].inkWidth / imageBoxes[1].width;
		log(
			`图片水印：400px 纸上宽 ${imageBoxes[0].inkWidth}px（占 ${(ratioA * 100).toFixed(1)}%），` +
				`800px 纸上宽 ${imageBoxes[1].inkWidth}px（占 ${(ratioB * 100).toFixed(1)}%），` +
				`占比一致 ${Math.abs(ratioA - ratioB) < 0.02 ? "✅" : "❌"}（期望约 40%）`
		);
	}

	// 9) 设置页 / 快速设置面板：水印 UI 真的接上了设置
	{
		const fakeSettings: LongshotSettings = {
			...DEFAULT_SETTINGS,
			watermarkEnabled: false,
			watermarkImagePath: "",
			watermarkText: "{{name}}",
		};
		const fakePlugin = {
			settings: fakeSettings,
			defaults: DEFAULT_SETTINGS,
			manifest: { id: "longshot-pdf" },
			saveSettings: async () => {},
			chooseImageFile: async () => false,
			chooseOutputDir: async () => false,
		} as never;

		// ── 详细设置页 ──
		const tab = new LongshotSettingTab({} as never, fakePlugin);
		// 挂到文档上，否则 getComputedStyle 取不到分栏的真实排版
		document.body.appendChild(tab.containerEl);
		tab.display();
		const watermarkTab = Array.from(
			tab.containerEl.querySelectorAll<HTMLButtonElement>(".longshot-tab")
		).find((button) => button.textContent?.includes("水印"));
		watermarkTab?.click();
		const groupIds = Array.from(tab.containerEl.querySelectorAll(".longshot-group")).map(
			(el) => /longshot-group-([a-z]+)/.exec(el.className)?.[1] ?? "?"
		);
		log(
			`水印分栏：切到「水印」${watermarkTab ? "✅" : "❌"}，三个分组 ${groupIds.join(" / ")}` +
				`（期望 visible / author / hidden）${groupIds.join(",") === "visible,author,hidden" ? " ✅" : " ❌"}`
		);

		// 打开「可见水印」，左栏必须出现预览画布，右栏出现各设置项
		const visibleToggle = tab.containerEl.querySelector<HTMLInputElement>(
			".longshot-group-visible .longshot-group-toggle input"
		);
		if (visibleToggle) {
			visibleToggle.checked = true;
			visibleToggle.dispatchEvent(new Event("change"));
			await tick();
		}
		const previewCol = tab.containerEl.querySelector<HTMLElement>(".longshot-split-preview");
		const settingsCol = tab.containerEl.querySelector<HTMLElement>(".longshot-split-settings");
		const split = tab.containerEl.querySelector<HTMLElement>(".longshot-split");
		const splitRow = split ? getComputedStyle(split).flexDirection : "";
		const colOverflow = settingsCol ? getComputedStyle(settingsCol).overflowY : "";
		log(
			`水印栏左右分栏：左预览 ${previewCol ? "✅" : "❌"}，右设置 ${settingsCol ? "✅" : "❌"}，` +
				`横排 ${splitRow === "row" ? "✅" : `❌(${splitRow || "无"})`}，` +
				`左栏在 DOM 中先于右栏 ${previewCol && settingsCol && previewCol.compareDocumentPosition(settingsCol) & Node.DOCUMENT_POSITION_FOLLOWING ? "✅" : "❌"}，` +
				`右栏独立滚动条 overflow-y=${colOverflow}${colOverflow === "auto" ? " ✅" : " ❌"}`
		);

		const body = tab.containerEl.querySelector<HTMLElement>(".longshot-group-visible .longshot-group-body");
		const previewCanvas = previewCol?.querySelector<HTMLCanvasElement>(".longshot-preview-canvas") ?? null;
		const previewInBody = body?.querySelector(".longshot-preview-canvas") ?? null;
		const paper = resolvePaperSize(fakeSettings);
		const previewRatio = previewCanvas ? previewCanvas.width / previewCanvas.height : 0;
		const paperRatio = paper.widthMm / paper.heightMm;
		const layoutSelect = body ? selectByOption(body, "tile") : null;
		const fontSelect = body ? selectByOption(body, "serif") : null;
		const fontOptionCount = fontSelect?.options.length ?? 0;
		const expectedFonts = Object.keys(WATERMARK_FONT_LABELS).length;
		const positionSelect = body ? selectByOption(body, "top-left") : null;
		const sliderCount = body?.querySelectorAll('input[type="range"]').length ?? 0;
		log(
			`可见水印展开：设置已开启 ${fakeSettings.watermarkEnabled ? "✅" : "❌"}，` +
				`预览画布 ${previewCanvas ? `${previewCanvas.width}×${previewCanvas.height}（比例 ${previewRatio.toFixed(3)} / 纸张 ${paperRatio.toFixed(3)}）${Math.abs(previewRatio - paperRatio) < 0.01 ? "✅" : "❌"}` : "缺失 ❌"}，` +
				`预览已移出设置区 ${previewInBody ? "❌ 仍在组内" : "✅"}，` +
				`排布选项 ${layoutSelect?.options.length ?? 0}（期望 2），字体选项 ${fontOptionCount}（期望 ${expectedFonts}）${fontOptionCount === expectedFonts ? " ✅" : " ❌"}，` +
				`滑块 ${sliderCount} 个，平铺时「位置」${positionSelect ? "不应出现 ❌" : "已隐藏 ✅"}`
		);
		const imageRow = body ? settingByName(body, "水印图片") : null;
		const imageButton = imageRow?.querySelector<HTMLButtonElement>('button[data-icon], button');
		log(
			`水印图片行：存在 ${imageRow ? "✅" : "❌"}，` +
				`「选择图片…」按钮 ${imageButton?.textContent?.includes("选择图片") ? "✅" : "❌"}，` +
				`清除按钮 ${Array.from(imageRow?.querySelectorAll("button") ?? []).some((b) => b.getAttribute("data-icon") === "rotate-ccw") ? "✅" : "❌"}`
		);

		// 切到「单个」后必须出现九宫格位置选择
		if (layoutSelect) {
			layoutSelect.value = "center";
			layoutSelect.dispatchEvent(new Event("change"));
			await tick();
		}
		const body2 = tab.containerEl.querySelector<HTMLElement>(".longshot-group-visible .longshot-group-body");
		const positionSelect2 = body2 ? selectByOption(body2, "top-left") : null;
		log(
			`排布切「单个」：位置选项 ${positionSelect2?.options.length ?? 0} 个（期望 9）` +
				`${positionSelect2?.options.length === 9 ? " ✅" : " ❌"}，` +
				`当前值 ${positionSelect2?.value ?? "(无)"}`
		);

		// 改位置后预览必须重画（像素发生变化）
		const canvasOf = (): HTMLCanvasElement | null =>
			tab.containerEl.querySelector<HTMLCanvasElement>(".longshot-preview-canvas");
		const beforeShot = canvasOf()?.toDataURL("image/png") ?? "";
		if (positionSelect2) {
			positionSelect2.value = "top-left";
			positionSelect2.dispatchEvent(new Event("change"));
			await tick();
		}
		const afterShot = canvasOf()?.toDataURL("image/png") ?? "";
		log(
			`预览联动：改「位置」后预览${beforeShot && afterShot && beforeShot !== afterShot ? "已重画 ✅" : "没有变化 ❌"}`
		);

		// ── 快速设置面板：三类水印各自一个开关 ──
		// 从「关」开始，才能看出开关与说明文字的联动
		fakeSettings.watermarkEnabled = false;
		fakeSettings.authorEnabled = false;
		fakeSettings.hiddenWatermarkEnabled = false;
		const fakeApp = { workspace: { getActiveFile: () => null } } as never;
		const modal = new ExportOptionsModal(fakeApp, fakePlugin);
		modal.open();
		const visibleRow = settingByName(modal.contentEl, "可见水印");
		const authorRow = settingByName(modal.contentEl, "作者信息");
		const hiddenRow = settingByName(modal.contentEl, "隐水印");
		const headingRow = settingByName(modal.contentEl, "加入水印");
		const toggleOf = (row: HTMLElement | null): HTMLInputElement | null =>
			row?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
		const modalVisibleToggle = toggleOf(visibleRow);
		const modalAuthorToggle = toggleOf(authorRow);
		const modalHiddenToggle = toggleOf(hiddenRow);
		const descBefore = visibleRow?.querySelector(".setting-item-description")?.textContent ?? "";
		if (modalVisibleToggle) {
			modalVisibleToggle.checked = true;
			modalVisibleToggle.dispatchEvent(new Event("change"));
			await tick();
		}
		if (modalAuthorToggle) {
			modalAuthorToggle.checked = true;
			modalAuthorToggle.dispatchEvent(new Event("change"));
			await tick();
		}
		const descAfter = settingByName(modal.contentEl, "可见水印")
			?.querySelector(".setting-item-description")?.textContent ?? "";
		const authorDesc = settingByName(modal.contentEl, "作者信息")
			?.querySelector(".setting-item-description")?.textContent ?? "";
		log(
			`快速设置面板：水印标题 ${headingRow ? "✅" : "❌"}，三个开关 可见/作者/隐 ${modalVisibleToggle ? "✅" : "❌"}/${modalAuthorToggle ? "✅" : "❌"}/${modalHiddenToggle ? "✅" : "❌"}，` +
				`勾选写回设置 可见=${fakeSettings.watermarkEnabled} 作者=${fakeSettings.authorEnabled} 隐=${fakeSettings.hiddenWatermarkEnabled}` +
				`${fakeSettings.watermarkEnabled && fakeSettings.authorEnabled && !fakeSettings.hiddenWatermarkEnabled ? " ✅" : " ❌"}`
		);
		log(
			`快速设置说明联动：「${descBefore}」→「${descAfter}」${descAfter.includes("已开启") ? " ✅" : " ❌"}；` +
				`作者行「${authorDesc}」${authorDesc.includes("已开启") ? " ✅" : " ❌"}`
		);

		// 换成「长截图」类型，纸张设置会隐藏，但水印开关必须还在
		const typeSelect = selectByOption(modal.contentEl, "long");
		if (typeSelect) {
			typeSelect.value = "long";
			typeSelect.dispatchEvent(new Event("change"));
			await tick();
		}
		const rowAfterType = settingByName(modal.contentEl, "可见水印");
		const paperRow = settingByName(modal.contentEl, "纸张尺寸");
		log(
			`切「长截图」：水印开关${rowAfterType?.closest(".is-hidden") ? "被误隐藏 ❌" : "仍可见 ✅"}，` +
				`纸张设置${paperRow?.closest(".is-hidden") ? "已隐藏 ✅" : "仍显示 ❌"}`
		);
		modal.close();
	}

	// 10) 作者信息：预览 + 样式模板
	{
		const fakeSettings: LongshotSettings = {
			...DEFAULT_SETTINGS,
			authorEnabled: true,
			authorName: "",
			authorText: "",
			authorAvatarPath: "",
			authorTemplates: [],
		};
		const fakePlugin = {
			settings: fakeSettings,
			defaults: DEFAULT_SETTINGS,
			manifest: { id: "longshot-pdf" },
			saveSettings: async () => {},
			chooseImageFile: async () => false,
			chooseOutputDir: async () => false,
		} as never;

		// ── 预览画布：上整页 + 下放大细节 ──
		const paper = resolvePaperSize(fakeSettings);
		const dpi = resolveQualityDpi(fakeSettings.quality);
		const bandMm = Math.max(6, authorBandMm(fakeSettings));
		const canvas = document.createElement("canvas");
		const previewSpec = buildAuthorPreviewSpec(fakeSettings, dpi, {
			name: "示例笔记",
			title: "示例笔记",
			date: "2026-01-01",
			author: "张三",
		});
		drawAuthorPreview(canvas, previewSpec, {
			widthCss: 240,
			paperWidthMm: paper.widthMm,
			paperHeightMm: paper.heightMm,
			paperColor: fakeSettings.paperColor,
			dpi,
			bandMm,
		});
		const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
		const pageHeightDev = Math.round((canvas.width * paper.heightMm) / paper.widthMm);
		const pageRatio = canvas.width / pageHeightDev;
		const paperRatio = paper.widthMm / paper.heightMm;
		// 放大细节必须真的画上了东西：只看下半部分
		const detailCtx = canvas.getContext("2d") as CanvasRenderingContext2D;
		const detailTop = pageHeightDev + Math.round(58 * 0.3 * dpr);
		const detailData = detailCtx.getImageData(0, detailTop, canvas.width, canvas.height - detailTop);
		let detailInk = 0;
		for (let i = 0; i < detailData.data.length; i += 4) {
			if (detailData.data[i] < 200 || detailData.data[i + 1] < 200 || detailData.data[i + 2] < 200) {
				detailInk += 1;
			}
		}
		log(
			`作者信息预览：画布 ${canvas.width}×${canvas.height} px，整页部分宽高比 ${pageRatio.toFixed(4)}` +
				`（纸张 ${paperRatio.toFixed(4)}）${Math.abs(pageRatio - paperRatio) < 0.01 ? " ✅" : " ❌"}，` +
				`放大细节墨点 ${detailInk}${detailInk > 0 ? " ✅" : " ❌"}`
		);

		// ── 内置预设 ──
		const names = AUTHOR_TEMPLATES.map((t) => t.name).join(" / ");
		const allBuiltin = AUTHOR_TEMPLATES.every((t) => t.builtin === true);
		const styleSignature = (template: (typeof AUTHOR_TEMPLATES)[number]): string =>
			[
				template.style.font,
				template.style.sizePt,
				template.style.color,
				template.style.align,
				template.style.avatarSizeMm,
				template.style.avatarShape,
				template.style.decor,
				template.style.accentColor,
				template.style.nameWeight,
			].join("|");
		const distinct = new Set(AUTHOR_TEMPLATES.map(styleSignature)).size;
		const decorCount = new Set(AUTHOR_TEMPLATES.map((t) => t.style.design)).size;
		log(
			`作者样式预设：${AUTHOR_TEMPLATES.length} 套（${names}）` +
				`${AUTHOR_TEMPLATES.length >= 6 && allBuiltin ? " ✅" : " ❌"}，样式互不相同 ${distinct}/${AUTHOR_TEMPLATES.length}` +
				`${distinct === AUTHOR_TEMPLATES.length ? " ✅" : " ❌"}，用到 ${decorCount} 种独立版式` +
				`${decorCount === 10 ? " ✅" : " ❌"}`
		);

		// ── 设置页：模板画廊 / 头像取景 / 保存 / 覆盖 / 删除 ──
		const tab = new LongshotSettingTab({} as never, fakePlugin);
		tab.display();
		Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>(".longshot-tab"))
			.find((button) => button.textContent?.includes("水印"))
			?.click();

		const authorBody = tab.containerEl.querySelector<HTMLElement>(".longshot-group-author .longshot-group-body");
		const authorPreviewCol = tab.containerEl.querySelector<HTMLElement>(".longshot-split-preview");
		const authorCanvas =
			authorPreviewCol?.querySelectorAll<HTMLCanvasElement>(".longshot-preview-canvas")[1] ?? null;
		const galleryCards = Array.from(
			authorBody?.querySelectorAll<HTMLElement>(".longshot-template-card") ?? []
		);
		const galleryThumbs = galleryCards.map((card) =>
			card.querySelector<HTMLCanvasElement>(".longshot-template-thumb")
		);
		/** 缩略图是不是真的画上了东西：透明底，只要有非透明像素就算画过 */
		const thumbInk = (canvas: HTMLCanvasElement | null): number => {
			const ctx = canvas?.getContext("2d");
			if (!canvas || !ctx) return 0;
			const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
			let ink = 0;
			for (let i = 3; i < data.length; i += 4) {
				if (data[i] > 8) ink += 1;
			}
			return ink;
		};
		const paintedThumbs = galleryThumbs.filter((canvas) => thumbInk(canvas) > 0).length;
		const thumbsHavePadding = galleryThumbs.every(canvas => {
			if (!canvas) return false;
			const ctx = canvas.getContext("2d")!;
			return [0, canvas.width - 2].every(x => {
				const pixels = ctx.getImageData(x, 0, 2, canvas.height).data;
				return pixels.every((value, index) => index % 4 !== 3 || value === 0);
			});
		});
		log(`全部模板小样两侧留白完整 ${thumbsHavePadding ? "✅" : "❌"}`);
		const expectedCards = AUTHOR_TEMPLATES.length + fakeSettings.authorTemplates.length;
		const fitRow = authorBody ? settingByName(authorBody, "头像呈现范围") : null;
		const fitSelect = fitRow?.querySelector<HTMLSelectElement>("select") ?? null;
		const cropArea = authorBody?.querySelector<HTMLElement>(".longshot-crop") ?? null;
		const cropCanvas = cropArea?.querySelector<HTMLCanvasElement>(".longshot-crop-canvas") ?? null;
		const quickSelect = cropArea ? selectByOption(cropArea, "middle-center") : null;
		const zoomRange = cropArea?.querySelector<HTMLInputElement>('input[type="range"]') ?? null;
		log(
			`作者信息展开：左栏预览画布 ${authorCanvas ? `${authorCanvas.width}×${authorCanvas.height} ✅` : "缺失 ❌"}，` +
				`模板画廊 ${galleryCards.length} 张（期望 ${expectedCards}）${galleryCards.length === expectedCards ? " ✅" : " ❌"}，` +
				`小样已绘制 ${paintedThumbs}/${galleryThumbs.length}${paintedThumbs === galleryThumbs.length && paintedThumbs > 0 ? " ✅" : " ❌"}`
		);
		log(
			`头像呈现范围：下拉 ${fitSelect ? `${fitSelect.options.length} 项 ✅` : "缺失 ❌"}，` +
				`当前值 ${fitSelect?.value ?? "(无)"}（期望 cover），` +
				`头像取景区 ${cropArea ? "✅" : "缺失 ❌"}，画布 ${cropCanvas ? `${cropCanvas.width}×${cropCanvas.height} ✅` : "缺失 ❌"}，` +
				`快速定位已移除 ${!quickSelect ? "✅" : "❌"}，` +
				`取景缩放滑块 ${zoomRange ? "✅" : "缺失 ❌"}`
		);
		// 切成「完整显示」后，取景区应当变成一句提示（裁剪只在「裁剪填满」时生效）
		if (fitSelect) {
			fitSelect.value = "contain";
			fitSelect.dispatchEvent(new Event("change"));
			await tick();
		}
		const cropCanvasAfter = tab.containerEl.querySelector<HTMLCanvasElement>(".longshot-crop-canvas");
		const cropNoteAfter = tab.containerEl.querySelector<HTMLElement>(".longshot-crop-desc")?.textContent ?? "";
		log(
			`切「完整显示」：取景画布${cropCanvasAfter ? "仍显示 ❌" : "已收起 ✅"}，` +
				`提示「${cropNoteAfter.slice(0, 18)}…」${cropNoteAfter.includes("不生效") ? "✅" : "❌"}，` +
				`设置写回 ${fakeSettings.authorAvatarFit === "contain" ? "✅" : "❌"}`
		);
		fakeSettings.authorAvatarFit = "cover";
		fakeSettings.authorAvatarShape = "circle";
		tab.display();
		Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>(".longshot-tab"))
			.find((button) => button.textContent?.includes("水印"))
			?.click();
		await tick();

		// 点「名片署名」那张卡片：样式写回设置，并且卡片被标成当前选中
		const cardTemplate = AUTHOR_TEMPLATES.find((t) => t.id === "card");
		const authorBody2 =
			tab.containerEl.querySelector<HTMLElement>(".longshot-group-author .longshot-group-body") ?? tab.containerEl;
		const cardEl = Array.from(
			authorBody2.querySelectorAll<HTMLElement>(".longshot-template-card")
		).find((el) => el.getAttribute("aria-label") === `套用模板：${cardTemplate?.name ?? ""}`);
		cardEl?.click();
		await tick();
		const applied =
			fakeSettings.authorAlign === cardTemplate?.style.align &&
			fakeSettings.authorSizePt === cardTemplate?.style.sizePt &&
			fakeSettings.authorFont === cardTemplate?.style.font &&
			fakeSettings.authorAvatarSizeMm === cardTemplate?.style.avatarSizeMm &&
			fakeSettings.authorColor === cardTemplate?.style.color &&
			fakeSettings.authorDecor === cardTemplate?.style.decor &&
			fakeSettings.authorAvatarShape === cardTemplate?.style.avatarShape &&
			fakeSettings.authorNameWeight === cardTemplate?.style.nameWeight;
		const bodyAfterApply =
			tab.containerEl.querySelector<HTMLElement>(".longshot-group-author .longshot-group-body") ?? tab.containerEl;
		const activeCard = bodyAfterApply.querySelector<HTMLElement>(".longshot-template-card.is-active");
		log(
			`点卡片套用「${cardTemplate?.name ?? ""}」：样式写回设置 ${applied ? "✅" : "❌"}` +
				`（对齐 ${fakeSettings.authorAlign}，字号 ${fakeSettings.authorSizePt}pt，头像 ${fakeSettings.authorAvatarSizeMm}mm，` +
				`形状 ${fakeSettings.authorAvatarShape}，装饰 ${fakeSettings.authorDecor}，字重 ${fakeSettings.authorNameWeight}），` +
				`选中高亮 ${activeCard?.getAttribute("aria-label") === `套用模板：${cardTemplate?.name ?? ""}` ? "✅" : "❌"}`
		);

		// 存成自定义模板
		const saveRow = settingByName(tab.containerEl, "保存为模板");
		const nameInput = saveRow?.querySelector<HTMLInputElement>("input");
		const saveButton = Array.from(saveRow?.querySelectorAll("button") ?? []).find((button) =>
			button.textContent?.includes("保存")
		);
		if (nameInput) nameInput.value = "我的署名";
		saveButton?.click();
		await tick();
		const saved = fakeSettings.authorTemplates[0];
		log(
			`保存为模板：模板数 ${fakeSettings.authorTemplates.length}（期望 1）` +
				`${fakeSettings.authorTemplates.length === 1 ? " ✅" : " ❌"}，` +
				`名称「${saved?.name ?? ""}」，样式随当前设置 ${saved?.style.align === fakeSettings.authorAlign ? "✅" : "❌"}`
		);

		// 同名再存一次 = 覆盖，不新增
		if (nameInput) nameInput.value = "我的署名";
		saveButton?.click();
		await tick();
		log(
			`同名保存：模板数仍为 ${fakeSettings.authorTemplates.length}（期望 1）` +
				`${fakeSettings.authorTemplates.length === 1 ? " ✅ 已覆盖" : " ❌ 重复新增"}`
		);

		// 自定义模板卡片可以删，内置预设卡片不提供删除按钮
		const galleryCardsNow = (): HTMLElement[] =>
			Array.from(tab.containerEl.querySelectorAll<HTMLElement>(".longshot-template-card"));
		const cardByLabel = (label: string): HTMLElement | null =>
			galleryCardsNow().find((el) => el.getAttribute("aria-label") === `套用模板：${label}`) ?? null;
		const builtinCard = cardByLabel(AUTHOR_TEMPLATES[0]?.name ?? "");
		const customCard = cardByLabel(saved?.name ?? "");
		const builtinRemove = builtinCard?.querySelector(".longshot-template-remove") ?? null;
		const customRemove = customCard?.querySelector<HTMLElement>(".longshot-template-remove") ?? null;
		customRemove?.click();
		await tick();
		const cardsAfterDelete = galleryCardsNow();
		const customTagLeft = cardsAfterDelete.some((el) => el.querySelector(".longshot-template-tag") !== null);
		log(
			`删除自定义模板：内置卡片删除按钮 ${builtinRemove ? "存在 ❌" : "不提供 ✅"}，` +
				`自定义卡片删除按钮 ${customRemove ? "✅" : "缺失 ❌"}，` +
				`删除后自定义剩 ${fakeSettings.authorTemplates.length} 个（期望 0）` +
				`${fakeSettings.authorTemplates.length === 0 ? " ✅" : " ❌"}，` +
				`画廊剩 ${cardsAfterDelete.length} 张（期望 ${AUTHOR_TEMPLATES.length}）` +
				`${cardsAfterDelete.length === AUTHOR_TEMPLATES.length && !customTagLeft ? " ✅" : " ❌"}`
		);

		// 重绘必须保留折叠区和真实滚动容器的位置。
		const host = document.createElement("div");
		host.style.cssText = "height: 500px; overflow: auto; width: 1000px";
		document.body.appendChild(host);
		host.appendChild(tab.containerEl);
		const folds = Array.from(tab.containerEl.querySelectorAll<HTMLDetailsElement>("details[data-fold]"));
		log(`复杂设置默认折叠 ${folds.length === 2 && folds.every(el => !el.open) ? "✅" : "❌"}`);
		for (const fold of folds) fold.querySelector("summary")?.click();
		const scroller = tab.containerEl.querySelector<HTMLElement>(".longshot-split-settings")!;
		scroller.scrollTop = 330;
		host.scrollTop = 90;
		const beforeScroll = scroller.scrollTop;
		const beforeHost = host.scrollTop;
		galleryCardsNow()[0]?.click();
		await tick();
		const afterScroll = tab.containerEl.querySelector<HTMLElement>(".longshot-split-settings")!.scrollTop;
		log(`套用模板保留滚动位置 ${beforeScroll} → ${afterScroll}、外层 ${beforeHost} → ${host.scrollTop} ${beforeScroll > 0 && afterScroll === beforeScroll && host.scrollTop === beforeHost ? "✅" : "❌"}`);
		log(`套用模板保留折叠状态 ${Array.from(tab.containerEl.querySelectorAll<HTMLDetailsElement>("details[data-fold]")).every(el => el.open) ? "✅" : "❌"}`);
		const fitAgain = settingByName(tab.containerEl, "头像呈现范围")?.querySelector("select");
		if (fitAgain) { fitAgain.value = "contain"; fitAgain.dispatchEvent(new Event("change")); }
		await tick();
		log(`切换头像选项保留滚动 ${tab.containerEl.querySelector<HTMLElement>(".longshot-split-settings")!.scrollTop === beforeScroll ? "✅" : "❌"}`);
		const galleryFold = tab.containerEl.querySelector<HTMLDetailsElement>('details[data-fold="templates"]')!;
		galleryFold.querySelector("summary")?.click();
		tab.display();
		log(`模板可收起且重绘后保持收起 ${!tab.containerEl.querySelector<HTMLDetailsElement>('details[data-fold="templates"]')!.open ? "✅" : "❌"}`);
		// 留下一个默认收起的设置页，供浏览器视觉复核。
		for (const fold of tab.containerEl.querySelectorAll<HTMLDetailsElement>("details[data-fold]")) fold.open = false;
		tab.containerEl.id = "watermark-settings-review";
		host.style.cssText = "width: min(1100px, 100%); margin: 24px auto";
		host.scrollTop = 0;
		(window as any).__watermarkTab = tab;

		// 2:1 的假图：只有左侧 30% 是黑块，用来看裁剪裁到了哪一段
		const wideCanvas = document.createElement("canvas");
		wideCanvas.width = 200;
		wideCanvas.height = 100;
		const wideCtx = wideCanvas.getContext("2d") as CanvasRenderingContext2D;
		wideCtx.fillStyle = "#ffffff";
		wideCtx.fillRect(0, 0, 200, 100);
		wideCtx.fillStyle = "#000000";
		wideCtx.fillRect(0, 0, 60, 100);
		const wideImage = new Image();
		wideImage.src = wideCanvas.toDataURL("image/png");
		await new Promise((resolve) => {
			wideImage.onload = () => resolve(null);
			wideImage.onerror = () => resolve(null);
		});

		// 每个新设计用真实署名带尺寸绘制：无头像 / 有头像 / 长内容均不越界。
		let designCases = 0;
		let designPass = 0;
		const designImages = new Set<string>();
		for (const template of AUTHOR_TEMPLATES) {
			for (const withAvatar of [false, true]) {
				for (const longText of [false, true]) {
					const settings = { ...DEFAULT_SETTINGS, authorEnabled: true, authorName: "林予安", authorText: longText ? "一段很长的中英文混排内容 · Building thoughtful things, one idea at a time." : "记录与分享", authorAvatarPath: withAvatar ? "sample.png" : "" };
					applyAuthorStyle(settings, template.style);
					const spec = buildAuthorSpec(settings, 96, {}, withAvatar ? wideImage : null)!;
					const band = Math.ceil(mmToPx(authorBandMm(settings), 96));
					const c = document.createElement("canvas"); c.width = 680; c.height = band + 20;
					const ctx = c.getContext("2d")!;
					drawAuthorBlock(ctx, spec, 10, 10, 660, band);
					const edge = ctx.getImageData(0, 0, 680, c.height).data;
					let ink = 0, escaped = 0;
					for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
						if (edge[(y * c.width + x) * 4 + 3] > 8) { ink++; if (x < 9 || x > 671 || y < 9 || y > band + 11) escaped++; }
					}
					const measured = authorBlockSize(ctx, spec);
					designCases++;
					if (ink > 0 && escaped === 0 && measured.height <= band) designPass++;
					if (!withAvatar && !longText) designImages.add(c.toDataURL());
				}
			}
		}
		log(`定制版式实际尺寸绘制：${designPass}/${designCases}（头像/无头像/长文字），无越界 ${designPass === 40 ? "✅" : "❌"}；独立绘制结果 ${designImages.size}/10 ${designImages.size === 10 ? "✅" : "❌"}`);
		// 重现署名横线与页码相交：直接检验最终整页中的两组像素，不只测预留高度。
		let footerPass = 0;
		const blank = document.createElement("canvas"); blank.width = 700; blank.height = 30;
		for (const template of AUTHOR_TEMPLATES) {
			for (const authorText of ["", "123456@qq.com"]) {
				const config = { ...DEFAULT_SETTINGS, authorEnabled: true, authorName: "Wen", authorText, authorAvatarPath: "sample", footerTemplate: "{{page}} / {{pages}}", footerColor: "#0000ff", footerAlign: "center" as const };
				applyAuthorStyle(config, template.style);
				config.authorColor = "#ff0000"; config.authorAccentColor = "#ff0000";
				const geo = computeGeometry(config, blank.width);
				const author = buildAuthorSpec(config, geo.dpi, {}, wideImage);
				const output = renderPage(blank, { start: 0, end: 30 } as any, buildPageSpec(config, geo, { page: "2", pages: "3" }, { author }));
				const pixels = output.getContext("2d")!.getImageData(0, 0, output.width, output.height).data;
				let redBottom = -1, blueTop = output.height;
				for (let y = Math.floor(geo.contentYPx + geo.contentHeightPx); y < output.height; y++) for (let x = 0; x < output.width; x++) {
					const i = (y * output.width + x) * 4;
					if (pixels[i] > 180 && pixels[i + 1] < 100 && pixels[i + 2] < 100) redBottom = Math.max(redBottom, y);
					if (pixels[i + 2] > 180 && pixels[i] < 100 && pixels[i + 1] < 100) blueTop = Math.min(blueTop, y);
				}
				if (redBottom >= 0 && blueTop < output.height && blueTop - redBottom >= 2) footerPass++;
			}
		}
		log(`最终分页署名与页码分离：${footerPass}/20（仅姓名 / 姓名加邮箱）${footerPass === 20 ? " ✅" : " ❌"}`);
		const savedDesign = { ...DEFAULT_SETTINGS };
		applyAuthorStyle(savedDesign, JSON.parse(JSON.stringify(AUTHOR_TEMPLATES[4].style)));
		const customDesignRoundTrip = savedDesign.authorDesign === "terminal";
		const oldStyle = { ...AUTHOR_TEMPLATES[0].style }; delete (oldStyle as any).design;
		applyAuthorStyle(savedDesign, oldStyle);
		log(`定制模板保存恢复 ${customDesignRoundTrip ? "✅" : "❌"}，旧模板兼容 ${savedDesign.authorDesign === "legacy" ? "✅" : "❌"}`);
		log(`说明文字与复杂设置栏目已移除 ${!tab.containerEl.querySelector('[data-fold="appearance"], .longshot-template-scene, .longshot-templates-desc') && !tab.containerEl.textContent?.includes("署名细节放大") ? "✅" : "❌"}`);

		// ── 裁剪编辑器：拖动 / 滚轮缩放 / destroy 后不再响应 ──
		{
			const stage = document.createElement("canvas");
			stage.style.position = "fixed";
			stage.style.left = "-400px";
			document.body.appendChild(stage);
			let commits = 0;
			const state = { offsetX: 0, offsetY: 0, zoom: 1 };
			const editor = createAvatarCropEditor({
				canvas: stage,
				getImage: () => wideImage,
				getState: () => ({ ...state }),
				getShape: () => "circle",
				getAccentColor: () => "#4169e1",
				onInput: (next) => Object.assign(state, next),
				onCommit: () => {
					commits += 1;
				},
			});
			const rect = stage.getBoundingClientRect();
			const pointer = (type: string, x: number, y: number): PointerEvent =>
				new PointerEvent(type, { pointerId: 1, clientX: rect.left + x, clientY: rect.top + y, bubbles: true });
			stage.dispatchEvent(pointer("pointerdown", 60, 60));
			stage.dispatchEvent(pointer("pointermove", 20, 90));
			const draggedOffset = { ...state };
			stage.dispatchEvent(pointer("pointerup", 20, 90));
			const dragCommits = commits;
			stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true, cancelable: true }));
			const zoomed = state.zoom;
			await new Promise((resolve) => setTimeout(resolve, 480));
			const wheelCommits = commits;
			editor.destroy();
			stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true, cancelable: true }));
			log(
				`裁剪编辑器（2:1 假图）：拖动后偏移 (${draggedOffset.offsetX.toFixed(2)}, ${draggedOffset.offsetY.toFixed(2)})` +
					`${draggedOffset.offsetX > 0.2 && draggedOffset.offsetY === 0 ? " ✅ 横向可动 / 纵向无余量保持不动" : " ❌"}` +
					`，松手落盘 ${dragCommits} 次${dragCommits === 1 ? " ✅" : " ❌"}；` +
					`滚轮缩放 ${state.zoom.toFixed(2)}（期望 >1）${zoomed > 1 ? " ✅" : " ❌"}` +
					`，静置后落盘 ${wheelCommits} 次${wheelCommits === 2 ? " ✅" : " ❌"}；` +
					`destroy 后滚轮不再生效 ${state.zoom === zoomed ? "✅" : "❌"}`
			);
			stage.remove();
		}

		// 字体确实进了绘制：全部字体渲染宽度应当不止一种
		const allFonts = Object.keys(WATERMARK_FONT_LABELS) as WatermarkFont[];
		const fontWidths = allFonts.map((font) => {
			const spec = buildAuthorPreviewSpec({ ...fakeSettings, authorFont: font, authorSizePt: 14 }, dpi, {
				name: "示例笔记",
				title: "示例笔记",
				date: "2026-01-01",
				author: "张三",
			});
			const probe = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
			probe.font = `400 ${spec.sizePx}px ${spec.font}`;
			return Math.round(probe.measureText("张三 2026 年 9 月").width);
		});
		log(
			`作者信息字体（共 ${allFonts.length} 款）：${allFonts
				.map((font, index) => `${WATERMARK_FONT_LABELS[font]}=${fontWidths[index]}px`)
				.join("，")} → ${new Set(fontWidths).size > 1 ? `宽度有 ${new Set(fontWidths).size} 种 ✅` : "⚠️ 所有字体渲染宽度一致（可能都没装）"}`
		);

		/** 把头像单独画进 120×120 的方框，返回方框内的墨点数量 */
		const avatarInk = (
			fit: "cover" | "contain" | "fill",
			offsetX: number,
			offsetY: number,
			zoom = 1
		): number => {
			const probe = document.createElement("canvas");
			probe.width = 120;
			probe.height = 120;
			const ctx = probe.getContext("2d") as CanvasRenderingContext2D;
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, 120, 120);
			drawAvatarInBox(ctx, wideImage, 0, 0, 120, fit, offsetX, offsetY, zoom);
			return inkBounds(probe).count;
		};
		const middleLeft = anchorToOffset("middle-left");
		const middleRight = anchorToOffset("middle-right");
		const middleCenter = anchorToOffset("middle-center");
		// contain：整图 200×100 等比缩到 120×60 居中 → 黑块 36×60 = 2160
		// fill：整图拉伸到 120×120 → 黑块 36×120 = 4320
		const coverLeft = avatarInk("cover", middleLeft.x, middleLeft.y);
		const coverRight = avatarInk("cover", middleRight.x, middleRight.y);
		// 放大 2 倍后横向仍有 3 倍余量，左侧 30% 的黑块会盖满整个框
		const coverZoomed = avatarInk("cover", middleLeft.x, middleLeft.y, 2);
		const containInk = avatarInk("contain", middleCenter.x, middleCenter.y);
		const fillInk = avatarInk("fill", middleCenter.x, middleCenter.y);
		log(
			`头像呈现范围（2:1 假图，仅左侧 30% 为黑）：` +
				`裁剪填满·左 ${coverLeft} 墨点（期望 8640，裁到左侧 100px 方形）/ 裁剪填满·右 ${coverRight} 墨点（期望 0，裁到白区）→ ${coverLeft !== coverRight ? "偏移定位生效 ✅" : "偏移定位无效 ❌"}；` +
				`放大 2 倍·左 ${coverZoomed} 墨点（期望 14400，整框都是黑块）${coverZoomed === 14400 ? " ✅" : " ⚠️"}；` +
				`完整显示 ${containInk} 墨点（期望 2160，上下留白）${containInk === 2160 ? " ✅" : " ⚠️"}；` +
				`拉伸填满 ${fillInk} 墨点（期望 4320）${fillInk === 4320 ? " ✅" : " ⚠️"}`
		);
	}

	window.addEventListener("beforeunload", () => {
		capture.canvas.width = 0;
		capture.canvas.height = 0;
	});
	log("验证完成 ✅");
}

/** 等一个微任务/宏任务回合：设置页的回调是 async 的，改完要等它重渲染 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 按 Setting 的标题找那一行（设置页里所有控件都挂在 .setting-item 上） */
function settingByName(root: ParentNode, name: string): HTMLElement | null {
	return (
		Array.from(root.querySelectorAll<HTMLElement>(".setting-item")).find(
			(el) => el.querySelector(".setting-item-name")?.textContent === name
		) ?? null
	);
}

/** 按 option 的值找一个下拉框，比按顺序取稳 */
function selectByOption(root: ParentNode, value: string): HTMLSelectElement | null {
	return (
		Array.from(root.querySelectorAll<HTMLSelectElement>("select")).find((select) =>
			Array.from(select.options).some((option) => option.value === value)
		) ?? null
	);
}

/**
 * 整幅统计「非背景」像素的外接矩形：背景按左上角像素取。
 * 用于判断水印落在纸张的哪个象限、有没有出血。
 */
function inkBounds(canvas: HTMLCanvasElement): {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	count: number;
} {
	const ctx = canvas.getContext("2d");
	if (!ctx) return { minX: 0, maxX: 0, minY: 0, maxY: 0, count: 0 };
	const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
	let minX = canvas.width;
	let maxX = -1;
	let minY = canvas.height;
	let maxY = -1;
	let count = 0;
	for (let y = 0; y < canvas.height; y++) {
		for (let x = 0; x < canvas.width; x++) {
			const i = (y * canvas.width + x) * 4;
			// 背景是纯白：任一通道明显偏暗就算墨
			if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) {
				count += 1;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	return { minX, maxX, minY, maxY, count };
}

/** 该行的墨点数量与 x 范围：以「该行出现最多的颜色」为背景，找出明显偏离背景的像素 */
function inkColumns(
	canvas: HTMLCanvasElement,
	y: number,
	tolerance = 60
): { count: number; first: number; last: number } {
	const ctx = canvas.getContext("2d");
	const row = Math.max(0, Math.min(canvas.height - 1, y));
	if (!ctx) return { count: 0, first: -1, last: -1 };
	const data = ctx.getImageData(0, row, canvas.width, 1).data;

	const buckets = new Map<number, number>();
	for (let x = 0; x < canvas.width; x++) {
		const i = x * 4;
		const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
		buckets.set(key, (buckets.get(key) ?? 0) + 1);
	}
	let bgKey = 0;
	let best = -1;
	for (const [key, count] of buckets) {
		if (count > best) {
			best = count;
			bgKey = key;
		}
	}
	const bg = [((bgKey >> 8) & 15) * 16 + 8, ((bgKey >> 4) & 15) * 16 + 8, (bgKey & 15) * 16 + 8];

	let count = 0;
	let first = -1;
	let last = -1;
	for (let x = 0; x < canvas.width; x += 2) {
		const i = x * 4;
		if (
			Math.abs(data[i] - bg[0]) > tolerance ||
			Math.abs(data[i + 1] - bg[1]) > tolerance ||
			Math.abs(data[i + 2] - bg[2]) > tolerance
		) {
			count += 1;
			if (first < 0) first = x;
			last = x;
		}
	}
	return { count, first, last };
}

/** 分块转 base64，避免超长 PDF 触发 apply 参数上限 */
function bytesToBase64(bytes: Uint8Array): string {
	const chunk = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function scaleCanvas(source: HTMLCanvasElement, width: number): HTMLCanvasElement {
	const out = document.createElement("canvas");
	out.width = width;
	out.height = Math.round((source.height / source.width) * width);
	const ctx = out.getContext("2d") as CanvasRenderingContext2D;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(source, 0, 0, out.width, out.height);
	return out;
}

/** 把每个换页边界、每个分块拼接位置的横条拼成一张对比图 */
function buildBoundaryStrip(
	pages: HTMLCanvasElement[],
	slices: { start: number; end: number }[],
	geometry: ReturnType<typeof computeGeometry>,
	longCanvas: HTMLCanvasElement,
	scale: number
): string {
	const bandHalf = 150;
	const rows: { canvas: HTMLCanvasElement; cx: number; cy: number; label: string }[] = [];

	for (let i = 0; i < pages.length - 1; i++) {
		const page = pages[i];
		const next = pages[i + 1];
		const sliceHeight = Math.round((slices[i].end - slices[i].start) * geometry.scale);
		const bottomY = geometry.contentYPx + sliceHeight;
		rows.push({
			canvas: page,
			cx: 0,
			cy: Math.max(0, bottomY - bandHalf),
			label: `P${i + 1} 页尾`,
		});
		rows.push({
			canvas: next,
			cx: 0,
			cy: geometry.contentYPx,
			label: `P${i + 2} 页首`,
		});
	}

	// 分块拼接处（源图上的整块边界）
	const chunkHeight = 2000;
	for (let offset = chunkHeight; offset < longCanvas.height / scale; offset += chunkHeight) {
		rows.push({
			canvas: longCanvas,
			cx: 0,
			cy: Math.round(offset * scale) - bandHalf,
			label: `源图拼接 y=${offset}`,
		});
	}

	const bandHeight = bandHalf * 2;
	const outWidth = 1000;
	const labelWidth = 0;
	const rowHeight = Math.round((bandHeight * outWidth) / pages[0].width);
	const gap = 4;
	const labelHeight = 16;
	const out = document.createElement("canvas");
	out.width = outWidth;
	out.height = rows.length * (rowHeight + labelHeight + gap);
	const ctx = out.getContext("2d") as CanvasRenderingContext2D;
	ctx.fillStyle = "#111111";
	ctx.fillRect(0, 0, out.width, out.height);
	ctx.font = "12px monospace";
	ctx.textBaseline = "top";

	rows.forEach((row, index) => {
		const y = index * (rowHeight + labelHeight + gap);
		ctx.fillStyle = "#8ab4f8";
		ctx.fillText(row.label, 4, y + 2);
		ctx.drawImage(
			row.canvas,
			0,
			row.cy,
			row.canvas.width,
			bandHeight,
			0,
			y + labelHeight,
			outWidth,
			rowHeight
		);
		void labelWidth;
	});
	return out.toDataURL("image/png");
}

run().catch((error) => {
	log(`失败：${String(error)}\n${(error as Error)?.stack ?? ""}`);
	console.error(error);
});