import { AVATAR_ZOOM_MAX, type AvatarShape } from "./settings";
import { clamp } from "./utils";
import { avatarPath, coverRect } from "./watermark";

export interface AvatarCropState {
	/** -1 贴左上、0 居中、1 贴右下 */
	offsetX: number;
	offsetY: number;
	/** 在「刚好吃满外框」的基础上再放大，1 = 不放大 */
	zoom: number;
}

export interface AvatarCropEditorOptions {
	canvas: HTMLCanvasElement;
	/** 头像图片（还没选图时返回 null，此时只画一个占位外框） */
	getImage: () => HTMLImageElement | null;
	getState: () => AvatarCropState;
	/** 外框形状跟着设置走，改形状时裁的仍是同一块区域 */
	getShape: () => AvatarShape;
	getAccentColor: () => string;
	/** 拖动 / 缩放过程中：更新设置并刷新署名预览（不落盘） */
	onInput: (state: AvatarCropState) => void;
	/** 一次交互结束：落盘保存 */
	onCommit: () => void;
	/** 编辑区边长（CSS px） */
	sizeCss?: number;
}

export interface AvatarCropEditor {
	/** 换图、改形状或设置被别处改动后重画 */
	refresh(): void;
	destroy(): void;
}

const DEFAULT_SIZE_CSS = 176;

/**
 * 可视化的头像裁剪区：直接把图片拖到想要的位置，滚轮缩放。
 *
 * 绘制用的是导出时的同一套几何（coverRect + avatarPath），所以这里看到的
 * 就是最终头像的样子；框外的部分画成半透明，方便判断裁掉了什么。
 */
