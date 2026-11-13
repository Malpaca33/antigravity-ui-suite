# Antigravity Usage HUD

English | [简体中文](README.zh-CN.md)

**A clean topbar status strip for Google Antigravity — check subagents, context usage, generation speed, and quota battery at a glance without opening any panel.**

![Antigravity Usage HUD](assets/hud-topbar.png)

## What It Shows & How It Changes

Right in the top-right titlebar of Antigravity:

- **Subagent Status (Left)**: Shows whether the current chat is running and how many subagents are active (`0 子代理` / `2 子运行`). Hover or click to expand the live subagent stream for the current window:

  ![Subagent Live Stream Panel](assets/hud-subagent-panel.png)

- **Context Ring**: Shows context percentage (`20%`, turning orange at `≥70%` and red at `≥88%`) and total window size (`256k` / `512k` / `1M`) underneath.
- **Speed & Model**: Dot-matrix `t/s` readout with the active model name below it, colored by speed tier:
  - `< 46 t/s`: white
  - `46 – 99 t/s`: deep green
  - `100 – 179 t/s`: deep orange
  - `≥ 180 t/s`: deep purple
- **7-Cell Quota Battery (Only Clickable Part on the Right)**:
  - Inside: 7 cells (~14% each) for the **5-hour window**.
  - Outside border: retro-red ring for the **weekly limit**.
  - **Click the battery** to toggle in place between **`Gemini`** (deep green) and **`Claude & GPT`** (pure white) — nothing pops open, and hovering context/speed won't light up.
- **New Chat / Empty Route**: Switching to a New Conversation immediately resets context (`0%`) and speed (`待命`) instead of showing the previous chat's numbers.

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

Turn on `usage-monitor` under **Customizations -> Installed** in Antigravity.  
*(The original 4-tab sidecar panel is still available via `⋮ -> Extensions -> 用量监控`.)*

---

## Credits & License

Redesigned from [yuhuan-dev/antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor) under [GPL-3.0](LICENSE).
