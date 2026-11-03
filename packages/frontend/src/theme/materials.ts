/**
 * Material registry. A material is a complete, opaque palette: every surface
 * that carries text owns a foreground/background pair, so nothing depends on
 * what happens to be painted behind it. Base palettes carry the approved
 * per-style restoration targets; the remaining roles are derived here by
 * fixed rules, and materials.test.ts holds every pair to WCAG thresholds.
 */
import { contrastRatio, mix, parseColor, relativeLuminance, TEXT_MIN, CONTROL_MIN } from './contrast';
import type { MaterialId, RoomId } from './types';
import { MATERIAL_IDS } from './types';

/**
 * Optional material-owned palette for active text editors (the Home user card's field, an inline rename).
 * It is independent of the composer and never imposes a universal parchment/ivory input surface.
 */
export interface EditorPalette { bg: string; text: string; placeholder: string; focus: string; /** Ink used by an optional editor tile, if the material supplies one. */ tileInk: string }

export interface BasePalette {
  panel: string; text: string; secondary: string; muted: string;
  user: string; userText: string; input: string;
  chrome: string; chromeText: string;
  link: string; button: string; buttonText: string;
  focus: string; controlBorder: string; trim: string;
  error: string; success: string;
  /** Optional danger-action ink on the user surface; panel errors keep their own ink. */
  userDanger?: string;
  /** Optional material-specific warning ink on textured plates. */
  warning?: string;
  // Optional: a palette that does not say keeps the rule the five earlier materials use.
  /** The thread sidebar's colour (default: the panel). */
  sidebar?: string;
  /** The companion's message surface (default: the input colour). */
  companion?: string;
  /** The raised surface (default: the panel lifted toward the text). */
  raised?: string;
  /** The composer pill's colour (default: the input colour). */
  composer?: string;
  /** The composer's quiet ink, its placeholder and resting icons, where the composer is its own leather (default: the muted ink, lifted to read on the composer). */
  composerMuted?: string;
  /** The quiet edge of a plate that must not compete with its neighbour (default: the trim). */
  divider?: string;
  /** The window frame's line and corners (default: the trim). */
  frame?: string;
  /** Text drawn on a primary-button fill from the chrome side (default: the chrome ink). */
  chromeOnButton?: string;
  /** The selected row on the chrome (the active rail item, the open chat) (default: the chrome lifted toward its ink). */
  chromeSelected?: string;
  /** The selected row on a menu drawn in the "You" substrate (Crimson Velvet's velvet rail) (default: the chrome selection). */
  accentSelected?: string;
  /** The primary button's edge (default: the control border). */
  buttonEdge?: string;
  /** The edge metal of the dark chrome plates in a light material (default: the trim). */
  chromeTrim?: string;
  /** The focus ring on the chrome (default: the focus colour on a dark material, a pale brass on a light one). */
  focusChrome?: string;
  editor?: EditorPalette;
}

/** Approved opaque material palettes, keyed by the existing persisted material ids. */
export const BASE_PALETTES: Record<string, BasePalette> = {
  'black-damask': {
    panel: '#101010',
    companion: '#101010',
    user: '#470509',
    text: '#F4EEE7',
    userText: '#FFF2E8',
    secondary: '#D5C9BC',
    muted: '#BFB1A2',
    input: '#191313',
    chrome: '#0B0B0C',
    chromeText: '#F4EEE7',
    raised: '#1B1816',
    link: '#E0B375',
    button: '#6F1821',
    buttonText: '#FFF5EA',
    focus: '#F0CD91',
    controlBorder: '#A68D74',
    trim: '#B8945C',
    frame: '#A98550',
    divider: '#66533A',
    error: '#FFB4A9',
    success: '#A2D6B1',
    sidebar: '#101010',
    composer: '#191313',
    chromeOnButton: '#FFF5EA',
    chromeSelected: '#5A1018', // the demo's crimson selected row on the black damask
    accentSelected: '#761C27', // a brighter crimson for the selected item on the velvet menu
    editor: { bg: '#191313', text: '#F4EEE7', placeholder: '#BFB1A2', focus: '#F0CD91', tileInk: '#191313' },
  },
  'mounted-paper': {
    panel: '#FFDA98',
    companion: '#FFDA98',
    user: '#B9834D',
    text: '#24190F',
    userText: '#24190F',
    secondary: '#4B3625',
    muted: '#59412E',
    input: '#E6CAA1',
    chrome: '#301409',       // the demo's oxblood wood (its rail): the menu, header, chat list and composer
    chromeText: '#F8E8CF',
    raised: '#FBE4BF',
    link: '#42280E',
    button: '#4A2015',       // deep oxblood, a step above the wood (the demo's dark buttons), with a brass edge
    buttonText: '#FFFFFF',
    focus: '#4E2D13',
    controlBorder: '#533119',
    trim: '#8A643C',
    frame: '#805D36',
    divider: '#A0784D',
    error: '#852B20',
    userDanger: '#652017',
    success: '#2E5731',
    warning: '#693F0D',
    sidebar: '#FFDA98',
    composer: '#E6CAA1',
    chromeOnButton: '#FFFFFF',
    chromeSelected: '#6A1F22', // a deep wine red selected row on the wood (red with the oxblood, not the demo's plum)
    buttonEdge: '#8A643C',
    chromeTrim: '#7E3420',     // the wood plates' edge: a rich oxblood red, not the parchment's brass
    focusChrome: '#BA5C3C',    // a deep red copper on the wood (3:1 on its lightest grain), not a pale gold
    editor: { bg: '#E6CAA1', text: '#24190F', placeholder: '#59412E', focus: '#4E2D13', tileInk: '#E6CAA1' },
  },
  'midnight-ink': {
    panel: '#0A162C',
    companion: '#0A162C',
    user: '#2B3B64',
    text: '#F4F0EB',
    userText: '#F4F0EB',
    secondary: '#C3CAE0',
    muted: '#ADB9D4',
    input: '#13223C',
    chrome: '#071225',
    chromeText: '#F4F0EB',
    raised: '#15233C',
    link: '#CCDCFF',
    button: '#425A8C',
    buttonText: '#FFFFFF',
    focus: '#D6E4FF',
    controlBorder: '#A9BBD5',
    trim: '#C1CCD7',
    frame: '#B8C3D0',
    error: '#FFB4A9',
    success: '#A2D6B1',
    sidebar: '#0A162C',
    composer: '#13223C',
    chromeOnButton: '#FFFFFF',
    editor: { bg: '#13223C', text: '#F4F0EB', placeholder: '#ADB9D4', focus: '#D6E4FF', tileInk: '#13223C' },
  },
  'botanical-linen': {
    panel: '#0B1829',
    companion: '#284059',
    user: '#262E51',
    text: '#F1EEE8',
    userText: '#F3F1FC',
    secondary: '#D8DDE0',
    muted: '#BCCBD7',
    input: '#14273A',
    chrome: '#081320',
    chromeText: '#F1EEE8',
    raised: '#13263A',
    link: '#CBDEFF',
    button: '#46508B',
    buttonText: '#FFFFFF',
    focus: '#C4D8EC',
    controlBorder: '#9CB5C4',
    trim: '#A6B8C4',
    frame: '#9DADB8',
    error: '#FFB4A9',
    success: '#BBE8C5',
    sidebar: '#0B1829',
    composer: '#14273A',
    chromeOnButton: '#FFFFFF',
    editor: { bg: '#14273A', text: '#F1EEE8', placeholder: '#BCCBD7', focus: '#C4D8EC', tileInk: '#14273A' },
  },
  'indigo-silk': {
    panel: '#11172D',
    companion: '#11172D',
    user: '#262145',
    text: '#F6EEDA',
    userText: '#F6F1FF',
    secondary: '#D6D1DE',
    muted: '#BEB8CD',
    input: '#191D36',
    chrome: '#090F20',
    chromeText: '#F6EEDA',
    raised: '#1A203B',
    link: '#DED1FF',
    button: '#514384',
    buttonText: '#FFFFFF',
    focus: '#E9C688',
    controlBorder: '#B3A17E',
    trim: '#BA995D',
    frame: '#BA995D',
    error: '#FFB4A9',
    success: '#A2D6B1',
    sidebar: '#11172D',
    composer: '#191D36',
    chromeOnButton: '#FFFFFF',
    editor: { bg: '#191D36', text: '#F6EEDA', placeholder: '#BEB8CD', focus: '#E9C688', tileInk: '#191D36' },
  },
  // Ember restoration (the approved blue/amber study): black leather panels and menu, navy leather accents, warm ivory ink and copper accents.
  // Chosen colours and their purpose are recorded in ember-tokens.json; remaining materials carry their separately approved restoration palettes.
  // Frame/divider copper remains decorative, never the sole control/focus indicator.
  'smoked-copper': {
    panel: '#131310',        // the black leather's own mean (the plate under the leather, and its fallback)
    text: '#F1E8DA',
    secondary: '#C4B5A5',
    muted: '#B5A697',
    user: '#142036',         // the navy leather's mean: "You" and every Home card (the approved study)
    userText: '#F1E8DA',
    input: '#192A3B',        // dark inset field, never ivory
    chrome: '#131310',       // the menu, header and page: the black leather's mean
    chromeText: '#F1E8DA',
    link: '#C58F71',
    button: '#C58F71',       // black ink on copper, never ivory
    buttonText: '#131310',
    focus: '#D9AB8D',
    controlBorder: '#C58F71',
    trim: '#C58F71',
    error: '#F3B3A7',
    success: '#C2D0AE',
    sidebar: '#131310',
    companion: '#131310',
    raised: '#23303D',
    composer: '#131310',     // the black leather's mean: the input bar, never ivory
    divider: '#66564A',
    frame: '#885440',
    chromeOnButton: '#131310',
    editor: { bg: '#192A3B', text: '#F1E8DA', placeholder: '#C4B5A5', focus: '#D9AB8D', tileInk: '#192A3B' },
  },
};

export type Scheme = 'dark' | 'light';

type Optional = 'sidebar' | 'companion' | 'raised' | 'composer' | 'composerMuted' | 'divider' | 'frame' | 'chromeOnButton' | 'chromeSelected' | 'accentSelected' | 'buttonEdge' | 'chromeTrim' | 'focusChrome' | 'editor' | 'userDanger';
export interface Roles extends Omit<BasePalette, Optional> {
  sidebar: string; divider: string; frame: string; composer: string; composerMuted: string; chromeOnButton: string; buttonEdge: string; chromeTrim: string; accentSelected: string;
  userDanger: string;
  /** Null: no material-specific override for active editors. */
  editor: EditorPalette | null;
  scheme: Scheme;
  panelAlt: string; panelDeep: string; panelRaised: string;
  companion: string; companionText: string;
  inputText: string; placeholder: string;
  chromeDeep: string; chromeMuted: string; chromeSelected: string;
  popover: string; popoverText: string;
  code: string; codeText: string; codeMuted: string;
  buttonHover: string;
  controlHover: string; controlSelected: string; controlSelectedText: string;
  controlDisabled: string; controlDisabledText: string;
  focusChrome: string;
  warning: string; errorChrome: string;
  linkBright: string; linkDim: string; gold: string;
  threadActive: string;
}

