import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export interface DeviceHardwareProfile {
    deviceModel: string
    viewport: { width: number; height: number }
    deviceScaleFactor: number
    isMobile: boolean
    hasTouch: boolean
    userAgent: string
}

export const REAL_ANDROID_DEVICE_CATALOG: readonly DeviceHardwareProfile[] = [
    {
        deviceModel: 'SM-S911B', // Samsung Galaxy S23
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2.625,
        isMobile: true,
        hasTouch: true,
        userAgent:
            'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2739.79'
    },
    {
        deviceModel: 'Pixel 7', // Google Pixel 7
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3.0,
        isMobile: true,
        hasTouch: true,
        userAgent:
            'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2739.79'
    },
    {
        deviceModel: '22101316G', // Xiaomi Redmi Note 12
        viewport: { width: 393, height: 873 },
        deviceScaleFactor: 2.75,
        isMobile: true,
        hasTouch: true,
        userAgent:
            'Mozilla/5.0 (Linux; Android 14; 22101316G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2739.79'
    },
    {
        deviceModel: 'SM-A546B', // Samsung Galaxy A54
        viewport: { width: 360, height: 800 },
        deviceScaleFactor: 2.0,
        isMobile: true,
        hasTouch: true,
        userAgent:
            'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2739.79'
    },
    {
        deviceModel: 'CPH2449', // OnePlus 11
        viewport: { width: 384, height: 854 },
        deviceScaleFactor: 2.8125,
        isMobile: true,
        hasTouch: true,
        userAgent:
            'Mozilla/5.0 (Linux; Android 14; CPH2449) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2739.79'
    }
]

export class StickyDeviceProfile {
    /**
     * Resolves a deterministic, sticky 1:1 hardware profile for an account.
     * Persists profile to disk alongside storageState so the account maintains
     * identical viewport, model, and UA across all subsequent sessions.
     */
    public static resolve(accountId: string, sessionDir?: string): DeviceHardwareProfile {
        const storageKey = crypto
            .createHash('sha256')
            .update(accountId)
            .digest('hex')
            .slice(0, 32)

        const targetDir = sessionDir || path.join(process.cwd(), 'browser', 'sessions')
        const profilePath = path.join(targetDir, `${storageKey}.deviceProfile.json`)

        if (fs.existsSync(profilePath)) {
            try {
                const content = fs.readFileSync(profilePath, 'utf-8')
                const parsed = JSON.parse(content) as DeviceHardwareProfile
                if (parsed.deviceModel && parsed.viewport && parsed.userAgent) {
                    return parsed
                }
            } catch {}
        }

        // Deterministic catalog selection from accountId hash
        const hashNum = parseInt(storageKey.slice(0, 8), 16)
        const catalogIndex = hashNum % REAL_ANDROID_DEVICE_CATALOG.length
        const selected = REAL_ANDROID_DEVICE_CATALOG[catalogIndex]!

        // Persist sticky profile to disk
        try {
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true })
            }
            fs.writeFileSync(profilePath, JSON.stringify(selected, null, 2), 'utf-8')
        } catch {}

        return selected
    }
}
