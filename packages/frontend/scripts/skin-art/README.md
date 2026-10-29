# Skin art: leathers, cloths and fittings from the original paintings

The Ember leathers are grown from the approved blue/amber study (`updated_ember_study_final.png`, 1536 × 1024), and its copper
brackets are cut from the original Ember plate art (`updated_ember-hedgewitch.png`, 1774 × 887); both are in the design asset
pack, not in this repository. Python 3 with numpy and Pillow.

**Leather** (`texgen.py`): a seamless tile in two layers. The grain (the creases and pores: everything finer than about 5 px) is
taken from clean areas of the study's black leather panel and spread over the tile; the large soft mottling is periodic noise,
kept faint (big blotches read as fake), coloured with `TEXGEN_COLORS` (dark;mid;light). Then the brightest pixels are rolled off
under every ink's bound (see `materials.ts`, `texturedPairs`) and the tile is saved as WebP; its per-channel extremes are measured
from the encoded file.

```bash
R="806,736,1306,774 896,374,1011,478 1168,482,1300,632"   # clean leather in the study's Chat panel
TEXGEN_COLORS="12,11,10;20,19,17;27,25,23" python3 texgen.py updated_ember_study_final.png black.png 576 3 0.35 1.3 $R  # panels, menu, companion, the input bar
TEXGEN_COLORS="13,22,38;20,33,55;27,43,70" python3 texgen.py updated_ember_study_final.png navy.png  576 5 0.35 1.4 $R  # "You" and the Home cards
```

Highlight caps used (per channel, soft knee at 78%): black (34, 32, 30), navy (38, 52, 76). Encoded at WebP quality 90.

