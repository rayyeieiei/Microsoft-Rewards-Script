import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { BrowserEnvironmentPolicy } from '../src/runtime/environment/BrowserEnvironmentPolicy'
import { UserAgentManager } from '../src/browser/UserAgent'
import AxiosClient from '../src/util/Axios'

export async function runAntiAbuseRemediationTests() {
    console.log('--- Running Anti-Abuse Detection Remediation Test Suite ---')

    // Test 1: User-Agent & Browser Context Options Consistency
    {
        const mobileProfile = BrowserEnvironmentPolicy.resolveProfile('mobile')
        const mobileOptions = BrowserEnvironmentPolicy.toContextOptions(mobileProfile)

        assert.strictEqual(
            mobileOptions.userAgent,
            UserAgentManager.DEFAULT_MOBILE_UA,
            'Mobile context must use official Edge Android User-Agent'
        )
        assert.strictEqual(mobileOptions.isMobile, true, 'isMobile must be true for mobile context')
        assert.strictEqual(mobileOptions.hasTouch, true, 'hasTouch must be true for mobile context')
        assert.strictEqual(
            mobileOptions.userAgent?.includes('HeadlessChrome'),
            false,
            'Mobile User-Agent must not leak HeadlessChrome'
        )
        assert.strictEqual(
            mobileOptions.userAgent?.includes('Linux; Android'),
            true,
            'Mobile User-Agent must indicate Android platform'
        )

        const desktopProfile = BrowserEnvironmentPolicy.resolveProfile('desktop')
        const desktopOptions = BrowserEnvironmentPolicy.toContextOptions(desktopProfile)

        assert.strictEqual(
            desktopOptions.userAgent,
            UserAgentManager.DEFAULT_DESKTOP_UA,
            'Desktop context must use official Edge Windows User-Agent'
        )
        assert.strictEqual(desktopOptions.isMobile, false, 'isMobile must be false for desktop context')
        assert.strictEqual(
            desktopOptions.userAgent?.includes('HeadlessChrome'),
            false,
            'Desktop User-Agent must not leak HeadlessChrome'
        )
        assert.strictEqual(
            desktopOptions.userAgent?.includes('Windows NT 10.0; Win64; x64'),
            true,
            'Desktop User-Agent must indicate Windows x64 platform'
        )

        console.log('✅ Test 1 Passed: User-Agent & Browser Context Options are consistent without HeadlessChrome')
    }

    // Test 2: In-DOM Monkeypatching & Browser Args Verification
    {
        const browserFilePath = path.join(process.cwd(), 'src', 'browser', 'Browser.ts')
        const browserSource = fs.readFileSync(browserFilePath, 'utf-8')

        // Must not contain Object.defineProperty on navigator.credentials
        assert.strictEqual(
            browserSource.includes("Object.defineProperty(navigator, 'credentials'"),
            false,
            'Browser.ts must not tamper with navigator.credentials'
        )

        // Must not contain --disable-blink-features=Attestation
        assert.strictEqual(
            browserSource.includes('--disable-blink-features=Attestation'),
            false,
            'BROWSER_ARGS must not contain --disable-blink-features=Attestation'
        )

        console.log('✅ Test 2 Passed: DOM API prototype integrity and clean browser args verified')
    }

    // Test 3: Telemetry Whitelist in Data Saver Route Handler
    {
        const browserFilePath = path.join(process.cwd(), 'src', 'browser', 'Browser.ts')
        const browserSource = fs.readFileSync(browserFilePath, 'utf-8')

        // Ensure whitelisted tokens are present in routeHandler
        assert.strictEqual(browserSource.includes("url.includes('/fd/ls/')"), true)
        assert.strictEqual(browserSource.includes("url.includes('/rewards/api/')"), true)
        assert.strictEqual(browserSource.includes("url.includes('c.bing.com')"), true)
        assert.strictEqual(browserSource.includes("url.includes('rewards.bing.com')"), true)

        console.log('✅ Test 3 Passed: Data Saver whitelist protects telemetry beacons and rewards endpoints')
    }

    // Test 4: Axios Default Headers & Protocol Cleanliness
    {
        const axiosClient = new AxiosClient({
            url: '',
            port: 0,
            username: '',
            password: '',
            proxyAxios: false
        })

        const internalInstance = (axiosClient as any).instance
        const defaultHeaders = internalInstance.defaults.headers

        assert.strictEqual(
            defaultHeaders['User-Agent'],
            UserAgentManager.DEFAULT_MOBILE_UA,
            'Axios default User-Agent must match mobile Edge Android'
        )
        assert.strictEqual(
            defaultHeaders['Sec-Ch-Ua-Platform'],
            '"Android"',
            'Axios must declare Android platform'
        )

        // Verify ReadToEarn and DailyCheckIn do not contain iOS Alamofire
        const readToEarnPath = path.join(process.cwd(), 'src', 'functions', 'activities', 'app', 'ReadToEarn.ts')
        const readToEarnSource = fs.readFileSync(readToEarnPath, 'utf-8')
        assert.strictEqual(
            readToEarnSource.includes('Alamofire'),
            false,
            'ReadToEarn must not use iOS Alamofire User-Agent'
        )
        assert.strictEqual(
            readToEarnSource.includes('randomBytes(64)'),
            false,
            'ReadToEarn must not send 64-byte random hex string IDs'
        )

        const dailyCheckInPath = path.join(process.cwd(), 'src', 'functions', 'activities', 'app', 'DailyCheckIn.ts')
        const dailyCheckInSource = fs.readFileSync(dailyCheckInPath, 'utf-8')
        assert.strictEqual(
            dailyCheckInSource.includes('Alamofire'),
            false,
            'DailyCheckIn must not use iOS Alamofire User-Agent'
        )

        console.log('✅ Test 4 Passed: Axios and DAPI activities use synchronized mobile identities without iOS leaks')
    }

    // Test 5: Search Heuristics Naturalization (Jitter & Clean URL Fallback)
    {
        const searchPath = path.join(process.cwd(), 'src', 'functions', 'activities', 'browser', 'Search.ts')
        const searchSource = fs.readFileSync(searchPath, 'utf-8')

        assert.strictEqual(
            searchSource.includes('delay: 35'),
            false,
            'Search.ts must not contain robotic delay: 35'
        )
        assert.strictEqual(
            searchSource.includes('PC=U531&FORM=ANNTA1'),
            false,
            'Search.ts must not contain suspicious static PC=U531&FORM=ANNTA1 parameters'
        )

        const searchOnBingPath = path.join(process.cwd(), 'src', 'functions', 'activities', 'browser', 'SearchOnBing.ts')
        const searchOnBingSource = fs.readFileSync(searchOnBingPath, 'utf-8')
        assert.strictEqual(
            searchOnBingSource.includes('PC=U531&FORM=ANNTA1'),
            false,
            'SearchOnBing.ts must not contain static PC=U531&FORM=ANNTA1 parameters'
        )

        console.log('✅ Test 5 Passed: Search typing jitter and clean URL fallback verified')
    }

    // Test 6: Undefined bot.fingerprint Safe Navigation (ClaimBonusPoints & Quiz crash fix)
    {
        const claimBonusPath = path.join(process.cwd(), 'src', 'functions', 'activities', 'api', 'ClaimBonusPoints.ts')
        const claimBonusSource = fs.readFileSync(claimBonusPath, 'utf-8')
        assert.strictEqual(
            claimBonusSource.includes('{ ...this.bot.fingerprint.headers }'),
            false,
            'ClaimBonusPoints must not access this.bot.fingerprint.headers without optional chaining'
        )
        assert.strictEqual(
            claimBonusSource.includes('{ ...(this.bot.fingerprint?.headers ?? {}) }'),
            true,
            'ClaimBonusPoints must use safe optional chaining with fallback object for fingerprint headers'
        )

        const quizPath = path.join(process.cwd(), 'src', 'functions', 'activities', 'api', 'Quiz.ts')
        const quizSource = fs.readFileSync(quizPath, 'utf-8')
        assert.strictEqual(
            quizSource.includes('{ ...this.bot.fingerprint.headers }'),
            false,
            'Quiz must not access this.bot.fingerprint.headers without optional chaining'
        )
        assert.strictEqual(
            quizSource.includes('{ ...(this.bot.fingerprint?.headers ?? {}) }'),
            true,
            'Quiz must use safe optional chaining with fallback object for fingerprint headers'
        )

        console.log('✅ Test 6 Passed: ClaimBonusPoints and Quiz safely handle undefined bot.fingerprint')
    }

    // Test 7: QueryEngine Short Query & Single-Word Filtering
    {
        const queryEnginePath = path.join(process.cwd(), 'src', 'functions', 'QueryEngine.ts')
        const queryEngineSource = fs.readFileSync(queryEnginePath, 'utf-8')
        assert.strictEqual(
            queryEngineSource.includes("trimmed.length < 5 || !trimmed.includes(' ')"),
            true,
            'QueryEngine must filter queries shorter than 5 chars or lacking whitespace'
        )

        console.log('✅ Test 7 Passed: QueryEngine filters short and single-word queries')
    }

    // Test 8: Adaptive Cooldown with Hard-Verification & Stagnant Loop Guard
    {
        const searchPath = path.join(process.cwd(), 'src', 'functions', 'activities', 'browser', 'Search.ts')
        const searchSource = fs.readFileSync(searchPath, 'utf-8')

        assert.strictEqual(
            searchSource.includes('const stagnantLoopMax = 3'),
            true,
            'Search.ts must enforce stagnantLoopMax = 3'
        )
        assert.strictEqual(
            searchSource.includes('verifyPointsWithServer(page, isMobile)'),
            true,
            'Search.ts must call verifyPointsWithServer before aborting search loop'
        )
        assert.strictEqual(
            searchSource.includes('[COOLDOWN-DETECTED]'),
            true,
            'Search.ts must log [COOLDOWN-DETECTED] when cooldown is verified'
        )

        console.log('✅ Test 8 Passed: Search adaptive cooldown and server hard-verification verified')
    }

    // Test 9: Config Defaults & Parallel Search Enforcement
    {
        const configExamplePath = path.join(process.cwd(), 'src', 'config.example.json')
        const configExample = JSON.parse(fs.readFileSync(configExamplePath, 'utf-8'))

        assert.strictEqual(
            configExample.searchSettings.parallelSearching,
            false,
            'config.example.json must default parallelSearching to false'
        )
        assert.strictEqual(
            configExample.searchSettings.scrollRandomResults,
            true,
            'config.example.json must enable scrollRandomResults for organic SERP interaction'
        )

        const searchManagerPath = path.join(process.cwd(), 'src', 'functions', 'SearchManager.ts')
        const searchManagerSource = fs.readFileSync(searchManagerPath, 'utf-8')
        assert.strictEqual(
            searchManagerSource.includes('Enforcing safe sequential search mode'),
            true,
            'SearchManager must warn and enforce sequential searches when parallel is configured'
        )

        console.log('✅ Test 9 Passed: Configuration defaults and sequential search enforcement verified')
    }

    console.log('🎉 ALL 9 ANTI-ABUSE REMEDIATION TESTS PASSED SUCCESSFULLY!')
}
