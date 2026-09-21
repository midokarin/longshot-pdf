import { App, Modal, Setting } from "obsidian";
import type LongshotPdfPlugin from "./main";
import { describeTarget, resolveOutputTarget } from "./files";
import {
	EXPORT_FORMAT_LABELS,
	EXPORT_TYPE_LABELS,
	PAPER_LABELS,
	QUALITY_LABELS,
	resolveExportMode,
	type ExportFormat,
	type ExportType,
	type PaperId,
	type QualityLevel,
} from "./settings";
import { clamp, round } from "./utils";
import { hasAuthorContent, hasWatermark } from "./watermark";

/**
 * 点击侧边栏图标后弹出的「快速设置 + 导出」面板。
 * 只放最常改的几项，改动即时保存；更细的设置留在插件设置页（底部有入口）。
 */
export class ExportOptionsModal extends Modal {
	private readonly plugin: LongshotPdfPlugin;
	/** 纸张相关设置，导出类型为「长截图」时不需要显示 */
	private paperSectionEl: HTMLElement | null = null;
	/** 高级设置里与纸张相关的一段（页边距 / 页脚），长截图类型时同样隐藏 */
	private advancedPaperEl: HTMLElement | null = null;
	/** 组合结果提示（A4 多页 PDF / 一张长图 JPG …） */
	private formatHintEl: HTMLElement | null = null;
	/** 「输出位置」那一行：当前保存路径显示在它的说明文字里 */
	private outputSettingEl: Setting | null = null;
	/** 快速面板里的三类水印开关，说明文字在 refresh() 里跟着状态更新 */
	private watermarkRows: { el: Setting; describe: () => string }[] = [];
	private runButtonEl: HTMLButtonElement | null = null;
	/** 「预览分页…」按钮：长截图类型不需要预览 */
	private previewButtonEl: HTMLButtonElement | null = null;

