import { Context } from 'hono'
import { Env } from '../index'

interface VersionRow { id: number; version: string; title: string | null; released_at: number | null; created_at: number; item_count: number }
interface ItemRow { id: number; version_id: number; type: string; title: string; body: string | null; sort_order: number; system_image: string; created_at: number; updated_at: number }

function mapVersion(r: VersionRow) {
  return { id: r.id, version: r.version, title: r.title, releasedAt: r.released_at, createdAt: r.created_at, itemCount: r.item_count }
}

function mapItem(r: ItemRow) {
  return { id: r.id, versionId: r.version_id, type: r.type, title: r.title, body: r.body, sortOrder: r.sort_order, systemImage: r.system_image, createdAt: r.created_at, updatedAt: r.updated_at }
}

// ─── Public ───────────────────────────────────────────────────────────────────

// GET /whats-new?version=2026.3 — called by the app on launch. Returns
// { release: null } with a 200 when there's nothing for this version (no
// matching row, or a row with zero items), so "no notes this release" stays
// off the client's error path.
export async function handleGetWhatsNew(c: Context<{ Bindings: Env }>) {
  const version = c.req.query('version')
  if (!version) return c.json({ error: 'missing version' }, 400)

  const versionRow = await c.env.DB.prepare(
    'SELECT id, title FROM whats_new_versions WHERE version = ?'
  ).bind(version).first<{ id: number; title: string | null }>()

  if (!versionRow) return c.json({ release: null })

  const { results } = await c.env.DB.prepare(
    'SELECT title, body, system_image FROM whats_new_items WHERE version_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).bind(versionRow.id).all<{ title: string; body: string | null; system_image: string }>()

  if (!results || results.length === 0) return c.json({ release: null })

  return c.json({
    release: {
      version,
      title: versionRow.title || "What's New",
      items: results.map(item => ({
        systemImage: item.system_image,
        title: item.title,
        description: item.body ?? '',
      })),
    },
  })
}

// GET /whats-new/versions — public list of past releases that actually have
// content, for the app's "Previous Versions" settings screen. Excludes empty
// version rows an admin has created but not yet filled in.
export async function handleGetWhatsNewVersions(c: Context<{ Bindings: Env }>) {
  const { results } = await c.env.DB.prepare(`
    SELECT v.version, v.title, v.released_at, v.created_at, COUNT(i.id) AS item_count
    FROM whats_new_versions v
    JOIN whats_new_items i ON i.version_id = v.id
    GROUP BY v.id
    HAVING COUNT(i.id) > 0
    ORDER BY COALESCE(v.released_at, v.created_at) DESC
  `).all<{ version: string; title: string | null; released_at: number | null; created_at: number; item_count: number }>()

  const versions = (results ?? []).map(row => ({
    version: row.version,
    title: row.title || "What's New",
    releasedAt: row.released_at,
  }))

  return c.json({ versions })
}

// ─── Versions ─────────────────────────────────────────────────────────────────

export async function handleListVersions(c: Context<{ Bindings: Env }>) {
  const { results } = await c.env.DB.prepare(`
    SELECT v.id, v.version, v.title, v.released_at, v.created_at, COUNT(i.id) AS item_count
    FROM whats_new_versions v
    LEFT JOIN whats_new_items i ON i.version_id = v.id
    GROUP BY v.id
    ORDER BY v.created_at DESC
  `).all<VersionRow>()
  return c.json(results.map(mapVersion))
}

export async function handleCreateVersion(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ version?: string; title?: string; releasedAt?: number }>()
  if (!body.version?.trim()) return c.json({ error: 'version required' }, 400)

  const row = await c.env.DB.prepare(
    'INSERT INTO whats_new_versions (version, title, released_at) VALUES (?, ?, ?) RETURNING *'
  ).bind(body.version.trim(), body.title?.trim() || null, body.releasedAt ?? null).first<VersionRow & { item_count: 0 }>()

  return c.json(mapVersion({ ...row!, item_count: 0 }), 201)
}

export async function handleDeleteVersion(c: Context<{ Bindings: Env }>) {
  await c.env.DB.prepare('DELETE FROM whats_new_versions WHERE id = ?').bind(Number(c.req.param('id'))).run()
  return c.json({ ok: true })
}

// ─── Items ─────────────────────────────────────────────────────────────────────

export async function handleListItems(c: Context<{ Bindings: Env }>) {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM whats_new_items WHERE version_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).bind(Number(c.req.param('id'))).all<ItemRow>()
  return c.json(results.map(mapItem))
}

export async function handleCreateItem(c: Context<{ Bindings: Env }>) {
  const versionId = Number(c.req.param('id'))
  const body = await c.req.json<{ type?: string; title?: string; body?: string; systemImage?: string }>()
  if (!body.title?.trim()) return c.json({ error: 'title required' }, 400)

  const maxRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM whats_new_items WHERE version_id = ?'
  ).bind(versionId).first<{ next: number }>()

  const row = await c.env.DB.prepare(
    'INSERT INTO whats_new_items (version_id, type, title, body, sort_order, system_image) VALUES (?, ?, ?, ?, ?, ?) RETURNING *'
  ).bind(
    versionId,
    body.type ?? 'feature',
    body.title.trim(),
    body.body?.trim() || null,
    maxRow?.next ?? 0,
    body.systemImage?.trim() || 'sparkles'
  ).first<ItemRow>()

  return c.json(mapItem(row!), 201)
}

export async function handleUpdateItem(c: Context<{ Bindings: Env }>) {
  const itemId = Number(c.req.param('itemId'))
  const body = await c.req.json<{ type?: string; title: string; body?: string | null; sortOrder?: number; systemImage?: string }>()
  if (!body.title?.trim()) return c.json({ error: 'title required' }, 400)

  await c.env.DB.prepare(
    'UPDATE whats_new_items SET type = ?, title = ?, body = ?, system_image = ?, updated_at = unixepoch() WHERE id = ?'
  ).bind(body.type ?? 'feature', body.title.trim(), body.body?.trim() || null, body.systemImage?.trim() || 'sparkles', itemId).run()

  return c.json({ ok: true })
}

export async function handleDeleteItem(c: Context<{ Bindings: Env }>) {
  await c.env.DB.prepare('DELETE FROM whats_new_items WHERE id = ?').bind(Number(c.req.param('itemId'))).run()
  return c.json({ ok: true })
}

export async function handleReorderItems(c: Context<{ Bindings: Env }>) {
  const versionId = Number(c.req.param('id'))
  const body = await c.req.json<{ ids: number[] }>()
  if (!Array.isArray(body.ids)) return c.json({ error: 'ids array required' }, 400)

  const stmts = body.ids.map((id, index) =>
    c.env.DB.prepare('UPDATE whats_new_items SET sort_order = ? WHERE id = ? AND version_id = ?')
      .bind(index, id, versionId)
  )
  await c.env.DB.batch(stmts)
  return c.json({ ok: true })
}
