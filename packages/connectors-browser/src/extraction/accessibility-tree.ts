import type { Page } from 'playwright'
import type { AccessibilityNode } from '../types.js'

/**
 * Extract accessibility information from the page using DOM APIs.
 * This approach works across all Playwright versions by querying
 * ARIA roles, labels, and states directly from the DOM.
 */
export async function extractAccessibilityTree(page: Page): Promise<AccessibilityNode[]> {
  return page.evaluate(() => {
    const results: Array<{
      role: string
      name: string
      value?: string
      description?: string
      depth: number
      disabled?: boolean
      checked?: boolean
      expanded?: boolean
      selected?: boolean
      required?: boolean
    }> = []

    // Roles we care about for test generation
    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
      'listbox', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'option', 'progressbar', 'scrollbar', 'searchbox',
      'slider', 'spinbutton', 'switch', 'tab', 'tablist', 'tabpanel',
      'tree', 'treeitem', 'dialog', 'alert', 'alertdialog', 'navigation',
      'main', 'banner', 'contentinfo', 'complementary', 'form', 'region',
      'heading', 'img', 'table', 'row', 'cell', 'columnheader', 'rowheader',
    ])

    // Map HTML elements to implicit ARIA roles
    const implicitRoles: Record<string, string> = {
      A: 'link',
      BUTTON: 'button',
      INPUT: 'textbox',
      SELECT: 'combobox',
      TEXTAREA: 'textbox',
      IMG: 'img',
      H1: 'heading',
      H2: 'heading',
      H3: 'heading',
      H4: 'heading',
      H5: 'heading',
      H6: 'heading',
      NAV: 'navigation',
      MAIN: 'main',
      HEADER: 'banner',
      FOOTER: 'contentinfo',
      ASIDE: 'complementary',
      FORM: 'form',
      TABLE: 'table',
      TR: 'row',
      TD: 'cell',
      TH: 'columnheader',
      DIALOG: 'dialog',
    }

    // Special input type role mappings
    const inputTypeRoles: Record<string, string> = {
      checkbox: 'checkbox',
      radio: 'radio',
      range: 'slider',
      number: 'spinbutton',
      search: 'searchbox',
      submit: 'button',
      reset: 'button',
      button: 'button',
    }

    function getRole(el: Element): string | null {
      const explicit = el.getAttribute('role')
      if (explicit) return explicit

      const tag = el.tagName
      if (tag === 'INPUT') {
        const type = (el as HTMLInputElement).type || 'text'
        return inputTypeRoles[type] ?? 'textbox'
      }

      return implicitRoles[tag] ?? null
    }

    function getAccessibleName(el: Element): string {
      // aria-label takes precedence
      const ariaLabel = el.getAttribute('aria-label')
      if (ariaLabel) return ariaLabel

      // aria-labelledby
      const labelledBy = el.getAttribute('aria-labelledby')
      if (labelledBy) {
        const parts = labelledBy.split(/\s+/).map(id => {
          const ref = document.getElementById(id)
          return ref?.textContent?.trim() ?? ''
        }).filter(Boolean)
        if (parts.length > 0) return parts.join(' ')
      }

      // For inputs, check associated label
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        if (el.id) {
          const label = document.querySelector(`label[for="${el.id}"]`)
          if (label?.textContent) return label.textContent.trim()
        }
        const placeholder = (el as HTMLInputElement).placeholder
        if (placeholder) return placeholder
      }

      // For images, use alt text
      if (el instanceof HTMLImageElement) {
        return el.alt || ''
      }

      // Use text content for other elements (truncated)
      const text = el.textContent?.trim() ?? ''
      return text.slice(0, 200)
    }

    function walk(el: Element, depth: number): void {
      const role = getRole(el)

      if (role && interactiveRoles.has(role)) {
        const name = getAccessibleName(el)
        if (name) {
          const htmlEl = el as HTMLElement
          const node: typeof results[number] = {
            role,
            name,
            depth,
          }

          // Value
          if ('value' in el && typeof (el as HTMLInputElement).value === 'string') {
            const val = (el as HTMLInputElement).value
            if (val) node.value = val
          }

          // Description
          const describedBy = el.getAttribute('aria-describedby')
          if (describedBy) {
            const desc = describedBy.split(/\s+/).map(id => {
              const ref = document.getElementById(id)
              return ref?.textContent?.trim() ?? ''
            }).filter(Boolean).join(' ')
            if (desc) node.description = desc
          }

          // States
          if (htmlEl.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
            node.disabled = true
          }
          const checked = el.getAttribute('aria-checked')
          if (checked === 'true') node.checked = true
          else if (checked === 'false') node.checked = false
          else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
            node.checked = el.checked
          }
          const expanded = el.getAttribute('aria-expanded')
          if (expanded === 'true') node.expanded = true
          else if (expanded === 'false') node.expanded = false
          const selected = el.getAttribute('aria-selected')
          if (selected === 'true') node.selected = true
          else if (selected === 'false') node.selected = false
          if (el.getAttribute('aria-required') === 'true' || (el as HTMLInputElement).required) {
            node.required = true
          }

          results.push(node)
        }
      }

      for (const child of el.children) {
        walk(child, depth + 1)
      }
    }

    walk(document.documentElement, 0)
    return results
  })
}
