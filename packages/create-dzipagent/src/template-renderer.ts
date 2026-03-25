/**
 * Renders a template string by replacing `{{variable}}` placeholders
 * with values from the provided variables map.
 *
 * Unknown variables are left as-is (no error thrown).
 */
export function renderTemplate(
  content: string,
  variables: Record<string, string>,
): string {
  return content.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = variables[key]
    return value !== undefined ? value : `{{${key}}}`
  })
}
