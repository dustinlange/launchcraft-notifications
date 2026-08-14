import type { Context } from 'hono'
import type { Env } from '../index'

// Backs the app's "What's New" modal. The public GET is what the app calls on
// launch; the admin routes are for editing the content without a deploy.

interface WhatsNewRow {
  version: string
  title: string
  items: string
  enabled: number
  updated_at: number
}

export interface WhatsNewItem {
  systemImage: string
  title: string
  description: string
}

/// Parses the stored JSON blob, tolerating anything malformed by returning an
/// empty list — a bad row shouldn't fail the request for every user on launch.
function parseItems(raw: string): WhatsNewItem[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// GET /whats-new?version=2026.3
// Returns { release: null } with a 200 when there's nothing for this version,
// so "no notes this release" stays off the client's error path.
export async function handleGetWhatsNew(c: Context<{ Bindings: Env }>) {
  const version = c.req.query('version')
  if (!version) return c.json({ error: 'missing version' }, 400)

  const row = await c.env.DB.prepare(
    'SELECT version, title, items, enabled, updated_at FROM whats_new WHERE version = ? AND enabled = 1'
  ).bind(version).first<WhatsNewRow>()

  if (!row) return c.json({ release: null })

  const items = parseItems(row.items)
  if (items.length === 0) return c.json({ release: null })

  return c.json({
    release: {
      version: row.version,
      title: row.title,
      items,
    },
  })
}

/// Validates an admin payload before it can reach every user on next launch.
function validateItems(value: unknown): value is WhatsNewItem[] {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every(item =>
    item !== null &&
    typeof item === 'object' &&
    typeof (item as WhatsNewItem).systemImage === 'string' &&
    typeof (item as WhatsNewItem).title === 'string' &&
    typeof (item as WhatsNewItem).description === 'string' &&
    (item as WhatsNewItem).systemImage.length > 0 &&
    (item as WhatsNewItem).title.length > 0
  )
}

// PUT /admin/whats-new
export async function handleAdminUpsertWhatsNew(c: Context<{ Bindings: Env }>) {
  let body: { version?: string; title?: string; items?: unknown; enabled?: boolean }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  const { version, title, items, enabled } = body

  if (!version || typeof version !== 'string') {
    return c.json({ error: 'missing version' }, 400)
  }
  if (!validateItems(items)) {
    return c.json({ error: 'items must be a non-empty array of { systemImage, title, description }' }, 400)
  }

  await c.env.DB.prepare(
    `INSERT INTO whats_new (version, title, items, enabled, updated_at)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(version) DO UPDATE SET
       title      = excluded.title,
       items      = excluded.items,
       enabled    = excluded.enabled,
       updated_at = unixepoch()`
  ).bind(
    version,
    title ?? "What's New",
    JSON.stringify(items),
    enabled === false ? 0 : 1
  ).run()

  return c.json({ ok: true, version })
}

// GET /admin/whats-new — every release, including disabled ones, for an editor UI.
export async function handleAdminListWhatsNew(c: Context<{ Bindings: Env }>) {
  const rows = await c.env.DB.prepare(
    'SELECT version, title, items, enabled, updated_at FROM whats_new ORDER BY updated_at DESC'
  ).all<WhatsNewRow>()

  const releases = (rows.results ?? []).map(row => ({
    version:   row.version,
    title:     row.title,
    items:     parseItems(row.items),
    enabled:   row.enabled === 1,
    updatedAt: row.updated_at,
  }))

  return c.json({ releases })
}
