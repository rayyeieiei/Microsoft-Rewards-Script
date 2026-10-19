import crypto from 'crypto'
import type { BrowserContextOptions } from 'patchright'
import { UserAgentManager } from '../../browser/UserAgent'
import type {
    BrowserContextKind,
    BrowserEnvironmentConfig,
    BrowserEnvironmentProfile,
    EnvironmentValidationResult,
    ScreenProfile
} from './BrowserEnvironmentTypes'

import type { StickyDeviceProfileData } from './StickyDeviceProfile'

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

    public static readonly REAL_DESKTOP_VIEWPORTS: ScreenProfile[] = [
        { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
        { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
        { viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25, isMobile: false, hasTouch: false },
        { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
        { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }
    ]

    public static getDeterministicDesktopScreen(emailOrId?: string): ScreenProfile {
        if (!emailOrId) return BrowserEnvironmentPolicy.DEFAULT_DESKTOP_SCREEN
        const hash = crypto.createHash('sha256').update(emailOrId.toLowerCase().trim()).digest('hex')
        const index = parseInt(hash.slice(0, 8), 16) % BrowserEnvironmentPolicy.REAL_DESKTOP_VIEWPORTS.length
        return BrowserEnvironmentPolicy.REAL_DESKTOP_VIEWPORTS[index] || BrowserEnvironmentPolicy.DEFAULT_DESKTOP_SCREEN
    }

    /**
     * Resolves an environment profile for the specified context kind.
     * Hardcoded/specified viewports use source: 'project-config'.
     * If screen is omitted or explicitly unforced, source is 'browser-default'.
     */
    public static resolveProfile(
        kind: BrowserContextKind,
        config?: BrowserEnvironmentConfig,
        stickyProfile?: StickyDeviceProfileData,
        accountEmail?: string
    ): BrowserEnvironmentProfile {
        const isMobile = kind === 'mobile'
        const emailKey = accountEmail || stickyProfile?.accountId
        const baseScreen = isMobile
            ? (stickyProfile?.device?.screen ?? BrowserEnvironmentPolicy.DEFAULT_MOBILE_SCREEN)
            : BrowserEnvironmentPolicy.getDeterministicDesktopScreen(emailKey)

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
                ? (stickyProfile?.device?.userAgent ?? UserAgentManager.DEFAULT_MOBILE_UA)
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

    /**
     * Resolves synchronized Chrome DevTools Protocol Client Hints metadata.
     * Prevents Sec-CH-UA-Platform: "Linux" leakage on mobile emulation sessions
     * and maintains Windows platform consistency (Win32 / Windows NT 10.0) on Desktop sessions.
     */
    public static getClientHintsMetadata(
        kind: BrowserContextKind,
        stickyProfile?: StickyDeviceProfileData
    ): {
        platform: string
        userAgent: string
        userAgentMetadata: {
            brands: Array<{ brand: string; version: string }>
            fullVersion: string
            platform: string
            platformVersion: string
            architecture: string
            model: string
            mobile: boolean
            bitness: string
            wow64: boolean
        }
    } | undefined {
        if (kind !== 'mobile') {
            return undefined
        }

        const device = stickyProfile?.device
        const model = device?.deviceModel || device?.model || 'SM-S911B'
        const platform = device?.platform || 'Android'
        const platformVersion = device?.platformVersion || '14.0.0'
        const userAgent = device?.userAgent || UserAgentManager.DEFAULT_MOBILE_UA

        const edgeVersionMatch = userAgent.match(/EdgA\/([0-9.]+)/)
        const fullVersion: string = (edgeVersionMatch && edgeVersionMatch[1]) ? edgeVersionMatch[1] : '128.0.2708.57'
        const majorVersion: string = fullVersion.split('.')[0] || '128'

        return {
            platform,
            userAgent,
            userAgentMetadata: {
                brands: [
                    { brand: 'Chromium', version: majorVersion },
                    { brand: 'Not=A?Brand', version: '24' },
                    { brand: 'Microsoft Edge', version: majorVersion }
                ],
                fullVersion,
                platform,
                platformVersion,
                architecture: '',
                model,
                mobile: true,
                bitness: '64',
                wow64: false
            }
        }
    }

    /**
     * Resolves synchronized Chrome DevTools Protocol Client Hints metadata for desktop Windows sessions.
     * Enforces platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', mobile: false.
     */
    public static getDesktopClientHintsMetadata(): {
        platform: string
        userAgent: string
        userAgentMetadata: {
            brands: Array<{ brand: string; version: string }>
            fullVersion: string
            platform: string
            platformVersion: string
            architecture: string
            model: string
            mobile: boolean
            bitness: string
            wow64: boolean
        }
    } {
        const userAgent = UserAgentManager.DEFAULT_DESKTOP_UA
        const edgeVersionMatch = userAgent.match(/Edg\/([0-9.]+)/)
        const fullVersion: string = (edgeVersionMatch && edgeVersionMatch[1]) ? edgeVersionMatch[1] : '128.0.2708.57'
        const majorVersion: string = fullVersion.split('.')[0] || '128'

        return {
            platform: 'Windows',
            userAgent,
            userAgentMetadata: {
                brands: [
                    { brand: 'Chromium', version: majorVersion },
                    { brand: 'Not=A?Brand', version: '24' },
                    { brand: 'Microsoft Edge', version: majorVersion }
                ],
                fullVersion,
                platform: 'Windows',
                platformVersion: '10.0.0',
                architecture: 'x86',
                model: '',
                mobile: false,
                bitness: '64',
                wow64: false
            }
        }
    }

    /**
     * Applies native Chrome DevTools Protocol userAgent and Client Hints overrides to a page.
     * Guarantees synchronized Sec-CH-UA-Platform: "Android" or "Windows", Sec-CH-UA-Model, and Sec-CH-UA-Mobile.
     */
    public static async applyClientHintsOverride(
        page: any,
        stickyProfileOrKind?: StickyDeviceProfileData | BrowserContextKind,
        explicitStickyProfile?: StickyDeviceProfileData
    ): Promise<void> {
        if (!page) return
        try {
            const context = typeof page.context === 'function' ? page.context() : undefined
            if (!context || typeof context.newCDPSession !== 'function') return

            const kind: BrowserContextKind =
                stickyProfileOrKind === 'desktop'
                    ? 'desktop'
                    : stickyProfileOrKind === 'mobile'
                      ? 'mobile'
                      : 'mobile'

            const stickyProfile: StickyDeviceProfileData | undefined =
                typeof stickyProfileOrKind === 'object' && stickyProfileOrKind !== null
                    ? (stickyProfileOrKind as StickyDeviceProfileData)
                    : explicitStickyProfile

            const clientHints =
                kind === 'desktop'
                    ? BrowserEnvironmentPolicy.getDesktopClientHintsMetadata()
                    : BrowserEnvironmentPolicy.getClientHintsMetadata(kind, stickyProfile)
            if (!clientHints) return

            const cdp = await context.newCDPSession(page)
            await cdp.send('Network.setUserAgentOverride', {
                userAgent: clientHints.userAgent,
                platform: clientHints.platform,
                userAgentMetadata: clientHints.userAgentMetadata
            })
            await cdp.send('Emulation.setUserAgentOverride', {
                userAgent: clientHints.userAgent,
                platform: clientHints.platform,
                userAgentMetadata: clientHints.userAgentMetadata
            }).catch(() => {})
        } catch {}
    }

    /**
     * Injects anti-fingerprint hardening scripts for desktop Windows emulation on Linux/POSIX:
     * - Guarantees navigator.platform is 'Win32'
     * - Guarantees navigator.webdriver is false
     * - Synchronizes Sec-CH-UA-Platform: "Windows" (Windows NT 10.0) via CDP override
     */
    public static async applyDesktopStealth(context: any): Promise<void> {
        if (!context) return
        if (typeof context.addInitScript === 'function') {
            await context.addInitScript(() => {
                try {
                    Object.defineProperty(navigator, 'platform', {
                        get: () => 'Win32',
                        configurable: true
                    })
                } catch {}

                try {
                    Object.defineProperty(navigator, 'webdriver', {
                        get: () => false,
                        configurable: true
                    })
                } catch {}
            }).catch(() => {})
        }

        if (typeof context.on === 'function') {
            context.on('page', async (page: any) => {
                await BrowserEnvironmentPolicy.applyClientHintsOverride(page, 'desktop')
            })
        }

        if (typeof context.pages === 'function') {
            for (const p of context.pages()) {
                await BrowserEnvironmentPolicy.applyClientHintsOverride(p, 'desktop')
            }
        }
    }

    /**
     * Injects anti-fingerprint hardening scripts for mobile emulation on Linux/POSIX:
     * - Disguises navigator.platform as 'Linux armv81'
     * - Injects mobile WebGL vendor ('Qualcomm') and renderer ('Adreno (TM) 740')
     * - Guarantees navigator.webdriver is false
     * - Synchronizes Sec-CH-UA-Platform: "Android" via CDP override
     */
    public static async applyMobileStealth(
        context: any,
        stickyProfile?: StickyDeviceProfileData
    ): Promise<void> {
        if (!context) return
        const isPixel = stickyProfile?.device?.id === 'google-pixel-7'
        const webglVendor = isPixel ? 'ARM' : 'Qualcomm'
        const webglRenderer = isPixel ? 'Mali-G710 MC10' : 'Adreno (TM) 740'

        if (typeof context.addInitScript === 'function') {
            await context.addInitScript(
                ({ vendor, renderer }: { vendor: string; renderer: string }) => {
                    try {
                        Object.defineProperty(navigator, 'platform', {
                            get: () => 'Linux armv81',
                            configurable: true
                        })
                    } catch {}

                    try {
                        Object.defineProperty(navigator, 'webdriver', {
                            get: () => false,
                            configurable: true
                        })
                    } catch {}

                    try {
                        const getParam = WebGLRenderingContext.prototype.getParameter
                        WebGLRenderingContext.prototype.getParameter = function (param: number) {
                            if (param === 37445) return vendor
                            if (param === 37446) return renderer
                            return getParam.apply(this, arguments as any)
                        }

                        if (typeof WebGL2RenderingContext !== 'undefined') {
                            const getParam2 = WebGL2RenderingContext.prototype.getParameter
                            WebGL2RenderingContext.prototype.getParameter = function (param: number) {
                                if (param === 37445) return vendor
                                if (param === 37446) return renderer
                                return getParam2.apply(this, arguments as any)
                            }
                        }
                    } catch {}
                },
                { vendor: webglVendor, renderer: webglRenderer }
            ).catch(() => {})
        }

        if (typeof context.on === 'function') {
            context.on('page', async (page: any) => {
                await BrowserEnvironmentPolicy.applyClientHintsOverride(page, stickyProfile)
            })
        }

        if (typeof context.pages === 'function') {
            for (const p of context.pages()) {
                await BrowserEnvironmentPolicy.applyClientHintsOverride(p, stickyProfile)
            }
        }
    }
}

export const REAL_DESKTOP_VIEWPORTS = BrowserEnvironmentPolicy.REAL_DESKTOP_VIEWPORTS