export interface MaterialDef {
  id: MaterialId;
  label: string;
  /** Default scene pairing and asset folder; material substrates/fittings never change with the selected room. */
  defaultRoom: RoomId;
  /** True for the pre-skin Hedgewitch palette, which lives in theme-hedgewitch.css. */
  legacy: boolean;
  scheme: Scheme;
  /** Null for the legacy material. */
  roles: Roles | null;
  /** True when the primary plates are "mounted": an opaque text surface set in a dark chrome ring with a
   *  1px brass edge (the library's mounted paper). Any material can opt in by being listed in MOUNTED. */
  mounted: boolean;
  /** Null for the legacy material. */
  texture: MaterialTexture | null;
  /** Corner radius of the chips and pills (CHIPS); null keeps each component's own. */
  chipRadius: number | null;
  /** Plates drawn in another plate's colour and substrate (Ember's navy Home cards, Moonlit Cloister's lighter blue ones,
   *  Crimson Velvet's velvet menu, Rain Greenhouse's slate Home cards). They keep the panel's (or a menu, the chrome's) ink. */
  accents: string[];
  /** Whose colour and substrate the accent plates wear: "You"'s, or the companion's. */
  accentSubstrate: 'user' | 'companion';
  /** Non-null: this material draws its plates flat (see FlatStyle). */
  flat: FlatStyle | null;
}

/** Restrained plate geometry (Ember). Retains existing radii and surface overrides without
 * the generic botanical/motif treatment. A material can now supply fine substrate and
 * separate worked edge hardware through MaterialTexture.relief; decoration gates still apply. */
export interface FlatStyle {
  /** Corner radius of every plate that is not an edge column. */
  radius: number;
  /** Plates whose colour differs from the generic list's (the composer is a card here, not chrome). */
  surfaces: Record<string, PlateSurface>;
  /** Plates drawn as soft bubbles: a small radius of their own and no corner fittings (the study's chat bubbles and input bar). */
  soft: { radius: number; selectors: string[] } | null;
  /** Plates whose edge is the quiet line instead of the trim, so two neighbours (companion and user bubbles) stay apart. */
  quiet: string[];
  /** Buttons a component paints with a hard-coded amber wash under the link colour (the confirm dialog's); the copper link on that wash reads 4.5 at rest and under 4 on hover,
   *  so here they are the material's selected fill instead: page ink on copper, in every mode (not only with decorations on). */
  primary: string[];
  /** Legacy optional wood layer; retained for compatibility, disabled for restored Ember. */
  woodgrain: { url: string; opacity: number; tilePx: [w: number, h: number] } | null;
}

/** Ceiling for the retained legacy wood-layer contract (restored Ember does not use it). */
export const WOODGRAIN_OPACITY_CEILING = 0.12;

export const FLAT: Partial<Record<MaterialId, FlatStyle>> = {
  // Cards and panels are nearly square, the copper fittings at their corners; only the bubbles and the input bar are rounded (the study).
  'smoked-copper': { radius: 3, surfaces: { '.composer-inner': '--composer-bg' }, 
    soft: { radius: 8, selectors: ['.message.companion', '.message.user', '.composer-inner'] }, quiet: [], primary: ['.cdlg-amber'],
    // Leather is the material-owned substrate below; never borrow the room's table wood.
    woodgrain: null },
};

/** The glyph and ring of Home's medallions (they sit on the chrome, the wood or leather, not on the card). The Library's trim is the parchment's
 *  brown and Ember's copper is dim on its leather, so each wears its own bright metal there (brass / light copper); the rest use their trim. */
export const BADGE_INK: Partial<Record<MaterialId, string>> = { 'mounted-paper': '#E0BB78', 'smoked-copper': '#E3B99D' };

/** The ink of icons (and their labels' glyphs) drawn on a material's parchment: a dark near-black with the paper's warmth, in place of the
 *  Library's brown link/trim, which read wrong on the cream. Applied by skins-css to the Home and Files icons on paper. */
export const ICON_INK: Partial<Record<MaterialId, string>> = { 'mounted-paper': '#2A1F14' };

/** Squared chips and pills, for the materials whose plates are nearly square (their painted references). */
export const CHIP_RADIUS: Partial<Record<MaterialId, number>> = { 'smoked-copper': 4, 'midnight-ink': 4, 'black-damask': 4, 'botanical-linen': 4, 'indigo-silk': 4 };

/** Materials whose decorated composer bar is the field itself (one surface, the field inside it clear, the chrome ink on it). */
export const CLEAR_COMPOSER_FIELD: ReadonlySet<MaterialId> = new Set<MaterialId>(['mounted-paper', 'black-damask', 'botanical-linen', 'indigo-silk']);


/** Where an active text editor is: the fields that exist only while someone is typing into them (Home's user card, an inline rename). */
export const EDITOR_FIELDS = ['.mc-input', '.thread-name-input'] as const;

/** Materials whose plates carry the dark backing and brass edge. The text surface itself stays opaque and its pair unchanged. */
export const MOUNTED: ReadonlySet<MaterialId> = new Set<MaterialId>(['mounted-paper']);

/** Slim brown backing 2px, brass edge 1px, drawn outside the plate's own box so no text area or layout shifts. */
export const MOUNT_BACKING_PX = 2;

/** Where a plate's solid colour comes from. Each is a custom property the material block sets, so the
 *  plate's background-color and the veil laid over its texture are always the same opaque colour. */
export type PlateSurface =
  | '--surface-companion' | '--surface-user' | '--surface-chrome' | '--sidebar-bg' | '--settings-panel-bg'
  | '--card-bg' | '--login-card-bg' | '--surface-popover' | '--composer-bg';

/**
 * A primary plate: an opaque text surface the skins frame, corner and texture. Built once here and
 * emitted once by the generator (skins-css.ts), so no component carries any of it.
 */
export interface PlateDef {
  selector: string;
  /** The soft drop shadow the plate keeps (and keeps under the mounting ring). */
  drop: string;
  surface: PlateSurface;
  /** 'card' lays the material's paper/cloth texture, 'chrome' its dark-column texture (the library's leather). */
  kind: 'card' | 'chrome';
  /** Corner piece size in CSS px (the art is 96px, scaled down, never stretched); 0 = no corners. */
  corner: number;
  /** The same on a phone (at or below the shell breakpoint). */
  cornerMobile: number;
  /** Carries the room's leaf/edge ornament (where the material has one) in its bottom-left corner. */
  ornament: boolean;
  /** The plate has its own 1px border, so the trim metal is that border's colour; otherwise it is a 1px inset outline. */
  border: boolean;
  /** A light material draws this plate as dark chrome with the chrome ink (the library's sidebar and composer). */
  chromeInLight: boolean;
  /** 'edge': a column that gets the trim metal on one side only instead of a frame. */
  edge?: 'right' | 'bottom';
  /** Corner radius in px, small enough for the corner art to sit inside it. */
  radius: number;
  /** Framed by the mounting ring in a mounted material (Library) when decorations are off or the plate is paper. */
  mount: boolean;
}

const plate = (selector: string, drop: string, surface: PlateSurface, o: Partial<PlateDef> = {}): PlateDef => ({
  selector, drop, surface, kind: 'card', corner: 22, cornerMobile: 18, ornament: false, border: false, chromeInLight: false, radius: 5, mount: true, ...o,
});

/** Chrome-coloured navigation surfaces can carry their selected material's substrate. */
export const NAV_SURFACES: string[] = ['.nav-rail', '.drawer-panel', '.mobile-topbar'];

/** Plates in the "You" substrate: Ember's navy and Moonlit Cloister's lighter blue Home cards, and Crimson Velvet's menu (rail,
 *  phone drawer and top bar) in its crimson velvet, as in its demo. */
export const ACCENTS: Partial<Record<MaterialId, string[]>> = { 'smoked-copper': ['.home-card'], 'midnight-ink': ['.home-card'], 'black-damask': NAV_SURFACES, 'botanical-linen': ['.home-card'] };
/** Rain Greenhouse's Home cards wear the companion's slate linen (lighter than its navy menu), not the indigo of "You". */
export const ACCENT_SUBSTRATE: Partial<Record<MaterialId, 'user' | 'companion'>> = { 'botanical-linen': 'companion' };

/**
 * Panels on the routes that used to sit under an opaque lid (Files, Canvas, Command, Browser, Observatory). Their own CSS gives them a near-transparent
 * wash made for glass over the room; with the lid gone each gets a plate in the chrome colour (the pair their remapped ink is drawn for) and the trim edge.
 * `bare` surfaces also carry a page-level opaque background of their own that must go transparent so the scene shows.
 */
export const ROUTE_PANELS: string[] = [
  '.cmd-panel', '.fl-plate', '.browser-toolbar',
  '.nt-card', '.cve-header', '.cve-body', '.ob-panel', '.ob-card', '.ob-peek',
];
export const ROUTE_BARE: string[] = ['.observatory-view'];
/** Route panels framed as the material's Home cards are: its fittings, rim and relief and their corner, over the chrome substrate.
 *  Celestial, by the owner's choice: its Command center and Home read as one set, navy with the gold studs and rim; Files
 *  (its places, recent cards, folder and open file) and the Notes cards are drawn the same way to stay in that set. */
export const DEFAULT_FRAMED_ROUTE_PANELS: string[] = ['.cmd-panel', '.fl-plate', '.nt-card', '.ob-panel', '.ob-card', '.cve-body'];
/** A route panel drawn on another of the material's substrates than the page default (chrome, or the card paper on a light material): Ember's
 *  Notes cards are the navy leather ('user' substrate, the Home cards'), the rest of its pages keep the black. */
export const ROUTE_PANEL_SUBSTRATE: Partial<Record<MaterialId, Record<string, 'user'>>> = { 'smoked-copper': { '.nt-card': 'user' } };
/** Per-material override of the default list (a material listed here gets exactly that list; [] turns framing off for it). */
export const FRAMED_ROUTE_OVERRIDES: Partial<Record<MaterialId, string[]>> = {};
/** Every material wears the plate frame on its route panels, except Hedgewitch (its own paper system, no plates). Extra readable turns plates off in the generator. */
export const FRAMED_ROUTE_PANELS: Partial<Record<MaterialId, string[]>> = Object.fromEntries(
  MATERIAL_IDS.filter(id => id !== 'hedgewitch').map(id => [id, FRAMED_ROUTE_OVERRIDES[id] ?? DEFAULT_FRAMED_ROUTE_PANELS]),
);

