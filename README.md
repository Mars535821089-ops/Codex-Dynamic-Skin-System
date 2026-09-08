# Codex Dynamic Skin System

如果这个项目让你的 Codex 工作区更舒服，欢迎点一个 Star，让更多人更容易找到它。

Codex Dynamic Skin System 是一个面向 Codex Desktop 的跨平台动态主题中心。它只负责主题导入、校验、存储、切换和渲染，不包含个人资料统计、会话克隆或其他私人增强功能。

## 支持能力

- macOS 与 Windows 独立安装和注入
- 图片主题：PNG、JPEG、WebP
- 动图主题：GIF
- 视频主题：MP4、WebM，并提供音频与后台播放策略
- 主题包结构校验、安全 CSS 校验、路径越界防护和媒体尺寸限制
- 页面切换、React 根节点重建后自动恢复主题层，避免运行中主题消失或重复叠加
- 自动修复完全由本地程序执行，不调用模型或供应商 API，也不消耗 Token；若选择允许自动重启，只有确认当前没有运行任务时才会重启，活动状态不明时一律不重启
- 出错时保留原生界面，可验证、可恢复

为了避免 Codex 在后台持续占用 GPU/CPU，视频的“后台播放”默认关闭。只有明确打开该选项后，下次重启 Codex 才会启用完整的后台播放能力；开启后会增加资源占用。

## 验证状态

当前是已完成跨平台源码 Review 和自动化合同验证的发布候选版。macOS 已在隔离实例中验证注入、媒体渲染、页面切换恢复与长时低占用；Windows 安装、注入、恢复、卸载和便携性边界已通过源码审查与自动化回归。由于当前没有 Windows 真机，未在 Windows 10/11 的真实 Codex UI 和签名安装包上执行；这是验证范围披露，不是已知的源码缺陷。首次使用仍建议在测试环境评估。

自动化测试和 CI 配置不等于实机通过。首次安装或升级前请保存工作；真实验收仅连接独立测试实例。

## 快速开始

### macOS

1. 无需另行安装 Node.js；安装器使用官方 Codex 内置并经过签名校验的 Node.js 运行时。
2. 下载仓库后运行 `macos/Install Codex Dream Skin.command`。
3. 使用 `macos/Customize Codex Dream Skin.command` 导入或切换主题。
4. 如需撤销，运行 `macos/Restore Codex Dream Skin.command`；该显式恢复入口会还原安装前的基础主题，并在完成后重新打开 Codex。

### Windows

1. 安装 Node.js 22 或更高版本。
2. 在 PowerShell 中运行 `windows/scripts/install-dream-skin.ps1`。
3. 安装完成后，使用系统托盘中的 **Codex Dream Skin** 菜单导入、切换或暂停主题。
4. 如需完整撤销并保持 Codex 关闭，运行 `& ".\windows\scripts\restore-dream-skin.ps1" -RestoreBaseTheme -NoRelaunch`。

详细步骤见 [macOS 安装说明](docs/install-macos.md) 与 [Windows 安装说明](docs/install-windows.md)。

## 开发与验证

同步平台运行时：

```bash
node tools/sync-runtime-assets.mjs
node tools/sync-runtime-assets.mjs --check
```

运行便携测试：

```bash
node --test tools/*.test.mjs tools/tests/*.test.mjs macos/tests/*.test.mjs windows/tests/*.test.mjs
```

真实 Codex 验收应在独立测试实例中进行，不要连接正在工作的主实例。

## 安全边界

注入器不修改 `app.asar`，主题包按白名单格式解析，导入失败不会覆盖上一个可用主题。首次使用前仍建议阅读 [SECURITY.md](SECURITY.md)。

## License

见 [LICENSE](LICENSE)。
