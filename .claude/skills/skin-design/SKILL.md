---
name: skin-design
description: Sanctum's rules and workflow for its eight skins (Ember, Moonlit Cloister, Hedgewitch, Oxblood Library, Crimson Velvet, Rain Greenhouse, Celestial, and the room frame they sit in). Use before changing, adding or reviewing anything a skin draws, in any skin, on any screen - a plate's colour, cloth, leather, paper or texture, its corner fittings or rim, a painted ornament (sprig, moon), the menu rail, the chat bar, the selected-item colour, Home cards, the desktop frame, or any shared theme code (packages/frontend/src/theme). Also when a reviewer says a skin looks fake, flat, SVG-like, too dark or off from its mock-up.
---

# Sanctum skin design

Every skin was brought to its painted mock-up one at a time, with the owner reviewing screenshots after each change. These are
the rules that came out of that, and the workflow that keeps them true. The per-skin choices (colours, files, sources) are in
[reference.md](reference.md); the recipes that cut each texture are in `packages/frontend/scripts/skin-art/README.md`.

## The rules

1. **The painting is the source.** Every cloth, leather, paper, fitting and ornament is cut or grown from that skin's painted
   mock-up (the design asset pack; never committed). Never invent a texture, and never draw one in SVG: the flat drawn look
   (vector fleur-de-lis, gradient corner brackets, line-art sprigs) was retired from every skin on purpose. When a mock-up does
   not show a surface (the Library's menu), look for it in that skin's other demo images before borrowing from another skin.
2. **Match the painting's values, not its idea.** Measure before and after: sample the mock-up's plate (mean, 2nd and 98th
   percentile) and the screenshot's, and compare. A texture that reads "fake" has been too bright, too blotchy (large mottling)
   or too uniform; the fix was always the painting's own darker value and its fine grain, with the mottling kept faint.
3. **Only the Library and Hedgewitch are light, paper skins.** Every other skin's fields, chat bar and wizards stay dark,
   including screens outside the skins (the setup wizard is dark leather and brass in every skin). In the Library the parchment
   is the surface everywhere, the menu included: no ivory layer on top of it, anywhere. Icons on parchment are ink (dark),
   never brown.
4. **Contrast is a gate, not a goal.** Every ink on every textured plate must read 4.5:1 plus a 0.1 margin on the worst
   composite (the texture's lightest or darkest pixel at its alpha), and control borders and focus rings 3:1
   (`texturedPairs` in `materials.ts`, held by `materials.test.ts`). When a texture fails, cap or floor its extremes
   (`clothfin.py`, `paperfin.py`) or pick a deeper ink; never loosen the test. Status inks (error, success, warning) count too.
5. **Home, the menu and the chat differ.** In each skin the Home cards, the menu (rail, drawer, top bar) and "You" read as
   distinct surfaces, using the painting's own cloths (`ACCENTS` and `ACCENT_SUBSTRATE` in `materials.ts`). Dark-on-dark
   everywhere was rejected. Celestial is the owner's exception: its Home cards wear the navy of its Command center, and its
   Command panels wear the Home cards' gold studs and rim (`FRAMED_ROUTE_PANELS`), so the two pages read as one set; the
   frame, not the cloth, sets them apart from the menu.
6. **Colours stay in the skin's family.** A selected item takes a colour of the skin (Library wine red, Velvet crimson), never
   a stray accent (lavender in a red room was rejected). The only constant across skins is the Sanctum mark.
7. **Edges sit into their material.** A rim on a dark plate must not glow: it takes the skin's own dark-edge colour, not a bright
   brass line. Remember the chat field is always focused, so its focus ring always shows.
8. **The chat bar is one surface** (`CLEAR_COMPOSER_FIELD`): the bar is the field, the field inside it is clear. A light field
   set inside a dark bar read as two colours and was rejected.
9. **Geometry from the painting.** Plates are nearly square with their fittings; chips and the Open chat button are 4px
   (`CHIP_RADIUS`). Ember alone rounds its bubbles and chat bar (8px, no fittings) and keeps cards at 3px.
10. **Ornaments are painted, legible and varied.** Sprigs and moons are lifted off the painting (`lift.py`), keep their painted
    colours, and are drawn large enough to read: hairline gold is thickened (`LIFT_BOLD`) and drawn at 112px. An ornament never
    draws taller than its plate (it shrinks, whole), and its side of the plate is reserved so text never runs under it.
    Variety is structural, not random: a message's slot is its sequence in the thread (`ORNAMENT_SLOTS`, `ornamentVariants`),
    the corner cycles so neighbours differ top and bottom and a speaker's every other message swaps sides, and each painting
    meets every corner. A phone's Home cards and the chat list keep their ornament at the bottom, so text keeps the full width.
11. **No outer app-shell frame**, on desktop or phone, unless `data-outer-frame=on`. This does not touch the header or the page
    plates: they keep their frames and ornaments on every page of every skin.
12. **An approved skin does not move as a side effect.** Shared code (frame, ornament slots, accents, rims, the chat list) touches
    every skin. After any shared change, screenshot every skin it reaches and compare with its last approved shot; exempt a skin
    rather than let it drift.
13. **No personal names** anywhere in the repo, commit messages or PR text: demo content uses Echo (the companion) and Sam.
14. **Desktop menu** (1920): about 160px wide, a dark fill with the room faintly through it, a gold hairline on its right edge,
    icon-and-label rows. Only the active item gets a plate. (Under 1100px the compact rail is 80px.)
15. **Chat bubbles** are capped at about 3/4 of the width on desktop.
16. **Phone room backgrounds** show the portrait painting (2:3 asset) whole across the full width from the top; its bottom fifth
    fades into the blurred fill. Never cover-zoom it into one wall panel. Hedgewitch (landscape) keeps `cover`.
17. **Files page** in every skin sits on that skin's paper or plate, never a flat brown.
18. **Ember**: its frames and fittings appear on every page. Notes uses the navy leather plate
    (`/skins/ember/ember-navy-leather.webp`), not black.
19. **Appearance, Customize** section is collapsed by default on every skin.
20. **Indigo-silk (Celestial) is reserved.** Do not touch its material, palette or assets without the owner's word.
21. **Settings on desktop is a real two-pane page**, not the phone column stretched. The phone root type size is 17px.

## The workflow

1. **Look first.** Screenshot the skin as it stands (desktop 1440x900 and phone 390x844, decorations on) and crop the
   mock-up's plates, fittings and ornaments at 2-4x. Name what differs before changing anything.
2. **Cut from the painting** with the scripts in `packages/frontend/scripts/skin-art/` (Python 3, numpy, Pillow):
   - `texgen.py` grows a seamless tile from clean patches (`TEXGEN_NOFLIP` keeps a weave's lean, `TEXGEN_ANISO` stretches a
     wood's streaks, `TEXGEN_BLOCK` and `TEXGEN_SIGMA` keep a pattern's motifs, `TEXGEN_COLORS` recolours the mottling).
   - `clothfin.py` (dark cloth: mean to the plate colour, highlights capped until every ink passes) or `paperfin.py` (light
     paper: darkest fibres floored).
   - `brackets.py` (fittings inside a CSS rim), `goldbrackets.py` (fittings over a rim, cut by their outline), `corners.py`
     (Ember's copper).
   - `lift.py` (an ornament by colour distance; `LIFT_NOBLUE` masks an avatar, `LIFT_BOLD` thickens hairlines), then
     `sprigset.py` (the corner variants).
   Sample areas must be clean: no text, title rules, studs or ornaments (a gold rule in a sample streaks the whole tile).
   Record every command in the skin-art README; it is the only record of how a file was made.
3. **Wire it**: copy the files into `public/skins/<room>/`, list them in `scripts/gen-skin-textures.ts`, set the material in
   `src/theme/materials.ts` (palette, `TEXTURES`, ceilings, accents, chips, clear field), then
   `npm run gen:textures` (pins sizes and SHA-256 in `asset-manifest.json`; drop entries for deleted files) and
   `npm run gen:skins` (regenerates `skins.generated.css`).
4. **Test**: `npx vitest run` in `packages/frontend` and `npx tsc --noEmit -p .`. Contrast failures mean the texture or ink
   is wrong; pinned values that changed on purpose get updated with a comment saying why.
5. **See it in the real app**: build, run the server, screenshot both widths, zoom the fittings and ornaments, and compare with
   the mock-up side by side. Stop the server as soon as the shots are taken (its scheduler starts turns). Send the shots for
   review before calling a skin done.
6. **Commit** signed, one skin or one fix per commit, the message saying what changed and why in plain words.