export const PLATES: PlateDef[] = [
  plate('.message.companion', '0 2px 8px rgba(20, 10, 5, 0.22)', '--surface-companion', { border: true, ornament: true }),
  plate('.message.user', '0 2px 8px rgba(20, 10, 5, 0.2)', '--surface-user', { border: true }),
  plate('.chat-header', 'none', '--surface-chrome', { kind: 'chrome', border: true, mount: false }),
  plate('.thread-sidebar', 'none', '--sidebar-bg', { corner: 22, cornerMobile: 18, chromeInLight: true, ornament: true }),
  plate('.composer-inner', '0 6px 20px rgba(20, 10, 5, 0.3)', '--surface-chrome', { kind: 'chrome', border: true, chromeInLight: true }),
  plate('.settings-content-inner', '0 10px 30px rgba(20, 10, 5, 0.35)', '--settings-panel-bg', { corner: 22, cornerMobile: 18, border: true }),
  plate('.settings-subnav', 'none', '--surface-chrome', { kind: 'chrome', corner: 0, cornerMobile: 0, radius: 0, edge: 'right', mount: false }),
  plate('.nav-rail', 'none', '--surface-chrome', { corner: 0, cornerMobile: 0, radius: 0, edge: 'right', mount: false }),
  plate('.drawer-panel', 'none', '--surface-chrome', { corner: 0, cornerMobile: 0, radius: 0, edge: 'right', mount: false }),
  /* The phone top bar is the header of every page but chat; chat's own header is `.chat-header`. Both wear the same frame (full border + corner fittings). */
  plate('.mobile-topbar', 'none', '--surface-chrome', { kind: 'chrome', border: true, mount: false }),
  plate('.cdlg-panel', '0 8px 32px rgba(0, 0, 0, 0.55)', '--card-bg', { border: true }),
  plate('.home-card', '0 10px 30px rgba(20, 10, 5, 0.35)', '--card-bg', { corner: 22, cornerMobile: 18 }),
  plate('.night-shelf', 'none', '--card-bg', { border: true }),
  plate('.login-card', '0 10px 30px rgba(20, 10, 5, 0.35)', '--login-card-bg', { corner: 22, cornerMobile: 18 }),
  plate('.search-panel', '0 12px 40px rgba(0, 0, 0, 0.45)', '--surface-popover', { border: true, cornerMobile: 16, corner: 20 }),
  plate('.cp-modal', '0 12px 40px rgba(0, 0, 0, 0.45)', '--card-bg', { border: true }),
];

/**
 * Chips and pills (step 4): the floating labels that carry their own plate (the empty line, the Home heading and identity, the day / new /
 * system dividers) get a 1px edge in the trim; the pills that already have a border (the update pill, the plus menu, the job panel) take
 * the trim as its colour. Every material, standard readability (Extra readable keeps its own 2px edge).
 */
export const CHIPS: string[] = ['.empty-state-text', '.home-hero-chip', '.day-divider-label', '.new-divider-label', '.system-text'];
export const BORDERED_PILLS: string[] = ['.update-pill', '.plus-menu', '.jtd-panel'];

/** The plates a mounted material (Library) sets in a dark backing with a brass edge, each with the soft drop shadow it keeps under the ring. */
export const MOUNT_PLATES: Array<[selector: string, drop: string]> = PLATES.filter(p => p.mount).map(p => [p.selector, p.drop]);

/**
 * Textures. The pattern files are generated (textures.ts); the amplitude is decided here, per material:
 * the file is laid over the plate's own opaque colour at `alpha`, so the plate stays opaque and the worst
 * possible single-ink texture pixel is `mix(plate, ink, alpha)`. The default ceiling and explicit
 * measured per-material exceptions bound amplitude; materials.test.ts pins every value under it and checks the text pairs on the worst composite.
 */
export const TEXTURE_ALPHA_MIN = 0.08;
export const TEXTURE_ALPHA_CEILING = 0.16;
/** This low-contrast paper raster needs a measured stronger normal blend to retain visible fibers. */
/** Ember's leathers, Moonlit Cloister's cloths and the Library's parchments are the plates themselves (cut from the original Ember plate art and capped below every ink's bound, see
 *  their measured extremes), so they lie at nearly full strength; the plate colour under them is each leather's own mean. */
export const MATERIAL_TEXTURE_ALPHA_CEILINGS: Partial<Record<MaterialId, number>> = { 'mounted-paper': 0.92, 'smoked-copper': 0.92, 'midnight-ink': 0.92, 'black-damask': 0.92, 'botanical-linen': 0.92, 'indigo-silk': 0.92 };
/** The texture model is checked against 4.5:1 plus this margin: the measured worst pixel on screen came out up to 0.07 under the model (antialiasing), so 4.6 in the model is 4.5 on screen. */
/** A leaf stem is about half a pixel wide at the size it is drawn, so no pixel carries the full ink: measured on screen the strongest
 *  ornament pixel reaches about this share of it. The model uses it, with the margin below, as its worst case. */
export const ORNAMENT_COVERAGE = 0.6;
export const TEXTURE_CONTRAST_MARGIN = 0.1;

export interface TextureLayer {
  url: string; ink: string; alpha: number;
  /** Fixed repeat size in CSS px, independent of plate dimensions. */
  tilePx: number;
  /** Per-channel raster bounds measured from the actual, unretouched asset. Omit for single-ink SVGs. */
  extremes?: readonly [darkest: string, lightest: string];
  /** Multiply tints real leather with its plate colour, so navy stays navy rather than gray. */
  blend?: 'multiply';
}
/**
 * Painted ornament variants: each plate's data-orn index (0 .. 2 x paintings - 1) picks a painting and a corner, upright at the
 * bottom (even) or hanging from the top (odd). The plates in `rightPlates` carry theirs on the right (and keep the right clear),
 * mirrored and toned for a lighter substrate; the rest on the ornament's own side. A phone's Home cards keep theirs at the bottom.
 */
export interface OrnamentVariants {
  paintings: string[];
  /** The file for a painting at a corner: {painting} and {corner} (bl, tl, br, tr) are filled in. */
  template: string;
  rightPlates: string[];
  /** True: a variant may also cross to the plate's other side (the reserved space moves with it). */
  alternate?: boolean;
}

/** A plate's data-orn runs 0 .. ORNAMENT_SLOTS - 1 (a message's: its sequence in the thread, modulo); a material's variants
 *  repeat over the slots. 24 is a multiple of the 4-corner cycle, so the cycle runs on across the wrap. */
export const ORNAMENT_SLOTS = 24;
export interface OrnamentVariant { painting: string; top: boolean; flip: boolean }
/**
 * The variants in slot order. The corner cycles every four slots: upright then hanging on the plate's own side, then the same on
 * the other side (where the material alternates; otherwise upright, upright, hanging, hanging). So consecutive messages differ
 * top and bottom, and a speaker's every other message (two slots on) swaps sides. The painting steps with the slot (shifted
 * once per cycle when the counts share a factor), so every painting meets every corner.
 */
export function ornamentVariants(v: OrnamentVariants): OrnamentVariant[] {
  const corners: Array<[flip: boolean, top: boolean]> = v.alternate ? [[false, false], [false, true], [true, false], [true, true]] : [[false, false], [false, false], [false, true], [false, true]];
  const P = v.paintings.length, C = corners.length;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const coprime = gcd(P, C) === 1;
  return Array.from({ length: P * C }, (_, i) => {
    const [flip, top] = corners[i % C];
    return { painting: v.paintings[coprime ? i % P : (i + Math.floor(i / C)) % P], top, flip };
  });
}
export const ornamentVariantUrl = (v: OrnamentVariants, painting: string, corner: 'bl' | 'tl' | 'br' | 'tr'): string =>
  v.template.replace('{painting}', painting).replace('{corner}', corner);

export interface MaterialTexture {
  /** Optional, material-owned edge hardware. Separate from grain, motifs and room scenery. */
  relief?: { corners: Record<'tl' | 'tr' | 'br' | 'bl', string>; plateShadow: string; frameShadow: string; cornerPx?: number; cornerMobilePx?: number;
    /** A light material's dark chrome plates (the Library's wood): their own rim, in place of the paper's. */
    chromeShadow?: string };
  /** Separate user substrate (Vampire red velvet), never the companion damask. */
  user?: TextureLayer;
  /** Separate companion substrate (the Conservatory's slate linen), where the companion's plate differs from the panels'. */
  companion?: TextureLayer;
  /** Separate composer substrate (Ember's black leather): the bar is the field, so the message field inside it is clear. */
  composer?: TextureLayer;
  /** Low-amplitude woven motif over real cloth; omitted on the separate user substrate. */
  pattern?: TextureLayer;
  /** Burnt paper only in the outer edge band, outside the existing 9px minimum text inset. */
  edge?: { ink: string; alpha: number; widthPx: number };
  card: TextureLayer;
  chrome: TextureLayer;
  /** Optional tile inside an active text editor. Null: keep its opaque material-owned colour. */
  editor: { url: string; ink: string; tilePx: number } | null;
  /** Separate bounded, non-repeating edge ornament, at its material-owned location/size. */
  ornament: { url: string; ink: string; alpha: number; sizePx: number; mobileSizePx?: number; position?: string; clearance?: boolean; variants?: OrnamentVariants } | null;
  /** The menu's own foot ornament, cut from the demo's menu (Celestial's compass); without one the rail's foot shows the
   *  Home ornament. */
  rail?: string;
}

