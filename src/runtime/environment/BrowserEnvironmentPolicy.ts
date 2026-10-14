import type { BrowserContextOptions } from 'patchright'
import { UserAgentManager } from '../../browser/UserAgent'
import type {
    BrowserContextKind,
    BrowserEnvironmentConfig,
    BrowserEnvironmentProfile,
    EnvironmentValidationResult,
    ScreenProfile
} from './BrowserEnvironmentTypes'
import type { DeviceHardwareProfile } from './StickyDeviceProfile'

export class BrowserEnvironmentPolicy {
    public static readonly DEFAULT_MOBILE_SCREEN: ScreenProfile = {
        viewport: { width: 375, height: 667 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true
    }

    public static readonly DEFAULT_DESKTOP_SCREEN: ScreenProfile = {
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false
    }

    public static readonly DESKTOP_VIEWPORTS = [
        { width: 1366, height: 768 },
        { width: 1440, height: 900 },
        { width: 1536, height: 864 },
        { width: 1600, height: 900 },
        { width: 1920, height: 1080 },
        { width: 1280, height: 800 }
    ] as const

    public static readonly MOBILE_VIEWPORTS = [
        { width: 393, height: 873 },
        { width: 412, height: 915 },
        { width: 360, height: 800 },
        { width: 384, height: 854 },
        { width: 390, height: 844 },
        { width: 414, height: 896 }
    ] as const

    public static getDeterministicHash(input: string): number {
        if (!input) return 0
        let hash = 0
        const normalized = input.trim().toLowerCase()
        for (let i = 0; i < normalized.length; i++) {
            hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0
        }
        return Math.abs(hash)
    }

    public static getDeterministicDesktopScreen(accountIdentifier?: string): ScreenProfile {
        if (!accountIdentifier) return BrowserEnvironmentPolicy.DEFAULT_DESKTOP_SCREEN
        const hash = BrowserEnvironmentPolicy.getDeterministicHash(accountIdentifier)
        const vp = BrowserEnvironmentPolicy.DESKTOP_VIEWPORTS[hash % BrowserEnvironmentPolicy.DESKTOP_VIEWPORTS.length]!
        return {
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false
        }
    }

    public static getDeterministicMobileViewport(accountIdentifier?: string): { width: number; height: number } {
        if (!accountIdentifier) return { width: 393, height: 873 }
        const hash = BrowserEnvironmentPolicy.getDeterministicHash(accountIdentifier)
        const vp = BrowserEnvironmentPolicy.MOBILE_VIEWPORTS[hash % BrowserEnvironmentPolicy.MOBILE_VIEWPORTS.length]!
        return { width: vp.width, height: vp.height }
    }

    /**
     * Resolves an environment profile for the specified context kind.
     * Hardcoded/specified viewports use source: 'project-config'.
     * If screen is omitted or explicitly unforced, source is 'browser-default'.
     */
    public static resolveProfile(
        kind: BrowserContextKind,
        config?: BrowserEnvironmentConfig,
        deviceProfile?: DeviceHardwareProfile,
        accountIdentifier?: string
    ): BrowserEnvironmentProfile {
        const isMobile = kind === 'mobile'
        const baseScreen = isMobile
            ? (deviceProfile
                  ? {
                        viewport: deviceProfile.viewport,
                        deviceScaleFactor: deviceProfile.deviceScaleFactor,
                        isMobile: deviceProfile.isMobile,
                        hasTouch: deviceProfile.hasTouch
                    }
                  : (accountIdentifier
                        ? {
                              viewport: BrowserEnvironmentPolicy.getDeterministicMobileViewport(accountIdentifier),
                              deviceScaleFactor: 2.5,
                              isMobile: true,
                              hasTouch: true
                          }
                        : BrowserEnvironmentPolicy.DEFAULT_MOBILE_SCREEN))
            : (accountIdentifier
                  ? BrowserEnvironmentPolicy.getDeterministicDesktopScreen(accountIdentifier)
                  : BrowserEnvironmentPolicy.DEFAULT_DESKTOP_SCREEN)

        const overrideScreen = isMobile ? config?.mobile : config?.desktop

        const finalScreen: ScreenProfile = {
            viewport: {
                width: overrideScreen?.viewport?.width ?? baseScreen.viewport.width,
                height: overrideScreen?.viewport?.height ?? baseScreen.viewport.height
            },
            deviceScaleFactor: overrideScreen?.deviceScaleFactor ?? baseScreen.deviceScaleFactor,
            isMobile: overrideScreen?.isMobile ?? baseScreen.isMobile,
            hasTouch: overrideScreen?.hasTouch ?? baseScreen.hasTouch
        }

        const profileId = `profile_${kind}_${finalScreen.viewport.width}x${finalScreen.viewport.height}`
        const userAgent =
            config?.userAgent ??
            (isMobile
                ? (deviceProfile?.userAgent ?? UserAgentManager.DEFAULT_MOBILE_UA)
                : UserAgentManager.DEFAULT_DESKTOP_UA)

        return {
            schemaVersion: 1,
            profileId,
            source: 'project-config',
            contextKind: kind,
            screen: finalScreen,
            userAgent,
            locale: config?.locale,
            timezoneId: config?.timezoneId,
            colorScheme: config?.colorScheme ?? 'light'
        }
    }

    /**
     * Creates standard, native Playwright BrowserContextOptions from a profile.
     * Strictly enforces:
     * - ignoreHTTPSErrors: false (TLS security)
     * - NO extraHTTPHeaders containing sec-ch-ua* (Chromium generates client hints natively)
     * - Official Edge userAgent for mobile/desktop to eliminate HeadlessChrome and Win32 on mobile
     * - Native WebGL, webdriver, battery, and media devices
     */
    public static toContextOptions(profile: BrowserEnvironmentProfile): BrowserContextOptions {
        const options: BrowserContextOptions = {
            ignoreHTTPSErrors: false,
            permissions: []
        }

        options.userAgent =
            profile.userAgent ??
            (profile.contextKind === 'mobile'
                ? UserAgentManager.DEFAULT_MOBILE_UA
                : UserAgentManager.DEFAULT_DESKTOP_UA)

        if (profile.screen) {
            options.viewport = profile.screen.viewport
            options.deviceScaleFactor = profile.screen.deviceScaleFactor
            options.isMobile = profile.screen.isMobile
            options.hasTouch = profile.screen.hasTouch
        }

        if (profile.locale) {
            options.locale = profile.locale
        }

        if (profile.timezoneId) {
            options.timezoneId = profile.timezoneId
        }

        if (profile.colorScheme) {
            options.colorScheme = profile.colorScheme
        }

        return options
    }

    /**
     * Validates a profile against schema contracts.
     */
    public static validateProfile(profile: BrowserEnvironmentProfile): EnvironmentValidationResult {
        const errors: string[] = []
        const warnings: string[] = []

        if (profile.schemaVersion !== 1) {
            errors.push(`Invalid schemaVersion: expected 1, got ${profile.schemaVersion}`)
        }

        if (profile.contextKind !== 'mobile' && profile.contextKind !== 'desktop') {
            errors.push(`Invalid contextKind: ${profile.contextKind}`)
        }

        if (profile.source !== 'browser-default' && profile.source !== 'project-config') {
            errors.push(`Invalid source: ${profile.source}`)
        }

        if (profile.screen) {
            if (profile.screen.viewport.width <= 0 || profile.screen.viewport.height <= 0) {
                errors.push('Viewport dimensions must be positive integers')
            }
            if (profile.source === 'browser-default') {
                warnings.push("Profile with specified screen should ideally use source: 'project-config'")
            }
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings
        }
    }
}
