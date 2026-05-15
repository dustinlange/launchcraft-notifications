// Launch Library 2 API client
// Docs: https://ll.thespacedevs.com/docs/

const LL2_BASE = 'https://ll.thespacedevs.com/2.3.0'

// Subset of the LL2 launch object we care about
export interface LL2Launch {
  id: string
  name: string
  net: string | null           // ISO8601 datetime; can be null if NET unknown
  window_start: string | null
  window_end: string | null
  status: { id: number; abbrev: string }
  image: string | null
  rocket: { configuration: { name: string; image_url: string | null } }
  pad: { name: string; location: { id: number; name: string } }
  launch_service_provider: { id: number; name: string; logo_url: string | null } | null
  mission: { name: string; description: string } | null
  timeline: LL2TimelineEvent[] | null
}

export interface LL2TimelineEvent {
  type: { abbrev: string }
  relative_time: string  // ISO 8601 duration e.g. "-PT38M" or "PT1M20S"
}

export function mapT0(net: string | null): number | null {
  if (!net) return null
  const ts = Date.parse(net)
  return isNaN(ts) ? null : Math.floor(ts / 1000)
}

// Parse ISO 8601 duration e.g. "-PT38M", "PT1M20S", "-PT1H2M30S" → signed seconds
export function parseRelativeTime(rel: string): number {
  const neg = rel.startsWith('-')
  const s = rel.replace(/^-/, '')
  const h = Number(s.match(/(\d+)H/)?.[1] ?? 0)
  const m = Number(s.match(/(\d+)M/)?.[1] ?? 0)
  const sec = Number(s.match(/(\d+)S/)?.[1] ?? 0)
  const total = h * 3600 + m * 60 + sec
  return neg ? -total : total
}

export interface LL2Client {
  getUpcomingLaunches(limit?: number): Promise<LL2Launch[]>
  getLaunch(id: string): Promise<LL2Launch | null>
}

export function createLL2Client(apiKey: string): LL2Client {
  const headers = {
    'Authorization': `Token ${apiKey}`,
    'Content-Type': 'application/json',
  }

  return {
    async getUpcomingLaunches(limit = 50): Promise<LL2Launch[]> {
      // status=1 (Go), 2 (TBD), 3 (TBC), 8 (Hold), 5 (In Flight)
      const url = `${LL2_BASE}/launches/upcoming/?limit=${limit}&ordering=net&status__ids=1,2,3,5,8&mode=detailed`
      console.log(`LL2 GET ${url}`)
      const res = await fetch(url, { headers })
      console.log(`LL2 upcoming response: ${res.status}`)
      if (!res.ok) throw new Error(`LL2 upcoming fetch failed: ${res.status}`)
      const data = await res.json<{ results: LL2Launch[] }>()
      return data.results
    },

    async getLaunch(id: string): Promise<LL2Launch | null> {
      const url = `${LL2_BASE}/launches/${id}/?mode=detailed`
      console.log(`LL2 GET ${url}`)
      const res = await fetch(url, { headers })
      console.log(`LL2 launch/${id} response: ${res.status}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`LL2 launch fetch failed: ${res.status}`)
      return res.json<LL2Launch>()
    },
  }
}