const TEXTURES: Record<Exclude<MaterialId, 'hedgewitch'>, MaterialTexture> = {
  'black-damask': {
    // The Vampire mock-up's black damask (its brocade grown from the painted plates in large blocks, so the motifs' lace survives:
    // texgen.py with TEXGEN_BLOCK and TEXGEN_SIGMA) and its crimson velvet "You"; the gold filigree cut from the Home plate's corners
    // without the rim (brackets.py), the rim drawn from its measured profile: a lit gold line, a black gap, a fine bronze line.
    card: { url: '/skins/salon/velvet-damask.webp', ink: '#232423', alpha: 0.92, tilePx: 576, extremes: ['#000000', '#232423'] },
    chrome: { url: '/skins/salon/velvet-damask.webp', ink: '#232423', alpha: 0.92, tilePx: 576, extremes: ['#000000', '#232423'] },
    user: { url: '/skins/salon/velvet-crimson.webp', ink: '#66171C', alpha: 0.92, tilePx: 576, extremes: ['#2A0000', '#66171C'] },
    relief: {
      corners: { tl: '/skins/salon/velvet-filigree-tl.webp', tr: '/skins/salon/velvet-filigree-tr.webp', br: '/skins/salon/velvet-filigree-br.webp', bl: '/skins/salon/velvet-filigree-bl.webp' },
      cornerPx: 36, cornerMobilePx: 30,
      plateShadow: 'inset 0 1px 0 rgba(255, 236, 190, 0.5), inset 0 0 0 1px #C9A065, inset 0 0 0 2px #7A5A30, inset 0 0 0 5px #0A0807, inset 0 0 0 6px #7F654C, inset 0 0 10px rgba(0, 0, 0, 0.45), 0 3px 10px rgba(0, 0, 0, 0.45)',
      frameShadow: 'inset 0 1px 0 rgba(255, 236, 190, 0.45), inset 0 0 0 1px #C9A065, inset 0 0 0 2px #7A5A30',
    },
    ornament: null,
    editor: null,
  },
  // The Library mock-up's own aged parchment (cream, and a darker tan for "You"), grown from its plates (texgen.py) with the darkest
  // fibres rolled off above every ink's bound (paperfin.py); its polished gold brackets cut by their outline from the Home plate's
  // corners (goldbrackets.py), drawn over the mount's dark rim and brass line; the chrome the oxblood wood of the Library demo's
  // rail, its grain upright (texgen.py, TEXGEN_NOFLIP and TEXGEN_ANISO).
  'mounted-paper': {
    card: { url: '/skins/library/library-parchment.webp', ink: '#E3BC81', alpha: 0.9, tilePx: 512, extremes: ['#E3BC81', '#FFEEBC'] },
    chrome: { url: '/skins/library/library-wood.webp', ink: '#3C1C12', alpha: 0.92, tilePx: 512, extremes: ['#240C00', '#3C1C12'] },
    user: { url: '/skins/library/library-you.webp', ink: '#A37D56', alpha: 0.9, tilePx: 512, extremes: ['#A37D56', '#E7C39D'] },
    edge: { ink: '#633918', alpha: 0.58, widthPx: 8 },
    relief: {
      corners: { tl: '/skins/library/library-bracket-tl.webp', tr: '/skins/library/library-bracket-tr.webp', br: '/skins/library/library-bracket-br.webp', bl: '/skins/library/library-bracket-bl.webp' },
      cornerPx: 30, cornerMobilePx: 26,
      // the mount's dark rim and brass line (outside), a lit top edge, a fine dark groove inside, a soft shadow off it
      plateShadow: 'var(--skin-mount-ring), inset 0 1px 0 rgba(255, 240, 200, 0.55), inset 0 0 0 1px #3A1E0C, inset 0 0 6px rgba(70, 35, 10, 0.35), 0 3px 10px rgba(0, 0, 0, 0.4)',
      frameShadow: 'inset 0 1px 0 rgba(255, 240, 200, 0.45), inset 0 0 0 1px #3A1E0C',
      // the wood plates: a dark ring and the oxblood edge, a faint warm top light, a dark groove, sunk a little
      chromeShadow: '0 0 0 2px var(--surface-chrome), 0 0 0 3px #7E3420, inset 0 1px 0 rgba(255, 190, 160, 0.14), inset 0 0 0 1px #160602, inset 0 0 8px rgba(0, 0, 0, 0.4), 0 3px 10px rgba(0, 0, 0, 0.4)',
    },
    ornament: null,
    editor: null,
  },
  // The Moonlit Cloister painting's own navy twill (companion, panels, chrome) and lighter "You" cloth, grown from its plates
  // (packages/frontend/scripts/skin-art/texgen.py, the weave's lean kept); its riveted silver brackets cut from the Home plate's
  // corners without the rim (brackets.py), the rim drawn here from the painting's measured profile (bright silver, black groove,
  // a fine inner silver line); its blue sprig lifted off the cloth (sprig.py), in the reserved bottom-left corner.
  'midnight-ink': {
    card: { url: '/skins/cloister/cloister-navy-cloth.webp', ink: '#182238', alpha: 0.92, tilePx: 576, extremes: ['#000418', '#182238'] },
    chrome: { url: '/skins/cloister/cloister-navy-cloth.webp', ink: '#182238', alpha: 0.92, tilePx: 576, extremes: ['#000418', '#182238'] },
    user: { url: '/skins/cloister/cloister-you-cloth.webp', ink: '#38466E', alpha: 0.92, tilePx: 576, extremes: ['#0E1F47', '#38466E'] },
    relief: {
      corners: { tl: '/skins/cloister/cloister-bracket-tl.webp', tr: '/skins/cloister/cloister-bracket-tr.webp', br: '/skins/cloister/cloister-bracket-br.webp', bl: '/skins/cloister/cloister-bracket-bl.webp' },
      cornerPx: 32, cornerMobilePx: 28,
      plateShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.5), inset 0 0 0 1px #8E97A8, inset 0 0 0 2px #03060F, inset 0 0 0 3px #929CAD, inset 0 0 0 4px #050A18, inset 0 0 10px rgba(0, 0, 0, 0.45), 0 3px 10px rgba(0, 0, 0, 0.45)',
      frameShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.5), inset 0 0 0 1px #8E97A8, inset 0 0 0 2px #03060F',
    },
    ornament: {
      url: '/skins/cloister/cloister-sprig-comp-bl.webp', ink: '#6F8CC8', alpha: 1, sizePx: 72, mobileSizePx: 48, position: '0 100%', clearance: true,
      // the three painted sprigs of the plates, each upright or hanging; on the lighter "You" bubbles and Home cards, mirrored to the right
      variants: { paintings: ['home', 'comp', 'you'], template: '/skins/cloister/cloister-sprig-{painting}-{corner}.webp', rightPlates: ['.message.user', '.home-card'] },
    },
    editor: null,
  },
  'botanical-linen': {
    // The Conservatory mock-up's three linens, grown from its plates (texgen.py) and set to their plate colours (clothfin.py): deep
    // navy (Home, panels, chrome), slate blue (the companion) and indigo ("You"); its silver studs cut from the Home plate's left
    // corners (the right ones mirrored: the painted right corners carry leaves), the rim from its measured profile (a bright
    // silver line, a steel band, a black groove); its leaf-and-blossom sprigs lifted off the cloth by colour (lift.py).
    card: { url: '/skins/conservatory/greenhouse-navy.webp', ink: '#36485B', alpha: 0.92, tilePx: 512, extremes: ['#00000B', '#36485B'] },
    chrome: { url: '/skins/conservatory/greenhouse-navy.webp', ink: '#36485B', alpha: 0.92, tilePx: 512, extremes: ['#00000B', '#36485B'] },
    companion: { url: '/skins/conservatory/greenhouse-slate.webp', ink: '#3C546D', alpha: 0.92, tilePx: 512, extremes: ['#061E36', '#3C546D'] },
    user: { url: '/skins/conservatory/greenhouse-indigo.webp', ink: '#4B5377', alpha: 0.92, tilePx: 512, extremes: ['#030B2D', '#4B5377'] },
    relief: {
      corners: { tl: '/skins/conservatory/greenhouse-stud-tl.webp', tr: '/skins/conservatory/greenhouse-stud-tr.webp', br: '/skins/conservatory/greenhouse-stud-br.webp', bl: '/skins/conservatory/greenhouse-stud-bl.webp' },
      cornerPx: 34, cornerMobilePx: 28,
      plateShadow: 'inset 0 1px 0 rgba(225, 238, 248, 0.6), inset 0 0 0 1px #ABB8C4, inset 0 0 0 4px #4E5E6C, inset 0 0 0 5px #0E1520, inset 0 0 8px rgba(0, 0, 0, 0.45), 0 3px 10px rgba(0, 0, 0, 0.45)',
      frameShadow: 'inset 0 1px 0 rgba(225, 238, 248, 0.55), inset 0 0 0 1px #ABB8C4, inset 0 0 0 4px #4E5E6C',
    },
    ornament: {
      url: '/skins/conservatory/greenhouse-sprig-comp-br.webp', ink: '#8FA394', alpha: 1, sizePx: 72, mobileSizePx: 48, position: '100% 100%', clearance: true,
      // the four painted sprigs (the Home plate's, both of the companion plate's, the "You" plate's), each upright or hanging, on
      // either side, so a thread and the Home page vary
      variants: { paintings: ['home', 'comp', 'bloom', 'you'], template: '/skins/conservatory/greenhouse-sprig-{painting}-{corner}.webp', rightPlates: [], alternate: true },
    },
    editor: null,
  },
  'indigo-silk': {
    // The Celestial mock-up's linens, grown from its plates (texgen.py) and set to their plate colours (clothfin.py): midnight
    // navy (companion, panels, chrome, and the Home cards, which the owner chose to match the Command center's) and violet
    // ("You"); its gold studs cut
    // from the Home plate's left corners (the right ones mirrored: the painted right corners carry stars), the rim from its
    // measured profile (a bright gold line, a dark gap, a fine bronze inner line); its gold moons and stars lifted off the
    // cloth by colour (lift.py), on either side, upright or hanging.
    card: { url: '/skins/night/celestial-navy.webp', ink: '#3C4359', alpha: 0.92, tilePx: 512, extremes: ['#000010', '#3C4359'] },
    chrome: { url: '/skins/night/celestial-navy.webp', ink: '#3C4359', alpha: 0.92, tilePx: 512, extremes: ['#000010', '#3C4359'] },
    user: { url: '/skins/night/celestial-violet.webp', ink: '#4D476D', alpha: 0.92, tilePx: 512, extremes: ['#050022', '#4D476D'] },
    relief: {
      corners: { tl: '/skins/night/celestial-stud-tl.webp', tr: '/skins/night/celestial-stud-tr.webp', br: '/skins/night/celestial-stud-br.webp', bl: '/skins/night/celestial-stud-bl.webp' },
      cornerPx: 34, cornerMobilePx: 28,
      plateShadow: 'inset 0 1px 0 rgba(255, 242, 166, 0.5), inset 0 0 0 1px #9C7A45, inset 0 0 0 2px #E6C47E, inset 0 0 0 3px #6C5034, inset 0 0 0 5px #050507, inset 0 0 0 6px #887159, inset 0 0 10px rgba(0, 0, 0, 0.45), 0 3px 10px rgba(0, 0, 0, 0.45)',
      frameShadow: 'inset 0 1px 0 rgba(255, 242, 166, 0.45), inset 0 0 0 1px #9C7A45, inset 0 0 0 2px #E6C47E, inset 0 0 0 3px #6C5034',
    },
    ornament: {
      // drawn larger than the sprigs: the painted moons are fine gold lines (thickened a pixel when cut), lost at sprig size
      url: '/skins/night/celestial-moon-comp-br.webp', ink: '#C9A15E', alpha: 1, sizePx: 112, mobileSizePx: 64, position: '100% 100%', clearance: true,
      variants: { paintings: ['home', 'comp', 'you'], template: '/skins/night/celestial-moon-{painting}-{corner}.webp', rightPlates: [], alternate: true },
    },
    // the astrolabe arcs and four-point star at the foot of the demo's menu (lift.py, its hairlines thickened)
    rail: '/skins/night/celestial-rail-compass.webp',
    editor: null,
  },
  // The leathers of the approved study: black for the companion's plates, the panels, the menu and the input bar, navy for "You" and
  // the Home cards, each a seamless tile grown from the study's own creased grain (packages/frontend/scripts/skin-art/texgen.py),
  // its brightest pixels rolled off under every ink's bound. The copper brackets are cut from the original Ember plate art
  // (packages/frontend/scripts/skin-art/corners.py).
  'smoked-copper': {
    card: { url: '/skins/ember/ember-black-leather.webp', ink: '#252221', alpha: 0.92, tilePx: 576, extremes: ['#050401', '#252221'] },
    chrome: { url: '/skins/ember/ember-black-leather.webp', ink: '#252221', alpha: 0.92, tilePx: 576, extremes: ['#050401', '#252221'] },
    user: { url: '/skins/ember/ember-navy-leather.webp', ink: '#263349', alpha: 0.92, tilePx: 576, extremes: ['#041125', '#263349'] },
    composer: { url: '/skins/ember/ember-black-leather.webp', ink: '#252221', alpha: 0.92, tilePx: 576, extremes: ['#050401', '#252221'] },
    relief: {
      corners: { tl: '/skins/ember/ember-fitting-tl.webp', tr: '/skins/ember/ember-fitting-tr.webp', br: '/skins/ember/ember-fitting-br.webp', bl: '/skins/ember/ember-fitting-bl.webp' },
      cornerPx: 24, cornerMobilePx: 20,
      // The painted rim: a two-pixel copper band lit along its top, a dark groove inside it, a soft shadow off the leather.
      plateShadow: 'inset 0 1px 0 rgba(254, 239, 218, 0.45), inset 0 0 0 1px rgba(195, 126, 89, 0.9), inset 0 0 0 2px #1A0C07, inset 0 0 8px rgba(0, 0, 0, 0.45), 0 3px 10px rgba(0, 0, 0, 0.35)',
      frameShadow: 'inset 0 1px 0 rgba(254, 239, 218, 0.45), inset 0 0 0 1px rgba(195, 126, 89, 0.9), inset 0 0 0 2px #1A0C07',
    },
    ornament: null,
    editor: null,
  },
};

