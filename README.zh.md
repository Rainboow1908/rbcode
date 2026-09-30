# RB Code

跑在浏览器里的 AI 编程助手，可以接上本机执行器，真正读写文件、执行命令。

[English](README.md)

## 能做什么

- 连接模型（OpenAI 兼容接口或 Anthropic），让它读、改、新建项目里的文件。
- 执行命令；删除这类危险操作会先征求同意，文件改动可以撤销、回退。
- 三种执行后端：浏览器沙箱（只有文件工具）、Windows 桌面执行器、安卓 App。
- 长对话会自动压缩历史，上下文不会被撑爆。
- Mermaid 流程图、LaTeX 数学公式、代码高亮、内置终端。
- 语音输入，以及把回答念出来。
- 多套主题（默认深色 / 浅色 / 极光 / OreUI）。

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `web/` | 网页前端（React + Vite）与托管它的 Cloudflare Worker |
| `companion/` | Windows 桌面执行器（Tauri + Rust） |
| `android/` | 安卓 App（Java，自带 Linux 环境执行命令） |

## 快速开始

网页端：

```
cd web
npm install
npm run dev
```

打开后进 设置 → 模型服务，添加提供商、填 API Key、选模型。

桌面执行器（Windows）：

```
cd companion
npm install
npm run tauri:dev
```

打包安装包用 `powershell -File build.ps1`；装好后把它窗口里的令牌填到 设置 → 执行后端。

安卓 App：

```
cd android
gradle assembleRelease
```

Linux 根文件系统不随仓库分发：构建前把 arm64 的 `ubuntu-base-*.tar.gz` 和 Termux 的 `proot` 等依赖放进 `android/linux-assets/`。正式签名需要自备 keystore（`android/app/keystore.properties`）。

## 许可

AGPL-3.0-or-later，见 [LICENSE](LICENSE)。

第三方组件保留各自许可，清单见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
