import type { Context } from 'hono'
import type { Env } from '../index'

interface FeedTemplateRow {
  id: number
  sort_order: number
  title: string
  logo_url: string | null
  section_type: string
  agency_ids: string
  agency_names: string
  location_ids: string
  location_names: string
  news_sources: string
  crewed_only: number | null
  in_space_only: number
  launch_layout: string
}

export async function handleGetFeedTemplates(c: Context<{ Bindings: Env }>) {
  const rows = await c.env.DB.prepare(
    'SELECT id, sort_order, title, logo_url, section_type, agency_ids, agency_names, location_ids, location_names, news_sources, crewed_only, in_space_only, launch_layout FROM feed_templates WHERE enabled = 1 ORDER BY sort_order ASC'
  ).all<FeedTemplateRow>()

  const templates = (rows.results ?? []).map(row => ({
    id:           row.id,
    sortOrder:    row.sort_order,
    title:        row.title,
    logoUrl:      row.logo_url,
    sectionType:  row.section_type,
    agencyIds:    JSON.parse(row.agency_ids) as number[],
    agencyNames:  JSON.parse(row.agency_names) as string[],
    locationIds:    JSON.parse(row.location_ids) as number[],
    locationNames:  JSON.parse(row.location_names) as string[],
    newsSources:  JSON.parse(row.news_sources) as string[],
    crewedOnly:   row.crewed_only === null ? null : row.crewed_only === 1,
    inSpaceOnly:  row.in_space_only === 1,
    launchLayout: row.launch_layout,
  }))

  return c.json({ templates })
}
