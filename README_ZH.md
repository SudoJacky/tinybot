# Tinybot

<p align="center">
  <img src="./public/assets/readme-hero.svg" width="100%" alt="Tinybot — 个人 AI，原生工具。">
</p>

[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![License](https://img.shields.io/badge/License-MIT-green?logo=opensourceinitiative&logoColor=white)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/SudoJacky/tinybot?style=social&logo=github)](https://github.com/SudoJacky/tinybot/stargazers)
[![GitHub Clones](https://img.shields.io/badge/dynamic/json?color=success&label=Clone&query=count&url=https://gist.githubusercontent.com/SudoJacky/1ed488e49d2ce0a4af8ce5a63af4396e/raw/clone.json&logo=github)](https://github.com/MShawon/github-clone-count-badge)
[![GitHub Issues](https://img.shields.io/github/issues/SudoJacky/tinybot?logo=github)](https://github.com/SudoJacky/tinybot/issues)
[![GitHub Release](https://img.shields.io/github/v/release/SudoJacky/tinybot?include_prereleases&logo=github)](https://github.com/SudoJacky/tinybot/releases)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/SudoJacky/tinybot)

> **后端状态：** Tinybot 目前正在实现 Rust 后端，当前并不稳定，未来版本很可能包含破坏性更新。[0.0.18](https://github.com/SudoJacky/tinybot/releases/tag/0.0.18) 是基于 Python 后端的相对稳定版本。

[English](README.md)

Tinybot 是一个由大语言模型和原生工具系统驱动的轻量级个人 AI 助手。

架构和维护文档请从 [Tinybot 工程文档地图](docs/README.md) 开始阅读。

安装 Tinybot 时，请前往 [GitHub Releases](https://github.com/SudoJacky/tinybot/releases)，选择最新发布版本并下载适合当前平台的安装包。

如需参与开发，请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)，了解开发环境初始化和仓库贡献要求。

我们已经支持了Agent graph的编排和高自由度的定义，未来将会支持由Agent负责和调用的Graph。
我们支持了灵动的宠物系统，Tinybot将以宠物的形式在工作中陪伴，同时可以将文字内容拖动给宠物并快速唤起会话，多模态和文件的支持将在未来实现（应该很快）。

<img width="418" height="236" alt="image" src="https://github.com/user-attachments/assets/59ffe250-d52a-4c8f-ad11-ab7ae6e86551" />

<img width="418" height="236" alt="exec-3bccb095-cd9a-4ebb-9f83-9295b1876440" src="https://github.com/user-attachments/assets/3fba12b1-a8e8-4a51-a76b-91e6dcfdc037" />

<img width="418" height="236" alt="exec-bd0be409-9323-425f-931a-e2b7b6d98573" src="https://github.com/user-attachments/assets/66e9e155-44e8-43ef-88a5-ea8cbc35c287" />


## Agent Plugins

从 v0.2.3 开始，Tinybot 支持 [Agent Plugins 1.0.0 标准](https://agent-plugins.org/)。你可以在 **工具与插件** 页面导入想要使用的插件目录。Tinybot 默认内置并启用 `create-agent-plugin`，因此可以直接通过 **迁移 Skill 或 MCP** 把现有 Skill 或 MCP 配置转换为插件，无需另行下载辅助插件。

<img width="480" height="314" alt="image" src="https://github.com/user-attachments/assets/efe401da-826b-4203-a158-d3d0c30293b3" />

## 自定义图表

Tinybot 可以提供自定义的图表。

<img width="480" height="374" alt="image" src="https://github.com/user-attachments/assets/3345c7f4-65c4-4464-aebf-b5ca491edea7" />

## 在另一个会话中继续

<img width="455" height="277" alt="image" src="https://github.com/user-attachments/assets/0af9df84-b254-469a-9ebd-2f7e866c66eb" />
