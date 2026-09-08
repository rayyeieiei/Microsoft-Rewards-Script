import assert from 'assert'
import { redactAccountKey, sanitizeLogMessage, sanitizeLogMetadata } from '../src/util/Redaction'

export async function runRedactionTests() {
    console.log('--- Running Redaction & Secret Sanitization Test Suite ---')

    // Test 10: OAuth code, state, access_token, refresh_token, and Bearer headers are redacted
    {
        const rawOAuthMessage =
            'OAuth poll redirect detected: https://login.live.com/oauth20_desktop.srf?code=M.R3_BAY.secret_auth_code_98765&state=secret_state_token_12345'
        const sanitizedOAuth = sanitizeLogMessage(rawOAuthMessage)

        assert.strictEqual(
            sanitizedOAuth.includes('secret_auth_code_98765'),
            false,
            'Raw OAuth code must be redacted from logs'
        )
        assert.strictEqual(
            sanitizedOAuth.includes('secret_state_token_12345'),
            false,
            'Raw OAuth state must be redacted from logs'
        )
        assert.ok(sanitizedOAuth.includes('code=[REDACTED]'))
        assert.ok(sanitizedOAuth.includes('state=[REDACTED]'))

        const rawTokensMessage =
            'Tokens refreshed: access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-secret and refresh_token=M.C543_BL2.0.secret Authorization: Bearer eyJhbGciOi...'
        const sanitizedTokens = sanitizeLogMessage(rawTokensMessage)

        assert.strictEqual(sanitizedTokens.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-secret'), false)
        assert.strictEqual(sanitizedTokens.includes('M.C543_BL2.0.secret'), false)
        assert.ok(sanitizedTokens.includes('access_token=[REDACTED]'))
        assert.ok(sanitizedTokens.includes('refresh_token=[REDACTED]'))
        assert.ok(sanitizedTokens.includes('Bearer [REDACTED]'))

        console.log('✅ Test 10 Passed: OAuth code/state and sensitive tokens are completely redacted')
    }

    // Test 11: Email addresses are redacted in all output sinks
    {
        // 1. Direct redactAccountKey helper tests
        assert.strictEqual(redactAccountKey('ehsanfizibers@outlook.com'), 'ehs***@outlook.com')
        assert.strictEqual(redactAccountKey('baryyaja@gmail.com'), 'bar***@gmail.com')
        assert.strictEqual(redactAccountKey('testing@example.org'), 'tes***@example.org')
        assert.strictEqual(redactAccountKey('test@example.org'), 'te***@example.org')
        assert.strictEqual(redactAccountKey('ab@domain.com'), 'a***@domain.com')
        assert.strictEqual(redactAccountKey('a@domain.com'), 'a***@domain.com')

        // 2. Sink-level regex email sanitization
        const rawLogWithEmail =
            'Account workflow started for user ehsanfizibers@outlook.com with proxy 1.2.3.4 and secondary baryyaja@gmail.com'
        const sanitizedLog = sanitizeLogMessage(rawLogWithEmail)

        assert.strictEqual(
            sanitizedLog.includes('ehsanfizibers@outlook.com'),
            false,
            'Full primary email must not appear in log message'
        )
        assert.strictEqual(
            sanitizedLog.includes('baryyaja@gmail.com'),
            false,
            'Full secondary email must not appear in log message'
        )
        assert.ok(sanitizedLog.includes('ehs***@outlook.com'))
        assert.ok(sanitizedLog.includes('bar***@gmail.com'))

        // 3. Metadata scrubbing
        const metadata = {
            email: 'admin@company.com',
            token: 'secret_jwt_token',
            nested: {
                userEmail: 'employee@company.com'
            }
        }
        const sanitizedMeta = sanitizeLogMetadata(metadata)
        assert.strictEqual(sanitizedMeta.email, 'adm***@company.com')
        assert.strictEqual(sanitizedMeta.nested.userEmail, 'emp***@company.com')

        console.log('✅ Test 11 Passed: Email addresses are cleanly masked across sink and metadata')
    }
}

if (require.main === module) {
    runRedactionTests().catch(err => {
        console.error(err)
        process.exit(1)
    })
}
