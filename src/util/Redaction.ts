/**
 * Redaction and log sanitization utilities.
 * Completely independent of AppOnly or Logger modules to prevent circular dependencies.
 */

export function redactAccountKey(identifier: string): string {
    if (!identifier) return 'anon'
    const clean = identifier.trim()
    const atIndex = clean.indexOf('@')
    if (atIndex <= 0) {
        if (clean.length <= 4) return 'acc***'
        return `${clean.slice(0, 3)}***`
    }
    const user = clean.slice(0, atIndex)
    const domain = clean.slice(atIndex + 1)
    const visibleLen = Math.min(3, Math.max(1, user.length - 2))
    return `${user.slice(0, visibleLen)}***@${domain}`
}

export function sanitizeLogMessage(input: string): string {
    if (!input || typeof input !== 'string') return input

    let sanitized = input

    // 1. Redact OAuth code and state query parameters:
    // Matches ?code=xyz or &code=xyz or code=xyz
    sanitized = sanitized.replace(/([?&]code=)([^&\s"'`]+)/gi, '$1[REDACTED]')
    sanitized = sanitized.replace(/([?&]state=)([^&\s"'`]+)/gi, '$1[REDACTED]')
    sanitized = sanitized.replace(/\b(code=)([^&\s"'`]+)/gi, '$1[REDACTED]')
    sanitized = sanitized.replace(/\b(state=)([^&\s"'`]+)/gi, '$1[REDACTED]')

    // 2. Redact OAuth tokens query parameters or key-values:
    sanitized = sanitized.replace(/([?&]access_token=)([^&\s"'`]+)/gi, '$1[REDACTED]')
    sanitized = sanitized.replace(/([?&]refresh_token=)([^&\s"'`]+)/gi, '$1[REDACTED]')
    sanitized = sanitized.replace(/\b(access_token=)([^&\s"'`]+)/gi, '$1[REDACTED]')
    sanitized = sanitized.replace(/\b(refresh_token=)([^&\s"'`]+)/gi, '$1[REDACTED]')

    // 3. Redact Authorization header & Bearer tokens:
    sanitized = sanitized.replace(/(Authorization:\s*Bearer\s+)[^\s"'`]+/gi, '$1[REDACTED]')
    sanitized = sanitized.replace(/\b(Bearer\s+)[A-Za-z0-9\-_=.]{10,}\b/gi, '$1[REDACTED]')

    // 4. Redact full email addresses:
    // e.g. ehsanfizibers@outlook.com -> ehs***@outlook.com
    sanitized = sanitized.replace(/\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (match, user, domain) => {
        // If already redacted, preserve
        if (user.endsWith('***')) return match
        const visibleLen = Math.min(3, Math.max(1, user.length - 2))
        return `${user.slice(0, visibleLen)}***@${domain}`
    })

    return sanitized
}

export function sanitizeLogMetadata<T>(value: T, seen = new WeakSet()): T {
    if (value === null || value === undefined) return value

    if (typeof value === 'string') {
        return sanitizeLogMessage(value) as unknown as T
    }

    if (typeof value !== 'object') {
        return value
    }

    // Handle circular references safely
    if (seen.has(value as object)) {
        return '[Circular]' as unknown as T
    }
    seen.add(value as object)

    if (Array.isArray(value)) {
        return value.map(item => sanitizeLogMetadata(item, seen)) as unknown as T
    }

    const sensitiveKeyPatterns = [/password/i, /secret/i, /token/i, /cookie/i, /auth/i, /code/i]

    const sanitizedObj: Record<string, any> = {}
    for (const [key, val] of Object.entries(value)) {
        const isSensitiveKey = sensitiveKeyPatterns.some(pattern => pattern.test(key))
        if (isSensitiveKey && typeof val === 'string' && val.length > 0) {
            sanitizedObj[key] = '[REDACTED]'
        } else if (key.toLowerCase() === 'email' && typeof val === 'string') {
            sanitizedObj[key] = redactAccountKey(val)
        } else {
            sanitizedObj[key] = sanitizeLogMetadata(val, seen)
        }
    }

    return sanitizedObj as T
}
