import crypto from 'crypto'
import type { Account } from '../../interface/Account'

export interface AccountOwnershipIdentity {
    accountId: string
    participantId: string
    householdId: string
}

export type OwnershipPolicyStatus =
    | 'valid'
    | 'identity-missing'
    | 'duplicate-account-id'
    | 'duplicate-participant'
    | 'household-limit-exceeded'
    | 'invalid-identity'

export interface OwnershipPolicyResult {
    status: OwnershipPolicyStatus
    accountId: string
    participantId: string
    householdId: string
    householdAccountCount: number
    reasons: string[]
    rawEmail?: string // Kept in memory for internal lookup, masked before diagnostic serialization
}

export interface OwnershipPolicySummary {
    totalAccounts: number
    totalParticipants: number
    totalHouseholds: number
    validAccounts: number
    blockedAccounts: number
    results: OwnershipPolicyResult[]
}

export type OwnershipEnforcementMode = 'report-only' | 'block-invalid'

export const MAX_HOUSEHOLD_ACCOUNTS = 6

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidUuid(val: unknown): boolean {
    return typeof val === 'string' && UUID_REGEX.test(val.trim())
}

/**
 * Derives an ephemeral, privacy-preserving public reference for UI/diagnostics.
 * Retains 128 bits (32 hex characters) derived via HMAC-SHA256.
 * The sessionSecret is created once per process run and never persisted or logged.
 */
export function derivePublicRef(sessionSecret: string, id: string): string {
    if (!sessionSecret) {
        throw new Error('[OWNERSHIP-IDENTITY] sessionSecret must be provided for derivePublicRef')
    }
    return crypto
        .createHmac('sha256', sessionSecret)
        .update(id)
        .digest('hex')
        .slice(0, 32)
}

export interface SanitizedDiagnosticResult {
    status: OwnershipPolicyStatus
    publicAccountRef: string
    publicParticipantRef: string
    publicHouseholdRef: string
    householdAccountCount: number
    reasons: string[]
}

export interface SanitizedDiagnosticSummary {
    enforcementMode: OwnershipEnforcementMode
    totalAccounts: number
    totalParticipants: number
    totalHouseholds: number
    validAccounts: number
    blockedAccounts: number
    results: SanitizedDiagnosticResult[]
}

/**
 * Creates a public, sanitized diagnostic DTO that never exposes raw UUIDs, emails, or credentials.
 */
export function createSanitizedDiagnosticDto(
    summary: OwnershipPolicySummary,
    enforcementMode: OwnershipEnforcementMode,
    sessionSecret: string
): SanitizedDiagnosticSummary {
    return {
        enforcementMode,
        totalAccounts: summary.totalAccounts,
        totalParticipants: summary.totalParticipants,
        totalHouseholds: summary.totalHouseholds,
        validAccounts: summary.validAccounts,
        blockedAccounts: summary.blockedAccounts,
        results: summary.results.map(r => ({
            status: r.status,
            publicAccountRef: r.accountId ? derivePublicRef(sessionSecret, r.accountId) : 'missing',
            publicParticipantRef: r.participantId ? derivePublicRef(sessionSecret, r.participantId) : 'missing',
            publicHouseholdRef: r.householdId ? derivePublicRef(sessionSecret, r.householdId) : 'missing',
            householdAccountCount: r.householdAccountCount,
            reasons: r.reasons
        }))
    }
}

export function isAccountActive(account: Account): boolean {
    return account.enabled !== false
}

/**
 * Cross-account ownership policy validator.
 * Validates:
 * 1. accountId uniqueness across the entire account list.
 * 2. Exactly one active account per participantId.
 * 3. Maximum 6 active accounts per householdId (hard policy constant).
 * 4. Strict UUID format.
 * In 'report-only' mode, reports identity-missing or invalid-identity without throwing.
 */
