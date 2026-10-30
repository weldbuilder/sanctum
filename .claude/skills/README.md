# Project skills

## Sanctum's own

| Folder | Skill name | What it is |
| --- | --- | --- |
| `skin-design/` | `skin-design` | The single source of truth for the eight skins: sources, contrast, geometry, ornaments, frames, menu, backgrounds, per-page rules, and how each texture is cut from its painting. Edit it whenever an approved skin changes. |

For any skin, theme, room, frame or layout work, load `skin-design` only.

## Fenced

`_fenced/` holds two vendored generic skills (`cinematic-ui`, `taste-skill`), fenced 2026-10-30. They are NOT for Sanctum skins and must not be loaded for any skin, theme, room, frame or layout work; some of their house rules (no gradients, no shadows, no indigo, no decorative shapes) contradict the skins. Both are MIT licensed (LICENSE files beside them); upstreams: https://github.com/akseolabs-seo/cinematic-ui (24a66c1) and https://github.com/Leonxlnx/taste-skill (12af471).