const LABELS: Record<MaterialId, string> = {
  'black-damask': 'Crimson Velvet',
  'mounted-paper': 'Oxblood Library',
  'midnight-ink': 'Moonlit Cloister',
  'botanical-linen': 'Rain Greenhouse',
  'indigo-silk': 'Celestial',
  'smoked-copper': 'Smoked copper',
  hedgewitch: 'Hedgewitch parchment',
};

const DEFAULT_ROOM: Record<MaterialId, RoomId> = {
  'black-damask': 'salon',
  'mounted-paper': 'library',
  'midnight-ink': 'cloister',
  'botanical-linen': 'conservatory',
  'indigo-silk': 'night',
  'smoked-copper': 'ember',
  hedgewitch: 'hedgewitch',
};

/** Nudge `fg` toward `toward` in small steps until it reaches `min` against `bg`. Deterministic. */
function ensure(fg: string, bg: string, min: number, toward: string): string {
  let c = fg;
  for (let t = 0; t <= 1.0001 && contrastRatio(c, bg) < min; t += 0.05) c = mix(fg, toward, Math.min(t, 1));
  return c;
}

export function deriveRoles(p: BasePalette): Roles {
  const scheme: Scheme = relativeLuminance(parseColor(p.panel)!) < 0.4 ? 'dark' : 'light';
  const dark = scheme === 'dark';
  const panelAlt = mix(p.panel, p.text, 0.04);
  const panelDeep = mix(p.panel, p.text, dark ? 0.08 : 0.06);
  const panelRaised = p.raised ?? (dark ? mix(p.panel, p.text, 0.06) : mix(p.panel, '#FFFFFF', 0.4));
  const sidebar = p.sidebar ?? p.panel;
  const link = p.link;
  const linkBright = mix(link, dark ? '#FFFFFF' : '#000000', 0.22);
  const linkDim = ensure(mix(link, p.panel, 0.25), p.panel, TEXT_MIN, p.text);
  return {
    ...p,
    sidebar,
    divider: p.divider ?? p.trim,
    frame: p.frame ?? p.trim,
    composer: p.composer ?? p.input,
    composerMuted: p.composerMuted ?? ensure(p.muted, p.composer ?? p.input, TEXT_MIN, p.text),
    chromeOnButton: p.chromeOnButton ?? p.chromeText,
    editor: p.editor ?? null,
    scheme,
    panelAlt, panelDeep, panelRaised,
    companion: p.companion ?? p.input, companionText: p.text,
    inputText: p.text,
    placeholder: ensure(p.muted, p.input, TEXT_MIN, p.text),
    chromeDeep: mix(p.chrome, '#000000', 0.25),
    chromeMuted: ensure(mix(p.chromeText, p.chrome, 0.28), p.chrome, TEXT_MIN, p.chromeText),
    chromeSelected: p.chromeSelected ?? mix(p.chrome, p.chromeText, 0.16),
    buttonEdge: p.buttonEdge ?? p.controlBorder,
    accentSelected: p.accentSelected ?? p.chromeSelected ?? mix(p.chrome, p.chromeText, 0.16),
    chromeTrim: p.chromeTrim ?? p.trim,
    popover: p.input, popoverText: p.text,
    code: dark ? p.chrome : mix(p.panel, p.text, 0.1),
    codeText: p.text,
    codeMuted: ensure(p.secondary, dark ? p.chrome : mix(p.panel, p.text, 0.1), TEXT_MIN, p.text),
    buttonHover: mix(p.button, '#000000', 0.14),
    controlHover: mix(p.input, p.text, 0.08),
    controlSelected: p.button, controlSelectedText: p.buttonText,
    controlDisabled: panelDeep,
    controlDisabledText: ensure(p.secondary, panelDeep, TEXT_MIN, p.text),
    // The library's own focus colour is dark ink on paper; its dark chrome needs the light brass.
    focusChrome: p.focusChrome ?? (dark ? p.focus : '#F0D397'),
    warning: p.warning ?? (dark ? '#F0C87C' : '#7A4B10'),
    errorChrome: dark ? p.error : '#FFB4A9',
    userDanger: p.userDanger ?? p.error,
    linkBright, linkDim,
    gold: ensure(p.trim, p.panel, TEXT_MIN, p.text),
    // A dark material's chat list is its own surface; a chosen chrome selection (Crimson Velvet's crimson) marks the open chat there too.
    threadActive: dark && p.chromeSelected ? p.chromeSelected : mix(sidebar, link, dark ? 0.2 : 0.16),
  };
}

export const MATERIALS: Record<MaterialId, MaterialDef> = Object.fromEntries(
  MATERIAL_IDS.map(id => {
    const base = BASE_PALETTES[id];
    const roles = base ? deriveRoles(base) : null;
    const def: MaterialDef = {
      id,
      label: LABELS[id],
      defaultRoom: DEFAULT_ROOM[id],
      legacy: !base,
      scheme: roles ? roles.scheme : 'light',
      roles,
      mounted: MOUNTED.has(id) && !!roles,
      texture: base ? TEXTURES[id as Exclude<MaterialId, 'hedgewitch'>] : null,
      chipRadius: base ? CHIP_RADIUS[id] ?? null : null,
      accents: base ? ACCENTS[id] ?? [] : [],
      accentSubstrate: ACCENT_SUBSTRATE[id] ?? 'user',
      flat: FLAT[id] && roles ? FLAT[id]! : null,
    };
    return [id, def];
  }),
) as Record<MaterialId, MaterialDef>;

export const MATERIAL_LIST: MaterialDef[] = MATERIAL_IDS.map(id => MATERIALS[id]);

export function isMaterialId(v: unknown): v is MaterialId {
  return typeof v === 'string' && (MATERIAL_IDS as readonly string[]).includes(v);
}

const rgba = (hex: string, a: number): string => {
  const c = parseColor(hex)!;
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;
};

/** Every semantic role, as the CSS custom property that carries it. */
export const SURFACE_ROLE_VARS: Array<[cssVar: string, role: keyof Roles]> = [
  ['--surface-panel', 'panel'], ['--surface-panel-text', 'text'], ['--surface-panel-secondary', 'secondary'], ['--surface-panel-muted', 'muted'],
  ['--surface-panel-alt', 'panelAlt'], ['--surface-panel-deep', 'panelDeep'], ['--surface-panel-raised', 'panelRaised'],
  ['--surface-user', 'user'], ['--surface-user-text', 'userText'],
  ['--surface-companion', 'companion'], ['--surface-companion-text', 'companionText'],
  ['--surface-input', 'input'], ['--surface-input-text', 'inputText'], ['--surface-input-placeholder', 'placeholder'],
  ['--surface-chrome', 'chrome'], ['--surface-chrome-deep', 'chromeDeep'], ['--surface-chrome-text', 'chromeText'],
  ['--surface-chrome-muted', 'chromeMuted'], ['--surface-chrome-selected', 'chromeSelected'],
  ['--surface-header', 'chrome'], ['--surface-header-text', 'chromeText'], ['--surface-header-muted', 'chromeMuted'],
  ['--surface-popover', 'popover'], ['--surface-popover-text', 'popoverText'],
  ['--surface-code', 'code'], ['--surface-code-text', 'codeText'], ['--surface-code-muted', 'codeMuted'],
  ['--control-bg', 'input'], ['--control-text', 'text'], ['--control-border', 'controlBorder'],
  ['--control-hover-bg', 'controlHover'], ['--control-selected-bg', 'controlSelected'], ['--control-selected-text', 'controlSelectedText'],
  ['--control-disabled-bg', 'controlDisabled'], ['--control-disabled-text', 'controlDisabledText'],
  ['--control-primary-bg', 'button'], ['--control-primary-text', 'buttonText'], ['--control-primary-hover', 'buttonHover'],
  ['--link', 'link'], ['--focus-ring', 'focus'], ['--focus-ring-chrome', 'focusChrome'],
  ['--status-error-text', 'error'], ['--status-success-text', 'success'], ['--status-warning-text', 'warning'], ['--status-error-chrome', 'errorChrome'],
];

/**
 * Semantic roles that have an editable legacy twin point at it, so a colour the
 * person sets in the editor (which writes the legacy name) still reaches every
 * surface that has moved to the semantic name.
 */
export const ROLE_ALIASES: Record<string, string> = {
  '--surface-panel': '--bg-primary',
  '--surface-panel-text': '--text-primary',
  '--surface-panel-secondary': '--text-secondary',
  '--surface-panel-muted': '--text-muted',
  '--surface-companion-text': '--text-primary',
  '--surface-input': '--bg-input',
  '--surface-input-text': '--text-primary',
  '--surface-user-text': '--lavender-bright',
  '--link': '--amber',
};

/**
 * Every CSS variable a skin material sets: the semantic roles, plus the legacy
 * names (--bg-primary, --text-primary, --amber, --lavender ...) as adapters so
 * components that still read the old names get the matching pair.
 */
