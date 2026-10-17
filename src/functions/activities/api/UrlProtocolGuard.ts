export const LOCAL_SYSTEM_PROTOCOLS = [
    'ms-search:',
    'microsoft-edge:',
    'ms-windows-store:',
    'intent:'
] as const

export function isLocalSystemProtocol(rawUrl?: string): boolean {
    if (!rawUrl) return false
    const trimmed = rawUrl.trim().toLowerCase()
    return LOCAL_SYSTEM_PROTOCOLS.some(scheme => trimmed.startsWith(scheme))
}

export interface PunchCardUrlResolution {
    action: 'navigate' | 'search' | 'skip-app'
    url?: string
    reason?: string
}

export function resolvePunchCardExecutionUrl(
    destinationUrl: string | undefined,
    title: string,
    offerId?: string
): PunchCardUrlResolution {
    const raw = (destinationUrl || '').trim()
    const lower = raw.toLowerCase()
    const cleanTitle = (title || offerId || 'Microsoft Rewards').trim()

    // 1. Promo aplikasi Bing / quest eksklusif Bing App
    if (lower.includes('bing.com/apps/rewards') || lower.includes('form=quest1')) {
        return {
            action: 'skip-app',
            reason: 'bing-app-exclusive-promo'
        }
    }

    // 2. ms-search: protocol - ekstrak parameter q atau fallback ke title
    if (lower.startsWith('ms-search:')) {
        let extractedQuery = ''
        try {
            const dummy = raw.replace(/^ms-search:\/?\/?/i, 'https://dummy.local/?')
            const parsed = new URL(dummy)
            extractedQuery = parsed.searchParams.get('q') || ''
        } catch {}

        if (!extractedQuery) {
            const match = raw.match(/[?&]q=([^&]+)/i)
            if (match && match[1]) {
                try {
                    extractedQuery = decodeURIComponent(match[1].replace(/\+/g, ' '))
                } catch {
                    extractedQuery = match[1]
                }
            }
        }

        const finalQuery = extractedQuery.trim() || cleanTitle
        return {
            action: 'search',
            url: `https://www.bing.com/search?q=${encodeURIComponent(finalQuery)}`,
            reason: 'ms-search-converted-to-bing-search'
        }
    }

    // 3. Deprecated envelope endpoint (baik absolute maupun relative)
    if (lower.includes('/dashboard/envelope')) {
        return {
            action: 'search',
            url: `https://www.bing.com/search?q=${encodeURIComponent(cleanTitle)}`,
            reason: 'deprecated-envelope-converted-to-bing-search'
        }
    }

    // 4. microsoft-edge: protocol
    if (lower.startsWith('microsoft-edge:') || lower.startsWith('microsoft-edge://')) {
        let extractedUrl = ''
        try {
            const cleanEdgeStr = raw.replace(/^microsoft-edge:\/\/?/i, 'https://dummy.edge.local/')
            const parsedEdge = new URL(cleanEdgeStr)
            const targetParam = parsedEdge.searchParams.get('url')
            if (targetParam) extractedUrl = targetParam.trim()
        } catch {}

        if (!extractedUrl) {
            const match = raw.match(/^microsoft-edge:\/?\/?(https?:\/\/.+)$/i)
            if (match && match[1]) extractedUrl = match[1].trim()
        }

        if (extractedUrl && (extractedUrl.startsWith('http://') || extractedUrl.startsWith('https://'))) {
            return {
                action: 'navigate',
                url: extractedUrl,
                reason: 'edge-protocol-target-url-extracted'
            }
        }

        return {
            action: 'search',
            url: `https://www.bing.com/search?q=${encodeURIComponent(cleanTitle)}`,
            reason: 'edge-protocol-converted-to-bing-search'
        }
    }

    // 5. Local system protocols lainnya
    if (isLocalSystemProtocol(raw)) {
        return {
            action: 'search',
            url: `https://www.bing.com/search?q=${encodeURIComponent(cleanTitle)}`,
            reason: 'local-protocol-converted-to-bing-search'
        }
    }

    // 6. Destination URL kosong / whitespace
    if (!raw) {
        return {
            action: 'search',
            url: `https://www.bing.com/search?q=${encodeURIComponent(cleanTitle)}`,
            reason: 'empty-destination-fallback-to-search'
        }
    }

    // 7. Protocol-relative URL
    if (raw.startsWith('//')) {
        return {
            action: 'navigate',
            url: `https:${raw}`,
            reason: 'protocol-relative-resolved'
        }
    }

    // 8. Path relatif (selain /dashboard/envelope yang sudah ditangani di atas)
    if (raw.startsWith('/')) {
        return {
            action: 'navigate',
            url: `https://rewards.bing.com${raw}`,
            reason: 'relative-path-resolved'
        }
    }

    // 9. Standard HTTP/HTTPS URL
    return {
        action: 'navigate',
        url: raw
    }
}

