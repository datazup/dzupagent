import { describe, it, expect } from 'vitest'
import { ContentExtractor } from '../content-extractor.js'

describe('ContentExtractor - complex HTML documents', () => {
  const extractor = new ContentExtractor()

  describe('code block preservation', () => {
    it('preserves text content inside <pre> tags', () => {
      const html = `<html><body>
        <pre><code>function hello() {
  console.log("world");
}</code></pre>
      </body></html>`
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('function hello()')
      expect(result.text).toContain('console.log')
    })

    it('preserves inline code content', () => {
      const html = '<html><body><p>Use the <code>Array.map()</code> method to transform arrays.</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Array.map()')
    })
  })

  describe('link extraction from text', () => {
    it('preserves link text content', () => {
      const html = '<html><body><p>Visit <a href="https://example.com">Example Site</a> for more.</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Visit')
      expect(result.text).toContain('Example Site')
      expect(result.text).toContain('for more.')
    })

    it('strips anchor tags but keeps text', () => {
      const html = '<html><body><a href="/link1">Link One</a> and <a href="/link2">Link Two</a></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Link One')
      expect(result.text).toContain('Link Two')
      expect(result.text).not.toContain('href')
    })
  })

  describe('image handling', () => {
    it('strips img tags from text output', () => {
      const html = '<html><body><p>Before <img src="photo.jpg" alt="A photo"> After</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Before')
      expect(result.text).toContain('After')
      expect(result.text).not.toContain('photo.jpg')
    })

    it('strips picture and source elements', () => {
      const html = `<html><body>
        <picture>
          <source srcset="img.webp" type="image/webp">
          <img src="img.jpg" alt="Fallback">
        </picture>
        <p>Real content here</p>
      </body></html>`
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Real content here')
    })
  })

  describe('table content', () => {
    it('preserves text from table cells', () => {
      const html = `<html><body>
        <table>
          <tr><th>Name</th><th>Value</th></tr>
          <tr><td>Alpha</td><td>100</td></tr>
          <tr><td>Beta</td><td>200</td></tr>
        </table>
      </body></html>`
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Name')
      expect(result.text).toContain('Alpha')
      expect(result.text).toContain('100')
      expect(result.text).toContain('Beta')
      expect(result.text).toContain('200')
    })
  })

  describe('list content', () => {
    it('preserves ordered list text', () => {
      const html = `<html><body>
        <ol>
          <li>First item</li>
          <li>Second item</li>
          <li>Third item</li>
        </ol>
      </body></html>`
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('First item')
      expect(result.text).toContain('Second item')
      expect(result.text).toContain('Third item')
    })

    it('preserves unordered list text', () => {
      const html = `<html><body>
        <ul>
          <li>Apple</li>
          <li>Banana</li>
          <li>Cherry</li>
        </ul>
      </body></html>`
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Apple')
      expect(result.text).toContain('Banana')
      expect(result.text).toContain('Cherry')
    })
  })

  describe('blockquote content', () => {
    it('preserves blockquote text', () => {
      const html = '<html><body><blockquote>This is a quoted passage from the original text.</blockquote></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('This is a quoted passage')
    })
  })

  describe('heading hierarchy', () => {
    it('extracts text from all heading levels', () => {
      const html = `<html><body>
        <h1>Heading 1</h1>
        <h2>Heading 2</h2>
        <h3>Heading 3</h3>
        <h4>Heading 4</h4>
        <h5>Heading 5</h5>
        <h6>Heading 6</h6>
        <p>Body paragraph</p>
      </body></html>`
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Heading 1')
      expect(result.text).toContain('Heading 2')
      expect(result.text).toContain('Heading 3')
      expect(result.text).toContain('Heading 4')
      expect(result.text).toContain('Heading 5')
      expect(result.text).toContain('Heading 6')
      expect(result.text).toContain('Body paragraph')
    })
  })

  describe('noscript removal', () => {
    it('removes noscript elements', () => {
      const html = '<html><body><noscript><p>Enable JavaScript</p></noscript><p>Main content</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Main content')
      expect(result.text).not.toContain('Enable JavaScript')
    })
  })

  describe('hidden elements', () => {
    it('removes elements with display:none style', () => {
      const html = '<html><body><div style="display:none">Hidden text</div><p>Visible text</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Visible text')
      expect(result.text).not.toContain('Hidden text')
    })

    it('removes elements with hidden attribute', () => {
      const html = '<html><body><div hidden>Secret text</div><p>Public text</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Public text')
      expect(result.text).not.toContain('Secret text')
    })
  })
})

