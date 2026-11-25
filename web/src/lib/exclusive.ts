/**
 * One floating layer at a time. Tooltips, popovers, glossary terms, diagram tooltips and menus claim the screen
 * when they open, which closes whatever else is open, so layers never pile up on each other. Rules:
 * - a layer opened from inside another one (a tooltip inside a popover or menu) keeps its parent open;
 * - while a layer the user opened on purpose is up (a menu, a click-pinned popover), merely hovering something
 *   else doesn't open a second layer on top of it (`hoverBlocked`); a click, tap or keyboard focus does, and
 *   replaces it.
 */
export interface Layer {
  close: () => void
  /** Opened on purpose (menu, pinned popover). */
  sticky?: () => boolean
  /** The layer's floating element; layers whose trigger sits inside it are nested, not competing. */
  floating?: () => Element | null
}

let open: Layer[] = []

const competing = (reference: Element | null | undefined) => (layer: Layer) => {
  const element = layer.floating?.()
  return !(reference && element?.contains(reference))
}

/** `layer` just opened from `reference`: close every other open layer except its parents. */
export function claimOpen(layer: Layer, reference?: Element | null): void {
  if (open.includes(layer)) return
  const closing = open.filter(competing(reference))
  open = [...open.filter((other) => !closing.includes(other)), layer]
  for (const other of closing) other.close()
}

/** The layer closed (or unmounted). */
export function releaseOpen(layer: Layer): void {
  open = open.filter((other) => other !== layer)
}

/** Should a hover on `reference` stay quiet because a menu or pinned popover is open elsewhere? */
export function hoverBlocked(reference?: Element | null): boolean {
  return open.filter(competing(reference)).some((layer) => layer.sticky?.())
}

/** Currently open layers, oldest first (tests). */
export function openLayers(): readonly Layer[] {
  return open
}
