import type { BrowserContext } from 'patchright'

export type SessionDevice = 'mobile' | 'desktop'

export type PlaywrightStorageState = Awaited<ReturnType<BrowserContext['storageState']>>
export type PlaywrightCookie = PlaywrightStorageState['cookies'][number]
export type PlaywrightOrigin = PlaywrightStorageState['origins'][number]

export const SUPPORTED_SCHEMA_VERSION = 1 as const
export const MAX_SESSION_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB limit

/**
 * Storage envelope for persisted Playwright sessions.
 * Plaintext authentication data at rest; protected via filesystem boundaries.
 */
export interface StoredSessionEnvelope {
    schemaVersion: 1
    accountId: string
    device: SessionDevice
    savedAt: number
    storageState: PlaywrightStorageState
}

export type SessionLoadSource =
    | 'modern-envelope'
    | 'previous-storage-state'
    | 'legacy-cookie-json'

export type SessionLoadResult =
    | {
          status: 'loaded'
          source: SessionLoadSource
          state: PlaywrightStorageState
          savedAt: number
          path: string
      }
    | {
          status: 'missing'
          path?: string
      }
    | {
          status: 'corrupted'
          reason: string
          path: string
      }
    | {
          status: 'unsupported-version'
          schemaVersion: number
          path: string
      }
    | {
          status: 'identity-mismatch'
          expectedAccountId: string
          actualAccountId: string
          expectedDevice?: SessionDevice
          actualDevice?: SessionDevice
          path: string
      }
    | {
          status: 'io-error'
          error: string
          path: string
      }

export type SessionSaveResult =
    | {
          status: 'saved'
          durationMs: number
          path: string
      }
    | {
          status: 'skipped'
          reason: string
      }
    | {
          status: 'failed'
          error: string
          path?: string
      }
    | {
          status: 'timed-out'
          durationMs: number
          path?: string
      }

/**
 * Validates Playwright storage state structure at runtime without trusting any/unknown casts.
 */
export function isValidStorageState(obj: any): obj is PlaywrightStorageState {
    if (!obj || typeof obj !== 'object') return false
    if (!Array.isArray(obj.cookies)) return false

    for (const c of obj.cookies) {
        if (!c || typeof c !== 'object') return false
        if (typeof c.name !== 'string' || typeof c.value !== 'string') return false
        if (typeof c.domain !== 'string' || typeof c.path !== 'string') return false
    }

    if (obj.origins !== undefined) {
        if (!Array.isArray(obj.origins)) return false
        for (const o of obj.origins) {
            if (!o || typeof o !== 'object') return false
            if (typeof o.origin !== 'string') return false
            if (!Array.isArray(o.localStorage)) return false
        }
    }

    return true
}
