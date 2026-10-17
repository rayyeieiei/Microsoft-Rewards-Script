import assert from 'assert'
import { resolvePunchCardExecutionUrl } from '../src/functions/activities/api/UrlProtocolGuard'
import { normalizeActivityUrl } from '../src/functions/activities/api/UrlReward'

export async function runPunchCardUrlResolutionTests() {
    console.log('--- Running Punch Card URL Resolution & App Quest Guard Test Suite ---')

    // Test 1: URL Amplop (Legacy /dashboard/envelope) dikonversi ke URL Search Bing valid
    {
        const title = 'October deals and trends'
        const envelopeAbs = 'https://rewards.bing.com/dashboard/envelope?id=ENUS_punchcard_october_2026'
        const resAbs = resolvePunchCardExecutionUrl(envelopeAbs, title)
        assert.strictEqual(resAbs.action, 'search')
        assert.strictEqual(
            resAbs.url,
            `https://www.bing.com/search?q=${encodeURIComponent(title)}`,
            'Absolute envelope URL must be converted to Bing search'
        )

        const envelopeRel = '/dashboard/envelope?id=ENUS_punchcard_october_2026'
        const resRel = resolvePunchCardExecutionUrl(envelopeRel, title)
        assert.strictEqual(resRel.action, 'search')
        assert.strictEqual(
            resRel.url,
            `https://www.bing.com/search?q=${encodeURIComponent(title)}`,
            'Relative envelope URL must be converted to Bing search'
        )

        const envelopeSubpath = 'https://rewards.bing.com/dashboard/envelope/offer'
        const resSub = resolvePunchCardExecutionUrl(envelopeSubpath, 'Daily Promo')
        assert.strictEqual(resSub.action, 'search')
        assert.strictEqual(
            resSub.url,
            `https://www.bing.com/search?q=${encodeURIComponent('Daily Promo')}`,
            'Envelope subpath must be converted to Bing search'
        )

        console.log('✅ Test 1 Passed: Deprecated /dashboard/envelope cleanly rewritten to Bing Search URL')
    }

    // Test 2: Protokol ms-search mengekstrak parameter query 'q' atau fallback ke judul
    {
        const res1 = resolvePunchCardExecutionUrl('ms-search:?q=test', 'Explore Search')
        assert.strictEqual(res1.action, 'search')
        assert.strictEqual(res1.url, 'https://www.bing.com/search?q=test')

        const res2 = resolvePunchCardExecutionUrl('ms-search:?q=Windows+Search', 'Explore Windows Search')
        assert.strictEqual(res2.action, 'search')
        assert.strictEqual(res2.url, 'https://www.bing.com/search?q=Windows%20Search')

        const res3 = resolvePunchCardExecutionUrl('ms-search://?q=Explore%20Cortana', 'Cortana Quest')
        assert.strictEqual(res3.action, 'search')
        assert.strictEqual(res3.url, 'https://www.bing.com/search?q=Explore%20Cortana')

        // Fallback jika tidak ada parameter q di ms-search:
        const resFallback = resolvePunchCardExecutionUrl('ms-search:', 'Windows Spotlight')
        assert.strictEqual(resFallback.action, 'search')
        assert.strictEqual(
            resFallback.url,
            `https://www.bing.com/search?q=${encodeURIComponent('Windows Spotlight')}`
        )

        console.log('✅ Test 2 Passed: ms-search: extracts query param or falls back to title cleanly')
    }

    // Test 3: Link promo aplikasi Bing (apps/rewards & form=quest1) ditandai sebagai skip-app
    {
        const appPromo1 = 'https://www.bing.com/apps/rewards/?form=quest1'
        const res1 = resolvePunchCardExecutionUrl(appPromo1, 'Rewards App weekly Exclusive Quest')
        assert.strictEqual(res1.action, 'skip-app')
        assert.strictEqual(res1.reason, 'bing-app-exclusive-promo')

        const appPromo2 = 'https://bing.com/apps/rewards'
        const res2 = resolvePunchCardExecutionUrl(appPromo2, 'Mobile Exclusive')
        assert.strictEqual(res2.action, 'skip-app')

        const appPromo3 = 'https://rewards.bing.com/promo?form=quest1'
        const res3 = resolvePunchCardExecutionUrl(appPromo3, 'Quest 1 App')
        assert.strictEqual(res3.action, 'skip-app')

        console.log('✅ Test 3 Passed: Bing app exclusive promo links categorized as skip-app')
    }

    // Test 4: URL web normal dan path relatif standar tetap diizinkan untuk navigasi
    {
        const normalWeb = 'https://www.bing.com/search?q=technology'
        const resNormal = resolvePunchCardExecutionUrl(normalWeb, 'Tech Quest')
        assert.strictEqual(resNormal.action, 'navigate')
        assert.strictEqual(resNormal.url, normalWeb)

        const relativeNormal = '/earn'
        const resRelNormal = resolvePunchCardExecutionUrl(relativeNormal, 'Earn Hub')
        assert.strictEqual(resRelNormal.action, 'navigate')
        assert.strictEqual(resRelNormal.url, 'https://rewards.bing.com/earn')

        console.log('✅ Test 4 Passed: Normal web URLs and standard relative paths navigate properly')
    }

    // Test 5: normalizeActivityUrl di UrlReward.ts mengintegrasikan rewrite envelope & app bypass
    {
        const envNorm = normalizeActivityUrl(
            'https://rewards.bing.com/dashboard/envelope?id=xyz',
            'https://rewards.bing.com',
            'Envelope Fallback Query'
        )
        assert.strictEqual(envNorm.action, 'navigate')
        assert.strictEqual(
            envNorm.url,
            `https://www.bing.com/search?q=${encodeURIComponent('Envelope Fallback Query')}`
        )

        const appNorm = normalizeActivityUrl(
            'https://www.bing.com/apps/rewards/?form=quest1',
            'https://rewards.bing.com',
            'App Quest'
        )
        assert.strictEqual(appNorm.action, 'bypass-navigation')
        assert.strictEqual(appNorm.scheme, 'bypass')

        console.log('✅ Test 5 Passed: normalizeActivityUrl properly integrates envelope rewriting & app bypass')
    }

    console.log('🎉 ALL PUNCH CARD URL RESOLUTION TESTS PASSED SUCCESSFULLY!\n')
}
