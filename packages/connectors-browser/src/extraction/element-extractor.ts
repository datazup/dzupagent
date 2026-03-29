import type { Page } from 'playwright'
import type { ElementInfo } from '../types.js'

export async function extractInteractiveElements(page: Page): Promise<ElementInfo[]> {
  return page.evaluate(() => {
    const selectors = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], select, [role="combobox"]'
    const elements = Array.from(document.querySelectorAll(selectors))

    return elements.map(el => {
      const htmlEl = el as HTMLElement
      const rect = htmlEl.getBoundingClientRect()

      // Determine location based on position
      let location = 'main'
      const parent = htmlEl.closest('header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]')
      if (parent) {
        const tag = parent.tagName.toLowerCase()
        const role = parent.getAttribute('role')
        if (tag === 'header' || role === 'banner') location = 'header'
        else if (tag === 'nav' || role === 'navigation') location = 'nav'
        else if (tag === 'footer' || role === 'contentinfo') location = 'footer'
        else if (tag === 'aside' || role === 'complementary') location = 'sidebar'
      }

      // Get ARIA attributes
      const ariaAttributes: Record<string, string> = {}
      for (const attr of htmlEl.attributes) {
        if (attr.name.startsWith('aria-')) {
          ariaAttributes[attr.name] = attr.value
        }
      }

      return {
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        label: htmlEl.textContent?.trim().slice(0, 200) || el.getAttribute('aria-label') || '',
        enabled: !(htmlEl as HTMLButtonElement).disabled,
        visible: rect.width > 0 && rect.height > 0,
        location,
        ariaAttributes,
      }
    })
  })
}
