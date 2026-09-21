/**
 * 「空白行」查找器：在截图上沿着纵向找一条几乎全是背景色的行。
 *
 * 分页时优先在这样的位置下刀，切口就不会从文字或图片中间穿过去。
 * 判断方式：先在左右边缘几列上估计背景色，再逐行扫描（横向按步长抽样），
 * 从下往上找连续三行都空的位置，返回最靠下的一条。
 */
export function createBlankRowFinder(
	canvas: HTMLCanvasElement,
	tolerance = 12
): (fromY: number, toY: number) => number | null {
	const ctx = canvas.getContext("2d");
	if (!ctx) return () => null;

	/** 背景色估计：把边缘采样到的颜色按 5 bit 量化后取出现次数最多的那一种 */
	const estimateBackground = (
		data: Uint8ClampedArray,
		width: number,
		height: number
	): [number, number, number] | null => {
		const counts = new Map<number, number>();
		const sampleColumns = [1, 2, 4, width - 3, width - 2];
		for (let y = 0; y < height; y += 2) {
			for (const x of sampleColumns) {
				if (x < 0 || x >= width) continue;
				const p = (y * width + x) * 4;
				const key = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3);
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}
		let best = -1;
		let bestCount = 0;
		for (const [key, count] of counts) {
			if (count > bestCount) {
				bestCount = count;
				best = key;
			}
		}
		return best < 0
			? null
			: [((best >> 10) & 31) << 3, ((best >> 5) & 31) << 3, (best & 31) << 3];
	};

	return (fromY, toY) => {
		const start = Math.max(0, Math.floor(fromY));
		const end = Math.min(canvas.height, Math.ceil(toY));
		if (end - start < 6) return null;

		let image: ImageData;
		try {
			image = ctx.getImageData(0, start, canvas.width, end - start);
		} catch {
			// 跨域图片会污染画布，读不到像素就退化为「找不到空白行」
			return null;
		}
		const { width, height, data } = image;
		const background = estimateBackground(data, width, height);
		if (!background) return null;

		const step = Math.max(1, Math.floor(width / 400));
		const blank = new Uint8Array(height);
		for (let y = 0; y < height; y++) {
			let isBlank = 1;
			for (let x = 0; x < width; x += step) {
				const p = (y * width + x) * 4;
				if (
					Math.abs(data[p] - background[0]) > tolerance ||
					Math.abs(data[p + 1] - background[1]) > tolerance ||
					Math.abs(data[p + 2] - background[2]) > tolerance
				) {
					isBlank = 0;
					break;
				}
			}
			blank[y] = isBlank;
		}

		// 上下相邻两行也要是空的，避免刚好切在笔画的边缘上
		for (let y = height - 2; y >= 1; y--) {
			if (blank[y] && blank[y - 1] && blank[y + 1]) return start + y;
		}
		return null;
	};
}