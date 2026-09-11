import crypto from 'crypto'
import { redactAccountKey } from '../../util/Redaction'

export interface AccountIdentity {
    accountId: string       // Stable internal UUID or SHA-256 namespace hash of normalized email
    displayAccount: string  // Redacted label for human-facing logs and UI only
}

/**
 * Resolves a stable account identity from account configuration.
 * Never generates random UUIDs per run.
 */
export function resolveAccountIdentity(account: { id?: string; email: string }): AccountIdentity {
    const rawEmail = account.email || ''
    const normalizedEmail = rawEmail.toLowerCase().trim()

    const accountId = account.id && account.id.trim().length > 0
        ? account.id.trim()
        : crypto.createHash('sha256').update(normalizedEmail).digest('hex')

    const displayAccount = redactAccountKey(rawEmail)

    return {
        accountId,
        displayAccount
    }
}

/**
 * Validates that all resolved account IDs in an account list are strictly unique.
 * Throws a descriptive error on duplicate accountId to fail fast at startup.
 */
export function validateUniqueAccountIdentities(accounts: Array<{ id?: string; email: string }>): void {
    const seen = new Map<string, string>() // accountId -> original identifier

    for (const acc of accounts) {
        const identity = resolveAccountIdentity(acc)
        if (seen.has(identity.accountId)) {
            const prior = seen.get(identity.accountId)!
            throw new Error(
                `[FATAL-IDENTITY] Duplicate accountId detected: '${identity.accountId}'. ` +
                `Collision between '${prior}' and '${acc.email}'. Each account must have a unique identifier.`
            )
        }
        seen.set(identity.accountId, acc.email)
    }
}
