# Sanctum

## Skins

Before changing anything a skin draws (`packages/frontend/src/theme`, `public/skins`, `theme-hedgewitch.css`, or a component's
surface colours), load the `skin-design` skill (`.claude/skills/skin-design/`). It is the only source of skin rules. `.claude/skills/_fenced/` (`cinematic-ui`, `taste-skill`) is fenced: generic design skills, never loaded for any skin, theme, room, frame or layout work. The rules that always hold:

- Every texture, fitting and ornament is cut from that skin's painted mock-up; no drawn SVG look.
- No ivory or light input surface in a skin whose palette has no ivory (only the Library and Hedgewitch are light).
- Every ink keeps its contrast on the worst texture pixel (`texturedPairs`); fix the texture or the ink, never the test.
- Home, the menu and "You" are distinct surfaces in every skin; a selected item takes the skin's own colour. Celestial is
  the owner's exception: its Home cards and Command panels share the navy, told apart from the menu by their gold frame.
- Ember's approved layout is full-window; shared changes must not move an approved skin. Screenshot every skin a change reaches.
- No personal names in the repository, commit messages or PR text; demo content uses Echo and Sam.