export function materialVars(r: Roles): Record<string, string> {
  const v: Record<string, string> = {};
  for (const [name, role] of SURFACE_ROLE_VARS) v[name] = r[role] as string;
  Object.assign(v, {
    '--surface-popover-border': r.controlBorder,
    // Where the classic look uses a gradient, an image or a translucent wash, a skin uses its own solid surface.
    '--login-card-bg': r.panel, '--login-frame-image': 'none',
    '--chrome-rail-bg': r.chrome, '--chrome-bar-bg': r.chrome, '--chrome-bar-border': rgba(r.chromeText, 0.18),
    '--surface-blur': 'none', '--surface-code-inline': r.code, '--control-primary-edge': r.buttonEdge,
    '--sidebar-bg': r.sidebar, '--divider': rgba(r.controlBorder, 0.5),
    '--surface-header-border': r.chromeMuted, '--surface-header-title': r.chromeText, '--surface-header-icon': r.chromeText,
    '--surface-header-mobile': r.chrome, '--surface-header-blur': 'none', '--surface-header-menu': r.chromeDeep,
    '--tab-bg': r.chrome, '--tab-text': r.chromeText, '--tab-border': r.chromeMuted, '--tab-dim-text': r.chromeMuted,
    '--tab-active-bg': r.panel, '--tab-active-text': r.text, '--tab-badge-bg': r.linkDim, '--tab-badge-text': r.panel,
    '--header-badge-bg': r.chromeText, '--header-badge-text': r.chrome,
    '--card-bg': r.panel,
    '--settings-error': r.error, '--settings-warning': r.warning, '--settings-success': r.success,
    '--settings-ink': r.text, '--settings-ink-2': r.secondary, '--settings-ink-3': r.muted,
    '--settings-panel-bg': r.panel, '--settings-panel-blur': 'none', '--settings-panel-border': r.controlBorder,
    '--settings-subnav-bg': r.chrome, '--settings-subnav-border': rgba(r.chromeText, 0.18),
    '--subnav-ink': r.chromeText, '--subnav-ink-2': r.chromeText, '--subnav-ink-3': r.chromeMuted, '--subnav-accent': r.chromeText, '--subnav-danger': r.errorChrome,
    '--settings-field-bg': r.input, '--settings-field-text': r.inputText, '--settings-field-border': r.controlBorder, '--settings-field-placeholder': r.placeholder,
    '--home-head-text': r.chromeText, '--home-head-border': r.chromeText,
    // No sprig is drawn on a skin's Home cards, so none of the four widths keeps room for one (phone text runs to the edge).
    '--home-sprig-display': 'none', '--home-sprig-room': '0rem', '--home-sprig-room-m': '0rem', '--home-sprig-room-phone': '0rem', '--home-sprig-room-half': '0rem',
    '--settings-hairline': rgba(r.controlBorder, 0.5), '--field-border': r.controlBorder, '--field-border-focus': r.focus,
    '--toggle-off-bg': r.panelDeep, '--toggle-off-border': r.controlBorder, '--toggle-off-thumb': r.muted,
    '--toggle-on-bg': r.button, '--toggle-on-border': r.controlBorder, '--toggle-on-thumb': r.buttonText,
    '--settings-disabled-bg': r.controlDisabled, '--settings-disabled-text': r.controlDisabledText,
    '--btn-border-primary': r.controlBorder, '--btn-border-muted': r.controlBorder, '--btn-border-muted-hover': r.text, '--btn-border-danger': r.error,
    '--menu-ink': menuInk(r), '--menu-mark': menuMark(r),
    '--chip-bg': r.chrome, '--chip-text': r.chromeText, '--chip-pad': '0.2rem 0.7rem', '--chip-shadow': 'none', '--composer-bg': r.composer, '--composer-border': r.controlBorder, '--composer-muted': r.composerMuted, '--surface-pill-bg': r.chrome, '--surface-pill-blur': 'none',
    '--surface-chrome-text-hover': r.chromeText, '--chrome-hover-wash': rgba(r.chromeText, 0.1),
    '--chrome-pill-border': r.chromeMuted, '--chrome-control-border': r.chromeMuted,
    '--approval-allow-bg': r.button, '--approval-allow-border': r.chromeMuted, '--approval-allow-hover': r.buttonHover,
    '--surface-user-meta': r.userText,
    '--surface-user-danger': r.userDanger,
    '--skin-frame-shadow': '0 10px 30px rgba(0, 0, 0, 0.35)',
    // legacy adapters
    '--bg-primary': r.panel, '--bg-secondary': r.panelAlt, '--bg-tertiary': r.panelDeep, '--bg-surface': r.panelRaised, '--bg-input': r.input,
    '--text-primary': r.text, '--text-secondary': r.secondary, '--text-muted': r.muted,
    '--amber': r.link, '--amber-bright': r.linkBright, '--amber-dim': r.linkDim,
    '--amber-glow': rgba(r.link, 0.2), '--amber-subtle': rgba(r.link, 0.1),
    '--lavender': r.link, '--lavender-bright': r.userText, '--lavender-dim': r.linkDim,
    '--lavender-glow': rgba(r.link, 0.2), '--lavender-subtle': r.user,
    '--gold': r.gold, '--gold-bright': mix(r.gold, r.scheme === 'dark' ? '#FFFFFF' : '#000000', 0.2), '--gold-dim': r.trim,
    '--gold-glow': rgba(r.trim, 0.16),
    '--companion-bg': r.companion, '--companion-border': r.trim, '--companion-edge': rgba(r.link, 0.5),
    '--user-bg': r.user, '--user-border': r.trim, '--user-edge': rgba(r.link, 0.5),
    '--presence': '#E0A020',
    '--ink-on-wood': r.chromeText, '--wood-1': r.chrome, '--wood-2': r.chromeDeep,
    '--parchment': r.panel, '--parchment-edge': r.panelDeep,
    '--lavender-fill': r.button, '--lavender-fill-hover': r.buttonHover,
    '--thread-active': r.threadActive, '--thread-active-text': r.text,
    '--panel-shadow': '0 10px 30px rgba(0, 0, 0, 0.35)',
    '--status-active': r.success, '--status-waking': '#E0A020',
    '--border': rgba(r.controlBorder, 0.45), '--border-hover': rgba(r.controlBorder, 0.8),
    '--bg-hover': rgba(r.text, 0.07), '--bg-active': rgba(r.link, 0.14),
    '--shadow': 'rgba(0, 0, 0, 0.4)',
  });
  for (const [role, legacy] of Object.entries(ROLE_ALIASES)) v[role] = `var(${legacy})`;
  // Tailwind's --color-* names point at the bare variables, so one change reaches both.
  for (const k of ['bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-surface', 'bg-input', 'text-primary', 'text-secondary', 'text-muted',
    'amber', 'amber-bright', 'amber-dim', 'amber-glow', 'amber-subtle', 'lavender', 'lavender-bright', 'lavender-dim', 'lavender-glow', 'lavender-subtle',
    'gold', 'gold-bright', 'gold-dim', 'gold-glow', 'status-active', 'status-waking', 'border', 'border-hover', 'bg-hover', 'bg-active']) {
    v[`--color-${k}`] = `var(--${k})`;
  }
  return v;
}

/** The foreground/background pairs a material promises, with the threshold each must meet. */
export interface PairSpec { id: string; fg: string; bg: string; min: number }

export function materialPairs(r: Roles): PairSpec[] {
  const t = TEXT_MIN, c = CONTROL_MIN;
  return [
    { id: 'text on panel', fg: r.text, bg: r.panel, min: t },
    { id: 'secondary on panel', fg: r.secondary, bg: r.panel, min: t },
    { id: 'muted on panel', fg: r.muted, bg: r.panel, min: t },
    { id: 'text on panel-alt', fg: r.text, bg: r.panelAlt, min: t },
    { id: 'muted on panel-alt', fg: r.muted, bg: r.panelAlt, min: t },
    { id: 'text on panel-deep', fg: r.text, bg: r.panelDeep, min: t },
    { id: 'muted on panel-deep', fg: r.muted, bg: r.panelDeep, min: t },
    { id: 'text on panel-raised', fg: r.text, bg: r.panelRaised, min: t },
    { id: 'muted on panel-raised', fg: r.muted, bg: r.panelRaised, min: t },
    { id: 'user text on user card', fg: r.userText, bg: r.user, min: t },
    { id: 'companion text on companion card', fg: r.companionText, bg: r.companion, min: t },
    { id: 'link on companion card', fg: r.link, bg: r.companion, min: t },
    { id: 'link on user card', fg: r.userText, bg: r.user, min: t },
    { id: 'input text on input', fg: r.inputText, bg: r.input, min: t },
    { id: 'secondary on companion card', fg: r.secondary, bg: r.companion, min: t },
    { id: 'muted on companion card', fg: r.muted, bg: r.companion, min: t },
    { id: 'secondary on panel-alt', fg: r.secondary, bg: r.panelAlt, min: t },
    { id: 'secondary on user card', fg: r.scheme === 'light' ? r.userText : r.secondary, bg: r.user, min: t },
    { id: 'muted edited/Cancel on user card', fg: r.scheme === 'light' ? r.userText : r.muted, bg: r.user, min: t },
    { id: 'chrome text on button', fg: r.chromeOnButton, bg: r.button, min: t },
    { id: 'chrome text on pill', fg: r.chromeText, bg: r.chrome, min: t },
    { id: 'header badge text', fg: r.chrome, bg: r.chromeText, min: t },
    { id: 'tab badge text', fg: r.panel, bg: r.linkDim, min: t },
    { id: 'toggle thumb on on-track', fg: r.buttonText, bg: r.button, min: c },
    { id: 'toggle thumb on off-track', fg: r.muted, bg: r.panelDeep, min: c },
    { id: 'placeholder on input', fg: r.placeholder, bg: r.input, min: t },
    { id: 'chrome text on chrome', fg: r.chromeText, bg: r.chrome, min: t },
    { id: 'chrome muted on chrome', fg: r.chromeMuted, bg: r.chrome, min: t },
    { id: 'chrome text on chrome selected', fg: r.chromeText, bg: r.chromeSelected, min: t },
    { id: 'chrome muted on chrome selected', fg: r.chromeMuted, bg: r.chromeSelected, min: t },
    { id: 'popover text on popover', fg: r.popoverText, bg: r.popover, min: t },
    { id: 'code text on code', fg: r.codeText, bg: r.code, min: t },
    { id: 'code muted on code', fg: r.codeMuted, bg: r.code, min: t },
    { id: 'link on code', fg: r.link, bg: r.code, min: t },
    { id: 'link-bright on code', fg: r.linkBright, bg: r.code, min: t },
    { id: 'link on panel', fg: r.link, bg: r.panel, min: t },
    { id: 'link on input', fg: r.link, bg: r.input, min: t },
    { id: 'link-dim on panel', fg: r.linkDim, bg: r.panel, min: t },
    { id: 'link-bright on panel', fg: r.linkBright, bg: r.panel, min: t },
    { id: 'gold on panel', fg: r.gold, bg: r.panel, min: t },
    { id: 'button text on button', fg: r.buttonText, bg: r.button, min: t },
    { id: 'button text on button hover', fg: r.buttonText, bg: r.buttonHover, min: t },
    { id: 'control text on control', fg: r.text, bg: r.input, min: t },
    { id: 'control text on control hover', fg: r.text, bg: r.controlHover, min: t },
    { id: 'selected text on selected', fg: r.controlSelectedText, bg: r.controlSelected, min: t },
    { id: 'disabled text on disabled', fg: r.controlDisabledText, bg: r.controlDisabled, min: t },
    { id: 'text on thread active', fg: r.text, bg: r.threadActive, min: t },
    { id: 'error on panel', fg: r.error, bg: r.panel, min: t },
    { id: 'error on input', fg: r.error, bg: r.input, min: t },
    { id: 'danger action on user hover', fg: r.userDanger, bg: mix(r.user, '#DC8C78', 0.08), min: c },
    { id: 'success on panel', fg: r.success, bg: r.panel, min: t },
    { id: 'warning on panel', fg: r.warning, bg: r.panel, min: t },
    { id: 'error on chrome', fg: r.errorChrome, bg: r.chrome, min: t },
    { id: 'control border on panel', fg: r.controlBorder, bg: r.panel, min: c },
    { id: 'control border on input', fg: r.controlBorder, bg: r.input, min: c },
    { id: 'focus ring on panel', fg: r.focus, bg: r.panel, min: c },
    { id: 'focus ring on input', fg: r.focus, bg: r.input, min: c },
    { id: 'focus ring on chrome', fg: r.focusChrome, bg: r.chrome, min: c },
    { id: 'focus ring on user card', fg: r.focus, bg: r.user, min: c },
    { id: 'text on sidebar', fg: r.text, bg: r.sidebar, min: t },
    { id: 'secondary on sidebar', fg: r.secondary, bg: r.sidebar, min: t },
    { id: 'muted on sidebar', fg: r.muted, bg: r.sidebar, min: t },
    { id: 'link on sidebar', fg: r.link, bg: r.sidebar, min: t },
    { id: 'text on composer', fg: r.text, bg: r.composer, min: t },
    { id: 'composer muted on composer', fg: r.composerMuted, bg: r.composer, min: t },
    { id: 'control border on companion card', fg: r.controlBorder, bg: r.companion, min: c },
    { id: 'control border on user card', fg: r.controlBorder, bg: r.user, min: c },
    { id: 'control border on sidebar', fg: r.controlBorder, bg: r.sidebar, min: c },
    ...(r.editor ? [
      { id: 'editor text on editor', fg: r.editor.text, bg: r.editor.bg, min: t },
      { id: 'editor placeholder on editor', fg: r.editor.placeholder, bg: r.editor.bg, min: t },
      { id: 'editor focus ring on editor', fg: r.editor.focus, bg: r.editor.bg, min: c },
    ] : []),
  ];
}