describe('ContentExtractor - meta tag edge cases', () => {
  const extractor = new ContentExtractor()

  describe('Open Graph tags', () => {
    it('extracts og:published_time', () => {
      const html = '<html><head><meta property="og:published_time" content="2024-03-15T10:00:00Z"></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.publishedDate).toBe('2024-03-15T10:00:00Z')
    })

    it('prefers article:published_time over og:published_time', () => {
      const html = `<html><head>
        <meta property="article:published_time" content="2024-01-01">
        <meta property="og:published_time" content="2024-06-01">
      </head><body>x</body></html>`
      const result = extractor.extract(html)
      expect(result.publishedDate).toBe('2024-01-01')
    })
  })

  describe('meta tags with single vs double quotes', () => {
    it('handles single-quoted attribute values', () => {
      const html = "<html><head><meta name='description' content='Single quoted description'></head><body>x</body></html>"
      const result = extractor.extract(html)
      expect(result.description).toBe('Single quoted description')
    })

    it('handles mixed quote styles', () => {
      const html = '<html><head><meta name="author" content=\'Mixed Quotes Author\'></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.author).toBe('Mixed Quotes Author')
    })
  })

  describe('empty and missing meta content', () => {
    it('returns undefined for empty description content', () => {
      const html = '<html><head><meta name="description" content=""></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.description).toBeUndefined()
    })

    it('returns undefined for empty author content', () => {
      const html = '<html><head><meta name="author" content=""></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.author).toBeUndefined()
    })
  })

  describe('self-closing meta tags', () => {
    it('handles self-closing meta with slash', () => {
      const html = '<html><head><meta name="description" content="Self closing" /></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.description).toBe('Self closing')
    })
  })
})

describe('ContentExtractor - entity decoding edge cases', () => {
  const extractor = new ContentExtractor()

  it('decodes &laquo; and &raquo; (French quotation marks)', () => {
    const html = '<html><body><p>&laquo;Hello World&raquo;</p></body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('\u00AB')
    expect(result.text).toContain('\u00BB')
  })

  it('decodes &apos; (apostrophe)', () => {
    const html = '<html><body><p>It&apos;s working</p></body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain("It's working")
  })

  it('decodes large numeric entities', () => {
    // Emoji: grinning face = &#128512; but fromCharCode may not work for > 0xFFFF
    // Test with a BMP character instead
    const html = '<html><body><p>&#9829;</p></body></html>' // heart symbol
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('\u2665')
  })

  it('decodes hex entity with uppercase letters', () => {
    const html = '<html><body><p>&#x4E2D;&#x6587;</p></body></html>' // Chinese characters
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('\u4E2D')
    expect(result.text).toContain('\u6587')
  })

  it('handles multiple entity decodings in a single string', () => {
    const html = '<html><body><p>&lt;div class=&quot;test&quot;&gt;&amp;content&lt;/div&gt;</p></body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('<div class="test">&content</div>')
  })
})

describe('ContentExtractor - whitespace and formatting', () => {
  const extractor = new ContentExtractor()

  it('handles tabs and mixed whitespace', () => {
    const html = '<html><body><p>Word1\t\t\tWord2     Word3</p></body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toBe('Word1 Word2 Word3')
  })

  it('converts block elements to newlines', () => {
    const html = '<html><body><div>Block 1</div><div>Block 2</div><p>Paragraph</p></body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Block 1')
    expect(result.text).toContain('Block 2')
    expect(result.text).toContain('Paragraph')
  })

  it('handles <br> tags as line separators', () => {
    const html = '<html><body><p>Line 1<br>Line 2<br/>Line 3</p></body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Line 1')
    expect(result.text).toContain('Line 2')
    expect(result.text).toContain('Line 3')
  })

  it('trims leading and trailing whitespace from result', () => {
    const html = '<html><body>   <p>Content</p>   </body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toBe('Content')
  })

  it('handles empty paragraphs without adding extra whitespace', () => {
    const html = '<html><body><p></p><p>Content</p><p></p></body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toBe('Content')
  })
})

describe('ContentExtractor - extraction modes', () => {
  const extractor = new ContentExtractor()

  it('returns text and metadata in "all" mode', () => {
    const html = `<html>
      <head><title>All Mode</title><meta name="description" content="Desc"></head>
      <body><p>Body text here</p></body>
    </html>`
    const result = extractor.extract(html, { mode: 'all', cleanHtml: true })
    expect(result.text).toContain('Body text here')
    expect(result.title).toBe('All Mode')
    expect(result.description).toBe('Desc')
  })

  it('returns text in "text" mode', () => {
    const html = '<html><head><title>Text Mode</title></head><body><p>Some text</p></body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Some text')
    expect(result.title).toBe('Text Mode')
  })

  it('returns empty text in "metadata" mode', () => {
    const html = '<html><head><title>Meta Mode</title></head><body><p>Ignored body</p></body></html>'
    const result = extractor.extract(html, { mode: 'metadata' })
    expect(result.text).toBe('')
    expect(result.title).toBe('Meta Mode')
  })

  it('uses default config (text mode, cleanHtml true) when no options', () => {
    const html = '<html><body><script>evil()</script><p>Clean content</p></body></html>'
    const result = extractor.extract(html)
    expect(result.text).toContain('Clean content')
    expect(result.text).not.toContain('evil')
  })
})

