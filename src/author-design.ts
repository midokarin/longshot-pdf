import type { AuthorSpec } from "./watermark";
import type { AuthorDesign } from "./settings";

/** 每种版式有自己的构图与比例；legacy 留给旧设置和旧自定义模板。 */
export const AUTHOR_DESIGNS: AuthorDesign[] = ["minimal", "terminal", "literary", "blog", "newsletter", "research", "photo", "podcast", "journal", "studio"];

export function designHeight(design: AuthorDesign, unit: number, avatar: number): number {
	const heights: Record<string, number> = { minimal: 3.8, terminal: 7.4, literary: 7.8, blog: 5.6, newsletter: 4.8, research: 6.5, photo: 5.2, podcast: 5.8, journal: 6.6, studio: 6.4 };
	return Math.max((heights[design] ?? 6) * unit, avatar + unit * 2.8);
}

export interface DesignLayout { width: number; height: number; nameWidth: number; textWidth: number; avatar: number; }

export function measureDesign(ctx: CanvasRenderingContext2D, spec: AuthorSpec): DesignLayout {
	const u = spec.sizePx;
	const measure = (text: string, scale: number, weight: number) => {
		ctx.save();
		ctx.font = `${weight} ${u * scale}px ${spec.font}`;
		if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
		const width = ctx.measureText(text).width;
		ctx.restore();
		return width;
	};
	const nameWidth = measure(spec.name, 1.28, spec.nameWeight);
	const textWidth = measure(spec.text, .8, 400);
	const avatar = spec.avatar ? spec.avatarSizePx : 0;
	const inset = ["podcast", "literary", "blog"].includes(spec.design ?? "") ? 7 : 5;
	const width = spec.design === "minimal"
		? Math.max(8 * u, nameWidth + textWidth + avatar + 4.5 * u)
		: Math.max(10 * u, Math.max(nameWidth, textWidth) + avatar + inset * u);
	return { width, height: designHeight(spec.design ?? "minimal", u, avatar), nameWidth, textWidth, avatar };
}