	constructor(app: App, plugin: LongshotPdfPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.modalEl.addClass("longshot-modal");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "长截图导出" });

		const settings = this.plugin.settings;
		const file = this.app.workspace.getActiveFile();
		const target = file && file.extension === "md" ? file : null;
		const note = contentEl.createDiv({ cls: "longshot-modal-note" });
		if (target) {
			note.createSpan({ text: "当前笔记：" });
			note.createEl("strong", { text: target.basename });
		} else {
			note.addClass("longshot-modal-warn");
			note.createSpan({ text: "当前没有打开 Markdown 笔记，请先打开一篇再导出。" });
		}

		new Setting(contentEl)
			.setName("导出类型")
			.setDesc("自动分页：按纸张切成多页；长截图：整篇拼成一张长图，不切分。")
			.addDropdown((dropdown) => {
				for (const type of Object.keys(EXPORT_TYPE_LABELS) as ExportType[]) {
					dropdown.addOption(type, EXPORT_TYPE_LABELS[type]);
				}
				dropdown.setValue(settings.exportType);
				dropdown.onChange(async (value) => {
					settings.exportType = value as ExportType;
					await this.plugin.saveSettings();
					this.refresh();
				});
			});

		new Setting(contentEl)
			.setName("导出格式")
			.setDesc("长截图 + PDF 会得到一张不切分的超长页面 PDF。")
			.addDropdown((dropdown) => {
				for (const format of Object.keys(EXPORT_FORMAT_LABELS) as ExportFormat[]) {
					dropdown.addOption(format, EXPORT_FORMAT_LABELS[format]);
				}
				dropdown.setValue(settings.exportFormat);
				dropdown.onChange(async (value) => {
					settings.exportFormat = value as ExportFormat;
					await this.plugin.saveSettings();
					this.refresh();
				});
			});

		const formatHint = contentEl.createDiv({ cls: "longshot-modal-note" });
		this.formatHintEl = formatHint;

		const paper = contentEl.createDiv({ cls: "longshot-modal-section" });
		this.paperSectionEl = paper;

		new Setting(paper)
			.setName("纸张尺寸")
			.setDesc("选「自定义尺寸」时，宽高在「更多设置…」里填写。")
			.addDropdown((dropdown) => {
				for (const id of Object.keys(PAPER_LABELS) as PaperId[]) {
					dropdown.addOption(id, PAPER_LABELS[id]);
				}
				dropdown.setValue(settings.paper);
				dropdown.onChange(async (value) => {
					settings.paper = value as PaperId;
					await this.plugin.saveSettings();
				});
			});

		new Setting(contentEl)
		.setName("纸张底色")
		.setDesc("也是截图底色（截图底色设为「跟随纸张颜色」时）。")
		.addColorPicker((picker) => {
			picker.setValue(settings.paperColor);
			picker.onChange(async (value) => {
				settings.paperColor = value;
				await this.plugin.saveSettings();
			});
		});

		// 水印：三类互相独立，想加哪一类就勾哪一类；具体样式在设置页的「水印」栏里调
		new Setting(contentEl).setName("加入水印").setHeading();
		this.watermarkRows = [];
		const addWatermarkRow = (
			name: string,
			enabled: () => boolean,
			set: (value: boolean) => void,
			describe: () => string
		): void => {
			const row = new Setting(contentEl)
				.setName(name)
				.setDesc(describe())
				.addToggle((toggle) => {
					toggle.setValue(enabled());
					toggle.onChange(async (value) => {
						set(value);
						await this.plugin.saveSettings();
						this.refresh();
					});
				});
			this.watermarkRows.push({ el: row, describe });
		};
		addWatermarkRow(
			"可见水印",
			() => settings.watermarkEnabled,
			(value) => (settings.watermarkEnabled = value),
			() => this.describeVisibleWatermark()
		);
		addWatermarkRow(
			"作者信息",
			() => settings.authorEnabled,
			(value) => (settings.authorEnabled = value),
			() => this.describeAuthor()
		);
		addWatermarkRow(
			"隐水印",
			() => settings.hiddenWatermarkEnabled,
			(value) => (settings.hiddenWatermarkEnabled = value),
			() => this.describeHidden()
		);

		// 高级设置：不常改的项折叠起来，保持面板整洁
		const advanced = contentEl.createEl("details", { cls: "longshot-advanced" });
		advanced.createEl("summary", { text: "高级设置" });
		const advancedBody = advanced.createDiv({ cls: "longshot-advanced-body" });

		// 页边距与页脚只对分页排版有效，导出长截图时随纸张设置一起隐藏
		const advancedPaper = advancedBody.createDiv({ cls: "longshot-modal-section" });
		this.advancedPaperEl = advancedPaper;

		this.addMarginSetting(advancedPaper);

		new Setting(advancedPaper)
			.setName("页脚")
			.setDesc("可用变量：{{page}} {{pages}} {{name}} {{title}} {{date}}，留空则不显示。")
			.addText((text) => {
				text.setPlaceholder("{{page}} / {{pages}}");
				text.setValue(settings.footerTemplate);
				text.onChange(async (value) => {
					settings.footerTemplate = value.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(advancedBody)
			.setName("内容宽度")
			.setDesc("渲染宽度（px），决定换行位置；越宽每行字数越多。")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.addClass("longshot-number-input");
				text.setValue(String(settings.contentWidth));
				text.onChange(async (value) => {
					const width = clamp(Math.round(Number(value) || settings.contentWidth), 320, 2000);
					settings.contentWidth = width;
					await this.plugin.saveSettings();
				});
			});

		new Setting(advancedBody)
			.setName("输出质量")
			.setDesc("清晰度与文件体积的取舍。")
			.addDropdown((dropdown) => {
				for (const level of Object.keys(QUALITY_LABELS) as QualityLevel[]) {
					dropdown.addOption(level, QUALITY_LABELS[level]);
				}
				dropdown.setValue(settings.quality);
				dropdown.onChange(async (value) => {
					settings.quality = value as QualityLevel;
					await this.plugin.saveSettings();
				});
			});

		const outputSetting = new Setting(contentEl)
			.setName("输出位置")
			.setDesc("导出文件的保存文件夹；默认放在笔记所在目录。")
			.addButton((button) => {
				button.setButtonText("选择文件夹…").onClick(async () => {
					if (await this.plugin.chooseOutputDir()) {
						this.refresh();
					}
				});
			})
			.addExtraButton((button) => {
				button
					.setIcon("rotate-ccw")
					.setTooltip("恢复为「跟随笔记所在目录」")
					.onClick(async () => {
						this.plugin.settings.outputDir = "";
						await this.plugin.saveSettings();
						this.refresh();
					});
			});
		this.outputSettingEl = outputSetting;

		const footer = contentEl.createDiv({ cls: "longshot-modal-footer" });
		const previewButton = footer.createEl("button", { text: "预览分页…" });
		previewButton.addEventListener("click", () => {
			this.close();
			void this.plugin.openPreview();
		});
		this.previewButtonEl = previewButton;
		const moreButton = footer.createEl("button", { text: "更多设置…" });
		moreButton.addEventListener("click", () => this.openPluginSettings());
		const cancelButton = footer.createEl("button", { text: "取消" });
		cancelButton.addEventListener("click", () => this.close());
		const runButton = footer.createEl("button", { text: "开始导出", cls: "mod-cta" });
		runButton.addEventListener("click", () => {
			const mode = resolveExportMode(this.plugin.settings);
			this.close();
			void this.plugin.runExport(mode);
		});
		this.runButtonEl = runButton;

		this.refresh();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** 按当前类型 / 格式显示或隐藏纸张设置，刷新结果提示，并在没有打开笔记时禁用导出 */
	private refresh(): void {
		const settings = this.plugin.settings;
		const isLong = settings.exportType === "long";
		this.paperSectionEl?.toggleClass("is-hidden", isLong);
		this.advancedPaperEl?.toggleClass("is-hidden", isLong);

		if (this.formatHintEl) {
			const paper = PAPER_LABELS[settings.paper].replace(/\s*\(.*\)$/, "");
			const imageExt = settings.exportFormat === "png" ? "PNG" : "JPG";
			const hint =
				settings.exportFormat === "pdf"
					? isLong
						? "将输出：一张不切分的超长页面 PDF"
						: `将输出：按 ${paper} 分页排版的多页 PDF`
					: isLong
						? `将输出：一张长图 ${imageExt}`
						: `将输出：每页一张 ${imageExt}，按 ${paper} 分页`;
			this.formatHintEl.setText(`格式组合 → ${hint}`);
		}

		for (const row of this.watermarkRows) {
			row.el.setDesc(row.describe());
		}

		if (this.outputSettingEl) {
			const mdFile = this.app.workspace.getActiveFile();
			const source = mdFile && mdFile.extension === "md" ? mdFile : null;
			const target = resolveOutputTarget(settings, source);
			this.outputSettingEl.setDesc(
				`导出文件的保存文件夹。当前：${describeTarget(target, source)}${source ? "" : "（打开笔记后可显示具体目录）"}`
			);
		}

		if (this.runButtonEl) {
			const file = this.app.workspace.getActiveFile();
			this.runButtonEl.disabled = !file || file.extension !== "md";
		}
		this.previewButtonEl?.toggleClass("is-hidden", isLong);
	}

	/** 三类水印的说明：顺带把当前状态显示出来，免得勾了却不知道加的是什么 */
	private describeVisibleWatermark(): string {
		const settings = this.plugin.settings;
		if (!settings.watermarkEnabled) {
			return "在每页（或整张长图）上叠加半透明水印；文字 / 图片在「更多设置…」的「水印」栏里填。";
		}
		if (!hasWatermark(settings)) {
			return "已开启，但还没填水印文字或图片，导出时不会生效。";
		}
		if (settings.watermarkImagePath.trim()) {
			return `已开启：图片「${settings.watermarkImagePath.trim()}」`;
		}
		return `已开启：文字「${settings.watermarkText.trim()}」`;
	}

	private describeAuthor(): string {
		const settings = this.plugin.settings;
		if (!settings.authorEnabled) {
			return "在正文下方加一条署名（头像 / 名字 / 附加文字）。";
		}
		if (!hasAuthorContent(settings)) {
			return "已开启，但还没填名字、附加文字或头像，导出时不会生效。";
		}
		const parts = [settings.authorName.trim(), settings.authorText.trim()].filter(
			(part) => part.length > 0
		);
		if (settings.authorAvatarPath.trim()) parts.push("含头像");
		return `已开启：${parts.join(" · ")}`;
	}

	private describeHidden(): string {
		const settings = this.plugin.settings;
		if (!settings.hiddenWatermarkEnabled) {
			return "把一段标识写进图片像素的最低位，肉眼不可见；仅 PNG / 无损 PDF 可靠。";
		}
		const text = settings.hiddenWatermarkText.trim();
		return text ? `已开启：写入「${text}」` : "已开启，但隐水印内容为空，导出时不会生效。";
	}

	private addMarginSetting(parent: HTMLElement): void {
		const settings = this.plugin.settings;
		const setting = new Setting(parent).setName("页边距").setDesc("单位 mm，依次为 上 / 右 / 下 / 左。");
		const fields: { label: string; get: () => number; set: (value: number) => void }[] = [
			{ label: "上", get: () => settings.marginTopMm, set: (v) => (settings.marginTopMm = v) },
			{ label: "右", get: () => settings.marginRightMm, set: (v) => (settings.marginRightMm = v) },
			{ label: "下", get: () => settings.marginBottomMm, set: (v) => (settings.marginBottomMm = v) },
			{ label: "左", get: () => settings.marginLeftMm, set: (v) => (settings.marginLeftMm = v) },
		];
		for (const field of fields) {
			const wrap = setting.controlEl.createDiv({ cls: "longshot-margin-item" });
			wrap.createSpan({ text: field.label });
			const input = wrap.createEl("input", {
				type: "number",
				attr: { min: "0", max: "60", step: "1" },
			});
			input.value = String(round(field.get()));
			input.addEventListener("change", () => {
				const value = clamp(Math.round(Number(input.value) || 0), 0, 60);
				input.value = String(value);
				field.set(value);
				void this.plugin.saveSettings();
			});
		}
	}

	private openPluginSettings(): void {
		this.close();
		const setting = (this.app as unknown as {
			setting?: { open(): void; openTabById(id: string): void };
		}).setting;
		if (!setting) return;
		setting.open();
		setting.openTabById(this.plugin.manifest.id);
	}
}

export interface ConfirmOptions {
	title: string;
	message: string;
	confirmText?: string;
	cancelText?: string;
}

/** 简易确认框（用于「渲染超时，是否仍然导出」这类询问） */
export class ConfirmModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly opts: ConfirmOptions,
		private readonly done: (value: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);
		this.contentEl.createEl("p", { text: this.opts.message });
		const footer = this.contentEl.createDiv({ cls: "longshot-modal-footer" });
		const cancel = footer.createEl("button", { text: this.opts.cancelText ?? "取消导出" });
		cancel.addEventListener("click", () => this.settle(false));
		const confirm = footer.createEl("button", {
			text: this.opts.confirmText ?? "仍然导出",
			cls: "mod-cta",
		});
		confirm.addEventListener("click", () => this.settle(true));
	}

	onClose(): void {
		this.contentEl.empty();
		// 用 Esc 或点遮罩关闭时按「取消」处理，避免调用方一直等下去
		this.settle(false);
	}

	private settle(value: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.done(value);
		this.close();
	}
}

export function confirmDialog(app: App, opts: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, opts, resolve).open();
	});
}