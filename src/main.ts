import { t, listSeparator } from "./i18n";
import { App, Notice, Plugin, TFile, TFolder } from "obsidian";
import { createBlankRowFinder } from "./blankrow";
import { collectBlocks, type BlockIndex } from "./blocks";
import {
	captureViewport,
	resolveBackgroundColor,
	type CaptureResult,
} from "./capture";
import {
	buildPageSpec,
	computeGeometry,
	renderLongImage,
	renderPage,
	type PageGeometry,
} from "./compose";
import {
	buildFileName,
	ensureTarget,
	resolveOutputTarget,
	templateVars,
	vaultRootPath,
	writeBinary,
} from "./files";
import { confirmDialog, ExportOptionsModal } from "./modal";
import { buildLongPdf, buildPdf, canvasToArrayBuffer } from "./output";
import { buildOutline, paginate, type PageSlice } from "./paginate";
import { pickFolder, pickImageFile } from "./picker";
import { previewPagination } from "./preview";
import { ProgressNotice } from "./progress";
import { renderPreviewOffscreen, type OffscreenRender } from "./render";
import {
	applyModeToSettings,
	DEFAULT_SETTINGS,
	imageFormatOf,
	resolveExportMode,
	resolveQualityDpi,
	type ExportMode,
	type LongshotSettings,
} from "./settings";
import { LongshotSettingTab, normalizeSettings } from "./settings-tab";
import { describeError, fillTemplate, mmToPx, nextFrame } from "./utils";
import {
	authorBandMm,
	buildAuthorSpec,
	buildWatermarkSpec,
	embedHiddenWatermark,
	extractHiddenWatermark,
	hasAuthorContent,
	hasWatermark,
	loadImage,
} from "./watermark";

export type { ExportMode };

/** 单篇导出过程中的进度回调 */
interface ExportHooks {
	update(message: string): void;
	/** 渲染超时后询问是否继续；返回 false 表示放弃这篇 */
	confirmPending?(pending: string[]): Promise<boolean>;
}

interface ExportOutcome {
	file: TFile;
	/** 用户中途取消了这篇 */
	cancelled: boolean;
	pages: number;
	saved: string[];
	hardSplits: number;
	warnings: string[];
	paperWidthMm: number;
	paperHeightMm: number;
}

/** 渲染 + 截图之后、写文件之前的中间状态 */
interface PreparedExport {
	file: TFile;
	mode: ExportMode;
	settings: LongshotSettings;
	capture: CaptureResult;
	backgroundColor: string;
	geometry: PageGeometry;
	blocks: BlockIndex;
	slices: PageSlice[];
	hardSplits: number;
	vars: Record<string, string>;
	watermarkImage: HTMLImageElement | null;
	avatar: HTMLImageElement | null;
	warnings: string[];
	dispose(): void;
}

