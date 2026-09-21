import { t } from "./i18n";
import { App, Modal, Notice } from "obsidian";
import type { BlockBox } from "./blocks";
import { renderPageThumbnail, type PageRenderSpec } from "./compose";
import {
	boundariesOf,
	nudgeBoundary,
	slicesFromBoundaries,
	type PageSlice,
} from "./paginate";

export interface PaginationPreviewContext {
	/** 截好的长图（缩略图直接从它裁切） */
	source: HTMLCanvasElement;
	/** 页面样式（几何 + 颜色），缩略图按同一套几何绘制 */
	spec: PageRenderSpec;
	/** 自动分页结果，用于「恢复自动分页」 */
	autoSlices: PageSlice[];
	/** 可选的分页断点，用于手动微调 */
	candidates: BlockBox[];
	totalHeight: number;
	/** 每页可容纳的源图高度 */
	capacity: number;
}

interface PageCard {
	root: HTMLElement;
	thumbWrap: HTMLElement;
	label: HTMLElement;
	up: HTMLButtonElement;
	down: HTMLButtonElement;
}

/**
 * 缩略图实际能占用的显示宽度（CSS px）。
 * 按这个宽度绘制，缩略图就能 1:1 落在设备像素上，而不是被浏览器放大后发虚。
 */
function thumbDisplayWidth(wrap: HTMLElement): number {
	const style = getComputedStyle(wrap);
	const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
	const available = wrap.clientWidth - padding;
	// 弹窗还没完成布局时 clientWidth 为 0，退回一个合理默认值
	return available >= 80 ? Math.round(available) : 200;
}

/**
 * 分页预览：逐页显示缩略图，允许把某条断点上/下移到相邻的块边界，
 * 确认后按调整过的分页导出。
 */
export class PaginationPreviewModal extends Modal {
	private slices: PageSlice[];
	private cards: PageCard[] = [];
	private summaryEl: HTMLElement | null = null;
	private settled = false;

	constructor(
		app: App,
		private readonly ctx: PaginationPreviewContext,
		private readonly done: (slices: PageSlice[] | null) => void
	) {
		super(app);
		this.slices = ctx.autoSlices.map((slice) => ({ ...slice }));
	}

	onOpen(): void {
		this.modalEl.addClass("longshot-modal");
		this.modalEl.addClass("longshot-preview");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
		this.settle(null);
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: t("分页预览") });
		contentEl.createEl("p", {
			cls: "longshot-modal-note",
			text:
				t("每页缩略图按真实版心绘制。断点不合适时用「↑ / ↓」把它挪到相邻的块边界；") +
				t("也可以在正文里单独写一行 /// 来强制分页。"),
		});
		this.summaryEl = contentEl.createDiv({ cls: "longshot-modal-note" });

		const grid = contentEl.createDiv({ cls: "longshot-preview-grid" });
		this.cards = [];
		for (let i = 0; i < this.slices.length; i++) {
			this.cards.push(this.createCard(grid, i));
		}

		const footer = contentEl.createDiv({ cls: "longshot-modal-footer" });
		const reset = footer.createEl("button", { text: t("恢复自动分页") });
		reset.addEventListener("click", () => {
			this.slices = this.ctx.autoSlices.map((slice) => ({ ...slice }));
			this.refreshAll();
		});
		const cancel = footer.createEl("button", { text: t("取消") });
		cancel.addEventListener("click", () => this.close());
		const confirm = footer.createEl("button", { text: t("按此分页导出"), cls: "mod-cta" });
		confirm.addEventListener("click", () => this.settle(this.slices));

		this.refreshSummary();
	}

	private createCard(parent: HTMLElement, index: number): PageCard {
		const root = parent.createDiv({ cls: "longshot-preview-card" });
		const thumbWrap = root.createDiv({ cls: "longshot-preview-thumb" });
		const label = root.createDiv({ cls: "longshot-preview-label" });
		const controls = root.createDiv({ cls: "longshot-preview-controls" });
		const up = controls.createEl("button", { text: t("↑ 断点上移") });
		up.addEventListener("click", () => this.nudge(index, "up"));
		const down = controls.createEl("button", { text: t("↓ 断点下移") });
		down.addEventListener("click", () => this.nudge(index, "down"));
		const card: PageCard = { root, thumbWrap, label, up, down };
		this.refreshCard(index, card);
		return card;
	}

	private nudge(index: number, direction: "up" | "down"): void {
		const next = nudgeBoundary(this.slices, index, direction, this.ctx.candidates);
		if (next === null) {
			new Notice(t("这个方向没有更合适的块边界了"));
			return;
		}
		const boundaries = boundariesOf(this.slices);
		boundaries[index] = next;
		this.slices = slicesFromBoundaries(boundaries, this.ctx.totalHeight);
		this.refreshCard(index, this.cards[index]);
		if (index + 1 < this.cards.length) {
			this.refreshCard(index + 1, this.cards[index + 1]);
		}
		this.refreshSummary();
	}

	private refreshAll(): void {
		this.cards.forEach((card, index) => this.refreshCard(index, card));
		this.refreshSummary();
	}

	private refreshCard(index: number, card: PageCard): void {
		const slice = this.slices[index];
		const isLast = index === this.slices.length - 1;
		card.thumbWrap.empty();
		try {
			card.thumbWrap.appendChild(
				renderPageThumbnail(
					this.ctx.source,
					slice,
					this.ctx.spec,
					thumbDisplayWidth(card.thumbWrap)
				)
			);
		} catch {
			card.thumbWrap.createDiv({ cls: "longshot-preview-failed", text: t("缩略图渲染失败") });
		}
		const ratio = (slice.end - slice.start) / Math.max(1, this.ctx.capacity);
		card.label.setText(t("第 {0} 页 · 填充 {1}%", index + 1, Math.round(ratio * 100)));
		card.label.toggleClass("is-overflow", ratio > 1.001);
		// 按「这个方向是否真的有块边界」决定按钮状态，避免点了没反应
		card.up.disabled = nudgeBoundary(this.slices, index, "up", this.ctx.candidates) === null;
		card.down.disabled = nudgeBoundary(this.slices, index, "down", this.ctx.candidates) === null;
		card.up.toggleClass("is-hidden", isLast);
		card.down.toggleClass("is-hidden", isLast);
	}

	private refreshSummary(): void {
		this.summaryEl?.setText(t("共 {0} 页，纸张 {1} × {2} mm", this.slices.length, this.ctx.spec.geometry.paperWidthMm, this.ctx.spec.geometry.paperHeightMm));
	}

	private settle(slices: PageSlice[] | null): void {
		if (this.settled) return;
		this.settled = true;
		this.done(slices);
		this.close();
	}
}

/** 打开分页预览，返回确认后的分页；取消返回 null */
export function previewPagination(
	app: App,
	ctx: PaginationPreviewContext
): Promise<PageSlice[] | null> {
	return new Promise((resolve) => {
		new PaginationPreviewModal(app, ctx, resolve).open();
	});
}
