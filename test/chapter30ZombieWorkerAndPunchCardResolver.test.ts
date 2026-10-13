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

    // Test 10: Isolated userData & detached logger context prevent state bleed on deadline timeout (miliani -> fynley)
    {
        const { createIsolatedUserData, executionContext } = await import('../src/index')
        const milianiScope = AccountScope.createForTesting('miliani@gmail.com', 'run_miliani')
        const fynleyScope = AccountScope.createForTesting('fynley@gmail.com', 'run_fynley')
        const milianiUserData = createIsolatedUserData('miliani')
        const fynleyUserData = createIsolatedUserData('fynley')

        milianiUserData.initialPoints = 3519
        milianiUserData.currentPoints = 3699

        // Simulate deadline timeout on miliani
        milianiScope.dispose()

        // Simulate late async callback inside miliani's executionContext attempting to mutate userData after fynley started
        await executionContext.run(
            {
                isMobile: false,
                account: { email: 'miliani@gmail.com' } as any,
                scope: milianiScope,
                userData: milianiUserData
            },
            async () => {
                const store = executionContext.getStore()
                assert.strictEqual(store?.userData, milianiUserData)
                assert.notStrictEqual(store?.userData, fynleyUserData)
                // Even if a late operation mutates its bound userData, fynleyUserData remains untouched
                store!.userData!.initialPoints = 3519
            }
        )

        // Meanwhile fynley runs in its own isolated executionContext
        await executionContext.run(
            {
                isMobile: true,
                account: { email: 'fynley@gmail.com' } as any,
                scope: fynleyScope,
                userData: fynleyUserData
            },
            async () => {
                const store = executionContext.getStore()
                assert.strictEqual(store?.userData?.initialPoints, 0, 'fynley initialPoints must start clean at 0, not 3519')
                store!.userData!.initialPoints = 4722
                store!.userData!.currentPoints = 4912
            }
        )

        assert.strictEqual(fynleyUserData.initialPoints, 4722)
        assert.strictEqual(fynleyUserData.currentPoints - fynleyUserData.initialPoints, 190)
        console.log('✅ Test 10 Passed: Isolated userData & executionContext prevent deadline timeout state bleed across accounts')
    }

    // Test 11: Fast-Bailout for HTTP 404 Punch Card URLs (no retry attempt 2/2, no safe-scroll, no server-verification)
    {
        const { UrlReward } = await import('../src/functions/activities/api/UrlReward')
        const { Workers } = await import('../src/functions/Workers')
        const warnLogs: string[] = []
        let safeScrollCalled = false
        let serverVerificationCalled = false

        const mockBot: any = {
            isMobile: true,
            requestToken: 'csrf_token',
            userData: { currentPoints: 1000, gainedPoints: 0, timezoneOffset: '60' },
            cookies: { mobile: [], desktop: [] },
            logger: {
                info: () => {},
                warn: (_m: any, tag: string, msg: string) => warnLogs.push(`[${tag}] ${msg}`),
                error: () => {},
                debug: () => {}
            },
            utils: {
                wait: async () => {},
                randomDelay: () => 0
            },
            browser: {
                func: {
                    getCurrentPoints: async () => {
                        serverVerificationCalled = true
                        return 1000
                    }
                }
            }
        }

        const fakeTab: any = {
            isClosed: () => false,
            url: () => 'https://www.bing.com/spotlight/costumeseason',
            on: () => {},
            off: () => {},
            mainFrame: () => ({}),
            goto: async () => ({
                status: () => 404
            }),
            evaluate: async () => {
                safeScrollCalled = true
                return false
            },
            close: async () => {}
        }

        const fakePage: any = {
            isClosed: () => false,
            url: () => 'https://rewards.bing.com/dashboard',
            locator: () => ({
                first: () => ({
                    isVisible: async () => false
                })
            }),
            context: () => ({
                newPage: async () => fakeTab,
                pages: () => [fakePage],
                cookies: async () => []
            })
        }

        const urlReward = new UrlReward(mockBot)
        const stepPromo: any = {
            offerId: 'ENID_PunchCard_Costume_Step1',
            title: 'Costume season is here',
            destinationUrl: 'https://www.bing.com/spotlight/costumeseason',
            pointProgressMax: 10,
            promotionType: 'urlreward'
        }
        const punchCard: any = {
            parentPromotion: {
                offerId: 'ENID_PunchCard_Costume_Parent',
                title: 'Costume Punch Card',
                pointProgressMax: 50,
                complete: false
            },
            childPromotions: [stepPromo]
        }

        const res = await urlReward.doUrlReward(stepPromo, fakePage, punchCard)
        assert.deepStrictEqual(res, { abortedBy404: true })
        assert.strictEqual(safeScrollCalled, false, 'Must NOT run safe-scroll on HTTP 404')
        assert.strictEqual(serverVerificationCalled, false, 'Must NOT run server-verification on HTTP 404')
        assert.ok(
            warnLogs.some(l =>
                l.includes('⚠️ [PUNCHCARD-GUARD] Langkah "Costume season is here" mengembalikan HTTP 404. Melakukan fast-bailout seketika.')
            ),
            'Must log exact PUNCHCARD-GUARD HTTP 404 fast-bailout warning'
        )

        // Verify Workers.executePunchCardStepViaEnvelope propagates abortedBy404
        mockBot.activities = {
            doUrlReward: async (promo: any, pg: any, pc: any) => urlReward.doUrlReward(promo, pg, pc)
        }
        const workers = new Workers(mockBot)
        const envRes = await workers.executePunchCardStepViaEnvelope(
            {
                context: fakePage.context,
                url: fakePage.url,
                locator: fakePage.locator,
                isClosed: fakePage.isClosed
            } as any,
            'ENID_PunchCard_Costume_Parent',
            stepPromo,
            punchCard,
            1
        )
        assert.strictEqual(envRes.abortedBy404, true)
        assert.strictEqual(envRes.verified, false)

        console.log('✅ Test 11 Passed: HTTP 404 Punch Card steps perform immediate fast-bailout without safe-scroll, server-verification, or retry')
    }

    // Test 12: Strict Search Point Delta Clamping prevents +87 counter jump from terminating search loop early
    {
        const { clampSearchPointDelta } = await import('../src/functions/activities/browser/Search')

        // Case A: Counter suddenly drops from 87 missing to 0 missing in a single query (+87 jump)
        const jumpDown = clampSearchPointDelta(87, 0, 3)
        assert.strictEqual(jumpDown.wasClamped, true)
        assert.strictEqual(jumpDown.gainedPoints, 3, 'Must clamp gainedPoints to +3 per query')
        assert.strictEqual(jumpDown.remaining, 84, 'Remaining must decrease by 3 (87 -> 84), never 87 -> 0')

        // Case B: Counter jumps upward from 60 missing to 90 missing mid-loop
        const jumpUp = clampSearchPointDelta(60, 90, 3)
        assert.strictEqual(jumpUp.wasClamped, true)
        assert.strictEqual(jumpUp.gainedPoints, 3)
        assert.strictEqual(jumpUp.remaining, 57)

        // Case C: Normal +3 gain (87 -> 84)
        const normalGain = clampSearchPointDelta(87, 84, 3)
        assert.strictEqual(normalGain.wasClamped, false)
        assert.strictEqual(normalGain.gainedPoints, 3)
        assert.strictEqual(normalGain.remaining, 84)

        // Case D: Stagnant query +0 gain (84 -> 84)
        const stagnant = clampSearchPointDelta(84, 84, 3)
        assert.strictEqual(stagnant.wasClamped, false)
        assert.strictEqual(stagnant.gainedPoints, 0)
        assert.strictEqual(stagnant.remaining, 84)

        console.log('✅ Test 12 Passed: clampSearchPointDelta strictly clamps anomalous +87 counter jumps to +3 per query')
    }

    // Test 13: Multi-source CSRF token extraction from context.cookies() & header/body forwarding in ClaimBonusPoints
    {
        const { ClaimBonusPoints } = await import('../src/functions/activities/api/ClaimBonusPoints')
        let capturedRequest: any = null

        const mockBot: any = {
            isMobile: true,
            requestToken: '',
            userData: {
                currentPoints: 2000,
                gainedPoints: 0,
                geoLocale: 'ID',
                timezoneOffset: '420'
            },
            cookies: { mobile: [], desktop: [] },
            fingerprint: { headers: { 'User-Agent': 'MockMobileUA' } },
            mainMobilePage: {
                isClosed: () => false,
                context: () => ({
                    cookies: async () => [
                        { name: '__RequestVerificationToken', value: 'cookie_csrf_token_xyz123', domain: 'rewards.bing.com' }
                    ]
                })
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
            browser: {
                func: {
                    buildCookieHeader: () => '__RequestVerificationToken=cookie_csrf_token_xyz123',
                    getCurrentPoints: async () => 2015
                }
            },
            axios: {
                request: async (req: any) => {
                    capturedRequest = req
                    return { status: 200, data: {} }
                }
            }
        }

        const claimer = new ClaimBonusPoints(mockBot)
        await claimer.claimBonusPoints()

        assert.strictEqual(mockBot.requestToken, 'cookie_csrf_token_xyz123', 'Should extract CSRF token from context.cookies()')
        assert.ok(capturedRequest, 'Should send claimallpointsasync request')
        assert.strictEqual(
            capturedRequest.headers['__RequestVerificationToken'],
            'cookie_csrf_token_xyz123',
            'Should forward __RequestVerificationToken in request headers'
        )
        assert.strictEqual(
            capturedRequest.data.get('__RequestVerificationToken'),
            'cookie_csrf_token_xyz123',
            'Should forward __RequestVerificationToken in form body'
        )
        assert.strictEqual(mockBot.userData.currentPoints, 2015)

        console.log('✅ Test 13 Passed: Multi-source CSRF token extracted from context.cookies() and forwarded in headers & body')
    }

    // Test 14: Post-Read-to-Earn getDashboardData fast return (morePromotions <= 10), getBrowserEarnablePoints preloadedData, and Punch Card single-pass delegation
    {
        const BrowserFunc = (await import('../src/browser/BrowserFunc')).default
        const { Workers } = await import('../src/functions/Workers')
        let axiosCalled = 0

        const mockDashboard: any = {
            userStatus: {
                availablePoints: 4125,
                counters: {
                    pcSearch: [{ pointProgress: 30, pointProgressMax: 90 }],
                    mobileSearch: [{ pointProgress: 0, pointProgressMax: 60 }]
                }
            },
            dailySetPromotions: {
                '01/01/2026': [{ pointProgress: 0, pointProgressMax: 30 }]
            },
            morePromotions: [
                { promotionType: 'urlreward', pointProgress: 0, pointProgressMax: 10, exclusiveLockedFeatureStatus: 'unlocked' },
                { promotionType: 'urlreward', pointProgress: 0, pointProgressMax: 10, exclusiveLockedFeatureStatus: 'unlocked' }
            ],
            punchCards: []
        }

        const mockBot: any = {
            isMobile: true,
            userData: { initialPoints: 4085, currentPoints: 4125, gainedPoints: 40 },
            cookies: { mobile: [], desktop: [] },
            config: { baseURL: 'https://rewards.bing.com', punchCardExecution: { mode: 'auto', maxChildrenPerRun: 8, stepDelayMs: 10 } },
            mainMobilePage: {
                isClosed: () => false,
                url: () => 'https://rewards.bing.com/',
                context: () => ({ cookies: async () => [] }),
                waitForSelector: async () => {},
                evaluate: async () => mockDashboard
            },
            logger: {
                info: () => {},
                warn: () => {},
                error: () => {},
                debug: () => {}
            },
            utils: {
                wait: async () => {},
                getFormattedDate: () => '01/01/2026'
            },
            axios: {
                request: async () => {
                    axiosCalled++
                    throw new Error('Axios should not be called when inPageData is valid')
                }
            }
        }

        const bf = new BrowserFunc(mockBot)
        const dashData = await bf.getDashboardData()
        assert.strictEqual(axiosCalled, 0, 'getDashboardData must return inPageData immediately even when morePromotions.length <= 10 without falling back to Axios')
        assert.strictEqual(dashData.userStatus.availablePoints, 4125)

        // Verify getBrowserEarnablePoints uses preloadedData without calling getDashboardData again
        let getDashboardDataCalls = 0
        bf.getDashboardData = async () => {
            getDashboardDataCalls++
            return mockDashboard
        }
        const earnable = await bf.getBrowserEarnablePoints(dashData)
        assert.strictEqual(getDashboardDataCalls, 0, 'getBrowserEarnablePoints(preloadedData) must not call getDashboardData()')
        assert.strictEqual(earnable.desktopSearchPoints, 60)
        assert.strictEqual(earnable.mobileSearchPoints, 60)
        assert.strictEqual(earnable.dailySetPoints, 30)
        assert.strictEqual(earnable.morePromotionsPoints, 20)

        // Verify Punch Card envelope step delegated to doUrlReward does NOT re-click or repeat in attempt 2/2
        let urlRewardCalls = 0
        let snapshotCalls = 0
        const mockEnvelopePage: any = {
            url: () => 'https://rewards.bing.com/dashboard/envelope?id=pc_parent_1',
            goto: async () => {},
            locator: () => ({
                count: async () => 1,
                nth: () => ({
                    isVisible: async () => true,
                    click: async () => {},
                    evaluate: async () => {}
                })
            }),
            context: () => ({
                waitForEvent: async () => null // no popup tab -> falls back to doUrlReward
            }),
            reload: async () => {},
            evaluate: async () => ({ hasCheckmark: false, completedCount: 0 })
        }

        const mockWorkers = new Workers({
            ...mockBot,
            activities: {
                doUrlReward: async () => {
                    urlRewardCalls++
                    return { abortedBy404: false }
                }
            }
        })

        const testCard: any = {
            name: 'Test Card',
            parentPromotion: { offerId: 'pc_parent_1', title: 'Test Card', complete: false },
            childPromotions: [
                { offerId: 'child_1', title: 'Delegated Step', destinationUrl: 'https://www.bing.com/search?q=test', complete: false }
            ]
        }

        await mockWorkers.doPunchCards(
            { punchCards: [testCard] } as any,
            mockEnvelopePage,
            {
                fetchPunchCardSnapshot: async () => {
                    snapshotCalls++
                    return {
                        parentOfferId: 'pc_parent_1',
                        childOfferId: 'child_1',
                        completedChildren: 0,
                        totalChildren: 1,
                        actionableNow: 1,
                        locked: 0,
                        futureDated: 0,
                        parentComplete: false,
                        childComplete: false
                    }
                }
            }
        )

        assert.strictEqual(urlRewardCalls, 1, 'Step delegated to doUrlReward must execute exactly 1 time (no internal 1x re-click and no attempt 2/2 repeat)')
        assert.strictEqual(snapshotCalls, 1, 'Server snapshot must be fetched only 1 time per step (no duplicate retrySnapshot)')

        console.log('✅ Test 14 Passed: Post-Read-to-Earn getDashboardData fast return, preloadedData reuse, and single-pass Punch Card verification verified')
    }

    // Test 15: Live Run Remediation: Thousand-separator DOM balance (7,177 -> 7177), lockInitialPoints <50 recovery, Punch Card +3 delta verification, & Keep Earning reconciliation
    {
        const BrowserFunc = (await import('../src/browser/BrowserFunc')).default
        const { Workers } = await import('../src/functions/Workers')

        // 15a: lockInitialPoints overwrites bogus <50 DOM value (e.g. 7) with authoritative DAPI balance (7177)
        const mockBot15: any = {
            isMobile: true,
            userData: { initialPoints: 7, currentPoints: 7, gainedPoints: 0 },
            cookies: { mobile: [], desktop: [] },
            config: { baseURL: 'https://rewards.bing.com', punchCardExecution: { mode: 'auto', maxChildExecutionsPerRun: 8, stepDelayMs: 10 } },
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
            utils: { wait: async () => {}, randomDelay: () => 0 }
        }
        const bf15 = new BrowserFunc(mockBot15)
        bf15.lockInitialPoints(7177)
        assert.strictEqual(mockBot15.userData.initialPoints, 7177, 'lockInitialPoints must overwrite bogus <50 DOM value (7) with 7177')
        assert.strictEqual(mockBot15.userData.currentPoints, 7177, 'lockInitialPoints must overwrite bogus <50 currentPoints (7) with 7177')

        // 15b: Thousand-separator regex parses "Available points 7,177" as 7177 (not 7)
        const sampleCardText = 'Available points 7,177 Redeem >'
        const normalizedTxt = sampleCardText.replace(/(\d)[,.](?=\d{3}\b)/g, '$1')
        const numbers = normalizedTxt.replace(/Available points|Poin yang tersedia|Redeem|>/gi, ' ').match(/\b(\d+)\b/g)
        assert.strictEqual(parseInt(numbers?.[0] || '0', 10), 7177, 'Formatted thousand-separator balance "7,177" must parse as 7177')

        // 15c: Punch Card step that increases balance by +3 is verified complete on Attempt 1 even if afterSnapshot is null
        const punchLogs: string[] = []
        const mockPunchBot: any = {
            ...mockBot15,
            userData: { initialPoints: 3839, currentPoints: 3839, gainedPoints: 0 },
            logger: {
                info: (_m: any, _t: string, msg: string) => punchLogs.push(msg),
                warn: (_m: any, _t: string, msg: string) => punchLogs.push(`WARN:${msg}`),
                error: () => {},
                debug: () => {}
            },
            activities: {
                doUrlReward: async () => {
                    mockPunchBot.userData.currentPoints = 3842 // +3 delta!
                    return { abortedBy404: false }
                }
            }
        }
        const punchWorkers = new Workers(mockPunchBot)
        const costumeCard: any = {
            name: 'October Monthly Bonus',
            parentPromotion: { offerId: 'oct_pc', title: 'October Monthly Bonus', complete: false },
            childPromotions: [
                { offerId: 'costume_1', title: 'Costume season is here', destinationUrl: 'https://www.bing.com/search?q=costume', complete: false }
            ]
        }
        const dummyEnvPage: any = {
            isClosed: () => false,
            url: () => 'https://rewards.bing.com/dashboard/envelope?id=oct_pc',
            goto: async () => {},
            waitForLoadState: async () => {},
            waitForSelector: async () => null,
            frames: () => [],
            locator: () => ({ count: async () => 0, first: () => ({ isVisible: async () => false }) })
        }
        await punchWorkers.doPunchCards(
            { punchCards: [costumeCard] } as any,
            dummyEnvPage,
            { fetchPunchCardSnapshot: async () => null }
        )
        assert.ok(
            punchLogs.some(l => l.includes('Step "Costume season is here" verified complete!') && l.includes('observedDelta=+3')),
            'Punch card step with +3 balance delta must be marked verified complete immediately'
        )
        assert.strictEqual(
            punchLogs.some(l => l.includes('remained unverified')),
            false,
            'Punch card step with +3 balance delta must NOT log remained unverified'
        )

        // 15d: Keep Earning batch reconciliation marks completed & verifiedOffersInSession cards as verified-complete
        const keepLogs: string[] = []
        const mockKeepBot: any = {
            ...mockBot15,
            userData: { initialPoints: 5575, currentPoints: 5575, gainedPoints: 0 },
            logger: {
                info: (_m: any, _t: string, msg: string) => keepLogs.push(msg),
                warn: () => {},
                error: () => {},
                debug: () => {}
            },
            browser: {
                func: {
                    getDashboardData: async () => ({
                        userStatus: { availablePoints: 5590 },
                        morePromotions: [
                            { offerId: 'promo_1', title: 'Find recipes quickly', pointProgressMax: 15, pointProgress: 15, complete: true }
                        ]
                    }),
                    getCurrentPoints: async () => 5590
                }
            },
            activities: {
                doUrlReward: async (act: any) => {
                    mockKeepBot.userData.currentPoints = 5590
                    keepWorkers.verifiedOffersInSession.add(act.offerId)
                }
            }
        }
        const keepWorkers = new Workers(mockKeepBot)
        mockKeepBot.workers = keepWorkers
        const dummyKeepPage: any = {
            isClosed: () => false,
            url: () => 'https://rewards.bing.com',
            evaluate: async () => ({ uncompletedCards: [], completedTitles: [] })
        }
        await keepWorkers.doMorePromotions(
            {
                morePromotions: [
                    { offerId: 'promo_1', title: 'Find recipes quickly', pointProgressMax: 15, pointProgress: 0, complete: false, promotionType: 'urlreward' }
                ]
            } as any,
            dummyKeepPage
        )
        assert.ok(
            keepLogs.some(l => l.includes('verified=1/1')),
            `Keep earning reconciliation must report verified=1/1 instead of 0/1: ${JSON.stringify(keepLogs)}`
        )

        console.log('✅ Test 15 Passed: Thousand-separator DOM balance, lockInitialPoints <50 recovery, Punch Card +3 delta verification, & Keep Earning reconciliation verified')
    }

    console.log('🎉 Chapter 30 Zombie Worker & Punch Card Resolver Test Suite PASSED!')
}

if (require.main === module) {
    runChapter30ZombieWorkerAndPunchCardResolverTests().catch(err => {
        console.error('❌ Test failed:', err)
        process.exit(1)
    })
}