/** The opaque colour a plate paints for a surface variable, so the texture's worst case can be computed. */
export function plateColor(r: Roles, surface: PlateSurface): string {
  switch (surface) {
    case '--surface-companion': return r.companion;
    case '--surface-user': return r.user;
    case '--surface-chrome': return r.chrome;
    case '--surface-popover': return r.popover;
    case '--sidebar-bg': return r.sidebar;
    case '--composer-bg': return r.composer;
    default: return r.panel; // --settings-panel-bg, --settings-panel-bg, --card-bg, --login-card-bg
  }
}

/** A single-ink SVG's strongest mark (legacy callers retain the original contract). */
export const textureWorst = (plate: string, layer: { ink: string; alpha: number }): string => mix(plate, layer.ink, layer.alpha);

/** The actual CSS composites, including both raster extremes and a failed-image solid fallback.
 * Per-channel min/max bounds also contain every bilinearly interpolated/scaled pixel. */
export function textureComposites(plate: string, layer: TextureLayer): string[] {
  const tint = (ink: string) => {
    if (layer.blend !== 'multiply') return ink;
    const p = parseColor(plate)!, c = parseColor(ink)!;
    return '#' + [p.r * c.r / 255, p.g * c.g / 255, p.b * c.b / 255].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  };
  return [plate, ...(layer.extremes ?? [layer.ink]).map(ink => mix(plate, tint(ink), layer.alpha))];
}

/** The legacy Hedgewitch paper remains independent of its room and separate from its botanicals. Grown from the Hedgewitch
 *  plates of its painting (packages/frontend/scripts/skin-art), its darkest fibres rolled off above every ink's bound, and laid
 *  at nearly full strength: the warm aged cream of the painting, and a dusty rose paper for "You". */
export const HEDGEWITCH_SUBSTRATE: TextureLayer = {
  url: '/hedgewitch/hedgewitch-paper.webp', ink: '#E2D0B5', alpha: 0.9, tilePx: 512,
  extremes: ['#E2D0B5', '#FFECD6'],
};
export const HEDGEWITCH_USER_PAPER: TextureLayer = {
  url: '/hedgewitch/hedgewitch-rose.webp', ink: '#BD9899', alpha: 0.9, tilePx: 512,
  extremes: ['#BD9899', '#EDC9CA'],
};
/** Hedgewitch's pop-ups, menus and dialogs, and the Home and chat strips that were still flat ivory: they take the chat's
 *  paper too, so no bare ivory is left in the kitchen (and each reads a shade less bright). Code and tool panels inside a
 *  message keep their deeper tan, set apart from the bubble around them. */
export const HEDGEWITCH_PAPER_OVERLAYS = [
  '.search-panel', '.cp-modal', '.cdlg-panel', '.plus-menu', '.slash-popup', '.jtd-panel', '.emoji-picker', '.tcm-root',
  '.tcm-submenu', '.ss-menu', '.hsel-list', '.cmd-manage-pop', '.night-shelf', '.reply-banner',
];
export const HEDGEWITCH_PAPER_PLATES = [
  { selector: '.message.companion', variable: '--surface-companion', base: '#faf4e4', inks: ['#2c231f', '#54483f', '#5d5047', '#57477a'], sprig: '/hedgewitch/sprig-sage.webp' },
  { selector: '.message.user', variable: '--surface-user', base: '#CFABAC', inks: ['#3b2f52'], sprig: '/hedgewitch/sprig-umbel.webp' },
  { selector: '.home-card', variable: '--bg-primary', base: '#f3ead7', inks: ['#2c231f', '#54483f', '#5d5047', '#57477a'], sprig: null },
  // the Notes page's cards: the Home cards' paper and inks (in the classic look the route keeps the paper's dark ink)
  { selector: '.nt-card', variable: '--bg-primary', base: '#f3ead7', inks: ['#2c231f', '#54483f', '#5d5047', '#57477a'], sprig: null },
  { selector: '.thread-sidebar', variable: '--bg-primary', base: '#f3ead7', inks: ['#2c231f', '#54483f', '#5d5047', '#57477a'], sprig: null },
  // Files' plates (places, recent cards, the folder, the open file), with the danger red of Delete.
  { selector: '.fl-plate', variable: '--bg-primary', base: '#f3ead7', inks: ['#2c231f', '#54483f', '#5d5047', '#57477a', '#8f3626'], sprig: null },
  { selector: '.composer-inner', variable: '--surface-input', base: '#faf4e5', inks: ['#2c231f', '#54483f', '#5d5047', '#57477a'], sprig: null },
  { selector: ':is(.composer-textarea, .mc-input, .thread-name-input)', variable: '--surface-input', base: '#faf4e5', inks: ['#2c231f', '#5d5047'], sprig: null },
  // The pop-ups' inks: the page's three, the darker lavender their links and accents take on paper, and Delete's red.
  { selector: `:is(${HEDGEWITCH_PAPER_OVERLAYS.join(', ')})`, variable: '--surface-popover', base: '#faf4e5', inks: ['#2c231f', '#54483f', '#5d5047', '#57477a', '#8f3626'], sprig: null },
] as const;
/** The paper a Hedgewitch plate wears: the rose for "You", the cream for everything else. */
export const hedgewitchPaperOf = (selector: string): TextureLayer => selector === '.message.user' ? HEDGEWITCH_USER_PAPER : HEDGEWITCH_SUBSTRATE;

export function hedgewitchTexturedPairs(): PairSpec[] {
  return HEDGEWITCH_PAPER_PLATES.flatMap(p => textureComposites(p.base, hedgewitchPaperOf(p.selector)).flatMap((bg, i) => [
    ...p.inks.map((fg, n) => ({ id: `${p.selector} ink ${n} paper bound ${i}`, fg, bg, min: TEXT_MIN })),
    ...(p.selector === '.message.user' ? [{ id: `.message.user edited metadata paper bound ${i}`, fg: '#3b2f52', bg, min: TEXT_MIN }] : []),
    { id: `${p.selector} focus paper bound ${i}`, fg: '#4a3b6e', bg, min: CONTROL_MIN },
    // The rose bubble's edge is the deeper lavender (the paler one is too light for the rose paper); the rest keep the control border.
    { id: `${p.selector} boundary paper bound ${i}`, fg: p.selector === '.message.user' ? '#57477a' : '#85734f', bg, min: CONTROL_MIN },
  ]));
}

/** The menu's ink, as in the demo's gilt menu: the chrome's own ink drawn toward the skin's metal (Celestial's and Crimson
 *  Velvet's gold, Ember's copper, the Library's brass, the Cloister's and the Greenhouse's silver). The house's name in the
 *  rail takes more of the metal. texturedPairs holds both on every menu plate and on the selected item. */
export const MENU_INK_METAL = 0.3;
export const MENU_MARK_METAL = 0.55;
export const menuInk = (r: Roles): string => mix(r.chromeText, r.trim, MENU_INK_METAL);
export const menuMark = (r: Roles): string => mix(r.chromeText, r.trim, MENU_MARK_METAL);

/**
 * Text that lands on a textured plate, judged on the worst composite (the strongest texture mark under the glyphs),
 * not on the flat colour. materials.test.ts holds every one to 4.5:1.
 */