/** 在统一的测量坐标内绘制定制版式。头像仍调用原来的裁剪/形状绘制器。 */
export function paintDesign(
	ctx: CanvasRenderingContext2D, spec: AuthorSpec, layout: DesignLayout,
	paintAvatar: (x: number, y: number, size: number) => void
): void {
	const { width: w, height: h, avatar: a } = layout;
	const u = spec.sizePx, ink = spec.color, accent = spec.accentColor;
	const rect = (x: number, y: number, width: number, height: number, color: string, radius: number | number[] = 0) => {
		ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill();
	};
	const line = (x: number, y: number, x2: number, y2: number, color: string, weight = .055) => {
		ctx.strokeStyle = color; ctx.lineWidth = u * weight; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
	};
	const dot = (x: number, y: number, r: number, color: string) => {
		ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
	};
	const text = (value: string, x: number, y: number, scale = 1, color = ink, weight = 400, align: CanvasTextAlign = "left") => {
		ctx.fillStyle = color; ctx.font = `${weight} ${scale * u}px ${spec.font}`;
		ctx.textBaseline = "middle"; ctx.textAlign = align;
		if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
		ctx.fillText(value, x, y);
	};
	const avatarAt = (x: number) => { if (a) paintAvatar(x, (h - a) / 2 + (spec.design === "terminal" ? .5 * u : 0), a); return x + (a ? a + .85 * u : 0); };
	const name = (x: number, y: number, scale = 1.28, color = ink, align: CanvasTextAlign = "left") => text(spec.name, x, y, scale, color, spec.nameWeight, align);
	const note = (x: number, y: number, color = ink, align: CanvasTextAlign = "left") => {
		ctx.save(); ctx.globalAlpha = spec.textOpacity; text(spec.text, x, y, .8, color, 400, align); ctx.restore();
	};
	switch (spec.design) {
		case "minimal": {
			const x = avatarAt(.6 * u);
			name(x, h / 2, 1);
			const divider = x + layout.nameWidth + .65 * u;
			if (spec.name && spec.text) line(divider, h / 2 - .5 * u, divider, h / 2 + .5 * u, "#b8bec5");
			note(spec.name ? divider + .85 * u : x, h / 2);
			break;
		}
		case "terminal": {
			line(1.2 * u, .85 * u, 4.3 * u, .85 * u, accent, .06);
			text("_", 4.8 * u, .65 * u, .8, accent, 600);
			const x = avatarAt(1.2 * u);
			text(">", x, h * .49, 1.15, accent, 600);
			name(x + 1.3 * u, h * .49, 1.18);
			if (spec.text) text("//", x, h * .73, .8, accent);
			note(x + 1.3 * u, h * .73);
			break;
		}
		case "literary": {
			text("“", 1.1 * u, 2 * u, 4.2, "#a8a0df", 400);
			const x = avatarAt(3.3 * u);
			name(x, h * .42, 1.2);
			note(x, h * .67);
			line(w - 4 * u, h - 1.1 * u, w - 1.2 * u, h - 1.1 * u, accent);
			break;
		}
		case "blog": {
			let x = 1.1 * u;
			if (a) x = avatarAt(x);
			else { text("↗", x + 1.1 * u, h / 2, 1.9, accent, 500, "center"); x += 3.4 * u; }
			name(x, spec.text ? h * .4 : h / 2, 1.12); note(x, h * .67);
			break;
		}
		case "newsletter": {
			// 横线随内容收紧；没有附加文字时，姓名与头像在同一中线上。
			line(.6 * u, .45 * u, w - .6 * u, .45 * u, ink, .045);
			const x = avatarAt(.6 * u);
			name(x, spec.text ? h * .42 : h / 2, 1.14);
			note(x, h * .76);
			break;
		}
		case "research": {
			for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) dot(w - (1 + i * .5) * u, (.8 + j * .5) * u, .045 * u, "#a4b5c4");
			const x = avatarAt(1.15 * u);
			name(x, h * .36, 1.04); note(x, h * .62);
			line(1.15 * u, h - .8 * u, w - 1.15 * u, h - .8 * u, accent, .045);
			line(1.15 * u, h - .58 * u, w - 1.15 * u, h - .58 * u, accent, .025);
			break;
		}
		case "photo": {
			line(.4 * u, h - 1.1 * u, .4 * u, h - 2 * u, accent, .07);
			line(.4 * u, h - 1.1 * u, 1.3 * u, h - 1.1 * u, accent, .07);
			const x = avatarAt(1.25 * u);
			name(x, spec.text ? h * .36 : h / 2, 1.13); note(x, h * .69);
			// 取景框角标。
			line(w - 2 * u, 1.1 * u, w - 1.1 * u, 1.1 * u, accent, .07);
			line(w - 1.1 * u, 1.1 * u, w - 1.1 * u, 2 * u, accent, .07);
			break;
		}
		case "podcast": {
			[.8, 1.6, 2.5, 1.2, 1.9].forEach((v, i) => rect((1.1 + i * .45) * u, (h - v * u) / 2, .22 * u, v * u, accent, .11 * u));
			const x = avatarAt(4.1 * u);
			name(x, spec.text ? h * .4 : h / 2, 1.18); note(x, h * .68);
			break;
		}
		case "journal": {
			ctx.save(); ctx.setLineDash([.13 * u, .3 * u]); line(1 * u, .7 * u, 1 * u, h - .7 * u, "#c7b696", .05); ctx.restore();
			const x = avatarAt(2 * u);
			line(x, h * .51, x + Math.min(layout.nameWidth + .3 * u, w - x - u), h * .51, accent, .075);
			name(x, h * .37, 1.12); note(x, h * .7);
			break;
		}
		case "studio": {
			line(w - 3.2 * u, .75 * u, w - 2.4 * u, 1.55 * u, accent, .13);
			line(w - 2.4 * u, .75 * u, w - 1.6 * u, 1.55 * u, accent, .13);
			const x = avatarAt(1.1 * u);
			name(x, h * .39, 1.28);
			line(x, h * .57, x + 2.4 * u, h * .57, ink, .12);
			note(x, h * .78);
			break;
		}
	}
}
