const SNAPI_BASE = 'https://api.spaceflightnewsapi.net/v4'

export interface SNAPIArticle {
  id: number
  title: string
  url: string
  news_site: string
  published_at: string
  authors: Array<{ name: string }> | null
  image_url: string | null
}

export async function getRecentArticles(since: Date): Promise<SNAPIArticle[]> {
  const iso = since.toISOString()
  const url = `${SNAPI_BASE}/articles/?limit=50&ordering=-published_at&published_at__gte=${encodeURIComponent(iso)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`SNAPI articles fetch failed: ${res.status}`)
  const data = await res.json() as { results: SNAPIArticle[] }
  return data.results ?? []
}

export async function getNewsSites(): Promise<string[]> {
  const res = await fetch(`${SNAPI_BASE}/info/`)
  if (!res.ok) throw new Error(`SNAPI info fetch failed: ${res.status}`)
  const data = await res.json() as { news_sites: string[] }
  return data.news_sites ?? []
}