export function createAvatarCropEditor(opts: AvatarCropEditorOptions): AvatarCropEditor {
	const canvas = opts.canvas;
	const sizeCss = Math.max(80, Math.round(opts.sizeCss ?? DEFAULT_SIZE_CSS));
	const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
	const size = Math.round(sizeCss * dpr);
	canvas.width = size;
	canvas.height = size;
	canvas.style.width = `${sizeCss}px`;
	canvas.style.height = `${sizeCss}px`;

	const ctx = canvas.getContext("2d");
	let dragging = false;
	let moved = false;
	let startPointer = { x: 0, y: 0 };
	let startState: AvatarCropState = { offsetX: 0, offsetY: 0, zoom: 1 };
	let commitTimer = 0;

	const imageSize = (): { iw: number; ih: number } | null => {
		const image = opts.getImage();
		if (!image) return null;
		const iw = image.naturalWidth || image.width;
		const ih = image.naturalHeight || image.height;
		if (iw <= 0 || ih <= 0) return null;
		return { iw, ih };
	};

	const draw = (): void => {
		if (!ctx) return;
		ctx.clearRect(0, 0, size, size);
		const shape = opts.getShape();
		const state = opts.getState();
		const dims = imageSize();
		const accent = opts.getAccentColor();

		// 占位：还没选图片时画一个空外框，告诉用户这里是头像的位置
		if (!dims) {
			ctx.save();
			ctx.strokeStyle = "rgba(127,127,127,0.5)";
			ctx.lineWidth = Math.max(1, dpr);
			ctx.setLineDash([6 * dpr, 4 * dpr]);
			avatarPath(ctx, size / 2 - size * 0.32, size / 2 - size * 0.32, size * 0.64, shape);
			ctx.stroke();
			ctx.restore();
			return;
		}

		const rect = coverRect(dims.iw, dims.ih, size, state.zoom, state.offsetX, state.offsetY);
		const image = opts.getImage();
		if (!image) return;

		// 框外：半透明的原图，看得见被裁掉了什么
		ctx.save();
		ctx.globalAlpha = 0.22;
		ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
		ctx.restore();

		// 框内：最终效果
		ctx.save();
		avatarPath(ctx, 0, 0, size, shape);
		ctx.clip();
		ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
		ctx.restore();

		// 外框描边：强调色一圈 + 外侧一圈浅灰，深浅底图上都看得清
		ctx.save();
		ctx.lineWidth = Math.max(1, 2 * dpr);
		ctx.strokeStyle = "rgba(255,255,255,0.65)";
		avatarPath(ctx, 0, 0, size, shape);
		ctx.stroke();
		ctx.lineWidth = Math.max(1, 1.5 * dpr);
		ctx.strokeStyle = accent;
		ctx.globalAlpha = 0.9;
		ctx.stroke();
		ctx.restore();
	};

	/** 把指针位移换算成偏移：拖的是图片，所以偏移按「可移动余量」的比例反向走 */
	const applyPointerDelta = (clientX: number, clientY: number): void => {
		const dims = imageSize();
		if (!dims) return;
		const rect = coverRect(dims.iw, dims.ih, size, startState.zoom, startState.offsetX, startState.offsetY);
		const overX = Math.max(0, rect.width - size);
		const overY = Math.max(0, rect.height - size);
		const dx = (clientX - startPointer.x) * dpr;
		const dy = (clientY - startPointer.y) * dpr;
		const next: AvatarCropState = {
			offsetX: overX > 0.5 ? clamp(startState.offsetX - (dx * 2) / overX, -1, 1) : startState.offsetX,
			offsetY: overY > 0.5 ? clamp(startState.offsetY - (dy * 2) / overY, -1, 1) : startState.offsetY,
			zoom: startState.zoom,
		};
		if (next.offsetX === opts.getState().offsetX && next.offsetY === opts.getState().offsetY) return;
		moved = true;
		opts.onInput(next);
		draw();
	};

	const onPointerDown = (event: PointerEvent): void => {
		if (!imageSize()) return;
		event.preventDefault();
		dragging = true;
		moved = false;
		startPointer = { x: event.clientX, y: event.clientY };
		startState = { ...opts.getState() };
		try {
			canvas.setPointerCapture(event.pointerId);
		} catch {
			// 合成事件（如无头环境的自动化测试）没有真实指针，抓取会失败，忽略即可
		}
		canvas.classList.add("is-dragging");
	};

	const onPointerMove = (event: PointerEvent): void => {
		if (!dragging) return;
		event.preventDefault();
		applyPointerDelta(event.clientX, event.clientY);
	};

	const endDrag = (event: PointerEvent): void => {
		if (!dragging) return;
		dragging = false;
		canvas.classList.remove("is-dragging");
		try {
			canvas.releasePointerCapture(event.pointerId);
		} catch {
			// 指针已经释放时忽略
		}
		if (moved) opts.onCommit();
	};

	/** 滚轮缩放：结束滚动后再落盘，避免每一格都写一次设置 */
	const onWheel = (event: WheelEvent): void => {
		if (!imageSize()) return;
		event.preventDefault();
		const state = opts.getState();
		const zoom = clamp(state.zoom * Math.exp(-event.deltaY * 0.0015), 1, AVATAR_ZOOM_MAX);
		if (zoom === state.zoom) return;
		opts.onInput({ ...state, zoom });
		draw();
		window.clearTimeout(commitTimer);
		commitTimer = window.setTimeout(() => opts.onCommit(), 400);
	};

	canvas.addEventListener("pointerdown", onPointerDown);
	canvas.addEventListener("pointermove", onPointerMove);
	canvas.addEventListener("pointerup", endDrag);
	canvas.addEventListener("pointercancel", endDrag);
	canvas.addEventListener("wheel", onWheel, { passive: false });

	draw();

	return {
		refresh: draw,
		destroy: () => {
			window.clearTimeout(commitTimer);
			canvas.removeEventListener("pointerdown", onPointerDown);
			canvas.removeEventListener("pointermove", onPointerMove);
			canvas.removeEventListener("pointerup", endDrag);
			canvas.removeEventListener("pointercancel", endDrag);
			canvas.removeEventListener("wheel", onWheel);
		},
	};
}