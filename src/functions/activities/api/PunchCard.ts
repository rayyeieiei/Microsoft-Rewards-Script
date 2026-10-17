export {
    LOCAL_SYSTEM_PROTOCOLS,
    isLocalSystemProtocol,
    resolvePunchCardExecutionUrl,
    type PunchCardUrlResolution
} from './UrlProtocolGuard'
import { isLocalSystemProtocol } from './UrlProtocolGuard'

/**
 * Intercepts local system protocols (ms-search:, microsoft-edge:, ms-windows-store:, intent:)
 * before invoking page.goto() on punch card tasks or promo tiles.
 * Bypasses raw navigation, simulates brief dwell-time (1500ms), and prevents net::ERR_ABORTED.
 */
export async function interceptLocalSystemProtocol(
    url: string | undefined,
    logger?: { warn: (isMobile: boolean | 'main', title: string, msg: string) => void },
    isMobile: boolean | 'main' = false,
    dwellTimeMs: number = 1500
): Promise<boolean> {
    if (!url) return false
    if (isLocalSystemProtocol(url)) {
        if (logger) {
            logger.warn(
                isMobile,
                'PUNCHCARD',
                `[URI-GUARD] Intercepted local system protocol "${url}" prior to page.goto. Gracefully bypassing navigation.`
            )
        }
        await new Promise(resolve => setTimeout(resolve, dwellTimeMs))
        return true
    }
    return false
}
