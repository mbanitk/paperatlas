import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimOpen, hoverBlocked, openLayers, releaseOpen, type Layer } from './exclusive'

const layer = (extra: Partial<Layer> = {}) => ({ ...extra, close: vi.fn<() => void>() })
const element = (inside: Element[] = []) => ({ contains: (node: Element) => inside.includes(node) }) as unknown as Element

afterEach(() => {
  for (const other of [...openLayers()]) releaseOpen(other)
})

describe('one floating layer at a time', () => {
  it('opening a second layer closes the first', () => {
    const a = layer()
    const b = layer()
    claimOpen(a)
    claimOpen(b)
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(b.close).not.toHaveBeenCalled()
    expect(openLayers()).toEqual([b])
  })

  it('re-claiming an open layer does not close it', () => {
    const a = layer()
    claimOpen(a)
    claimOpen(a)
    expect(a.close).not.toHaveBeenCalled()
  })

  it('a click, tap or focus elsewhere replaces a pinned popover or menu', () => {
    const pinned = layer({ sticky: () => true })
    claimOpen(pinned)
    claimOpen(layer())
    expect(pinned.close).toHaveBeenCalled()
  })

  it('hovering elsewhere stays quiet only while a pinned popover or menu is open', () => {
    let pinned = false
    const popover = layer({ sticky: () => pinned })
    claimOpen(popover)
    expect(hoverBlocked({} as Element)).toBe(false)
    pinned = true
    expect(hoverBlocked({} as Element)).toBe(true)
    releaseOpen(popover)
    expect(hoverBlocked({} as Element)).toBe(false)
  })

  it('a layer opened from inside another keeps its parent open, and may open on hover', () => {
    const trigger = {} as Element
    const parent = layer({ sticky: () => true, floating: () => element([trigger]) })
    claimOpen(parent)
    expect(hoverBlocked(trigger)).toBe(false)
    const child = layer()
    claimOpen(child, trigger)
    expect(parent.close).not.toHaveBeenCalled()
    claimOpen(layer(), {} as Element)
    expect(parent.close).toHaveBeenCalled()
    expect(child.close).toHaveBeenCalled()
  })
})
