import { useCallback, useLayoutEffect, useState } from 'react'

/**
 * Content-box width of an element, tracked with a ResizeObserver and rounded to `step` px (so a resize
 * doesn't re-layout a diagram on every pixel). Null until the element is measured, which happens before
 * paint. Returns a callback ref, so an element that mounts later (after data arrives) is measured too.
 */
export function useElementWidth<T extends HTMLElement>(step = 4): [(element: T | null) => void, number | null] {
  const [element, setElement] = useState<T | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const ref = useCallback((node: T | null) => setElement(node), [])
  useLayoutEffect(() => {
    if (!element) return
    const update = () => {
      const styles = getComputedStyle(element)
      const inner = element.getBoundingClientRect().width - parseFloat(styles.paddingLeft || '0') - parseFloat(styles.paddingRight || '0')
      setWidth(Math.max(0, Math.floor(inner / step) * step))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, step])
  return [ref, width]
}

/**
 * Scale at which a diagram of natural width `natural` fits `available` px without its 12 px text dropping
 * below 11 px (never scaled up). Null when it doesn't fit even at the minimum scale.
 */
export function fitScale(natural: number, available: number | null | undefined, minScale = 0.92): number | null {
  if (!available || natural <= 0) return 1
  const scale = Math.min(1, available / natural)
  return scale >= minScale ? scale : null
}
