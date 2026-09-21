import { App, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type LongshotPdfPlugin from "./main";
import { describeTarget, resolveOutputTarget } from "./files";
import {
	AUTHOR_TEMPLATES,
	AVATAR_FIT_LABELS,
	AVATAR_SHAPE_LABELS,
	AVATAR_ZOOM_MAX,
	WATERMARK_ANCHOR_LABELS,
	WATERMARK_FONT_LABELS,
	WATERMARK_LAYOUT_LABELS,
	anchorToOffset,
	applyAuthorStyle,
	authorStyleOf,
	resolvePaperSize,
	resolveQualityDpi,
	type AlignMode,
	type AvatarFit,
	type AvatarShape,
	type CaptureBackground,
	EXPORT_FORMAT_LABELS,
	EXPORT_TYPE_LABELS,
	type ExportFormat,
	type ExportMode,
	type ExportType,
	type ImageFormat,
	type LongshotSettings,
	PAPER_LABELS,
	type PaperId,
	QUALITY_LABELS,
	type QualityLevel,
	type RenderTheme,
	type WatermarkAnchor,
	type WatermarkFont,
	type WatermarkLayout,
} from "./settings";
import {
	authorBandMm,
	buildAuthorPreviewSpec,
	buildWatermarkSpec,
	drawAuthorPreview,
	drawAuthorThumb,
	drawWatermarkPreview,
	loadImage,
	type AuthorPreviewSize,
	type WatermarkPreviewSize,
} from "./watermark";
import { createAvatarCropEditor } from "./crop";
import { clamp } from "./utils";

/** 设置页水印预览画布的显示宽度（CSS px） */
const PREVIEW_WIDTH = 240;

export class LongshotSettingTab extends PluginSettingTab {
	private readonly plugin: LongshotPdfPlugin;
	/** 当前选中的分栏；重新渲染（如切换纸张尺寸）后仍停留在这一栏 */
	private activeTab = "capture";
	/** 作者信息里最近套用的样式模板 id（不持久化，仅用于让下拉框记住选择） */
	private authorTemplateId: string | null = null;
	private foldState = new Map<string, boolean>();
	private renderedTab = "";

	constructor(app: App, plugin: LongshotPdfPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		// 在清空 DOM 前记录内层滚动栏和宿主滚动位置；同步恢复，避免跳顶闪烁。
		const sameTab = this.renderedTab === this.activeTab;
		const scrolls: { el: HTMLElement; top: number; left: number }[] = [];
		for (let el: HTMLElement | null = containerEl; el; el = el.parentElement) {
			scrolls.push({ el, top: el.scrollTop, left: el.scrollLeft });
		}
		const inner = Array.from(containerEl.querySelectorAll<HTMLElement>(".longshot-split-settings, .longshot-split-preview"))
			.map(el => ({ selector: el.classList.contains("longshot-split-settings") ? ".longshot-split-settings" : ".longshot-split-preview", top: el.scrollTop }));
		for (const detail of containerEl.querySelectorAll<HTMLDetailsElement>("details[data-fold]")) {
			this.foldState.set(detail.dataset.fold!, detail.open);
		}
		containerEl.empty();
		containerEl.addClass("longshot-settings");
		containerEl.createEl("p", {
			text: "把笔记按阅读视图的样式渲染成长图，再自动分页、缩放并排版到纸张上，导出 PDF / 分页图片。",
			cls: "setting-item-description",
		});

		const tabs: { id: string; label: string; icon: string; render: (parent: HTMLElement) => void }[] = [
			{ id: "capture", label: "截图", icon: "camera", render: (parent) => this.renderCapture(parent) },
			{ id: "paper", label: "纸张", icon: "file-text", render: (parent) => this.renderPaper(parent) },
			{ id: "header", label: "页眉页脚", icon: "layout-template", render: (parent) => this.renderHeaderFooter(parent) },
			{ id: "pagination", label: "分页", icon: "scissors", render: (parent) => this.renderPagination(parent) },
			{ id: "watermark", label: "水印", icon: "droplet", render: (parent) => this.renderWatermark(parent) },
			{ id: "output", label: "输出", icon: "download", render: (parent) => this.renderOutput(parent) },
		];
		const active = tabs.find((tab) => tab.id === this.activeTab) ?? tabs[0];

		const tabBar = containerEl.createDiv({ cls: "longshot-tabs" });
		for (const tab of tabs) {
			const button = tabBar.createEl("button", { cls: "longshot-tab" });
			setIcon(button.createSpan({ cls: "longshot-tab-icon" }), tab.icon);
			button.createSpan({ text: tab.label });
			button.toggleClass("is-active", tab.id === active.id);
			button.addEventListener("click", () => {
				if (this.activeTab === tab.id) return;
				this.activeTab = tab.id;
				this.display();
			});
		}

		active.render(containerEl.createDiv({ cls: "longshot-tab-body" }));
		this.renderedTab = this.activeTab;
		if (sameTab) {
			for (const pos of inner) {
				const el = containerEl.querySelector<HTMLElement>(pos.selector);
				if (el) el.scrollTop = pos.top;
			}
			for (const { el, top, left } of scrolls) { el.scrollTop = top; el.scrollLeft = left; }
		}
	}

	/** ── 截图 ─────────────────────────────────────────────── */
	private renderCapture(parent: HTMLElement): void {
		const settings = this.plugin.settings;

		this.addNumber(
			parent,
			"渲染宽度",
			"离屏渲染时的内容宽度（CSS px）。它决定排版换行位置与输出清晰度：数值越大，一行容纳的内容越多。",
			() => settings.contentWidth,
			(value) => (settings.contentWidth = value),
			{ min: 320, max: 1600, step: 10 }
		);

		this.addNumber(
			parent,
			"截图倍率",
			"DOM 渲染到画布的像素比。推荐 2–3，越大越清晰、越慢。内容特别长时会自动降级。",
			() => settings.captureScale,
			(value) => (settings.captureScale = value),
			{ min: 1, max: 5, step: 0.5 }
		);

		new Setting(parent)
			.setName("渲染配色")
			.setDesc("截图时使用的主题配色。为了让导出的「纸」更好看，默认用浅色渲染。")
			.addDropdown((dropdown) => {
				const options: Record<RenderTheme, string> = {
					light: "浅色（推荐）",
					dark: "深色",
					theme: "跟随当前主题",
				};
				dropdown.addOptions(options);
				dropdown.setValue(settings.renderTheme);
				dropdown.onChange(async (value) => {
					settings.renderTheme = value as RenderTheme;
					await this.plugin.saveSettings();
				});
			});

		new Setting(parent)
			.setName("截图包含标题")
			.setDesc("把笔记标题按阅读视图的内联标题渲染进截图；若正文里已手写一级标题，可能会出现两个标题。")
			.addToggle((toggle) => {
				toggle.setValue(settings.includeTitle);
				toggle.onChange(async (value) => {
					settings.includeTitle = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(parent)
			.setName("截图底色")
			.setDesc("默认跟随纸张颜色，这样米色 / 深色纸张上不会有突兀的色块。")
			.addDropdown((dropdown) => {
				dropdown.addOptions({
					paper: "跟随纸张颜色（推荐）",
					theme: "跟随主题背景",
				} as Record<CaptureBackground, string>);
				dropdown.setValue(settings.captureBackground);
				dropdown.onChange(async (value) => {
					settings.captureBackground = value as CaptureBackground;
					await this.plugin.saveSettings();
				});
			});

		this.addNumber(
			parent,
			"渲染等待",
			"渲染完成后的额外等待时间（ms），给 Mermaid、数学公式、嵌入笔记留出加载时间。",
			() => settings.settleDelayMs,
			(value) => (settings.settleDelayMs = value),
			{ min: 0, max: 8000, step: 100 }
		);

		this.addNumber(
			parent,
			"渲染等待上限",
			"等待 Mermaid、数学公式、图片、嵌入笔记渲染完成的最长时间（ms）。超时会询问是否仍然导出。",
			() => settings.renderTimeoutMs,
			(value) => (settings.renderTimeoutMs = value),
			{ min: 0, max: 60000, step: 500 }
		);

	}

	/** ── 纸张与页边距 ─────────────────────────────────────── */
	private renderPaper(parent: HTMLElement): void {
		const settings = this.plugin.settings;

		new Setting(parent)
			.setName("纸张尺寸")
			.setDesc("导出 PDF 的页面尺寸。")
			.addDropdown((dropdown) => {
				dropdown.addOptions(PAPER_LABELS);
				dropdown.setValue(settings.paper);
				dropdown.onChange(async (value) => {
					settings.paper = value as PaperId;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		if (settings.paper === "custom") {
			this.addNumber(
				parent,
				"自定义宽度 (mm)",
				"仅在纸张尺寸选择「自定义」时生效。",
				() => settings.customWidthMm,
				(value) => (settings.customWidthMm = value),
				{ min: 50, max: 1000, step: 1 }
			);
			this.addNumber(
				parent,
				"自定义高度 (mm)",
				"仅在纸张尺寸选择「自定义」时生效。",
				() => settings.customHeightMm,
				(value) => (settings.customHeightMm = value),
				{ min: 50, max: 1000, step: 1 }
			);
		}

		new Setting(parent)
			.setName("横向")
			.setDesc("开启后纸张横放（长边为宽）。")
			.addToggle((toggle) => {
				toggle.setValue(settings.landscape);
				toggle.onChange(async (value) => {
					settings.landscape = value;
					await this.plugin.saveSettings();
				});
			});

		this.addNumber(parent, "上边距 (mm)", "正文距纸张上边缘的距离。", () => settings.marginTopMm, (v) => (settings.marginTopMm = v), { min: 0, max: 80, step: 1 });
		this.addNumber(parent, "下边距 (mm)", "正文距纸张下边缘的距离。", () => settings.marginBottomMm, (v) => (settings.marginBottomMm = v), { min: 0, max: 80, step: 1 });
		this.addNumber(parent, "左边距 (mm)", "正文距纸张左边缘的距离。", () => settings.marginLeftMm, (v) => (settings.marginLeftMm = v), { min: 0, max: 80, step: 1 });
		this.addNumber(parent, "右边距 (mm)", "正文距纸张右边缘的距离。", () => settings.marginRightMm, (v) => (settings.marginRightMm = v), { min: 0, max: 80, step: 1 });

		new Setting(parent)
			.setName("纸张颜色")
			.setDesc("页面底色，例如 #ffffff 或 #faf7f0（米色护眼纸）。")
			.addColorPicker((picker) => {
				picker.setValue(settings.paperColor);
				picker.onChange(async (value) => {
					settings.paperColor = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(parent)
			.setName("纸张边框")
			.setDesc("在页面四边加一圈细线（类似信纸边框）。")
			.addToggle((toggle) => {
				toggle.setValue(settings.borderEnabled);
				toggle.onChange(async (value) => {
					settings.borderEnabled = value;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		if (settings.borderEnabled) {
			this.addNumber(parent, "边框线宽 (pt)", "0 表示不画边框。", () => settings.borderWidthPt, (v) => (settings.borderWidthPt = v), { min: 0, max: 6, step: 0.5 });
			this.addNumber(parent, "边框内缩 (mm)", "边框距纸张边缘的距离。", () => settings.borderInsetMm, (v) => (settings.borderInsetMm = v), { min: 0, max: 40, step: 1 });
			new Setting(parent).setName("边框颜色").addColorPicker((picker) => {
				picker.setValue(settings.borderColor);
				picker.onChange(async (value) => {
					settings.borderColor = value;
					await this.plugin.saveSettings();
				});
			});
		}
	}

	/** ── 页眉页脚 ─────────────────────────────────────────── */
	private renderHeaderFooter(parent: HTMLElement): void {
		const settings = this.plugin.settings;

		this.addText(
			parent,
			"页眉模板",
			"留空则不显示。可用变量：{{name}} 笔记名、{{date}} 日期、{{page}} 页码、{{pages}} 总页数。",
			() => settings.headerTemplate,
			(v) => (settings.headerTemplate = v),
			"例如 {{name}}"
		);
		this.addText(
			parent,
			"页脚模板",
			"留空则不显示。可用变量同上，默认是页码。",
			() => settings.footerTemplate,
			(v) => (settings.footerTemplate = v),
			"例如 {{page}} / {{pages}}"
		);

		this.addNumber(parent, "页眉页脚字号 (pt)", "文字大小。", () => settings.footerSizePt, (v) => (settings.footerSizePt = v), { min: 5, max: 24, step: 0.5 });

		new Setting(parent).setName("页眉页脚颜色").addColorPicker((picker) => {
			picker.setValue(settings.footerColor);
			picker.onChange(async (value) => {
				settings.footerColor = value;
				await this.plugin.saveSettings();
			});
		});

		this.addAlignSetting(parent, "页眉对齐", () => settings.headerAlign, (v) => (settings.headerAlign = v));
		this.addAlignSetting(parent, "页脚对齐", () => settings.footerAlign, (v) => (settings.footerAlign = v));
	}

	/** ── 分页 ─────────────────────────────────────────────── */
	private renderPagination(parent: HTMLElement): void {
		const settings = this.plugin.settings;

		new Setting(parent)
			.setName("智能分页")
			.setDesc("优先在块与块的间隙处换页，避免把段落、列表、表格、代码块拦腰截断。")
			.addToggle((toggle) => {
				toggle.setValue(settings.smartBreak);
				toggle.onChange(async (value) => {
					settings.smartBreak = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(parent)
			.setName("避免标题孤行")
			.setDesc("页面末尾只剩一个标题时，把标题挪到下一页。")
			.addToggle((toggle) => {
				toggle.setValue(settings.avoidHeadingOrphan);
				toggle.onChange(async (value) => {
					settings.avoidHeadingOrphan = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(parent)
			.setName("图片不跨页")
			.setDesc("图片、视频等整体推到下一页，避免被拦腰截断；代价是上一页底部可能留白。")
			.addToggle((toggle) => {
				toggle.setValue(settings.avoidSplittingImages);
				toggle.onChange(async (value) => {
					settings.avoidSplittingImages = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(parent)
			.setName("页面填充下限")
			.setDesc("换页时最少要填满页面的比例。数值越大，页面越满、页尾留白越多。")
			.addSlider((slider) => {
				slider.setLimits(0.3, 0.9, 0.05);
				slider.setValue(settings.minFillRatio);
				slider.setDynamicTooltip();
				slider.onChange(async (value) => {
					settings.minFillRatio = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(parent)
			.setName("强制分页标记")
			.setDesc("正文里单独成行写 /// 时，在这一行强制换页。代码块里的 /// 不受影响。")
			.addToggle((toggle) => {
				toggle.setValue(settings.respectForcedBreaks);
				toggle.onChange(async (value) => {
					settings.respectForcedBreaks = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(parent)
			.setName("PDF 书签")
			.setDesc("把笔记里的标题按层级写成 PDF 书签，阅读器侧栏可以直接跳转。")
			.addToggle((toggle) => {
				toggle.setValue(settings.pdfOutline);
				toggle.onChange(async (value) => {
					settings.pdfOutline = value;
					await this.plugin.saveSettings();
				});
			});
	}

	/** ── 水印 / 作者信息 / 隐水印 ──────────────────────────── */
	private renderWatermark(parent: HTMLElement): void {
		const settings = this.plugin.settings;

		// 左右分栏：左边预览，右边设置栏（自己带一条滚动条，互不干扰）
		const split = parent.createDiv({ cls: "longshot-split" });
		const previewCol = split.createDiv({ cls: "longshot-split-preview" });
		const settingsCol = split.createDiv({ cls: "longshot-split-settings" });
		const emptyNote = previewCol.createDiv({
			cls: "longshot-preview-empty",
			text: "开启下面任意一类水印后，这里会显示对应的实时预览。",
		});
		const stack = previewCol.createDiv({ cls: "longshot-preview-stack" });

		const visiblePreview = this.addWatermarkPreview(stack);
		const authorPreview = this.addAuthorPreview(stack);
		const anyPreview = settings.watermarkEnabled || settings.authorEnabled;
		visiblePreview.box.toggleClass("is-hidden", !settings.watermarkEnabled);
		authorPreview.box.toggleClass("is-hidden", !settings.authorEnabled);
		emptyNote.toggleClass("is-hidden", anyPreview);

		// ── 可见水印 ──
		const visible = this.watermarkGroup(settingsCol, {
			id: "visible",
			icon: "droplet",
			title: "可见水印",
			desc: "在每页（或整张长图）上叠加半透明水印：写文字，或者放一张图片。",
			enabled: settings.watermarkEnabled,
			onToggle: (value) => (settings.watermarkEnabled = value),
		});

		if (visible) {
			// 下拉框那几项自己不保存，所以这里统一「先存再刷新」
			const changed = (): void => {
				void this.plugin.saveSettings();
				visiblePreview.refresh();
			};

			this.addText(
				visible,
				"水印文字",
				"可用变量：{{name}} 笔记名、{{title}} 标题、{{date}} 日期、{{author}} 作者名。",
				() => settings.watermarkText,
				(v) => (settings.watermarkText = v),
				"{{name}}",
				changed
			);

			const imageSetting = new Setting(visible)
				.setName("水印图片")
				.setDesc("留空则用上面的文字；填库内相对路径，或点右侧按钮从系统文件里选一张。")
				.addText((text) => {
					text.inputEl.addClass("longshot-path-input");
					text.setPlaceholder("assets/logo.png");
					text.setValue(settings.watermarkImagePath);
					text.onChange(async (value) => {
						settings.watermarkImagePath = value.trim();
						changed();
					});
				})
				.addButton((button) => {
					button.setButtonText("选择图片…").onClick(async () => {
						if (await this.plugin.chooseImageFile("watermark")) {
							this.display();
						}
					});
				})
				.addExtraButton((button) => {
					button
						.setIcon("rotate-ccw")
						.setTooltip("清除图片水印")
						.onClick(async () => {
							settings.watermarkImagePath = "";
							await this.plugin.saveSettings();
							this.display();
						});
				});
			imageSetting.setDesc(
				settings.watermarkImagePath.trim()
					? `当前：${settings.watermarkImagePath.trim()}`
					: "留空则用上面的文字；填库内相对路径，或点右侧按钮从系统文件里选一张。"
			);

			new Setting(visible)
				.setName("排布")
				.setDesc("平铺会在整页斜向重复，单个只在页面上放一处。")
				.addDropdown((dropdown) => {
					dropdown.addOptions(WATERMARK_LAYOUT_LABELS);
					dropdown.setValue(settings.watermarkLayout);
					dropdown.onChange(async (value) => {
						settings.watermarkLayout = value as WatermarkLayout;
						await this.plugin.saveSettings();
						this.display();
					});
				});

			if (settings.watermarkLayout === "center") {
				new Setting(visible)
					.setName("位置")
					.setDesc("水印落在纸张的哪个位置（已自动留出边距，不会被裁掉）。")
					.addDropdown((dropdown) => {
						dropdown.addOptions(WATERMARK_ANCHOR_LABELS);
						dropdown.setValue(settings.watermarkAnchor);
						dropdown.onChange(async (value) => {
							settings.watermarkAnchor = value as WatermarkAnchor;
							changed();
						});
					});
			}

			this.addSlider(
				visible,
				"大小",
				"字号，单位 pt。斜向平铺时通常要开得比单个大一些。",
				() => settings.watermarkSizePt,
				(v) => (settings.watermarkSizePt = v),
				{ min: 6, max: 120, step: 1 },
				changed
			);

			new Setting(visible)
				.setName("字体")
				.setDesc("只影响文字水印。")
				.addDropdown((dropdown) => {
					dropdown.addOptions(WATERMARK_FONT_LABELS);
					dropdown.setValue(settings.watermarkFont);
					dropdown.onChange(async (value) => {
						settings.watermarkFont = value as WatermarkFont;
						changed();
					});
				});

			this.addSlider(
				visible,
				"不透明度",
				"0.08 左右既能看到又不影响阅读。",
				() => settings.watermarkOpacity,
				(v) => (settings.watermarkOpacity = v),
				{ min: 0.02, max: 0.5, step: 0.01 },
				changed
			);
			this.addSlider(
				visible,
				"旋转",
				"单位度，负数表示逆时针倾斜，常用的斜向水印是 -30。",
				() => settings.watermarkRotationDeg,
				(v) => (settings.watermarkRotationDeg = v),
				{ min: -90, max: 90, step: 1 },
				changed
			);

			new Setting(visible).setName("颜色").addColorPicker((picker) => {
				picker.setValue(settings.watermarkColor);
				picker.onChange(async (value) => {
					settings.watermarkColor = value;
					changed();
				});
			});

			if (settings.watermarkImagePath.trim()) {
				this.addSlider(
					visible,
					"图片大小",
					"图片宽度占纸张宽度的比例（平铺时会再缩小一半）。",
					() => settings.watermarkImageScale,
					(v) => (settings.watermarkImageScale = v),
					{ min: 0.05, max: 1, step: 0.05 },
					changed
				);
			}
		}

		// ── 作者信息 ──
		const author = this.watermarkGroup(settingsCol, {
			id: "author",
			icon: "user",
			title: "作者信息",
			desc: "在正文下方加一条署名（头像 / 名字 / 附加文字）；长截图会接在图片底部。",
			enabled: settings.authorEnabled,
			onToggle: (value) => (settings.authorEnabled = value),
		});

		if (author) {
			const preview = authorPreview.refresh;

			this.addText(author, "作者名", "显示在附加文字上方，可用 {{date}} 等变量。", () => settings.authorName, (v) => (settings.authorName = v), "张三", preview);
			this.addText(author, "附加文字", "例如「2026 年 9 月 · 内部资料」。", () => settings.authorText, (v) => (settings.authorText = v), "", preview);

			this.addTemplateGallery(this.addFold(author, "templates", "样式模板 · 选择或保存"), settings);

			const avatarSetting = new Setting(author)
				.setName("头像图片")
				.setDesc("留空则不显示头像；填库内相对路径，或从系统文件里选一张。")
				.addText((text) => {
					text.inputEl.addClass("longshot-path-input");
					text.setPlaceholder("assets/avatar.png");
					text.setValue(settings.authorAvatarPath);
					text.onChange(async (value) => {
						settings.authorAvatarPath = value.trim();
						await this.plugin.saveSettings();
						preview();
					});
				})
				.addButton((button) => {
					button.setButtonText("选择图片…").onClick(async () => {
						if (await this.plugin.chooseImageFile("avatar")) {
							this.display();
						}
					});
				})
				.addExtraButton((button) => {
					button
						.setIcon("rotate-ccw")
						.setTooltip("清除头像")
						.onClick(async () => {
							settings.authorAvatarPath = "";
							await this.plugin.saveSettings();
							this.display();
						});
				});
			avatarSetting.setDesc(
				settings.authorAvatarPath.trim()
					? `当前：${settings.authorAvatarPath.trim()}`
					: "留空则不显示头像；填库内相对路径，或从系统文件里选一张。"
			);

			// 不常改的取景与形状收进独立折叠区。
			const avatarDetails = this.addFold(author, "avatar", "头像取景与形状");
			this.addAvatarCrop(avatarDetails, settings, preview, authorPreview.getImage, authorPreview.onImageLoaded);

			this.addSelect(
				avatarDetails,
				"头像呈现范围",
				"图片不是正方形时怎么放进头像框：裁剪填满不会变形（取景在上面拖），完整显示会四周留白，拉伸会变形。",
				AVATAR_FIT_LABELS,
				() => settings.authorAvatarFit,
				(value) => (settings.authorAvatarFit = value as AvatarFit),
				// 「头像取景」只在裁剪填满时才生效，切换后要重渲染这一栏
				() => this.display()
			);

			this.addSlider(avatarDetails, "头像尺寸 (mm)", "头像的边长。", () => settings.authorAvatarSizeMm, (v) => (settings.authorAvatarSizeMm = v), { min: 3, max: 30, step: 1 }, preview);
			this.addSlider(author, "字号 (pt)", "作者名与附加文字的大小。", () => settings.authorSizePt, (v) => (settings.authorSizePt = v), { min: 6, max: 24, step: 0.5 }, preview);
			this.addSelect(author, "字体", "作者名与附加文字使用的字体。", WATERMARK_FONT_LABELS, () => settings.authorFont, (value) => (settings.authorFont = value as WatermarkFont), preview);
			this.addSelect(avatarDetails, "头像形状", "头像外框的形状；圆角方形看起来更接近名片。", AVATAR_SHAPE_LABELS, () => settings.authorAvatarShape, (value) => (settings.authorAvatarShape = value as AvatarShape), preview);

			new Setting(author).setName("文字颜色").addColorPicker((picker) => {
				picker.setValue(settings.authorColor);
				picker.onChange(async (value) => {
					settings.authorColor = value;
					await this.plugin.saveSettings();
					preview();
				});
			});
			this.addAlignSetting(author, "对齐", () => settings.authorAlign, (v) => (settings.authorAlign = v), preview);

		}

		// ── 隐水印 ──
		const hidden = this.watermarkGroup(settingsCol, {
			id: "hidden",
			icon: "eye-off",
			title: "隐水印（像素级）",
			desc: "把一段标识写进图片像素的最低位，肉眼不可见。仅 PNG 可靠：JPEG 压缩会破坏它。",
			enabled: settings.hiddenWatermarkEnabled,
			onToggle: (value) => (settings.hiddenWatermarkEnabled = value),
		});

		if (hidden) {
			hidden.createEl("p", {
				cls: "longshot-group-note",
				text:
					"开启后 PDF 会改用无损页面（文件更大）。用命令「读取图片里的隐水印」可以校验是否写入成功。",
			});
			this.addText(
				hidden,
				"隐水印内容",
				"可用变量：{{name}} 笔记名、{{title}} 标题、{{date}} 日期、{{author}} 作者名。最长 65535 字节。",
				() => settings.hiddenWatermarkText,
				(v) => (settings.hiddenWatermarkText = v),
				"Longshot PDF · {{name}} · {{date}}"
			);
		}
	}

	/**
	 * 水印设置的分组外壳：标题 + 图标 + 说明 + 右侧开关。
	 * 三组（可见水印 / 作者信息 / 隐水印）各自带一条彩色竖线，展开后一眼能分清。
	 * 返回展开后的内容区；未启用时返回 null。
	 */
	private watermarkGroup(
		parent: HTMLElement,
		opts: {
			id: string;
			icon: string;
			title: string;
			desc: string;
			enabled: boolean;
			onToggle: (value: boolean) => void;
		}
	): HTMLElement | null {
		const section = parent.createDiv({ cls: `longshot-group longshot-group-${opts.id}` });
		const head = section.createDiv({ cls: "longshot-group-head" });
		setIcon(head.createSpan({ cls: "longshot-group-icon" }), opts.icon);
		const text = head.createDiv({ cls: "longshot-group-text" });
		text.createDiv({ cls: "longshot-group-title", text: opts.title });
		text.createDiv({ cls: "longshot-group-desc", text: opts.desc });
		new Setting(head.createDiv({ cls: "longshot-group-toggle" })).addToggle((toggle) => {
			toggle.setValue(opts.enabled);
			toggle.onChange(async (value) => {
				opts.onToggle(value);
				await this.plugin.saveSettings();
				this.display();
			});
		});
		return opts.enabled ? section.createDiv({ cls: "longshot-group-body" }) : null;
	}

	/**
	 * 水印预览：一张按纸张比例缩小的小纸 + 当前设置的水印，用的是导出时同一套绘制代码。
	 * 返回 refresh() 与预览盒子（供左右分栏时按开关显隐）。
	 */
	private addWatermarkPreview(parent: HTMLElement): { refresh: () => void; box: HTMLElement } {
		const box = parent.createDiv({ cls: "longshot-preview-box" });
		const canvas = box.createEl("canvas", { cls: "longshot-preview-canvas" });
		const hint = box.createDiv({ cls: "longshot-preview-hint" });
		const sampleVars = { name: "示例笔记", title: "示例笔记", date: "2026-01-01", author: "作者" };

		/** 已加载图片的缓存，避免每次拖滑块都重新读盘 */
		let cached: { path: string; image: HTMLImageElement | null } | null = null;

		const refresh = (): void => {
			void (async () => {
				const settings = this.plugin.settings;
				const path = settings.watermarkImagePath.trim();
				if (!cached || cached.path !== path) {
					cached = { path, image: path ? await loadImage(this.app, path, () => {}) : null };
				}
				const paper = resolvePaperSize(settings);
				const dpi = resolveQualityDpi(settings.quality);
				const size: WatermarkPreviewSize = {
					widthCss: PREVIEW_WIDTH,
					paperWidthMm: paper.widthMm,
					paperHeightMm: paper.heightMm,
					paperColor: settings.paperColor,
					dpi,
				};
				drawWatermarkPreview(
					canvas,
					buildWatermarkSpec(settings, dpi, sampleVars, cached.image),
					size
				);
				hint.setText(path && !cached.image ? "水印图片加载失败" : "");
				hint.hidden = !hint.textContent;
			})();
		};

		refresh();
		return { refresh, box };
	}

	/**
	 * 作者信息预览：上面一张整页缩小图（署名按真实比例落在底部，用来看它占多少竖向空间），
	 * 下面一条署名带的放大细节（用来看字体、字号、颜色、头像大小与对齐）。
	 * 用的是导出时同一套 buildAuthorSpec + drawAuthorBlock。
	 *
	 * 另外把「当前头像图」和「图片加载完成」的回调暴露出去：裁剪区要拿同一张图来画。
	 */
	private addAuthorPreview(parent: HTMLElement): {
		refresh: () => void;
		box: HTMLElement;
		getImage: () => HTMLImageElement | null;
		onImageLoaded: (listener: () => void) => void;
	} {
		const box = parent.createDiv({ cls: "longshot-preview-box" });
		const canvas = box.createEl("canvas", { cls: "longshot-preview-canvas" });
		const hint = box.createDiv({ cls: "longshot-preview-hint" });
		const sampleVars = { name: "示例笔记", title: "示例笔记", date: "2026-01-01", author: "张三" };

		/** 已加载头像的缓存，避免每次拖滑块都重新读盘 */
		let cached: { path: string; image: HTMLImageElement | null } | null = null;
		const listeners: (() => void)[] = [];

		const refresh = (): void => {
			void (async () => {
				const settings = this.plugin.settings;
				const path = settings.authorAvatarPath.trim();
				let imageChanged = false;
				if (!cached || cached.path !== path) {
					cached = { path, image: path ? await loadImage(this.app, path, () => {}) : null };
					imageChanged = true;
				}
				if (imageChanged) {
					for (const listener of listeners) listener();
				}
				const paper = resolvePaperSize(settings);
				const dpi = resolveQualityDpi(settings.quality);
				// 还没填内容时 authorBandMm 会给 0，这里兜一个下限，署名带在预览里始终看得见
				const previewSpec = buildAuthorPreviewSpec(settings, dpi, sampleVars, cached.image);
				const bandMm = authorBandMm({ ...settings, authorEnabled: true, authorName: previewSpec.name, authorText: previewSpec.text });
				const size: AuthorPreviewSize = {
					widthCss: PREVIEW_WIDTH,
					paperWidthMm: paper.widthMm,
					paperHeightMm: paper.heightMm,
					paperColor: settings.paperColor,
					dpi,
					bandMm,
				};
				drawAuthorPreview(canvas, previewSpec, size);

				hint.setText(path && !cached.image ? "头像加载失败" : "");
				hint.hidden = !hint.textContent;
			})();
		};

		refresh();
		return {
			refresh,
			box,
			getImage: () => cached?.image ?? null,
			onImageLoaded: (listener) => {
				listeners.push(listener);
			},
		};
	}

	/** 原生折叠区支持键盘操作，重绘后保留用户的展开选择。 */
	private addFold(parent: HTMLElement, id: string, title: string): HTMLElement {
		const details = parent.createEl("details", { cls: "longshot-advanced" });
		details.dataset.fold = id;
		details.open = this.foldState.get(id) ?? false;
		details.createEl("summary", { text: title });
		return details.createDiv({ cls: "longshot-advanced-body" });
	}

	/**
	 * 作者信息的样式模板：每个模板一张按导出链路画出来的小样，点一下立即套用。
	 * 模板只含样式（字体 / 字号 / 颜色 / 对齐 / 头像尺寸与形状 / 装饰 / 字重…），
	 * 名字、附加文字与头像仍由用户自己填；自定义模板可以删掉。
	 */
	private addTemplateGallery(parent: HTMLElement, settings: LongshotSettings): void {
		const all = [...AUTHOR_TEMPLATES, ...settings.authorTemplates];
		const currentStyle = authorStyleOf(settings);
		const selectedId = all.find(t => t.id === this.authorTemplateId &&
			Object.entries(currentStyle).every(([key, value]) => t.style[key as keyof typeof currentStyle] === value))?.id
			?? all.find(t => Object.entries(currentStyle).every(([key, value]) => t.style[key as keyof typeof currentStyle] === value))?.id;

		const box = parent.createDiv({ cls: "longshot-templates" });



		const grid = box.createDiv({ cls: "longshot-template-grid" });
		for (const template of all) {
			const card = grid.createDiv({ cls: "longshot-template-card" });
			card.toggleClass("is-active", template.id === selectedId);
			card.tabIndex = 0;
			card.setAttribute("role", "button");
			card.setAttribute("aria-pressed", String(template.id === selectedId));
			card.addEventListener("keydown", event => {
				if (event.target === card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); card.click(); }
			});
			card.setAttribute("aria-label", `套用模板：${template.name}`);
			const thumb = card.createEl("canvas", { cls: "longshot-template-thumb" });
			drawAuthorThumb(thumb, template.style, { name: "Lin", text: "123456@qq.com" });
			const foot = card.createDiv({ cls: "longshot-template-foot" });
			foot.createSpan({ cls: "longshot-template-name", text: template.name });
			if (!template.builtin) {
				foot.createSpan({ cls: "longshot-template-tag", text: "自定义" });
				const remove = foot.createEl("button", { cls: "longshot-template-remove" });
				setIcon(remove, "trash");
				remove.setAttribute("aria-label", `删除模板：${template.name}`);
				remove.addEventListener("click", (event) => {
					event.stopPropagation();
					void (async () => {
						settings.authorTemplates = settings.authorTemplates.filter(
							(item) => item.id !== template.id
						);
						if (this.authorTemplateId === template.id) this.authorTemplateId = null;
						await this.plugin.saveSettings();
						this.display();
					})();
				});
			}
			card.addEventListener("click", () => {
				void (async () => {
					this.authorTemplateId = template.id;
					applyAuthorStyle(settings, template.style);
					await this.plugin.saveSettings();
					this.display();
				})();
			});
		}

		let nameInputEl: HTMLInputElement | null = null;
		new Setting(parent)
			.setName("保存为模板")
			.setDesc("把当前的样式存成模板，以后可以一键套用；同名会覆盖。")
			.addText((text) => {
				nameInputEl = text.inputEl;
				text.inputEl.addClass("longshot-path-input");
				text.setPlaceholder("例如：我的署名");
			})
			.addButton((button) => {
				button.setButtonText("保存").onClick(async () => {
					const name = (nameInputEl?.value ?? "").trim();
					if (!name) {
						new Notice("请先填写模板名称");
						return;
					}
					const style = authorStyleOf(settings);
					const existing = settings.authorTemplates.find((template) => template.name === name);
					if (existing) {
						existing.style = style;
						this.authorTemplateId = existing.id;
					} else {
						const id = `custom-${Date.now()}`;
						settings.authorTemplates = [...settings.authorTemplates, { id, name, style }];
						this.authorTemplateId = id;
					}
					await this.plugin.saveSettings();
					new Notice(`已保存模板「${name}」`);
					this.display();
				});
			});
	}

	/**
	 * 头像取景：直接把图片拖到想要的构图，滚轮缩放，比九宫格下拉更直观。
	 *
	 * 画的是导出时的同一份几何（coverRect + avatarPath），所以这里看到的就是最终头像的样子；
	 * 框外画成半透明，看得见被裁掉了什么。
	 */
	private addAvatarCrop(
		parent: HTMLElement,
		settings: LongshotSettings,
		preview: () => void,
		getImage: () => HTMLImageElement | null,
		onImageLoaded: (listener: () => void) => void
	): void {
		const wrap = parent.createDiv({ cls: "longshot-crop" });
		wrap.createDiv({ cls: "longshot-crop-title", text: "头像取景" });

		if (settings.authorAvatarFit !== "cover") {
			wrap.createDiv({
				cls: "longshot-crop-desc",
				text: "当前「头像呈现范围」不是裁剪填满，取景不生效；切成「裁剪填满」后就能在这里拖动构图。",
			});
			return;
		}

		wrap.createDiv({
			cls: "longshot-crop-desc",
			text: settings.authorAvatarPath.trim()
				? "按住图片拖动取景范围，滚轮缩放；虚线圈外是会被裁掉的部分。"
				: "先在下面选一张头像图片，然后就能在这里拖动取景。",
		});

		const stage = wrap.createDiv({ cls: "longshot-crop-stage" });
		const canvas = stage.createEl("canvas", { cls: "longshot-crop-canvas" });
		stage.createDiv({ cls: "longshot-crop-hint", text: "拖动 · 滚轮缩放" });

		let zoomSlider: { setValue: (value: number) => void } | null = null;

		const editor = createAvatarCropEditor({
			canvas,
			getImage,
			getState: () => ({
				offsetX: settings.authorAvatarOffsetX,
				offsetY: settings.authorAvatarOffsetY,
				zoom: settings.authorAvatarZoom,
			}),
			getShape: () => settings.authorAvatarShape,
			getAccentColor: () => settings.authorAccentColor,
			onInput: (state) => {
				settings.authorAvatarOffsetX = state.offsetX;
				settings.authorAvatarOffsetY = state.offsetY;
				settings.authorAvatarZoom = state.zoom;
				zoomSlider?.setValue(state.zoom);
				preview();
			},
			onCommit: () => {
				void this.plugin.saveSettings();
			},
		});
		// 头像图是异步读进来的：加载完成后让裁剪区重画一次，否则会停在没有图的占位状态
		onImageLoaded(() => editor.refresh());
		editor.refresh();

		new Setting(wrap)
			.setName("取景缩放")
			.setDesc("在「刚好吃满」的基础上放大原图，用来把人物拉近；也可以在图上直接滚轮。")
			.addSlider((slider) => {
				zoomSlider = slider;
				slider.setLimits(1, AVATAR_ZOOM_MAX, 0.05);
				slider.setValue(settings.authorAvatarZoom);
				slider.setDynamicTooltip();
				slider.onChange(async (value) => {
					settings.authorAvatarZoom = value;
					await this.plugin.saveSettings();
					editor.refresh();
					preview();
				});
			})
			.addExtraButton(button => {
				button.setIcon("rotate-ccw").setTooltip("恢复居中、不放大").onClick(async () => {
					settings.authorAvatarOffsetX = 0;
					settings.authorAvatarOffsetY = 0;
					settings.authorAvatarZoom = 1;
					await this.plugin.saveSettings();
					zoomSlider?.setValue(1);
					editor.refresh();
					preview();
				});
			});
	}

	/** ── 输出 ─────────────────────────────────────────────── */
	private renderOutput(parent: HTMLElement): void {
		const settings = this.plugin.settings;

		new Setting(parent)
			.setName("输出清晰度")
			.setDesc("PDF 内页面的像素密度。高 = 300 DPI；内容过宽时会自动下调，避免大幅放大。")
			.addDropdown((dropdown) => {
				dropdown.addOptions(QUALITY_LABELS);
				dropdown.setValue(settings.quality);
				dropdown.onChange(async (value) => {
					settings.quality = value as QualityLevel;
					await this.plugin.saveSettings();
				});
			});

		new Setting(parent)
			.setName("导出类型")
			.setDesc("自动分页：按纸张切成多页；长截图：整篇拼成一张长图，不切分。")
			.addDropdown((dropdown) => {
				dropdown.addOptions(EXPORT_TYPE_LABELS as Record<ExportType, string>);
				dropdown.setValue(settings.exportType);
				dropdown.onChange(async (value) => {
					settings.exportType = value as ExportType;
					await this.plugin.saveSettings();
				});
			});

		new Setting(parent)
			.setName("导出格式")
			.setDesc("PDF；JPG 体积小（推荐）；PNG 无损但文件很大。长截图 + PDF 会得到不切分的超长页面。")
			.addDropdown((dropdown) => {
				dropdown.addOptions(EXPORT_FORMAT_LABELS as Record<ExportFormat, string>);
				dropdown.setValue(settings.exportFormat);
				dropdown.onChange(async (value) => {
					settings.exportFormat = value as ExportFormat;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		if (settings.exportFormat !== "png") {
			new Setting(parent)
				.setName("JPEG 质量")
				.setDesc("0.92 左右比较均衡。")
				.addSlider((slider) => {
					slider.setLimits(0.6, 1, 0.01);
					slider.setValue(settings.jpegQuality);
					slider.setDynamicTooltip();
					slider.onChange(async (value) => {
						settings.jpegQuality = value;
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(parent)
			.setName("输出位置")
			.setDesc(`导出文件的保存文件夹。当前：${describeTarget(resolveOutputTarget(settings, null), null)}`)
			.addButton((button) => {
				button.setButtonText("选择文件夹…").onClick(async () => {
					if (await this.plugin.chooseOutputDir()) {
						this.display();
					}
				});
			})
			.addExtraButton((button) => {
				button
					.setIcon("rotate-ccw")
					.setTooltip("恢复为「跟随笔记所在目录」")
					.onClick(async () => {
						settings.outputDir = "";
						await this.plugin.saveSettings();
						this.display();
					});
			});
		this.addText(
			parent,
			"文件名模板",
			"可用变量：{{name}} 笔记名、{{date}} 日期、{{time}} 时间。",
			() => settings.fileTemplate,
			(v) => (settings.fileTemplate = v),
			"{{name}}"
		);

		// ── 重置 ─────────────────────────────────────────────
		new Setting(parent)
			.setName("恢复默认设置")
			.setDesc("把上面的所有选项重置为插件的默认值。")
			.addButton((button) => {
				button.setButtonText("恢复默认");
				button.setWarning();
				button.onClick(async () => {
					this.plugin.settings = { ...this.plugin.defaults };
					await this.plugin.saveSettings();
					this.display();
				});
			});
	}

	private addText(
		parent: HTMLElement,
		name: string,
		desc: string,
		get: () => string,
		set: (value: string) => void,
		placeholder = "",
		onChanged?: () => void
	): void {
		new Setting(parent)
			.setName(name)
			.setDesc(desc)
			.addText((text) => {
				text.setPlaceholder(placeholder);
				text.setValue(get());
				text.onChange(async (value) => {
					set(value);
					await this.plugin.saveSettings();
					onChanged?.();
				});
			});
	}

	/** 带实时回调的滑块：拖动时既保存设置，也能即时刷新预览 */
	private addSlider(
		parent: HTMLElement,
		name: string,
		desc: string,
		get: () => number,
		set: (value: number) => void,
		opts: { min: number; max: number; step: number },
		onChanged?: () => void
	): void {
		new Setting(parent)
			.setName(name)
			.setDesc(desc)
			.addSlider((slider) => {
				slider.setLimits(opts.min, opts.max, opts.step);
				slider.setValue(get());
				slider.setDynamicTooltip();
				slider.onChange(async (value) => {
					set(value);
					await this.plugin.saveSettings();
					onChanged?.();
				});
			});
	}

	private addNumber(
		parent: HTMLElement,
		name: string,
		desc: string,
		get: () => number,
		set: (value: number) => void,
		opts: { min?: number; max?: number; step?: number } = {}
	): void {
		new Setting(parent)
			.setName(name)
			.setDesc(desc)
			.addText((text) => {
				text.inputEl.type = "number";
				if (opts.min !== undefined) text.inputEl.min = String(opts.min);
				if (opts.max !== undefined) text.inputEl.max = String(opts.max);
				if (opts.step !== undefined) text.inputEl.step = String(opts.step);
				text.setValue(String(get()));
				text.onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed)) return;
					set(parsed);
					await this.plugin.saveSettings();
				});
			});
	}

	private addAlignSetting(
		parent: HTMLElement,
		name: string,
		get: () => AlignMode,
		set: (value: AlignMode) => void,
		onChanged?: () => void
	): void {
		new Setting(parent)
			.setName(name)
			.addDropdown((dropdown) => {
				dropdown.addOptions({ left: "左对齐", center: "居中", right: "右对齐" } as Record<AlignMode, string>);
				dropdown.setValue(get());
				dropdown.onChange(async (value) => {
					set(value as AlignMode);
					await this.plugin.saveSettings();
					onChanged?.();
				});
			});
	}

	/** 下拉选择：立即保存 + 可选回调；选项文字由调用方给的标签表决定 */
	private addSelect(
		parent: HTMLElement,
		name: string,
		desc: string,
		labels: Record<string, string>,
		value: () => string,
		set: (value: string) => void,
		onChanged?: () => void
	): void {
		new Setting(parent)
			.setName(name)
			.setDesc(desc)
			.addDropdown((dropdown) => {
				dropdown.addOptions(labels);
				dropdown.setValue(value());
				dropdown.onChange(async (next) => {
					set(next);
					await this.plugin.saveSettings();
					onChanged?.();
				});
			});
	}
}

/** 旧版字段：导出方式曾是「导出模式 + 图片格式」两个独立设置 */
interface LegacySettings {
	exportMode?: ExportMode;
	imageFormat?: ImageFormat;
	/** 旧版的输出位置是 vault 内相对路径 */
	outputFolder?: string;
	/** 旧版头像只能从九宫格里挑一个裁剪位置 */
	authorAvatarAnchor?: WatermarkAnchor;
}

const LEGACY_KEYS = [
	"exportMode",
	"imageFormat",
	"savePdf",
	"savePageImages",
	"saveLongImage",
	"outputFolder",
	"authorAvatarAnchor",
];

export function normalizeSettings(
	loaded: Partial<LongshotSettings> & LegacySettings,
	fallback: LongshotSettings
): LongshotSettings {
	const merged = { ...fallback, ...loaded };
	// 把旧版的「导出模式 + 图片格式」迁移成「导出类型 + 导出格式」，保留用户原来的选择
	if (loaded.exportMode && loaded.exportType === undefined) {
		merged.exportType = loaded.exportMode === "long" || loaded.exportMode === "longPdf" ? "long" : "paged";
		merged.exportFormat =
			loaded.exportMode === "pdf" || loaded.exportMode === "longPdf"
				? "pdf"
				: loaded.imageFormat === "png"
					? "png"
					: "jpeg";
	}
	// 旧版的输出位置（vault 内相对路径）迁移到新的 outputDir
	if (loaded.outputFolder && loaded.outputDir === undefined) {
		merged.outputDir = loaded.outputFolder;
	}
	// 旧版的九宫格裁剪位置迁移成偏移 + 缩放；用户原来选的落点保持不变
	if (
		loaded.authorAvatarAnchor &&
		loaded.authorAvatarOffsetX === undefined &&
		loaded.authorAvatarOffsetY === undefined
	) {
		const point = anchorToOffset(loaded.authorAvatarAnchor);
		merged.authorAvatarOffsetX = point.x;
		merged.authorAvatarOffsetY = point.y;
	}
	// 数值兜底：手工改坏 data.json 时也不至于让头像跑到框外
	merged.authorAvatarOffsetX = clamp(merged.authorAvatarOffsetX, -1, 1);
	merged.authorAvatarOffsetY = clamp(merged.authorAvatarOffsetY, -1, 1);
	merged.authorAvatarZoom = clamp(merged.authorAvatarZoom, 1, AVATAR_ZOOM_MAX);
	// 模板列表来自 data.json，可能被手工改坏，这里兜一下底
	merged.authorTemplates = Array.isArray(merged.authorTemplates) ? merged.authorTemplates : [];
	for (const key of LEGACY_KEYS) {
		delete (merged as unknown as Record<string, unknown>)[key];
	}
	return merged;
}