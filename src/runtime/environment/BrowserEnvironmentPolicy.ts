import type { BrowserContextOptions } from 'patchright'
import type {
    BrowserContextKind,
    BrowserEnvironmentConfig,
    BrowserEnvironmentProfile,
    EnvironmentValidationResult,
    ScreenProfile
} from './BrowserEnvironmentTypes'

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

    /**
     * Resolves an environment profile for the specified context kind.
     * Hardcoded/specified viewports use source: 'project-config'.
     * If screen is omitted or explicitly unforced, source is 'browser-default'.
     */
    public static resolveProfile(
        kind: BrowserContextKind,
        config?: BrowserEnvironmentConfig
    ): BrowserEnvironmentProfile {
        const isMobile = kind === 'mobile'
        const baseScreen = isMobile
            ? BrowserEnvironmentPolicy.DEFAULT_MOBILE_SCREEN
            : BrowserEnvironmentPolicy.DEFAULT_DESKTOP_SCREEN

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

        return {
            schemaVersion: 1,
            profileId,
            source: 'project-config',
            contextKind: kind,
            screen: finalScreen,
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
     * - Native WebGL, webdriver, battery, and media devices
     */
    public static toContextOptions(profile: BrowserEnvironmentProfile): BrowserContextOptions {
        const options: BrowserContextOptions = {
            ignoreHTTPSErrors: false,
            permissions: []
        }

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
