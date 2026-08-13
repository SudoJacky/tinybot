# Tinybot

<p align="center">
  <img src="./public/assets/logo.svg" width="96" alt="Tinybot logo">
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

一些项目中组件的设计思路文档： [Tinybot Design Docs](https://sudojacky.github.io/#/docs/tinybot)

安装 Tinybot 时，请前往 [GitHub Tags](https://github.com/SudoJacky/tinybot/tags)，选择最新版本并下载适合当前平台的安装包。

<img width="558" height="314" alt="image" src="https://github.com/user-attachments/assets/59ffe250-d52a-4c8f-ad11-ab7ae6e86551" />

<img width="597" height="348" alt="应用截图" src="https://github.com/user-attachments/assets/e78f6ddd-3d7b-43eb-beb5-d3628d846e82" />

## Agent Plugins

从 v0.2.3 开始，Tinybot 支持 [Agent Plugins 1.0.0 标准](https://agent-plugins.org/)。你可以在 **工具与插件** 页面导入想要使用的插件目录。Tinybot 默认内置并启用 `create-agent-plugin`，因此可以直接通过 **迁移 Skill 或 MCP** 把现有 Skill 或 MCP 配置转换为插件，无需另行下载辅助插件。

<img width="681" height="445" alt="image" src="https://github.com/user-attachments/assets/efe401da-826b-4203-a158-d3d0c30293b3" />

## 自定义图表

Tinybot 可以提供自定义的图表。

<img width="960" height="747" alt="image" src="https://github.com/user-attachments/assets/3345c7f4-65c4-4464-aebf-b5ca491edea7" />

## Continue in another conversation

<img width="683" height="415" alt="image" src="https://github.com/user-attachments/assets/0af9df84-b254-469a-9ebd-2f7e866c66eb" />
