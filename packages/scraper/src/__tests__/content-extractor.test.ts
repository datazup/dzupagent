import { describe, it, expect } from 'vitest'
import { ContentExtractor } from '../content-extractor.js'

describe('ContentExtractor', () => {
  const extractor = new ContentExtractor()

  describe('title extraction', () => {
    it('extracts title from <title> tag', () => {
      const html = '<html><head><title>My Page Title</title></head><body>Content</body></html>'
      const result = extractor.extract(html)
      expect(result.title).toBe('My Page Title')
    })

    it('falls back to first <h1> when no <title> tag exists', () => {
      const html = '<html><body><h1>Heading Title</h1><p>Content</p></body></html>'
      const result = extractor.extract(html)
      expect(result.title).toBe('Heading Title')
    })

    it('returns undefined when no title or h1 exists', () => {
      const html = '<html><body><p>Just a paragraph</p></body></html>'
      const result = extractor.extract(html)
      expect(result.title).toBeUndefined()
    })

    it('strips HTML tags from h1 fallback title', () => {
      const html = '<html><body><h1>Title with <em>emphasis</em></h1></body></html>'
      const result = extractor.extract(html)
      expect(result.title).toBe('Title with emphasis')
    })

    it('decodes HTML entities in title', () => {
      const html = '<html><head><title>Tom &amp; Jerry&apos;s Page</title></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.title).toBe("Tom & Jerry's Page")
    })
  })

  describe('meta description extraction', () => {
    it('extracts description from meta name="description"', () => {
      const html = '<html><head><meta name="description" content="A great page about things"></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.description).toBe('A great page about things')
    })

    it('handles content before name attribute order', () => {
      const html = '<html><head><meta content="Reverse order desc" name="description"></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.description).toBe('Reverse order desc')
    })

    it('returns undefined when no description meta tag', () => {
      const html = '<html><head></head><body>No meta tags</body></html>'
      const result = extractor.extract(html)
      expect(result.description).toBeUndefined()
    })
  })

  describe('author extraction', () => {
    it('extracts author from meta name="author"', () => {
      const html = '<html><head><meta name="author" content="Jane Doe"></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.author).toBe('Jane Doe')
    })

    it('falls back to article:author property', () => {
      const html = '<html><head><meta property="article:author" content="John Smith"></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.author).toBe('John Smith')
    })

    it('prefers meta name="author" over article:author', () => {
      const html = `<html><head>
        <meta name="author" content="Primary Author">
        <meta property="article:author" content="Secondary Author">
      </head><body>x</body></html>`
      const result = extractor.extract(html)
      expect(result.author).toBe('Primary Author')
    })
  })

  describe('published date extraction', () => {
    it('extracts date from article:published_time', () => {
      const html = '<html><head><meta property="article:published_time" content="2024-01-15"></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.publishedDate).toBe('2024-01-15')
    })

    it('falls back to meta name="date"', () => {
      const html = '<html><head><meta name="date" content="2023-06-20"></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.publishedDate).toBe('2023-06-20')
    })

    it('falls back to og:published_time', () => {
      const html = '<html><head><meta property="og:published_time" content="2023-12-01"></head><body>x</body></html>'
      const result = extractor.extract(html)
      expect(result.publishedDate).toBe('2023-12-01')
    })
  })

  describe('clean text extraction', () => {
    it('removes script tags and their content', () => {
      const html = '<html><body><p>Hello</p><script>alert("xss")</script><p>World</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).not.toContain('alert')
      expect(result.text).toContain('Hello')
      expect(result.text).toContain('World')
    })

    it('removes style tags and their content', () => {
      const html = '<html><body><style>.red{color:red}</style><p>Visible text</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).not.toContain('color')
      expect(result.text).toContain('Visible text')
    })

    it('removes nav, header, footer, aside elements', () => {
      const html = `<html><body>
        <nav><a href="/">Home</a></nav>
        <header><h1>Site Header</h1></header>
        <main><p>Main content here</p></main>
        <aside><p>Sidebar</p></aside>
        <footer><p>Copyright</p></footer>
      </body></html>`
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Main content here')
      expect(result.text).not.toContain('Home')
      expect(result.text).not.toContain('Site Header')
      expect(result.text).not.toContain('Sidebar')
      expect(result.text).not.toContain('Copyright')
    })

    it('removes HTML comments', () => {
      const html = '<html><body><!-- This is a comment --><p>Real content</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).not.toContain('comment')
      expect(result.text).toContain('Real content')
    })

    it('removes iframe and svg elements', () => {
      const html = '<html><body><iframe src="https://example.com"></iframe><svg><circle></circle></svg><p>Text</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Text')
      expect(result.text).not.toContain('iframe')
      expect(result.text).not.toContain('circle')
    })

    it('removes form elements', () => {
      const html = '<html><body><form><input type="text"><button>Submit</button></form><p>After form</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('After form')
      expect(result.text).not.toContain('Submit')
    })

    it('collapses multiple whitespace into single spaces', () => {
      const html = '<html><body><p>Word1     Word2\t\tWord3</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).not.toMatch(/  /)
    })

    it('collapses excessive newlines', () => {
      const html = '<html><body><p>Para 1</p><div></div><div></div><div></div><div></div><p>Para 2</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).not.toMatch(/\n{3,}/)
    })
  })

  describe('non-clean text extraction (stripAllTags only)', () => {
    it('strips tags but keeps all text content', () => {
      const html = '<html><body><script>var x = 1;</script><nav>NavText</nav><p>Content</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: false })
      // cleanHtml: false only strips tags, keeps all text
      expect(result.text).toContain('Content')
      expect(result.text).toContain('var x = 1;')
    })
  })

  describe('maxLength truncation', () => {
    it('truncates text to maxLength', () => {
      const html = '<html><body><p>' + 'A'.repeat(500) + '</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true, maxLength: 50 })
      expect(result.text.length).toBe(50)
    })

    it('does not truncate when text is shorter than maxLength', () => {
      const html = '<html><body><p>Short text</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true, maxLength: 1000 })
      expect(result.text).toBe('Short text')
    })
  })

  describe('metadata-only mode', () => {
    it('returns empty text in metadata mode', () => {
      const html = `<html><head>
        <title>Page Title</title>
        <meta name="description" content="A description">
        <meta name="author" content="Author Name">
      </head><body><p>Body content should be ignored</p></body></html>`
      const result = extractor.extract(html, { mode: 'metadata' })
      expect(result.text).toBe('')
      expect(result.title).toBe('Page Title')
      expect(result.description).toBe('A description')
      expect(result.author).toBe('Author Name')
    })
  })

  describe('HTML entity decoding', () => {
    it('decodes named entities', () => {
      const html = '<html><body><p>&amp; &lt; &gt; &quot; &#39; &nbsp;</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('&')
      expect(result.text).toContain('<')
      expect(result.text).toContain('>')
      expect(result.text).toContain('"')
      expect(result.text).toContain("'")
    })

    it('decodes special character entities', () => {
      const html = '<html><body><p>&mdash; &ndash; &hellip; &copy; &reg; &trade;</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('\u2014') // mdash
      expect(result.text).toContain('\u2013') // ndash
      expect(result.text).toContain('\u2026') // hellip
      expect(result.text).toContain('\u00A9') // copy
      expect(result.text).toContain('\u00AE') // reg
      expect(result.text).toContain('\u2122') // trade
    })

    it('decodes numeric decimal entities', () => {
      const html = '<html><body><p>&#65;&#66;&#67;</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('ABC')
    })

    it('decodes numeric hex entities', () => {
      const html = '<html><body><p>&#x41;&#x42;&#x43;</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('ABC')
    })
  })

  describe('edge cases', () => {
    it('handles empty HTML', () => {
      const result = extractor.extract('')
      expect(result.text).toBe('')
      expect(result.title).toBeUndefined()
    })

    it('handles HTML with only whitespace', () => {
      const result = extractor.extract('   \n\n  \t  ')
      expect(result.text).toBe('')
    })

    it('handles deeply nested HTML', () => {
      const html = '<html><body><div><div><div><div><p>Deep content</p></div></div></div></div></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Deep content')
    })

    it('handles self-closing tags', () => {
      const html = '<html><body><p>Before<br/>After</p></body></html>'
      const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
      expect(result.text).toContain('Before')
      expect(result.text).toContain('After')
    })
  })
})
