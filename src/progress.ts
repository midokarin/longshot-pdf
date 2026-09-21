import { Notice } from "obsidian";

/** 单条可更新内容的进度提示，避免刷屏 */
export class ProgressNotice {
	private notice: Notice | null = null;
	private finished = false;

	constructor(private readonly title: string) {}

	update(message: string): void {
		if (this.finished) return;
		const text = `${this.title}\n${message}`;
		if (!this.notice) {
			this.notice = new Notice(text, 0);
			return;
		}
		if (typeof this.notice.setMessage === "function") {
			this.notice.setMessage(text);
		} else {
			this.notice.hide();
			this.notice = new Notice(text, 0);
		}
	}

	/** 暂时收起提示（例如中途弹窗等待用户确认），后续 update 会重新出现 */
	hide(): void {
		this.notice?.hide();
		this.notice = null;
	}

	finish(message: string, timeoutMs = 6000): void {
		this.finished = true;
		this.notice?.hide();
		this.notice = null;
		new Notice(`${this.title}\n${message}`, timeoutMs);
	}

	fail(message: string): void {
		this.finished = true;
		this.notice?.hide();
		this.notice = null;
		new Notice(`${this.title} 失败\n${message}`, 10000);
	}
}