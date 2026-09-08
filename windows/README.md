# Windows 安装

如果这个项目对你有帮助，欢迎点一个 Star，支持后续兼容维护。

## 环境要求

- Windows 10 / 11，官方 Codex Desktop Store 版，至少打开过一次。
- 源码安装需要 Node.js 22 or newer（Node.js 22 或更新版本）。
- PowerShell 5.1 或更新版本；无需管理员权限。
- 当前安装包内置 x64 Node.js，不宣称已完成原生 ARM64 安装包验收。

## 安装与使用

1. 安装前保存工作并退出所有 Codex 窗口及已有 Dream Skin 托盘。
2. 在仓库目录打开 PowerShell，运行 `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned`，然后运行 `& ".\windows\scripts\install-dream-skin.ps1"`。
3. 使用生成的 **Codex Dream Skin** 桌面或开始菜单快捷方式打开 Codex。
4. 在应用内主题中心导入图片、GIF、MP4/WebM、主题 ZIP，切换/删除主题、选择存储目录；设置会保存。
5. 想用普通 Codex 图标打开后也自动注入，在系统托盘勾选 **普通启动自动注入（仅空闲时重启）**；再勾选 **登录时启动**，电脑重启后同样生效。

已正常注入时不会反复重注入。普通启动先留 10 秒启动时间；有任务运行、无法确认空闲或实例身份不明确时，不自动重启。一次尝试后锁定，防止重启循环。暂停会保留，Codex 关闭时不会被自动拉起。视频后台播放默认关闭，降低资源消耗。

用户状态默认在 `%LOCALAPPDATA%\CodexDreamSkin`。`theme-windows.ps1` 是内部函数库，不是交互菜单。

视频导入、视频封面和部分缩略图转换需要 `ffmpeg.exe` 在 PATH 中；缺失时会明确报错并保留原主题，不会假装导入成功。

恢复原生外观且保持 Codex 关闭：在 PowerShell 运行 `& ".\windows\scripts\restore-dream-skin.ps1" -RestoreBaseTheme -NoRelaunch`。

## 更新和完整说明

更新检查指向 `Mars535821089-ops/Codex-Dynamic-Skin-System`，配置在 `repository.json`，不会静默安装更新。

详见 [完整安装、安全说明与验证边界](../docs/install-windows.md) 和 [English](README.en.md)。
