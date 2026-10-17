import type { Page } from 'patchright'
import { AccountSuspendedError } from '../../interface/Errors'

export { AccountSuspendedError }

export const SUSPENSION_PATTERNS = [
    /your account has been suspended/i,
    /akun anda telah ditangguhkan/i,
    /account restricted/i,
    /violating the terms of service/i
] as const

export const SUSPENSION_URL_ROUTES = [
    '/error?code=100',
    '/suspended',
    '/restricted'
] as const

/**
 * Checks if the given HTML/text content or URL indicates account suspension/ban.
 */
export function isSuspensionContent(htmlOrText: string, currentUrl?: string): boolean {
    const url = (currentUrl || '').toLowerCase()
    if (SUSPENSION_URL_ROUTES.some(route => url.includes(route))) {
        return true
    }

    const text = (htmlOrText || '').toLowerCase()
    return SUSPENSION_PATTERNS.some(pattern => pattern.test(text))
}

/**
 * Proactively inspects a Playwright Page for suspension indicators via URL, DOM evaluate, and page content.
 */
export async function checkPageSuspension(page: Page): Promise<{ isSuspended: boolean; reason?: string }> {
    if (!page || typeof page.isClosed !== 'function' || page.isClosed() || typeof page.url !== 'function') {
        return { isSuspended: false }
    }

    try {
        const currentUrl = page.url() || ''
        const urlLower = currentUrl.toLowerCase()

        for (const route of SUSPENSION_URL_ROUTES) {
            if (urlLower.includes(route)) {
                return {
                    isSuspended: true,
                    reason: `URL contains suspended route: ${route} (${currentUrl})`
                }
            }
        }

        // Fast in-page evaluation of visible text
        const bodyText = await page.evaluate(() => {
            return (document.documentElement ? document.documentElement.innerText || document.documentElement.textContent : '') || ''
        }).catch(() => '')

        for (const pattern of SUSPENSION_PATTERNS) {
            if (pattern.test(bodyText)) {
                return {
                    isSuspended: true,
                    reason: `Suspension text detected matching pattern: ${pattern.toString()}`
                }
            }
        }

        // Additional fallback: inspect page content
        const rawContent = await page.content().catch(() => '')
        for (const pattern of SUSPENSION_PATTERNS) {
            if (pattern.test(rawContent)) {
                return {
                    isSuspended: true,
                    reason: `Suspension content detected matching pattern: ${pattern.toString()}`
                }
            }
        }
    } catch {}

    return { isSuspended: false }
}
