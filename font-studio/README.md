# Font Studio

Antigravity sidecar UI plugin for per-region English & Chinese typography preview and live hot-swapping.

## Features
- **Per-Region Control**: Configure **Sidebar & UI**, **Chat Body**, **Input Box**, and **Code & Terminal** independently.
- **English / Chinese Split**: Pair Latin fonts (`Google Sans`, `Anthropic Sans`, `Anthropic Serif Text`, `Inter`) with Chinese fonts (`PingFang SC Medium/Regular/Semibold`, `Songti SC`, `Sarasa Mono Slab SC`, `Sarasa UI SC`) via `unicode-range`.
- **Live Preview & Instant Apply**: Preview changes inline with pill selectors, then click **Apply** to write `theme.css` and hot-inject into Antigravity via CDP (or **Reset** to restore native defaults).

## Install
Copy `font-studio/` to `~/.gemini/config/plugins/font-studio/` and enable `"font-studio": { "enabled": true }` in `~/.gemini/config/config.json`.
