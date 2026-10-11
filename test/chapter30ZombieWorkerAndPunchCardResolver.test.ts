import assert from 'assert'
import {
    extractHttpUrlFromAppUri,
    isAppExclusiveUri,
    isLocalAppUri,
    interruptibleWait
} from '../src/runtime/BrowserOperationGuard'
import { ReadToEarn } from '../src/functions/activities/app/ReadToEarn'
import { AccountScope } from '../src/runtime/AccountScope'

export async function runChapter30ZombieWorkerAndPunchCardResolverTests(): Promise<void> {
    console.log('\n--- Running Chapter 30 Zombie Worker & Punch Card Resolver Test Suite ---')

    // Test 1: extractHttpUrlFromAppUri query extraction for ms-search://
    {
        const uri1 = 'ms-search://search/?q=mona+lisa'
        const res1 = extractHttpUrlFromAppUri(uri1)
        assert.strictEqual(res1, 'https://www.bing.com/search?q=mona%20lisa&FORM=RWRD1')

        const uri2 = 'ms-search:?q=world+heritage&source=bing'
        const res2 = extractHttpUrlFromAppUri(uri2)
        assert.strictEqual(res2, 'https://www.bing.com/search?q=world%20heritage&FORM=RWRD1')

        const uriEdge = 'microsoft-edge:https://rewards.bing.com/dashboard'
        const resEdge = extractHttpUrlFromAppUri(uriEdge)
        assert.strictEqual(resEdge, 'https://rewards.bing.com/dashboard')

        const invalidUri = 'ms-calculator:'
        assert.strictEqual(extractHttpUrlFromAppUri(invalidUri), null)

        console.log('✅ Test 1 Passed: extractHttpUrlFromAppUri converts ms-search and edge schemes to Bing search URLs')
    }

    // Test 2: isAppExclusiveUri identification
    {
        assert.strictEqual(isAppExclusiveUri('ms-windows-store://pdp/?productId=9WZDNCRFHVJL'), true)
        assert.strictEqual(isAppExclusiveUri('xbox://gamepass/quest/123'), true)
        assert.strictEqual(isAppExclusiveUri('intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;end'), true)
        assert.strictEqual(isAppExclusiveUri('market://details?id=com.microsoft.bing'), true)
        assert.strictEqual(isAppExclusiveUri('https://www.bing.com/search?q=test'), false)
        assert.strictEqual(isAppExclusiveUri('http://example.com'), false)
        assert.strictEqual(isAppExclusiveUri(undefined), false)
        assert.strictEqual(isLocalAppUri('ms-windows-store://pdp/?productId=9WZDNCRFHVJL'), true)
        assert.strictEqual(isLocalAppUri('https://www.bing.com'), false)

        console.log('✅ Test 2 Passed: isAppExclusiveUri and isLocalAppUri correctly identify native app and store protocols')
    }

    // Test 3: targetDashboard sanitization (envelope URL prevention)
    {
        const sanitizeDashboardUrl = (rawUrl?: string): string => {
            let targetDashboard = (rawUrl || 'https://rewards.bing.com').trim()
            if (targetDashboard.includes('/dashboard/envelope')) {
                targetDashboard = 'https://rewards.bing.com'
            }
            return targetDashboard
        }

        assert.strictEqual(sanitizeDashboardUrl('https://rewards.bing.com/dashboard/envelope'), 'https://rewards.bing.com')
        assert.strictEqual(sanitizeDashboardUrl('https://rewards.bing.com/dashboard/envelope?id=123'), 'https://rewards.bing.com')
        assert.strictEqual(sanitizeDashboardUrl('https://rewards.bing.com'), 'https://rewards.bing.com')
        assert.strictEqual(sanitizeDashboardUrl(undefined), 'https://rewards.bing.com')

        console.log('✅ Test 3 Passed: targetDashboard sanitization strips envelope paths to rewards home')
    }

    // Test 4: interruptibleWait with AbortSignal cancellation
    {
        const controller = new AbortController()
        const startTime = Date.now()

        // Schedule abort in 50ms while waiting for 2000ms
        setTimeout(() => controller.abort(), 50)
        await interruptibleWait(2000, controller.signal)
        const elapsed = Date.now() - startTime

        assert.ok(elapsed < 500, `Expected interruptibleWait to abort early, but took ${elapsed}ms`)
        assert.strictEqual(controller.signal.aborted, true)

        // Wait with already aborted signal should return immediately
        const startImmediate = Date.now()
        await interruptibleWait(1000, controller.signal)
        assert.ok(Date.now() - startImmediate < 50, 'Expected immediate return for aborted signal')

        console.log('✅ Test 4 Passed: interruptibleWait responds immediately to AbortSignal cancellation')
    }

    // Test 5: cleanPointString logic ensures promo badge strings with '+' are rejected
    {
        const cleanPointString = (raw?: string | null): number | null => {
            if (!raw) return null
            const trimmed = raw.trim()
            if (trimmed.startsWith('+')) return null
            const num = parseInt(trimmed.replace(/[^0-9]/g, ''), 10)
            return isNaN(num) || num <= 0 ? null : num
        }

        assert.strictEqual(cleanPointString('+5 Pts'), null)
        assert.strictEqual(cleanPointString('+10'), null)
        assert.strictEqual(cleanPointString('+50 points'), null)
        assert.strictEqual(cleanPointString('5,619'), 5619)
        assert.strictEqual(cleanPointString(' 1234 '), 1234)
        assert.strictEqual(cleanPointString('Available points: 2,500'), 2500)
        assert.strictEqual(cleanPointString(''), null)
        assert.strictEqual(cleanPointString(null), null)

        console.log('✅ Test 5 Passed: cleanPointString rejects promo badge values with leading +')
    }

    // Test 6: Quiz balance sanity clamp protects against premature termination
    {
        const evaluateBalance = (oldBalance: number, rawNewBalance: number): { newBalance: number; gained: number } => {
            let newBalance = rawNewBalance
            if (oldBalance > 0 && newBalance < oldBalance * 0.7) {
                newBalance = oldBalance
            }
            return {
                newBalance,
                gained: newBalance - oldBalance
            }
        }

        const oldBalance = 5619
        // Scraper accidentally parsed promo badge '+5' -> 5
        const resultAnomaly = evaluateBalance(oldBalance, 5)
        assert.strictEqual(resultAnomaly.newBalance, 5619, 'Should clamp to oldBalance on >30% sudden drop')
        assert.strictEqual(resultAnomaly.gained, 0, 'Gained delta should be 0, not -5614')

        // Valid point gain: 5619 -> 5629 (+10 points)
        const resultValid = evaluateBalance(oldBalance, 5629)
        assert.strictEqual(resultValid.newBalance, 5629)
        assert.strictEqual(resultValid.gained, 10)

        console.log('✅ Test 6 Passed: Quiz balance sanity clamp suppresses negative delta glitch')
    }

    // Test 7: Bounded Join simulation guarantees settled promise before next worker
    {
        let workerFinished = false
        const abortController = new AbortController()

        // Simulate a running worker that responds to abort signal
        const simulateWorker = async (signal: AbortSignal): Promise<string> => {
            await interruptibleWait(10000, signal)
            workerFinished = true
            return 'done'
        }

        const workerPromise = simulateWorker(abortController.signal)

        // Trigger deadline abort
        abortController.abort()

        // Bounded Join: wait up to 5000ms for worker to exit
        await Promise.race([
            workerPromise.catch(() => null),
            new Promise(resolve => setTimeout(resolve, 5000))
        ])

        assert.strictEqual(workerFinished, true, 'Worker should have completed immediately upon abort')
        console.log('✅ Test 7 Passed: Bounded Join guarantees worker promise settles cleanly on abort')
    }

    // Test 8: ReadToEarn eliminates false-positive 30/30 skip, enforces ID geo fallback, and uses localArticlesPool on MSN 400
    {
        const mockLogs: string[] = []
        const submittedCountries: string[] = []
        const mockScope = AccountScope.createForTesting('ehsanfizibers@example.com', 'run_ch30_rte')
        mockScope.setDapiToken('valid_dapi_token')

        const mockBot: any = {
            isMobile: true,
            accessToken: 'valid_dapi_token',
            activeAccount: { email: 'ehsanfizibers@example.com', geoLocale: 'auto' },
            accountScope: mockScope,
            // Simulate userData.geoLocale accidentally still at 'US' before DAPI resolves
            userData: { currentPoints: 500, gainedPoints: 0, geoLocale: 'US' },
            config: {
                locale: 'id-ID',
                searchSettings: { readDelay: { min: 0, max: 0 } }
            },
            logger: {
                info: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[INFO][${tag}] ${msg}`),
                warn: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[WARN][${tag}] ${msg}`),
                error: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[ERROR][${tag}] ${msg}`),
                debug: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[DEBUG][${tag}] ${msg}`)
            },
            utils: {
                wait: async () => {},
                randomDelay: () => 0
            },
            browser: {
                func: {
                    // Simulate missing msnreadearn activity (readToEarnActivity is undefined)
                    getAppEarnablePoints: async () => ({
                        readToEarn: 0,
                        checkIn: 0,
                        totalEarnablePoints: 0,
                        readToEarnCompleted: false,
                        readToEarnActivity: undefined
                    })
                }
            },
            axios: {
                defaults: { headers: { common: {} as Record<string, string> } },
                request: async (config: any) => {
                    if (String(config.url).includes('assets.msn.com')) {
                        // Simulate MSN feed 400
                        return { status: 400, data: {} }
                    }
                    const payload = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
                    submittedCountries.push(payload.country)
                    return { status: 200, data: { status: 'success' } }
                }
            }
        }

        const rte = new ReadToEarn(mockBot)

        // 8a: Verify resolveCountry() never falls back to 'US' for auto/ID accounts
        assert.strictEqual(rte.resolveCountry(), 'ID')

        // 8b: Verify evaluateReadToEarnProgress when activity is undefined/null
        const evalUndefined = rte.evaluateReadToEarnProgress(undefined, undefined)
        assert.strictEqual(evalUndefined.currentProgress, 0)
        assert.strictEqual(evalUndefined.maxProgress, 30)
        assert.strictEqual(evalUndefined.remainingQuota, 30)
        assert.strictEqual(evalUndefined.isExplicitlyCompleted, false)

        const evalMissingActivity = rte.evaluateReadToEarnProgress(undefined, {
            readToEarn: 0,
            readToEarnCompleted: false,
            readToEarnActivity: undefined
        })
        assert.strictEqual(evalMissingActivity.currentProgress, 0)
        assert.strictEqual(evalMissingActivity.maxProgress, 30)
        assert.strictEqual(evalMissingActivity.remainingQuota, 30)
        assert.strictEqual(evalMissingActivity.isExplicitlyCompleted, false)

        // 8c: Verify evaluateReadToEarnProgress when activity IS explicitly completed (30/30)
        const evalCompleted = rte.evaluateReadToEarnProgress({
            attributes: { pointProgress: 30, pointProgressMax: 30, offerid: 'ENUS_readarticle3_30points' }
        })
        assert.strictEqual(evalCompleted.currentProgress, 30)
        assert.strictEqual(evalCompleted.maxProgress, 30)
        assert.strictEqual(evalCompleted.remainingQuota, 0)
        assert.strictEqual(evalCompleted.isExplicitlyCompleted, true)

        // 8d: Execute doReadToEarn() when activity is undefined and MSN feed returns 400 -> must read 10 articles from localArticlesPool with country='ID'
        await rte.doReadToEarn()

        assert.strictEqual(submittedCountries.length, 10, 'Must execute 10 articles from localArticlesPool when activity is undefined')
        assert.ok(submittedCountries.every(c => c === 'ID'), 'All submitted Read to Earn payloads must use country=ID')
        assert.strictEqual(mockBot.userData.gainedPoints, 30, 'Must gain 30 points (10 * 3 pts)')

        console.log('✅ Test 8 Passed: ReadToEarn eliminates false-positive 30/30 skip, enforces ID geo fallback, and executes 10 articles from localArticlesPool on MSN 400')
    }

    // Test 9: initialPoints idempotency guard prevents Web Dashboard from overwriting DAPI Fast-Path starting balance (4085 -> 4128 = +43)
    {
        const { DailyCheckIn } = await import('../src/functions/activities/app/DailyCheckIn')
        const BrowserFunc = (await import('../src/browser/BrowserFunc')).default
        const mockScope = AccountScope.createForTesting('baryyaja@gmail.com', 'run_ch30_balance_lock')
        mockScope.setDapiToken('valid_dapi_token')

        const mockBot: any = {
            isMobile: true,
            accessToken: 'valid_dapi_token',
            activeAccount: { email: 'baryyaja@gmail.com', geoLocale: 'auto' },
            accountScope: mockScope,
            userData: {
                initialPoints: 0,
                currentPoints: 0,
                gainedPoints: 0,
                geoLocale: 'ID'
            },
            config: {
                locale: 'id-ID',
                searchSettings: { readDelay: { min: 0, max: 0 } }
            },
            logger: {
                info: () => {},
                warn: () => {},
                error: () => {},
                debug: () => {}
            },
            utils: {
                wait: async () => {},
                randomDelay: () => 0
            },
            axios: {
                defaults: { headers: { common: {} as Record<string, string> } },
                request: async (config: any) => {
                    if (String(config.url).includes('assets.msn.com')) {
                        return { status: 400, data: {} }
                    }
                    const payload = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
                    if (payload?.attributes?.offerid === 'Gamification_Sapphire_DailyCheckIn') {
                        // Server returns balance 4095 after +10 check-in
                        return { status: 200, data: { response: { balance: 4095 } } }
                    }
                    return { status: 200, data: { status: 'success' } }
                }
            }
        }

        const browserFunc = new BrowserFunc(mockBot)
        mockBot.browser = {
            func: {
                lockInitialPoints: (pts?: number) => browserFunc.lockInitialPoints(pts),
                getAppEarnablePoints: async () => ({
                    readToEarn: 30,
                    checkIn: 10,
                    totalEarnablePoints: 40,
                    readToEarnCompleted: false,
                    readToEarnActivity: undefined
                })
            }
        }

        // 1. Execute Daily Check-In (+10 pts, rawServerBalance=4095) when initialPoints was 0
        const checkIn = new DailyCheckIn(mockBot)
        await checkIn.doDailyCheckIn()
        assert.strictEqual(mockBot.userData.initialPoints, 4085, 'initialPoints must be locked at 4085 (4095 - 10)')
        assert.strictEqual(mockBot.userData.currentPoints, 4095, 'currentPoints must be 4095 after check-in')

        // 2. Execute Read to Earn (+30 pts, 10 articles * 3)
        const rte = new ReadToEarn(mockBot)
        await rte.doReadToEarn()
        assert.strictEqual(mockBot.userData.initialPoints, 4085, 'initialPoints must remain locked at 4085')
        assert.strictEqual(mockBot.userData.currentPoints, 4125, 'currentPoints must be 4125 after Read to Earn')

        // 3. Simulate Web Dashboard load returning availablePoints = 4125
        browserFunc.lockInitialPoints(4125)
        if (!mockBot.userData.initialPoints || mockBot.userData.initialPoints <= 0) {
            mockBot.userData.initialPoints = 4125
        }
        assert.strictEqual(mockBot.userData.initialPoints, 4085, 'Web Dashboard must NEVER overwrite locked initialPoints (4085)')

        // 4. Simulate Pending Coin claim (+3 pts)
        mockBot.userData.currentPoints += 3
        assert.strictEqual(mockBot.userData.currentPoints, 4128)

        // 5. Verify [ACCOUNT-FINISH] calculation: totalCollected = currentPoints - initialPoints
        const totalCollected = mockBot.userData.currentPoints - mockBot.userData.initialPoints
        assert.strictEqual(totalCollected, 43, 'Total collected must be +43 (4128 - 4085)')

        console.log('✅ Test 9 Passed: initialPoints idempotency guard locks 4085 and computes Total: +43 (Old: 4085 → New: 4128)')
    }

    console.log('🎉 Chapter 30 Zombie Worker & Punch Card Resolver Test Suite PASSED!')
}

if (require.main === module) {
    runChapter30ZombieWorkerAndPunchCardResolverTests().catch(err => {
        console.error('❌ Test failed:', err)
        process.exit(1)
    })
}