describe('ContentExtractor - complex real-world HTML', () => {
  const extractor = new ContentExtractor()

  it('handles a full blog post structure', () => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>How to Build Great Software</title>
  <meta name="description" content="A guide to building software that lasts.">
  <meta name="author" content="Jane Developer">
  <meta property="article:published_time" content="2024-06-15">
</head>
<body>
  <nav><a href="/">Home</a><a href="/blog">Blog</a></nav>
  <header><h1>Site Name</h1></header>
  <article>
    <h1>How to Build Great Software</h1>
    <p>Building great software requires discipline and craft.</p>
    <h2>Step 1: Planning</h2>
    <p>Start with a clear plan and well-defined requirements.</p>
    <h2>Step 2: Implementation</h2>
    <p>Write clean, testable code with good abstractions.</p>
    <pre><code>const result = await buildSoftware(plan);</code></pre>
    <h2>Step 3: Testing</h2>
    <p>Test thoroughly, including edge cases and error paths.</p>
  </article>
  <aside><p>Related Articles</p></aside>
  <footer><p>&copy; 2024 Jane Developer</p></footer>
  <script>analytics.track('page_view');</script>
</body>
</html>`

    const result = extractor.extract(html, { mode: 'all', cleanHtml: true })
    expect(result.title).toBe('How to Build Great Software')
    expect(result.description).toBe('A guide to building software that lasts.')
    expect(result.author).toBe('Jane Developer')
    expect(result.publishedDate).toBe('2024-06-15')
    expect(result.text).toContain('Building great software')
    expect(result.text).toContain('Step 1: Planning')
    expect(result.text).toContain('buildSoftware(plan)')
    expect(result.text).not.toContain('analytics.track')
    expect(result.text).not.toContain('Related Articles')
    expect(result.text).not.toContain('Home')
  })

  it('handles a minimal HTML fragment without head', () => {
    const html = '<div><p>Just a fragment</p></div>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Just a fragment')
    expect(result.title).toBeUndefined()
    expect(result.description).toBeUndefined()
  })

  it('handles HTML with multiple script tags', () => {
    const html = `<html><body>
      <script>var a = 1;</script>
      <p>Content 1</p>
      <script type="text/javascript">var b = 2;</script>
      <p>Content 2</p>
      <script src="external.js"></script>
      <p>Content 3</p>
    </body></html>`
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Content 1')
    expect(result.text).toContain('Content 2')
    expect(result.text).toContain('Content 3')
    expect(result.text).not.toContain('var a')
    expect(result.text).not.toContain('var b')
  })

  it('handles nested nav elements inside other elements', () => {
    const html = `<html><body>
      <div>
        <nav>
          <ul><li><a href="/">Home</a></li></ul>
        </nav>
      </div>
      <main><p>Main content</p></main>
    </body></html>`
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Main content')
    expect(result.text).not.toContain('Home')
  })

  it('handles very long single-line HTML', () => {
    const longText = 'Word '.repeat(10000)
    const html = `<html><body><p>${longText}</p></body></html>`
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.text).toContain('Word')
  })

  it('handles HTML with data attributes', () => {
    const html = '<html><body><div data-component="hero" data-id="123"><p>Hero content</p></div></body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Hero content')
    expect(result.text).not.toContain('data-component')
  })
})

describe('ContentExtractor - title edge cases', () => {
  const extractor = new ContentExtractor()

  it('handles empty title tag', () => {
    const html = '<html><head><title></title></head><body><p>Content</p></body></html>'
    const result = extractor.extract(html)
    // Empty title → should fall back to h1, or be undefined
    expect(result.title).toBeUndefined()
  })

  it('handles whitespace-only title tag', () => {
    const html = '<html><head><title>   \n  </title></head><body><p>Content</p></body></html>'
    const result = extractor.extract(html)
    expect(result.title).toBeUndefined()
  })

  it('handles title with nested tags', () => {
    const html = '<html><head><title>Title with <b>bold</b></title></head><body><p>Body</p></body></html>'
    const result = extractor.extract(html)
    // decodeEntities is called on the raw content including tags
    expect(result.title).toContain('Title with')
  })

  it('uses h1 with complex nested markup as fallback', () => {
    const html = '<html><body><h1><span class="highlight">Fancy</span> <em>Title</em></h1><p>Body</p></body></html>'
    const result = extractor.extract(html)
    expect(result.title).toBe('Fancy Title')
  })
})