export function texturedPairs(m: MaterialDef): PairSpec[] {
  const r = m.roles!, tex = m.texture!;
  // Real leather's visible lighter pore peaks need the existing brighter copper link ink.
  const link = m.id === 'smoked-copper' ? r.linkBright : r.link;
  const out: PairSpec[] = [];
  // `own`: the plate's own substrate (a user, composer or accent leather), which never carries the woven pattern.
  const on = (label: string, surface: PlateSurface, kind: 'card' | 'chrome', fgs: Array<[string, string]>, light = false, own?: TextureLayer) => {
    const k = light && m.scheme === 'light' ? 'chrome' : kind;
    const surf = light && m.scheme === 'light' ? '--surface-chrome' : surface;
    // Flat plate overrides (the Ember composer) own their actual surface, not the generic chrome default.
    const actual = m.flat?.surfaces[label === 'composer plate' ? '.composer-inner' : ''] ?? surf;
    const layer = own ?? tex[k];
    const bases = textureComposites(plateColor(r, actual as PlateSurface), layer);
    const composites = tex.pattern && !own ? bases.flatMap(bg => textureComposites(bg, tex.pattern!)) : bases;
    for (const [i, bg] of composites.entries()) {
      for (const [name, fg] of fgs) out.push({ id: `${name} on ${label} (worst texture${layer.extremes || tex.pattern ? ` bound ${i}` : ''})`, fg, bg, min: TEXT_MIN });
      for (const [name, fg] of [['control border', k === 'chrome' && r.scheme === 'light' ? r.chromeMuted : r.controlBorder], ['focus ring', k === 'chrome' ? r.focusChrome : r.focus]] as const) out.push({ id: `${name} on ${label} bound ${i}`, fg, bg, min: CONTROL_MIN });
    }
  };
  const chromeFgs: Array<[string, string]> = [['chrome text', r.chromeText], ['chrome muted', r.chromeMuted]];
  const menuFgs: Array<[string, string]> = [['menu ink', menuInk(r)], ['menu mark', menuMark(r)]];
  on('companion plate', '--surface-companion', 'card', [['companion text', r.companionText], ['secondary', r.secondary], ['muted', r.muted], ['link', link]], false, tex.companion);
  on('user plate', '--surface-user', 'card', [['user text', r.userText], ['link', r.userText], ['secondary Cancel hover', r.scheme === 'light' || m.id === 'smoked-copper' ? r.userText : r.secondary], ['muted edited/Cancel', r.scheme === 'light' || m.id === 'smoked-copper' ? r.userText : r.muted]], false, tex.user); // MessageBubble's user anchors use the user ink.
  // MessageBubble's live Delete icon keeps its 8% red hover wash over the user substrate.
  for (const [i, bg] of textureComposites(r.user, tex.user ?? tex.card).entries()) out.push({ id: `danger action on user hover bound ${i}`, fg: r.userDanger, bg: mix(bg, '#DC8C78', 0.08), min: CONTROL_MIN });
  const panelFgs: Array<[string, string]> = [['text', r.text], ['secondary', r.secondary], ['muted', r.muted], ['link', link], ['error', r.error], ['success', r.success], ['warning', r.warning]];
  on('panel plate', '--settings-panel-bg', 'card', panelFgs);
  // Accent plates keep their own ink on the "You" colour and substrate: the panel's (Home cards), or the chrome's (a menu).
  const accentLayer = m.accentSubstrate === 'companion' ? tex.companion : tex.user;
  if (m.accents.length && accentLayer) {
    const menu = m.accents.some(a => NAV_SURFACES.includes(a));
    on('accent plate', m.accentSubstrate === 'companion' ? '--surface-companion' : '--surface-user', 'card', menu ? [...chromeFgs, ...menuFgs, ['error chrome', r.errorChrome]] : panelFgs, false, accentLayer);
    if (menu) for (const [name, fg] of [...chromeFgs, ...menuFgs]) out.push({ id: `${name} on the selected menu item`, fg, bg: r.accentSelected, min: TEXT_MIN });
  }
  // The menu ink on the selected row of a menu drawn on the chrome (the accent menus are held just above).
  if (!m.accents.some(a => NAV_SURFACES.includes(a))) out.push({ id: 'menu ink on the selected menu item', fg: menuInk(r), bg: r.chromeSelected, min: TEXT_MIN });
  on('popover plate', '--surface-popover', 'card', [['popover text', r.popoverText], ['muted', r.muted], ['link', link]]);
  on('chrome plate', '--surface-chrome', 'chrome', [...chromeFgs, ...menuFgs, ['error chrome', r.errorChrome]]);
  on('sidebar plate', '--sidebar-bg', 'card', sidebarInk(r, link), true);
  // A composer with its own leather is the field itself: the typed text, the chrome ink and the lifted quiet ink all sit on it.
  if (tex.composer) on('composer plate', '--surface-chrome', 'chrome', [['chrome text', r.chromeText], ['field text', r.inputText], ['composer muted', r.composerMuted]], true, tex.composer);
  else on('composer plate', '--surface-chrome', 'chrome', chromeFgs, true);
  if (r.editor && tex.editor) {
    const bg = textureWorst(r.editor.bg, { ink: tex.editor.ink, alpha: 1 });
    out.push({ id: 'editor text on the editor (worst parchment tile pixel)', fg: r.editor.text, bg, min: TEXT_MIN });
  }
  // Reserved motifs never underlie glyphs or controls. Keep the full overlay bound for
  // any legacy/unreserved ornament; reserved geometry is integration-tested separately.
  if (tex.ornament && !tex.ornament.clearance) {
    const o = tex.ornament;
    const over = (label: string, base: string, layer: TextureLayer, fgs: Array<[string, string]>) => {
      for (const [i, substrate] of textureComposites(base, layer).entries()) {
        const bg = mix(substrate, o.ink, o.alpha); // full opacity: no antialiasing discount
        for (const [name, fg] of fgs) out.push({ id: `${name} on ${label} under ornament bound ${i}`, fg, bg, min: TEXT_MIN });
        for (const [name, fg] of [['control border', r.controlBorder], ['focus ring', r.focus]] as const) out.push({ id: `${name} on ${label} under ornament bound ${i}`, fg, bg, min: CONTROL_MIN });
      }
    };
    over('companion plate', r.companion, tex.card, [['companion text', r.companionText], ['muted', r.muted], ['link', link]]);
    over('panel plate', r.panel, tex.card, [['text', r.text], ['muted', r.muted], ['link', link]]);
    over('user plate', r.user, tex.user ?? tex.card, [['user text', r.userText], ['link', link]]);
    over('sidebar plate', r.sidebar, tex.card, sidebarInk(r, link));
  }
  return out;
}

/** What a thread sidebar's text is, on a dark material (panel ink on the panel) or a light one (chrome ink on chrome). */
function sidebarInk(r: Roles, link = r.link): Array<[string, string]> {
  return r.scheme === 'light'
    ? [['chrome text', r.chromeText], ['chrome muted', r.chromeMuted]]
    : [['text', r.text], ['secondary', r.secondary], ['muted', r.muted], ['link', link]];
}

/**
 * The skin custom properties a material adds: the trim metal, the textures with the percentage of plate colour
 * kept over them (the veil), the ornament, and the composer field's own pair. Percentages are literal numbers so
 * the stylesheet and the test cannot disagree.
 */
export function skinVars(m: MaterialDef): Record<string, string> {
  const r = m.roles!, t = m.texture!;
  const q = (u: string) => `url("${u}")`;
  const keep = (a: number) => `${Math.round((1 - a) * 1000) / 10}%`;
  const v: Record<string, string> = {
    '--skin-trim': r.trim,
    '--skin-tex-card': q(t.card.url), '--skin-veil-card': keep(t.card.alpha), '--skin-tex-card-size': `${t.card.tilePx}px ${t.card.tilePx}px`,
    '--skin-tex-chrome': q(t.chrome.url), '--skin-veil-chrome': keep(t.chrome.alpha), '--skin-tex-chrome-size': `${t.chrome.tilePx}px ${t.chrome.tilePx}px`,
    '--skin-field-bg': r.input, '--skin-field-text': r.inputText, '--skin-field-placeholder': r.placeholder,
    '--skin-trim-quiet': r.divider, '--skin-frame': r.frame,
  };
  if (!m.flat) for (const [name, layer] of [['card', t.card], ['chrome', t.chrome], ['user', t.user ?? t.card], ['companion', t.companion ?? t.card]] as const) {
    v[`--skin-tex-${name}`] = q(layer.url);
    v[`--skin-veil-${name}`] = keep(layer.alpha);
    v[`--skin-tex-${name}-size`] = `${layer.tilePx}px ${layer.tilePx}px`;
    v[`--skin-tex-${name}-blend`] = layer.blend ?? 'normal';
  }
  // A flat material with its own "You" and composer substrates (Ember's): the user, accent and composer plate rules read these.
  if (m.flat) for (const [name, layer] of [['user', t.user], ['composer', t.composer]] as const) {
    if (!layer) continue;
    v[`--skin-tex-${name}`] = q(layer.url); v[`--skin-veil-${name}`] = keep(layer.alpha);
    v[`--skin-tex-${name}-size`] = `${layer.tilePx}px ${layer.tilePx}px`;
  }
  if (t.pattern) {
    v['--skin-pattern'] = q(t.pattern.url);
    v['--skin-pattern-size'] = `${t.pattern.tilePx}px ${t.pattern.tilePx}px`;
  }
  if (t.relief) {
    for (const [corner, url] of Object.entries(t.relief.corners)) v[`--skin-fitting-${corner}`] = q(url);
    v['--skin-plate-relief'] = t.relief.plateShadow;
    if (t.relief.chromeShadow) { v['--skin-chrome-relief'] = t.relief.chromeShadow; v['--skin-chrome-trim'] = r.chromeTrim; }
    v['--skin-frame-relief'] = t.relief.frameShadow;
  }
  if (BADGE_INK[m.id]) v['--skin-badge-ink'] = BADGE_INK[m.id]!;
  if (ICON_INK[m.id]) v['--skin-icon-ink'] = ICON_INK[m.id]!;
  if (r.editor) {
    v['--skin-editor-bg'] = r.editor.bg; v['--skin-editor-text'] = r.editor.text;
    v['--skin-editor-placeholder'] = r.editor.placeholder; v['--skin-editor-focus'] = r.editor.focus;
    v['--skin-editor-tex'] = t.editor ? q(t.editor.url) : 'none';
    v['--skin-editor-tex-size'] = t.editor ? `${t.editor.tilePx}px ${t.editor.tilePx}px` : 'auto';
  }
  if (t.rail) v['--skin-rail-orn'] = q(t.rail);
  if (t.ornament) {
    v['--skin-orn'] = q(t.ornament.url);
    v['--skin-orn-size'] = `${t.ornament.sizePx}px`;
    v['--skin-orn-mobile-size'] = `${t.ornament.mobileSizePx ?? t.ornament.sizePx}px`;
    v['--skin-orn-position'] = t.ornament.position ?? '0 100%';
    // painted variants, by index: the left (own-side) and right files, and the upright one a phone's Home card keeps
    const ov = t.ornament.variants;
    if (ov) ornamentVariants(ov).forEach(({ painting, top }, k) => {
      v[`--skin-orn-${k}-left`] = q(ornamentVariantUrl(ov, painting, top ? 'tl' : 'bl'));
      v[`--skin-orn-${k}-right`] = q(ornamentVariantUrl(ov, painting, top ? 'tr' : 'br'));
      v[`--skin-orn-${k}-upright-left`] = q(ornamentVariantUrl(ov, painting, 'bl'));
      v[`--skin-orn-${k}-upright-right`] = q(ornamentVariantUrl(ov, painting, 'br'));
    });
  }
  return v;
}

/** Every texture and ornament file the materials point at, for the integrity test and the service-worker allowlist. */
export function materialAssetPaths(): string[] {
  const out = new Set<string>();
  for (const m of MATERIAL_LIST) {
    if (!m.texture) continue;
    out.add(m.texture.card.url); out.add(m.texture.chrome.url);
    if (m.texture.user) out.add(m.texture.user.url);
    if (m.texture.companion) out.add(m.texture.companion.url);
    if (m.texture.composer) out.add(m.texture.composer.url);
    if (m.texture.pattern) out.add(m.texture.pattern.url);
    if (m.texture.relief) Object.values(m.texture.relief.corners).forEach(url => out.add(url));
    if (m.texture.ornament) out.add(m.texture.ornament.url);
    const v = m.texture.ornament?.variants;
    if (v) for (const painting of v.paintings) for (const corner of ['bl', 'tl', 'br', 'tr'] as const) out.add(ornamentVariantUrl(v, painting, corner));
    if (m.texture.editor) out.add(m.texture.editor.url);
    if (m.texture.rail) out.add(m.texture.rail);
  }
  return [...out];
}
