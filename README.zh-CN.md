# Antigravity Usage HUD

[English](README.md) | 简体中文

**Google Antigravity 顶栏极简状态条：不用点开面板，抬头直接看子代理、上下文、推理速度和电池余量。**

![Antigravity Usage HUD 顶栏演示](assets/hud-topbar.png)

## 顶栏里每一块看什么

就在 Antigravity 主窗口右上角：

- **左边状态点**：显示当前对话是否在运行、开了几个子代理（比如 `2 子运行`），鼠标放上去或点一下就能看子代理实时进度。
- **上下文圆环**：显示当前对话上下文用了多少（比如 `20%`），下面直接标出总窗口大小（`256k` / `512k` / `1M`）。
- **点阵速度 + 模型名**：实时输出速度（按快慢分白 / 绿 / 橙 / 紫四档颜色），下面一行小字直接标出当前在用的模型。
- **7 格小电池**：里面一格约 14% 表示 **5 小时额度**，外圈红框表示 **周限额**。**只有电池能点**，点一下就在 `Gemini`（深绿）和 `Claude & GPT`（纯白）之间原地切换；左边上下文和速度不点亮、不弹窗。

---

## 安装

目录名保持为 `usage-monitor`，不用装依赖：

**macOS / Linux**
```bash
git clone https://github.com/Malpaca33/antigravity-usage-hud.git ~/.gemini/config/plugins/usage-monitor
```

**Windows (PowerShell)**
```powershell
git clone https://github.com/Malpaca33/antigravity-usage-hud.git "$env:USERPROFILE\.gemini\config\plugins\usage-monitor"
```

装好后在 Antigravity 左侧 **Customizations -> Installed** 里打开 `usage-monitor` 即可自动显示在顶栏（不改客户端安装包）。  
*需要看历史账单或详细趋势时，仍可从右上角 `⋮ -> Extensions -> 用量监控` 打开原版侧栏面板。*

---

## 致谢与协议

基于 [yuhuan-dev/antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor) 改写，沿用 [GPL-3.0](LICENSE) 开源协议。