**Fittings** (`corners.py`): the copper bracket at each corner of a painted plate, cut out onto transparency by colour (the
bracket's body and rivet), with the painting's thin dark shadow around it. The bottom-left bracket is the cleanest and is mirrored
into the other three corners. Saved as lossless WebP.

```bash
python3 corners.py updated_ember-hedgewitch.png out ember-fitting 175 251 794 432 32
```

## Moonlit Cloister

From `Updated_moonlit_menu_chat_repsonse.png` (1672 × 941, in the design asset pack). Its Home plate's outer edge is
left 81, top 197, right 1590, bottom 366.

```bash
SRC=Updated_moonlit_menu_chat_repsonse.png
TEXGEN_NOFLIP=1 python3 texgen.py $SRC navy.png 576 2 0.6 1.0 780,420,1560,606 960,212,1490,352   # companion, panels, chrome
TEXGEN_NOFLIP=1 python3 texgen.py $SRC you.png  576 4 0.6 1.0 640,672,1560,845                    # "You"
python3 brackets.py $SRC out cloister-bracket 81 197 1590 366 56 9                            # the four brackets, rim left out
python3 sprig.py $SRC home.webp 92 232 218 352 7,18,39 95 0.12 0.14                           # the three plates' sprigs, above their brackets
python3 sprig.py $SRC comp.webp 92 458 240 612 8,20,41 95 0.12 0.14
python3 sprig.py $SRC you.webp  92 728 218 843 40,55,96 150 0.12 0.14
python3 sprigset.py out cloister-sprig 91,111,165 156,177,237 0.8 home=home.webp comp=comp.webp you=you.webp  # 12 corner variants
```

`sprigset.py` tones each sprig for the cloth it sits on (the companion's dark navy, or the lighter blue of "You" and the Home
cards, mirrored to their right) and turns it to each corner: upright at the bottom, hanging from the top. Each bubble picks one by
its message id, each Home card has its own. `TEXGEN_NOFLIP` keeps the weave's diagonal lean (no mirrored patches). Highlight caps: navy (30, 42, 68) knee 80%, "You"
(50, 64, 106) knee 88%, so the muted ink keeps 4.6:1 on the lightest thread. The brackets are saved as lossless WebP and drawn
at 32px (28px on a phone), where the 9px rim they leave out matches the stylesheet's 5px rim (`materials.ts`, `plateShadow`).

## Hedgewitch

From `updated_ember-hedgewitch.png` (the Hedgewitch half: x from 887). The paper is light, so instead of capping highlights
`paperfin.py` rolls its darkest fibres off above a floor, encodes the WebP and reports every ink on the darkest composite.

```bash
SRC=updated_ember-hedgewitch.png
python3 texgen.py $SRC paper.png 512 7 1.0 1.0 1347,262,1487,325 1447,340,1492,430 1232,465,1527,530   # the cream plates
python3 texgen.py $SRC rose.png  512 9 1.0 1.0 1357,648,1477,780 1187,645,1357,712                     # the "You" plate
python3 paperfin.py paper.png hedgewitch-paper.webp 234,213,184 0.7 0.9 '#f3ead7' '#2c231f:4.6,#54483f:4.6,#5d5047:4.6,#57477a:4.6,#4a3b6e:3.1,#85734f:3.1'
python3 paperfin.py rose.png  hedgewitch-rose.webp  196,158,160 0.7 0.9 '#CFABAC' '#3b2f52:4.6,#4a3b6e:3.1,#57477a:3.1'
```

On the painting's warmer paper the muted ink is #5d5047 (one step darker than before), the "You" metadata takes the "You"
ink, and the rose bubble's edge is the deeper lavender.

## Oxblood Library

From `updated_library_vampire_set-menu-chat-response.png` (1672 × 941, the Library half). Its Home plate's outer edge is
left 177, top 157, right 793, bottom 425.

```bash
SRC=updated_library_vampire_set-menu-chat-response.png
python3 texgen.py $SRC parch.png 512 3 0.8 1.0 670,280,770,400 610,175,770,245 360,478,620,540 690,548,775,630   # the cream plates
python3 texgen.py $SRC you.png   512 5 0.8 1.0 320,692,620,762 580,770,775,845                                   # the "You" plate
python3 paperfin.py parch.png library-parchment.webp 236,196,138 0.7 0.9 '#FFDA98' '#24190F:4.6,#4B3625:4.6,#59412E:4.6,#42280E:4.6,#852B20:4.6,#2E5731:4.6,#693F0D:4.6,#533119:3.1,#4E2D13:3.1'
python3 paperfin.py you.png   library-you.webp       170,130,95  0.7 0.9 '#B9834D' '#24190F:4.6,#652017:3.1,#533119:3.1,#4E2D13:3.1'
python3 goldbrackets.py $SRC out library-bracket 177 157 793 425 44 12 28                          # the four gold brackets
TEXGEN_NOFLIP=1 TEXGEN_ANISO=0.2 python3 texgen.py library.jpg wood.png 512 4 0.9 1.0 10,785,126,860   # the demo rail's oxblood wood
```

`goldbrackets.py` cuts a bracket that sits over the rim by flood-filling from its rivet through everything brighter than its
dark outline, then opens the fill (dropping the rim's 1px highlight it leaks along) and adds the outline back as a soft rim.
The wood is grown from below the Library demo's rail (`library.jpg`, 1536 × 864); `TEXGEN_ANISO=0.2` stretches its soft
streaks along the grain, and its highlights are capped at (64, 30, 18), knee 85%.

## Crimson Velvet

From `updated_library_vampire_set-menu-chat-response.png` (the Vampire half, x from 836). Its Home plate's outer edge is
left 1002, top 157, right 1621, bottom 425.

```bash
SRC=updated_library_vampire_set-menu-chat-response.png
TEXGEN_BLOCK=88 TEXGEN_SIGMA=16 TEXGEN_NOFLIP=1 python3 texgen.py $SRC dam.png 576 5 0.2 1.0 1496,268,1608,372 1256,478,1458,552   # the damask
TEXGEN_BLOCK=56 TEXGEN_SIGMA=8 TEXGEN_NOFLIP=1 python3 texgen.py $SRC velvet.png 576 7 0.5 1.0 1396,765,1571,832                   # the "You" velvet
python3 brackets.py $SRC out velvet-filigree 1002 157 1621 425 60 11                                                               # the gold filigree
```

`TEXGEN_BLOCK` and `TEXGEN_SIGMA` keep a patterned cloth's motifs: larger patches, and the motif scale kept in the grain layer
rather than in the (faint) mottling. The damask is then toned to the mock-up's plates (mean #0E0E0E, deviation 5) with its
highlights capped at (32, 32, 31); the velvet capped at (104, 20, 26), so the control border keeps 3:1 on its lightest pile.
The samples sit below the Home plate's gold title rule, which would otherwise streak the tile.

## Rain Greenhouse

From `updated_celestial_conservatory_menu_chat_response.png` (1672 × 941, the Conservatory half: x up to 836). Its Home plate's
outer edge is left 52, top 190, right 783, bottom 388.

```bash
SRC=updated_celestial_conservatory_menu_chat_response.png
TEXGEN_NOFLIP=1 python3 texgen.py $SRC navy.png   512 3 0.6 1.0 548,198,645,382 200,198,640,245   # Home, panels, chrome
TEXGEN_NOFLIP=1 python3 texgen.py $SRC slate.png  512 5 0.6 1.0 590,470,665,630 200,470,660,512   # the companion
TEXGEN_NOFLIP=1 python3 texgen.py $SRC indigo.png 512 7 0.6 1.0 400,720,640,868                   # "You"
python3 clothfin.py navy.png   greenhouse-navy.webp   '#0B1829' 0.92 '#F1EEE8:4.6,#D8DDE0:4.6,#BCCBD7:4.6,#E4EEFF:4.6,#FFB4A9:4.6,#BBE8C5:4.6,#9CB5C4:3.1,#C4D8EC:3.1'
python3 clothfin.py slate.png  greenhouse-slate.webp  '#284059' 0.92 '#F1EEE8:4.6,#D8DDE0:4.6,#BCCBD7:4.68,#CBDEFF:4.6,#FFB4A9:4.68,#BBE8C5:4.68,#F0C87C:4.68,#9CB5C4:3.1,#C4D8EC:3.1'   # also the Home cards, so the status inks too
python3 clothfin.py indigo.png greenhouse-indigo.webp '#262E51' 0.92 '#F3F1FC:4.6,#D8DDE0:4.6,#BCCBD7:4.68,#9CB5C4:3.1,#C4D8EC:3.1'
python3 brackets.py $SRC out gh-stud 52 190 783 388 46 6    # keep tl and bl; tr and br are them mirrored (the painted right corners carry leaves)
python3 lift.py $SRC home.webp 640,200,776,381 10,23,43 45 110 right 0.1 752,190,783,232 758,358,783,388
python3 lift.py $SRC comp.webp 660,490,777,631 37,60,84 45 110 right 0.1 742,461,783,505 742,596,783,637
python3 lift.py $SRC you.webp  640,735,777,865 37,46,82 45 110 right 0.1 742,711,783,748 742,830,783,871
LIFT_NOBLUE=45 python3 lift.py $SRC bloom.webp 58,505,190,631 37,60,84 45 110 left 0.1 52,608,92,637 108,500,205,594   # the companion plate's left sprig, its avatar left out
python3 sprigset.py out greenhouse-sprig keep keep 0.95 home=home.webp comp=comp.webp bloom=bloom.webp you=you.webp
```

`clothfin.py` moves a cloth's mean to its plate colour and rolls its highlights off until every ink passes; `lift.py` lifts an
ornament that is not blue (sage leaves, white blossom) by its colour distance from the cloth; `sprigset.py keep keep` keeps the
paintings' own colours on every cloth.

## Celestial

From `updated_celestial_conservatory_menu_chat_response.png` (the Celestial half, x from 836). Its Home plate's outer edge is
left 888, top 191, right 1618, bottom 389.

```bash
SRC=updated_celestial_conservatory_menu_chat_response.png
TEXGEN_NOFLIP=1 python3 texgen.py $SRC navy.png   512 3 0.6 1.0 1036,200,1376,248 1041,470,1396,512   # companion, panels, chrome
TEXGEN_NOFLIP=1 python3 texgen.py $SRC violet.png 512 7 0.6 1.0 1216,722,1436,868                    # "You" and the Home cards
python3 clothfin.py navy.png   celestial-navy.webp   '#11172D' 0.92 '#F6EEDA:4.6,#D6D1DE:4.6,#BEB8CD:4.68,#DED1FF:4.6,#E4DAFF:4.6,#FFB4A9:4.68,#A2D6B1:4.68,#F0C87C:4.68,#B3A17E:3.1,#E9C688:3.1'
python3 clothfin.py violet.png celestial-violet.webp '#262145' 0.92 '#F6F1FF:4.6,#F6EEDA:4.6,#D6D1DE:4.6,#BEB8CD:4.68,#DED1FF:4.6,#E4DAFF:4.6,#FFB4A9:4.68,#A2D6B1:4.68,#F0C87C:4.68,#B3A17E:3.1,#E9C688:3.1'
python3 brackets.py $SRC out cel-stud 888 191 1618 389 46 7    # keep tl and bl; tr and br are them mirrored (the painted right corners carry stars)
export LIFT_BOLD=0.85   # thicken the hairline gold by about a pixel, or it vanishes when drawn small
python3 lift.py $SRC home.webp 1396,199,1610,382 13,21,40 45 110 right 0.04 1588,191,1619,226 1588,354,1619,389
python3 lift.py $SRC comp.webp 1426,470,1610,631 17,22,44 45 110 right 0.04 1592,463,1619,496 1592,600,1619,638
python3 lift.py $SRC you.webp  1426,720,1610,865 38,33,69 45 110 right 0.04 1592,713,1619,746 1592,836,1619,872
unset LIFT_BOLD
python3 sprigset.py out celestial-moon keep keep 1.0 home=home.webp comp=comp.webp you=you.webp
```

The stud boxes left out of the lift are kept tight to the studs, so the crescents that run close to them stay whole.

The menu's foot (`celestial-rail-compass.webp`) is the astrolabe arcs, four-point star and small stars at the foot of the
Celestial menu in the Home demo (`sanctum-home-celestial-demo.png`, 1672 × 941). The menu's gilt lines run at x 8-9 and 224 and
y 930; the cut keeps inside them and leaves out the two corner fittings. The faint gold needs lower thresholds than the moons, and
`LIFT_NOBLUE` leaves out the demo's blue cloth grain that the lower thresholds would otherwise lift along the lines.

```bash
SRC=sanctum-home-celestial-demo.png
LIFT_BOLD=0.85 LIFT_NOBLUE=12 python3 lift.py $SRC celestial-rail-compass.webp 11,705,222,919 4,11,31 22 70 left 0.04 11,905,34,919 198,903,222,919
```