export default class LongshotPdfPlugin extends Plugin {
	settings: LongshotSettings = { ...DEFAULT_SETTINGS };
	readonly defaults: LongshotSettings = DEFAULT_SETTINGS;
	private busy = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new LongshotSettingTab(this.app, this));

		this.addRibbonIcon("camera", t("长截图导出（打开设置面板）"), () => {
			this.openExportModal();
		});

		this.addCommand({
			id: "export-pdf",
			name: t("长截图 → 分页 → 导出 PDF"),
			checkCallback: (checking) => this.commandGuard(checking, "pdf"),
		});
		this.addCommand({
			id: "export-page-images",
			name: t("长截图 → 分页 → 导出每页图片（JPG / PNG）"),
			checkCallback: (checking) => this.commandGuard(checking, "pages"),
		});
		this.addCommand({
			id: "save-long-image",
			name: t("只生成长截图（JPG / PNG）"),
			checkCallback: (checking) => this.commandGuard(checking, "long"),
		});
		this.addCommand({
			id: "save-long-pdf",
			name: t("长截图 → 单页 PDF（不切分）"),
			checkCallback: (checking) => this.commandGuard(checking, "longPdf"),
		});
		this.addCommand({
			id: "preview-pagination",
			name: t("长截图 → 分页预览（可手动调整断点）"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.openPreview();
				return true;
			},
		});
		this.addCommand({
			id: "batch-export-folder",
			name: t("批量导出：当前笔记所在文件夹（含子文件夹）"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const folder = file?.parent;
				if (!file || file.extension !== "md" || !folder) return false;
				if (!checking) void this.runBatchExport(folder, resolveExportMode(this.settings));
				return true;
			},
		});
		this.addCommand({
			id: "verify-hidden-watermark",
			name: t("读取图片里的隐水印（校验）"),
			callback: () => {
				const input = document.createElement("input");
				input.type = "file";
				input.accept = ".png,image/png";
				input.hidden = true;
				input.setAttribute("aria-label", t("选择要校验的 PNG 图片…"));
				input.addEventListener("change", () => {
					const file = input.files?.[0];
					input.remove();
					if (file) void this.verifyHiddenWatermark(file);
				}, { once: true });
				input.addEventListener("cancel", () => input.remove(), { once: true });
				document.body.appendChild(input);
				input.click();
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) =>
						item
							.setTitle(t("长截图：导出该文件夹为 PDF"))
							.setIcon("camera")
							.onClick(() => void this.runBatchExport(file, "pdf"))
					);
					return;
				}
				if (file instanceof TFile && file.extension === "md") {
					menu.addItem((item) =>
						item
							.setTitle(t("长截图：导出这篇笔记"))
							.setIcon("camera")
							.onClick(() => void this.runExport(resolveExportMode(this.settings), file))
					);
				}
			})
		);
	}

	private commandGuard(checking: boolean, mode: ExportMode): boolean {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			return false;
		}
		if (!checking) {
			void this.runExport(mode);
		}
		return true;
	}

	/** 侧边栏图标：先弹出快速设置面板，确认后再导出 */
	openExportModal(): void {
		if (this.busy) {
			new Notice(t("已有导出任务在进行中，请稍候"));
			return;
		}
		new ExportOptionsModal(this.app, this).open();
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<LongshotSettings> | null;
		this.settings = normalizeSettings(stored ?? {}, DEFAULT_SETTINGS);
	}

	/** 打开系统文件夹选择框挑导出位置；返回是否改了设置 */
	async chooseOutputDir(): Promise<boolean> {
		const file = this.app.workspace.getActiveFile();
		const target = resolveOutputTarget(this.settings, file && file.extension === "md" ? file : null);
		let picked: string | null;
		try {
			picked = await pickFolder({
				title: t("选择导出位置"),
				defaultPath:
					this.settings.outputDir && target.kind === "fs"
						? target.folder
						: vaultRootPath(this.app),
			});
		} catch (error) {
			new Notice(t("打不开系统文件夹选择框：{0}", describeError(error)));
			return false;
		}
		if (!picked) {
			return false;
		}
		this.settings.outputDir = picked;
		await this.saveSettings();
		new Notice(t("导出位置已设为\n{0}", picked));
		return true;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * 打开系统文件选择框挑一张图片（水印 / 头像用），
	 * 把绝对路径写回设置并立即保存；返回是否改了设置。
	 */
	async chooseImageFile(which: "watermark" | "avatar"): Promise<boolean> {
		let picked: string | null;
		try {
			picked = await pickImageFile({
				title: which === "watermark" ? t("选择水印图片") : t("选择头像图片"),
				defaultPath: vaultRootPath(this.app),
			});
		} catch (error) {
			new Notice(t("打不开系统文件选择框：{0}", describeError(error)));
			return false;
		}
		if (!picked) {
			return false;
		}
		if (which === "watermark") {
			this.settings.watermarkImagePath = picked;
		} else {
			this.settings.authorAvatarPath = picked;
		}
		await this.saveSettings();
		new Notice(t("已选用图片\n{0}", picked));
		return true;
	}

	/** 导出单篇笔记（默认导出当前打开的那篇） */
	async runExport(mode: ExportMode, target?: TFile): Promise<void> {
		const file = target ?? this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			new Notice(t("请先打开一篇 Markdown 笔记"));
			return;
		}
		if (this.busy) {
			new Notice(t("已有导出任务在进行中，请稍候"));
			return;
		}
		this.busy = true;

		const settings = this.settings;
		if (resolveExportMode(settings) !== mode) {
			applyModeToSettings(settings, mode);
			void this.saveSettings();
		}
		const progress = new ProgressNotice(`Longshot PDF · ${file.basename}`);
		try {
			const ctx = await this.prepareExport(file, mode, {
				update: (message) => progress.update(message),
				confirmPending: (pending) =>
					confirmDialog(this.app, {
						title: t("渲染可能还没完成"),
						message: t("等待超时，仍未完成：{0}。\n现在导出这些内容可能显示不完整。", pending.join(listSeparator)),
						confirmText: t("仍然导出"),
						cancelText: t("取消导出"),
					}),
			});
			if (!ctx) {
				progress.finish(t("已取消导出"));
				return;
			}
			try {
				const outcome = await this.writeExport(ctx, ctx.slices, {
					update: (message) => progress.update(message),
				});
				progress.finish(this.summarize([outcome]));
			} finally {
				ctx.dispose();
			}
		} catch (error) {
			console.error("[longshot-pdf]", error);
			progress.fail(describeError(error));
		} finally {
			this.busy = false;
		}
	}

	/** 分页预览：先渲染截图，弹窗里确认 / 微调断点，再按调整后的分页写文件 */
	async openPreview(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			new Notice(t("请先打开一篇 Markdown 笔记"));
			return;
		}
		if (this.busy) {
			new Notice(t("已有导出任务在进行中，请稍候"));
			return;
		}
		this.busy = true;

		const settings = this.settings;
		const mode: ExportMode = settings.exportFormat === "pdf" ? "pdf" : "pages";
		if (resolveExportMode(settings) !== mode) {
			applyModeToSettings(settings, mode);
			void this.saveSettings();
		}
		const progress = new ProgressNotice(`Longshot PDF · ${file.basename}`);
		try {
			const ctx = await this.prepareExport(file, mode, {
				update: (message) => progress.update(message),
			});
			if (!ctx) {
				progress.finish(t("已取消导出"));
				return;
			}
			try {
				progress.hide();
				const slices = await previewPagination(this.app, {
					source: ctx.capture.canvas,
					spec: buildPageSpec(
						settings,
						ctx.geometry,
						{ ...ctx.vars, page: "1", pages: String(ctx.slices.length) },
						{
							watermark: buildWatermarkSpec(
								settings,
								ctx.geometry.dpi,
								ctx.vars,
								ctx.watermarkImage
							),
							author: buildAuthorSpec(settings, ctx.geometry.dpi, ctx.vars, ctx.avatar),
						}
					),
					autoSlices: ctx.slices,
					candidates: ctx.blocks.candidates,
					totalHeight: ctx.capture.canvas.height,
					capacity: ctx.geometry.capacitySrcPx,
				});
				if (!slices) {
					progress.finish(t("已取消导出"));
					return;
				}
				const outcome = await this.writeExport(ctx, slices, {
					update: (message) => progress.update(message),
				});
				progress.finish(this.summarize([outcome]));
			} finally {
				ctx.dispose();
			}
		} catch (error) {
			console.error("[longshot-pdf]", error);
			progress.fail(describeError(error));
		} finally {
			this.busy = false;
		}
	}

	/** 批量导出文件夹里的所有笔记（串行，位图导出吃内存不能并发） */
	async runBatchExport(folder: TFolder, mode: ExportMode): Promise<void> {
		if (this.busy) {
			new Notice(t("已有导出任务在进行中，请稍候"));
			return;
		}
		const files = collectMarkdownFiles(folder);
		if (files.length === 0) {
			new Notice(t("「{0}」里没有 Markdown 笔记", folder.name));
			return;
		}
		if (files.length > 100) {
			const ok = await confirmDialog(this.app, {
				title: t("批量导出"),
				message: t("「{0}」及其子文件夹里有 {1} 篇笔记，导出过程无法中断。确定继续吗？", folder.name, files.length),
				confirmText: t("开始导出"),
			});
			if (!ok) return;
		}
		this.busy = true;

		const settings = this.settings;
		if (resolveExportMode(settings) !== mode) {
			applyModeToSettings(settings, mode);
			void this.saveSettings();
		}
		const progress = new ProgressNotice(t("Longshot PDF · 批量导出（{0} 篇）", files.length));
		const outcomes: ExportOutcome[] = [];
		const failures: string[] = [];
		try {
			for (let i = 0; i < files.length; i++) {
				const file = files[i];
				const prefix = t("第 {0}/{1} 篇 · {2}", i + 1, files.length, file.basename);
				progress.update(t("{0}\n正在渲染…", prefix));
				try {
					const ctx = await this.prepareExport(file, mode, {
						update: (message) => progress.update(`${prefix}\n${message}`),
					});
					if (!ctx) continue;
					try {
						outcomes.push(
							await this.writeExport(ctx, ctx.slices, {
								update: (message) => progress.update(`${prefix}\n${message}`),
							})
						);
					} finally {
						ctx.dispose();
					}
				} catch (error) {
					console.error(t("[longshot-pdf] 批量导出失败"), file.path, error);
					failures.push(`${file.basename}：${describeError(error)}`);
				}
			}

			const lines: string[] = [t("已导出 {0}/{1} 篇", outcomes.length, files.length)];
			if (failures.length > 0) {
				lines.push(t("失败 {0} 篇：", failures.length), ...failures.slice(0, 3));
				if (failures.length > 3) lines.push(t("… 另有 {0} 篇失败，详见控制台", failures.length - 3));
			}
			progress.finish(lines.join("\n"), 12000);
		} finally {
			this.busy = false;
		}
	}

	/** 读取 PNG 里的隐水印，用于校验导出结果 */
	async verifyHiddenWatermark(file: TFile | File): Promise<void> {
		try {
			const bytes = file instanceof TFile
				? await this.app.vault.readBinary(file)
				: await file.arrayBuffer();
			const image = await blobToImage(new Blob([bytes]));
			const canvas = document.createElement("canvas");
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			if (!ctx) throw new Error(t("无法创建画布上下文"));
			ctx.drawImage(image, 0, 0);
			const text = extractHiddenWatermark(canvas);
			canvas.width = 0;
			canvas.height = 0;
			if (text === null) {
				new Notice(t("{0}\n没有读到隐水印（可能被压缩过，或导出时未开启）", file.name));
				return;
			}
			new Notice(t("{0}\n隐水印内容：\n{1}", file.name, text), 12000);
		} catch (error) {
			new Notice(t("读取失败：{0}", describeError(error)));
		}
	}

	/** 渲染 + 截图 + 分页计算；返回 null 表示用户取消 */
	private async prepareExport(
		file: TFile,
		mode: ExportMode,
		hooks: ExportHooks
	): Promise<PreparedExport | null> {
		const settings = this.settings;
		const warnings: string[] = [];
		const vars = { ...templateVars(file), title: file.basename, author: settings.authorName.trim() };

		hooks.update(t("正在加载水印 / 头像图片…"));
		const watermarkImage = hasWatermark(settings)
			? await loadImage(this.app, settings.watermarkImagePath, (message) => warnings.push(message))
			: null;
		const avatar = hasAuthorContent(settings)
			? await loadImage(this.app, settings.authorAvatarPath, (message) => warnings.push(message))
			: null;

		hooks.update(t("正在按阅读视图渲染笔记…"));
		const offscreen: OffscreenRender = await renderPreviewOffscreen(this.app, file, {
			contentWidth: settings.contentWidth,
			theme: settings.renderTheme,
			settleDelayMs: settings.settleDelayMs,
			renderTimeoutMs: settings.renderTimeoutMs,
			title: settings.includeTitle ? file.basename : null,
			onWarn: (message) => warnings.push(message),
			onProgress: (message) => hooks.update(message),
		});

		try {
			// 主动检测超时：交给调用方决定是继续导出还是放弃
			if (offscreen.pending.length > 0 && hooks.confirmPending) {
				const ok = await hooks.confirmPending(offscreen.pending);
				if (!ok) {
					offscreen.destroy();
					return null;
				}
			}

			hooks.update(t("正在截取长图…"));
			const backgroundColor =
				settings.captureBackground === "paper"
					? settings.paperColor
					: resolveBackgroundColor(offscreen.content);
			const capture = await captureViewport(
				offscreen.stage,
				offscreen.content,
				offscreen.heightCss,
				{
					scale: settings.captureScale,
					backgroundColor,
					blocks: offscreen.sizer,
					onProgress: (done, totalCount, label) =>
						hooks.update(
							label === t("整页截取") ? t("正在截取长图…") : t("正在截取长图 {0}/{1}…", done, totalCount)
						),
				}
			);

			hooks.update(t("正在计算分页…"));
			const geometry = computeGeometry(settings, capture.canvas.width);
			const blocks = collectBlocks(offscreen.sizer, offscreen.stage, capture.scale);
			const { slices, hardSplits } = paginate({
				totalHeight: capture.canvas.height,
				capacity: geometry.capacitySrcPx,
				candidates: blocks.candidates,
				topLevel: blocks.topLevel,
				atoms: settings.avoidSplittingImages ? blocks.atoms : [],
				minFillRatio: settings.minFillRatio,
				smartBreak: settings.smartBreak,
				avoidHeadingOrphan: settings.avoidHeadingOrphan,
				forcedBreaks: settings.respectForcedBreaks ? blocks.forcedBreaks : [],
				findBlankRow: createBlankRowFinder(capture.canvas),
			});

			return {
				file,
				mode,
				settings,
				capture,
				backgroundColor,
				geometry,
				blocks,
				slices,
				hardSplits,
				vars,
				watermarkImage,
				avatar,
				warnings,
				dispose: () => {
					offscreen.destroy();
					capture.canvas.width = 0;
					capture.canvas.height = 0;
				},
			};
		} catch (error) {
			offscreen.destroy();
			throw error;
		}
	}

	/** 按给定的分页写出文件 */
	private async writeExport(
		ctx: PreparedExport,
		slices: PageSlice[],
		hooks: ExportHooks
	): Promise<ExportOutcome> {
		const { settings, file, mode, capture, geometry, warnings } = ctx;
		const imageFormat = imageFormatOf(settings);
		const imageExt = imageFormat === "png" ? "png" : "jpg";
		const hiddenText = settings.hiddenWatermarkEnabled
			? fillTemplate(settings.hiddenWatermarkText, ctx.vars).trim()
			: "";
		if (hiddenText && imageFormat !== "png" && mode !== "pdf") {
			warnings.push(t("隐水印只对 PNG 可靠，JPEG 压缩会破坏它"));
		}

		const target = resolveOutputTarget(settings, file);
		await ensureTarget(this.app, target);
		const saved: string[] = [];
		const paper = { widthMm: geometry.paperWidthMm, heightMm: geometry.paperHeightMm };

		if (mode === "long" || mode === "longPdf") {
			hooks.update(t("正在保存长截图…"));
			const dpi = Math.max(72, capture.scale * 96);
			const decorated = renderLongImage(capture.canvas, {
				watermark: buildWatermarkSpec(settings, dpi, ctx.vars, ctx.watermarkImage),
				author: buildAuthorSpec(settings, dpi, ctx.vars, ctx.avatar),
				authorBandPx: Math.round(mmToPx(authorBandMm(settings), dpi)),
				paperColor: ctx.backgroundColor,
			});
			try {
				if (hiddenText && !embedHiddenWatermark(decorated, hiddenText)) {
					warnings.push(t("隐水印写入失败（画布过小或像素不可读）"));
				}
				const data =
					mode === "long"
						? await canvasToArrayBuffer(decorated, imageFormat, settings.jpegQuality)
						: await buildLongPdf(decorated, {
								dpi: resolveQualityDpi(settings.quality),
								format: imageFormat,
								jpegQuality: settings.jpegQuality,
								layout: {
									paperWidthMm: paper.widthMm,
									marginTopMm: settings.marginTopMm,
									marginRightMm: settings.marginRightMm,
									marginBottomMm: settings.marginBottomMm,
									marginLeftMm: settings.marginLeftMm,
									paperColor: ctx.backgroundColor,
								},
							});
				const name = buildFileName(settings, file, mode === "long" ? imageExt : "pdf", "-long");
				saved.push(await writeBinary(this.app, target, name, data));
			} finally {
				if (decorated !== capture.canvas) {
					decorated.width = 0;
					decorated.height = 0;
				}
			}
			return {
				file,
				cancelled: false,
				pages: 1,
				saved,
				hardSplits: 0,
				warnings,
				paperWidthMm: paper.widthMm,
				paperHeightMm: paper.heightMm,
			};
		}

		const total = Math.max(1, slices.length);
		const pages: HTMLCanvasElement[] = [];
		let hiddenFailed = false;
		try {
			for (let i = 0; i < total; i++) {
				hooks.update(t("正在排版第 {0}/{1} 页…", i + 1, total));
				const vars = { ...ctx.vars, page: String(i + 1), pages: String(total) };
				const page = renderPage(
					capture.canvas,
					slices[i],
					buildPageSpec(settings, geometry, vars, {
						watermark: buildWatermarkSpec(settings, geometry.dpi, vars, ctx.watermarkImage),
						author: buildAuthorSpec(settings, geometry.dpi, vars, ctx.avatar),
					})
				);
				if (hiddenText && !embedHiddenWatermark(page, hiddenText)) {
					hiddenFailed = true;
				}
				pages.push(page);
				await nextFrame();
			}
			if (hiddenFailed) {
				warnings.push(t("隐水印写入失败（画布过小或像素不可读）"));
			}

			if (mode === "pdf") {
				hooks.update(t("正在生成 PDF…"));
				// 隐水印写在像素最低位，只有无损页面能保住它
				const pdfFormat = hiddenText ? "png" : imageFormat;
				const buffer = await buildPdf(pages, {
					paperWidthMm: geometry.paperWidthMm,
					paperHeightMm: geometry.paperHeightMm,
					format: pdfFormat,
					jpegQuality: settings.jpegQuality,
					outline: settings.pdfOutline ? buildOutline(ctx.blocks, slices) : undefined,
					onProgress: (done, count) => hooks.update(t("正在写入 PDF {0}/{1}…", done, count)),
				});
				saved.push(
					await writeBinary(this.app, target, buildFileName(settings, file, "pdf"), buffer)
				);
			} else {
				const digits = Math.max(2, String(pages.length).length);
				for (let i = 0; i < pages.length; i++) {
					hooks.update(t("正在保存分页图片 {0}/{1}…", i + 1, pages.length));
					const suffix = `-p${String(i + 1).padStart(digits, "0")}`;
					const name = buildFileName(settings, file, imageExt, suffix);
					saved.push(
						await writeBinary(
							this.app,
							target,
							name,
							await canvasToArrayBuffer(pages[i], imageFormat, settings.jpegQuality)
						)
					);
				}
			}

			return {
				file,
				cancelled: false,
				pages: total,
				saved,
				hardSplits: ctx.hardSplits,
				warnings,
				paperWidthMm: paper.widthMm,
				paperHeightMm: paper.heightMm,
			};
		} finally {
			for (const page of pages) {
				page.width = 0;
				page.height = 0;
			}
		}
	}

	private summarize(outcomes: ExportOutcome[]): string {
		const lines: string[] = [];
		if (outcomes.length === 1) {
			const outcome = outcomes[0];
			lines.push(
				t("共 {0} 页，纸张 {1} × {2} mm", outcome.pages, outcome.paperWidthMm, outcome.paperHeightMm)
			);
			if (outcome.hardSplits > 0) {
				lines.push(t("其中 {0} 处因块过长被切分，可在设置里调整内容宽度或页边距", outcome.hardSplits));
			}
			lines.push(...outcome.saved.slice(0, 5));
			if (outcome.saved.length > 5) {
				lines.push(t("… 另有 {0} 个文件", outcome.saved.length - 5));
			}
			if (outcome.warnings.length > 0) {
				lines.push(t("提示：{0}", outcome.warnings[0]));
			}
			return lines.join("\n");
		}
		const totalPages = outcomes.reduce((sum, outcome) => sum + outcome.pages, 0);
		lines.push(t("已导出 {0} 篇，共 {1} 页", outcomes.length, totalPages));
		const warnings = outcomes.flatMap((outcome) => outcome.warnings);
		if (warnings.length > 0) {
			lines.push(t("提示：{0}{1}", warnings[0], warnings.length > 1 ? t("（共 {0} 条）", warnings.length) : ""));
		}
		return lines.join("\n");
	}
}

/** 递归收集文件夹里的 Markdown 笔记（按路径排序，保证多次导出顺序一致） */
function collectMarkdownFiles(folder: TFolder): TFile[] {
	const result: TFile[] = [];
	const walk = (node: TFolder): void => {
		for (const child of node.children) {
			if (child instanceof TFolder) {
				walk(child);
			} else if (child instanceof TFile && child.extension === "md") {
				result.push(child);
			}
		}
	};
	walk(folder);
	return result.sort((a, b) => a.path.localeCompare(b.path));
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(blob);
		const image = new Image();
		image.onload = () => {
			URL.revokeObjectURL(url);
			resolve(image);
		};
		image.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error(t("图片解码失败")));
		};
		image.src = url;
	});
}
