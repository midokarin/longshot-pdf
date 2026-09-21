Fix plugin review issues without changing PDF export behavior:

- Add the MIT license and explain local file access in both READMEs.
- Remove jsPDF's unused CDN-based viewer from the production bundle.
- Read only the selected PNG for hidden watermark verification instead of listing the vault.
- Replace the `builtin-modules` dependency with Node.js's built-in module list.
- Remove CSS `!important` overrides and unsupported scrollbar styling.
- Build releases in GitHub Actions with provenance attestations. Attach only the three Obsidian installation files.

Direct filesystem access remains available for exporting outside the vault and using local watermark/avatar images. Reload the plugin after updating.

修复审核报告中的脚本创建、样式兼容性和依赖问题，补充 MIT 许可证及中英文文件访问说明。隐水印校验改为仅读取选中的 PNG。发布文件由 GitHub Actions 构建并附带来源证明。

保留库外导出和本机图片读取功能，因此直接文件系统访问的行为提示仍可能出现。更新后请重新加载插件。
