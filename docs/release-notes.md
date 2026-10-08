Longshot PDF 0.2.5 fixes [#1](https://github.com/midokarin/longshot-pdf/issues/1): inline titles now retain their reading-view color and typography during export. This fixes dark titles on notes with a dark background, including notes styled independently of the app theme. The plugin no longer overrides the title styles supplied by Obsidian, themes or CSS snippets.

The GitHub Actions release includes `main.js`, `manifest.json`, and `styles.css`, with build provenance attestations. Replace these three files to update an existing installation, then reload the plugin.

Longshot PDF 0.2.5 修复了 [#1](https://github.com/midokarin/longshot-pdf/issues/1) 中的内联标题样式问题。导出时会保留标题在阅读视图中的颜色和排版，解决深色背景笔记里的标题变成深色、难以辨认的问题。插件不再覆盖 Obsidian、主题或 CSS 片段提供的标题样式。

此版本由 GitHub Actions 构建，附带 `main.js`、`manifest.json`、`styles.css` 和构建来源证明。更新已有安装时替换这三个文件，再重新加载插件。
