# The skins, as approved

Material id → label → room folder (`public/skins/<room>/`). Sources are in the design asset pack (not in the repository); the
exact crops and commands are in `packages/frontend/scripts/skin-art/README.md`. Colours are the plate colours under each
texture (and their fallback when decorations are off).

## Ember (`smoked-copper`, room `ember`)
- Sources: `updated_ember_study_final.png` (the leathers), `updated_ember-hedgewitch.png` (the copper fittings).
- A flat material (`FLAT`): black leather `#131310` for the panels, menu, companion bubbles and chat bar on every page except Notes; navy leather
  `#142036` for "You", every Home card and the Notes plate. Copper fittings, a copper rim.
- Cards and panels 3px with fittings; bubbles and the chat bar rounded 8px with no fittings; chips 4px.
- No outer frame; the copper fittings sit on the plates and the header on every page.

## Moonlit Cloister (`midnight-ink`, room `cloister`)
- Source: `Updated_moonlit_menu_chat_repsonse.png`.
- Navy twill `#0A162C` (companion, panels, menu, header, chat list); a lighter "You" cloth `#2B3B64` for "You" and the Home
  cards. Riveted silver brackets inside a CSS rim (bright silver, black groove, fine inner line).
- Three painted blue sprigs; the companion's bubbles and chat list carry them on the left, "You" and Home (mirrored, lighter)
  on the right; they cycle upright and hanging, but do not cross sides.

## Hedgewitch (`hedgewitch`, the kitchen; the legacy palette in `theme-hedgewitch.css`)
- Source: the Hedgewitch half of `updated_ember-hedgewitch.png`.
- Crinkled cream paper; "You" is the painting's dusty rose `#CFABAC` with a deeper lavender edge and plum ink; muted ink
  `#5d5047`. Sage sprig on the companion's bubbles, yarrow on "You"; botanicals on the Home cards. A light skin on its own paper; no ivory layer.
- Unframed: the kitchen has no frame and no inset.

## Oxblood Library (`mounted-paper`, room `library`)
- Sources: the Library half of `updated_library_vampire_set-menu-chat-response.png` (plates, brackets), `library.jpg` (the menu).
- Aged parchment `#FFDA98` plates, a darker tan "You" `#B9834D`, burnt edges, a slim dark mount with a brass line. Polished gold
  riveted brackets.
- The parchment is the surface everywhere: the chrome (rail, drawer, top bar, header, chat list, chat bar) sits on it, with no
  ivory layer. Icons are ink. The rim is oxblood `#7E3420`, the focus ring red copper `#BA5C3C`, the selected item wine red
  `#6A1F22`. The chat bar is one surface.

## Crimson Velvet (`black-damask`, room `salon`)
- Sources: the Vampire half of the same mock-up; `Vampire-salon.jpg` and its sibling demo for the menu.
- Black brocade damask `#101010` plates (grown in large blocks so the scrolls survive); crimson velvet `#470509` for "You" and
  the whole menu (rail, drawer, top bar). Gold filigree corners, a gold rim (lit line, black gap, fine bronze line).
- Selected: `#761C27` on the velvet menu, `#5A1018` on the damask (the open chat).

## Rain Greenhouse (`botanical-linen`, room `conservatory`)
- Source: the Conservatory half of `updated_celestial_conservatory_menu_chat_response.png`.
- Deep navy linen `#0B1829` (menu, panels, header, chat list); slate linen `#284059` for the companion and the Home cards;
  indigo linen `#262E51` for "You". Silver studs (the painted left corners, mirrored for the right), a silver rim.
- Four painted leaf-and-blossom sprigs (the Home plate's, both of the companion plate's, the "You" plate's), 16 variants over
  both sides and both corners.

## Celestial (`indigo-silk`, room `night`)
- Source: the Celestial half of the same mock-up.
- Midnight navy linen `#11172D` (companion, panels, menu, and the Home cards); violet linen `#262145` for "You". Gold studs
  (left ones mirrored), a gold rim (bright line, dark gap, bronze line). The Home cards were violet until the owner chose the
  Command center's navy for them; the Command panels in turn wear the Home cards' studs, rim and 5px corners
  (`FRAMED_ROUTE_PANELS`).
- Three painted gold moon-and-star groups, lines thickened, drawn at 112px (64px on a phone), 12 variants over both sides and
  both corners.

## Shared pieces, and where they live
- Palettes, textures, fittings, ornaments, accents, chips, clear chat bar: `packages/frontend/src/theme/materials.ts`.
- How plates, rims, accents and ornament slots are drawn: `packages/frontend/src/theme/skins-css.ts` (generates
  `skins.generated.css`; never edit that file by hand).
- The frame, its desktop inset and the Ember exception: `packages/frontend/src/theme/skins.css`.
- Ornament slots: a message's `data-orn` is its sequence modulo 24 (`MessageBubble.tsx`); the Home cards take 0-5 in order
  (`HomeView.tsx`).
- Asset integrity: `packages/frontend/src/theme/asset-manifest.json` (every file under `public/skins` pinned by size and hash;
  nothing unreferenced may ship).
