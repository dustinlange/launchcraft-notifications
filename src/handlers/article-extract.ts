import { Context } from 'hono'
import { Env } from '../index'

// Cap what we hand back — the on-device summarizer has a limited context
// window, and there's no reason to ship more text than it can use.
const MAX_TEXT_LENGTH = 8000

// GET /article-extract?url=<article-url>
// Fetches a news article server-side and extracts its readable text, so the
// app can summarize it on-device (Foundation Models has no way to read a
// page loaded in Safari — this is the only part of the summary feature that
// touches the backend at all).
export async function handleArticleExtract(c: Context<{ Bindings: Env }>) {
  const rawUrl = c.req.query('url')
  if (!rawUrl) return c.json({ error: 'missing url' }, 400)

  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    return c.json({ error: 'invalid url' }, 400)
  }

  // Basic SSRF guard: only ever fetch public http(s) article URLs, never
  // anything that could resolve to an internal/loopback address.
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return c.json({ error: 'invalid url' }, 400)
  }
  const hostname = target.hostname.toLowerCase()
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname === '0.0.0.0' ||
    hostname === '::1'
  ) {
    return c.json({ error: 'invalid url' }, 400)
  }

  let response: Response
  try {
    response = await fetch(target.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LaunchcraftBot/1.0)' },
    })
  } catch (err) {
    console.error('handleArticleExtract: fetch failed', err)
    return c.json({ error: 'could not load article' }, 502)
  }

  if (!response.ok || !response.body) {
    return c.json({ error: 'could not load article' }, 502)
  }

  const text = await extractText(response)
  if (!text) {
    return c.json({ error: 'could not extract article text' }, 502)
  }

  return c.json({ text, url: target.toString() })
}

/**
 * Pulls plain text out of an article page's <p> tags via HTMLRewriter —
 * Cloudflare Workers have no DOM, so a proper Readability-style parser
 * (which needs jsdom) can't run here. Collecting paragraph text is cruder
 * — it won't reliably drop related-article boxes or captions on every
 * site — but it's good enough for most news pages without adding any new
 * dependency. Upgrade path if quality proves insufficient: `linkedom` +
 * `@mozilla/readability`, both Workers-compatible.
 */
async function extractText(response: Response): Promise<string | null> {
  const paragraphs: string[] = []
  let current = ''

  const rewriter = new HTMLRewriter()
    // Drop obvious non-content regions before they ever reach the <p>
    // handler below.
    .on('nav, footer, aside, script, style, form, .related, .ad, .advertisement', {
      element(element) {
        element.remove()
      },
    })
    .on('p', {
      text(text) {
        current += text.text
        if (text.lastInTextNode) {
          const trimmed = current.trim()
          if (trimmed.length > 0) paragraphs.push(trimmed)
          current = ''
        }
      },
    })

  await rewriter.transform(response).arrayBuffer()

  const joined = paragraphs.join('\n\n').trim()
  if (joined.length === 0) return null
  return joined.length > MAX_TEXT_LENGTH ? joined.slice(0, MAX_TEXT_LENGTH) : joined
}
