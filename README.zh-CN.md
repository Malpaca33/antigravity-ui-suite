# Antigravity Usage HUD

[English](README.md) | 简体中文

**Google Antigravity 顶栏极简状态条：不用点开面板，抬头直接看子代理、上下文、推理速度和电池余量。**

![Antigravity Usage HUD 顶栏演示](assets/hud-topbar.png)

## 顶栏各模块与状态变化

就在 Antigravity 主窗口右上角，所有状态随当前对话实时变化：

- **左边状态点 & 子代理面板**：显示当前对话是否在运行、开了几个子代理（如 `0 子代理`、`2 子运行`）；鼠标放上去或点一下可展开当前窗口的子代理实时进度：

  ![子代理实时状态面板](assets/hud-subagent-panel.png)

- **上下文圆环**：显示当前对话上下文占比（常规蓝色，`≥70%` 变橙警告，`≥88%` 变红），下面直接标出总窗口大小（`256k` / `512k` / `1M`）。
- **点阵速度 + 模型名**：实时输出速度（下面紧贴当前模型名），按速度四档自动变色：
  - `< 46 t/s`：白色
  - `46 – 99 t/s`：深正绿
  - `100 – 179 t/s`：深橙色
  - `≥ 180 t/s`：深紫色
- **7 格小电池（右侧唯一可点击区域）**：
  - 里面 7 格（每格约 14%）显示 **5 小时额度**，外圈红框显示 **周限额**。
  - **点一下电池**：原地切换 **`Gemini`（深绿）** 与 **`Claude & GPT`（纯白）**，不展开弹窗；左边上下文和速度不点亮、不可点，切换时位置零移位。
- **新开对话自动归零**：切到 New Conversation 或还没发消息的空对话时，上下文与速度立刻归零（`0%` / `待命`），不会残留上一条对话的数据。

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