export function validateOwnershipPolicy(
    accounts: Account[],
    mode: OwnershipEnforcementMode = 'report-only'
): OwnershipPolicySummary {
    const results: OwnershipPolicyResult[] = []

    const seenAccountIds = new Map<string, string>() // accountId -> email/index
    const activeParticipantMap = new Map<string, string>() // participantId -> email
    const householdActiveCountMap = new Map<string, number>() // householdId -> active count

    // Pre-pass: calculate active accounts per household
    for (const acc of accounts) {
        if (isAccountActive(acc) && acc.householdId && isValidUuid(acc.householdId)) {
            const hId = acc.householdId.trim().toLowerCase()
            householdActiveCountMap.set(hId, (householdActiveCountMap.get(hId) || 0) + 1)
        }
    }

    const uniqueParticipants = new Set<string>()
    const uniqueHouseholds = new Set<string>()

    let validCount = 0
    let blockedCount = 0

    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i]!
        const active = isAccountActive(acc)
        const reasons: string[] = []
        let status: OwnershipPolicyStatus = 'valid'

        const accountId = acc.id?.trim() || ''
        const participantId = acc.participantId?.trim() || ''
        const householdId = acc.householdId?.trim() || ''

        // 1. Missing identity check
        const missingFields: string[] = []
        if (!accountId) missingFields.push('id')
        if (!participantId) missingFields.push('participantId')
        if (!householdId) missingFields.push('householdId')

        if (missingFields.length > 0) {
            status = 'identity-missing'
            reasons.push(`Missing identity fields: ${missingFields.join(', ')}`)
        } else {
            // 2. Format validation
            if (!isValidUuid(accountId)) {
                status = 'invalid-identity'
                reasons.push(`Invalid UUID format for accountId: '${accountId}'`)
            }
            if (!isValidUuid(participantId)) {
                status = 'invalid-identity'
                reasons.push(`Invalid UUID format for participantId: '${participantId}'`)
            }
            if (!isValidUuid(householdId)) {
                status = 'invalid-identity'
                reasons.push(`Invalid UUID format for householdId: '${householdId}'`)
            }
        }

        // 3. Duplicate accountId check (across ALL accounts, active or not)
        if (accountId && isValidUuid(accountId)) {
            const normAccountId = accountId.toLowerCase()
            if (seenAccountIds.has(normAccountId)) {
                status = 'duplicate-account-id'
                reasons.push(`Duplicate accountId detected: collides with ${seenAccountIds.get(normAccountId)}`)
            } else {
                seenAccountIds.set(normAccountId, acc.email || `index_${i}`)
            }
        }

        // 4. Participant constraint (1 active account per participantId)
        if (active && participantId && isValidUuid(participantId)) {
            const normPartId = participantId.toLowerCase()
            uniqueParticipants.add(normPartId)
            if (activeParticipantMap.has(normPartId)) {
                status = 'duplicate-participant'
                reasons.push(
                    `One participant may only have one active account: participantId already claimed by ${activeParticipantMap.get(normPartId)}`
                )
            } else {
                activeParticipantMap.set(normPartId, acc.email || `index_${i}`)
            }
        }

        // 5. Household limit check (max 6 active accounts per householdId)
        let householdCount = 0
        if (householdId && isValidUuid(householdId)) {
            const normHouseId = householdId.toLowerCase()
            uniqueHouseholds.add(normHouseId)
            householdCount = householdActiveCountMap.get(normHouseId) || 0
            if (active && householdCount > MAX_HOUSEHOLD_ACCOUNTS) {
                status = 'household-limit-exceeded'
                reasons.push(
                    `Household limit exceeded: ${householdCount} active accounts in household (maximum permitted: ${MAX_HOUSEHOLD_ACCOUNTS})`
                )
            }
        }

        if (status === 'valid') {
            validCount++
        } else {
            blockedCount++
        }

        results.push({
            status,
            accountId,
            participantId,
            householdId,
            householdAccountCount: householdCount,
            reasons,
            rawEmail: acc.email
        })
    }

    return {
        totalAccounts: accounts.length,
        totalParticipants: uniqueParticipants.size,
        totalHouseholds: uniqueHouseholds.size,
        validAccounts: validCount,
        blockedAccounts: blockedCount,
        results
    }
}
