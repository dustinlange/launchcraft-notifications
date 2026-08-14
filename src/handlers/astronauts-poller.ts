import { Env } from '../index'
import { createLL2Client } from '../ll2'
import {
  getAllAstronautSnapshots,
  upsertAstronautSnapshot,
  getUsersForAstronautAgency,
  clearDeviceToken,
  logNotification,
} from '../db/queries'
import { pushAlertNotification } from '../apns'
import { getApnsConfig } from './webhook'

export async function pollAstronauts(env: Env): Promise<void> {
  // Fetch current astronaut list from LL2
  let astronauts: Array<{
    id: number
    name: string
    status: { id: number; name: string } | null
    agency: { id: number; name: string } | null
    flights_count: number | null
    in_space: boolean
    image: { image_url: string; thumbnail_url: string } | null
  }>
  try {
    const client = createLL2Client(env.LL2_API_KEY)
    astronauts = await client.getAstronauts(200)
  } catch (err) {
    console.error('pollAstronauts: failed to fetch astronauts from LL2', err)
    return
  }

  if (astronauts.length === 0) return

  // Load existing snapshots for change detection
  const { results: existingSnapshots } = await getAllAstronautSnapshots(env.DB)
  const snapshotMap = new Map(existingSnapshots.map(s => [s.astronaut_id, s]))

  const apnsConfig = getApnsConfig(env)

  for (const astronaut of astronauts) {
    // Belt-and-suspenders: skip non-active astronauts even if the API filter misbehaves
    if (astronaut.status?.id !== 1) continue

    const newInSpace = astronaut.in_space ? 1 : 0
    const existing = snapshotMap.get(astronaut.id)

    if (existing && existing.in_space !== newInSpace) {
      // Status changed — notify subscribers
      const agencyId = astronaut.agency?.id ?? null
      const { results: users } = await getUsersForAstronautAgency(env.DB, agencyId)

      if (users.length > 0) {
        const wasInSpace = existing.in_space === 1
        let title: string
        let body: string

        if (!wasInSpace && newInSpace === 1) {
          // Just launched to space
          const flightNum = astronaut.flights_count
          title = 'Astronaut Launched to Space'
          body = flightNum && flightNum > 0
            ? `${astronaut.name} has launched to space for the ${ordinal(flightNum)} time!`
            : `${astronaut.name} has launched to space!`
        } else {
          // Returned to Earth — use entered_space_at for an accurate day count
          const daysInSpace = existing.entered_space_at
            ? Math.round((Math.floor(Date.now() / 1000) - existing.entered_space_at) / 86400)
            : null
          title = 'Astronaut Returned to Earth'
          body = daysInSpace && daysInSpace > 0
            ? `${astronaut.name} has returned to Earth after ${daysInSpace} day${daysInSpace === 1 ? '' : 's'} in space.`
            : `${astronaut.name} has returned to Earth.`
        }

        const imageUrl = astronaut.image?.thumbnail_url ?? undefined

        await Promise.allSettled(
          users.map(async u => {
            const result = await pushAlertNotification(env.KV, apnsConfig, u.device_token, {
              title,
              body,
              launchId: '',
              type: 'astronaut_status',
              imageUrl,
            })
            await logNotification(env.DB, 'astronaut_status', u.user_id, result.ok)
            if (!result.ok && (result.status === 410 || result.status === 400)) {
              console.warn(`Clearing stale device token for ${u.user_id} after APNs ${result.status}`)
              await clearDeviceToken(env.DB, u.user_id, u.device_token)
            }
          })
        )
      }
    }

    // Upsert the new snapshot (also inserts first-time entries)
    await upsertAstronautSnapshot(env.DB, {
      astronaut_id: astronaut.id,
      name: astronaut.name,
      in_space: newInSpace,
      agency_id: astronaut.agency?.id ?? null,
      flights_count: astronaut.flights_count ?? null,
    })
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}
