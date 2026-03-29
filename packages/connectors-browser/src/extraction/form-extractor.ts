import type { Page } from 'playwright'
import type { FormInfo } from '../types.js'

export async function extractForms(page: Page): Promise<FormInfo[]> {
  return page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form'))
    return forms.map(form => {
      const inputs = Array.from(form.querySelectorAll('input, select, textarea'))
      const fields = inputs.map(input => {
        const el = input as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
        const type = el.tagName === 'SELECT' ? 'select'
          : el.tagName === 'TEXTAREA' ? 'textarea'
          : (el as HTMLInputElement).type || 'text'

        // Find label
        const id = el.id
        const labelEl = id ? document.querySelector(`label[for="${id}"]`) : null
        const label = labelEl?.textContent?.trim() ?? el.getAttribute('aria-label') ?? null

        // Get options for select elements
        const options = el.tagName === 'SELECT'
          ? Array.from((el as HTMLSelectElement).options).map(o => o.text)
          : undefined

        return {
          name: el.name || el.id || '',
          type,
          label,
          placeholder: (el as HTMLInputElement).placeholder || null,
          required: el.required,
          ...(options ? { options } : {}),
        }
      })

      return {
        action: form.action || '',
        method: (form.method || 'get').toUpperCase(),
        fields,
      }
    })
  })
}
