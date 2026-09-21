/**
 * 浏览器 harness 用的 obsidian 桩件。
 * harness 只跑纯算法/渲染逻辑，凡是被引到的 obsidian 值都退化成空实现。
 */

interface DomCreateOpts {
	cls?: string | string[];
	text?: string;
}

function applyOpts(el: HTMLElement, opts?: DomCreateOpts): void {
	if (!opts) return;
	if (typeof opts.cls === "string") el.className = opts.cls;
	else if (Array.isArray(opts.cls)) el.className = opts.cls.join(" ");
	if (typeof opts.text === "string") el.textContent = opts.text;
}

/**
 * Obsidian 给 DOM 元素挂的扩展方法。这里只实现被用到的几个，
 * 让 Modal 之类的 UI 代码也能在浏览器里真实跑起来。
 */
const domProto = HTMLElement.prototype as unknown as Record<string, unknown>;
domProto.createEl = function (this: HTMLElement, tag: string, opts?: DomCreateOpts) {
	const el = document.createElement(tag);
	applyOpts(el, opts);
	this.appendChild(el);
	return el;
};
domProto.createDiv = function (this: HTMLElement, opts?: DomCreateOpts) {
	return this.createEl("div", opts);
};
domProto.createSpan = function (this: HTMLElement, opts?: DomCreateOpts) {
	return this.createEl("span", opts);
};
domProto.empty = function (this: HTMLElement) {
	this.replaceChildren();
};
domProto.addClass = function (this: HTMLElement, ...cls: string[]) {
	this.classList.add(...cls);
};
domProto.removeClass = function (this: HTMLElement, ...cls: string[]) {
	this.classList.remove(...cls);
};
domProto.toggleClass = function (this: HTMLElement, cls: string, on: boolean) {
	this.classList.toggle(cls, on);
};
domProto.setText = function (this: HTMLElement, text: string) {
	this.textContent = text;
};

export class TFile {
	path = "";
}
export class TFolder {
	path = "";
}
export class App {}
export class Component {
	load(): void {}
	unload(): void {}
}
export class MarkdownView {}
export class Notice {
	static messages: string[] = [];
	constructor(public message: string) { Notice.messages.push(message); }
	setMessage(message: string): void { this.message = message; Notice.messages.push(message); }
	hide(): void {}
}
export class Plugin {}
export class FuzzySuggestModal {}
export class Menu {}
export class MenuItem {}
export class MarkdownRenderer {}

/** vault 路径归一化：反斜杠转正斜杠、压掉重复与首尾的斜杠 */
export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

/** 图标：只留一个带 data-icon 的 svg，够断言「这一组用了哪个图标」 */
export function setIcon(el: HTMLElement, icon: string): void {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("data-icon", icon);
	el.appendChild(svg);
}

/* ── 控件 ──────────────────────────────────────────────────
   下面这些组件只实现被插件用到的方法，语义与 Obsidian 一致：
   setValue 不触发 onChange，用户交互才触发。 */

type ChangeHandler<T> = (value: T) => unknown;

class TextComponent {
	readonly inputEl: HTMLInputElement;
	private handler: ChangeHandler<string> | null = null;

	constructor(parent: HTMLElement) {
		this.inputEl = document.createElement("input");
		this.inputEl.type = "text";
		parent.appendChild(this.inputEl);
		this.inputEl.addEventListener("input", () => void this.handler?.(this.inputEl.value));
	}

	setPlaceholder(value: string): this {
		this.inputEl.placeholder = value;
		return this;
	}

	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}

	getValue(): string {
		return this.inputEl.value;
	}

	onChange(handler: ChangeHandler<string>): this {
		this.handler = handler;
		return this;
	}
}

class ToggleComponent {
	readonly toggleEl: HTMLInputElement;
	private handler: ChangeHandler<boolean> | null = null;

	constructor(parent: HTMLElement) {
		this.toggleEl = document.createElement("input");
		this.toggleEl.type = "checkbox";
		this.toggleEl.className = "checkbox-container";
		parent.appendChild(this.toggleEl);
		this.toggleEl.addEventListener("change", () => void this.handler?.(this.toggleEl.checked));
	}

	setValue(value: boolean): this {
		this.toggleEl.checked = value;
		return this;
	}

	onChange(handler: ChangeHandler<boolean>): this {
		this.handler = handler;
		return this;
	}
}

class DropdownComponent {
	readonly selectEl: HTMLSelectElement;
	private handler: ChangeHandler<string> | null = null;

	constructor(parent: HTMLElement) {
		this.selectEl = document.createElement("select");
		parent.appendChild(this.selectEl);
		this.selectEl.addEventListener("change", () => void this.handler?.(this.selectEl.value));
	}

	addOption(value: string, display: string): this {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = display;
		this.selectEl.appendChild(option);
		return this;
	}

	addOptions(options: Record<string, string>): this {
		for (const [value, display] of Object.entries(options)) {
			this.addOption(value, display);
		}
		return this;
	}

	setValue(value: string): this {
		this.selectEl.value = value;
		return this;
	}

	getValue(): string {
		return this.selectEl.value;
	}

	onChange(handler: ChangeHandler<string>): this {
		this.handler = handler;
		return this;
	}
}

class SliderComponent {
	readonly sliderEl: HTMLInputElement;
	private handler: ChangeHandler<number> | null = null;

