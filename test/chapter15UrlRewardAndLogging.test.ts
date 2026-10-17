import assert from 'assert'
import { redactAccountKey, sanitizeLogMessage } from '../src/util/Redaction'
import { normalizeActivityUrl, isLocalSystemProtocol } from '../src/functions/activities/api/UrlReward'

export async function runChapter15UrlRewardAndLoggingTests(): Promise<void> {
    console.log('--- Running Chapter 15 URL Reward Normalizer & Logging Unmasking Test Suite ---')

    // Test 1: normalizeActivityUrl resolves relative paths with rewards.bing.com origin
    {
        const relativeUrl1 = '/redeem/000100000002'
        const res1 = normalizeActivityUrl(relativeUrl1)
        assert.strictEqual(res1.action, 'navigate')
        assert.strictEqual(res1.scheme, 'relative-resolved')
        assert.strictEqual(res1.url, 'https://rewards.bing.com/redeem/000100000002')

        const relativeUrl2 = '/dashboard/enrollment?publ=BING'
        const res2 = normalizeActivityUrl(relativeUrl2, 'https://rewards.bing.com')
        assert.strictEqual(res2.action, 'navigate')
        assert.strictEqual(res2.scheme, 'relative-resolved')
        assert.strictEqual(res2.url, 'https://rewards.bing.com/dashboard/enrollment?publ=BING')

        console.log('✅ Test 1 Passed: normalizeActivityUrl properly resolves relative paths to absolute URLs')
    }

    // Test 2: normalizeActivityUrl rewrites microsoft-edge:// URLs with target url query parameter
    {
        const edgeWithQuery = 'microsoft-edge://?ux=searchbar&url=https%3A%2F%2Fwww.bing.com%2Fsearch%3Fq%3DWorld%2BNews'
        const res = normalizeActivityUrl(edgeWithQuery)
        assert.strictEqual(res.action, 'navigate')
        assert.strictEqual(res.scheme, 'edge-rewritten')
        assert.strictEqual(res.url, 'https://www.bing.com/search?q=World+News')

        const edgeDirectHttp = 'microsoft-edge:https://www.bing.com/travel'
        const resDirect = normalizeActivityUrl(edgeDirectHttp)
        assert.strictEqual(resDirect.action, 'navigate')
        assert.strictEqual(resDirect.scheme, 'edge-rewritten')
        assert.strictEqual(resDirect.url, 'https://www.bing.com/travel')

        console.log('✅ Test 2 Passed: normalizeActivityUrl extracts target HTTP/HTTPS from microsoft-edge: URLs')
    }

    // Test 3: normalizeActivityUrl rewrites microsoft-edge:// without inner url to fallback Bing query or origin
    {
        const edgeBare = 'microsoft-edge://'
        const resWithFallback = normalizeActivityUrl(edgeBare, 'https://rewards.bing.com', 'Daily Quiz')
        assert.strictEqual(resWithFallback.action, 'navigate')
        assert.strictEqual(resWithFallback.scheme, 'edge-rewritten')
        assert.strictEqual(resWithFallback.url, 'https://www.bing.com/search?q=Daily%20Quiz')

        const resWithoutFallback = normalizeActivityUrl(edgeBare)
        assert.strictEqual(resWithoutFallback.action, 'navigate')
        assert.strictEqual(resWithoutFallback.scheme, 'edge-rewritten')
        assert.strictEqual(resWithoutFallback.url, 'https://www.bing.com')

        console.log('✅ Test 3 Passed: normalizeActivityUrl falls back gracefully when microsoft-edge: lacks target url')
    }

    // Test 4: normalizeActivityUrl bypasses empty, javascript:, and anchor URLs
    {
        const emptyRes = normalizeActivityUrl('')
        assert.strictEqual(emptyRes.action, 'bypass-navigation')
        assert.strictEqual(emptyRes.scheme, 'bypass')
        assert.strictEqual(emptyRes.url, '')

        const jsRes = normalizeActivityUrl('javascript:void(0);')
        assert.strictEqual(jsRes.action, 'bypass-navigation')
        assert.strictEqual(jsRes.scheme, 'bypass')
        assert.strictEqual(jsRes.url, '')

        const hashRes = normalizeActivityUrl('#')
        assert.strictEqual(hashRes.action, 'bypass-navigation')
        assert.strictEqual(hashRes.scheme, 'bypass')
        assert.strictEqual(hashRes.url, '')

        // Protocol URI Guard: ms-search:, microsoft-edge:, ms-windows-store:, intent:
        assert.strictEqual(isLocalSystemProtocol('ms-search:query=bing'), true)
        assert.strictEqual(isLocalSystemProtocol('microsoft-edge:https://example.com'), true)
        assert.strictEqual(isLocalSystemProtocol('ms-windows-store://pdp/?productid=123'), true)
        assert.strictEqual(isLocalSystemProtocol('intent:#Intent;action=view;end'), true)
        assert.strictEqual(isLocalSystemProtocol('https://rewards.bing.com'), false)

        const msSearchRes = normalizeActivityUrl('ms-search:query=bing')
        assert.strictEqual(msSearchRes.action, 'bypass-navigation')
        assert.strictEqual(msSearchRes.scheme, 'bypass')

        const storeRes = normalizeActivityUrl('ms-windows-store://pdp/?productid=123')
        assert.strictEqual(storeRes.action, 'bypass-navigation')
        assert.strictEqual(storeRes.scheme, 'bypass')

        const intentRes = normalizeActivityUrl('intent:#Intent;action=view')
        assert.strictEqual(intentRes.action, 'bypass-navigation')
        assert.strictEqual(intentRes.scheme, 'bypass')

        console.log('✅ Test 4 Passed: normalizeActivityUrl bypasses navigation for empty, javascript:, and local system protocols (URI Guard)')
    }

    // Test 5: normalizeActivityUrl handles malformed URLs defensibly without throwing
    {
        const malformed = 'ht!tp://:::invalid-url:::'
        let threw = false
        let res: any = null
        try {
            res = normalizeActivityUrl(malformed, 'https://rewards.bing.com', 'Safe Search')
        } catch {
            threw = true
        }
        assert.strictEqual(threw, false, 'normalizeActivityUrl must never throw on malformed inputs')
        assert.ok(res, 'Resolution object must be returned')
        assert.strictEqual(res.url, 'https://www.bing.com/search?q=Safe%20Search')

        // Protocol-relative handling
        const protoRelative = '//www.bing.com/rewards'
        const protoRes = normalizeActivityUrl(protoRelative)
        assert.strictEqual(protoRes.action, 'navigate')
        assert.strictEqual(protoRes.scheme, 'https')
        assert.strictEqual(protoRes.url, 'https://www.bing.com/rewards')

        console.log('✅ Test 5 Passed: normalizeActivityUrl handles malformed inputs defensibly')
    }

    // Test 6: redactAccountKey('MAIN') returns 'MAIN' unchanged (no acc*** tag)
    {
        assert.strictEqual(redactAccountKey('MAIN'), 'MAIN', "Identifier 'MAIN' must not be converted to 'acc***'")
        assert.strictEqual(redactAccountKey('main'), 'MAIN', "Identifier 'main' must not be converted to 'acc***'")
        assert.strictEqual(redactAccountKey('  MAIN  '), 'MAIN')

        // Non-MAIN accounts still follow standard redaction
        assert.strictEqual(redactAccountKey('milan@outlook.com'), 'mil***@outlook.com')
        assert.strictEqual(redactAccountKey('user'), 'acc***')

        console.log("✅ Test 6 Passed: redactAccountKey preserves 'MAIN' without masking")
    }

    // Test 7: sanitizeLogMessage({ redactEmail: false }) unmasks email while strictly redacting credentials & tokens
    {
        const rawMessage =
            '[MAIN] [milan@outlook.com] Requesting https://login.live.com/oauth20_desktop.srf?code=M.R3_BAY.secret_auth_code_98765&state=secret_state_token_12345 access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-secret Authorization: Bearer eyJhbGciOiJIUzI1Ni...'

        const consoleClean = sanitizeLogMessage(rawMessage, { redactEmail: false })

        // Email remains unmasked
        assert.ok(
            consoleClean.includes('milan@outlook.com'),
            'Email must remain unmasked for terminal console output when redactEmail is false'
        )

        // Strict security redaction must still occur
        assert.strictEqual(consoleClean.includes('secret_auth_code_98765'), false, 'OAuth code must be redacted')
        assert.strictEqual(consoleClean.includes('secret_state_token_12345'), false, 'OAuth state must be redacted')
        assert.strictEqual(
            consoleClean.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-secret'),
            false,
            'access_token must be redacted'
        )
        assert.ok(consoleClean.includes('code=[REDACTED]'))
        assert.ok(consoleClean.includes('state=[REDACTED]'))
        assert.ok(consoleClean.includes('access_token=[REDACTED]'))
        assert.ok(consoleClean.includes('Bearer [REDACTED]'))

        console.log('✅ Test 7 Passed: sanitizeLogMessage allows unmasked email while strictly redacting credentials')
    }

    // Test 8: sanitizeLogMessage backward compatibility (default redactEmail: true)
    {
        const rawMessage =
            '[MAIN] [milan@outlook.com] Account initialized with refresh_token=M.C543_BL2.0.secret'

        const defaultClean = sanitizeLogMessage(rawMessage)

        assert.strictEqual(
            defaultClean.includes('milan@outlook.com'),
            false,
            'Email must be redacted by default in sanitizeLogMessage'
        )
        assert.ok(defaultClean.includes('mil***@outlook.com'))
        assert.ok(defaultClean.includes('refresh_token=[REDACTED]'))

        console.log('✅ Test 8 Passed: sanitizeLogMessage default maintains full email redaction backward compatibility')
    }

    console.log('🎉 All Chapter 15 tests passed successfully!')
}
