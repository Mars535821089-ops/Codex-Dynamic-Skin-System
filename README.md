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
- 出错时保留原生界面，可验证、可恢复

## 快速开始

### macOS

1. 安装 Node.js 20 或更高版本。
2. 下载仓库后运行 `macos/Install Codex Dream Skin.command`。
3. 使用 `macos/Customize Codex Dream Skin.command` 导入或切换主题。
4. 如需撤销，运行 `macos/Restore Codex Dream Skin.command`。

### Windows

1. 安装 Node.js 20 或更高版本。
2. 在 PowerShell 中运行 `windows/scripts/install-dream-skin.ps1`。
3. 使用 `windows/scripts/theme-windows.ps1` 管理主题。
4. 如需撤销，运行 `windows/scripts/restore-dream-skin.ps1`。

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
