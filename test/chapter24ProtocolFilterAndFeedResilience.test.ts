import assert from 'assert'
import { chromium, type Browser } from 'patchright'
import { isLocalAppUri, extractHttpUrlFromAppUri, runGuardedOperation } from '../src/runtime/BrowserOperationGuard'
import { ReadToEarn } from '../src/functions/activities/app/ReadToEarn'
import type { MicrosoftRewardsBot } from '../src/index'

export async function runChapter24ProtocolFilterAndFeedResilienceTests() {
    console.log('\n--- Running Chapter 24 Protocol Filter, Envelope Selector & MSN Feed Resilience Test Suite ---')

    // Test 1: URI filter and app protocol detection
    {
        const positiveUris = [
            'ms-search://search/?q=Your%20words%20become%20art',
            'ms-search:query=windows%20search',
            'microsoft-edge://https://rewards.bing.com',
            'microsoft-edge:https://www.bing.com/search?q=test',
            'ms-windows-store://pdp/?productid=9WZDNCRFHVJL',
            'ms-windows-store:navigate?appid=123',
            'intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;end',
            'market://details?id=com.microsoft.bing'
        ]

        for (const uri of positiveUris) {
            assert.strictEqual(isLocalAppUri(uri), true, `Expected true for local app URI: ${uri}`)
        }

        const negativeUris = [
            'https://rewards.bing.com',
            'http://www.bing.com/search?q=rewards',
            'https://account.microsoft.com',
            ''
        ]

        for (const uri of negativeUris) {
            assert.strictEqual(isLocalAppUri(uri), false, `Expected false for web URI: ${uri}`)
        }

        // Test extraction of embedded http(s) URL from microsoft-edge:
        assert.strictEqual(
            extractHttpUrlFromAppUri('microsoft-edge:https://www.bing.com/search?q=hello'),
            'https://www.bing.com/search?q=hello'
        )
        assert.strictEqual(
            extractHttpUrlFromAppUri('microsoft-edge://https://rewards.bing.com/dashboard'),
            'https://rewards.bing.com/dashboard'
        )
        assert.strictEqual(
            extractHttpUrlFromAppUri('microsoft-edge:?url=https%3A%2F%2Fwww.bing.com'),
            'https://www.bing.com'
        )
        assert.strictEqual(
            extractHttpUrlFromAppUri('ms-windows-store://navigate'),
            null
        )

        console.log('✅ Test 1 Passed: Local app URI filter and HTTP extraction accurate')
    }

    // Test 2: runGuardedOperation prevents navigation-error status on app URI
    {
        const result = await runGuardedOperation({
            stage: 'activity-navigation',
            timeoutMs: 5000,
            operation: async () => {
                throw new Error('page.goto: net::ERR_ABORTED at microsoft-edge://https://rewards.bing.com')
            }
        })

        assert.strictEqual(result.status, 'completed', 'App URI error should be mapped to completed/recovered instead of navigation-error')
        console.log('✅ Test 2 Passed: runGuardedOperation cleanly recovers from app scheme errors without navigation-error')
    }

    // Test 3: MSN Feed market resolver accurate across locales
    {
        const dummyBot = {
            userData: { geoLocale: 'ID' },
            logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
            axios: { request: async () => ({}) }
        } as unknown as MicrosoftRewardsBot

        const readToEarn = new ReadToEarn(dummyBot)
        assert.deepStrictEqual(readToEarn.resolveMsnMarket('id'), { market: 'id-id', locale: 'id-ID' })
        assert.deepStrictEqual(readToEarn.resolveMsnMarket('ID'), { market: 'id-id', locale: 'id-ID' })
        assert.deepStrictEqual(readToEarn.resolveMsnMarket('us'), { market: 'en-us', locale: 'en-US' })
        assert.deepStrictEqual(readToEarn.resolveMsnMarket('gb'), { market: 'en-gb', locale: 'en-GB' })
        assert.deepStrictEqual(readToEarn.resolveMsnMarket('jp'), { market: 'ja-jp', locale: 'ja-JP' })
        assert.deepStrictEqual(readToEarn.resolveMsnMarket('unknown_geo'), { market: 'en-us', locale: 'en-US' })

        console.log('✅ Test 3 Passed: MSN Feed market resolver maps locales accurately')
    }

    // Test 4: MSN Feed instant fallback article pool on 400 error
    {
        const dummyBot = {
            userData: { geoLocale: 'ID' },
            logger: {
                debug: () => {},
                info: () => {},
                warn: () => {},
                error: () => {}
            },
            axios: {
                request: async () => {
                    const err: any = new Error('Request failed with status code 400')
                    err.response = { status: 400, data: 'Requested market are not supported' }
                    throw err
                }
            }
        } as unknown as MicrosoftRewardsBot

        const readToEarn = new ReadToEarn(dummyBot)
        const articles = await readToEarn.fetchValidMsnArticles(10)

        assert.strictEqual(articles.length, 10, 'Must return exactly 10 fallback articles')
        for (const id of articles) {
            assert.ok(typeof id === 'string' && id.length >= 6, `Article ID ${id} must be valid format`)
        }

        console.log('✅ Test 4 Passed: Instant transition to fallback article pool on HTTP 400')
    }

    // Test 5: Punch card envelope flexible selectors detection in live DOM
    let browser: Browser | null = null
    try {
        browser = await chromium.launch({ headless: true })
        const page = await browser.newPage()

        const testSelectors = [
            '<a href="/search?q=costumes" target="_blank">Search Costumes</a>',
            '<button data-bi-name="punchcard_step_1">Explore</button>',
            '<a class="c-call-to-action" href="https://bing.com">Get Started</a>',
            '<div class="punchcard-wrapper"><div class="punchcard-step"><a href="https://bing.com">Step 1</a></div></div>',
            '<a href="#">Jelajahi penawaran</a>',
            '<button>Mulai</button>'
        ]

        const flexibleSelector = [
            'a[href*="/search?"][target="_blank"]',
            'button[data-bi-name*="punchcard" i]',
            '.c-call-to-action',
            '[class*="punchcard"] [class*="step"]:not([class*="complete"]) a',
            'a:has-text("Explore")',
            'a:has-text("Start")',
            'a:has-text("Mulai")',
            'a:has-text("Jelajahi")',
            'button:has-text("Explore")',
            'button:has-text("Start")',
            'button:has-text("Mulai")',
            'button:has-text("Jelajahi")'
        ].join(', ')

        for (const html of testSelectors) {
            await page.setContent(`<div>${html}</div>`)
            const el = await page.waitForSelector(flexibleSelector, { state: 'visible', timeout: 2000 })
            assert.ok(el, `Flexible selector should match: ${html}`)
        }

        console.log('✅ Test 5 Passed: Flexible envelope step selectors reliably match all DOM patterns')
    } finally {
        if (browser) {
            await browser.close()
        }
    }

    // Test 6: ms-search:// protocol guard on punch card delegation
    {
        const mockLogs: string[] = []
        let gotoCalled = false

        const mockPage: any = {
            url: () => 'https://rewards.bing.com/dashboard/envelope?id=test_card',
            goto: async () => {
                gotoCalled = true
            },
            isClosed: () => false,
            context: () => ({})
        }

        const mockBot: any = {
            isMobile: false,
            userData: { currentPoints: 100 },
            logger: {
                warn: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[WARN][${tag}] ${msg}`),
                info: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[INFO][${tag}] ${msg}`),
                debug: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[DEBUG][${tag}] ${msg}`),
                error: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[ERROR][${tag}] ${msg}`)
            },
            utils: {
                wait: async (ms: number) => {
                    mockLogs.push(`[WAIT] ${ms}ms`)
                }
            }
        }

        const promotion: any = {
            title: 'Your words become art in seconds',
            destinationUrl: 'ms-search://search/?q=Your%20words%20become%20art',
            pointProgressMax: 10
        }

        const punchCard: any = {
            parentPromotion: { offerId: 'windows_search_parent' }
        }

        const { UrlReward } = await import('../src/functions/activities/api/UrlReward')
        const urlReward = new UrlReward(mockBot)
        await urlReward.doUrlReward(promotion, mockPage, punchCard)

        assert.strictEqual(gotoCalled, false, 'page.goto must never be called for ms-search:// protocol!')
        const guardLog = mockLogs.find(l => l.includes('[WARN][PUNCHCARD-GUARD]') && l.includes('ms-search:'))
        assert.ok(guardLog, `Expected PUNCHCARD-GUARD log for ms-search, got: ${mockLogs.join('\n')}`)
        const waitLog = mockLogs.find(l => l.includes('[WAIT] 1800ms'))
        assert.ok(waitLog, 'Expected simulated dwell delay around 1800ms')

        console.log('✅ Test 6 Passed: ms-search:// protocol correctly intercepted by PUNCHCARD-GUARD without page.goto')
    }

    console.log('🎉 ALL CHAPTER 24 TESTS PASSED!')
}

if (require.main === module) {
    runChapter24ProtocolFilterAndFeedResilienceTests().catch(err => {
        console.error('❌ Test failed:', err)
        process.exit(1)
    })
}
