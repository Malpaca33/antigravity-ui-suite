# Antigravity UI Suite

English | [简体中文](README.zh-CN.md)

**UI enhancement suite for Google Antigravity, containing two standalone components:**

1. **Usage HUD**: Zero-click topbar status strip for subagents, context window, generation speed, and dual-pool battery quota.
2. **Font Studio**: Sidecar typography panel for per-region English & Chinese font selection, live preview, and instant hot-apply.

---

## Quick Start

### 1. Requirements
- macOS (Apple Silicon / Intel)
- Google Antigravity 2.0+
- Node.js 18+

### 2. Install & Enable
```bash
git clone https://github.com/Malpaca33/antigravity-ui-suite.git /tmp/ag-ui-suite
mkdir -p ~/.gemini/config/plugins/usage-monitor ~/.gemini/config/plugins/font-studio
cp -r /tmp/ag-ui-suite/plugin.json /tmp/ag-ui-suite/pricing-catalog.json /tmp/ag-ui-suite/assets /tmp/ag-ui-suite/sidecars ~/.gemini/config/plugins/usage-monitor/
cp -r /tmp/ag-ui-suite/font-studio/* ~/.gemini/config/plugins/font-studio/
```

Enable both plugins in `~/.gemini/config/config.json` and restart Antigravity:
```json
{
  "plugins": {
    "usage-monitor": { "enabled": true },
    "font-studio": { "enabled": true }
  }
}
```

### 3. Uninstall & Rollback
- Click **Reset** in the **Font Studio** panel to restore native typography immediately.
- Set `"enabled": false` in `~/.gemini/config/config.json` and restart Antigravity to disable either plugin.

### 4. Acknowledgements & License
- Forked and extended from [yuhuan-dev/antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor) — thanks to the original author for the topbar HUD architecture and telemetry engine.
- Licensed under [LICENSE](LICENSE). Third-party proprietary fonts (e.g., Anthropic fonts) are **not bundled** in this repository.

---

## Part 1: Antigravity Usage HUD

![Antigravity Usage HUD Topbar](assets/hud-topbar.png)

---

## 1. Dual-Pool Battery Toggle (`Gemini` ↔ `Claude & GPT`)

- The battery on the right shows your **5-hour quota** (7 cells, ~14% each) inside and your **weekly quota** as the retro-red outer border ring.
- The battery automatically binds to the model currently selected in the bottom-left picker and switches pools immediately when you change models (falling back to the active conversation model).
- **Only the battery is clickable**: click it once to switch in place between **`Gemini` (deep green)** and **`Claude & GPT` (pure white)** — zero layout shift, no popup panel, and hovering context or speed will not light up.

| Pool | Live Topbar HUD |
| :--- | :--- |
| **`Gemini` Pool**<br>*(Deep Green 7-cell battery + red weekly ring)* | ![Gemini Pool Battery](assets/hud-battery-gemini.png) |
| **`Claude & GPT` Pool**<br>*(Click battery to toggle in place — Pure White 7-cell battery + red weekly ring)* | ![Claude & GPT Pool Battery](assets/hud-battery-claude.png) |

---

## 2. Speed Color Tiers & Context Ring States

Everything updates in place for the **active window only**:

- **Dot-Matrix Speed (`t/s`) + Model Sublabel**:
  - `< 46 t/s`: neutral dark/white (shown in the `11.8 t/s · Argon 4-medium` capture above)
  - `46 – 99 t/s`: **deep green** (`#148838`, shown in the `94.4 t/s` banner at the top)
  - `100 – 179 t/s`: **deep orange** (`#c2410c`, shown in the `122 t/s` capture above)
  - `≥ 180 t/s`: **deep purple** (`#7e22ce`)
- **2× Context Ring + Window Capacity (`256k` / `512k` / `1M`)**:
  - Normal (`< 70%`): blue ring (`20%` / `34%` above)
  - Warning (`70% – 87%`): orange ring (`87%` below)
  - Critical (`≥ 88%`): red ring (`93%` above)
- **New Chat Auto-Reset**: Switching to a New Conversation immediately clears context (`0%`) and speed (`待命`) so previous chats never leak over.

---

## 3. Single-Window Subagent Stream (Left Pill)

The left pill (`0 子代理` / `2 子运行`) tracks only the current window's main agent and subagents. Hover or click it to view the live subagent stream:

![Subagent Live Stream Panel](assets/hud-subagent-panel.png)

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

Enable `usage-monitor` under **Customizations -> Installed** in Antigravity.

> **Required for Antigravity v2.33.0+ (CDP disabled by default):**  
> Newer Antigravity builds disable the remote debugging port by default and clean stale `DevToolsActivePort` files on launch. Quit Antigravity and start it with `--remote-debugging-port=0` so the topbar HUD can attach:
> ```bash
> # macOS
> open -a "/Applications/Antigravity.app" --args --remote-debugging-port=0
> ```
> *(Topbar-only mode is enabled by default; to restore the right auxiliary panel, set `has_web_ui: true` and restore `ui_config` in `sidecars/panel/sidecar.json`.)*

---

## Credits & License

Redesigned from [yuhuan-dev/antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor) under [GPL-3.0](LICENSE).


---

## Part 2: Font Studio (Per-Region Typography Plugin)

Located in [`font-studio/`](font-studio/), running as a standalone Antigravity sidecar panel.

![Font Studio Panel](assets/font-studio-panel.png)

### Key Features

- **Four Independent UI Regions**:
  - Sidebar & UI
  - Chat Body
  - Input Box
  - Code & Terminal
- **Separate English & Chinese Stacks**:
  - Uses `unicode-range` to pair Latin fonts (`Google Sans`, `Anthropic Sans`, `Anthropic Serif Text`, `Inter`) with Chinese fonts (`PingFang SC Medium/Regular/Semibold`, `Songti SC`, `Sarasa Mono Slab SC`, `Sarasa UI SC`).
- **Pill-Based Live Preview**:
  - Uses inline pill selectors instead of native dropdowns to avoid focus loss in Electron webviews.
  - Updates the inline preview inside each card immediately on click.
- **One-Click Hot Apply & Reset**:
  - Click **Apply** to write `theme.css` and hot-inject into the active Antigravity window via CDP.
  - Click **Reset** to restore native default fonts immediately.