	constructor(parent: HTMLElement) {
		this.sliderEl = document.createElement("input");
		this.sliderEl.type = "range";
		parent.appendChild(this.sliderEl);
		this.sliderEl.addEventListener("input", () => void this.handler?.(Number(this.sliderEl.value)));
	}

	setLimits(min: number, max: number, step: number): this {
		this.sliderEl.min = String(min);
		this.sliderEl.max = String(max);
		this.sliderEl.step = String(step);
		return this;
	}

	setValue(value: number): this {
		this.sliderEl.value = String(value);
		return this;
	}

	setDynamicTooltip(): this {
		return this;
	}

	onChange(handler: ChangeHandler<number>): this {
		this.handler = handler;
		return this;
	}
}

class ButtonComponent {
	readonly buttonEl: HTMLButtonElement;

	constructor(parent: HTMLElement) {
		this.buttonEl = document.createElement("button");
		parent.appendChild(this.buttonEl);
	}

	setButtonText(value: string): this {
		this.buttonEl.textContent = value;
		return this;
	}

	setIcon(icon: string): this {
		this.buttonEl.setAttribute("data-icon", icon);
		return this;
	}

	setTooltip(value: string): this {
		this.buttonEl.title = value;
		return this;
	}

	setWarning(): this {
		this.buttonEl.classList.add("mod-warning");
		return this;
	}

	setCta(): this {
		this.buttonEl.classList.add("mod-cta");
		return this;
	}

	setDisabled(value: boolean): this {
		this.buttonEl.disabled = value;
		return this;
	}

	onClick(handler: () => unknown): this {
		this.buttonEl.addEventListener("click", () => void handler());
		return this;
	}
}

class ColorComponent {
	readonly colorEl: HTMLInputElement;
	private handler: ChangeHandler<string> | null = null;

	constructor(parent: HTMLElement) {
		this.colorEl = document.createElement("input");
		this.colorEl.type = "color";
		parent.appendChild(this.colorEl);
		this.colorEl.addEventListener("input", () => void this.handler?.(this.colorEl.value));
	}

	setValue(value: string): this {
		this.colorEl.value = value;
		return this;
	}

	onChange(handler: ChangeHandler<string>): this {
		this.handler = handler;
		return this;
	}
}

export class Setting {
	readonly settingEl: HTMLElement;
	readonly infoEl: HTMLElement;
	readonly nameEl: HTMLElement;
	readonly descEl: HTMLElement;
	readonly controlEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv({ cls: "setting-item" });
		this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
		this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
		this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
		this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
	}

	setName(name: string): this {
		this.nameEl.setText(name);
		return this;
	}

	setDesc(desc: string): this {
		this.descEl.setText(desc);
		return this;
	}

	setClass(cls: string): this {
		this.settingEl.addClass(cls);
		return this;
	}

	setHeading(): this {
		this.settingEl.addClass("setting-item-heading");
		return this;
	}

	addText(cb: (component: TextComponent) => unknown): this {
		cb(new TextComponent(this.controlEl));
		return this;
	}

	addToggle(cb: (component: ToggleComponent) => unknown): this {
		cb(new ToggleComponent(this.controlEl));
		return this;
	}

	addDropdown(cb: (component: DropdownComponent) => unknown): this {
		cb(new DropdownComponent(this.controlEl));
		return this;
	}

	addSlider(cb: (component: SliderComponent) => unknown): this {
		cb(new SliderComponent(this.controlEl));
		return this;
	}

	addButton(cb: (component: ButtonComponent) => unknown): this {
		cb(new ButtonComponent(this.controlEl));
		return this;
	}

	addExtraButton(cb: (component: ButtonComponent) => unknown): this {
		cb(new ButtonComponent(this.controlEl));
		return this;
	}

	addColorPicker(cb: (component: ColorComponent) => unknown): this {
		cb(new ColorComponent(this.controlEl));
		return this;
	}
}

export class PluginSettingTab {
	readonly containerEl: HTMLElement;

	constructor(
		public readonly app: unknown,
		public readonly plugin: unknown
	) {
		this.containerEl = document.createElement("div");
		this.containerEl.className = "vertical-tab-content";
	}

	display(): void {}
	hide(): void {}
}

/** 够用的 Modal：容器 + 内容区，open() 挂到 body 并触发 onOpen() */
export class Modal {
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	contentEl: HTMLElement;
	titleEl: HTMLElement;

	constructor(public readonly app: unknown) {
		this.containerEl = document.createElement("div");
		this.containerEl.className = "modal-container";
		this.modalEl = document.createElement("div");
		this.modalEl.className = "modal";
		this.contentEl = document.createElement("div");
		this.contentEl.className = "modal-content";
		this.titleEl = document.createElement("h2");
		this.modalEl.appendChild(this.titleEl);
		this.modalEl.appendChild(this.contentEl);
		this.containerEl.appendChild(this.modalEl);
	}

	open(): void {
		document.body.appendChild(this.containerEl);
		this.onOpen();
	}

	close(): void {
		this.onClose();
		this.containerEl.remove();
	}

	onOpen(): void {}
	onClose(): void {}
}

/** Match Obsidian's language API; test pages can select a locale before importing. */
export function getLanguage(): string {
	if (localStorage.getItem("longshot-test-legacy-api")) throw new Error("Language API unavailable");
	return localStorage.getItem("language") ?? "zh";
}
