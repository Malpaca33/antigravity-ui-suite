# Antigravity Usage HUD

English | [简体中文](README.zh-CN.md)

**A clean topbar status strip for Google Antigravity — check subagents, context usage, generation speed, and quota battery at a glance without opening any panel.**

![Antigravity Usage HUD](assets/hud-topbar.png)

## What It Shows

Right in the top-right titlebar of Antigravity:

- **Subagent Status (Left)**: Shows whether the current chat is running and how many subagents are active (`0 子代理` / `2 子运行`). Hover or click to see what each subagent is doing.
- **Context Ring**: Shows how much of the context window is used (`20%`) and the total window size (`256k` / `512k` / `1M`) right underneath.
- **Speed & Model**: Dot-matrix `t/s` speed readout (colored white → green → orange → purple by speed tier) with the active model name below it.
- **7-Cell Quota Battery**: Each cell (~14%) tracks the **5-hour window**, and the red outer border tracks the **weekly limit**. **Only the battery is clickable** — click it to switch between `Gemini` (green) and `Claude & GPT` (white) in place.

---

## Install

Keep the folder name as `usage-monitor` (no `npm install` needed):

**macOS / Linux**
```bash
git clone https://github.com/Malpaca33/antigravity-usage-hud.git ~/.gemini/config/plugins/usage-monitor
```

**Windows (PowerShell)**
```powershell
git clone https://github.com/Malpaca33/antigravity-usage-hud.git "$env:USERPROFILE\.gemini\config\plugins\usage-monitor"
```

Then turn on `usage-monitor` under **Customizations -> Installed** in Antigravity.  
*(The original 4-tab sidecar panel is still available from `⋮ -> Extensions -> 用量监控` if you want historical charts.)*

---

## Credits & License

Redesigned from [yuhuan-dev/antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor) under [GPL-3.0](LICENSE).
