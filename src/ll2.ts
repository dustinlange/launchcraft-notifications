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
  rocket: { configuration: { name: string } }
  pad: { name: string; location: { name: string } }
  mission: { name: string; description: string } | null
  flightplan: LL2FlightplanEvent[] | null  // only on detailed endpoint; paid tier
}

export interface LL2FlightplanEvent {
  description: string
  relative_time: string  // e.g. "-00:05:00" or "00:01:20"
}

// LL2 status abbrevs → our status
const STATUS_MAP: Record<string, 'go' | 'hold' | 'scrub' | 'success' | 'failure'> = {
  'Go':              'go',
  'TBD':             'go',
  'TBC':             'go',
  'Hold':            'hold',
  'In Flight':       'go',
  'Success':         'success',
  'Failure':         'failure',
  'Partial Failure': 'failure',
  'Scrub':           'scrub',
}

export function mapStatus(abbrev: string): 'go' | 'hold' | 'scrub' | 'success' | 'failure' {
  return STATUS_MAP[abbrev] ?? 'go'
}

export function mapT0(net: string | null): number | null {
  if (!net) return null
  const ts = Date.parse(net)
  return isNaN(ts) ? null : Math.floor(ts / 1000)
}

// Parse "HH:MM:SS" or "-HH:MM:SS" relative time → seconds offset from T-0
export function parseRelativeTime(rel: string): number {
  const neg = rel.startsWith('-')
  const parts = rel.replace(/^-/, '').split(':').map(Number)
  const secs = (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)
  return neg ? -secs : secs
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
      const url = `${LL2_BASE}/launch/upcoming/?limit=${limit}&ordering=net&status=1,2,3,5,8&mode=detailed`
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`LL2 upcoming fetch failed: ${res.status}`)
      const data = await res.json<{ results: LL2Launch[] }>()
      return data.results
    },

    async getLaunch(id: string): Promise<LL2Launch | null> {
      const res = await fetch(`${LL2_BASE}/launch/${id}/?mode=detailed`, { headers })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`LL2 launch fetch failed: ${res.status}`)
      return res.json<LL2Launch>()
    },
  }
}
